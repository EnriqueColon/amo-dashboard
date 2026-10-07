import { useEffect, useMemo, useState } from 'react'
import { Columns3, LineChart } from 'lucide-react'
import { KPI_EXPLANATION_NARRATIVE } from '@/lib/kpi-explanation'
import {
  formatPercent as formatPercentMetric,
  formatDeltaPercentPoints,
  formatMoney,
  formatMultiple as formatMultipleMetric,
} from '@/lib/metrics'
import { getCreCapitalColor, getScoreColor } from '@/lib/score-colors'
import { DefTerm } from '@/components/DefTerm'
import { InstitutionProfileDrawer, type InstitutionProfileRow } from '@/components/InstitutionProfileDrawer'
import { Skeleton } from '@/components/ui/skeleton'
import { FilterHint } from '@/components/FilterHint'
import { FDIC_SCOPE_DEF } from '@/lib/filterDefinitions'
import {
  loadMiMeta, loadScreening, loadBehaviorSignals, signalsByKey, stateCodeFor,
  formatQuarterLabel, MiError, MI_SOURCE_LABEL, MI_UNAVAILABLE_TITLE,
  type MiMeta, type MiScreeningPayload, type MiScreeningRow, type MiSignalsResult,
} from '@/lib/market-intelligence'

// Shown until /meta answers, so the control is never empty. The live list
// (meta.scopes.states, which includes DC and PR) replaces it on load.
const FALLBACK_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
  'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
  'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire',
  'New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio',
  'Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota',
  'Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia',
  'Wisconsin','Wyoming',
]
const NATIONAL = 'National'

type SortKey = 'opportunity' | 'earnings' | 'vulnerability' | 'npl' | 'cre'

const SORT_VALUE: Record<SortKey, (r: MiScreeningRow) => number> = {
  opportunity: (r) => r.opportunityScore ?? 0,
  earnings: (r) => r.earningsScore ?? 0,
  vulnerability: (r) => r.vulnerabilityScore ?? 0,
  npl: (r) => r.nonaccrualLoans ?? 0,
  cre: (r) => r.creConcentration ?? 0,
}

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })

function formatCurrency(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '—'
  return currencyFormatter.format(value)
}

function formatPercent(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '—'
  return percentFormatter.format(value / 100)
}

function formatNumber(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('en-US').format(value)
}

function formatRatio(value: number | null | undefined) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  return formatMultipleMetric(value)
}

function formatScore(value: number | null | undefined) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(1)
}

