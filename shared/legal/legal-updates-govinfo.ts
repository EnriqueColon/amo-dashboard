/**
 * What the Government Publishing Office holds on a federal bill, for the Legislative Tracker.
 *
 * govtrack (`legal-updates-legislation.ts`) finds the bills and supplies their identity. It is thin
 * past that — number, title, status, sponsor — and for weeks the open note on the federal side was
 * that there was no text route without an API key: congress.gov's API answers 403 and govinfo's
 * answers 401 without one. Both are true of the *APIs*. GPO's bulk data needs no key at all, and
 * carries everything the Florida side gets from LegiScan and more:
 *
 *   BILLSTATUS  the record — sponsor and cosponsors, committees, every action, related bills,
 *               subject terms, text versions, committee report citations, and the Congressional
 *               Research Service's summary of the bill, where CRS has written one.
 *   BILLS       the text of each version, as XML.
 *   CRPT        the committee report, where the bill was reported — "Purpose and Summary",
 *               "Background and Need for the Legislation", the committee's votes.
 *
 * So a federal bill's card can show the same three layers as a rule or a Florida bill: the record,
 * then the source's own account of itself (the CRS summary and the report, or the text where there
 * is neither), then the model's prose about what it was handed. The CRS summary is the Library of
 * Congress's plain-English statement of what a bill does — the federal counterpart of Florida's
 * staff analysis — and a bill that has not moved often has none, in which case the text is short
 * enough to be read whole.
 *
 * Import-free so the test runner can load it; the fetches take a timeout and fail to `undefined`,
 * leaving the item as govtrack described it.
 */

export type BillAction = { date: string; text: string }

export type BillRecord = {
  /** "Rep. Ben Cline [R-VA-6]" — the record's "Cline, Ben" turned around. */
  sponsor?: string
  cosponsors: number
  introducedOn?: string
  committees: string[]
  policyArea?: string
  subjects: string[]
  /** Deduped and newest first; the record lists most floor actions twice, once per source system. */
  actions: BillAction[]
  latestAction?: BillAction
  /** "S. 3977 (identical bill)" */
  relatedBills: Array<{ number: string; relationship: string }>
  /** Newest first. `url` is the XML; `pageUrl` is the same version as a page a reader can open. */
  textVersions: Array<{ type: string; date: string; url: string; pageUrl: string }>
  reports: Array<{ citation: string; url: string }>
  /** CRS summaries, newest first. `text` is plain text; the record carries HTML. */
  summaries: Array<{ date: string; description: string; text: string }>
  /** congress.gov's page for the bill. */
  legislationUrl?: string
}

// ── Locating the record ────────────────────────────────────────────────────────

/**
 * "H.R. 7730" → "hr", "S. 5477" → "s", "H.J.Res. 12" → "hjres". The record's own abbreviations,
 * which are also the path segments GPO files it under.
 */
export function parseBillNumber(displayNumber: string): { type: string; number: number } | undefined {
  const m = displayNumber.trim().match(/^([A-Za-z.]+?)\s*(\d+)$/)
  if (!m) return undefined
  const type = m[1].toLowerCase().replace(/\./g, "")
  const number = Number(m[2])
  if (!["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"].includes(type) || !number) return undefined
  return { type, number }
}

export function billStatusUrl(displayNumber: string, congress: number): string | undefined {
  const parsed = parseBillNumber(displayNumber)
  if (!parsed) return undefined
  return `https://www.govinfo.gov/bulkdata/BILLSTATUS/${congress}/${parsed.type}/BILLSTATUS-${congress}${parsed.type}${parsed.number}.xml`
}

// ── Reading the XML ────────────────────────────────────────────────────────────
//
// The record is regular, shallow and well-formed, and this module keeps no imports, so it is read
// with a handful of tag matchers rather than a parser. Each one works on a block already cut from
// its parent, which is what keeps `<item>` inside `<sponsors>` apart from `<item>` inside
// `<actions>`.

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * The contents of each top-level `<tag>` in `xml`, nesting respected. The record nests the same
 * tag inside itself — `<item>` for a committee holds `<item>`s for its activities, a text version's
 * `<item>` holds `<item>`s for its formats — and a non-greedy match closes at the inner tag,
 * leaving the outer one cut in half.
 */
