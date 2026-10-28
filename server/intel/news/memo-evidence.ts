/**
 * Evidence guardrail for the AI-generated industry outlook memo.
 *
 * The memo is written by a model with a hosted web-search tool. Two failure
 * modes produce fabricated statistics in an investment memo:
 *
 *  1. The model states a figure it never read (e.g. "Miami-Dade lis pendens
 *     filings averaging 180-220 per week"), sometimes attaching whatever
 *     citation happens to be nearby.
 *  2. Web search surfaces an SEO content farm, and the model treats it as a
 *     citable authority.
 *
 * A prompt instruction cannot prevent either one. This module is the actual
 * enforcement, in three escalating rules applied to every body bullet:
 *
 *  - A bullet crediting a denied actor is removed outright.
 *  - An attribution to an unrecognized publisher is stripped out, keeping the
 *    surrounding qualitative sentence — a farm is not citable for opinion
 *    either, but the analysis around it is often still worth reading.
 *  - What remains must credit a recognized publisher if it states a figure,
 *    or the bullet is removed.
 *
 * Bullets with no attribution and no figures are never touched: the Executive
 * Summary is legitimately qualitative and must survive intact.
 *
 * Deliberately dependency-free so it can be unit tested with
 * `node --test --experimental-strip-types lib/memo-evidence.test.ts`.
 */

export const MEMO_HEADINGS = [
  "Executive Summary",
  "U.S. commercial real estate outlook (CRE debt & distress)",
  "Miami-specific CRE and distressed-debt outlook",
  "How this shapes distressed-debt investing",
  "Key sources (for further reading)",
]

const SOURCES_HEADING = "Key sources (for further reading)"

/**
 * Publishers whose figures we are willing to print. Default-deny: anything not
 * listed is treated as unverified, which is the intended bias — a bullet with
 * no statistic is better than a bullet with an invented one.
 */
export const TRUSTED_PUBLISHER_DOMAINS = [
  // CRE data, ratings and research
  "trepp.com",
  "spglobal.com",
  "moodys.com",
  "moodysanalytics.com",
  "fitchratings.com",
  "kbra.com",
  "morningstar.com",
  "greenstreet.com",
  "costar.com",
  "attomdata.com",
  "attom.com",
  "corelogic.com",
  "realtytrac.com",
  "msci.com",
  "rcanalytics.com",
  "cred-iq.com",
  "credaily.com",
  "yardimatrix.com",
  "lightboxre.com",
  // CRE trade press
  "bisnow.com",
  "commercialobserver.com",
  "therealdeal.com",
  "globest.com",
  "connectcre.com",
  "cpexecutive.com",
  "commercialsearch.com",
  "multihousingnews.com",
  "rebusinessonline.com",
  "wealthmanagement.com",
  "crenews.com",
  "commercialmortgage.com",
  // Brokerages and lenders
  "cbre.com",
  "jll.com",
  "cushmanwakefield.com",
  "colliers.com",
  "newmark.com",
  "marcusmillichap.com",
  "avisonyoung.com",
  "savills.us",
  "berkadia.com",
  "walkerdunlop.com",
  // Associations, GSEs and regulators
  "mba.org",
  "nareit.com",
  "nar.realtor",
  "urban.org",
  "freddiemac.com",
  "fanniemae.com",
  "newyorkfed.org",
  "stlouisfed.org",
  "dallasfed.org",
  "philadelphiafed.org",
  "richmondfed.org",
  "atlantafed.org",
  // General business and financial press
  "wsj.com",
  "bloomberg.com",
  "reuters.com",
  "ft.com",
  "cnbc.com",
  "barrons.com",
  "forbes.com",
  "businessinsider.com",
  "axios.com",
  "marketwatch.com",
  "nytimes.com",
  "washingtonpost.com",
  "economist.com",
  "apnews.com",
  "fortune.com",
  // Florida / South Florida
  "miamiherald.com",
  "bizjournals.com",
  "sun-sentinel.com",
  "floridatrend.com",
  "thenextmiami.com",
  "miamitodaynews.com",
  "wlrn.org",
  "local10.com",
  "nbcmiami.com",
  "floridarealtors.org",
  "miamidade.gov",
  // Florida Department of Revenue — an official body that the .gov rule misses.
  "floridarevenue.com",
]

