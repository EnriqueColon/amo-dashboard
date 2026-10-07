/**
 * Client for this app's /api/mi/* routes, which mirror the Market Intelligence
 * analytics API 1:1 (see server/market-intelligence.ts and
 * docs/market-intelligence-meta.json for the contract).
 *
 * Everything on the FDIC Data Analytics page reads through here. The types
 * below are the subset of the contract the page and the drawer render; the
 * server passes bodies through untouched, so a field present upstream is
 * present here under the same name and in the same unit.
 *
 * Units, because they are easy to get wrong:
 *   nplRatio, noncurrent_to_*_ratio, pastDue*, loanLossReserve   fractions (0.0053)
 *   creConcentration, cet1Ratio, leverageRatio, roaLatest, nim*  percents  (40.3)
 *   kpis.avgNplRatio, kpis.avgReserveCoverage                     fractions
 *   kpis.avgNoncurrentToLoans, kpis.avgCreConcentration           percents
 *   nplSummary.avgNpl, nplSummary.avgCreToAssets                  percents
 *   dollar fields on rows                                         dollars
 *   behavior.* money fields and trend money fields                $ thousands (Call Report native)
 *   the three scores                                              percentile ranks 0–100 within the scope
 */

// ── Envelope ────────────────────────────────────────────────────────────────

export type MiMetaStamp = { quarter: string; scope: string; contractVersion: string; servedAt: string }

export class MiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'MiError'
    this.status = status
  }
  /** 401/503/502 mean the source is down or misconfigured, not that the user asked for something invalid. */
  get unavailable() {
    return this.status === 401 || this.status === 502 || this.status === 503 || this.status === 0
  }
}

