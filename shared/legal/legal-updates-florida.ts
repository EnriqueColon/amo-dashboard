/**
 * Florida bills for the Legislative Tracker, taken from the legislative record.
 *
 * `legal-updates-legislation.ts` says Florida is not covered because there is no open API for the
 * Florida legislature. That was true of the *free and keyless* options, and it left Florida as the
 * half of the section the model still invented. It turns out `LEGISCAN_API_KEY` has been sitting in
 * the environment since the project was set up, listed as required in a deployment checklist and
 * read by nothing — `confluence.md` recorded that it was unused. It works, and LegiScan indexes
 * Florida completely, so the same correction applies here as applied to federal bills.
 *
 * Two calls per session rather than a search: `getMasterList` returns every bill in a session with
 * its title, official description, status and last action, which is one request instead of a dozen
 * searches, and it cannot miss a bill because a search term did not happen to appear in it. The
 * per-bill call is made only for the handful that survive the gate, because only they need a
 * citation — `state_link`, which points at flsenate.gov.
 *
 * That per-bill call returns far more than the link: sponsors, the full action history, every
 * roll call, the companion bill, each text version, and the legislature's own staff analyses.
 * For a while only the link was used. The record facts now come from the rest of it, and the
 * staff analysis — nonpartisan committee staff explaining what the bill does, in prose — is what
 * the model is handed to summarise, in place of a one-sentence official description.
 */

export type SourcedFloridaBill = {
  /** As Florida prints it: "SB 300", "HB 1423". */
  displayNumber: string
  title: string
  /** Human-readable status: "Passed", "Died in Rules". */
  statusLabel: string
  /** Date of the most recent action, which is what the feed dates the item to. */
  statusDate: string
  /** The flsenate.gov page for the bill, which is what the tab cites. */
  url: string
  /** The legislature's own description. Authoritative text, so the gate may read it. */
  description?: string
  chamber: "senate" | "house"
  sessionName: string
  /** As a reader would name them: "Rep. David Smith (R, HD-038)"; a committee sponsor by its name. */
  sponsors: string[]
  /** Date of the first recorded action, which Florida calls "Filed". */
  filedOn?: string
  /** The same-as bill in the other chamber, as Florida prints it: "SB 532". */
  companion?: string
  /** The most recent roll call, which says how far the bill actually got. */
  lastVote?: { description: string; yea: number; nay: number; date: string; passed: boolean }
  /** The latest text version, linked to the legislature's own copy. */
  latestText?: { type: string; date: string; url: string }
  /** The latest staff analysis, linked. Florida publishes one per committee stop. */
  analysis?: { description: string; date: string; url: string }
}

/**
 * LegiScan's `status` is an integer with a fixed meaning across every state. `last_action` is
 * richer where it exists ("Died in Rules", "Chapter No. 2026-207") and is preferred; this is the
 * fallback, and the reason nothing depends on the integer alone.
 */
const STATUS_LABELS: Record<number, string> = {
  1: "Introduced",
  2: "Engrossed",
  3: "Enrolled",
  4: "Passed",
  5: "Vetoed",
  6: "Failed",
}

/**
 * LegiScan hands back the legislature's text with HTML entities still in it — "clerk&#39;s office"
 * rendered literally on the tab. Only the handful of entities that actually appear in bill text;
 * this is not a general HTML decoder and does not need to be.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * LegiScan numbers Florida bills `H0011` and `S0274`; Florida itself writes "HB 11" and "SB 274",
 * and so does flsenate.gov. The conversion matters beyond presentation: the bill-identity guard
 * reads the number back out of the title and looks for it on the cited page, and it is looking for
 * the form the page actually prints.
 */
export function toDisplayNumber(legiscanNumber: string): string | null {
  const m = /^([HS])(\d+)([A-Z]*)$/i.exec(legiscanNumber.trim())
  if (!m) return null
  const chamber = m[1].toUpperCase() === "S" ? "SB" : "HB"
  const number = String(Number(m[2]))
  if (number === "0" || number === "NaN") return null
  // A special-session suffix is part of the number, not decoration: flsenate prints "HB 1F".
  return `${chamber} ${number}${m[3].toUpperCase()}`
}

