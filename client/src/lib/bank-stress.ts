/**
 * Client for /api/bank-stress/* (server/bank-stress.ts), which reads the
 * bank_stress.db that collector/bank_stress computes weekly from the FDIC
 * BankFind API. Every number here traces to a Call Report field; the formulas
 * are in collector/bank_stress/README.md and arrive at runtime in
 * meta.definitions so the UI never hardcodes a label or a threshold.
 *
 * Units: scores and percentiles 0–100 (higher = more stress); metrics ending
 * in _ratio / _share / concentration / leverage are percent units (5.0 = 5%);
 * provision_coverage is a multiple; *_k fields are $ thousands.
 */

export type BsMetricDef = { key: string; label: string; unit: 'pct' | 'x' | 'usd_k'; stress_when: 'high' | 'low' | null; group: string; formula: string }
export type BsComponentDef = { id: string; label: string; metric: string; feature: 'level' | 'qoq' | 'yoy' | 'slope' }
export type BsFlagDef = { id: string; label: string; rule?: string }
export type BsBand = { key: string; label: string; max_assets_k: number | null }

export type BsDefinitions = {
  metrics: BsMetricDef[]
  components: Record<string, BsComponentDef[]>
  weights: Record<string, number>
  flags: BsFlagDef[]
  watch_flags: BsFlagDef[]
  tiers: { watchlist_min_flags: number; pressure_min_flags: number }
  cre_seller_signal_flags: string[]
  peer_bands: BsBand[]
  deal_view: { cre_concentration_min_pct: number; cre_loans_min_k: number; default_states: string[] }
  de_novo_years: number
}

export type BsMeta = {
  ok: true
  computed_at: string
  fetched_at: string | null
  latest_quarter: string
  quarters: string[]
  scored_quarters: string[]
  banks_scored: number
  detail: string
  states: string[]
  tiers: Record<string, number>
  band_counts: Record<string, number>
  cre_seller_signal_count: number
  definitions: BsDefinitions
}

export type BsDriver = { id: string; label: string; percentile: number; value: number | null }

export type BsRankingRow = {
  rank: number | null
  rank_in_band: number | null
  cert: number
  name: string
  state: string | null
  peer_band: string | null
  assets_k: number | null
  hc_owned: 0 | 1
  excluded_reason: string | null
  condition: number | null
  deterioration: number | null
  cre_exposure: number | null
  composite: number | null
  completeness: number
  flag_count: number
  flags: string[]
  watch_flags: string[]
  tier: 'normal' | 'watchlist' | 'pressure'
  cre_seller_signal: 0 | 1
  top_drivers: BsDriver[]
  cohort_size: number
  band_size: number
  cre_concentration: number | null
  construction_concentration: number | null
  cre_loans_k: number | null
  noncurrent_ratio: number | null
  tier1_leverage: number | null
  roa: number | null
  efficiency_ratio: number | null
  loan_to_deposit: number | null
  reserve_coverage: number | null
  merger_quarter: 0 | 1 | null
}

export type BsHistoryRow = Omit<BsRankingRow, 'cert' | 'name' | 'state' | 'hc_owned'> & {
  repdte: string
  components: Record<string, number | null>
  [metric: string]: unknown
}

export type BsBankDetail = {
  ok: true
  computed_at: string
  bank: { cert: number; name: string; state: string | null; hc_name: string | null; hc_owned: 0 | 1; estymd: number | null; cblr: number | null; assets_k: number | null; city?: string; bkclass?: string; active?: number }
  failure: { faildate: string; restype: string } | null
  aom_canonical_names: string[]
  history: BsHistoryRow[] // oldest → newest
}

export class BsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new BsError(0, err instanceof Error ? err.message : 'network error')
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new BsError(res.status, `non-JSON response (HTTP ${res.status})`)
  }
  const b = body as { ok?: boolean; error?: string }
  if (!res.ok || b.ok !== true) throw new BsError(res.status, b.error ?? `HTTP ${res.status}`)
  return body as T
}

export function loadBsMeta(): Promise<BsMeta> {
  return getJson<BsMeta>('/api/bank-stress/meta')
}

export type BsRankingParams = {
  quarter?: string
  band?: string
  states?: string[]
  min_score?: number
  tier?: string
  cre_only?: boolean
  seller_only?: boolean
  include_excluded?: boolean
  search?: string
}

export function loadBsRanking(p: BsRankingParams): Promise<{ ok: true; quarter: string; computed_at: string; total: number; rows: BsRankingRow[] }> {
  const q = new URLSearchParams()
  if (p.quarter) q.set('quarter', p.quarter)
  if (p.band) q.set('band', p.band)
  if (p.states?.length) q.set('states', p.states.join(','))
  if (p.min_score !== undefined && Number.isFinite(p.min_score)) q.set('min_score', String(p.min_score))
  if (p.tier) q.set('tier', p.tier)
  if (p.cre_only) q.set('cre_only', '1')
  if (p.seller_only) q.set('seller_only', '1')
  if (p.include_excluded) q.set('include_excluded', '1')
  if (p.search) q.set('search', p.search)
  const qs = q.toString()
  return getJson(`/api/bank-stress/ranking${qs ? `?${qs}` : ''}`)
}

export function loadBsBank(cert: number | string): Promise<BsBankDetail> {
  return getJson<BsBankDetail>(`/api/bank-stress/bank/${encodeURIComponent(String(cert))}`)
}

/** '20260630' → 'Q2 2026' */
export function formatQuarter(repdte: string | null | undefined): string {
  if (!repdte || repdte.length !== 8) return '—'
  const q = Math.floor((Number(repdte.slice(4, 6)) - 1) / 3) + 1
  return `Q${q} ${repdte.slice(0, 4)}`
}

/** Call Report $ thousands → "$1.2B" */
export function formatThousands(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v) * 1000
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  return `${sign}$${(abs / 1e3).toFixed(0)}K`
}

export function formatPct(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(decimals)}%`
}

export function formatScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(1)
}

/** Tailwind classes for a 0–100 stress score (higher = more stress). */
export function stressTone(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'text-slate-400'
  if (score >= 75) return 'bg-red-100 text-red-900'
  if (score >= 60) return 'bg-amber-100 text-amber-900'
  if (score >= 45) return 'bg-slate-100 text-slate-800'
  return 'bg-emerald-50 text-emerald-900'
}

export const TIER_LABEL: Record<string, string> = { normal: 'Normal', watchlist: 'Watchlist', pressure: 'Likely pressure' }
export const TIER_TONE: Record<string, string> = {
  normal: 'border-slate-200 bg-slate-50 text-slate-600',
  watchlist: 'border-amber-200 bg-amber-50 text-amber-800',
  pressure: 'border-red-200 bg-red-50 text-red-800',
}
