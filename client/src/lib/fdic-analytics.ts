/**
 * Client for the FDIC Data Analytics page's data routes.
 *
 * These are this app's own /api/fdic/* routes (server/fdic-analytics.ts),
 * computed from the FDIC Call Report rows the weekly collector job pulls
 * directly from the FDIC. From 7 to 27 Oct 2026 the page read a pass-through
 * to the Market Intelligence tool instead; the envelope and payload shapes
 * were kept when the source moved in-house (stage 2), and the module was
 * renamed from market-intelligence.ts when the proxy was removed (stage 4).
 *
 * Balance-sheet behaviour signals (`meta.signals`, `/behavior-signals`, the
 * drawer's `behavior`) are computed by collector/bank_stress/behavior.py since
 * stage 3 — a port of the Market Intelligence rules — and served from the same
 * tables. `behavior` is null only for a bank with a single quarter on file.
 *
 * Units, because they are easy to get wrong:
 *   nplRatio, noncurrent_to_*_ratio, pastDue*, loanLossReserve   fractions (0.0053)
 *   creConcentration, cet1Ratio, leverageRatio, roaLatest, nim*  percents  (40.3)
 *   kpis.avgNplRatio, kpis.avgReserveCoverage                     fractions
 *   kpis.avgNoncurrentToLoans, kpis.avgCreConcentration           percents
 *   nplSummary.avgNpl, nplSummary.avgCreToAssets                  percents
 *   dollar fields on rows                                         dollars
 *   behavior.* money fields and trend money fields                $ thousands (Call Report native)
 *   the stress scores                                             percentile ranks 0–100 within the bank's
 *                                                                 asset-size peer band, higher = more stress
 */

const API_PREFIX = '/api/fdic'

// ── Envelope ────────────────────────────────────────────────────────────────

export type FdicMetaStamp = { quarter: string; scope: string; contractVersion: string; servedAt: string }

export class FdicError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FdicError'
    this.status = status
  }
  /** 401/503/502 mean the source is down or misconfigured, not that the user asked for something invalid. */
  get unavailable() {
    return this.status === 401 || this.status === 502 || this.status === 503 || this.status === 0
  }
}