/** Publisher names as a model is likely to write them in "(Publisher, Month Year)". */
export const TRUSTED_PUBLISHER_NAMES = [
  "trepp",
  "s&p global",
  "s&p",
  "standard & poor",
  "moody's",
  "moodys",
  "fitch",
  "kbra",
  "morningstar",
  "green street",
  "costar",
  "attom",
  "corelogic",
  "realtytrac",
  "msci",
  "real capital analytics",
  "cred iq",
  "cred-iq",
  "cre daily",
  "yardi",
  "lightbox",
  "bisnow",
  "commercial observer",
  "the real deal",
  "globest",
  "globe st",
  "connect cre",
  "commercial property executive",
  "multi-housing news",
  "cbre",
  "jll",
  "cushman",
  "colliers",
  "newmark",
  "marcus & millichap",
  "avison young",
  "savills",
  "berkadia",
  "walker & dunlop",
  "mortgage bankers association",
  "nareit",
  "national association of realtors",
  "urban institute",
  "freddie mac",
  "fannie mae",
  "federal reserve",
  "new york fed",
  "st. louis fed",
  // FRED redistributes the Fed, Treasury and Freddie Mac series behind the
  // memo's measured figures, and is named in their attributions.
  "fred",
  "ice data indices",
  "fdic",
  "occ",
  "u.s. treasury",
  "census bureau",
  "bureau of labor statistics",
  "wall street journal",
  "bloomberg",
  "reuters",
  "financial times",
  "cnbc",
  "barron's",
  "forbes",
  "business insider",
  "axios",
  "marketwatch",
  "new york times",
  "washington post",
  "the economist",
  "associated press",
  "fortune",
  "miami herald",
  "business journal",
  "sun sentinel",
  "sun-sentinel",
  "florida trend",
  "the next miami",
  "miami today",
  "wlrn",
  "florida realtors",
  "miami-dade clerk",
  "miami-dade county clerk",
  "miami-dade oca",
  "office of the courts administrator",
]

/**
 * The model writes typographic characters — non-breaking hyphens in
 * "Miami‑Dade", non-breaking spaces in "CRED iQ", curly apostrophes — which
 * silently defeat literal matching. Left unnormalized this both under-credits
 * real publishers and lets a denied byline slip through as "Marcus Bell AI".
 */
function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
}

/**
 * Known-bad actors, denied ahead of any allowlist or .gov/.edu match.
 *
 * This is the weakest layer — a content farm can register a new domain in
 * minutes — so it exists only to make repeat offenders cheap to shut off. The
 * allowlist above is what actually holds. `real-estate-tycoon.org` published
 * the fabricated Miami-Dade lis pendens and Florida foreclosure figures under
 * the byline "Marcus Bell AI"; the others were observed in live web-search
 * results for these same queries.
 */
export const DENIED_SOURCE_DOMAINS = [
  "real-estate-tycoon.org",
  "dealcharts.org",
  "legalclarity.org",
  "creditandcollectionnews.com",
  "tmcnet.com",
  // A notice-aggregation page cited for Florida foreclosure counts in every
  // unrestricted live run — the same failure class as the original complaint.
  "noticeregistry.com",
]

/**
 * Bylines that identify machine-written content regardless of where it is
 * hosted. "Marcus Bell" is denied without the "AI" suffix too: the model
 * shortens bylines, and a real analyst by that name is not a source we cite.
 */
export const DENIED_BYLINES = ["marcus bell ai", "marcus bell"]

/**
 * Domains passed to OpenAI's web_search `filters.allowed_domains`, which keeps
 * an unrecognized source out of the model's context entirely.
 *
 * Anything searchable is also citable — a search-only domain would just produce
 * bullets that the citation rules then delete. The additions over
 * TRUSTED_PUBLISHER_DOMAINS are government hosts that the .gov rule already
 * trusts for citation but that search filtering has to name explicitly.
 */
export const SEARCH_ALLOWED_DOMAINS = [
  ...TRUSTED_PUBLISHER_DOMAINS,
  "federalreserve.gov",
  "fdic.gov",
  "occ.gov",
  "treasury.gov",
  "sec.gov",
  "bls.gov",
  "census.gov",
  "consumerfinance.gov",
  "fhfa.gov",
  "miamidadeclerk.gov",
]

const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").trim()
}

