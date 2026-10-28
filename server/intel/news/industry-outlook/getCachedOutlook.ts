import { unstable_cache } from "../../cache-shim"
import { retrieveSources } from "./retrieveSources"
import type { RetrievedSource } from "./schema"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"
import { callOpenAi, getOpenAiApiKey } from "../../openai"
import {
  ensureKeySignalFigures,
  hasDeniedSource,
  hasTrustedAttribution,
  MEMO_HEADINGS,
  SEARCH_ALLOWED_DOMAINS,
  sanitizeMemoEvidence,
} from "../memo-evidence"
import { getVerifiedMetrics } from "./verifiedMetrics"
import { formatVerifiedDataBlock, type VerifiedMetric } from "../verified-metrics"

/** Human-readable current date (ET) so the model can't present a stale quarter as current. */
function todayLongET(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date())
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    task,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ])
}

/**
 * True if the text looks like a real AI-generated memo (has substance).
 *
 * The section headings are load-bearing, not cosmetic: the UI splits the memo
 * on them and renders the Executive Summary as the Key Signals cards. When the
 * model occasionally omits them, every bullet — including the raw source URLs —
 * collapses into Key Signals. A memo without headings must never be cached.
 */
function hasUsableContent(text: string): boolean {
  if (!text || text.trim().length < 200) return false
  const lines = text.split("\n").map((l) => l.trim().toLowerCase())
  const present = MEMO_HEADINGS.filter((h) => lines.includes(h.toLowerCase()))
  return present.includes("Executive Summary") && present.length >= 3
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Sentence boundary: period/!/? followed by space and a capital/digit/$.
// Negative lookbehind avoids splitting after two-letter abbreviations (U.S., D.C.).
const SENTENCE_SPLIT_RE = /(?<![A-Z]\.[A-Z]\.)(?<=[.!?])\s+(?=[A-Z0-9$"(])/

/**
 * Generation is flaky about line breaks: sometimes a whole section arrives as
 * one fused paragraph (especially with web-search citation blocks). Enforce
 * one bullet per key point so the UI never renders a wall of text.
 */
function enforceBulletStructure(text: string): string {
  const out: string[] = []
  let inSources = false

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const isHeading = MEMO_HEADINGS.some((h) => trimmed.toLowerCase() === h.toLowerCase())
    if (isHeading) {
      inSources = /^key sources/i.test(trimmed)
      out.push("", trimmed)
      continue
    }
    if (inSources) {
      out.push(trimmed)
      continue
    }

    // Re-split bullet markers that got glued mid-line ("...defaults. - CMBS...")
    const pieces = trimmed.replace(/([.!?])\s+-\s+(?=[A-Z0-9$"])/g, "$1\n").split("\n")
    for (const piece of pieces) {
      const body = piece.replace(/^(?:[-•*]\s*)+/, "").trim()
      if (!body) continue
      if (body.length <= 300) {
        out.push(`- ${body}`)
        continue
      }
      // Merged blob: one sentence per bullet; tiny fragments join the previous.
      const bullets: string[] = []
      for (const sentence of body.split(SENTENCE_SPLIT_RE)) {
        const s = sentence.trim()
        if (!s) continue
        if (s.length < 60 && bullets.length) bullets[bullets.length - 1] += ` ${s}`
        else bullets.push(s)
      }
      for (const b of bullets) out.push(`- ${b}`)
    }
  }
  return out.join("\n").trim()
}

function cleanMemoText(text: string): string {
  let cleaned = text
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  // Drop any preamble/memo header before the first real section heading,
  // e.g. "I'll search for..." narration or TO:/FROM:/DATE: lines. Not anchored
  // to line start because search narration can fuse onto the same line.
  const firstSection = cleaned.search(/(?:\d+\)\s*)?executive summary/i)
  if (firstSection > 0) {
    cleaned = cleaned.slice(firstSection).trim()
  }

  // Put every known section heading on its own line (handles "5) Key sources"
  // numbering and headings fused onto the end of a paragraph).
  for (const heading of MEMO_HEADINGS) {
    cleaned = cleaned.replace(
      new RegExp(`\\s*(?:\\d+\\)\\s*)?${escapeRegex(heading)}\\s*:?\\s*`, "gi"),
      `\n\n${heading}\n`
    )
  }

  return enforceBulletStructure(cleaned)
}

function normalizeSources(sources: RetrievedSource[]): Array<{ title: string; url: string }> {
  const seen = new Set<string>()
  const output: Array<{ title: string; url: string }> = []
  for (const item of sources) {
    const url = String(item.url || "").trim()
    if (!/^https?:\/\//i.test(url)) continue
    // The fallback memo prints these as a reading list; a denied actor is not one.
    if (hasDeniedSource(`${item.publisher || ""} ${url} ${item.title || ""}`)) continue
    const key = url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ title: String(item.title || url).trim(), url })
    if (output.length >= 12) break
  }
  return output
}

export function buildFallbackMemo(
  sources: RetrievedSource[],
  reason: string,
  metrics: VerifiedMetric[] = []
): string {
  const sourceLines = normalizeSources(sources)
  const renderedSources =
    sourceLines.length > 0
      ? sourceLines.map((s) => `${s.title} — ${s.url}`)
      : ["No verified sources were available in this run."]

  return [
    "Executive Summary",
    // The measured figures do not depend on generation succeeding, so a failed
    // run still shows current market data rather than only an apology.
    ...metrics.map((m) => `- ${m.sentence}`),
    // Wording is load-bearing: the client detects a fallback memo by this
    // phrase and declines to cache it, so the next request retries generation.
    "- We could not complete a full generated outlook in this run; the measured figures above are current.",
    `- Reason: ${reason}.`,
    "",
    "U.S. commercial real estate outlook (CRE debt & distress)",
    "- Data retrieval was partially available; re-run is recommended for a fuller update.",
    "",
    "Miami-specific CRE and distressed-debt outlook",
    "- Miami/Florida signal coverage was limited in this run; re-run is recommended.",
    "",
    "How this shapes distressed-debt investing",
    "- Use the sources below for direct verification and decision support.",
    "",
    "Key sources (for further reading)",
    ...renderedSources,
  ].join("\n")
}

/**
 * Second way an unrecognized source reaches the model: the supplemental feed is
 * Google News RSS, which is not domain-restricted the way web search now is.
 * Its links are news.google.com redirects (resolution is skipped for latency),
 * so the publisher name is the only usable trust signal.
 *
 * Denied actors are excluded outright. The rest are ordered recognized-first so
 * the six prompt slots go to citable publishers, and anything unrecognized that
 * still makes the cut is labelled as background the model may not quote.
 */
function classifySources(sources: RetrievedSource[]): {
  ordered: Array<{ source: RetrievedSource; citable: boolean }>
  deniedCount: number
} {
  const seen = new Set<string>()
  const citable: RetrievedSource[] = []
  const background: RetrievedSource[] = []
  let deniedCount = 0

  for (const s of sources) {
    const url = String(s.url || "").trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url.toLowerCase())) continue
    seen.add(url.toLowerCase())

    if (hasDeniedSource(`${s.publisher || ""} ${url} ${s.title || ""}`)) {
      deniedCount += 1
      continue
    }
    if (hasTrustedAttribution(`${s.publisher || ""} ${url}`)) citable.push(s)
    else background.push(s)
  }

  return {
    ordered: [
      ...citable.map((source) => ({ source, citable: true })),
      ...background.map((source) => ({ source, citable: false })),
    ].slice(0, PROMPT_SOURCE_SLOTS),
    deniedCount,
  }
}

/**
 * Articles quoted into the prompt. Raised from six because the citation rules
 * discard any figure from an unrecognized publisher: a narrow feed leaves the
 * model with too little citable material and it falls back to vague prose.
 */
const PROMPT_SOURCE_SLOTS = 10

function buildPrompt(
  sources: RetrievedSource[],
  metrics: VerifiedMetric[]
): {
  system: string
  user: string
  deniedSourceCount: number
} {
  const { ordered, deniedCount } = classifySources(sources)
  const richContext = ordered
    .map(({ source: s, citable }, i) => {
      const lines = [
        `[Source ${i + 1} — ${(s.region || "national").toUpperCase()} — ${
          citable ? "RECOGNIZED PUBLISHER: figures may be cited" : "BACKGROUND ONLY: do not cite, do not quote any figure from it"
        }]`,
        `Title: ${s.title}`,
        `Publisher: ${s.publisher || "Unknown"} | Date: ${s.date || "Recent"}`,
        `URL: ${s.url}`,
      ]
      const snippet = (s.snippet || "").trim()
      if (snippet) lines.push(`Content: ${snippet.slice(0, 600)}`)
      return lines.join("\n")
    })
    .join("\n\n")

  const system =
    "You are a senior CRE distressed-debt analyst at a private equity firm specializing in distressed commercial real estate debt, NPL acquisitions, and loan workouts. " +
    "Write for the investment committee: plain text only, concise and analytical. " +
    "Use your web search tool to find current market data — CMBS delinquency rates, special servicing volumes, foreclosure filings, note sale pipelines, and deal activity. " +
    "Supplement with the source articles provided below.\n\n" +
    "EVIDENCE RULES — these override every formatting or style instruction that follows:\n" +
    "1. Every figure you state must come from one of exactly three places: the VERIFIED MARKET DATA block, " +
    "a search result you actually read, or a supplied source article you actually read. " +
    "Never invent, estimate, extrapolate, average, or infer a number, and never restate a figure from memory.\n" +
    "2. Immediately after each figure, attribute it in plain parentheses: (Publisher, Month Year). " +
    "Example: CMBS office delinquency reached 11.7% (Trepp, July 2026).\n" +
    "3. The VERIFIED MARKET DATA block is measured, not searched, and is the most reliable evidence you have. " +
    "Quote those figures verbatim with the attribution given, and never alter, re-round or 'update' them.\n" +
    "4. A searched figure is only usable if it comes from a recognized publisher — a data or ratings provider " +
    "(Trepp, S&P Global, Moody's, Fitch, KBRA, CoStar, ATTOM, CoreLogic, CRED iQ), CRE trade press " +
    "(CRE Daily, Bisnow, Commercial Observer, The Real Deal, GlobeSt), a major brokerage, a government " +
    "body, or an established news organization. Blogs, SEO content sites and lead-generation pages are " +
    "not sources: omit their numbers.\n" +
    "5. If you cannot source a figure for a point worth making, make the point qualitatively with no number. " +
    "A bullet with no statistic is strongly preferred over a bullet with an unverified one.\n" +
    "6. Do not present a quarter, month, or year as current unless a source dates it that way.\n" +
    "7. The Executive Summary is the section a reader sees first, so it must be quantitative: at least three " +
    "of its bullets state a specific figure, each carrying its attribution exactly as it would in the body. " +
    "Lead with the VERIFIED MARKET DATA figures — they are the ones you can be certain of. An Executive " +
    "Summary of generic statements with no numbers is a failed memo.\n" +
    "8. Never use markdown symbols (no **, no #, no bullet dashes — use plain hyphens).\n" +
    "9. Always emit all five required section headings, each on its own line, exactly as named by the user.\n" +
    "10. Each supplied source article is tagged RECOGNIZED PUBLISHER or BACKGROUND ONLY. Never cite, quote, " +
    "or take a figure from a BACKGROUND ONLY source — use it for orientation only."

  const verifiedBlock = formatVerifiedDataBlock(metrics)

  const user = `Write a distressed commercial real estate debt outlook memo. Use your web search tool AND the source articles below.

TODAY'S DATE: ${todayLongET()}

SCOPE: U.S. national, Florida, Miami-Dade
${verifiedBlock ? `\n${verifiedBlock}\n` : ""}

OUTPUT — use these exact five section headers in this order:
1) Executive Summary
2) U.S. commercial real estate outlook (CRE debt & distress)
3) Miami-specific CRE and distressed-debt outlook
4) How this shapes distressed-debt investing
5) Key sources (for further reading)

WRITING RULES:
- Start your response DIRECTLY with the text "Executive Summary" — no preamble, no memo header (no TO:/FROM:/DATE: lines), no commentary about searching.
- Write each of the five section headers on its own line, spelled exactly as listed above, before that section's bullets.
- EVERY section must be formatted as plain hyphen bullets ("- "), INCLUDING the Executive Summary. Never write paragraphs.
- The Executive Summary is the highest-value section: at least three of its bullets must carry a specific, attributed figure, drawn first from VERIFIED MARKET DATA and then from your strongest sourced findings. Restating a body figure here is expected, not a repetition error.
- Never repeat a point within a section. If two bullets in the same section would say the same thing, write only one of them.
- Each bullet starts on its OWN LINE with "- ".
- ONE key point per bullet. Never combine multiple facts, deals, or data points into a single bullet — split them.
- 4-8 bullets per section (except Key sources).
- Each bullet: 1-2 SHORT sentences maximum. Be concise.
- Include a dollar amount, percentage, basis-point move, delinquency rate, loan count or deal size ONLY when a source gives you that exact figure, and attach its attribution: (Publisher, Month Year).
- Name specific properties, cities, lenders, borrowers, or servicers only when a source names them.
- Run several distinct searches rather than one: CMBS delinquency and special servicing rates by property type; CRE loan maturity volumes coming due; South Florida and Miami-Dade foreclosure and lis pendens activity; recent distressed note and loan sale transactions with pricing; office and multifamily valuation marks; bank CRE portfolio sales.
- Prefer the most recent figure you can source, and always state the period it covers.
- If searches return nothing usable for a section, say so plainly in that section instead of filling it with estimated numbers.
- Key sources: list 4-8 URLs, one per line, format: Title — https://url

SUPPLEMENTAL SOURCE ARTICLES:
${richContext || "No supplemental articles provided — rely on web search."}`

  return { system, user, deniedSourceCount: deniedCount }
}

/**
 * What the evidence guard removed from the most recent generation in this
 * process. A bad source used to be discovered only by a reader noticing a bad
 * bullet; this is read back by /api/cron/warm-cache so every deploy reports it.
 * Null when the memo came from cache, i.e. the guard did not run.
 */
export type EvidenceGuardReport = {
  generatedAt: string
  bulletsKept: number
  droppedUnsourced: number
  droppedDenied: number
  removedDuplicates: number
  attributionsStripped: number
  /** Supplemental feed articles kept out of the prompt for being denied actors. */
  deniedSourceArticles: number
  /** Unrecognized hosts a citation pointed at — the list to review and act on. */
  unrecognizedDomains: string[]
  /** A few removed bullets, truncated, so a bad pattern is recognizable. */
  samples: string[]
  /** Measured FRED/FDIC figures available to this run. */
  verifiedMetrics: number
  /** Measured bullets added because the model's summary was short on figures. */
  verifiedBulletsInserted: number
  /** Figure-bearing Key Signals bullets after every rule ran. */
  keySignalFigures: number
}

let lastEvidenceGuardReport: EvidenceGuardReport | null = null

export function getLastEvidenceGuardReport(): EvidenceGuardReport | null {
  return lastEvidenceGuardReport
}

function countBullets(memo: string): number {
  return memo.split("\n").filter((l) => /^[-•*]\s/.test(l.trim())).length
}

/** Generates the memo. Throws on any failure so callers can decide whether to cache. */
async function runGeneration(): Promise<string> {
  // Both inputs are optional and independently time-boxed, so a slow or broken
  // feed costs latency at worst — never the memo.
  const [sources, metrics] = await Promise.all([
    withTimeout(retrieveSources(), 8000, "Source retrieval timed out.").catch(
      (err): RetrievedSource[] => {
        console.error("Industry outlook source retrieval error:", err)
        return []
      }
    ),
    getVerifiedMetrics(),
  ])

  const { system, user, deniedSourceCount } = buildPrompt(sources, metrics)
  const raw = await callOpenAi({
    system,
    user,
    tier: "fast",
    maxTokens: 3200,
    temperature: 0.2,
    webSearch: true,
    // Keep content farms out of the model's context in the first place. This is
    // the only call site that restricts search; every other feature is unchanged.
    searchAllowedDomains: SEARCH_ALLOWED_DOMAINS,
    timeoutMs: 90_000,
  })
  const {
    text: sanitized,
    dropped,
    denied,
    duplicates,
    strippedAttributions,
    unrecognizedDomains,
  } = sanitizeMemoEvidence(cleanMemoText(raw))

  const { text: content, inserted, figures } = ensureKeySignalFigures(sanitized, metrics)

  const report: EvidenceGuardReport = {
    generatedAt: new Date().toISOString(),
    bulletsKept: countBullets(content),
    droppedUnsourced: dropped.length,
    droppedDenied: denied.length,
    removedDuplicates: duplicates.length,
    attributionsStripped: strippedAttributions.length,
    deniedSourceArticles: deniedSourceCount,
    unrecognizedDomains: unrecognizedDomains.slice(0, 12),
    samples: [...denied, ...dropped].slice(0, 3).map((b) => b.slice(0, 140)),
    verifiedMetrics: metrics.length,
    verifiedBulletsInserted: inserted,
    keySignalFigures: figures,
  }
  lastEvidenceGuardReport = report
  console.info("industry-outlook:evidence-guard", JSON.stringify(report))

  if (!hasUsableContent(content)) {
    throw new Error("OpenAI returned insufficient content")
  }
  return content
}

/**
 * Returns today's industry outlook from cache, or generates + caches it.
 * Safe to call from both the API route and the cron warm-up directly —
 * no HTTP round-trip, no middleware interception.
 *
 * Failed generations are NEVER cached: the cached function throws on failure,
 * and the fallback memo is built fresh per request so the next request retries.
 */
export async function getCachedIndustryOutlook(): Promise<string> {
  const day = newsCalendarDayET()
  const cachedGeneration = unstable_cache(
    async () => runGeneration(),
    ["industry-outlook-shared-v12", day],
    { revalidate: NEWS_TAB_REVALIDATE_SECONDS }
  )

  try {
    if (!getOpenAiApiKey()) throw new Error("Missing OPENAI_API_KEY")
    return await cachedGeneration()
  } catch (err) {
    console.error("Industry outlook generation error:", err)
    const [sources, metrics] = await Promise.all([
      withTimeout(retrieveSources(), 8000, "Source retrieval timed out.").catch(
        (): RetrievedSource[] => []
      ),
      getVerifiedMetrics(),
    ])
    return buildFallbackMemo(
      sources,
      err instanceof Error ? err.message : "Unhandled generation error",
      metrics
    )
  }
}
