/**
 * Who a legal development actually applies to, computed rather than asserted.
 *
 * The Legal Landscape tab used to end each card at a generated `whyItMatters`
 * paragraph, which claims importance without demonstrating it. The model cannot be
 * asked to name the affected institutions — that is the fabrication failure this feed
 * has already been through once, and an invented bank name is far more dangerous than
 * an invented URL because there is nothing to click and check.
 *
 * So the division of labour here is the one the rest of this repo already trusts: the
 * model proposes a *test* (a size band, a concentration threshold), and we answer it
 * ourselves against FDIC call-report data. The model is being asked what the rule says
 * about its own scope, which is on the page it cited, rather than what is in our
 * portfolio, which it has no way to know.
 *
 * ## The unit trap
 *
 * There are two different "CRE concentration" figures in this codebase and they are not
 * interchangeable:
 *
 * - `ScreeningRow.creConcentration` is CRE loans over **total loans**, 0–100.
 * - `ScreeningRow.capitalRatios.creToTier1Tier2` is CRE over **Tier 1 + Tier 2 capital**,
 *   expressed as a multiple, so `3` is 300%.
 *
 * Supervisory thresholds — the 2006 interagency CRE guidance, and every rule that has
 * cited it since — are measured against the second. A rule saying "CRE above 300% of
 * capital" compared against `creConcentration` matches **nothing, ever**, because that
 * field cannot exceed 100. It fails silently and looks like a rule that happens not to
 * affect anyone. Hence `minCreToCapitalPct`, named for its units, resolved against
 * `creToTier1Tier2 * 100` and nothing else.
 */

/**
 * The fields of a screening row this module reads. The dashboard's
 * server/fdic-analytics.ts rows carry the same names (the contract was kept
 * when FDIC Data Analytics was rebuilt here), so they pass straight in.
 */
export type ScreeningRow = {
  id: string
  name: string
  state?: string
  totalAssets: number
  capitalRatios?: { creToTier1Tier2?: number | null; constructionToTier1Tier2?: number | null } | null
}

/**
 * The scope test a rule states about itself.
 *
 * Every field is optional because most developments state no quantitative scope at all,
 * and inventing one would defeat the point. Three states are deliberately
 * distinguishable: constraints present (compute the set), `appliesToAllInstitutions`
 * (the set is everyone), and neither (unknown — the card says nothing).
 */
export type LegalApplicability = {
  /** Lower bound on total assets, in dollars. A "$10 billion or more" rule is 1e10. */
  minTotalAssetsUsd?: number
  /** Upper bound on total assets, in dollars. Community-bank relief usually has one. */
  maxTotalAssetsUsd?: number
  /**
   * Lower bound on total CRE as a **percentage of Tier 1 + Tier 2 capital**. The 2006
   * guidance limb is `300`. See the unit trap above: this is not CRE over loans.
   */
  minCreToCapitalPct?: number
  /**
   * Lower bound on construction and land development as a percentage of capital. The
   * other limb of the 2006 guidance is `100`.
   */
  minConstructionToCapitalPct?: number
  /** Set when the rule applies regardless of size or concentration. */
  appliesToAllInstitutions?: boolean
  /**
   * The test restated in the rule's own words, so a reader can check our arithmetic
   * against the document we linked. This is the part that makes a wrong test
   * correctable rather than invisible.
   */
  basis?: string
}

export type ApplicabilityExample = {
  cert: string
  name: string
  state?: string
}

export type ApplicabilityMatch = {
  /** Institutions in the universe that satisfy the test. */
  matched: number
  /** How many institutions the test was applied to, so `matched` has a denominator. */
  universe: number
  /** The largest few matches, for sanity-checking the test against the linked rule. */
  examples: ApplicabilityExample[]
}

/** Absurd values are rejected rather than clamped, since a clamped threshold silently
 * answers a different question than the rule asked. */
const MAX_PLAUSIBLE_ASSETS_USD = 1e14
const MAX_PLAUSIBLE_PCT = 10000

function usableNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value < 0 || value > max) return undefined
  return value
}

/**
 * Narrow an untrusted applicability object from the model, or from a client calling the
 * resolver action.
 *
 * Returns `null` when nothing usable survives, which the caller must treat as "no test"
 * rather than as an empty test — an empty test matches every institution and would put
 * a confident, meaningless number on the card.
 */
export function normalizeApplicability(raw: unknown): LegalApplicability | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  const out: LegalApplicability = {
    minTotalAssetsUsd: usableNumber(r.minTotalAssetsUsd, MAX_PLAUSIBLE_ASSETS_USD),
    maxTotalAssetsUsd: usableNumber(r.maxTotalAssetsUsd, MAX_PLAUSIBLE_ASSETS_USD),
    minCreToCapitalPct: usableNumber(r.minCreToCapitalPct, MAX_PLAUSIBLE_PCT),
    minConstructionToCapitalPct: usableNumber(r.minConstructionToCapitalPct, MAX_PLAUSIBLE_PCT),
    appliesToAllInstitutions: r.appliesToAllInstitutions === true || undefined,
    basis: typeof r.basis === "string" && r.basis.trim() ? r.basis.trim() : undefined,
  }

  // An inverted band is a misread rather than a narrow rule, and silently returning zero
  // matches would present it as a finding.
  if (
    out.minTotalAssetsUsd !== undefined &&
    out.maxTotalAssetsUsd !== undefined &&
    out.minTotalAssetsUsd > out.maxTotalAssetsUsd
  ) {
    return null
  }

  return hasTest(out) ? out : null
}