function blocks(xml: string, tag: string): string[] {
  const token = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?(/?)>`, "g")
  const out: string[] = []
  let depth = 0
  let start = -1
  for (const m of xml.matchAll(token)) {
    if (m[2] === "/") continue // self-closing: nothing inside
    if (m[1] === "") {
      if (depth === 0) start = m.index + m[0].length
      depth += 1
    } else {
      depth -= 1
      if (depth === 0 && start >= 0) out.push(xml.slice(start, m.index))
      if (depth < 0) depth = 0
    }
  }
  return out
}

function block(xml: string, tag: string): string | undefined {
  return blocks(xml, tag)[0]
}

function text(xml: string | undefined, tag: string): string | undefined {
  if (!xml) return undefined
  const inner = block(xml, tag)
  if (inner === undefined) return undefined
  const value = decodeEntities(inner.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")).trim()
  return value.length > 0 ? value : undefined
}

/** HTML or bill XML to plain text: block ends become line breaks, everything else is dropped. */
function markupToText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|header|section|subsection|paragraph|subparagraph|clause|text|official-title|legis-type|quoted-block|toc-entry)>/gi, "\n")
      .replace(/<enum>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

/** "Rep. Cline, Ben [R-VA-6]" → "Rep. Ben Cline [R-VA-6]". */
export function describeMember(fullName: string): string {
  const m = fullName.match(/^(Rep\.|Sen\.|Del\.|Resident Commissioner)\s+([^,\[]+),\s*([^\[]+?)\s*(\[[^\]]+\])?$/)
  if (!m) return fullName.trim()
  return `${m[1]} ${m[3].trim()} ${m[2].trim()}${m[4] ? ` ${m[4]}` : ""}`
}

/**
 * The Library of Congress restates each chamber's floor action under its own prefix —
 * "Passed/agreed to in Senate: Passed Senate without amendment…" — so most floor actions appear
 * twice on the same date. One copy is kept, the chamber's own, which is the shorter.
 */
export function dedupeActions(actions: BillAction[]): BillAction[] {
  const seen = new Map<string, BillAction>()
  for (const action of actions) {
    const key = `${action.date}|${action.text.replace(/^[^:]{0,60}:\s*/, "").toLowerCase()}`
    const existing = seen.get(key)
    if (!existing || action.text.length < existing.text.length) seen.set(key, action)
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date))
}

/** govinfo keeps every version as a page beside the XML; the reader gets the page. */
function pageUrlFor(xmlUrl: string): string {
  return xmlUrl.replace(/\/xml\/([^/]+)\.xml$/, "/html/$1.htm")
}

/** "H. Rept. 119-783" → govinfo's page for it. "S. Rept." likewise. */
export function reportUrlFor(citation: string): string | undefined {
  const m = citation.match(/^(H|S)\.\s*Rept\.\s*(\d+)-(\d+)/i)
  if (!m) return undefined
  const pkg = `CRPT-${m[2]}${m[1].toLowerCase()}rpt${m[3]}`
  return `https://www.govinfo.gov/content/pkg/${pkg}/html/${pkg}.htm`
}

