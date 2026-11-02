import { useEffect, useMemo, useState } from 'react'
import { Columns3, Gauge, GitCompare, Search } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { DefTerm } from '@/components/DefTerm'
import { BankStressDrawer } from '@/components/BankStressDrawer'
import { InstitutionProfileDrawer, type InstitutionProfileRow } from '@/components/InstitutionProfileDrawer'
import { KPI_EXPLANATION_NARRATIVE } from '@/lib/kpi-explanation'
import { formatPercent as formatPercentMetric, formatDeltaPercentPoints, formatMoney, formatMultiple } from '@/lib/metrics'
import { getCreCapitalColor } from '@/lib/score-colors'
import {
  loadBsMeta, loadBsRanking, formatQuarter, formatThousands, formatPct, formatScore, stressTone,
  BsError, TIER_LABEL, TIER_TONE, type BsMeta, type BsRankingRow,
} from '@/lib/bank-stress'
import {
  loadFdicMeta, loadScreening, loadBehaviorSignals, signalsByKey, formatQuarterLabel,
  type FdicMeta, type FdicScreeningRow, type FdicSignalsResult,
} from '@/lib/fdic-analytics'

/*
 * Bank Stress & FDIC Analytics — one page since 2 Nov 2026.
 *
 * The ranking (/api/bank-stress/ranking) is the spine: its filters decide
 * which banks are on screen, for any scored quarter. The former FDIC Data
 * Analytics page's figures (/api/fdic/screening, /api/fdic/behavior-signals)
 * are joined onto those rows by cert. Both read bank_stress.db; the FDIC
 * screening exists for the latest quarter only, so on an older quarter the
 * extra columns, cohort tiles, signals and compare view are switched off and
 * the page says so.
 */

type Region = 'southeast' | 'florida' | 'national' | 'custom'
type SortKey = 'rank' | 'composite' | 'condition' | 'deterioration' | 'cre_exposure' | 'flag_count' | 'cre_concentration' | 'assets_k' | 'name' | 'noncurrent_ratio' | 'tier1_leverage' | 'hfs' | 'hfs_change' | 'signals' | 'npl' | 'cre_loans'
type ColumnGroup = 'credit' | 'capital' | 'earnings' | 'book'

const COLUMN_GROUPS: Array<{ key: ColumnGroup; label: string; hint: string }> = [
  { key: 'credit', label: 'Credit quality', hint: 'NPL ($), NPL ratio, Noncurrent ($), past dues, reserve coverage' },
  { key: 'capital', label: 'Capital', hint: 'CET1, capital ratio used, CRE / (T1+T2), CRE / Equity, construction and multifamily / capital' },
  { key: 'earnings', label: 'Earnings', hint: 'ROA, ROA Δ, NI TTM, NI YoY %, NIM, NIM Δ, earnings buffer' },
  { key: 'book', label: 'Loan book', hint: 'Total loans, CRE loans, CRE / loans, unused commitments, CRE mix, 4-quarter CRE and NPL trend' },
]
const COLUMNS_STORAGE_KEY = 'bank-stress:columns'

function readColumnGroups(): Set<ColumnGroup> {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY)
    if (raw) return new Set(JSON.parse(raw) as ColumnGroup[])
  } catch { /* storage blocked — fall through to the default */ }
  return new Set<ColumnGroup>(['credit'])
}

/** Latest-quarter held-for-sale as % of loans, and its change over the four quarters shown ($K). */
function hfsLatest(r: BsRankingRow): number | null {
  return r.hfs_history?.[0]?.hfs_pct ?? null
}
function hfsChange(r: BsRankingRow): number | null {
  const h = r.hfs_history ?? []
  const newest = h[0]?.hfs_k, oldest = h[h.length - 1]?.hfs_k
  return newest != null && oldest != null && h.length > 1 ? newest - oldest : null
}

type Joined = { f: FdicScreeningRow | undefined; fired: string[] }

const SORT_VALUE: Record<SortKey, (r: BsRankingRow, j: Joined) => number | string> = {
  rank: (r) => r.rank ?? 1e9,
  hfs: (r) => hfsLatest(r) ?? -1,
  hfs_change: (r) => hfsChange(r) ?? -1e15,
  composite: (r) => r.composite ?? -1,
  condition: (r) => r.condition ?? -1,
  deterioration: (r) => r.deterioration ?? -1,
  cre_exposure: (r) => r.cre_exposure ?? -1,
  flag_count: (r) => r.flag_count,
  cre_concentration: (r) => r.cre_concentration ?? -1,
  assets_k: (r) => r.assets_k ?? -1,
  name: (r) => r.name,
  noncurrent_ratio: (r) => r.noncurrent_ratio ?? -1,
  tier1_leverage: (r) => r.tier1_leverage ?? 1e9,
  signals: (_r, j) => j.fired.length,
  npl: (_r, j) => j.f?.nonaccrualLoans ?? -1,
  cre_loans: (_r, j) => j.f?.creLoans ?? -1,
}

const PAGE = 150
const MAX_COMPARE = 10

// FDIC screening units (see lib/fdic-analytics.ts): ratios like nplRatio are fractions, creConcentration/cet1 are percents, money is dollars.
const fracPct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`)
const pctPct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`)
const money = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : formatMoney(v))
const ratio = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : formatMultiple(v))

