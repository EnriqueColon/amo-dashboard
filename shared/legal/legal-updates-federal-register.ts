/**
 * Rules and proposed rules for the Regulatory section, taken from the Federal Register.
 *
 * Same correction as `legal-updates-legislation.ts`, applied to the other section that has a
 * published record. A final rule is not something to ask a model about: it has a document number,
 * a citation, an issuing agency and a publication date, and the Federal Register gives all of them
 * away over an open API with no key. Asking instead is how the feed came to contain a "2026 update"
 * linked to a statute enacted in 2020.
 *
 * This does not replace the regulatory prompt, and is not meant to. The Federal Register carries
 * rulemaking only — the FDIC's Financial Institution Letters, OCC bulletins and supervisory
 * guidance never appear in it, and those are a large part of what this section is for. So the
 * record supplies what it has and the model still goes looking for the rest.
 *
 * Unlike govtrack, the Federal Register publishes the agency's own abstract. That is authoritative
 * text rather than an argument, so the relevance gate is allowed to read it as the item's summary.
 *
 * The record also carries the full text of every document, and the module fetches the parts of
 * it that explain the rule — see `selectRuleText`. That text is handed to the model as the thing
 * to summarise, in place of a 70-word abstract. It is still the agency's own words; the model is
 * asked to condense, not to know.
 */

export type SourcedRule = {
  /** The Federal Register's own identifier, e.g. "2026-10036". Unique per document. */
  documentNumber: string
  title: string
  /** "Rule" or "Proposed Rule", as the Federal Register types it. */
  type: string
  /** Every issuing agency. A joint rule lists all of them, and the tab names them all. */
  agencies: string[]
  publicationDate: string
  url: string
  /** The agency's abstract. Absent on some notices, which is why nothing depends on it. */
  abstract?: string
  effectiveOn?: string
  /** Set on proposed rules. The date that actually matters to a reader who wants to respond. */
  commentsCloseOn?: string
  /** The agency's own one-line statement of what the document is: "Final rule.", "Notice of proposed rulemaking." */
  action?: string
  /** Federal Register citation, e.g. "91 FR 29340". */
  citation?: string
  /** The CFR parts the document amends, as "12 CFR Part 34". */
  cfrReferences: string[]
  /** Agency docket identifiers, with the "Docket ID" / "Docket No." prefix removed. */
  docketIds: string[]
  /** Regulation Identifier Numbers from the Unified Agenda. */
  rins: string[]
  pageLength?: number
  /** The official govinfo PDF. */
  pdfUrl?: string
  /** The full text as plain text. Fetched separately; see `fetchRuleText`. */
  rawTextUrl?: string
  /**
   * Set when this document is a correction notice for another. The document number of the
   * original, taken from the tail of the `correction_of` URL.
   */
  correctionOf?: string
  /** Set on an original that has since been corrected: when, and where the correction is. */
  correctedOn?: string
  correctionUrl?: string
}

/**
 * Phrase searches over the full text, so they are wide on purpose and the gate below decides.
 * Searching "commercial real estate" returns a Farm Service Agency rule on loan delivery because
 * the phrase appears somewhere in it — which is why relevance is never taken from the search.
 */
const SEARCH_TERMS = [
  "commercial real estate",
  "commercial mortgage",
  "real estate lending",
  "appraisal",
  "foreclosure",
  "receivership",
  "loan modification",
  "concentration",
  "allowance for credit losses",
  "capital requirements",
]

/** Rulemaking only. Notices and presidential documents are a different kind of thing. */
const DOCUMENT_TYPES = ["RULE", "PRORULE"]

/**
 * The regulators of the institutions this firm buys from, works with and is itself subject to.
 * Federal Register agency slugs, as `GET /api/v1/agencies` names them.
 *
 * Restricting by issuer as well as by subject, because subject alone let through a Farm Credit
 * Administration rule on troubled-debt classification: real terms, real rule, and the FCA
 * regulates farm lenders that no one here will ever hold a note from. The relevance gate cannot see
 * that. Who issued the rule is a fact the record states outright, so it is used.
 *
 * Treasury is listed as the department because the OCC's rules are frequently filed under both,
 * and FinCEN is not: its rulemaking is anti-money-laundering, which is real but not this tab.
 */
const AGENCIES = [
  "comptroller-of-the-currency",
  "federal-deposit-insurance-corporation",
  "federal-reserve-system",
  "consumer-financial-protection-bureau",
  "federal-housing-finance-agency",
  "housing-and-urban-development-department",
  "treasury-department",
  "national-credit-union-administration",
]