async function miGet<T>(path: string): Promise<T & { meta: MiMetaStamp }> {
  let res: Response
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new MiError(0, err instanceof Error ? err.message : 'network error')
  }
  let body: any
  try {
    body = await res.json()
  } catch {
    throw new MiError(res.status || 502, `Unexpected non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok || !body || body.ok !== true) {
    throw new MiError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
  }
  return body as T & { meta: MiMetaStamp }
}

// ── /meta ───────────────────────────────────────────────────────────────────

export type MiSignalDef = {
  key: string
  label: string
  side: 'action' | 'pressure'
  meaning: string
  rule: string
}

export type MiAssetBand = { key: string; label: string; maxAssets: number | null }

export type MiMeta = {
  meta: MiMetaStamp & { apiVersion: string; source: string }
  scopes: { national: string; states: Record<string, string> }
  assetBands: MiAssetBand[]
  signals: MiSignalDef[]
  signalThresholds: Record<string, number>
  creCategoryLabels: Record<string, string>
  endpoints: Record<string, string>
  cache: { note: string }
}

let metaPromise: Promise<MiMeta> | null = null

/** One fetch per page load; both the page and the drawer need it. Failures are not memoised. */
export function loadMiMeta(): Promise<MiMeta> {
  if (!metaPromise) {
    metaPromise = miGet<MiMeta>('/api/mi/meta').catch((err) => {
      metaPromise = null
      throw err
    })
  }
  return metaPromise
}

export function signalsByKey(meta: MiMeta | null): Map<string, MiSignalDef> {
  return new Map((meta?.signals ?? []).map((s) => [s.key, s]))
}

/** "FLORIDA" → "FL" using meta.scopes.states; falls back to the input. */
export function stateCodeFor(meta: MiMeta | null, stateName: string | undefined): string | undefined {
  if (!stateName || !meta) return stateName
  const upper = stateName.toUpperCase()
  if (upper.length === 2 && meta.scopes.states[upper]) return upper
  for (const [code, name] of Object.entries(meta.scopes.states)) {
    if (name.toUpperCase() === upper) return code
  }
  return stateName
}

// ── /screening ──────────────────────────────────────────────────────────────

export type MiCapitalCategory = { category: string; label: string; binding: string; basis: string }

export type MiCapitalRatios = {
  creToTier1Tier2: number | null
  creToEquity: number | null
  constructionToTier1Tier2: number | null
  multifamilyToTier1Tier2: number | null
}

export type MiTrendPoint = { reportDate: string; creConcentration?: number; nplRatio?: number }

export type MiScreeningRow = {
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
  capitalCategory?: MiCapitalCategory
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
  capitalRatios?: MiCapitalRatios
  trend: MiTrendPoint[]
  opportunityScore: number
  earningsScore: number
  vulnerabilityScore: number
}

export type MiScreeningKpis = {
  institutionsScreened: number
  avgNplRatio: number
  avgNoncurrentToLoans: number
  avgReserveCoverage: number
  avgCreConcentration: number
}

export type MiNplSummary = {
  totalLoans: number
  totalNpl: number
  totalCre: number
  totalAssets: number
  avgNpl: number
  avgCreToAssets: number
  count: number
}

export type MiScreeningPayload = {
  rows: MiScreeningRow[]
  kpis: MiScreeningKpis
  nplSummary: MiNplSummary
  quarters: string[]
  quartersDisplay: string[]
  rawRowCount: number
}

export type MiScreening = { meta: MiMetaStamp; payload: MiScreeningPayload }

export function loadScreening(scope: string): Promise<MiScreening> {
  return miGet<{ payload: MiScreeningPayload }>(`/api/mi/screening?scope=${encodeURIComponent(scope)}`)
}

// ── /behavior-signals ───────────────────────────────────────────────────────

export type MiSignalSummary = {
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

export type MiSignalCohort = {
  scope: string
  asOfQuarter: string
  institutionCount: number
  currentCount: number
  unjudgedCount: number
  summaries: MiSignalSummary[]
}

export type MiSignalsResult = {
  byCert: Map<string, MiSignalSummary>
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
export async function loadBehaviorSignals(scope: string, meta: MiMeta): Promise<MiSignalsResult> {
  const isNational = scope === meta.scopes.national
  const urls = isNational
    ? meta.assetBands.map((b) => `/api/mi/behavior-signals?scope=${encodeURIComponent(scope)}&band=${encodeURIComponent(b.key)}`)
    : [`/api/mi/behavior-signals?scope=${encodeURIComponent(scope)}`]

  const parts = await Promise.all(urls.map(async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    const text = await res.text()
    let body: any
    try { body = JSON.parse(text) } catch { throw new MiError(res.status || 502, `Unexpected non-JSON response (HTTP ${res.status})`) }
    if (!res.ok || body?.ok !== true) throw new MiError(res.status, typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
    return { cohort: body.cohort as MiSignalCohort, bytes: text.length }
  }))

  const byCert = new Map<string, MiSignalSummary>()
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

export type MiTrendQuarter = {
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

export type MiRollForwardStep = {
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

export type MiInstitution = {
  meta: MiMetaStamp
  cert: string
  trend: {
    cert: string
    name: string
    city: string
    state: string
    points: MiTrendQuarter[]
    verdict: { tone: string; heading: string; text: string }
    leverageOnly: boolean
  }
  history: {
    cert: string
    acquisitions: Array<{ date: string; description: string; absorbedCert: string }>
  }
  behavior: {
    cert: string
    name: string
    state: string
    asOfQuarter: string
    points: Array<Record<string, number | string | null>>
    rollForward: MiRollForwardStep[]
    latestByCategory: Array<{ category: string; label: string; step: MiRollForwardStep }>
    signalsByQuarter: Array<{ quarter: string; label: string; fired: string[]; unjudged: string[] }>
    latest: MiSignalSummary
    reading: { text: string; signals: string[] }
  }
  /** Present only when requested with ?include=narrative (an OpenAI call upstream). */
  narrative?: { text: string }
}

export function loadInstitution(cert: string, opts: { narrative?: boolean } = {}): Promise<MiInstitution> {
  const qs = opts.narrative ? '?include=narrative' : ''
  return miGet<MiInstitution>(`/api/mi/institution/${encodeURIComponent(cert)}${qs}`)
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

export const MI_SOURCE_LABEL = 'Source: FDIC Call Report via Market Intelligence'
export const MI_UNAVAILABLE_TITLE = 'Market Intelligence unavailable'