/**
 * Florida numbers its local bills in the 4000s — bills affecting one county, city or special
 * district. Of the 53 in the 2026 regular session, 48 name a county, city, town, village or
 * authority in the title ("Pace Fire Rescue District, Santa Rosa County"), and none is about
 * commercial real estate.
 *
 * They are excluded because they reach the gate by accident: the boilerplate describing a
 * district's boundaries and taxing powers mentions industrial property, which is enough for a term
 * match and tells a note buyer nothing. Checked against the whole window, excluding them costs no
 * item that would otherwise have qualified.
 */
export function isLocalBill(displayNumber: string): boolean {
  const m = /^[HS]B (\d+)/.exec(displayNumber)
  if (!m) return false
  const n = Number(m[1])
  return n >= 4000 && n <= 4999
}

/**
 * The reviser's bills, titled simply "Florida Statutes". Six of them in the 2026 session, adopting
 * the year's statutes and deleting provisions that "have become inoperative by noncurrent repeal"
 * — which is a term match on `noncurrent` and not a change to anything. They are housekeeping, and
 * a reader who wants them is reading the statutes, not this tab.
 */
export function isReviserBill(title: string): boolean {
  const t = title.trim().toLowerCase()
  return t === "florida statutes" || t === "revision of the florida statutes"
}

type MasterListBill = {
  bill_id?: number
  number?: string
  title?: string
  description?: string
  status?: number
  status_date?: string
  last_action?: string
  last_action_date?: string
}

export type FloridaCandidate = {
  billId: number
  displayNumber: string
  title: string
  description?: string
  statusLabel: string
  statusDate: string
  chamber: "senate" | "house"
  sessionName: string
}

/**
 * A master-list row turned into a candidate, or `null` where the row cannot be trusted.
 *
 * The structural exclusions happen here rather than in the relevance gate, because they are facts
 * about what kind of bill this is rather than judgements about its subject.
 */
export function toCandidate(raw: MasterListBill, sessionName: string): FloridaCandidate | null {
  const displayNumber = raw.number ? toDisplayNumber(raw.number) : null
  const title = raw.title ? decodeEntities(raw.title).trim() : undefined
  const statusDate = (raw.last_action_date || raw.status_date)?.slice(0, 10)
  if (!displayNumber || !title || !statusDate || !raw.bill_id) return null
  if (isLocalBill(displayNumber) || isReviserBill(title)) return null

  return {
    billId: raw.bill_id,
    displayNumber,
    title,
    description: raw.description ? decodeEntities(raw.description).trim() || undefined : undefined,
    statusLabel: raw.last_action ? decodeEntities(raw.last_action).trim() : STATUS_LABELS[raw.status ?? 0] || "Introduced",
    statusDate,
    chamber: displayNumber.startsWith("S") ? "senate" : "house",
    sessionName,
  }
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

type SessionRow = { session_id?: number; session_name?: string; year_end?: number }

/**
 * Sessions whose final year could still hold an action inside the window.
 *
 * Florida runs a regular session and any number of special ones — eight sessions fall inside a
 * 400-day window — and a bill's last action can postdate the session that produced it, so the
 * filter is deliberately loose at the session level and exact at the bill level.
 */
export function selectSessions(sessions: SessionRow[], sinceYear: number): number[] {
  return sessions
    .filter((s) => typeof s.session_id === "number" && (s.year_end ?? 0) >= sinceYear)
    .map((s) => s.session_id as number)
}

/** The `masterlist` object carries a `session` entry alongside the bills; it is not a bill. */
function billRows(masterlist: unknown): MasterListBill[] {
  if (!masterlist || typeof masterlist !== "object") return []
  return Object.entries(masterlist as Record<string, unknown>)
    .filter(([key]) => key !== "session")
    .map(([, value]) => value as MasterListBill)
}

/**
 * Candidates across every session in the window, already structurally filtered and date-bounded.
 *
 * Separated from the relevance step so that the expensive part — one `getBill` call per survivor —
 * happens only for bills that will actually be shown.
 */
export async function fetchFloridaCandidates(
  apiKey: string,
  now: Date,
  windowDays: number,
  timeoutMs = 20_000
): Promise<FloridaCandidate[]> {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)
  const base = `https://api.legiscan.com/?key=${encodeURIComponent(apiKey)}`

  const list = (await getJson(`${base}&op=getSessionList&state=FL`, timeoutMs)) as {
    sessions?: SessionRow[]
  } | null
  const sessionIds = selectSessions(list?.sessions ?? [], Number(since.slice(0, 4)))
  if (sessionIds.length === 0) return []

  const perSession = await Promise.all(
    sessionIds.map(async (id) => {
      const data = (await getJson(`${base}&op=getMasterList&id=${id}`, timeoutMs)) as {
        masterlist?: Record<string, unknown>
      } | null
      const sessionRow = data?.masterlist?.session as { session_name?: string } | undefined
      const sessionName = sessionRow?.session_name?.trim() || "Florida Legislature"
      return billRows(data?.masterlist)
        .map((row) => toCandidate(row, sessionName))
        .filter((c): c is FloridaCandidate => c !== null && c.statusDate >= since)
    })
  )

  return perSession.flat()
}

