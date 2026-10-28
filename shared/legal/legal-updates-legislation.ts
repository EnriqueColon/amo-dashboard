/**
 * Federal bills for the Legislative Tracker, taken from the legislative record.
 *
 * The other two sections ask a model what happened and then check the answer. For legislation that
 * order was the wrong way round, and `legal-updates-bills.ts` records what it cost: asked for
 * recent CRE bills, the model returned four plausible sequential numbers with invented titles, and
 * did it again on a second run. Catching that leaves the section empty, which is honest but not
 * the tool.
 *
 * A bill is a matter of record, so there is no reason to ask. govtrack publishes the record openly,
 * and here it supplies the number, the title, the status and the date of the last action. The model
 * is left with the one job it is actually good at — explaining what a real bill means for this firm
 * — and has no opportunity to invent an identity, because it is never asked for one.
 *
 * This module supplies identity and nothing more. What the record holds beyond that — sponsors,
 * actions, the CRS summary, the text, the committee report — comes from `legal-updates-govinfo.ts`,
 * and the prompt that asks for prose lives there with it. Florida is `legal-updates-florida.ts`.
 */

export type SourcedBill = {
  /** As the record prints it: "H.R. 7730". */
  displayNumber: string
  title: string
  /** Human-readable status from the record: "Passed House & Senate (President next)". */
  statusLabel: string
  /** Date of the most recent action, which is what the feed dates the item to. */
  statusDate: string
  url: string
  sponsor?: string
}

/**
 * govtrack's `q` is a full-text search over the bill, not the title, so these are wide on purpose:
 * they exist to surface candidates, and the title gate below is what decides. Searching
 * "commercial real estate" returns the Agricultural Act because the phrase appears somewhere in
 * it — which is why relevance is never taken from the search.
 */
const SEARCH_QUERIES = [
  "commercial real estate",
  "commercial mortgage",
  "foreclosure",
  "receivership",
  "distressed debt",
  "loan modification",
  "real estate lending",
  "bankruptcy",
  "appraisal",
  "commercial property",
  "note sale",
  "loan-to-value",
]

/** The 1st Congress convened in 1789 and each runs two years. */
export function currentCongress(now: Date): number {
  return Math.floor((now.getFullYear() - 1789) / 2) + 1
}

type GovTrackBill = {
  display_number?: string
  title_without_number?: string
  title?: string
  current_status_label?: string
  current_status_date?: string
  link?: string
  sponsor?: { name?: string }
}

export function toSourcedBill(raw: GovTrackBill): SourcedBill | null {
  const displayNumber = raw.display_number?.trim()
  const title = (raw.title_without_number || raw.title)?.trim()
  const statusDate = raw.current_status_date?.slice(0, 10)
  if (!displayNumber || !title || !statusDate || !raw.link) return null
  return {
    displayNumber,
    title,
    statusLabel: raw.current_status_label?.trim() || "In committee",
    statusDate,
    url: raw.link,
    sponsor: raw.sponsor?.name?.trim() || undefined,
  }
}

/**
 * Relevance is judged on the authoritative title and nothing else.
 *
 * This is stricter than it could be and the cost is known: H.R. 10375 modernises the SBA 504
 * programme, which is commercial real estate lending, and nothing in any of its titles says so.
 * The alternative is asking a model to judge, which is how invented items got in. A real bill
 * missed is recoverable; a fabricated one quoted in a credit memo is not.
 *
 * The test is passed in rather than imported so that this module owns no policy: the feed already
 * has one gate deciding what bears on the firm, and a second copy here could disagree with it.
 */
export function selectRelevantBills(
  bills: SourcedBill[],
  isRelevant: (title: string) => boolean,
  limit = 5
): SourcedBill[] {
  return bills
    .filter((b) => isRelevant(b.title))
    .sort((a, b) => b.statusDate.localeCompare(a.statusDate))
    .slice(0, limit)
}

/**
 * Titles differing only in their session year are the same legislation reintroduced, and a
 * companion bill carries the same title in the other chamber. Both read as duplicates on the page.
 */
