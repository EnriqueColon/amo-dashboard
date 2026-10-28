import { unstable_cache } from "../cache-shim"
import { trackBillStatuses, type TrackedBill } from "./bill-status-tracking"
import { type LegalApplicability, normalizeApplicability } from "@shared/legal/legal-applicability"
import { billKeyFor, keepVerifiedBills } from "@shared/legal/legal-updates-bills"
import type { BillMovement } from "@shared/legal/legal-updates-movement"
import { dedupeByTitle, dropStaleItems } from "@shared/legal/legal-updates-filter"
import {
  buildRuleSummaryPrompt,
  describeAgencies,
  describeRuleFromRecord,
  describeRuleRecord,
  fetchFederalRules,
  fetchRuleText,
  type RecordFact,
} from "@shared/legal/legal-updates-federal-register"
import {
  buildFloridaSummaryPrompt,
  describeFloridaFromRecord,
  describeFloridaRecord,
  describeFloridaSessionState,
  describeIntent,
  fetchFloridaAnalysisText,
  fetchFloridaBills,
} from "@shared/legal/legal-updates-florida"
import {
  buildFederalBillSummaryPrompt,
  describeBillRecord,
  describeSourcesRead,
  fetchBillRecord,
  fetchBillSources,
  hasSources,
  type BillSources,
} from "@shared/legal/legal-updates-govinfo"
import {
  currentCongress,
  describeFromRecord,
  fetchFederalBills,
} from "@shared/legal/legal-updates-legislation"
import { buildSectionPrompt } from "@shared/legal/legal-updates-prompts"
import { buildDigestDetailPrompt, fetchPageText, type DigestPage } from "@shared/legal/legal-updates-pages"
import { pdfToText } from "./legal-pdf"
import {
  bearsOnFirmOperations,
  isEnforcementDigest,
  partitionByRelevance,
} from "@shared/legal/legal-updates-relevance"
import {
  LEGAL_SECTIONS,
  SECTION_LABELS,
  type LegalSection,
  windowFor,
} from "@shared/legal/legal-updates-sections"
import { keepVerifiableItems } from "@shared/legal/legal-updates-sources"
import { newsCalendarDayET } from "@shared/news/news-tab-cache"
import { callOpenAiJson, getOpenAiApiKey } from "../openai"

export type LegalItem = {
  id: string
  section: LegalSection
  title: string
  source: string
  date: string
  jurisdiction: "Federal" | "Florida" | "Multi-State"
  summary: string
  whyItMatters: string
  status?: string
  url?: string
  /**
   * Specific points drawn from the document's own text — who it covers, what it requires, which
   * numbers and dates. Present only where the full text was fetched and the model was given it;
   * never written from the abstract alone, and never from memory.
   */
  details?: string[]
  /**
   * The record's own facts about the document — citation, CFR parts amended, docket, length —
   * exactly as the source states them. Nothing here has been through a model.
   */
  record?: RecordFact[]
  /**
   * The label over `details`, naming what was read: "From the rule text", "From the staff
   * analysis", "From the CRS summary and the bill text". Set by whichever collector read the text.
   */
  detailsSource?: string
  /**
   * For a bill that died: what its record says about its chances next session, in one sentence.
   * Procedural and checkable — the last roll call, where it died — never a guess at why.
   */
  intent?: string
  /**
   * What the document says about its own scope, if anything. Resolved against FDIC data by
   * `resolveLegalApplicability` at render time rather than here — see that action for why the
   * join is deliberately outside this cache.
   */
  applicability?: LegalApplicability
  /**
   * How the bill's status changed since this tool last looked. Legislative items only, and only
   * where a database is configured — absent on the dev preview, which has none.
   */
  movement?: BillMovement
}