type Sponsor = {
  name?: string
  role?: string
  party?: string
  district?: string
  committee_sponsor?: number
  sponsor_type_id?: number
  sponsor_order?: number
}
type HistoryRow = { date?: string; action?: string }
type Vote = { date?: string; desc?: string; yea?: number; nay?: number; passed?: number }
type SameAs = { type?: string; sast_bill_number?: string }
type TextVersion = { date?: string; type?: string; state_link?: string; url?: string }
type Supplement = { date?: string; type?: string; title?: string; description?: string; state_link?: string; url?: string }

export type BillDetail = {
  state_link?: string
  url?: string
  status?: number
  status_date?: string
  description?: string
  sponsors?: Sponsor[]
  history?: HistoryRow[]
  votes?: Vote[]
  sasts?: SameAs[]
  texts?: TextVersion[]
  supplements?: Supplement[]
}

/** "Rep. David Smith (R, HD-038)"; a committee sponsor is named as the committee. */
export function describeSponsor(s: Sponsor): string | null {
  const name = s.name?.trim()
  if (!name) return null
  if (s.committee_sponsor) return name
  const role = s.role?.trim()
  const tags = [s.party?.trim(), s.district?.trim()].filter(Boolean).join(", ")
  return `${role ? `${role}. ` : ""}${name}${tags ? ` (${tags})` : ""}`
}

/**
 * Primary sponsors only, in the legislature's order. Florida bills routinely carry a dozen
 * co-sponsors; a reader wants to know who brought it, not who signed on.
 */
export function describeSponsors(sponsors: Sponsor[] | undefined, limit = 3): string[] {
  const primary = (sponsors ?? []).filter((s) => (s.sponsor_type_id ?? 1) === 1)
  const chosen = primary.length > 0 ? primary : (sponsors ?? [])
  return chosen
    .slice()
    .sort((a, b) => (a.sponsor_order ?? 0) - (b.sponsor_order ?? 0))
    .map(describeSponsor)
    .filter((s): s is string => s !== null)
    .slice(0, limit)
}

/** The most recent roll call, or nothing where the bill never came to a vote. */
export function selectLastVote(votes: Vote[] | undefined): SourcedFloridaBill["lastVote"] {
  const dated = (votes ?? []).filter((v) => v.date && v.desc && typeof v.yea === "number" && typeof v.nay === "number")
  if (dated.length === 0) return undefined
  const last = dated.slice().sort((a, b) => (a.date as string).localeCompare(b.date as string)).pop() as Vote
  return {
    description: decodeEntities(last.desc as string).trim(),
    yea: last.yea as number,
    nay: last.nay as number,
    date: (last.date as string).slice(0, 10),
    passed: last.passed === 1,
  }
}

/** The latest version of the bill text, cited to the legislature's own copy where there is one. */
export function selectLatestText(texts: TextVersion[] | undefined): SourcedFloridaBill["latestText"] {
  const usable = (texts ?? []).filter((t) => t.date && (t.state_link || t.url))
  if (usable.length === 0) return undefined
  const last = usable.slice().sort((a, b) => (a.date as string).localeCompare(b.date as string)).pop() as TextVersion
  return {
    type: last.type?.trim() || "Text",
    date: (last.date as string).slice(0, 10),
    url: (last.state_link || last.url) as string,
  }
}

/**
 * The latest staff analysis. LegiScan files Florida's analyses under a mislabelled `type`
 * ("Veto Letter") but titles them "Analysis" and links them under `/Analyses/` on flsenate.gov;
 * either mark is accepted and the type is ignored.
 */