export function parseBillStatus(xml: string): BillRecord | undefined {
  const bill = block(xml, "bill")
  if (!bill) return undefined

  const sponsorName = text(block(bill, "sponsors"), "fullName")
  const cosponsors = blocks(block(bill, "cosponsors") ?? "", "item").length
  const committees = blocks(block(bill, "committees") ?? "", "item")
    .map((item) => text(item, "name"))
    .filter((n): n is string => !!n)
  const subjects = blocks(block(block(bill, "subjects") ?? "", "legislativeSubjects") ?? "", "item")
    .map((item) => text(item, "name"))
    .filter((n): n is string => !!n)

  const actions = dedupeActions(
    blocks(block(bill, "actions") ?? "", "item")
      .map((item) => ({ date: text(item, "actionDate") ?? "", text: text(item, "text") ?? "" }))
      .filter((a) => a.date && a.text)
  )

  const relatedBills = blocks(block(bill, "relatedBills") ?? "", "item")
    .map((item) => {
      const type = text(item, "type")
      const number = text(item, "number")
      const relationship = text(block(item, "relationshipDetails") ?? "", "type")
      if (!type || !number) return undefined
      const display = type.toUpperCase() === "HR" ? "H.R." : `${type.toUpperCase().replace(/(RES)$/, ".Res")}.`
      return { number: `${display} ${number}`, relationship: (relationship ?? "related bill").toLowerCase() }
    })
    .filter((r): r is { number: string; relationship: string } => !!r)

  const textVersions = blocks(block(bill, "textVersions") ?? "", "item")
    .map((item) => {
      const url = blocks(block(item, "formats") ?? "", "item")
        .map((f) => text(f, "url"))
        .find((u): u is string => !!u && /\.xml$/i.test(u))
      const type = text(item, "type")
      if (!type || !url) return undefined
      return { type, date: (text(item, "date") ?? "").slice(0, 10), url, pageUrl: pageUrlFor(url) }
    })
    .filter((v): v is BillRecord["textVersions"][number] => !!v)
    .sort((a, b) => b.date.localeCompare(a.date))

  const reports = blocks(block(bill, "committeeReports") ?? "", "committeeReport")
    .map((item) => text(item, "citation"))
    .filter((c): c is string => !!c)
    .map((citation) => ({ citation, url: reportUrlFor(citation) }))
    .filter((r): r is { citation: string; url: string } => !!r.url)

  const summaries = blocks(block(bill, "summaries") ?? "", "summary")
    .map((item) => ({
      date: text(item, "actionDate") ?? "",
      description: text(item, "actionDesc") ?? "",
      text: markupToText(block(item, "text") ?? ""),
    }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))

  // The bill's own latest action is the last <latestAction> in the file; related bills carry
  // their own, earlier in it.
  const latestBlocks = blocks(bill, "latestAction")
  const latestRaw = latestBlocks[latestBlocks.length - 1]
  const latestAction =
    latestRaw && text(latestRaw, "actionDate") && text(latestRaw, "text")
      ? { date: text(latestRaw, "actionDate") as string, text: text(latestRaw, "text") as string }
      : actions[0]

  return {
    sponsor: sponsorName ? describeMember(sponsorName) : undefined,
    cosponsors,
    introducedOn: text(bill, "introducedDate"),
    committees,
    policyArea: text(block(bill, "policyArea"), "name"),
    subjects,
    actions,
    latestAction,
    relatedBills,
    textVersions,
    reports,
    summaries,
    legislationUrl: text(bill, "legislationUrl"),
  }
}

// ── Fetching ───────────────────────────────────────────────────────────────────

const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" }

async function fetchText(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" })
    if (!res.ok) return undefined
    return await res.text()
  } catch {
    return undefined
  }
}

export async function fetchBillRecord(
  displayNumber: string,
  congress: number,
  timeoutMs = 15_000
): Promise<BillRecord | undefined> {
  const url = billStatusUrl(displayNumber, congress)
  if (!url) return undefined
  const xml = await fetchText(url, timeoutMs)
  return xml ? parseBillStatus(xml) : undefined
}

/**
 * How much the model is given, in words. A bill's text is read whole when it is short — most of
 * what reaches this feed is a few hundred to a couple of thousand words — and cut when it is not;
 * an appropriations act is not going to be condensed into five bullets however much of it is sent.
 * The report excerpt is the committee's own account and is already the distilled form.
 */