/** Denied outright, including subdomains — takes precedence over any allowlist. */
export function isDeniedDomain(host: string): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  return DENIED_SOURCE_DOMAINS.some((d) => h === d || h.endsWith("." + d))
}

/** Exact host or subdomain of a trusted domain; plus any .gov / .edu host. */
export function isTrustedDomain(host: string): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  if (isDeniedDomain(h)) return false
  if (/\.(gov|edu|mil)$/.test(h)) return true
  return TRUSTED_PUBLISHER_DOMAINS.some((d) => h === d || h.endsWith("." + d))
}

/** True when the text names a denied domain or byline anywhere. */
export function hasDeniedSource(text: string): boolean {
  const normalized = normalizeTypography(text.toLowerCase())
  if (DENIED_BYLINES.some((b) => normalized.includes(b))) return true
  DOMAIN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DOMAIN_RE.exec(normalized))) {
    if (isDeniedDomain(match[1])) return true
  }
  return false
}

function mentionsTrustedName(text: string): boolean {
  const t = normalizeTypography(text.toLowerCase())
  return TRUSTED_PUBLISHER_NAMES.some((name) => {
    let from = 0
    for (;;) {
      const idx = t.indexOf(name, from)
      if (idx === -1) return false
      from = idx + 1
      // Require a word boundary so "mba" does not match inside "columbia",
      // but tolerate a plural or possessive ("Business Journals", "Reuters'").
      const before = idx === 0 ? " " : t[idx - 1]
      let end = idx + name.length
      if (t[end] === "s") end += 1
      if (t[end] === "'") end += 1
      const after = end >= t.length ? " " : t[end]
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
    }
  })
}

/**
 * True when the text credits a recognized publisher — either a cited domain
 * (web search leaves these as "(trepp.com)") or a named one ("(Trepp, July 2026)").
 */
export function hasTrustedAttribution(text: string): boolean {
  DOMAIN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DOMAIN_RE.exec(text))) {
    if (isTrustedDomain(match[1])) return true
  }
  return mentionsTrustedName(text)
}

/**
 * Blanks out anything date-shaped so a calendar reference is never mistaken
 * for a statistic. "Q1 2026", "July 2026", "2025-2026" carry no numeric claim.
 */
function maskDates(text: string): string {
  return text
    .replace(/\bQ[1-4]\s*(?:of\s*)?(?:'|FY)?\s*(?:19|20)?\d{2}\b/gi, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2},?\s*(?:19|20)\d{2}\b/gi,
      " "
    )
    .replace(/\b(?:19|20)\d{2}\s*(?:–|—|-|to|through)\s*(?:19|20)?\d{2}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
}

const STAT_PATTERNS: RegExp[] = [
  // Money: $930 billion, $2M, $1.4 trillion
  /\$\s?\d/,
  // Rates: 6.1%, 43 percent, 6 basis points, 25 bps
  /\d[\d,.]*\s*(?:%|percent\b|percentage\s+points?\b|pct\b|basis\s+points?\b|bps\b)/i,
  // Magnitudes: 930 billion, 2.4 million
  /\d[\d,.]*\s*(?:trillion|billion|million|thousand)\b/i,
  // Ranges (years already masked out): 180-220, 15 to 20
  /\b\d[\d,]*(?:\.\d+)?\s*(?:–|—|-|to)\s*\d[\d,]*(?:\.\d+)?\b/,
  // Thousands-separated counts: 1,200
  /\b\d{1,3}(?:,\d{3})+\b/,
  // Counted things: 420 filings, 37 loans, 1.2 msf
  /\b\d[\d,.]*\s*(?:filings?|loans?|notes?|mortgages?|properties|assets?|units?|deals?|transactions?|foreclosures?|auctions?|buildings?|keys\b|beds\b|acres?|square\s+feet|sf\b|msf\b|sq\.?\s?ft)/i,
]

/** True when the text asserts a quantitative claim (dates and bare years excluded). */
export function containsStatistic(text: string): boolean {
  const masked = maskDates(text)
  return STAT_PATTERNS.some((re) => re.test(masked))
}

const DOMAIN_LIKE_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i
const URL_RE = /https?:\/\/[^\s)\]]+/gi
const PAREN_RE = /\s*\(([^()]*)\)/g

