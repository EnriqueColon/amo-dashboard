import { useEffect, useMemo, useState } from 'react'
import { Columns3, LineChart } from 'lucide-react'
import { computeCapitalRatios, type CapitalRatios } from '@/lib/fdic-ratio-helpers'
import { KPI_EXPLANATION_NARRATIVE } from '@/lib/kpi-explanation'
import {
  formatPercent as formatPercentMetric,
  formatDeltaPercentPoints,
  formatMoney,
  formatMultiple as formatMultipleMetric,
} from '@/lib/metrics'
import { getCreCapitalColor } from '@/lib/score-colors'
import { getErrorMessage } from '@/lib/error-utils'
import { DefTerm } from '@/components/DefTerm'
import { InstitutionProfileDrawer, type InstitutionProfileRow } from '@/components/InstitutionProfileDrawer'
import { Skeleton } from '@/components/ui/skeleton'

const US_STATES_ALPHABETICAL = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa',
  'Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan',
  'Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire',
  'New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio',
  'Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota',
  'Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia',
  'Wisconsin','Wyoming',
] as const

type RegionKey = 'national' | (typeof US_STATES_ALPHABETICAL)[number]

type Financial = {
  id: string
  name: string
  city?: string
  state?: string
  totalAssets: number
  totalDeposits?: number
  netIncome?: number
  roa?: number
  roe?: number
  creConcentration?: number
  creLoans?: number
  totalLoans?: number
  nonaccrualLoans?: number
  constructionLoans?: number
  multifamilyLoans?: number
  nonResidentialLoans?: number
  otherRealEstateLoans?: number
  totalUnusedCommitments?: number
  creUnusedCommitments?: number
  nplRatio?: number
  noncurrent_to_loans_ratio?: number
  noncurrent_to_assets_ratio?: number
  pastDue3090?: number
  pastDue90Plus?: number
  loanLossReserve?: number
  netInterestMargin?: number
  cet1Ratio?: number
  leverageRatio?: number
  tier1RbcRatio?: number
  totalRbcRatio?: number
  reportDate?: string
  totalEquityDollars?: number | null
}

type ScreeningRow = Financial & {
  trend: Array<{ reportDate: string; creConcentration?: number; nplRatio?: number; roa?: number; netIncome?: number; netInterestMargin?: number }>
  opportunityScore: number
  earningsScore: number
  vulnerabilityScore: number
  capitalRatio: number
  capitalRatios?: CapitalRatios
  roaLatest?: number | null
  roaDelta4Q?: number | null
  netIncomeTTM?: number | null
  netIncomeYoYPct?: number | null
  nimLatest?: number | null
  nimDelta4Q?: number | null
  earningsBufferPct?: number | null
}

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })

function formatQuarter(dateString?: string) {
  if (!dateString) return 'Unknown'
  if (/^\d{8}$/.test(dateString)) {
    const year = dateString.slice(0, 4)
    const month = Number(dateString.slice(4, 6))
    return `Q${Math.ceil(month / 3)} ${year}`
  }
  const parsed = new Date(dateString)
  if (Number.isNaN(parsed.getTime())) return dateString
  return `Q${Math.floor(parsed.getMonth() / 3) + 1} ${parsed.getFullYear()}`
}