export function selectLatestAnalysis(supplements: Supplement[] | undefined): SourcedFloridaBill["analysis"] {
  const analyses = (supplements ?? []).filter(
    (s) => s.date && (s.state_link || s.url) && (/^analysis$/i.test(s.title?.trim() ?? "") || /\/Analyses\//i.test(s.state_link ?? ""))
  )
  if (analyses.length === 0) return undefined
  const last = analyses.slice().sort((a, b) => (a.date as string).localeCompare(b.date as string)).pop() as Supplement
  return {
    description: decodeEntities(last.description?.trim() || "Staff analysis"),
    date: (last.date as string).slice(0, 10),
    url: (last.state_link || last.url) as string,
  }
}

/** "SB 532" from LegiScan's `S532`, for the same-as bill in the other chamber. */
export function selectCompanion(sasts: SameAs[] | undefined): string | undefined {
  const same = (sasts ?? []).find((s) => /same as/i.test(s.type ?? "") && s.sast_bill_number)
  return same ? toDisplayNumber(same.sast_bill_number as string) ?? undefined : undefined
}

/** The record turned into a sourced bill; pure, so it can be tested against a captured response. */
export function toSourcedFloridaBill(candidate: FloridaCandidate, bill: BillDetail | undefined): SourcedFloridaBill | null {
  const url = bill?.state_link?.trim()
  if (!url) return null

  const filed = (bill?.history ?? []).find((h) => h.date)
  return {
    displayNumber: candidate.displayNumber,
    title: candidate.title,
    statusLabel: candidate.statusLabel,
    statusDate: candidate.statusDate,
    url,
    description:
      candidate.description ||
      (bill?.description ? decodeEntities(bill.description).trim() : undefined) ||
      undefined,
    chamber: candidate.chamber,
    sessionName: candidate.sessionName,
    sponsors: describeSponsors(bill?.sponsors),
    filedOn: filed?.date?.slice(0, 10),
    companion: selectCompanion(bill?.sasts),
    lastVote: selectLastVote(bill?.votes),
    latestText: selectLatestText(bill?.texts),
    analysis: selectLatestAnalysis(bill?.supplements),
  }
}

/**
 * The citation and the rest of the record, fetched only for bills that survived the gate.
 *
 * `state_link` is the legislature's own page and is what the tab cites; it is also on the
 * legislative allowlist, which LegiScan's own domain is not. A bill without one is dropped rather
 * than cited to LegiScan, because the point of this section is to point at the record itself.
 */
async function attachDetail(
  apiKey: string,
  candidate: FloridaCandidate,
  timeoutMs: number
): Promise<SourcedFloridaBill | null> {
  const data = (await getJson(
    `https://api.legiscan.com/?key=${encodeURIComponent(apiKey)}&op=getBill&id=${candidate.billId}`,
    timeoutMs
  )) as { bill?: BillDetail } | null
  return toSourcedFloridaBill(candidate, data?.bill)
}

export function selectRelevantFloridaBills(
  candidates: FloridaCandidate[],
  isRelevant: (item: { title?: string; summary?: string }) => boolean,
  limit = 5
): FloridaCandidate[] {
  return candidates
    .filter((c) => isRelevant({ title: c.title, summary: c.description }))
    .sort((a, b) => b.statusDate.localeCompare(a.statusDate))
    .slice(0, limit)
}

/**
 * Relevant Florida bills with a citation, or an empty list.
 *
 * Returns nothing rather than throwing when the key is absent, so a deployment without it shows an
 * empty Florida side and a note, not an error. Over a 400-day window this reduces 1,930 bills with
 * an action to roughly half a dozen.
 */
export async function fetchFloridaBills(
  apiKey: string | undefined,
  now: Date,
  windowDays: number,
  isRelevant: (item: { title?: string; summary?: string }) => boolean,
  limit = 5,
  timeoutMs = 20_000
): Promise<SourcedFloridaBill[]> {
  if (!apiKey?.trim()) return []

  const candidates = await fetchFloridaCandidates(apiKey, now, windowDays, timeoutMs)
  const relevant = selectRelevantFloridaBills(candidates, isRelevant, limit)
  const withUrls = await Promise.all(relevant.map((c) => attachDetail(apiKey, c, timeoutMs)))
  return withUrls.filter((b): b is SourcedFloridaBill => b !== null)
}

// ── Staff analysis ─────────────────────────────────────────────────────────────

/**
 * How much of an analysis the model is given, in words. Florida's run to eight or ten pages and
 * three to five thousand words, so this is rarely reached; it exists for the one that is not.
 */
export const ANALYSIS_WORD_CAP = 5_000

/**
 * The analysis as the model should see it. The House's PDFs repeat a navigation line on every
 * page ("JUMP TO SUMMARY ANALYSIS RELEVANT INFORMATION BILL HISTORY") and open with a storage
 * name; neither is the analysis. Everything else is kept — these documents are already the
 * distilled form, so unlike a Federal Register rule there is no section to prefer.
 */
export function cleanAnalysisText(text: string): string {
  return text
    .replace(/\0/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^JUMP TO\b/i.test(line))
    .filter((line) => !/^STORAGE NAME:/i.test(line))
    .filter((line) => !/^DATE: \d{1,2}\/\d{1,2}\/\d{4}\s*\d*$/i.test(line))
    .join("\n")
}

function truncateWords(s: string, limit: number): string {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length <= limit) return s.trim()
  return words.slice(0, limit).join(" ") + " […]"
}