/**
 * "according to X", "per X", "as reported by X" — an attribution written into
 * the prose rather than parenthesized. Anchored on a capitalized name so
 * ordinary phrasing ("according to the loan documents") is not matched.
 */
const ATTRIBUTION_PHRASE_RE =
  /,?\s*\b(?:according to|as reported by|reported by|as first reported by|per|via|citing|sourced from)\s+(?:the\s+)?([A-Z][A-Za-z0-9&.'’-]*(?:\s+(?:of|de|&|and)?\s*[A-Z][A-Za-z0-9&.'’-]*){0,4})/g

/**
 * True when a parenthetical is a source credit rather than an ordinary aside.
 * "(credaily.com)", "(Trepp, July 2026)" and "(Source: ATTOM)" are credits;
 * "(CRE debt & distress)" and "(NPLs)" are not, and must be left alone.
 */
function isAttributionParen(inner: string): boolean {
  const text = inner.trim()
  if (!text) return false
  if (/https?:\/\//i.test(text)) return true
  if (DOMAIN_LIKE_RE.test(text)) return true
  if (/^(?:source|sources|per|via|from|courtesy of|reported by)\s*[:\-—]?\s+/i.test(text)) return true
  // "<name>, July 2026" / "<name>, Q2 2026" / "<name>, 2026"
  return /^[^,]{2,60},\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2},?\s*)?(?:Q[1-4]\s*)?(?:19|20)\d{2}\.?$/i.test(
    text
  )
}

function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return ""
  }
}

/**
 * Every domain named in a piece of attribution text, as bare hosts. Uses its
 * own regex instances: this runs from inside a String.replace callback, where
 * sharing lastIndex with the regex driving that replace would be fragile.
 */
function domainsIn(text: string): string[] {
  const found: string[] = []
  const urls = new RegExp(URL_RE.source, "gi")
  let urlMatch: RegExpExecArray | null
  while ((urlMatch = urls.exec(text))) {
    const host = hostOf(urlMatch[0])
    if (host) found.push(host)
  }

  const domains = new RegExp(DOMAIN_RE.source, "gi")
  let match: RegExpExecArray | null
  const withoutUrls = text.replace(new RegExp(URL_RE.source, "gi"), " ")
  while ((match = domains.exec(withoutUrls))) found.push(normalizeHost(match[1]))
  return [...new Set(found)]
}

/**
 * Cleans up the gap a removed citation leaves behind. Removing a trailing
 * "according to <Publisher>." takes the sentence's final period with it, so the
 * original terminator is restored.
 */
function tidy(text: string, original: string): string {
  const cleaned = text
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:]+([.!?])$/, "$1")
    .replace(/[\s,;:]+$/, "")
    .trim()

  if (!cleaned) return cleaned
  const terminator = original.trim().match(/[.!?]$/)?.[0]
  return terminator && !/[.!?]$/.test(cleaned) ? cleaned + terminator : cleaned
}

export type AttributionAudit = {
  /** Attribution text removed from surviving bullets, e.g. "real-estate-tycoon.org". */
  stripped: string[]
  /** Hosts seen in an attribution that the allowlist does not recognize. */
  unrecognized: string[]
}

/**
 * Removes source credits that point at unrecognized publishers, leaving the
 * analytical sentence in place. Stripping beats dropping here: the model often
 * writes a sound qualitative read and then hangs a junk citation on it, and the
 * claim stands on its own once the false authority is gone. A bullet left too
 * thin to say anything is dropped by the caller.
 */
function stripUntrustedAttributions(body: string, audit: AttributionAudit): string {
  const record = (raw: string) => {
    const label = raw.trim()
    if (label && !audit.stripped.includes(label)) audit.stripped.push(label)
    for (const host of domainsIn(raw)) {
      if (!audit.unrecognized.includes(host)) audit.unrecognized.push(host)
    }
  }

  let out = body.replace(PAREN_RE, (whole, inner: string) => {
    if (!isAttributionParen(inner) || hasTrustedAttribution(inner)) return whole
    record(inner)
    return ""
  })

  out = out.replace(ATTRIBUTION_PHRASE_RE, (whole, name: string) => {
    if (hasTrustedAttribution(name)) return whole
    // Only a name that looks like a publisher, not an ordinary capitalized noun.
    if (!DOMAIN_LIKE_RE.test(name) && !/\s/.test(name.trim())) return whole
    record(name)
    return ""
  })

  // Bare cited URLs left in prose by citation stripping upstream.
  out = out.replace(URL_RE, (url) => {
    const host = hostOf(url)
    if (!host || isTrustedDomain(host)) return url
    record(host)
    return ""
  })

  return out === body ? body : tidy(out, body)
}