export const BILL_TEXT_WORD_CAP = 3_000
export const REPORT_WORD_CAP = 2_500

function truncateWords(s: string, limit: number): string {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length <= limit) return s.trim()
  return words.slice(0, limit).join(" ") + " […]"
}

/**
 * The bill's text, from the enacting clause on. The XML's metadata block and form (distribution
 * code, the "IN THE SENATE OF THE UNITED STATES" heading, the introduction line) say nothing the
 * record has not already said, so the body alone is kept: the official title, then the sections.
 */
export function billXmlToText(xml: string): string {
  const title = text(xml, "official-title")
  const body = block(xml, "legis-body") ?? block(xml, "resolution-body") ?? xml.replace(/<metadata[\s\S]*?<\/metadata>/, "").replace(/<form>[\s\S]*?<\/form>/, "")
  const sections = markupToText(body)
  return [title, sections].filter((s): s is string => !!s && s.length > 0).join("\n")
}

export async function fetchBillText(
  record: BillRecord,
  timeoutMs = 15_000,
  cap = BILL_TEXT_WORD_CAP
): Promise<string | undefined> {
  const latest = record.textVersions[0]
  if (!latest) return undefined
  const xml = await fetchText(latest.url, timeoutMs)
  if (!xml) return undefined
  const plain = billXmlToText(xml)
  return plain.length > 0 ? truncateWords(plain, cap) : undefined
}

/**
 * The part of a committee report worth the model's attention.
 *
 * A House report opens with a contents list whose entries end in dot leaders, then repeats each
 * heading over its section. The body is taken from the first "Purpose and Summary" that is a
 * heading rather than a contents entry, through "Background and Need", hearings, consideration and
 * the committee's votes, and stops at "Committee Oversight Findings" — after which the report is
 * budget statements, rule citations and the text of the statute as amended, none of which is the
 * committee explaining its bill. A report without those headings is taken from the top.
 */
export function selectReportText(plain: string, cap = REPORT_WORD_CAP): string {
  const lines = plain.split("\n")
  const isHeading = (line: string, name: RegExp) => name.test(line) && !/\.{4,}\s*\d*\s*$/.test(line)
  let start = lines.findIndex((l) => isHeading(l, /^\s*(I\.\s+)?Purpose and Summary\s*$/i))
  if (start < 0) start = 0
  let end = lines.findIndex((l, i) => i > start && isHeading(l, /^\s*([IVX]+\.\s+)?(Committee Oversight Findings|New Budget Authority|Congressional Budget Office Cost Estimate|Changes in Existing Law)\b/i))
  if (end < 0) end = lines.length
  return truncateWords(lines.slice(start, end).join("\n"), cap)
}

export async function fetchReportText(
  record: BillRecord,
  timeoutMs = 15_000,
  cap = REPORT_WORD_CAP
): Promise<string | undefined> {
  const report = record.reports[0]
  if (!report) return undefined
  const html = await fetchText(report.url, timeoutMs)
  if (!html) return undefined
  const body = html.match(/<pre[\s>][\s\S]*?<\/pre>/i)?.[0] ?? html.match(/<body[\s>][\s\S]*?<\/body>/i)?.[0] ?? html
  const plain = markupToText(body.replace(/<(script|style)[\s>][\s\S]*?<\/\1>/gi, " "))
  const selected = selectReportText(plain, cap)
  return selected.length > 0 ? selected : undefined
}

/** Everything that was read about one bill, for the prompt. Absent fields were not available. */
export type BillSources = {
  crsSummary?: { description: string; date: string; text: string }
  reportText?: string
  billText?: string
}

export async function fetchBillSources(record: BillRecord, timeoutMs = 15_000): Promise<BillSources> {
  const [reportText, billText] = await Promise.all([fetchReportText(record, timeoutMs), fetchBillText(record, timeoutMs)])
  const crs = record.summaries[0]
  return {
    crsSummary: crs ? { description: crs.description, date: crs.date, text: crs.text } : undefined,
    reportText,
    billText,
  }
}