export type LegalUpdatesResponse = {
  items: LegalItem[]
  generatedAt: string
  /** Feed-wide problems: a missing key, a dead API. Rendered at the top of the tab. */
  notes: string[]
  /**
   * Why a section has nothing in it, keyed by section. Held apart from `notes` so the tab can say
   * it in place — a section with no items is not rendered, so a note at the top was the only sign
   * anything had happened, and it read like an error rather than an answer.
   */
  sectionNotes: Partial<Record<LegalSection, string>>
  /**
   * A line shown above a section's items when the items need framing — the Legislative Tracker
   * between Florida sessions, when every bill on it is dead. Distinct from `sectionNotes`, which
   * explain an empty section.
   */
  sectionContext?: Partial<Record<LegalSection, string>>
}

// ── OpenAI fetch ───────────────────────────────────────────────────────────────

async function querySection(section: LegalSection, now: Date): Promise<LegalItem[]> {
  try {
    const parsed = await callOpenAiJson({
      system:
        "Return ONLY valid JSON. Use your web search tool. Do not fabricate items — only include real, verifiable developments.",
      user: buildSectionPrompt(section, now),
      tier: "fast",
      temperature: 0.1,
      maxTokens: 1800,
      webSearch: true,
    })
    if (!parsed) return []

    const rawItems = Array.isArray(parsed?.items) ? parsed.items : []

    return rawItems
      .filter(
        (item: Record<string, unknown>) =>
          item && typeof item.title === "string" && item.title.trim()
      )
      .map((item: Record<string, unknown>, idx: number) => ({
        id: `${section}-${idx}-${String(item.title).slice(0, 20).replace(/\s+/g, "-").toLowerCase()}`,
        section,
        title: String(item.title).trim(),
        source: typeof item.source === "string" ? item.source.trim() : "",
        date: typeof item.date === "string" ? item.date.trim() : "",
        jurisdiction: (["Federal", "Florida", "Multi-State"].includes(
          String(item.jurisdiction)
        )
          ? item.jurisdiction
          : "Federal") as LegalItem["jurisdiction"],
        summary: typeof item.summary === "string" ? item.summary.trim() : "",
        whyItMatters:
          typeof item.whyItMatters === "string"
            ? item.whyItMatters.trim()
            : "",
        status: typeof item.status === "string" ? item.status.trim() : undefined,
        url: typeof item.url === "string" ? item.url.trim() : undefined,
        applicability: normalizeApplicability(item.applicability) ?? undefined,
      }))
  } catch {
    return []
  }
}

/**
 * Federal legislation, built from the record and then given prose by the model.
 *
 * The identity of every item here — number, title, status, date, link — comes from govtrack and is
 * never round-tripped through the model. The rest of the record — sponsor, cosponsors, committees,
 * how it passed, the report, the text, the CRS summary — comes from GPO's bulk data by bill number,
 * and the model is given the CRS summary, the report's explanatory sections and the text to
 * condense into `details`. A bill whose record could not be fetched renders on govtrack's facts
 * alone, and one for which nothing was read carries no details list: that list means something
 * was read. If the summary call fails, the item still renders on `describeFromRecord`, because a
 * real bill with a thin description is worth more than nothing and far more than an invented one.
 */