/** Logs the offending hosts of a bullet the guard threw away. */
function recordUntrustedDomains(text: string, audit: AttributionAudit): void {
  for (const host of domainsIn(text)) {
    if (isTrustedDomain(host)) continue
    if (!audit.unrecognized.includes(host)) audit.unrecognized.push(host)
  }
}

export type MemoSanitizeResult = {
  text: string
  /** Bullets removed for stating an unverifiable figure — logged, not shown. */
  dropped: string[]
  /** Bullets removed for crediting an explicitly denied source. */
  denied: string[]
  /** Bullets removed as restatements of an earlier bullet. */
  duplicates: string[]
  /** Unrecognized credits removed from bullets that otherwise survived. */
  strippedAttributions: string[]
  /** Distinct unrecognized hosts seen in any credit — the whack-a-mole feed. */
  unrecognizedDomains: string[]
}

export const NO_DATA_LINE =
  "- No independently sourced figures were available for this section in today's run."

/** Letters remaining after a strip, below which the bullet says nothing. */
const MIN_STRIPPED_BULLET_LETTERS = 35

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "to", "for", "on", "at", "by", "with",
  "is", "are", "was", "were", "has", "have", "had", "as", "that", "this", "these",
  "from", "its", "it", "which", "while", "also", "been", "be",
])

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9.%$\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  )
}

/**
 * The model frequently restates the same finding several times in one section
 * — sometimes looping the identical sentence — which reads as padding in a
 * memo. Two bullets sharing most of their content words are the same point.
 *
 * Compared within a section only. The Executive Summary is a deliberate
 * restatement of the body's strongest figures, so comparing across sections
 * would let the summary delete the very bullets it is summarizing.
 */
function isRestatement(candidate: Set<string>, seen: Set<string>[]): boolean {
  if (candidate.size === 0) return false
  for (const prior of seen) {
    let shared = 0
    for (const word of candidate) if (prior.has(word)) shared += 1
    const overlap = shared / Math.min(candidate.size, prior.size)
    if (overlap >= 0.8) return true
  }
  return false
}

/**
 * Removes every bullet that states a statistic without crediting a recognized
 * publisher. Section headings and the "Key sources" URL list pass through
 * untouched — a link is not a claim, and dropping links would strip the memo's
 * audit trail.
 */
export function sanitizeMemoEvidence(memo: string): MemoSanitizeResult {
  const dropped: string[] = []
  const denied: string[] = []
  const duplicates: string[] = []
  const audit: AttributionAudit = { stripped: [], unrecognized: [] }
  const out: string[] = []
  let seenPoints: Set<string>[] = []
  const sourceLines: string[] = []
  let section = ""
  let bulletsInSection = 0

  const flushSection = () => {
    if (section && section !== SOURCES_HEADING && bulletsInSection === 0) {
      out.push(NO_DATA_LINE)
    }
  }

  for (const line of memo.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (section !== SOURCES_HEADING) out.push("")
      continue
    }

    const heading = MEMO_HEADINGS.find((h) => trimmed.toLowerCase() === h.toLowerCase())
    if (heading) {
      flushSection()
      section = heading
      bulletsInSection = 0
      seenPoints = []
      out.push(trimmed)
      continue
    }

    if (section === SOURCES_HEADING) {
      sourceLines.push(trimmed)
      continue
    }

    const prefix = trimmed.match(/^(?:[-•*]\s*)+/)?.[0] ?? ""
    const body = trimmed.slice(prefix.length)

    if (hasDeniedSource(body)) {
      denied.push(body)
      recordUntrustedDomains(body, audit)
      continue
    }

    const kept = stripUntrustedAttributions(body, audit)
    const wasStripped = kept !== body

    if (containsStatistic(kept) && !hasTrustedAttribution(kept)) {
      dropped.push(body)
      continue
    }
    // Once its false authority is gone, a stub is not worth a bullet.
    if (wasStripped && kept.replace(/[^a-z]/gi, "").length < MIN_STRIPPED_BULLET_LETTERS) {
      dropped.push(body)
      continue
    }

    const words = contentWords(kept)
    if (isRestatement(words, seenPoints)) {
      duplicates.push(body)
      continue
    }
    seenPoints.push(words)

    bulletsInSection += 1
    out.push(wasStripped ? `${prefix}${kept}` : trimmed)
  }
  flushSection()

  if (sourceLines.length) out.push(...filterSourceLines(sourceLines, audit))

  return {
    text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    dropped,
    denied,
    duplicates,
    strippedAttributions: audit.stripped,
    unrecognizedDomains: audit.unrecognized,
  }
}