const FIELDS = [
  "document_number",
  "title",
  "type",
  "publication_date",
  "html_url",
  "agencies",
  "abstract",
  "effective_on",
  "comments_close_on",
  "action",
  "citation",
  "cfr_references",
  "docket_ids",
  "regulation_id_numbers",
  "page_length",
  "pdf_url",
  "raw_text_url",
  "correction_of",
]

type FederalRegisterDocument = {
  document_number?: string
  title?: string
  type?: string
  publication_date?: string
  html_url?: string
  agencies?: Array<{ name?: string }>
  abstract?: string
  effective_on?: string | null
  comments_close_on?: string | null
  action?: string | null
  citation?: string | null
  cfr_references?: Array<{ title?: number | null; part?: string | null; chapter?: string | null }>
  docket_ids?: string[]
  regulation_id_numbers?: string[]
  page_length?: number | null
  pdf_url?: string | null
  raw_text_url?: string | null
  correction_of?: string | null
}

const DOCKET_PREFIX = /^docket\s+(id|no\.?|number)\s*:?\s*/i

/** "12 CFR Part 34" from the record's `{ title: 12, part: "34" }`; a chapter-level reference names the chapter. */
export function describeCfrReference(ref: {
  title?: number | null
  part?: string | null
  chapter?: string | null
}): string | null {
  if (!ref.title) return null
  if (ref.part) return `${ref.title} CFR Part ${ref.part}`
  if (ref.chapter) return `${ref.title} CFR Chapter ${ref.chapter}`
  return null
}

export function toSourcedRule(raw: FederalRegisterDocument): SourcedRule | null {
  const documentNumber = raw.document_number?.trim()
  const title = raw.title?.trim()
  const publicationDate = raw.publication_date?.slice(0, 10)
  const url = raw.html_url?.trim()
  if (!documentNumber || !title || !publicationDate || !url) return null

  const correctionOf = raw.correction_of?.trim().split("/").pop() || undefined

  return {
    documentNumber,
    title,
    type: raw.type?.trim() || "Rule",
    agencies: (raw.agencies ?? [])
      .map((a) => a.name?.trim())
      .filter((n): n is string => Boolean(n)),
    publicationDate,
    url,
    abstract: raw.abstract?.trim() || undefined,
    effectiveOn: raw.effective_on?.slice(0, 10) || undefined,
    commentsCloseOn: raw.comments_close_on?.slice(0, 10) || undefined,
    action: raw.action?.trim().replace(/\.$/, "") || undefined,
    citation: raw.citation?.trim() || undefined,
    cfrReferences: [
      ...new Set(
        (raw.cfr_references ?? [])
          .map(describeCfrReference)
          .filter((s): s is string => s !== null)
      ),
    ],
    docketIds: (raw.docket_ids ?? [])
      .map((d) => d.trim().replace(DOCKET_PREFIX, ""))
      .filter(Boolean),
    rins: (raw.regulation_id_numbers ?? []).map((r) => r.trim()).filter(Boolean),
    pageLength: typeof raw.page_length === "number" && raw.page_length > 0 ? raw.page_length : undefined,
    pdfUrl: raw.pdf_url?.trim() || undefined,
    rawTextUrl: raw.raw_text_url?.trim() || undefined,
    correctionOf,
  }
}

/** Titles differing only in punctuation or case are the same rule reached by two searches. */
export function normalizeRuleTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Two rounds, because a rule repeats for two different reasons.
 *
 * It surfaces under several of the searches, which is the same document twice. And a rule is
 * genuinely republished — "Real Estate Lending Escrow Accounts" appeared on 2026-05-19 and again
 * on 2026-06-29, two document numbers for one rule. The later publication wins, being the
 * operative one, and whichever copy has an abstract, the survivor gets it.
 *
 * Except when the later one is a correction. `C1-2026-10036` is a one-page notice fixing a
 * typographical error in the escrow rule; it has no abstract, no action line and 197 words of
 * text. Letting it win meant the tab showed a real OCC rule under the correction's date with the
 * correction's text as the thing to summarise. A correction says so in the record
 * (`correction_of`), so the original wins outright and carries a note of when it was corrected.
 */
