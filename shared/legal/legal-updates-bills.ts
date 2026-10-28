/**
 * Does a legislative item cite a bill that exists, and is it the bill it claims?
 *
 * `legal-updates-sources.ts` asks whether a URL loads. For the other two sections that is a real
 * question, because a regulator's site returns an honest 404 for a page it does not have. For
 * legislation it answers nothing, and had been answering nothing since the guard was written:
 *
 * - congress.gov sits behind Cloudflare and returns **403** to us. `checkSourceUrl` treats 403 as
 *   "the host refused us, not that the page is absent", which is right for a press release and
 *   means no congress.gov URL was ever checked. `senate-bill/999999`, `401st-congress` and the
 *   literal path `senate-bill/not-a-bill` all returned `ok`.
 * - flsenate.gov and govinfo.gov serve soft 404s with HTTP 200, so gibberish passed there too.
 *
 * What that let through, from one live run: four items citing `S. 1234`, `H.R. 5678`, `S. 2345`
 * and `S. 3456` with commercial-real-estate titles. Every number is a real bill and not one of
 * those titles is. S. 1234 is the SSI Savings Penalty Elimination Act; H.R. 5678 is the No Pay for
 * Disarray Act. The model had picked plausible sequential numbers and written CRE titles onto them,
 * and the feed had no way to notice.
 *
 * So the question here is stronger than "does the page load". A bill has an identity independent
 * of any page: a chamber, a number and a congress. That can be looked up, and the answer compared
 * with what the item claims.
 */

/** govtrack's `bill_type` values, which is what the lookup is keyed on. */
export type BillType =
  | "senate_bill"
  | "house_bill"
  | "senate_resolution"
  | "house_resolution"
  | "senate_joint_resolution"
  | "house_joint_resolution"
  | "senate_concurrent_resolution"
  | "house_concurrent_resolution"

export type FederalBillReference = {
  jurisdiction: "federal"
  billType: BillType
  number: number
  congress?: number
}

export type FloridaBillReference = {
  jurisdiction: "florida"
  chamber: "senate" | "house"
  number: number
}

export type BillReference = FederalBillReference | FloridaBillReference

/**
 * Longest form first, so `S.J.Res. 5` is not read as `S. 5` with stray text after it. The federal
 * forms all require the period after the chamber letter, which is what keeps `S. 106` (a federal
 * bill) from colliding with `SB 106` (a Florida one).
 */
const FEDERAL_PATTERNS: [RegExp, BillType][] = [
  [/\bH\.?\s?J\.?\s?Res\.?\s*(\d{1,5})\b/i, "house_joint_resolution"],
  [/\bS\.?\s?J\.?\s?Res\.?\s*(\d{1,5})\b/i, "senate_joint_resolution"],
  [/\bH\.?\s?Con\.?\s?Res\.?\s*(\d{1,5})\b/i, "house_concurrent_resolution"],
  [/\bS\.?\s?Con\.?\s?Res\.?\s*(\d{1,5})\b/i, "senate_concurrent_resolution"],
  [/\bH\.?\s?Res\.?\s*(\d{1,5})\b/i, "house_resolution"],
  [/\bS\.?\s?Res\.?\s*(\d{1,5})\b/i, "senate_resolution"],
  [/\bH\.?\s?R\.?\s*(\d{1,5})\b/i, "house_bill"],
  [/\bS\.\s*(\d{1,5})\b/i, "senate_bill"],
]

/** `CS/SB 1234` and `CS/CS/HB 7` are committee substitutes — the same bill, still that number. */
const FLORIDA_PATTERN = /\b(?:CS\/)*(SB|HB|SJR|HJR|SPB|PCB)\s*(\d{1,5})\b/i

/** The 1st Congress convened in 1789 and each runs two years. */
export function congressForYear(year: number): number {
  return Math.floor((year - 1789) / 2) + 1
}

/** Reads the congress and bill out of a congress.gov URL, which states both unambiguously. */
export function parseCongressGovUrl(url: string | undefined): FederalBillReference | null {
  if (!url) return null
  const m = url.match(
    /congress\.gov\/bill\/(\d{1,3})(?:st|nd|rd|th)-congress\/([a-z-]+)\/(\d{1,5})\b/i
  )
  if (!m) return null
  const billType = SLUG_TO_BILL_TYPE[m[2].toLowerCase()]
  if (!billType) return null
  return { jurisdiction: "federal", billType, number: Number(m[3]), congress: Number(m[1]) }
}

const SLUG_TO_BILL_TYPE: Record<string, BillType> = {
  "senate-bill": "senate_bill",
  "house-bill": "house_bill",
  "senate-resolution": "senate_resolution",
  "house-resolution": "house_resolution",
  "senate-joint-resolution": "senate_joint_resolution",
  "house-joint-resolution": "house_joint_resolution",
  "senate-concurrent-resolution": "senate_concurrent_resolution",
  "house-concurrent-resolution": "house_concurrent_resolution",
}

/**
 * Florida first. `SB`/`HB` carry no period, and the federal patterns all demand one, so the two
 * cannot both match — but reading Florida first makes that independent of pattern order above.
 */