export function hasSources(sources: BillSources | undefined): boolean {
  return !!sources && !!(sources.crsSummary || sources.reportText || sources.billText)
}

// ── The record, as a reader would cite it ──────────────────────────────────────

/**
 * How a bill passed each chamber, from its actions: "House 2026-09-16 (voice vote, under
 * suspension); Senate 2026-09-28 (unanimous consent)". The manner is as telling as the fact —
 * suspension and unanimous consent are the routes for bills nobody objects to.
 */
export function describePassage(actions: BillAction[]): string | undefined {
  // Each chamber's clerk has its own phrasing for passage, and the record keeps the clerk's text.
  const PASSAGE: Record<"House" | "Senate", RegExp> = {
    House: /^(On passage Passed|On motion to suspend the rules and pass [^.]*Agreed to|Passed\/agreed to in House)/i,
    Senate: /^(Passed Senate|Passed\/agreed to in Senate)/i,
  }
  const oldestFirst = [...actions].reverse()
  const parts: string[] = []
  for (const chamber of ["House", "Senate"] as const) {
    const passed = oldestFirst.find((a) => PASSAGE[chamber].test(a.text))
    if (!passed) continue
    // The Congressional Record citation ("CR H5939-5940") looks like a tally and is not one.
    const t = shortenAction(passed.text)
    const tally = t.match(/(\d+)\s*-\s*(\d+)/)
    const manner = /unanimous consent/i.test(t)
      ? "unanimous consent"
      : tally
        ? `${tally[1]}–${tally[2]}`
        : /voice vote/i.test(t)
          ? /suspend the rules/i.test(t) ? "voice vote, under suspension" : "voice vote"
          : undefined
    parts.push(`${chamber} ${passed.date}${manner ? ` (${manner})` : ""}`)
  }
  return parts.length > 0 ? parts.join("; ") : undefined
}

/**
 * An action as the card has room for it: without the Congressional Record citation, and without
 * the House's referral formula ("for a period to be subsequently determined by the Speaker, in
 * each case for consideration of such provisions as fall within the jurisdiction of the committee
 * concerned"), which says only that two committees share the bill.
 */
export function shortenAction(text: string): string {
  return text
    .replace(/\s*\((consideration|text):[^)]*\)\s*$/i, "")
    .replace(/,?\s*for a period to be subsequently determined by the Speaker,?\s*in each case for consideration of such provisions as fall within the jurisdiction of the committee concerned/i, "")
    .replace(/\.$/, "")
    .trim()
}

/**
 * The record's own facts, none of them through a model. The shape matches `RecordFact` in the
 * Federal Register module; declared structurally so this file keeps no imports.
 */
export function describeBillRecord(record: BillRecord): Array<{ label: string; value: string; url?: string }> {
  const facts: Array<{ label: string; value: string; url?: string }> = []
  if (record.sponsor) facts.push({ label: "Sponsor", value: record.sponsor })
  if (record.cosponsors > 0) facts.push({ label: "Cosponsors", value: String(record.cosponsors) })
  if (record.introducedOn) facts.push({ label: "Introduced", value: record.introducedOn })
  if (record.committees.length > 0) facts.push({ label: record.committees.length > 1 ? "Committees" : "Committee", value: record.committees.join("; ") })
  const passage = describePassage(record.actions)
  if (passage) facts.push({ label: "Passed", value: passage })
  if (record.latestAction) facts.push({ label: "Last action", value: `${shortenAction(record.latestAction.text)} (${record.latestAction.date})` })
  for (const related of record.relatedBills.slice(0, 2)) facts.push({ label: related.relationship === "identical bill" ? "Identical" : "Related", value: related.number })
  if (record.reports[0]) facts.push({ label: "Report", value: record.reports[0].citation, url: record.reports[0].url })
  if (record.textVersions[0]) facts.push({ label: "Text", value: `${record.textVersions[0].type} (${record.textVersions[0].date})`, url: record.textVersions[0].pageUrl })
  if (record.summaries[0] && record.legislationUrl) facts.push({ label: "CRS summary", value: `${record.summaries[0].description} (${record.summaries[0].date})`, url: `${record.legislationUrl}/summary` })
  if (record.policyArea) facts.push({ label: "Policy area", value: record.policyArea })
  return facts
}