/** Whether there is anything to resolve. `basis` alone is prose, not a test. */
export function hasTest(test: LegalApplicability): boolean {
  return (
    test.appliesToAllInstitutions === true ||
    test.minTotalAssetsUsd !== undefined ||
    test.maxTotalAssetsUsd !== undefined ||
    test.minCreToCapitalPct !== undefined ||
    test.minConstructionToCapitalPct !== undefined
  )
}

/** `creToTier1Tier2` is a multiple, so 3 is 300%. Converted once, here, on purpose. */
function creToCapitalPct(row: ScreeningRow): number | null {
  const ratio = row.capitalRatios?.creToTier1Tier2
  return typeof ratio === "number" && Number.isFinite(ratio) ? ratio * 100 : null
}

function constructionToCapitalPct(row: ScreeningRow): number | null {
  const ratio = row.capitalRatios?.constructionToTier1Tier2
  return typeof ratio === "number" && Number.isFinite(ratio) ? ratio * 100 : null
}

/**
 * Whether one institution falls inside the rule's stated scope.
 *
 * An institution whose capital ratios are missing is **excluded** from a
 * concentration-based test rather than included. FDIC omits the inputs for a minority of
 * filers, and counting them as matches would inflate the affected set with institutions
 * we cannot actually show to be affected. The count therefore reads as "at least this
 * many", which is the honest direction to be wrong in.
 */
export function institutionMatches(row: ScreeningRow, test: LegalApplicability): boolean {
  if (test.minTotalAssetsUsd !== undefined && !(row.totalAssets >= test.minTotalAssetsUsd)) {
    return false
  }
  if (test.maxTotalAssetsUsd !== undefined && !(row.totalAssets <= test.maxTotalAssetsUsd)) {
    return false
  }

  if (test.minCreToCapitalPct !== undefined) {
    const pct = creToCapitalPct(row)
    if (pct === null || pct < test.minCreToCapitalPct) return false
  }

  if (test.minConstructionToCapitalPct !== undefined) {
    const pct = constructionToCapitalPct(row)
    if (pct === null || pct < test.minConstructionToCapitalPct) return false
  }

  return true
}

const MAX_EXAMPLES = 3

/**
 * The institutions a test selects, largest first.
 *
 * Kept separate from `resolveApplicability` so a caller that needs the rows themselves — to
 * intersect them with a watchlist, say — can do it from the same single pass rather than
 * re-deriving the matched set with a second, possibly divergent, filter.
 */
export function selectMatching(
  test: LegalApplicability,
  universe: ScreeningRow[]
): ScreeningRow[] {
  return universe
    .filter((row) => institutionMatches(row, test))
    .sort((a, b) => b.totalAssets - a.totalAssets)
}

/**
 * Summarize an already-matched set.
 *
 * Examples are the largest matches rather than an arbitrary slice, because the reader
 * recognising a name is what makes a wrong test obvious.
 */
export function summarizeMatches(
  matched: ScreeningRow[],
  universeSize: number
): ApplicabilityMatch {
  return {
    matched: matched.length,
    universe: universeSize,
    examples: matched.slice(0, MAX_EXAMPLES).map((row) => ({
      cert: row.id,
      name: row.name,
      state: row.state,
    })),
  }
}

/** Apply a test to a universe of institutions. */
export function resolveApplicability(
  test: LegalApplicability,
  universe: ScreeningRow[]
): ApplicabilityMatch {
  return summarizeMatches(selectMatching(test, universe), universe.length)
}

/**
 * The test in the reader's words, built from the numbers we actually applied.
 *
 * Derived from the sanitized test rather than echoing the model's `basis`, so that what
 * the card claims and what the count measured cannot drift apart.
 */
export function describeTest(test: LegalApplicability): string {
  const clauses: string[] = []

  const { minTotalAssetsUsd: min, maxTotalAssetsUsd: max } = test
  if (min !== undefined && max !== undefined) {
    clauses.push(`assets between ${formatAssets(min)} and ${formatAssets(max)}`)
  } else if (min !== undefined) {
    clauses.push(`assets of ${formatAssets(min)} or more`)
  } else if (max !== undefined) {
    clauses.push(`assets under ${formatAssets(max)}`)
  }

  if (test.minCreToCapitalPct !== undefined) {
    clauses.push(`CRE at or above ${formatPct(test.minCreToCapitalPct)} of capital`)
  }
  if (test.minConstructionToCapitalPct !== undefined) {
    clauses.push(`construction at or above ${formatPct(test.minConstructionToCapitalPct)} of capital`)
  }

  if (clauses.length === 0) return "all insured institutions"
  return clauses.join(" and ")
}

function formatPct(pct: number): string {
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
}

function formatAssets(usd: number): string {
  if (usd >= 1e12) return `$${trim(usd / 1e12)}tn`
  if (usd >= 1e9) return `$${trim(usd / 1e9)}bn`
  if (usd >= 1e6) return `$${trim(usd / 1e6)}m`
  return `$${Math.round(usd).toLocaleString()}`
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