export function dedupeRules(rules: SourcedRule[]): SourcedRule[] {
  const keep = (map: Map<string, SourcedRule>, key: string, rule: SourcedRule) => {
    const existing = map.get(key)
    if (!existing) {
      map.set(key, rule)
      return
    }
    const corrected = correctedPair(existing, rule)
    if (corrected) {
      map.set(key, corrected)
      return
    }
    const winner = rule.publicationDate > existing.publicationDate ? rule : existing
    const loser = winner === rule ? existing : rule
    map.set(key, winner.abstract ? winner : { ...winner, abstract: loser.abstract })
  }

  const byNumber = new Map<string, SourcedRule>()
  for (const rule of rules) keep(byNumber, rule.documentNumber, rule)

  const byTitle = new Map<string, SourcedRule>()
  for (const rule of byNumber.values()) keep(byTitle, normalizeRuleTitle(rule.title), rule)

  return [...byTitle.values()]
}

/** The original, annotated, when one of the two is a correction of the other; otherwise null. */
function correctedPair(a: SourcedRule, b: SourcedRule): SourcedRule | null {
  const [original, correction] =
    a.correctionOf === b.documentNumber ? [b, a] : b.correctionOf === a.documentNumber ? [a, b] : [null, null]
  if (!original || !correction) return null
  return { ...original, correctedOn: correction.publicationDate, correctionUrl: correction.url }
}

/**
 * Relevance is judged on the title and the agency's abstract, and the test is passed in.
 *
 * Same reasoning as `selectRelevantBills`: this module owns no policy, so the feed's one gate
 * cannot be contradicted by a second copy of it living here.
 */
export function selectRelevantRules(
  rules: SourcedRule[],
  isRelevant: (item: { title?: string; summary?: string }) => boolean,
  limit = 5
): SourcedRule[] {
  return rules
    .filter((r) => isRelevant({ title: r.title, summary: r.abstract }))
    .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate))
    .slice(0, limit)
}

const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" }

function searchUrl(term: string, since: string): string {
  const params = new URLSearchParams({
    per_page: "100",
    order: "newest",
    "conditions[publication_date][gte]": since,
    // Quoted, so this is a phrase search rather than a bag of words.
    "conditions[term]": `"${term}"`,
  })
  for (const type of DOCUMENT_TYPES) params.append("conditions[type][]", type)
  for (const agency of AGENCIES) params.append("conditions[agencies][]", agency)
  for (const field of FIELDS) params.append("fields[]", field)
  return `https://www.federalregister.gov/api/v1/documents.json?${params.toString()}`
}