/**
 * Key Signals bullets that must state a figure. Three fills the first row of
 * the card grid, which is what a reader sees without scrolling.
 */
export const MIN_KEY_SIGNAL_FIGURES = 3

/** Bounds of the Executive Summary's body lines, exclusive of its heading. */
function executiveSummaryRange(lines: string[]): { start: number; end: number } | null {
  const heading = lines.findIndex((l) => l.trim().toLowerCase() === "executive summary")
  if (heading === -1) return null
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i++) {
    if (MEMO_HEADINGS.some((h) => lines[i].trim().toLowerCase() === h.toLowerCase())) {
      end = i
      break
    }
  }
  return { start: heading + 1, end }
}

/**
 * A figure this system measured itself, as a printable sentence. Structural on
 * purpose: lib/verified-metrics.ts produces these, and importing it here would
 * make both modules circular and neither of them unit testable.
 */
export type MeasuredFigure = {
  /** The figure alone, used to detect that the memo already states it. */
  value: string
  /** Complete attributed sentence, printable as a bullet without editing. */
  sentence: string
}

/**
 * Guarantees Key Signals states real numbers.
 *
 * Key Signals renders the Executive Summary, so when the model writes a summary
 * of generalities — which it does often enough to matter, and did every time
 * while figures were banned there outright — the most prominent section of the
 * memo carries no information. Prompt wording alone never fixed this.
 *
 * Measured figures are the remedy: they need no publisher to vouch for them, so
 * they can be inserted after the rules above have run and still be trustworthy.
 * A figure the summary already quotes is skipped, and the "no figures available"
 * placeholder gives way to the real data.
 *
 * Call this after sanitizeMemoEvidence, so an inserted bullet is never at risk
 * of being deleted as unsourced.
 */
export function ensureKeySignalFigures(
  memo: string,
  measured: MeasuredFigure[]
): { text: string; inserted: number; figures: number } {
  const lines = memo.split("\n")
  const range = executiveSummaryRange(lines)
  if (!range) return { text: memo, inserted: 0, figures: 0 }

  const section = lines.slice(range.start, range.end)
  const figures = section.filter(
    (l) => /^[-•*]\s/.test(l.trim()) && containsStatistic(l)
  ).length
  const shortfall = MIN_KEY_SIGNAL_FIGURES - figures
  if (shortfall <= 0 || measured.length === 0) return { text: memo, inserted: 0, figures }

  const existing = section.join(" ")
  const additions = measured
    .filter((m) => !existing.includes(m.value))
    .slice(0, shortfall)
    .map((m) => `- ${m.sentence}`)
  if (additions.length === 0) return { text: memo, inserted: 0, figures }

  const kept = section.filter((l) => l.trim() !== NO_DATA_LINE.trim())
  return {
    text: [
      ...lines.slice(0, range.start),
      ...additions,
      ...kept,
      ...lines.slice(range.end),
    ].join("\n"),
    inserted: additions.length,
    figures: figures + additions.length,
  }
}

/**
 * A link is not a claim, so the reading list is kept generously: untrusted URLs
 * are dropped only when enough recognized publishers remain to still give the
 * reader somewhere to verify the memo. Denied sources are the exception — they
 * are never worth a click, so they go regardless of what is left.
 */
function filterSourceLines(lines: string[], audit: AttributionAudit): string[] {
  const allowed: string[] = []
  for (const line of lines) {
    if (hasDeniedSource(line)) recordUntrustedDomains(line, audit)
    else allowed.push(line)
  }

  const trusted = allowed.filter((l) => {
    const url = l.match(/https?:\/\/[^\s)]+/)?.[0]
    return url ? isTrustedDomain(hostOf(url)) : false
  })
  return trusted.length >= 3 ? trusted : allowed
}