/** For the card's label over the details: "From the CRS summary and the bill text". */
export function describeSourcesRead(sources: BillSources | undefined): string | undefined {
  if (!sources) return undefined
  const read: string[] = []
  if (sources.crsSummary) read.push("the CRS summary")
  if (sources.reportText) read.push("the committee report")
  if (sources.billText) read.push("the bill text")
  if (read.length === 0) return undefined
  const list = read.length === 1 ? read[0] : `${read.slice(0, -1).join(", ")} and ${read[read.length - 1]}`
  return `From ${list}`
}

// ── The prompt ─────────────────────────────────────────────────────────────────

type PromptBill = { displayNumber: string; title: string; statusLabel: string; statusDate: string; sponsor?: string }

/**
 * Asks only for prose, and supplies the facts. Keyed by bill number on the way back.
 *
 * Where the CRS summary, the committee report or the text was read, the model is told which and
 * asked for specifics with that as the only source. Where nothing was, the ask is the thin one it
 * always was and the details list is to be left empty — never filled from memory, which for a bill
 * number is the fastest route to a confident account of some other bill.
 */
export function buildFederalBillSummaryPrompt(bills: PromptBill[], sources: Map<string, BillSources> = new Map()): string {
  const list = bills
    .map((b) => {
      const head = `- ${b.displayNumber} [status: ${b.statusLabel}, as of ${b.statusDate}${b.sponsor ? `, sponsor: ${b.sponsor}` : ""}]: ${b.title}`
      const s = sources.get(b.displayNumber)
      const parts: string[] = []
      if (s?.crsSummary) parts.push(`  Congressional Research Service summary (${s.crsSummary.description}, ${s.crsSummary.date}):\n"""\n${s.crsSummary.text}\n"""`)
      if (s?.reportText) parts.push(`  Committee report, explanatory sections:\n"""\n${s.reportText}\n"""`)
      if (s?.billText) parts.push(`  Bill text:\n"""\n${s.billText}\n"""`)
      return parts.length > 0 ? `${head}\n${parts.join("\n")}` : `${head}\n  (no summary, report or text was available)`
    })
    .join("\n\n")

  return `These are real federal bills, taken from the legislative record. Their numbers, titles, statuses, dates and sponsors are already confirmed — do not restate, correct or change them, and do not add bills.

${list}

For each one, write three things for a firm that buys and works out distressed commercial real estate debt:
- "summary": 2-3 sentences in plain English on what the bill would actually do. Base this only on the material given for that bill; where none is given, say what the title states and no more.
- "details": where a CRS summary, committee report or bill text is given, 3 to 5 bullet points, each one sentence of at most 30 words, stating the specific things that material says: what the bill changes in current law and the section it amends, who it applies to, any amounts, thresholds, dates or effective dates, the committee's vote where the report gives it, and the committee's stated reason for the bill. Use the material's own terms. Where nothing is given, return an empty list; never fill it from memory. Where material is marked as cut short ("[…]"), say nothing about what it does not cover.
- "whyItMatters": 1-2 sentences on the consequence for note purchases, workouts, foreclosures or REO. If the honest answer is that the effect is indirect or minimal, say that instead of inflating it.

Where a bill's effect on commercial real estate is incidental, say so plainly. An item that explains why it is marginal is more useful than one that pretends otherwise.

Return ONLY valid JSON, keyed by bill number exactly as written above:
{
  "summaries": {
    "${bills[0]?.displayNumber ?? "H.R. 1234"}": { "summary": "...", "details": ["...", "..."], "whyItMatters": "..." }
  }
}`
}