async function searchRules(term: string, since: string, timeoutMs: number): Promise<SourcedRule[]> {
  try {
    const res = await fetch(searchUrl(term, since), {
      headers: HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return []
    const data = (await res.json()) as { results?: FederalRegisterDocument[] }
    return (data.results ?? []).map(toSourcedRule).filter((r): r is SourcedRule => r !== null)
  } catch {
    return []
  }
}

async function fetchDocument(documentNumber: string, timeoutMs: number): Promise<SourcedRule | null> {
  const params = new URLSearchParams()
  for (const field of FIELDS) params.append("fields[]", field)
  try {
    const res = await fetch(
      `https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(documentNumber)}.json?${params}`,
      { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" }
    )
    if (!res.ok) return null
    return toSourcedRule((await res.json()) as FederalRegisterDocument)
  } catch {
    return null
  }
}

/**
 * A correction whose original fell outside the search window arrives alone. The original is the
 * document a reader wants, so it is fetched by number; if that fails the correction stands,
 * because a thin true item beats none.
 */
async function resolveLoneCorrections(rules: SourcedRule[], timeoutMs: number): Promise<SourcedRule[]> {
  return Promise.all(
    rules.map(async (rule) => {
      if (!rule.correctionOf) return rule
      const original = await fetchDocument(rule.correctionOf, timeoutMs)
      if (!original) return rule
      return { ...original, correctedOn: rule.publicationDate, correctionUrl: rule.url }
    })
  )
}

/**
 * One term failing is not the section failing — these are independent searches over the same
 * record, so a timeout on one costs some recall and nothing else.
 */
export async function fetchFederalRules(
  now: Date,
  windowDays: number,
  isRelevant: (item: { title?: string; summary?: string }) => boolean,
  limit = 5,
  timeoutMs = 20_000
): Promise<SourcedRule[]> {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)
  const batches = await Promise.all(SEARCH_TERMS.map((t) => searchRules(t, since, timeoutMs)))
  const relevant = selectRelevantRules(dedupeRules(batches.flat()), isRelevant, limit)
  // Resolving after selection, so a correction is only chased when its rule is going to render.
  // Dedupe again: a fetched original may be the same rule as another survivor.
  return dedupeRules(await resolveLoneCorrections(relevant, timeoutMs))
}

// ── Full text ──────────────────────────────────────────────────────────────────

/**
 * How much of a document the model is given to summarise, in words. A rule's explanatory text
 * runs from a few thousand words to over a hundred thousand; the parts that say what it does are
 * near the front of whichever sections `selectRuleText` picks, so a cap loses boilerplate before
 * it loses substance. Five rules at this size is a few cents a day.
 */
export const RULE_TEXT_WORD_CAP = 6_000

/**
 * Section headings that explain what the rule does, in the order a reader wants them. Agencies
 * are not uniform — the OCC writes "Description of the Final Rule", the FDIC "Overview of the
 * Proposed Rule" then "Section-by-Section Description", the Fed "Changes to …" — so this is a
 * family of phrasings rather than one.
 */
const EXPLANATORY_HEADING =
  /(description|overview|summary|discussion|explanation) of (the )?(final |proposed |interim )?(rule|proposal|regulation|amendments|provisions)|^(the )?(final|proposed|interim final) rule$|section-by-section|detailed description|(changes|revisions|amendments) to\b/i

/**
 * Sections that are procedure rather than substance: the Administrative Procedure Act, Paperwork
 * Reduction Act and Regulatory Flexibility Act analyses that every rule carries, and the requests
 * for comment. Real text, and the last thing a reader of this tab needs condensed.
 */
const PROCEDURAL_HEADING =
  /administrative (law|procedure)|regulatory (analys|matters|planning|flexibility)|paperwork reduction|economic analysis|impact analysis|request for comment|unfunded mandates|congressional review|alternatives considered|good cause|federalism|small business|plain language|riegle|solicitation of comments|effective date$|severability/i

/** Background sections come after the explanatory ones, when there is room. */
const CONTEXT_HEADING = /introduction|background|policy objectives|overview$|authority/i

const ROMAN = /^\s*([IVX]{1,6})\.\s+(\S.*)$/

function romanValue(numeral: string): number {
  const values: Record<string, number> = { I: 1, V: 5, X: 10 }
  let total = 0
  for (let i = 0; i < numeral.length; i++) {
    const v = values[numeral[i]]
    const next = values[numeral[i + 1]] ?? 0
    total += v < next ? -v : v
  }
  return total
}

export type RuleTextSection = { heading: string; body: string }

/** Page markers, footnote markup and the typesetter's hyphenation, none of which are the rule. */
export function cleanRuleText(raw: string): string {
  return raw
    .replace(/\0/g, "")
    .replace(/\[\[Page \d+\]\]/g, "")
    .replace(/<\/?SUP>/gi, "")
    .replace(/<\/?E[^>]*>/g, "")
    .replace(/\r/g, "")
}

/**
 * The top-level sections of a document's explanatory text.
 *
 * The Federal Register's plain text puts each heading on its own line, numbered in Roman numerals,
 * and usually precedes the body with a table of contents listing the same headings. Two things
 * make a naive split wrong. The contents list repeats every heading, so the body is taken to begin
 * at the first heading whose text has already been seen — "I. Introduction" the second time — and
 * everything before it is the list. (Measuring the gap between headings does not work: the list
 * carries its lettered sub-entries, which run to paragraphs.) And sub-sections restart the
 * numerals — a "1. BMA transactions" nested three levels down is printed as "I. BMA transactions"
 * — so within the body a heading only counts when its numeral is the next one expected; anything
 * else is part of the section it appears in. A document with no contents list keeps the text
 * before its first heading, since short rules sometimes have no headings at all.
 */
export function splitRuleSections(text: string): RuleTextSection[] {
  const start = text.indexOf("SUPPLEMENTARY INFORMATION")
  const body = start >= 0 ? text.slice(start + "SUPPLEMENTARY INFORMATION".length).replace(/^:\s*/, "") : text
  const lines = body.split("\n")

  const headings: Array<{ line: number; value: number; heading: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROMAN)
    if (m && m[2].length < 160) headings.push({ line: i, value: romanValue(m[1]), heading: m[2].trim() })
  }

  const key = (h: string) => h.toLowerCase().replace(/[^a-z]+/g, " ").trim()
  const seen = new Set<string>()
  let firstBody = 0
  for (let i = 0; i < headings.length; i++) {
    const k = key(headings[i].heading)
    if (seen.has(k)) {
      firstBody = i
      break
    }
    seen.add(k)
  }

  const accepted: typeof headings = []
  let expected = 1
  for (let i = firstBody; i < headings.length; i++) {
    if (headings[i].value !== expected) continue
    accepted.push(headings[i])
    expected++
  }

  const sections: RuleTextSection[] = []
  // With no contents list, whatever precedes the first heading is text; with one, it is the list.
  if (firstBody === 0) {
    const preamble = lines.slice(0, accepted[0]?.line ?? lines.length).join("\n").trim()
    if (preamble) sections.push({ heading: "", body: preamble })
  }

  for (let i = 0; i < accepted.length; i++) {
    const from = accepted[i].line + 1
    const to = accepted[i + 1]?.line ?? lines.length
    const sectionBody = lines.slice(from, to).join("\n").trim()
    if (sectionBody) sections.push({ heading: accepted[i].heading, body: sectionBody })
  }
  return sections
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

function truncateWords(s: string, limit: number): string {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length <= limit) return s.trim()
  return words.slice(0, limit).join(" ") + " […]"
}

/**
 * The parts of a document worth a model's attention, within the word cap.
 *
 * Explanatory sections first, in document order; then context; then whatever else is not
 * procedural. The regulatory text itself — everything from "List of Subjects" on — is the
 * amendments in legal form, and the explanatory sections already say what they do. A document
 * with no recognisable structure is taken from the top.
 */
export function selectRuleText(text: string, cap = RULE_TEXT_WORD_CAP): string {
  const cleaned = cleanRuleText(text)
  const cut = cleaned.search(/^\s*List of Subjects/m)
  const explanatory = cut >= 0 ? cleaned.slice(0, cut) : cleaned
  const sections = splitRuleSections(explanatory)
  if (sections.length === 0) return truncateWords(explanatory, cap)

  const rank = (s: RuleTextSection) =>
    EXPLANATORY_HEADING.test(s.heading) ? 0 : PROCEDURAL_HEADING.test(s.heading) ? 3 : CONTEXT_HEADING.test(s.heading) ? 1 : 2
  const ordered = sections
    .map((s, i) => ({ s, i, rank: rank(s) }))
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)

  const chosen: Array<{ i: number; text: string }> = []
  let remaining = cap
  for (const { s, i } of ordered) {
    if (remaining <= 0) break
    const n = wordCount(s.body)
    const body = n > remaining ? truncateWords(s.body, remaining) : s.body
    chosen.push({ i, text: s.heading ? `${s.heading}\n${body}` : body })
    remaining -= Math.min(n, remaining)
  }
  // Document order is easier to read than rank order once the selection is made.
  return chosen
    .sort((a, b) => a.i - b.i)
    .map((c) => c.text)
    .join("\n\n")
}