/**
 * Loans held for sale over the latest four quarters: four small bars (oldest →
 * newest, scaled to the bank's own high), the latest balance with its share of
 * loans, the direction over the four quarters, and the troubled part in red.
 */
function HfsCell({ row }: { row: BsRankingRow }) {
  const pts = [...(row.hfs_history ?? [])].reverse() // oldest → newest
  if (!pts.length || pts.every((p) => p.hfs_k == null)) return <span className="text-slate-400">—</span>
  const max = Math.max(...pts.map((p) => p.hfs_k ?? 0), 1)
  const latest = pts[pts.length - 1]
  const change = hfsChange(row)
  const arrow = change == null || Math.abs(change) < 1 ? '→' : change > 0 ? '▲' : '▼'
  const tone = change == null || Math.abs(change) < 1 ? 'text-slate-500' : change > 0 ? 'text-red-700' : 'text-emerald-700'
  const title = pts.map((p) => `${formatQuarter(p.quarter)}: ${formatThousands(p.hfs_k)}${p.hfs_pct != null ? ` (${p.hfs_pct.toFixed(2)}% of loans)` : ''}${(p.troubled_k ?? 0) > 0 ? `, ${formatThousands(p.troubled_k)} troubled` : ''}`).join('\n')
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={title}>
      <span className="flex items-end gap-px h-4" aria-hidden>
        {pts.map((p) => (
          <span key={p.quarter} className={`inline-block w-1.5 rounded-sm ${p === latest ? 'bg-slate-700' : 'bg-slate-300'}`} style={{ height: `${Math.max(2, Math.round(((p.hfs_k ?? 0) / max) * 16))}px` }} />
        ))}
      </span>
      <span className="tabular-nums text-slate-800">{formatThousands(latest.hfs_k)}</span>
      {latest.hfs_pct != null && <span className="text-[10px] text-slate-500 tabular-nums">{latest.hfs_pct.toFixed(2)}%</span>}
      <span className={`text-[10px] ${tone}`}>{arrow}</span>
      {(latest.troubled_k ?? 0) > 0 && <span className="text-[10px] text-red-700 tabular-nums" title="90+ days past due or nonaccrual within held for sale">{formatThousands(latest.troubled_k)} troubled</span>}
    </div>
  )
}