function normalizeReportDate(dateStr: string | undefined): string {
  if (!dateStr) return ''
  if (/^\d{8}$/.test(dateStr)) return dateStr
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return m[1] + m[2] + m[3]
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

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

export default function MarketAnalytics() {
  const [region, setRegion] = useState<RegionKey>('Florida')
  const [showCapitalColumns, setShowCapitalColumns] = useState(false)
  const [showEarningsColumns, setShowEarningsColumns] = useState(false)
  const [showColumnsMenu, setShowColumnsMenu] = useState(false)
  const [tableSortColumn, setTableSortColumn] = useState<'npl' | 'cre'>('npl')
  const [tableSortDesc, setTableSortDesc] = useState(true)
  const [selectedInstitution, setSelectedInstitution] = useState<ScreeningRow | null>(null)
  const [compareRows, setCompareRows] = useState<ScreeningRow[]>([])
  const [loading, setLoading] = useState(false)
  const [financials, setFinancials] = useState<Financial[]>([])
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let mounted = true
    async function loadData() {
      setLoading(true)
      setError(undefined)
      try {
        const params = region !== 'national' ? `?state=${encodeURIComponent(region)}` : ''
        const res = await fetch(`/api/fdic/financials${params}`)
        if (!res.ok) throw new Error(`Server error: ${res.status}`)
        const json = await res.json()
        if (!mounted) return
        if (json.error) { setError(json.error); setFinancials([]); return }
        setFinancials(json.data ?? [])
      } catch (err) {
        if (!mounted) return
        setError(`Failed to load FDIC data: ${getErrorMessage(err)}`)
        setFinancials([])
      } finally {
        if (mounted) setLoading(false)
      }
    }
    loadData()
    return () => { mounted = false }
  }, [region])

  const regionFinancials = useMemo(() => {
    if (region === 'national') return financials
    return financials.filter((item) => item.state && item.state.toUpperCase() === region.toUpperCase())
  }, [financials, region])

  const lastQuarterDates = useMemo(() => {
    const dates = Array.from(new Set(regionFinancials.map((item) => item.reportDate).filter(Boolean))) as string[]
    return dates.sort((a, b) => normalizeReportDate(b).localeCompare(normalizeReportDate(a))).slice(0, 8)
  }, [regionFinancials])

  const lastQuarterDatesDisplay = useMemo(() => lastQuarterDates.slice(0, 4), [lastQuarterDates])

  const filteredFinancials = useMemo(() => {
    return regionFinancials.filter((item) => {
      if (lastQuarterDates.length > 0 && item.reportDate && !lastQuarterDates.includes(item.reportDate)) return false
      return true
    })
  }, [regionFinancials, lastQuarterDates])

  const nplLoansSummary = useMemo(() => {
    if (filteredFinancials.length === 0) return null
    const latestById = new Map<string, Financial>()
    filteredFinancials.forEach((item) => {
      const existing = latestById.get(item.id)
      const existingDate = existing?.reportDate ? Date.parse(existing.reportDate) : 0
      const nextDate = item.reportDate ? Date.parse(item.reportDate) : 0
      if (!existing || nextDate > existingDate) latestById.set(item.id, item)
    })
    const latest = Array.from(latestById.values())
    const totalLoans = latest.reduce((s, i) => s + (i.totalLoans ?? 0), 0)
    const totalNpl = latest.reduce((s, i) => s + (i.nonaccrualLoans ?? 0), 0)
    const totalCre = latest.reduce((s, i) => s + (i.creLoans ?? 0), 0)
    const totalAssets = latest.reduce((s, i) => s + i.totalAssets, 0)
    const avgNpl = latest.length > 0 ? latest.reduce((s, i) => s + (i.nplRatio ?? 0) * 100, 0) / latest.length : 0
    const avgCreToAssets = totalAssets > 0 ? (totalCre / totalAssets) * 100 : 0
    return { totalLoans, totalNpl, totalCre, totalAssets, avgNpl, avgCreToAssets, count: latest.length }
  }, [filteredFinancials])

  const kpis = useMemo(() => {
    if (filteredFinancials.length === 0) return [
      { label: 'Institutions Screened', value: '0' },
      { label: 'Avg NPL Ratio', value: '—' },
      { label: 'Avg Noncurrent / Loans', value: '—' },
      { label: 'Avg Reserve Coverage', value: '—' },
      { label: 'Avg CRE Concentration', value: '—' },
    ]
    const latestById = new Map<string, Financial>()
    filteredFinancials.forEach((item) => {
      const existing = latestById.get(item.id)
      const existingDate = existing?.reportDate ? Date.parse(existing.reportDate) : 0
      const nextDate = item.reportDate ? Date.parse(item.reportDate) : 0
      if (!existing || nextDate > existingDate) latestById.set(item.id, item)
    })
    const latest = Array.from(latestById.values())
    const avg = (vals: number[]) => vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
    const avgNpl = avg(latest.map((i) => i.nplRatio || 0))
    const avgNoncurrentLoans = avg(latest.map((i) => (i.noncurrent_to_loans_ratio ?? 0) * 100))
    const avgReserve = avg(latest.map((i) => i.loanLossReserve || 0))
    const avgCre = avg(latest.map((i) => i.creConcentration || 0))
    return [
      { label: 'Institutions Screened', value: formatNumber(latest.length) },
      { label: 'Avg NPL Ratio', value: formatPercent(avgNpl * 100) },
      { label: 'Avg Noncurrent / Loans', value: formatPercent(avgNoncurrentLoans) },
      { label: 'Avg Reserve Coverage', value: formatPercent(avgReserve * 100) },
      { label: 'Avg CRE Concentration', value: formatPercent(avgCre) },
    ]
  }, [filteredFinancials])

  const screeningTable = useMemo<ScreeningRow[]>(() => {
    const grouped = new Map<string, Financial[]>()
    filteredFinancials.forEach((item) => {
      if (!grouped.has(item.id)) grouped.set(item.id, [])
      grouped.get(item.id)!.push(item)
    })
    const mostRecentQuarter = lastQuarterDates[0]
    const mostRecentNorm = normalizeReportDate(mostRecentQuarter)
    const rows: ScreeningRow[] = []
    grouped.forEach((items) => {
      const sorted = [...items].sort((a, b) => normalizeReportDate(b.reportDate).localeCompare(normalizeReportDate(a.reportDate)))
      const byDateNorm = new Map(sorted.map((entry) => [normalizeReportDate(entry.reportDate), entry]))
      const latest = mostRecentNorm && byDateNorm.has(mostRecentNorm) ? byDateNorm.get(mostRecentNorm)! : sorted[0]
      if (mostRecentNorm && !byDateNorm.has(mostRecentNorm)) return
      const capitalRatio = latest.cet1Ratio ?? latest.leverageRatio ?? 0
      const trend = lastQuarterDatesDisplay.filter(Boolean).map((date) => {
        const entry = byDateNorm.get(normalizeReportDate(date))
        return { reportDate: date, creConcentration: entry?.creConcentration, nplRatio: entry?.nplRatio, roa: entry?.roa, netIncome: entry?.netIncome, netInterestMargin: entry?.netInterestMargin }
      })
      const capitalRatios = computeCapitalRatios({
        totalAssets: latest.totalAssets,
        creLoans: latest.creLoans ?? 0,
        constructionLoans: latest.constructionLoans ?? 0,
        multifamilyLoans: latest.multifamilyLoans ?? 0,
        leverageRatio: latest.leverageRatio,
        tier1RbcRatio: latest.tier1RbcRatio,
        totalRbcRatio: latest.totalRbcRatio,
        cet1Ratio: latest.cet1Ratio,
        totalEquityDollars: latest.totalEquityDollars,
      })

      const q3 = lastQuarterDates[3]
      const roaLatest = latest.roa != null ? latest.roa : null
      const roaDelta4Q = lastQuarterDates.length >= 4 && roaLatest != null && byDateNorm.get(normalizeReportDate(q3))?.roa != null
        ? roaLatest - (byDateNorm.get(normalizeReportDate(q3))!.roa ?? 0) : null
      const nimLatest = latest.netInterestMargin != null ? latest.netInterestMargin : null
      const nimDelta4Q = lastQuarterDates.length >= 4 && nimLatest != null && byDateNorm.get(normalizeReportDate(q3))?.netInterestMargin != null
        ? nimLatest - (byDateNorm.get(normalizeReportDate(q3))!.netInterestMargin ?? 0) : null

      const niCurrent4 = lastQuarterDates.slice(0, 4).map((d) => byDateNorm.get(normalizeReportDate(d))?.netIncome)
      const hasAll4 = niCurrent4.length === 4 && niCurrent4.every((v) => v != null && Number.isFinite(v))
      const netIncomeTTM = hasAll4 ? (niCurrent4.reduce((s, v) => s! + v!, 0) as number) : null
      const niPrior4 = lastQuarterDates.slice(4, 8).map((d) => byDateNorm.get(normalizeReportDate(d))?.netIncome)
      const hasAll8 = niPrior4.length === 4 && niPrior4.every((v) => v != null && Number.isFinite(v))
      const netIncomeTTMPrior = hasAll8 ? (niPrior4.reduce((s, v) => s! + v!, 0) as number) : null
      const netIncomeYoYPct = netIncomeTTM != null && netIncomeTTMPrior != null ? (() => {
        const denom = Math.abs(netIncomeTTMPrior)
        return denom === 0 ? null : ((netIncomeTTM - netIncomeTTMPrior) / denom) * 100
      })() : null
      const earningsBufferPct = netIncomeTTM != null && (latest.creLoans ?? 0) > 0 ? (netIncomeTTM / latest.creLoans!) * 100 : null

      rows.push({ ...latest, trend, opportunityScore: 0, earningsScore: 0, vulnerabilityScore: 0, capitalRatio, capitalRatios, roaLatest, roaDelta4Q, netIncomeTTM, netIncomeYoYPct, nimLatest, nimDelta4Q, earningsBufferPct })
    })
    return rows
  }, [filteredFinancials, lastQuarterDates])

  const sortedScreeningTable = useMemo(() => {
    return [...screeningTable].sort((a, b) => {
      if (tableSortColumn === 'npl') {
        const va = a.nonaccrualLoans ?? 0, vb = b.nonaccrualLoans ?? 0
        return tableSortDesc ? vb - va : va - vb
      }
      const va = a.creConcentration ?? 0, vb = b.creConcentration ?? 0
      return tableSortDesc ? vb - va : va - vb
    })
  }, [screeningTable, tableSortColumn, tableSortDesc])

  const asOfQuarter = lastQuarterDates[0] ? formatQuarter(lastQuarterDates[0]) : 'Latest'
  const regionDisplay = region === 'national' ? 'United States' : region

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
            FDIC financials, failures, and historical summaries with filters.
          </p>
          <p className="text-xs text-muted-foreground">
            FDIC data is quarterly and lagged by 1–2 quarters.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-card border border-border rounded-lg p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Controls</p>
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as RegionKey)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground w-48"
          >
            <option value="national">United States</option>
            {US_STATES_ALPHABETICAL.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
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
          <p className="text-sm font-medium">Loading FDIC data for {regionDisplay}…</p>
          <div className="space-y-2">
            {[1,2,3].map((i) => <Skeleton key={i} className="h-4 rounded" />)}
          </div>
        </div>
      )}
      {error && <div className="bg-card border border-border rounded-lg p-4 text-sm text-destructive">{error}</div>}

      {/* NPL Summary */}
      {nplLoansSummary && (
        <div className="bg-card border-2 border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-base font-semibold mb-1">NPL & Loans</h2>
          <p className="text-sm text-muted-foreground mb-4">Nonperforming loan metrics for {regionDisplay}. Dollar values from FDIC call reports (latest quarter).</p>
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
        <p className="text-xs text-muted-foreground mb-4">Average metrics for {regionDisplay} based on the latest quarter. FDIC data is quarterly and lagged.</p>
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
              Bank-level screening focused on NPL (nonaccrual loans in dollars), CRE loans, and CRE concentration. Sort by NPL ($) or CRE Concentration to prioritize.
            </p>
          </div>
          {!loading && screeningTable.length > 0 && (
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
                  {item.name}{item.state ? ` (${item.state})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse min-w-[1200px]">
            <thead>
              <tr className="border-b border-border">
                {[
                  { label: 'Institution', term: 'Institution' }, { label: 'State', term: 'State' },
                  { label: 'Report', term: 'Report' }, { label: 'Total Assets', term: 'Total Assets' },
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
                    {col.sortKey ? (
                      <button type="button" className="cursor-pointer border-b border-dashed border-muted-foreground/50 hover:opacity-80 text-left font-normal flex items-center gap-1 text-xs"
                        onClick={() => { setTableSortColumn(col.sortKey!); setTableSortDesc((prev) => tableSortColumn === col.sortKey ? !prev : true) }}>
                        <DefTerm term={col.term}>{col.label}</DefTerm>
                        {tableSortColumn === col.sortKey ? (tableSortDesc ? ' ↓' : ' ↑') : ''}
                      </button>
                    ) : (
                      <DefTerm term={col.term}>{col.label}</DefTerm>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(10).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array(17).fill(0).map((_, j) => <td key={j} className="py-2 px-2"><Skeleton className="h-3 w-16" /></td>)}
                  </tr>
                ))
              ) : sortedScreeningTable.map((item, index) => (
                <tr key={`${item.id}-${item.reportDate || 'na'}-${index}`} className="border-b border-border/30 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => {
                    setSelectedInstitution(item)
                    const key = `${item.id}-${item.reportDate ?? ''}`
                    setCompareRows((prev) => prev.some((r) => `${r.id}-${r.reportDate ?? ''}` === key) ? prev : [item, ...prev])
                  }}>
                  <td className="py-1.5 px-2 font-medium text-foreground">{item.name}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{item.state || '—'}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{formatQuarter(item.reportDate)}</td>
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
                  <td className="py-1.5 px-2 text-xs text-muted-foreground">{item.cet1Ratio !== undefined && item.cet1Ratio !== 0 ? 'CET1' : 'Leverage'}</td>
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
                      {item.trend.map((entry) => <div key={`cre-${item.id}-${entry.reportDate}`}>{formatQuarter(entry.reportDate)}: {formatPercent(entry.creConcentration)}</div>)}
                    </div>
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      {item.trend.map((entry) => <div key={`npl-${item.id}-${entry.reportDate}`}>{formatQuarter(entry.reportDate)}: {formatPercent((entry.nplRatio ?? 0) * 100)}</div>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-muted-foreground leading-relaxed">
          Click a row to view the institution profile and compare institutions side-by-side.
        </p>
      </div>

      <InstitutionProfileDrawer
        row={selectedInstitution as InstitutionProfileRow | null}
        cohort={screeningTable as InstitutionProfileRow[]}
        asOfQuarter={asOfQuarter}
        onClose={() => { setSelectedInstitution(null); setCompareRows([]) }}
        compareRows={compareRows as InstitutionProfileRow[]}
        onAddToCompare={(row) => {
          const key = `${row.id}-${(row as any).reportDate ?? ''}`
          if (compareRows.some((r) => `${r.id}-${r.reportDate ?? ''}` === key)) return
          setCompareRows((prev) => [...prev, row as ScreeningRow].slice(-10))
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