/**
 * The document's explanatory text, selected and capped, or undefined when it cannot be had. A
 * missing text degrades the item to the abstract, which is where it was before this existed.
 */
export async function fetchRuleText(rule: SourcedRule, timeoutMs = 20_000): Promise<string | undefined> {
  if (!rule.rawTextUrl) return undefined
  try {
    const res = await fetch(rule.rawTextUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return undefined
    const selected = selectRuleText(await res.text())
    return selected.length > 0 ? selected : undefined
  } catch {
    return undefined
  }
}

// ── Description ────────────────────────────────────────────────────────────────

/** The agencies as a reader would name them, with the parent department dropped when redundant. */
export function describeAgencies(rule: SourcedRule): string {
  if (rule.agencies.length === 0) return "Federal Register"
  // "Treasury Department, Comptroller of the Currency" is one issuer described twice; the specific
  // half is the informative one.
  return rule.agencies[rule.agencies.length - 1]
}

/**
 * What the item says before a model has seen it.
 *
 * Written from the record alone so that a failed or skipped summarisation step degrades to a
 * thinner item rather than no item. Everything here is the document's own.
 */
export function describeRuleFromRecord(rule: SourcedRule): string {
  if (rule.abstract) return rule.abstract
  const deadline = rule.commentsCloseOn
    ? ` Comments close ${rule.commentsCloseOn}.`
    : rule.effectiveOn
      ? ` Effective ${rule.effectiveOn}.`
      : ""
  return `${rule.type} issued by ${describeAgencies(rule)}, published ${rule.publicationDate}.${deadline}`
}

export type RecordFact = { label: string; value: string; url?: string }

/**
 * The record's own facts about a document, as a reader would cite them. Nothing here has been
 * through a model, and nothing here can be wrong in the way prose can.
 */
export function describeRuleRecord(rule: SourcedRule): RecordFact[] {
  const facts: RecordFact[] = []
  if (rule.action) facts.push({ label: "Action", value: rule.action })
  if (rule.citation) facts.push({ label: "Citation", value: rule.citation })
  if (rule.cfrReferences.length > 0) {
    facts.push({ label: "Amends", value: summariseCfrReferences(rule.cfrReferences) })
  }
  if (rule.docketIds.length > 0) facts.push({ label: "Docket", value: rule.docketIds.join(", ") })
  if (rule.rins.length > 0) facts.push({ label: "RIN", value: rule.rins.join(", ") })
  if (rule.pageLength) facts.push({ label: "Length", value: `${rule.pageLength} page${rule.pageLength === 1 ? "" : "s"}` })
  if (rule.correctedOn) facts.push({ label: "Corrected", value: rule.correctedOn, url: rule.correctionUrl })
  if (rule.pdfUrl) facts.push({ label: "Official PDF", value: "govinfo.gov", url: rule.pdfUrl })
  return facts
}

/** "12 CFR Parts 34 and 160" rather than two separate references to the same title. */
export function summariseCfrReferences(refs: string[]): string {
  const byTitle = new Map<string, string[]>()
  for (const ref of refs) {
    const m = ref.match(/^(\d+) CFR (Part|Chapter) (.+)$/)
    if (!m) {
      byTitle.set(ref, [])
      continue
    }
    const key = `${m[1]} CFR ${m[2]}`
    byTitle.set(key, [...(byTitle.get(key) ?? []), m[3]])
  }
  return [...byTitle.entries()]
    .map(([key, parts]) => {
      if (parts.length === 0) return key
      const plural = parts.length > 1 ? key.replace(/Part$/, "Parts").replace(/Chapter$/, "Chapters") : key
      const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]
      return `${plural} ${list}`
    })
    .join("; ")
}