export default function MarketAnalytics() {
  const [region, setRegion] = useState<string>('Florida')
  const [showCapitalColumns, setShowCapitalColumns] = useState(false)
  const [showEarningsColumns, setShowEarningsColumns] = useState(false)
  const [showColumnsMenu, setShowColumnsMenu] = useState(false)
  const [tableSortColumn, setTableSortColumn] = useState<SortKey>('opportunity')
  const [tableSortDesc, setTableSortDesc] = useState(true)
  const [selectedInstitution, setSelectedInstitution] = useState<MiScreeningRow | null>(null)
  const [compareRows, setCompareRows] = useState<MiScreeningRow[]>([])
  const [loading, setLoading] = useState(false)
  const [meta, setMeta] = useState<MiMeta | null>(null)
  // The payload and the scope it was fetched for travel together, so nothing
  // downstream can pair a new region with the previous region's rows.
  const [screening, setScreening] = useState<{ scope: string; payload: MiScreeningPayload } | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [signals, setSignals] = useState<MiSignalsResult | null>(null)
  const [signalsError, setSignalsError] = useState<string | undefined>()
  const [error, setError] = useState<{ title: string; detail: string } | undefined>()

  // /meta once: scope list, signal vocabulary, state-code lookup.
  useEffect(() => {
    let mounted = true
    loadMiMeta().then((m) => { if (mounted) setMeta(m) }).catch(() => { /* surfaced by the screening fetch below */ })
    return () => { mounted = false }
  }, [])

  // Screening is the page. A failure clears every number — the page must not
  // keep showing figures from a previous scope or a previous load.
  useEffect(() => {
    let mounted = true
    async function loadData() {
      setLoading(true)
      setError(undefined)
      setScreening(null)
      setSignals(null) // the old scope's signal counts must not sit under the new heading
      setSignalsError(undefined)
      setAsOf(null)
      setSelectedInstitution(null)
      setCompareRows([])
      try {
        const res = await loadScreening(region)
        if (!mounted) return
        setScreening({ scope: region, payload: res.payload })
        setAsOf(res.meta.quarter)
      } catch (err) {
        if (!mounted) return
        const mi = err instanceof MiError ? err : null
        setError({
          title: mi && !mi.unavailable ? 'Could not load screening' : MI_UNAVAILABLE_TITLE,
          detail: mi ? mi.message : (err instanceof Error ? err.message : String(err)),
        })
      } finally {
        if (mounted) setLoading(false)
      }
    }
    loadData()
    return () => { mounted = false }
  }, [region])

  // Balance-sheet signals are an overlay on the table: if they fail, the
  // Signals column says so, but the screening still renders.
  useEffect(() => {
    // Wait for the screening of *this* region, not the one still on screen
    // from the previous region — otherwise the band calls fire twice.
    if (!meta || !screening || screening.scope !== region) return
    let mounted = true
    setSignals(null)
    setSignalsError(undefined)
    loadBehaviorSignals(region, meta)
      .then((s) => { if (mounted) setSignals(s) })
      .catch((err) => { if (mounted) setSignalsError(err instanceof Error ? err.message : String(err)) })
    return () => { mounted = false }
  }, [meta, screening, region])

  const signalDefs = useMemo(() => signalsByKey(meta), [meta])

  const scopeOptions = useMemo(() => {
    if (meta) {
      const states = Object.values(meta.scopes.states).sort((a, b) => a.localeCompare(b))
      return { national: meta.scopes.national, states }
    }
    return { national: NATIONAL, states: FALLBACK_STATES }
  }, [meta])

  // Only show figures that belong to the selected scope — while a new scope is
  // loading, the previous scope's numbers must not sit under the new label.
  const payload = screening && screening.scope === region ? screening.payload : null
  const rows = payload?.rows ?? []

  const sortedScreeningTable = useMemo(() => {
    const value = SORT_VALUE[tableSortColumn]
    // Stable sort over API order, so ties keep the order Market Intelligence returned.
    return [...rows].sort((a, b) => tableSortDesc ? value(b) - value(a) : value(a) - value(b))
  }, [rows, tableSortColumn, tableSortDesc])

  const kpis = useMemo(() => {
    const k = payload?.kpis
    if (!k) return [
      { label: 'Institutions Screened', value: '—' },
      { label: 'Avg NPL Ratio', value: '—' },
      { label: 'Avg Noncurrent / Loans', value: '—' },
      { label: 'Avg Reserve Coverage', value: '—' },
      { label: 'Avg CRE Concentration', value: '—' },
    ]
    return [
      { label: 'Institutions Screened', value: formatNumber(k.institutionsScreened) },
      { label: 'Avg NPL Ratio', value: formatPercent(k.avgNplRatio * 100) },
      { label: 'Avg Noncurrent / Loans', value: formatPercent(k.avgNoncurrentToLoans) },
      { label: 'Avg Reserve Coverage', value: formatPercent(k.avgReserveCoverage * 100) },
      { label: 'Avg CRE Concentration', value: formatPercent(k.avgCreConcentration) },
    ]
  }, [payload])

  const nplLoansSummary = payload?.nplSummary ?? null
  const asOfQuarter = asOf ? formatQuarterLabel(asOf) : 'Latest'
  const regionDisplay = region === scopeOptions.national ? 'United States' : region

  const cohortNote = useMemo(() => {
    if (!payload || rows.length === 0) return null
    const count = rows.length.toLocaleString('en-US')
    const total = payload.kpis.institutionsScreened
    const base = total > rows.length
      ? `Screening ${count} of the ${total.toLocaleString('en-US')} FDIC-reporting institutions Market Intelligence covers in ${regionDisplay}`
      : `Screening all ${count} FDIC-reporting institutions in ${regionDisplay}`
    return `${base}. Scores are percentile ranks within this scope, and peer percentiles in the profile drawer are relative to this cohort.`
  }, [payload, rows.length, regionDisplay])

  const signalsNote = useMemo(() => {
    if (!payload) return null // payload is scope-gated; nothing from the previous scope may show
    if (signalsError) return `Balance-sheet signals unavailable: ${signalsError}`
    if (!signals) return null
    return `${signals.firedCount.toLocaleString('en-US')} of ${signals.currentCount.toLocaleString('en-US')} institutions fired at least one balance-sheet signal in ${asOfQuarter}.`
  }, [payload, signals, signalsError, asOfQuarter])

  const sortButton = (col: { label: string; term: string; sortKey?: SortKey }) => col.sortKey ? (
    <button type="button" className="cursor-pointer border-b border-dashed border-muted-foreground/50 hover:opacity-80 text-left font-normal flex items-center gap-1 text-xs"
      onClick={() => { setTableSortColumn(col.sortKey!); setTableSortDesc((prev) => tableSortColumn === col.sortKey ? !prev : true) }}>
      <DefTerm term={col.term}>{col.label}</DefTerm>
      {tableSortColumn === col.sortKey ? (tableSortDesc ? ' ↓' : ' ↑') : ''}
    </button>
  ) : (
    <DefTerm term={col.term}>{col.label}</DefTerm>
  )

  return (
    <div className="p-6 space-y-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <LineChart size={20} className="text-primary" />
            <h1 className="text-xl font-semibold">FDIC Data Analytics</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Bank screening, scores and balance-sheet signals from FDIC Call Report data.
          </p>
          <p className="text-xs text-muted-foreground">
            {asOf ? <>Data as of <span className="font-medium text-foreground">{asOfQuarter}</span> · </> : null}
            {MI_SOURCE_LABEL}. FDIC data is quarterly and lagged by 1–2 quarters.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-card border border-border rounded-lg p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Controls</p>
        <div className="flex flex-wrap gap-3 items-center">
          <FilterHint def={FDIC_SCOPE_DEF}>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground w-48"
            >
              <option value={scopeOptions.national}>United States</option>
              {scopeOptions.states.map((state) => <option key={state} value={state}>{state}</option>)}
            </select>
          </FilterHint>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColumnsMenu((v) => !v)}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
            >
              <Columns3 size={15} />
              Columns
            </button>
            {showColumnsMenu && (
              <div className="absolute top-full mt-1 left-0 z-20 w-80 rounded-lg border border-border bg-card shadow-lg p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground">Capital ratio columns</p>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={showCapitalColumns} onChange={(e) => setShowCapitalColumns(e.target.checked)} className="rounded" />
                  CRE / (T1+T2), CRE / Equity, Const / Capital, MF / Capital
                </label>
                <p className="text-xs font-semibold text-muted-foreground pt-1">Earnings columns</p>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={showEarningsColumns} onChange={(e) => setShowEarningsColumns(e.target.checked)} className="rounded" />
                  ROA, ROA Δ, NI TTM, NI YoY %, NIM, NIM Δ, Earnings Buffer %
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium">Loading Market Intelligence screening for {regionDisplay}…</p>
          <div className="space-y-2">
            {[1,2,3].map((i) => <Skeleton key={i} className="h-4 rounded" />)}
          </div>
        </div>
      )}
      {error && (
        <div className="bg-card border border-destructive/40 rounded-lg p-4 text-sm" role="alert">
          <p className="font-semibold text-destructive">{error.title}</p>
          <p className="text-muted-foreground mt-1">{error.detail}</p>
          <p className="text-xs text-muted-foreground mt-2">No figures are shown until the source answers; nothing on this page is cached locally.</p>
        </div>
      )}

      {/* NPL Summary */}
      {nplLoansSummary && (
        <div className="bg-card border-2 border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-base font-semibold mb-1">NPL & Loans</h2>
          <p className="text-sm text-muted-foreground mb-4">Nonperforming loan metrics for {regionDisplay}. Dollar values from FDIC call reports ({asOfQuarter}).</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'Total Loans', value: loading ? '…' : formatMoney(nplLoansSummary.totalLoans), sub: 'Net loans & leases' },
              { label: 'Avg NPL Ratio', value: loading ? '…' : formatPercent(nplLoansSummary.avgNpl), sub: 'Nonaccrual ÷ total loans' },
              { label: 'NPL ($)', value: loading ? '…' : formatMoney(nplLoansSummary.totalNpl), sub: 'Total nonaccrual loans', amber: true },
              { label: 'CRE Loans', value: loading ? '…' : formatMoney(nplLoansSummary.totalCre), sub: 'Constr + MF + Non-res + Other' },
              { label: 'CRE / Assets', value: loading ? '…' : formatPercent(nplLoansSummary.avgCreToAssets), sub: 'CRE as % of total assets' },
              { label: 'Total Assets', value: loading ? '…' : formatMoney(nplLoansSummary.totalAssets), sub: `${nplLoansSummary.count} institutions` },
            ].map((kpi) => (
              <div key={kpi.label} className={`p-4 rounded-lg border ${kpi.amber ? 'bg-amber-50 border-amber-200' : 'bg-muted/30 border-border'} min-w-0`}>
                <p className={`text-xs font-medium uppercase tracking-wide ${kpi.amber ? 'text-amber-800' : 'text-muted-foreground'}`}>{kpi.label}</p>
                <p className={`text-sm font-semibold mt-1 tabular-nums ${kpi.amber ? 'text-amber-900' : 'text-foreground'}`}>{kpi.value}</p>
                <p className={`text-xs mt-0.5 ${kpi.amber ? 'text-amber-700' : 'text-muted-foreground'}`}>{kpi.sub}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cohort Summary */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-base font-semibold mb-1">Cohort Summary</h3>
        <p className="text-xs text-muted-foreground mb-4">Average metrics for {regionDisplay} as of {asOfQuarter}. FDIC data is quarterly and lagged.</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="p-3 bg-background border border-border rounded-lg">
              <p className="text-xs font-medium text-muted-foreground"><DefTerm term={kpi.label}>{kpi.label}</DefTerm></p>
              <p className="text-lg font-semibold text-foreground">{loading ? '…' : kpi.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">{KPI_EXPLANATION_NARRATIVE}</p>
      </div>

      {/* Target Screening Table */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-base font-semibold mb-1">Target Screening List</h3>
            <p className="text-xs text-muted-foreground">
              Bank-level screening ranked by Opportunity Score, with Earnings and Vulnerability scores, NPL (nonaccrual loans in dollars), CRE loans and CRE concentration. Click any underlined header to sort.
            </p>
            {cohortNote && !loading && (
              <p className="mt-1 text-xs text-muted-foreground">{cohortNote}</p>
            )}
            {signalsNote && !loading && (
              <p className="mt-1 text-xs text-muted-foreground">{signalsNote}</p>
            )}
          </div>
          {!loading && rows.length > 0 && (
            <select
              value={selectedInstitution ? `${selectedInstitution.id}-${selectedInstitution.reportDate ?? ''}` : '__none__'}
              onChange={(e) => {
                if (e.target.value === '__none__') { setSelectedInstitution(null); return }
                const row = sortedScreeningTable.find((r) => `${r.id}-${r.reportDate ?? ''}` === e.target.value)
                if (row) {
                  setSelectedInstitution(row)
                  const key = `${row.id}-${row.reportDate ?? ''}`
                  setCompareRows((prev) => prev.some((r) => `${r.id}-${r.reportDate ?? ''}` === key) ? prev : [row, ...prev])
                }
              }}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground w-64"
            >
              <option value="__none__">Jump to institution…</option>
              {[...sortedScreeningTable].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((item) => (
                <option key={`${item.id}-${item.reportDate ?? 'na'}`} value={`${item.id}-${item.reportDate ?? ''}`}>
                  {item.name}{item.state ? ` (${stateCodeFor(meta, item.state)})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse min-w-[1400px]">
            <thead>
              <tr className="border-b border-border">
                {[
                  { label: 'Institution', term: 'Institution' }, { label: 'State', term: 'State' },
                  { label: 'Report', term: 'Report' },
                  { label: 'Opp.', term: 'Opportunity Score', sortKey: 'opportunity' as const },
                  { label: 'Earn.', term: 'Earnings Score', sortKey: 'earnings' as const },
                  { label: 'Vuln.', term: 'Vulnerability Score', sortKey: 'vulnerability' as const },
                  { label: 'Signals', term: 'Balance-Sheet Signals' },
                  { label: 'Total Assets', term: 'Total Assets' },
                  { label: 'Total Loans', term: 'Total Loans' }, { label: 'CRE Loans', term: 'CRE Loans' },
                  { label: 'CRE Conc.', term: 'CRE Concentration', sortKey: 'cre' as const },
                  { label: 'NPL ($)', term: 'NPL ($)', sortKey: 'npl' as const },
                  { label: 'NPL Ratio', term: 'NPL Ratio' }, { label: 'NC / Loans', term: 'Noncurrent / Loans' },
                  { label: 'NC ($)', term: 'Noncurrent ($)' }, { label: 'PD 30-89 / A', term: 'Past Due 30-89 / Assets' },
                  { label: 'PD 90+ / A', term: 'Past Due 90+ / Assets' }, { label: 'Reserve Cov.', term: 'Reserve Coverage' },
                  { label: 'CET1', term: 'CET1' }, { label: 'Leverage', term: 'Leverage' },
                  { label: 'Cap Used', term: 'Capital Used' },
                  ...(showCapitalColumns ? [
                    { label: 'CRE/(T1+T2)', term: 'CRE / (T1+T2)' }, { label: 'CRE/Equity', term: 'CRE / Equity' },
                    { label: 'Const/(T1+T2)', term: 'Const / (T1+T2)' }, { label: 'MF/(T1+T2)', term: 'MF / (T1+T2)' },
                  ] : []),
                  ...(showEarningsColumns ? [
                    { label: 'ROA', term: 'ROA (Latest)' }, { label: 'ROA Δ4Q', term: 'ROA Δ (4Q)' },
                    { label: 'NI TTM', term: 'Net Income (TTM)' }, { label: 'NI YoY%', term: 'Net Income YoY %' },
                    { label: 'NIM', term: 'NIM (Latest)' }, { label: 'NIM Δ4Q', term: 'NIM Δ (4Q)' },
                    { label: 'Earn Buf%', term: 'Earnings Buffer %' },
                  ] : []),
                  { label: 'Total UC', term: 'Total UC' }, { label: 'CRE UC', term: 'CRE UC' },
                  { label: 'CRE Mix', term: 'CRE Mix' }, { label: 'CRE Conc (4Q)', term: 'CRE Concentration (4Q)' },
                  { label: 'NPL Ratio (4Q)', term: 'NPL Ratio (4Q)' },
                ].map((col) => (
                  <th key={`${col.label}-${col.term}`} className="text-left py-2 px-2 font-medium text-muted-foreground whitespace-nowrap">
                    {sortButton(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(10).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array(21).fill(0).map((_, j) => <td key={j} className="py-2 px-2"><Skeleton className="h-3 w-16" /></td>)}
                  </tr>
                ))
              ) : sortedScreeningTable.map((item, index) => {
                const fired = signals?.byCert.get(item.id)?.fired ?? []
                return (
                <tr key={`${item.id}-${item.reportDate || 'na'}-${index}`} className="border-b border-border/30 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => {
                    setSelectedInstitution(item)
                    const key = `${item.id}-${item.reportDate ?? ''}`
                    setCompareRows((prev) => prev.some((r) => `${r.id}-${r.reportDate ?? ''}` === key) ? prev : [item, ...prev])
                  }}>
                  <td className="py-1.5 px-2 font-medium text-foreground">{item.name}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{stateCodeFor(meta, item.state) || '—'}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{formatQuarterLabel(item.reportDate)}</td>
                  <td className={`py-1.5 px-2 tabular-nums font-medium ${getScoreColor(item.opportunityScore, 'structural')}`}>{formatScore(item.opportunityScore)}</td>
                  <td className={`py-1.5 px-2 tabular-nums font-medium ${getScoreColor(item.earningsScore, 'earnings')}`}>{formatScore(item.earningsScore)}</td>
                  <td className={`py-1.5 px-2 tabular-nums font-medium ${getScoreColor(item.vulnerabilityScore, 'vulnerability')}`}>{formatScore(item.vulnerabilityScore)}</td>
                  <td className="py-1.5 px-2">
                    {signals == null && !signalsError ? (
                      <Skeleton className="h-3 w-12" />
                    ) : fired.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-[180px]">
                        {fired.map((key) => {
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
                  <td className="py-1.5 px-2 tabular-nums">{formatCurrency(item.totalAssets)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatCurrency(item.totalLoans)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatCurrency(item.creLoans)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent(item.creConcentration)}</td>
                  <td className="py-1.5 px-2 tabular-nums font-medium text-amber-700">{formatMoney(item.nonaccrualLoans)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent((item.nplRatio ?? 0) * 100)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent((item.noncurrent_to_loans_ratio ?? 0) * 100)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatMoney((item.noncurrent_to_loans_ratio ?? 0) * (item.totalLoans ?? 0))}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent((item.pastDue3090 ?? 0) * 100)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent((item.pastDue90Plus ?? 0) * 100)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent((item.loanLossReserve ?? 0) * 100)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent(item.cet1Ratio)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatPercent(item.leverageRatio)}</td>
                  <td className="py-1.5 px-2 text-xs text-muted-foreground" title={item.capitalCategory ? `${item.capitalCategory.label} — ${item.capitalCategory.binding}` : undefined}>
                    {item.cet1Ratio !== undefined && item.cet1Ratio !== null && item.cet1Ratio !== 0 ? 'CET1' : 'Leverage'}
                  </td>
                  {showCapitalColumns && <>
                    <td className={`py-1.5 px-2 tabular-nums ${getCreCapitalColor(item.capitalRatios?.creToTier1Tier2 ?? undefined)}`}>{formatRatio(item.capitalRatios?.creToTier1Tier2)}</td>
                    <td className={`py-1.5 px-2 tabular-nums ${getCreCapitalColor(item.capitalRatios?.creToEquity ?? undefined)}`}>{formatRatio(item.capitalRatios?.creToEquity)}</td>
                    <td className={`py-1.5 px-2 tabular-nums ${getCreCapitalColor(item.capitalRatios?.constructionToTier1Tier2 ?? undefined)}`}>{formatRatio(item.capitalRatios?.constructionToTier1Tier2)}</td>
                    <td className={`py-1.5 px-2 tabular-nums ${getCreCapitalColor(item.capitalRatios?.multifamilyToTier1Tier2 ?? undefined)}`}>{formatRatio(item.capitalRatios?.multifamilyToTier1Tier2)}</td>
                  </>}
                  {showEarningsColumns && <>
                    <td className="py-1.5 px-2 tabular-nums">{item.roaLatest != null ? formatPercentMetric(item.roaLatest, 2) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.roaDelta4Q != null ? formatDeltaPercentPoints(item.roaDelta4Q, 2) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.netIncomeTTM != null ? formatMoney(item.netIncomeTTM) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.netIncomeYoYPct != null ? formatDeltaPercentPoints(item.netIncomeYoYPct, 1) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.nimLatest != null ? formatPercentMetric(item.nimLatest, 2) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.nimDelta4Q != null ? formatDeltaPercentPoints(item.nimDelta4Q, 2) : '—'}</td>
                    <td className="py-1.5 px-2 tabular-nums">{item.earningsBufferPct != null ? formatPercentMetric(item.earningsBufferPct, 1) : '—'}</td>
                  </>}
                  <td className="py-1.5 px-2 tabular-nums">{formatCurrency(item.totalUnusedCommitments)}</td>
                  <td className="py-1.5 px-2 tabular-nums">{formatCurrency(item.creUnusedCommitments)}</td>
                  <td className="py-1.5 px-2">
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      <div>Const: {formatPercent(item.creLoans ? ((item.constructionLoans || 0) / item.creLoans) * 100 : undefined)}</div>
                      <div>MF: {formatPercent(item.creLoans ? ((item.multifamilyLoans || 0) / item.creLoans) * 100 : undefined)}</div>
                      <div>NR: {formatPercent(item.creLoans ? ((item.nonResidentialLoans || 0) / item.creLoans) * 100 : undefined)}</div>
                    </div>
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      {item.trend.map((entry) => <div key={`cre-${item.id}-${entry.reportDate}`}>{formatQuarterLabel(entry.reportDate)}: {formatPercent(entry.creConcentration)}</div>)}
                    </div>
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      {item.trend.map((entry) => <div key={`npl-${item.id}-${entry.reportDate}`}>{formatQuarterLabel(entry.reportDate)}: {formatPercent((entry.nplRatio ?? 0) * 100)}</div>)}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          Click a row to view the institution profile and compare institutions side-by-side.
        </p>
      </div>

      <InstitutionProfileDrawer
        row={selectedInstitution as InstitutionProfileRow | null}
        cohort={rows as InstitutionProfileRow[]}
        asOfQuarter={asOfQuarter}
        onClose={() => { setSelectedInstitution(null); setCompareRows([]) }}
        compareRows={compareRows as InstitutionProfileRow[]}
        onAddToCompare={(row) => {
          const key = `${row.id}-${row.reportDate ?? ''}`
          if (compareRows.some((r) => `${r.id}-${r.reportDate ?? ''}` === key)) return
          setCompareRows((prev) => [...prev, row as MiScreeningRow].slice(-10))
        }}
        onRemoveFromCompare={(id, reportDate) => {
          const next = compareRows.filter((r) => !(r.id === id && (r.reportDate ?? '') === (reportDate ?? '')))
          setCompareRows(next)
          if (next.length === 0) setSelectedInstitution(null)
        }}
        onClearCompare={() => setCompareRows([])}
      />
    </div>
  )
}