export function parseBillReference(text: string | undefined): BillReference | null {
  if (!text) return null

  const fl = text.match(FLORIDA_PATTERN)
  if (fl) {
    const prefix = fl[1].toUpperCase()
    return {
      jurisdiction: "florida",
      chamber: prefix.startsWith("S") ? "senate" : "house",
      number: Number(fl[2]),
    }
  }

  for (const [pattern, billType] of FEDERAL_PATTERNS) {
    const m = text.match(pattern)
    if (m) return { jurisdiction: "federal", billType, number: Number(m[1]) }
  }
  return null
}

/**
 * Words that carry no identity. Without this, "Act" and "Florida" alone would make any two titles
 * look related, which is the whole question being asked.
 */
const TITLE_NOISE = new Set([
  "act",
  "bill",
  "resolution",
  "senate",
  "house",
  "congress",
  "united",
  "states",
  "federal",
  "florida",
  "amend",
  "amendment",
  "relating",
  "related",
  "provide",
  "providing",
  "purposes",
  "other",
  "such",
  "shall",
  "section",
  "title",
  "concerning",
  "respect",
  "certain",
])

export function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    // Drop bill numbers so "1234" cannot count as agreement between two titles.
    .replace(/\d+/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !TITLE_NOISE.has(w))
  return new Set(words)
}

/**
 * Do the claimed and authoritative titles describe the same bill?
 *
 * Deliberately not an equality test. A genuine citation often gives the short title where the
 * record gives the long one, or the reverse, so the two agree in substance and not in wording.
 * What fabrication looks like is different in kind: zero words in common, because the title was
 * invented to fit the search rather than read off the bill.
 *
 * Two shared significant words is the bar. All four fabricated items scored zero.
 */
export function titlesAgree(claimed: string, authoritative: string): boolean {
  const a = significantWords(claimed)
  const b = significantWords(authoritative)
  if (a.size === 0 || b.size === 0) return false

  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1

  // A very short claimed title has fewer chances to overlap, so one distinctive word carries it.
  const required = a.size <= 2 ? 1 : 2
  return shared >= required
}

export type BillVerdict =
  | { status: "ok"; authoritativeTitle?: string }
  /** No bill number anywhere in the item. The prompt requires one, so this is a malformed item. */
  | { status: "unparseable" }
  /** The chamber and number do not correspond to any bill in that congress. */
  | { status: "no-such-bill"; reference: BillReference }
  /** The bill exists and is a different bill than the one described. */
  | { status: "misattributed"; reference: BillReference; authoritativeTitle: string }
  /** The record could not be reached. Distinguished so an outage is not reported as a lie. */
  | { status: "unchecked"; reason: string }

type GovTrackBill = {
  title?: string
  title_without_number?: string
  display_number?: string
}

/**
 * govtrack rather than api.congress.gov because the official API returns 403 without a key, and
 * this needs to work on a deployment with no new secret provisioned. govtrack is already on the
 * legislative allowlist. It answers `{"objects": []}` for a number that does not exist, which is
 * the distinction the whole guard rests on.
 */
async function lookupFederalBill(
  reference: FederalBillReference,
  congress: number,
  timeoutMs: number
): Promise<GovTrackBill | null | "error"> {
  const url =
    `https://www.govtrack.us/api/v2/bill?congress=${congress}` +
    `&bill_type=${reference.billType}&number=${reference.number}`
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return "error"
    const data = (await res.json()) as { objects?: GovTrackBill[] }
    return data.objects?.[0] ?? null
  } catch {
    return "error"
  }
}

/**
 * Two attempts, because "could not check" drops a real bill.
 *
 * govtrack answers its first request after an idle period in around 28 seconds and the rest in a
 * quarter of one, so the generous timeout here is not padding — it is the actual cost of the first
 * request of the day. The retry is for a transient failure rather than a cold start, which no
 * number of short retries will outlast.
 */
async function lookupFederalBillWithRetry(
  reference: FederalBillReference,
  congress: number,
  timeoutMs: number
): Promise<GovTrackBill | null | "error"> {
  const first = await lookupFederalBill(reference, congress, timeoutMs)
  if (first !== "error") return first
  return lookupFederalBill(reference, congress, timeoutMs)
}

/** Markers Florida's legislature sites put on a page for a bill they do not have. */
const NOT_FOUND_MARKERS =
  /(page (you requested|cannot be found))|(bill (was )?not found)|(no (bill|results) (were )?found)|(does not exist)|(invalid bill)/i

/**
 * Florida has no open bill API, so this reads the cited page: it must not announce that the bill
 * is absent, and it must actually print the number claimed. The second half is what a soft 404
 * cannot satisfy — the page renders, but the number is nowhere on it.
 */
async function checkFloridaBillPage(
  reference: FloridaBillReference,
  url: string,
  timeoutMs: number
): Promise<"ok" | "no-such-bill" | "error"> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return res.status === 403 || res.status === 429 ? "error" : "no-such-bill"
    const body = await res.text()
    if (NOT_FOUND_MARKERS.test(body)) return "no-such-bill"
    const printsNumber = new RegExp(
      `\\b(?:SB|HB|SJR|HJR|SPB|PCB)\\s*0*${reference.number}\\b`,
      "i"
    ).test(body)
    return printsNumber ? "ok" : "no-such-bill"
  } catch {
    return "error"
  }
}