/**
 * The staff analysis as text, or undefined when there is none or it cannot be read.
 *
 * The analysis is a PDF on flsenate.gov. Turning a PDF into text needs a parser, and this module
 * stays import-free so the test runner can load it, so the parser is passed in: the action
 * supplies one and a test supplies a stub. A failure here leaves the bill on its official
 * description, which is where it was before this existed.
 */
export async function fetchFloridaAnalysisText(
  bill: SourcedFloridaBill,
  pdfToText: (bytes: Uint8Array) => Promise<string>,
  timeoutMs = 20_000,
  cap = ANALYSIS_WORD_CAP
): Promise<string | undefined> {
  if (!bill.analysis) return undefined
  try {
    const res = await fetch(bill.analysis.url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return undefined
    const text = cleanAnalysisText(await pdfToText(new Uint8Array(await res.arrayBuffer())))
    return text.length > 0 ? truncateWords(text, cap) : undefined
  } catch {
    return undefined
  }
}

/**
 * The record's own facts about a bill, as a reader would cite them. Nothing here has been through
 * a model. The shape matches `RecordFact` in the Federal Register module; declared structurally
 * so this file keeps no imports.
 */
export function describeFloridaRecord(bill: SourcedFloridaBill): Array<{ label: string; value: string; url?: string }> {
  const facts: Array<{ label: string; value: string; url?: string }> = []
  if (bill.sponsors.length > 0) facts.push({ label: bill.sponsors.length > 1 ? "Sponsors" : "Sponsor", value: bill.sponsors.join("; ") })
  if (bill.filedOn) facts.push({ label: "Filed", value: bill.filedOn })
  if (bill.companion) facts.push({ label: "Companion", value: bill.companion })
  if (bill.lastVote) {
    facts.push({
      label: "Last vote",
      value: `${bill.lastVote.description}: ${bill.lastVote.yea}–${bill.lastVote.nay}${bill.lastVote.passed ? "" : ", failed"} (${bill.lastVote.date})`,
    })
  }
  if (bill.latestText) facts.push({ label: "Text", value: `${bill.latestText.type} (${bill.latestText.date})`, url: bill.latestText.url })
  if (bill.analysis) facts.push({ label: "Staff analysis", value: `${bill.analysis.description} (${bill.analysis.date})`, url: bill.analysis.url })
  return facts
}

// ── Dead bills ─────────────────────────────────────────────────────────────────

/**
 * Florida's clerks record a bill that was still in committee when the session ended as "Died in
 * <committee>"; a bill the sponsor pulled is "Withdrawn from consideration". Neither has any
 * effect, and neither can move again — it would have to be refiled as a new bill.
 */
export function isDeadStatus(status: string | undefined): boolean {
  return /^died\b|withdrawn from consideration|^failed\b|^vetoed\b/i.test(status?.trim() ?? "")
}

/**
 * A line for the section when every Florida bill on it is dead, which is the state of the
 * Legislative Tracker for roughly half of every year. Florida's regular session runs sixty days
 * in the spring; filing for the next one opens in the autumn. Without this the section reads as
 * five live bills, and a reader has to open each one to learn that none of them is.
 */
export function describeFloridaSessionState(
  items: Array<{ status?: string; date: string }>
): string | undefined {
  if (items.length === 0 || !items.every((i) => isDeadStatus(i.status))) return undefined
  const year = Math.max(...items.map((i) => Number(i.date.slice(0, 4)) || 0))
  if (!year) return undefined
  return `The Florida Legislature's ${year} session has ended, and every Florida bill below lapsed with it; none has any effect. Filing for the ${year + 1} session usually opens in the autumn, and new bills appear here as they are filed.`
}

/**
 * What a dead bill's record says about its chances next time, in one sentence a reader can check.
 *
 * Written from the record alone — the last roll call, where it died, when it was filed, its
 * companion — because the honest signal is procedural: a bill that passed a chamber 114–0 and died
 * in the other chamber's Rules committee is a different thing from one that was filed and never
 * heard, and the record states which. Nothing is said about *why* it died; the record does not
 * know and neither do we.
 */
export function describeIntent(bill: SourcedFloridaBill): string | undefined {
  if (!isDeadStatus(bill.statusLabel)) return undefined
  const where = bill.statusLabel.trim().replace(/^Died/, "died").replace(/^Withdrawn/, "withdrawn")
  const chamber = bill.chamber === "senate" ? "Senate" : "House"
  const companion = bill.companion ? ` Companion ${bill.companion} in the other chamber.` : ""
  const vote = bill.lastVote

  if (vote && vote.passed && /third reading|floor|^(house|senate):/i.test(vote.description)) {
    return `Passed the ${chamber} ${vote.yea}–${vote.nay} on ${vote.date}, then ${where}. A bill that clears one chamber is commonly refiled.${companion}`
  }
  if (vote && vote.passed) {
    return `Cleared ${vote.description} ${vote.yea}–${vote.nay} on ${vote.date}, then ${where}.${companion}`
  }
  if (vote) {
    return `Failed in ${vote.description} ${vote.yea}–${vote.nay} on ${vote.date}.${companion}`
  }
  const filed = bill.filedOn ? `Filed ${bill.filedOn}; ` : ""
  return `${filed}${where} without a hearing or a vote.${companion}`
}

/** What the item says before a model has seen it. Everything here is the bill's own. */
export function describeFloridaFromRecord(bill: SourcedFloridaBill): string {
  if (bill.description) return bill.description
  return `${bill.displayNumber}, ${bill.title} (${bill.sessionName}). Status as of ${bill.statusDate}: ${bill.statusLabel}.`
}

/**
 * Asks only for prose, and supplies the facts. Keyed by bill number on the way back.
 *
 * Where a bill's staff analysis was fetched, that is what the model is given to condense, and it
 * is asked for the specifics a one-line description leaves out. Where only the description is
 * available the ask is narrower, and the details list is to be left empty rather than filled.
 */
export function buildFloridaSummaryPrompt(bills: SourcedFloridaBill[], texts: Map<string, string> = new Map()): string {
  const list = bills
    .map((b) => {
      const head = `- ${b.displayNumber} [${b.sessionName}, status: ${b.statusLabel}, as of ${b.statusDate}]: ${b.title}\n  Official description: ${b.description || "(none published)"}`
      const text = texts.get(b.displayNumber)
      return text ? `${head}\n  Legislative staff analysis:\n"""\n${text}\n"""` : head
    })
    .join("\n\n")

  return `These are real Florida bills, taken from the legislative record. Their numbers, titles, statuses and dates are already confirmed — do not restate, correct or change them, and do not add bills.

${list}

For each one, write three things for a firm that buys and works out distressed commercial real estate debt in Florida:
- "summary": 2-3 sentences in plain English on what the bill would actually do. Base this on the official description and, where given, the staff analysis; do not introduce facts they do not contain.
- "details": where a staff analysis is given, 3 to 5 bullet points, each one sentence of at most 30 words, stating the specific things the analysis says: what the bill changes in current law, who it applies to, any amounts, thresholds or dates, the fiscal impact the analysis reports, and how committees voted. Use the analysis's own terms. Where no analysis is given, return an empty list; never fill it from memory. Where the analysis is marked as cut short ("[…]"), say nothing about what it does not cover.
- "whyItMatters": 1-2 sentences on the consequence for note purchases, workouts, foreclosures or REO. If the honest answer is that the effect is indirect or minimal, say that instead of inflating it.

A bill that died in committee still matters if it signals where the legislature is heading, but say plainly that it did not pass.

Return ONLY valid JSON, keyed by bill number exactly as written above:
{
  "summaries": {
    "${bills[0]?.displayNumber ?? "SB 300"}": { "summary": "...", "details": ["...", "..."], "whyItMatters": "..." }
  }
}`
}