export function normalizeBillTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bof \d{4}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Two rounds, because a bill repeats for two different reasons.
 *
 * It surfaces under several of the twelve searches, which is the same bill twice. And the House and
 * Senate move companion bills with identical titles, which is one piece of legislation in two
 * chambers — "Bankruptcy Threshold Adjustment Act" arrived as both H.R. 7730 and S. 3977. Showing
 * both is the padding this feed is supposed to have stopped doing, so the one with the later action
 * wins: it is the copy that has actually moved.
 */
export function dedupeBills(bills: SourcedBill[]): SourcedBill[] {
  const keep = (map: Map<string, SourcedBill>, key: string, bill: SourcedBill) => {
    const existing = map.get(key)
    if (!existing || bill.statusDate > existing.statusDate) map.set(key, bill)
  }

  const byNumber = new Map<string, SourcedBill>()
  for (const bill of bills) keep(byNumber, bill.displayNumber, bill)

  const byTitle = new Map<string, SourcedBill>()
  for (const bill of byNumber.values()) keep(byTitle, normalizeBillTitle(bill.title), bill)

  return [...byTitle.values()]
}

async function searchBills(
  query: string,
  congress: number,
  since: string,
  timeoutMs: number
): Promise<SourcedBill[]> {
  const url =
    `https://www.govtrack.us/api/v2/bill?congress=${congress}` +
    `&q=${encodeURIComponent(query)}&current_status_date__gte=${since}` +
    `&order_by=-current_status_date&limit=25`
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return []
    const data = (await res.json()) as { objects?: GovTrackBill[] }
    return (data.objects ?? []).map(toSourcedBill).filter((b): b is SourcedBill => b !== null)
  } catch {
    return []
  }
}

/**
 * Absorbs govtrack's cold start, once, before the searches fan out.
 *
 * Measured: the first request after a period of idleness took 28 seconds, and every request after
 * it took a quarter of a second. Production makes exactly one cold request a day, because the feed
 * is generated by a daily cron, so the old arrangement raced all twelve searches against a
 * 15-second timeout that the first of them was always going to lose — and losing them all empties
 * the section. Retrying does not help: four attempts at 20 seconds failed in a row before one at
 * 60 seconds succeeded in 28. The wait is real and has to be waited out.
 *
 * The cheapest request that still warms it, and its result is thrown away. A failure here is
 * ignored: the searches will fail too, and they report it.
 */
async function warmUp(congress: number, timeoutMs: number): Promise<void> {
  try {
    await fetch(`https://www.govtrack.us/api/v2/bill?congress=${congress}&limit=1`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
  } catch {
    /* the searches report their own failure */
  }
}

/**
 * One query failing is not the section failing — these are twelve independent searches over the
 * same record, so a timeout on one costs some recall and nothing else.
 */
export async function fetchFederalBills(
  now: Date,
  windowDays: number,
  isRelevant: (title: string) => boolean,
  limit = 5,
  timeoutMs = 20_000,
  warmUpMs = 35_000
): Promise<SourcedBill[]> {
  const congress = currentCongress(now)
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)
  await warmUp(congress, warmUpMs)
  const batches = await Promise.all(
    SEARCH_QUERIES.map((q) => searchBills(q, congress, since, timeoutMs))
  )
  return selectRelevantBills(dedupeBills(batches.flat()), isRelevant, limit)
}

/**
 * What the item says before a model has seen it.
 *
 * Written from the record alone so that a failed or skipped summarisation step degrades to a
 * thinner item rather than no item. Everything here is quotable: it is the bill's own number,
 * title, status and sponsor.
 */
export function describeFromRecord(bill: SourcedBill): string {
  const sponsor = bill.sponsor ? ` Sponsored by ${bill.sponsor}.` : ""
  return `${bill.displayNumber}, ${bill.title}. Status as of ${bill.statusDate}: ${bill.statusLabel}.${sponsor}`
}