export default function BankStress() {
  const [meta, setMeta] = useState<BsMeta | null>(null)
  const [metaError, setMetaError] = useState<{ status: number; message: string } | null>(null)
  const [quarter, setQuarter] = useState<string>('')
  const [band, setBand] = useState<string>('')
  const [region, setRegion] = useState<Region>('southeast')
  const [customStates, setCustomStates] = useState<string>('')
  const [tier, setTier] = useState<string>('')
  const [minScore, setMinScore] = useState<string>('')
  const [creOnly, setCreOnly] = useState(false)
  const [sellerOnly, setSellerOnly] = useState(false)
  const [signalOnly, setSignalOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<BsRankingRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDesc, setSortDesc] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [selected, setSelected] = useState<BsRankingRow | null>(null)
  // FDIC overlay (former FDIC Data Analytics page)
  const [fdicMeta, setFdicMeta] = useState<FdicMeta | null>(null)
  const [screening, setScreening] = useState<{ scope: string; byCert: Map<string, FdicScreeningRow> } | null>(null)
  const [screeningError, setScreeningError] = useState<string | null>(null)
  const [signals, setSignals] = useState<{ scope: string; result: FdicSignalsResult } | null>(null)
  const [signalsError, setSignalsError] = useState<string | null>(null)
  const [groups, setGroups] = useState<Set<ColumnGroup>>(readColumnGroups)
  const [showColumnsMenu, setShowColumnsMenu] = useState(false)
  const [compare, setCompare] = useState<FdicScreeningRow[]>([])
  const [compareOpen, setCompareOpen] = useState(false)

  useEffect(() => {
    let mounted = true
    loadBsMeta()
      .then((m) => { if (!mounted) return; setMeta(m); setQuarter(m.latest_quarter) })
      .catch((err) => { if (mounted) setMetaError({ status: err instanceof BsError ? err.status : 0, message: err instanceof Error ? err.message : String(err) }) })
    loadFdicMeta().then((m) => { if (mounted) setFdicMeta(m) }).catch((err) => { if (mounted) setScreeningError(err instanceof Error ? err.message : String(err)) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(Array.from(groups))) } catch { /* not persisted */ }
  }, [groups])

  const states = useMemo(() => {
    if (!meta) return []
    if (region === 'national') return []
    if (region === 'florida') return ['FL']
    if (region === 'southeast') return meta.definitions.deal_view.default_states
    return customStates.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s))
  }, [meta, region, customStates])

  const isLatest = !!meta && quarter === meta.latest_quarter
  // The FDIC routes take the same states as one comma-separated scope.
  const fdicScope = fdicMeta ? (states.length ? states.join(',') : fdicMeta.scopes.national) : null

  useEffect(() => {
    if (!meta || !quarter) return
    let mounted = true
    setLoading(true)
    setError(null)
    setShown(PAGE)
    const minScoreNum = minScore.trim() === '' ? undefined : Number(minScore)
    loadBsRanking({ quarter, band: band || undefined, states, tier: tier || undefined, min_score: minScoreNum, cre_only: creOnly, seller_only: sellerOnly })
      .then((res) => { if (mounted) setRows(res.rows) })
      .catch((err) => { if (mounted) { setRows(null); setError(err instanceof Error ? err.message : String(err)) } })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [meta, quarter, band, states, tier, minScore, creOnly, sellerOnly])

  // FDIC screening + balance-sheet signals for the region. They are an overlay:
  // if either fails, its columns say so and the ranking still renders.
  useEffect(() => {
    if (!fdicMeta || !fdicScope || !isLatest) return
    let mounted = true
    setScreeningError(null)
    setSignalsError(null)
    loadScreening(fdicScope)
      .then((res) => { if (mounted) setScreening({ scope: fdicScope, byCert: new Map(res.payload.rows.map((r) => [r.id, r])) }) })
      .catch((err) => { if (mounted) setScreeningError(err instanceof Error ? err.message : String(err)) })
    loadBehaviorSignals(fdicScope, fdicMeta)
      .then((s) => { if (mounted) setSignals({ scope: fdicScope, result: s }) })
      .catch((err) => { if (mounted) setSignalsError(err instanceof Error ? err.message : String(err)) })
    return () => { mounted = false }
  }, [fdicMeta, fdicScope, isLatest])

  // Only figures fetched for the scope on screen; never the previous region's.
  const fdicRows = isLatest && screening && screening.scope === fdicScope ? screening.byCert : null
  const fdicSignals = isLatest && signals && signals.scope === fdicScope ? signals.result : null
  const signalDefs = useMemo(() => signalsByKey(fdicMeta), [fdicMeta])

  const joined = useMemo(() => {
    const out = new Map<number, Joined>()
    for (const r of rows ?? []) {
      const cert = String(r.cert)
      out.set(r.cert, { f: fdicRows?.get(cert), fired: fdicSignals?.byCert.get(cert)?.fired ?? [] })
    }
    return out
  }, [rows, fdicRows, fdicSignals])

  const filtered = useMemo(() => {
    if (!rows) return []
    const q = search.trim().toUpperCase()
    let base = q ? rows.filter((r) => r.name.toUpperCase().includes(q) || String(r.cert) === q) : rows
    if (signalOnly && fdicSignals) base = base.filter((r) => (joined.get(r.cert)?.fired.length ?? 0) > 0)
    const val = SORT_VALUE[sortKey]
    const empty: Joined = { f: undefined, fired: [] }
    return [...base].sort((a, b) => {
      const av = val(a, joined.get(a.cert) ?? empty), bv = val(b, joined.get(b.cert) ?? empty)
      if (av < bv) return sortDesc ? 1 : -1
      if (av > bv) return sortDesc ? -1 : 1
      return (a.rank ?? 1e9) - (b.rank ?? 1e9)
    })
  }, [rows, search, sortKey, sortDesc, signalOnly, fdicSignals, joined])

  const summary = useMemo(() => {
    const t = { total: filtered.length, watchlist: 0, pressure: 0, sellers: 0, signalled: 0 }
    for (const r of filtered) {
      if (r.tier === 'watchlist') t.watchlist++
      if (r.tier === 'pressure') t.pressure++
      if (r.cre_seller_signal) t.sellers++
      if ((joined.get(r.cert)?.fired.length ?? 0) > 0) t.signalled++
    }
    return t
  }, [filtered, joined])

  // Cohort figures for exactly the banks in the table (the old page averaged the whole state instead).
  const cohort = useMemo(() => {
    if (!fdicRows) return null
    const fr = filtered.map((r) => joined.get(r.cert)?.f).filter((f): f is FdicScreeningRow => !!f)
    if (!fr.length) return null
    const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
    const mean = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
    const totalAssets = sum(fr.map((f) => f.totalAssets)), totalLoans = sum(fr.map((f) => f.totalLoans)), totalCre = sum(fr.map((f) => f.creLoans)), totalNpl = sum(fr.map((f) => f.nonaccrualLoans))
    return {
      count: fr.length, totalAssets, totalLoans, totalCre, totalNpl,
      nplPct: totalLoans > 0 ? (totalNpl / totalLoans) * 100 : null,
      creToAssetsPct: totalAssets > 0 ? (totalCre / totalAssets) * 100 : null,
      avgNoncurrent: mean(fr.map((f) => f.noncurrent_to_loans_ratio)),
      avgReserve: mean(fr.map((f) => f.loanLossReserve)),
      avgCreConc: mean(fr.map((f) => f.creConcentration)),
    }
  }, [fdicRows, filtered, joined])

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDesc((d) => !d)
    else { setSortKey(key); setSortDesc(key !== 'rank' && key !== 'name' && key !== 'tier1_leverage') }
  }

  function toggleGroup(g: ColumnGroup) {
    setGroups((prev) => { const next = new Set(prev); if (next.has(g)) next.delete(g); else next.add(g); return next })
  }

  function toggleCompare(f: FdicScreeningRow) {
    setCompare((prev) => prev.some((c) => c.id === f.id) ? prev.filter((c) => c.id !== f.id) : [...prev, f].slice(-MAX_COMPARE))
  }

  const defs = meta?.definitions
  const flagLabel = (id: string) => defs?.flags.find((f) => f.id === id)?.label ?? defs?.watch_flags.find((f) => f.id === id)?.label ?? id
  const bandLabel = (key: string | null) => defs?.peer_bands.find((b) => b.key === key)?.label ?? key ?? '—'
  const fdicOn = !!fdicRows
  const show = (g: ColumnGroup) => fdicOn && groups.has(g)

  // Sortable header. The label is the glossary key ("bank-stress:<label>") unless
  // a term is given (the FDIC columns keep the keys they had on their own page).
  const Th = ({ k, children, align = 'right', term }: { k: SortKey; children: string; align?: 'left' | 'right'; term?: string }) => (
    <th
      className={`py-2 px-2 font-medium text-slate-600 cursor-pointer select-none whitespace-nowrap ${align === 'left' ? 'text-left' : 'text-right'} ${sortKey === k ? 'text-slate-900' : ''}`}
      onClick={() => sortBy(k)}
    >
      <DefTerm term={term ?? `bank-stress:${children}`}>{children}</DefTerm>{sortKey === k ? (sortDesc ? ' ↓' : ' ↑') : ''}
    </th>
  )
  const Hd = ({ term, children, align = 'right' }: { term: string; children: string; align?: 'left' | 'right' }) => (
    <th className={`py-2 px-2 font-medium text-slate-600 whitespace-nowrap ${align === 'left' ? 'text-left' : 'text-right'}`}><DefTerm term={term}>{children}</DefTerm></th>
  )
  const td = 'py-1.5 px-2 text-right tabular-nums'

  const extraHeaders = (
    <>
      {show('credit') && <>
        <Th k="npl" term="NPL ($)">NPL ($)</Th>
        <Hd term="NPL Ratio">NPL ratio</Hd>
        <Hd term="Noncurrent ($)">NC ($)</Hd>
        <Hd term="Past Due 30-89 / Assets">PD 30-89 / A</Hd>
        <Hd term="Past Due 90+ / Assets">PD 90+ / A</Hd>
        <Hd term="Reserve Coverage">Reserve cov.</Hd>
      </>}
      {show('capital') && <>
        <Hd term="CET1">CET1</Hd>
        <Hd term="Capital Used" align="left">Cap used</Hd>
        <Hd term="CRE / (T1+T2)">CRE/(T1+T2)</Hd>
        <Hd term="CRE / Equity">CRE/Equity</Hd>
        <Hd term="Const / (T1+T2)">Const/(T1+T2)</Hd>
        <Hd term="MF / (T1+T2)">MF/(T1+T2)</Hd>
      </>}
      {show('earnings') && <>
        <Hd term="ROA (Latest)">ROA</Hd>
        <Hd term="ROA Δ (4Q)">ROA Δ4Q</Hd>
        <Hd term="Net Income (TTM)">NI TTM</Hd>
        <Hd term="Net Income YoY %">NI YoY%</Hd>
        <Hd term="NIM (Latest)">NIM</Hd>
        <Hd term="NIM Δ (4Q)">NIM Δ4Q</Hd>
        <Hd term="Earnings Buffer %">Earn buf%</Hd>
      </>}
      {show('book') && <>
        <Hd term="Total Loans">Total loans</Hd>
        <Th k="cre_loans" term="CRE Loans">CRE loans</Th>
        <Hd term="CRE Concentration">CRE / loans</Hd>
        <Hd term="Total UC">Total UC</Hd>
        <Hd term="CRE UC">CRE UC</Hd>
        <Hd term="CRE Mix" align="left">CRE mix</Hd>
        <Hd term="CRE Concentration (4Q)" align="left">CRE / loans (4Q)</Hd>
        <Hd term="NPL Ratio (4Q)" align="left">NPL ratio (4Q)</Hd>
      </>}
    </>
  )

  const extraCells = (f: FdicScreeningRow | undefined) => {
    const blank = (n: number) => Array.from({ length: n }).map((_, i) => <td key={i} className="py-1.5 px-2 text-right text-slate-400">—</td>)
    const cre = f?.creLoans
    const share = (v: number | undefined) => (cre ? pctPct(((v ?? 0) / cre) * 100) : '—')
    return (
      <>
        {show('credit') && (f ? <>
          <td className={`${td} font-medium text-amber-700`}>{money(f.nonaccrualLoans)}</td>
          <td className={td}>{fracPct(f.nplRatio)}</td>
          <td className={td}>{f.noncurrent_to_loans_ratio != null && f.totalLoans != null ? money(f.noncurrent_to_loans_ratio * f.totalLoans) : '—'}</td>
          <td className={td}>{fracPct(f.pastDue3090)}</td>
          <td className={td}>{fracPct(f.pastDue90Plus)}</td>
          <td className={td}>{fracPct(f.loanLossReserve)}</td>
        </> : blank(6))}
        {show('capital') && (f ? <>
          <td className={td}>{pctPct(f.cet1Ratio)}</td>
          <td className="py-1.5 px-2 text-slate-500" title={f.capitalCategory ? `${f.capitalCategory.label} — ${f.capitalCategory.binding}` : undefined}>{f.cet1Ratio ? 'CET1' : 'Leverage'}</td>
          <td className={`${td} ${getCreCapitalColor(f.capitalRatios?.creToTier1Tier2 ?? undefined)}`}>{ratio(f.capitalRatios?.creToTier1Tier2)}</td>
          <td className={`${td} ${getCreCapitalColor(f.capitalRatios?.creToEquity ?? undefined)}`}>{ratio(f.capitalRatios?.creToEquity)}</td>
          <td className={`${td} ${getCreCapitalColor(f.capitalRatios?.constructionToTier1Tier2 ?? undefined)}`}>{ratio(f.capitalRatios?.constructionToTier1Tier2)}</td>
          <td className={`${td} ${getCreCapitalColor(f.capitalRatios?.multifamilyToTier1Tier2 ?? undefined)}`}>{ratio(f.capitalRatios?.multifamilyToTier1Tier2)}</td>
        </> : blank(6))}
        {show('earnings') && (f ? <>
          <td className={td}>{f.roaLatest != null ? formatPercentMetric(f.roaLatest, 2) : '—'}</td>
          <td className={td}>{f.roaDelta4Q != null ? formatDeltaPercentPoints(f.roaDelta4Q, 2) : '—'}</td>
          <td className={td}>{money(f.netIncomeTTM)}</td>
          <td className={td}>{f.netIncomeYoYPct != null ? formatDeltaPercentPoints(f.netIncomeYoYPct, 1) : '—'}</td>
          <td className={td}>{f.nimLatest != null ? formatPercentMetric(f.nimLatest, 2) : '—'}</td>
          <td className={td}>{f.nimDelta4Q != null ? formatDeltaPercentPoints(f.nimDelta4Q, 2) : '—'}</td>
          <td className={td}>{f.earningsBufferPct != null ? formatPercentMetric(f.earningsBufferPct, 1) : '—'}</td>
        </> : blank(7))}
        {show('book') && (f ? <>
          <td className={td}>{money(f.totalLoans)}</td>
          <td className={td}>{money(f.creLoans)}</td>
          <td className={td}>{pctPct(f.creConcentration)}</td>
          <td className={td}>{money(f.totalUnusedCommitments)}</td>
          <td className={td}>{money(f.creUnusedCommitments)}</td>
          <td className="py-1.5 px-2 text-[10px] text-slate-500 whitespace-nowrap">C {share(f.constructionLoans)} · MF {share(f.multifamilyLoans)} · NR {share(f.nonResidentialLoans)}</td>
          <td className="py-1.5 px-2 text-[10px] text-slate-500 whitespace-nowrap" title={f.trend.map((e) => `${formatQuarterLabel(e.reportDate)}: ${pctPct(e.creConcentration)}`).join('\n')}>{[...f.trend].reverse().map((e) => pctPct(e.creConcentration, 0)).join(' → ')}</td>
          <td className="py-1.5 px-2 text-[10px] text-slate-500 whitespace-nowrap" title={f.trend.map((e) => `${formatQuarterLabel(e.reportDate)}: ${fracPct(e.nplRatio)}`).join('\n')}>{[...f.trend].reverse().map((e) => fracPct(e.nplRatio, 1)).join(' → ')}</td>
        </> : blank(8))}
      </>
    )
  }

  const extraCount = (show('credit') ? 6 : 0) + (show('capital') ? 6 : 0) + (show('earnings') ? 7 : 0) + (show('book') ? 8 : 0)
  const colCount = 17 + extraCount
  const compareCohort = useMemo(() => filtered.map((r) => joined.get(r.cert)?.f).filter((f): f is FdicScreeningRow => !!f), [filtered, joined])

  return (
    <div className="p-6 max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2"><Gauge className="h-6 w-6 text-slate-500" /> Bank Stress &amp; FDIC Analytics</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Banks under earnings, credit and commercial-real-estate pressure, ranked within their asset-size peer group, with their FDIC
            credit, capital, earnings and loan-book figures and what they did with their CRE book. The early signal for who will be selling
            distressed CRE loans. Source: FDIC Call Reports via the BankFind API, pulled directly every week.
          </p>
          {meta && (
            <p className="text-xs text-slate-500 mt-1">
              Data as of <span className="font-medium text-slate-700">{formatQuarter(meta.latest_quarter)}</span> ·
              computed {new Date(meta.computed_at).toLocaleString()} · {meta.banks_scored.toLocaleString()} banks ranked ·
              scores are percentile ranks within the peer band, higher = more stress · FDIC data is quarterly and lagged by 1–2 quarters
            </p>
          )}
        </div>
      </div>

      {metaError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">{metaError.status === 503 ? 'Bank stress ranking has not been computed yet' : 'Bank stress ranking unavailable'}</p>
          <p className="mt-1">{metaError.message}</p>
          <p className="mt-1 text-xs text-amber-800">No figures are shown until the weekly job has produced bank_stress.db.</p>
        </div>
      )}

      {meta && (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
            <label className="flex flex-col gap-1 text-xs text-slate-600">Quarter
              <select className="border rounded px-2 py-1 text-sm" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                {meta.quarters.map((q) => <option key={q} value={q}>{formatQuarter(q)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Region
              <select className="border rounded px-2 py-1 text-sm" value={region} onChange={(e) => setRegion(e.target.value as Region)}>
                <option value="southeast">Florida + Southeast ({meta.definitions.deal_view.default_states.join(', ')})</option>
                <option value="florida">Florida</option>
                <option value="national">National</option>
                <option value="custom">Pick states…</option>
              </select>
            </label>
            {region === 'custom' && (
              <label className="flex flex-col gap-1 text-xs text-slate-600">States (codes, comma-separated)
                <input className="border rounded px-2 py-1 text-sm w-48" placeholder="FL, GA, TX" value={customStates} onChange={(e) => setCustomStates(e.target.value)} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-xs text-slate-600">Peer band
              <select className="border rounded px-2 py-1 text-sm" value={band} onChange={(e) => setBand(e.target.value)}>
                <option value="">All bands</option>
                {meta.definitions.peer_bands.map((b) => <option key={b.key} value={b.key}>{b.label} ({meta.band_counts[b.key] ?? 0})</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Tier
              <select className="border rounded px-2 py-1 text-sm" value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">All tiers</option>
                <option value="pressure">Likely pressure (5+ flags)</option>
                <option value="watchlist">Watchlist (3–4 flags)</option>
                <option value="normal">Normal (0–2 flags)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">Min composite
              <input className="border rounded px-2 py-1 text-sm w-24" type="number" min={0} max={100} placeholder="0" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
            </label>
            <div className="flex flex-col gap-0.5 pb-0.5">
              <label className="flex items-center gap-2 text-xs text-slate-700" title={`CRE ≥ ${meta.definitions.deal_view.cre_concentration_min_pct}% of Tier 1 capital OR CRE loans ≥ ${formatThousands(meta.definitions.deal_view.cre_loans_min_k)}`}>
                <input type="checkbox" checked={creOnly} onChange={(e) => setCreOnly(e.target.checked)} /> Deal-sourcing view (CRE-heavy banks only)
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700" title="Flags 5 + 6 + 8 together: provisioning behind losses, CRE charge-offs rising, selling at a loss">
                <input type="checkbox" checked={sellerOnly} onChange={(e) => setSellerOnly(e.target.checked)} /> CRE seller signal only
              </label>
              <label className={`flex items-center gap-2 text-xs ${fdicSignals ? 'text-slate-700' : 'text-slate-400'}`} title="At least one of the seven balance-sheet behaviour signals fired in the latest quarter">
                <input type="checkbox" disabled={!fdicSignals} checked={signalOnly && !!fdicSignals} onChange={(e) => setSignalOnly(e.target.checked)} /> Balance-sheet signal fired only
              </label>
            </div>
            <div className="ml-auto flex items-end gap-2">
              <div className="relative">
                <button type="button" disabled={!fdicOn} onClick={() => setShowColumnsMenu((v) => !v)}
                  className="flex items-center gap-1.5 border rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <Columns3 className="h-3.5 w-3.5" /> Columns{groups.size ? ` (${groups.size})` : ''}
                </button>
                {showColumnsMenu && fdicOn && (
                  <div className="absolute right-0 top-full mt-1 z-20 w-80 rounded-md border border-slate-200 bg-white shadow-lg p-3 space-y-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">FDIC column groups</p>
                    {COLUMN_GROUPS.map((g) => (
                      <label key={g.key} className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                        <input type="checkbox" className="mt-0.5" checked={groups.has(g.key)} onChange={() => toggleGroup(g.key)} />
                        <span><span className="font-medium">{g.label}</span><span className="block text-[11px] text-slate-500">{g.hint}</span></span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" disabled={compare.length === 0} onClick={() => setCompareOpen(true)}
                className="flex items-center gap-1.5 border rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                title="Tick banks in the first column, then compare them side by side with peer positioning">
                <GitCompare className="h-3.5 w-3.5" /> Compare ({compare.length})
              </button>
              {compare.length > 0 && <button type="button" className="text-xs text-slate-500 underline pb-1" onClick={() => setCompare([])}>clear</button>}
              <label className="flex items-center gap-1 border rounded px-2 py-1 text-sm">
                <Search className="h-3.5 w-3.5 text-slate-400" />
                <input className="outline-none w-44 text-sm" placeholder="Bank name or cert" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            {[
              { label: 'Banks shown', value: summary.total.toLocaleString(), tone: 'text-slate-900' },
              { label: 'Watchlist (3–4 flags)', value: summary.watchlist.toLocaleString(), tone: 'text-amber-700' },
              { label: 'Likely pressure (5+ flags)', value: summary.pressure.toLocaleString(), tone: 'text-red-700' },
              { label: 'CRE seller signal', value: summary.sellers.toLocaleString(), tone: 'text-red-700' },
              { label: 'Balance-sheet signal fired', value: fdicSignals ? summary.signalled.toLocaleString() : '—', tone: 'text-amber-700' },
            ].map((t) => (
              <div key={t.label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
                <p className={`text-xl font-semibold tabular-nums ${t.tone}`}>{t.value}</p>
              </div>
            ))}
          </div>

          {isLatest && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 mb-4">
              {[
                { label: 'Total assets', term: 'Total Assets', value: cohort ? money(cohort.totalAssets) : '—' },
                { label: 'Total loans', term: 'Total Loans', value: cohort ? money(cohort.totalLoans) : '—' },
                { label: 'CRE loans', term: 'CRE Loans', value: cohort ? money(cohort.totalCre) : '—', sub: cohort ? `${pctPct(cohort.creToAssetsPct)} of assets` : undefined },
                { label: 'NPL ($)', term: 'NPL ($)', value: cohort ? money(cohort.totalNpl) : '—', sub: cohort ? `${pctPct(cohort.nplPct, 2)} of loans` : undefined, amber: true },
                { label: 'Avg NPL ratio', term: 'Avg NPL Ratio', value: cohort ? pctPct(cohort.nplPct, 2) : '—' },
                { label: 'Avg noncurrent / loans', term: 'Avg Noncurrent / Loans', value: cohort ? fracPct(cohort.avgNoncurrent) : '—' },
                { label: 'Avg reserve coverage', term: 'Avg Reserve Coverage', value: cohort ? fracPct(cohort.avgReserve) : '—' },
                { label: 'Avg CRE / loans', term: 'Avg CRE Concentration', value: cohort ? pctPct(cohort.avgCreConc) : '—' },
              ].map((t) => (
                <div key={t.label} className={`rounded-md border px-3 py-1.5 ${t.amber ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50/60'}`}>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500"><DefTerm term={t.term}>{t.label}</DefTerm></p>
                  <p className={`text-sm font-semibold tabular-nums ${t.amber ? 'text-amber-900' : 'text-slate-900'}`}>{t.value}</p>
                  {t.sub && <p className="text-[10px] text-slate-500 tabular-nums">{t.sub}</p>}
                </div>
              ))}
            </div>
          )}

          {!isLatest && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600 mb-3">
              FDIC cohort figures, extra columns, balance-sheet signals and the compare view cover the latest quarter ({formatQuarter(meta.latest_quarter)}) only; they come back when you select it.
            </div>
          )}
          {isLatest && (screeningError || signalsError) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 mb-3">
              {screeningError && <p>FDIC figures unavailable: {screeningError}</p>}
              {signalsError && <p>Balance-sheet signals unavailable: {signalsError}</p>}
            </div>
          )}
          {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-3">{error}</div>}

          <div className="rounded-md border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="py-2 pl-2 w-6" title="Tick to add to the compare view"><GitCompare className="h-3 w-3 text-slate-400" /></th>
                  <Th k="rank" align="left">#</Th>
                  <Th k="name" align="left">Bank</Th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600"><DefTerm term="bank-stress:Band">Band</DefTerm></th>
                  <Th k="composite">Composite</Th>
                  <Th k="condition">Condition</Th>
                  <Th k="deterioration">Deterior.</Th>
                  <Th k="cre_exposure">CRE</Th>
                  <Th k="flag_count">Flags</Th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600"><DefTerm term="bank-stress:Top drivers">Top drivers</DefTerm></th>
                  <th className="py-2 px-2 text-left font-medium text-slate-600"><DefTerm term="bank-stress:Signal">Signal</DefTerm></th>
                  <Th k="signals" align="left" term="Balance-Sheet Signals">Balance-sheet signals</Th>
                  <Th k="hfs" align="left">Held for sale (4Q)</Th>
                  <Th k="cre_concentration">CRE / T1</Th>
                  <Th k="noncurrent_ratio">Noncurr.</Th>
                  <Th k="tier1_leverage">T1 lev.</Th>
                  <Th k="assets_k">Assets</Th>
                  {extraHeaders}
                </tr>
              </thead>
              <tbody>
                {loading && !rows && Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={colCount} className="px-2 py-1.5"><Skeleton className="h-4 w-full" /></td></tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={colCount} className="px-3 py-6 text-center text-slate-500">No banks match these filters.</td></tr>
                )}
                {filtered.slice(0, shown).map((r) => {
                  const j = joined.get(r.cert)
                  const f = j?.f
                  const inCompare = !!f && compare.some((c) => c.id === f.id)
                  return (
                      <tr key={r.cert} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(r)}>
                        <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" disabled={!f} checked={inCompare} onChange={() => f && toggleCompare(f)} aria-label={`Compare ${r.name}`} />
                        </td>
                        <td className="py-1.5 px-2 tabular-nums text-slate-500">{r.rank ?? '—'}</td>
                        <td className="py-1.5 px-2">
                          <div className="font-medium text-slate-900">{r.name}</div>
                          <div className="text-[10px] text-slate-500">cert {r.cert} · {f?.city ? `${f.city}, ` : ''}{r.state ?? '—'}{r.hc_owned ? ' · HC-owned' : ''}{r.merger_quarter ? ' · merger qtr' : ''}{r.excluded_reason ? ` · ${r.excluded_reason.replace('_', ' ')}` : ''}</div>
                        </td>
                        <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{bandLabel(r.peer_band)}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums font-semibold rounded ${stressTone(r.composite)}`} title={`completeness ${formatPct(r.completeness, 0)}`}>{formatScore(r.composite)}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.condition)}`}>{formatScore(r.condition)}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.deterioration)}`}>{formatScore(r.deterioration)}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums ${stressTone(r.cre_exposure)}`}>{formatScore(r.cre_exposure)}</td>
                        <td className="py-1.5 px-2 text-right">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${TIER_TONE[r.tier]}`} title={[...r.flags, ...r.watch_flags].map(flagLabel).join('\n') || 'no flags'}>
                            {r.flag_count} · {TIER_LABEL[r.tier]}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-slate-600 max-w-[260px]">
                          {r.top_drivers.slice(0, 3).map((d) => (
                            <span key={d.id} className="inline-block mr-1 mb-0.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] whitespace-nowrap" title={`${d.label}: ${d.percentile.toFixed(0)}th percentile`}>{d.label} <span className="text-slate-400">{d.percentile.toFixed(0)}</span></span>
                          ))}
                        </td>
                        <td className="py-1.5 px-2">
                          {r.cre_seller_signal ? <span className="inline-block rounded bg-red-600 text-white px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap" title="Flags 5, 6 and 8 together">CRE seller</span> : null}
                        </td>
                        <td className="py-1.5 px-2">
                          {!isLatest || signalsError ? <span className="text-slate-300">—</span>
                            : !fdicSignals ? <Skeleton className="h-3 w-12" />
                            : (j?.fired.length ?? 0) === 0 ? <span className="text-slate-400">—</span>
                            : (
                              <div className="flex flex-wrap gap-1 max-w-[200px]">
                                {j!.fired.map((key) => {
                                  const def = signalDefs.get(key)
                                  return (
                                    <span key={key} title={def ? `${def.meaning}\n\n${def.rule}` : key}
                                      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap ${def?.side === 'pressure' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-sky-300 bg-sky-50 text-sky-900'}`}>
                                      {def?.label ?? key}
                                    </span>
                                  )
                                })}
                              </div>
                            )}
                        </td>
                        <td className="py-1.5 px-2"><HfsCell row={r} /></td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.cre_concentration, 0)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.noncurrent_ratio, 2)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatPct(r.tier1_leverage, 1)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{formatThousands(r.assets_k)}</td>
                        {extraCells(f)}
                      </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length > shown && (
              <div className="p-2 text-center border-t border-slate-100">
                <button className="text-xs text-slate-700 underline" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length.toLocaleString()}</button>
              </div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Click a row for the bank's full profile (scores, rule history, charts, FDIC capital detail, acquisitions, balance-sheet actions). Tick banks in the first column to compare them side by side.</p>

          <details className="mt-4 text-xs text-slate-600">
            <summary className="cursor-pointer font-medium text-slate-700">How the ranking and the figures are built</summary>
            <div className="mt-2 grid md:grid-cols-2 gap-4">
              <div>
                <p className="font-medium text-slate-800">Sub-scores and weights</p>
                <ul className="list-disc ml-4 mt-1 space-y-0.5">
                  {Object.entries(meta.definitions.components).map(([sub, comps]) => (
                    <li key={sub}><span className="capitalize font-medium">{sub.replace('_', ' ')}</span> ({Math.round((meta.definitions.weights[sub] ?? 0) * 100)}%): {comps.map((c) => c.label).join(', ')}</li>
                  ))}
                </ul>
                <p className="mt-2">Each component is its percentile within the peer band (higher = more stress). A sub-score is the mean of its available components; the composite re-weights the available sub-scores. Banks established in the last {meta.definitions.de_novo_years} years are shown but not ranked.</p>
                {fdicMeta && fdicMeta.signals.length > 0 && (
                  <>
                    <p className="font-medium text-slate-800 mt-3">Balance-sheet signals (latest quarter, not part of the score)</p>
                    <ul className="list-disc ml-4 mt-1 space-y-0.5">
                      {fdicMeta.signals.map((s) => <li key={s.key}><span className="font-medium">{s.label}</span> — {s.meaning}</li>)}
                    </ul>
                  </>
                )}
              </div>
              <div>
                <p className="font-medium text-slate-800">Flags (one point each)</p>
                <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                  {meta.definitions.flags.map((f) => <li key={f.id}><span className="font-medium">{f.label}</span> — {f.rule}</li>)}
                </ol>
                <p className="mt-2">Tiers: 0–2 normal, {meta.definitions.tiers.watchlist_min_flags}–{meta.definitions.tiers.pressure_min_flags - 1} watchlist, {meta.definitions.tiers.pressure_min_flags}+ likely pressure. Flags {meta.definitions.cre_seller_signal_flags.map((f) => f.replace('f', '')).join(' + ')} together = CRE seller signal. Watch flags (not counted): {meta.definitions.watch_flags.map((w) => w.label).join('; ')}.</p>
                <p className="font-medium text-slate-800 mt-3">Cohort figures</p>
                <p className="mt-1">The FDIC tiles add up or average the banks in the table, so they follow every filter. {KPI_EXPLANATION_NARRATIVE}</p>
              </div>
            </div>
          </details>
        </>
      )}

      <BankStressDrawer cert={selected?.cert ?? null} name={selected?.name} onClose={() => setSelected(null)} definitions={meta?.definitions ?? null} />

      <InstitutionProfileDrawer
        row={compareOpen ? (compare[0] as InstitutionProfileRow | undefined) ?? null : null}
        cohort={compareCohort as InstitutionProfileRow[]}
        asOfQuarter={meta ? formatQuarter(meta.latest_quarter) : 'Latest'}
        onClose={() => setCompareOpen(false)}
        compareRows={compareOpen ? (compare as InstitutionProfileRow[]) : []}
        onAddToCompare={(row) => setCompare((prev) => prev.some((c) => c.id === row.id) ? prev : [...prev, row as FdicScreeningRow].slice(-MAX_COMPARE))}
        onRemoveFromCompare={(id) => {
          const next = compare.filter((c) => c.id !== id)
          setCompare(next)
          if (next.length === 0) setCompareOpen(false)
        }}
        onClearCompare={() => setCompare([])}
      />
    </div>
  )
}