async function collectFederalBills(now: Date, filterDays: number): Promise<LegalItem[]> {
  const bills = await fetchFederalBills(now, filterDays, (title) =>
    bearsOnFirmOperations({ title })
  )
  if (bills.length === 0) return []

  const congress = currentCongress(now)
  const records = new Map<string, RecordFact[]>()
  const sources = new Map<string, BillSources>()
  await Promise.all(
    bills.map(async (bill) => {
      const record = await fetchBillRecord(bill.displayNumber, congress)
      if (!record) return
      const facts = describeBillRecord(record)
      if (facts.length > 0) records.set(bill.displayNumber, facts)
      const read = await fetchBillSources(record)
      if (hasSources(read)) sources.set(bill.displayNumber, read)
    })
  )

  const prose = await summariseRecords(
    buildFederalBillSummaryPrompt(bills, sources),
    bills.map((b) => b.displayNumber),
    3200
  )

  return bills.map((bill, idx) => {
    const written = prose.get(bill.displayNumber)
    const read = sources.get(bill.displayNumber)
    return {
      id: `legislative-${idx}-${bill.displayNumber.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      section: "legislative" as const,
      title: `${bill.displayNumber} – ${bill.title}`,
      source: `${bill.displayNumber} — ${bill.displayNumber.startsWith("S") ? "U.S. Senate" : "U.S. House"}`,
      date: bill.statusDate,
      jurisdiction: "Federal" as const,
      summary: written?.summary || describeFromRecord(bill),
      whyItMatters: written?.whyItMatters || "",
      details: read ? written?.details : undefined,
      detailsSource: read ? describeSourcesRead(read) : undefined,
      record: records.get(bill.displayNumber),
      status: bill.statusLabel,
      url: bill.url,
    }
  })
}

/**
 * Prose for items whose facts are already settled.
 *
 * One function for all three records, because the shape of the exchange is identical: a prompt
 * carrying the facts, and an answer keyed by the record's own identifier. `keys` is passed rather
 * than derived so a model that invents a key, reorders the list or answers for only some of it
 * still lands each summary on the right item — and anything it added is ignored.
 */
type RecordProse = { summary: string; whyItMatters: string; details?: string[] }

async function summariseRecords(
  prompt: string,
  keys: string[],
  maxTokens = 1600
): Promise<Map<string, RecordProse>> {
  const out = new Map<string, RecordProse>()
  try {
    const parsed = await callOpenAiJson({
      system: "Return ONLY valid JSON. Do not add, rename or renumber the items you are given.",
      user: prompt,
      tier: "fast",
      temperature: 0.1,
      maxTokens,
      // No search: the facts are supplied, and the only task left is explanation.
      webSearch: false,
    })
    // The prompt asks for `{ "summaries": { ... } }`. The model drops the wrapper about half the
    // time and returns the keys at the top level, which is a compliant answer to the question and
    // used to be read as no answer at all — every Florida bill then rendered as its raw official
    // description with no "why it matters", and nothing logged the reason.
    const summaries =
      parsed?.summaries && typeof parsed.summaries === "object" ? parsed.summaries : parsed
    if (!summaries || typeof summaries !== "object") return out

    for (const key of keys) {
      const entry = (summaries as Record<string, unknown>)[key]
      if (!entry || typeof entry !== "object") continue
      const { summary, whyItMatters, details } = entry as Record<string, unknown>
      const points = Array.isArray(details)
        ? details
            .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
            .map((d) => d.trim())
            .slice(0, 6)
        : []
      out.set(key, {
        summary: typeof summary === "string" ? summary.trim() : "",
        whyItMatters: typeof whyItMatters === "string" ? whyItMatters.trim() : "",
        details: points.length > 0 ? points : undefined,
      })
    }
  } catch {
    /* every caller falls back to its own describe-from-record */
  }
  return out
}

/**
 * Florida legislation, built from the record the same way as the federal side.
 *
 * Reached through LegiScan, whose key has been in the environment unused since the project was set
 * up. Absent the key this returns nothing and the feed says so in a note, rather than falling back
 * to asking a model — which is what produced `CS/HB 1353` and `HB 793`, neither of which exists.
 */
async function collectFloridaBills(now: Date, filterDays: number): Promise<LegalItem[]> {
  const bills = await fetchFloridaBills(
    process.env.LEGISCAN_API_KEY,
    now,
    filterDays,
    bearsOnFirmOperations
  )
  if (bills.length === 0) return []

  // The legislature's own staff analysis, where one was published, so the model condenses what
  // nonpartisan staff wrote about the bill rather than a one-line description of it.
  const texts = new Map<string, string>()
  await Promise.all(
    bills.map(async (bill) => {
      const text = await fetchFloridaAnalysisText(bill, pdfToText)
      if (text) texts.set(bill.displayNumber, text)
    })
  )

  const prose = await summariseRecords(
    buildFloridaSummaryPrompt(bills, texts),
    bills.map((b) => b.displayNumber),
    3200
  )

  return bills.map((bill, idx) => {
    const written = prose.get(bill.displayNumber)
    const record = describeFloridaRecord(bill)
    return {
      id: `legislative-fl-${idx}-${bill.displayNumber.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      section: "legislative" as const,
      title: `${bill.displayNumber} – ${bill.title}`,
      source: `${bill.displayNumber} — Florida ${bill.chamber === "senate" ? "Senate" : "House"}`,
      date: bill.statusDate,
      jurisdiction: "Florida" as const,
      summary: written?.summary || describeFloridaFromRecord(bill),
      whyItMatters: written?.whyItMatters || "",
      details: texts.has(bill.displayNumber) ? written?.details : undefined,
      detailsSource: texts.has(bill.displayNumber) ? "From the staff analysis" : undefined,
      record: record.length > 0 ? record : undefined,
      intent: describeIntent(bill),
      status: bill.statusLabel,
      url: bill.url,
    }
  })
}

/**
 * Reads the roundup pages the Enforcement section cites, and replaces what the model recalled
 * about each with what the page says.
 *
 * Only for items that are a regulator's monthly roundup, and only after source verification has
 * confirmed the page exists. The model found the page; it did not read it, and a summary written
 * from recall of a page that lists orders by name is the one place in this feed where a wrong
 * institution could be named. A page that cannot be read leaves its item as it was.
 */
async function readEnforcementPages(items: LegalItem[]): Promise<LegalItem[]> {
  const digests = items.filter((item) => item.url && isEnforcementDigest(item))
  if (digests.length === 0) return items

  const pages: DigestPage[] = []
  await Promise.all(
    digests.map(async (item) => {
      const text = await fetchPageText(item.url as string)
      if (text) pages.push({ key: item.id, title: item.title, date: item.date, text })
    })
  )
  if (pages.length === 0) return items

  const prose = await summariseRecords(buildDigestDetailPrompt(pages), pages.map((p) => p.key), 2400)
  if (prose.size === 0) return items

  return items.map((item) => {
    const written = prose.get(item.id)
    if (!written || !written.summary) return item
    return {
      ...item,
      summary: written.summary,
      whyItMatters: written.whyItMatters || item.whyItMatters,
      details: written.details,
      detailsSource: "From the page",
    }
  })
}

/**
 * Rulemaking from the Federal Register, built from the record and then given prose by the model.
 *
 * A supplement rather than a replacement for the regulatory prompt: the Federal Register carries
 * rulemaking only, and the FDIC's Financial Institution Letters, OCC bulletins and supervisory
 * guidance — a large part of what this section is for — never appear in it.
 */
async function collectFederalRules(now: Date, filterDays: number): Promise<LegalItem[]> {
  const rules = await fetchFederalRules(now, filterDays, bearsOnFirmOperations)
  if (rules.length === 0) return []

  // The document's own explanatory text, so the model condenses the rule rather than the
  // abstract of the rule. A fetch that fails leaves that rule on its abstract, as before.
  const texts = new Map<string, string>()
  await Promise.all(
    rules.map(async (rule) => {
      const text = await fetchRuleText(rule)
      if (text) texts.set(rule.documentNumber, text)
    })
  )

  const prose = await summariseRecords(
    buildRuleSummaryPrompt(rules, texts),
    rules.map((r) => r.documentNumber),
    // Five rules, each with a summary, up to five points and a consequence.
    3200
  )

  return rules.map((rule, idx) => {
    const written = prose.get(rule.documentNumber)
    const record = describeRuleRecord(rule)
    return {
      id: `regulatory-fr-${idx}-${rule.documentNumber}`,
      section: "regulatory" as const,
      title: rule.title,
      source: `${describeAgencies(rule)} — ${rule.type}`,
      date: rule.publicationDate,
      jurisdiction: "Federal" as const,
      summary: written?.summary || describeRuleFromRecord(rule),
      whyItMatters: written?.whyItMatters || "",
      // Only where the model was actually given the text; a list written from an abstract would
      // be the abstract restated as bullets, or worse, filled in.
      details: texts.has(rule.documentNumber) ? written?.details : undefined,
      detailsSource: texts.has(rule.documentNumber) ? "From the rule text" : undefined,
      record: record.length > 0 ? record : undefined,
      status: rule.commentsCloseOn
        ? `Comments close ${rule.commentsCloseOn}`
        : rule.effectiveOn
          ? `Effective ${rule.effectiveOn}`
          : rule.type,
      url: rule.url,
    }
  })
}

/**
 * A section's worth of items that survived source verification.
 *
 * Retried once when nothing survives, because the model's failure here is erratic rather than
 * steady: it will construct a plausible Federal Reserve press-release URL from the date format on
 * one attempt and cite the real page on the next. Verification always protects the reader, so the
 * only thing at stake is whether the section has anything in it, and one more call is cheap
 * against a feed that regenerates daily.
 */
type SectionResult = {
  section: LegalSection
  kept: LegalItem[]
  /** Counts behind an empty section, so it can explain itself rather than simply vanishing. */
  discarded: { stale: number; unverified: number; offTopic: number; misattributed: number }
}

/** The record-sourced half of a section, fetched in parallel where there is more than one source. */
async function collectFromRecord(
  section: LegalSection,
  now: Date,
  filterDays: number
): Promise<LegalItem[]> {
  if (section === "legislative") {
    const [federal, florida] = await Promise.all([
      collectFederalBills(now, filterDays),
      collectFloridaBills(now, filterDays),
    ])
    return [...federal, ...florida]
  }
  if (section === "regulatory") return collectFederalRules(now, filterDays)
  // Enforcement has no equivalent: consent orders and prohibition notices are published as news
  // releases, not into a queryable record.
  return []
}

async function collectSection(section: LegalSection, now: Date): Promise<SectionResult> {
  const discarded = { stale: 0, unverified: 0, offTopic: 0, misattributed: 0 }
  const { filterDays } = windowFor(section)

  // Whatever this section has a published record for, fetched once and not retried against the
  // model. Legislation has one for both jurisdictions now; regulatory has one for rulemaking only.
  const sourced = await collectFromRecord(section, now, filterDays)

  for (let attempt = 0; attempt < 2; attempt++) {
    // For legislation the model is a fallback rather than a supplement. Both jurisdictions come
    // from a record, so asking as well would put the same bill on the page twice under two
    // spellings of one title — `dedupeByTitle` matches "SB 300 – Alternative Judicial Sales
    // Procedures" against "SB 300: Alternative Judicial Sales" not at all.
    const askModel = section !== "legislative" || sourced.length === 0
    const raw = [...sourced, ...(askModel ? await querySection(section, now) : [])]
    if (raw.length === 0) continue

    // Cheapest checks first: date and topic are local, source verification costs a fetch each.
    const dated = dropStaleItems(raw, now.getTime(), filterDays)
    const topical = partitionByRelevance(dated.kept)
    const verified = await keepVerifiableItems(topical.relevant)

    discarded.stale += dated.dropped.length
    discarded.offTopic += topical.irrelevant.length
    discarded.unverified += verified.rejected.length

    // Legislation gets a second, stronger check. A loading URL says nothing here: congress.gov
    // returns 403 to us and Florida's sites serve soft 404s, so the section had been accepting
    // real bill numbers carrying invented titles. See `lib/legal-updates-bills.ts`.
    let kept = verified.kept
    if (section === "legislative") {
      const bills = await keepVerifiedBills(kept, now)
      discarded.misattributed += bills.rejected.length
      kept = bills.kept
    }

    if (kept.length > 0) {
      // Enforcement has no record to draw from, but the roundup pages it cites can be read.
      if (section === "enforcement") kept = await readEnforcementPages(kept)
      return { section, kept, discarded }
    }
  }

  return { section, kept: [], discarded }
}

/**
 * Records each rendered bill's status and hangs any transition on the item.
 *
 * Runs on the deduped set rather than per section, so the status recorded is the one the tab
 * actually shows. Doing it earlier would record bills that a later gate then discarded, and the
 * next run would report a move from a status no reader ever saw.
 */
async function attachMovement(items: LegalItem[]): Promise<LegalItem[]> {
  const keys = new Map<LegalItem, string>()
  const tracked: TrackedBill[] = []

  for (const item of items) {
    if (item.section !== "legislative" || !item.status || !item.date) continue
    const key = billKeyFor(item)
    if (!key) continue
    keys.set(item, key)
    tracked.push({ key, title: item.title, status: item.status, statusDate: item.date })
  }

  const movements = await trackBillStatuses(tracked)
  if (movements.size === 0) return items

  return items.map((item) => {
    const movement = movements.get(keys.get(item) ?? "")
    return movement ? { ...item, movement } : item
  })
}

/** Reads as an answer rather than an error, because most of the time it is one. */
function describeEmptySection(result: SectionResult): string | undefined {
  const { stale, unverified, offTopic, misattributed } = result.discarded
  const { filterDays } = windowFor(result.section)

  if (stale + unverified + offTopic + misattributed === 0) {
    return `No qualifying developments in the last ${filterDays} days.`
  }

  const reasons: string[] = []
  if (stale) reasons.push(`${stale} older than ${filterDays} days`)
  if (offTopic) reasons.push(`${offTopic} without a clear bearing on the firm's operations`)
  if (unverified) reasons.push(`${unverified} without a verifiable primary source`)
  if (misattributed) reasons.push(`${misattributed} citing a bill number that is a different bill`)

  return `Nothing to report. Candidates were set aside: ${reasons.join("; ")}.`
}

// ── Main export ────────────────────────────────────────────────────────────────

async function fetchLegalUpdatesImpl(): Promise<LegalUpdatesResponse> {
  const notes: string[] = []

  if (!getOpenAiApiKey()) {
    return {
      items: [],
      generatedAt: new Date().toISOString(),
      notes: ["Missing OPENAI_API_KEY — legal intelligence feed unavailable."],
      sectionNotes: {},
    }
  }

  // Said out loud rather than degrading quietly: without the key the Legislative Tracker shows
  // federal bills only, and a half-empty section is indistinguishable from a quiet fortnight.
  if (!process.env.LEGISCAN_API_KEY?.trim()) {
    notes.push("Missing LEGISCAN_API_KEY — Florida bills are omitted from the Legislative Tracker.")
  }

  // One clock for the prompts and the filter, so they cannot disagree about what "recent" means.
  const now = new Date()

  const collected = await Promise.all(LEGAL_SECTIONS.map((s) => collectSection(s, now)))

  // Dedupe last and across sections, so one development cannot occupy two of them.
  const allItems = await attachMovement(dedupeByTitle(collected.flatMap((c) => c.kept)))

  const sectionNotes: Partial<Record<LegalSection, string>> = {}
  for (const result of collected) {
    if (allItems.some((i) => i.section === result.section)) continue
    sectionNotes[result.section] = describeEmptySection(result)
  }

  // Between Florida sessions the Tracker's Florida side is entirely bills that lapsed in March,
  // and without saying so it reads as five live bills.
  const sectionContext: Partial<Record<LegalSection, string>> = {}
  const floridaBills = allItems.filter((i) => i.section === "legislative" && i.jurisdiction === "Florida")
  const sessionState = describeFloridaSessionState(floridaBills)
  if (sessionState) sectionContext.legislative = sessionState

  if (allItems.length === 0 && collected.every((c) => c.discarded.stale + c.discarded.unverified + c.discarded.offTopic === 0)) {
    notes.push("No legal intelligence items returned. Check OpenAI API key and quota.")
  }

  return {
    items: allItems,
    generatedAt: new Date().toISOString(),
    notes,
    sectionNotes,
    sectionContext,
  }
}

export async function fetchLegalUpdates(): Promise<LegalUpdatesResponse> {
  const day = newsCalendarDayET()
  return unstable_cache(
    async () => fetchLegalUpdatesImpl(),
    ["legal-updates-v14", day],
    // 25h so the entry outlives the day and never expires just before the cron.
    { revalidate: 90000 }
  )()
}