export type BillCandidate = {
  title?: string
  source?: string
  url?: string
  date?: string
}

/**
 * The URL is read before the title, because a congress.gov URL states the congress and the title
 * does not. Where they disagree about which bill this is, that disagreement is itself the answer:
 * an item whose link and headline name different bills is not citing either of them.
 */
export async function verifyBill(
  item: BillCandidate,
  now: Date = new Date(),
  timeoutMs = 30_000
): Promise<BillVerdict> {
  const fromUrl = parseCongressGovUrl(item.url)
  const fromText = parseBillReference(item.source) ?? parseBillReference(item.title)

  if (
    fromUrl &&
    fromText &&
    fromText.jurisdiction === "federal" &&
    (fromText.billType !== fromUrl.billType || fromText.number !== fromUrl.number)
  ) {
    return { status: "misattributed", reference: fromUrl, authoritativeTitle: "(link and title name different bills)" }
  }

  const reference = fromUrl ?? fromText
  if (!reference) return { status: "unparseable" }

  if (reference.jurisdiction === "florida") {
    if (!item.url) return { status: "unparseable" }
    const verdict = await checkFloridaBillPage(reference, item.url, timeoutMs)
    if (verdict === "error") return { status: "unchecked", reason: "Florida bill page unreachable" }
    if (verdict === "no-such-bill") return { status: "no-such-bill", reference }
    return { status: "ok" }
  }

  const year = Number(item.date?.slice(0, 4)) || now.getFullYear()
  const congress = reference.congress ?? congressForYear(year)
  const found = await lookupFederalBillWithRetry(reference, congress, timeoutMs)

  if (found === "error") return { status: "unchecked", reason: "govtrack unreachable" }
  if (found === null) return { status: "no-such-bill", reference }

  // Matched against every form govtrack knows, so a citation of the official long title agrees
  // with a record that carries the short one. Reported as the short title alone, since `title`
  // already embeds the number and repeating it makes the message unreadable.
  const matchable = [found.title_without_number, found.title].filter(Boolean).join(" ")
  const authoritativeTitle = found.title_without_number || found.title || "(untitled)"

  if (!item.title) return { status: "unparseable" }
  if (!titlesAgree(item.title, matchable)) {
    return { status: "misattributed", reference, authoritativeTitle }
  }
  return { status: "ok", authoritativeTitle }
}

/**
 * Only legislative items go through this. Regulatory and enforcement sources return honest 404s,
 * so `checkSourceUrl` is a real check for them and there is no second identity to confirm.
 *
 * An item that could not be checked is dropped rather than shown. Failing open is what produced
 * the fabricated bills, and the section already explains an empty state in place.
 */
export async function keepVerifiedBills<T extends BillCandidate>(
  items: T[],
  now: Date = new Date(),
  concurrency = 4
): Promise<{ kept: T[]; rejected: Array<{ item: T; verdict: BillVerdict }> }> {
  const verdicts = new Array<BillVerdict>(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      verdicts[i] = await verifyBill(items[i], now)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))

  const kept: T[] = []
  const rejected: Array<{ item: T; verdict: BillVerdict }> = []
  items.forEach((item, i) => {
    if (verdicts[i].status === "ok") kept.push(item)
    else rejected.push({ item, verdict: verdicts[i] })
  })
  return { kept, rejected }
}

/**
 * A stable key for a bill across days, for the status table.
 *
 * Deliberately not the item's title or id. Titles get reworded between runs and the feed's `id`
 * embeds the item's position in the list, so either would make the same bill look like a new one
 * tomorrow and the tracking would report movement that never happened. The chamber, number and
 * jurisdiction are the parts that cannot change without it being a different bill.
 *
 * The congress is left out on purpose: a bill reintroduced in the next congress keeps its number
 * only by coincidence, but treating that as continuity is the lesser error against re-flagging
 * every bill each January.
 */
export function billKey(reference: BillReference): string {
  return reference.jurisdiction === "federal"
    ? `US ${reference.billType} ${reference.number}`
    : `FL ${reference.chamber} ${reference.number}`
}

/** The key for an item, or `null` if no bill can be read out of it. */
export function billKeyFor(item: BillCandidate): string | null {
  const reference =
    parseCongressGovUrl(item.url) ?? parseBillReference(item.source) ?? parseBillReference(item.title)
  return reference ? billKey(reference) : null
}

/** Exported for the verify script's per-item log line. */
export function describeVerdict(verdict: BillVerdict): string {
  switch (verdict.status) {
    case "ok":
      return "real bill, title agrees"
    case "unparseable":
      return "no bill number in the item"
    case "no-such-bill":
      return `no such bill (${JSON.stringify(verdict.reference)})`
    case "misattributed":
      return `number belongs to a different bill: ${verdict.authoritativeTitle}`
    case "unchecked":
      return `could not check: ${verdict.reason}`
  }
}