/**
 * Asks only for prose, and supplies the facts.
 *
 * The rules are given rather than searched for, so there is nothing to look up and no reason to
 * reach for the web. Keyed by document number on the way back so a reordered or partial answer
 * still lands on the right rule.
 *
 * Where the document's own explanatory text was fetched, that is what the model is given to
 * condense, and it is asked for the specifics the abstract leaves out: who is covered, what
 * changes, which numbers and dates, what the agency said to the comments it received. Where only
 * the abstract is available the ask is narrower, and a reader is told nothing about the gap.
 */
export function buildRuleSummaryPrompt(rules: SourcedRule[], texts: Map<string, string> = new Map()): string {
  const list = rules
    .map((r) => {
      const text = texts.get(r.documentNumber)
      const head = `- ${r.documentNumber} [${r.type}, ${describeAgencies(r)}, published ${r.publicationDate}]: ${r.title}\n  Agency abstract: ${r.abstract || "(none published)"}`
      return text ? `${head}\n  Explanatory text from the document:\n"""\n${text}\n"""` : head
    })
    .join("\n\n")

  return `These are real documents from the Federal Register. Their numbers, titles, agencies, types and dates are already confirmed — do not restate, correct or change them, and do not add documents.

${list}

For each one, write three things for a firm that buys and works out distressed commercial real estate debt:
- "summary": 2-3 sentences in plain English on what the rule actually changes. Base this on the agency abstract and, where given, the explanatory text; do not introduce facts they do not contain. Where the abstract reads "(none published)" and no text is given, write from the title and type alone and never mention that an abstract is missing — the reader is looking at a rule, not at our data.
- "details": where explanatory text is given, 3 to 5 bullet points, each one sentence of at most 30 words, stating the specific things the text says: who the rule applies to, what it requires or permits, any thresholds, amounts or dates, and what the agency said about the comments it received. Quote the agency's own terms. Where no text is given, return an empty list; never fill it from memory. Where the text is marked as cut short ("[…]"), say nothing about what it does not cover.
- "whyItMatters": 1-2 sentences on the consequence for note purchases, workouts, foreclosures or REO. If the honest answer is that the effect is indirect or minimal, say that instead of inflating it.

Where a rule's effect on commercial real estate is incidental, say so plainly. An item that explains why it is marginal is more useful than one that pretends otherwise.

Return ONLY valid JSON, keyed by document number exactly as written above:
{
  "summaries": {
    "${rules[0]?.documentNumber ?? "2026-10036"}": { "summary": "...", "details": ["...", "..."], "whyItMatters": "..." }
  }
}`
}