async function apiGet<T>(path: string): Promise<T & { meta: FdicMetaStamp }> {
  let res: Response
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new FdicError(0, err instanceof Error ? err.message : 'network error')
  }
  let body: any
  try {
    body = await res.json()
  } catch {
    throw new FdicError(res.status || 502, `Unexpected non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok || !body || body.ok !== true) {
    throw new FdicError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
  }
  return body as T & { meta: FdicMetaStamp }
}

// ── /meta ───────────────────────────────────────────────────────────────────

export type FdicSignalDef = {
  key: string
  label: string
  side: 'action' | 'pressure'
  meaning: string
  rule: string
}

export type FdicAssetBand = { key: string; label: string; maxAssets: number | null }

export type FdicMeta = {
  meta: FdicMetaStamp & { apiVersion: string; source: string }
  scopes: { national: string; states: Record<string, string> }
  assetBands: FdicAssetBand[]
  signals: FdicSignalDef[]
  signalThresholds: Record<string, number>
  creCategoryLabels: Record<string, string>
  endpoints: Record<string, string>
  cache: { note: string }
}

let metaPromise: Promise<FdicMeta> | null = null

/** One fetch per page load; both the page and the drawer need it. Failures are not memoised. */
export function loadFdicMeta(): Promise<FdicMeta> {
  if (!metaPromise) {
    metaPromise = apiGet<FdicMeta>(`${API_PREFIX}/meta`).catch((err) => {
      metaPromise = null
      throw err
    })
  }
  return metaPromise
}

export function signalsByKey(meta: FdicMeta | null): Map<string, FdicSignalDef> {
  return new Map((meta?.signals ?? []).map((s) => [s.key, s]))
}

/** "FLORIDA" → "FL" using meta.scopes.states; falls back to the input. */
export function stateCodeFor(meta: FdicMeta | null, stateName: string | undefined): string | undefined {
  if (!stateName || !meta) return stateName
  const upper = stateName.toUpperCase()
  if (upper.length === 2 && meta.scopes.states[upper]) return upper
  for (const [code, name] of Object.entries(meta.scopes.states)) {
    if (name.toUpperCase() === upper) return code
  }
  return stateName
}

// ── /screening ──────────────────────────────────────────────────────────────

export type FdicCapitalCategory = { category: string; label: string; binding: string; basis: string }

export type FdicCapitalRatios = {
  creToTier1Tier2: number | null
  creToEquity: number | null
  constructionToTier1Tier2: number | null
  multifamilyToTier1Tier2: number | null
}

export type FdicTrendPoint = { reportDate: string; creConcentration?: number; nplRatio?: number }

export type FdicScreeningRow = {
  id: string // FDIC CERT
  name: string
  city?: string
  state?: string // full state name, e.g. "FLORIDA"
  reportDate: string // YYYYMMDD
  totalAssets: number
  totalLoans?: number
  creLoans?: number
  creConcentration?: number
  nonaccrualLoans?: number
  nplRatio?: number
  noncurrent_to_loans_ratio?: number
  noncurrent_to_assets_ratio?: number
  pastDue3090?: number
  pastDue90Plus?: number
  loanLossReserve?: number
  loansToDeposits?: number
  cet1Ratio?: number
  leverageRatio?: number
  capitalCategory?: FdicCapitalCategory
  totalUnusedCommitments?: number
  creUnusedCommitments?: number
  constructionLoans?: number
  multifamilyLoans?: number
  nonResidentialLoans?: number
  otherRealEstateLoans?: number
  ownerOccupiedLoans?: number
  nonOwnerOccupiedLoans?: number
  roaLatest?: number | null
  roaDelta4Q?: number | null
  netIncomeTTM?: number | null
  netIncomeYoYPct?: number | null
  nimLatest?: number | null
  nimDelta4Q?: number | null
  earningsBufferPct?: number | null
  capitalRatios?: FdicCapitalRatios
  trend: FdicTrendPoint[]
  stateCode?: string
  // Bank Stress Ranking scores — percentile ranks within the asset band, higher = more stress.
  // Null for banks that are shown but not ranked (established < 3 years ago).
  stressComposite: number | null
  conditionScore: number | null
  deteriorationScore: number | null
  creExposureScore: number | null
  stressRank: number | null
  peerBand: string | null
  flagCount: number
  flags: string[]
  tier: 'normal' | 'watchlist' | 'pressure' | null
  creSellerSignal: boolean
  excludedReason: string | null
}

export type FdicScreeningKpis = {
  institutionsScreened: number
  avgNplRatio: number
  avgNoncurrentToLoans: number
  avgReserveCoverage: number
  avgCreConcentration: number
}

export type FdicNplSummary = {
  totalLoans: number
  totalNpl: number
  totalCre: number
  totalAssets: number
  avgNpl: number
  avgCreToAssets: number
  count: number
}

export type FdicScreeningPayload = {
  rows: FdicScreeningRow[]
  kpis: FdicScreeningKpis
  nplSummary: FdicNplSummary
  quarters: string[]
  quartersDisplay: string[]
  rawRowCount: number
}

export type FdicScreening = { meta: FdicMetaStamp; payload: FdicScreeningPayload }

export function loadScreening(scope: string): Promise<FdicScreening> {
  return apiGet<{ payload: FdicScreeningPayload }>(`${API_PREFIX}/screening?scope=${encodeURIComponent(scope)}`)
}

// ── /behavior-signals ───────────────────────────────────────────────────────

export type FdicSignalSummary = {
  cert: string
  name: string
  state: string
  quarter: string
  current: boolean
  quartersAvailable: number
  totalAssets: number
  grossLoans: number
  creLoans: number
  band: string
  measures: Record<string, number | null>
  fired: string[]
  unjudged: string[]
  actionCount: number
  pressureCount: number
  percentiles: Record<string, number | null>
}

export type FdicSignalCohort = {
  scope: string
  asOfQuarter: string
  institutionCount: number
  currentCount: number
  unjudgedCount: number
  summaries: FdicSignalSummary[]
}

export type FdicSignalsResult = {
  byCert: Map<string, FdicSignalSummary>
  institutionCount: number
  currentCount: number
  unjudgedCount: number
  firedCount: number
  largestResponseBytes: number
}

/**
 * The National cohort is 4,600 institutions and the whole-scope response is
 * ~3.9 MB, so for National the contract says to fetch per asset band (seven
 * calls of ≤0.6 MB each) and merge. A state fits in one call.
 */
export async function loadBehaviorSignals(scope: string, meta: FdicMeta): Promise<FdicSignalsResult> {
  const isNational = scope === meta.scopes.national
  const urls = isNational
    ? meta.assetBands.map((b) => `${API_PREFIX}/behavior-signals?scope=${encodeURIComponent(scope)}&band=${encodeURIComponent(b.key)}`)
    : [`${API_PREFIX}/behavior-signals?scope=${encodeURIComponent(scope)}`]

  const parts = await Promise.all(urls.map(async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    const text = await res.text()
    let body: any
    try { body = JSON.parse(text) } catch { throw new FdicError(res.status || 502, `Unexpected non-JSON response (HTTP ${res.status})`) }
    if (!res.ok || body?.ok !== true) throw new FdicError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
    return { cohort: body.cohort as FdicSignalCohort, bytes: text.length }
  }))

  const byCert = new Map<string, FdicSignalSummary>()
  let firedCount = 0, largest = 0
  for (const { cohort, bytes } of parts) {
    largest = Math.max(largest, bytes)
    for (const s of cohort.summaries) {
      byCert.set(s.cert, s)
      if (s.fired.length > 0) firedCount++
    }
  }
  // institutionCount / currentCount / unjudgedCount are scope-wide in every
  // band response (verified: all seven National bands carry 4,603 / 4,309 / 27),
  // so they are read once, not summed. Only the summaries are per band.
  const first = parts[0].cohort
  return {
    byCert,
    institutionCount: first.institutionCount,
    currentCount: first.currentCount,
    unjudgedCount: first.unjudgedCount,
    firedCount,
    largestResponseBytes: largest,
  }
}

// ── /institution/<cert> ─────────────────────────────────────────────────────

export type FdicTrendQuarter = {
  quarter: string
  label: string
  noncurrentPct: number | null
  nplPct: number | null
  leveragePct: number | null
  cet1Pct: number | null
  totalRbcPct: number | null
  creToCapitalPct: number | null
  constructionToCapitalPct: number | null
  reservePct: number | null
  roaPct: number | null
  nimPct: number | null
  capital: { category: string; label: string }
}

export type FdicRollForwardStep = {
  quarter: string
  label: string
  priorNonaccrual: number
  newNonaccrualProxy: number
  currentNonaccrual: number
  chargeOffs: number
  oreoTransferProxy: number
  unexplainedExit: number
  unexplainedExitPctOfCre: number
  unexplainedExitShareOfPrior: number
}

export type FdicInstitution = {
  meta: FdicMetaStamp
  cert: string
  trend: {
    cert: string
    name: string
    city: string
    state: string
    points: FdicTrendQuarter[]
    verdict: { tone: string; heading: string; text: string }
    leverageOnly: boolean
  }
  history: {
    cert: string
    acquisitions: Array<{ date: string; description: string; absorbedCert: string }>
    /** Set when the live FDIC history lookup failed; the list is then empty, not "none on record". */
    error?: string
  }
  /** Null only when the bank has a single quarter on file (nothing to judge). */
  behavior: null | {
    cert: string
    name: string
    state: string
    asOfQuarter: string
    points: Array<Record<string, number | string | null>>
    rollForward: FdicRollForwardStep[]
    latestByCategory: Array<{ category: string; label: string; step: FdicRollForwardStep }>
    signalsByQuarter: Array<{ quarter: string; label: string; fired: string[]; unjudged: string[] }>
    latest: FdicSignalSummary
    reading: { text: string; signals: string[] }
  }
  /** Present only when requested with ?include=narrative (an OpenAI call upstream). */
  narrative?: { text: string }
}

export function loadInstitution(cert: string, _opts: { narrative?: boolean } = {}): Promise<FdicInstitution> {
  // The narrative option was an OpenAI call inside Market Intelligence; there is no equivalent here.
  return apiGet<FdicInstitution>(`${API_PREFIX}/institution/${encodeURIComponent(cert)}`)
}

// ── Display helpers shared by the page and the drawer ───────────────────────

/** "20260630" → "Q2 2026". Also accepts ISO dates. */
export function formatQuarterLabel(dateString?: string): string {
  if (!dateString) return '—'
  if (/^\d{8}$/.test(dateString)) {
    const month = Number(dateString.slice(4, 6))
    return `Q${Math.ceil(month / 3)} ${dateString.slice(0, 4)}`
  }
  const parsed = new Date(dateString)
  if (Number.isNaN(parsed.getTime())) return dateString
  return `Q${Math.floor(parsed.getMonth() / 3) + 1} ${parsed.getFullYear()}`
}

export const FDIC_SOURCE_LABEL = 'Source: FDIC Call Reports, pulled directly from the FDIC BankFind API'
export const FDIC_UNAVAILABLE_TITLE = 'FDIC data not available'
