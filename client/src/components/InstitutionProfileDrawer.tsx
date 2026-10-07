import { useCallback, useEffect, useMemo, useState } from "react"
import { Copy, X } from "lucide-react"
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/hooks/use-toast"
import {
  loadInstitution, loadMiMeta, signalsByKey, MiError, MI_UNAVAILABLE_TITLE,
  type MiInstitution, type MiMeta, type MiRollForwardStep, type MiTrendQuarter,
} from "@/lib/market-intelligence"
import {
  formatMoney,
  formatCapitalMultiple,
  formatPercent as formatPercentMetric,
  formatDeltaPercentPoints,
  formatMultiple as formatMultipleMetric,
} from "@/lib/metrics"
import { getCreCapitalColor } from "@/lib/score-colors"
// Peer ranking, its metric set and its direction rules live in one pure module
// so all three surfaces below share them and a guardrail can assert them.
import {
  buildPeerCohort,
  getPeerInterpretation,
  peerPercentile,
  PEER_META,
} from "@/lib/peer-metrics"
import { DefTerm } from "@/components/DefTerm"

function formatDeltaPp(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(decimals)} pp`
}

function formatAssets(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function formatQuarter(dateString?: string) {
  if (!dateString) return "—"
  if (/^\d{8}$/.test(dateString)) {
    const year = dateString.slice(0, 4)
    const month = Number(dateString.slice(4, 6))
    const quarter = Math.ceil(month / 3)
    return `Q${quarter} ${year}`
  }
  const parsed = new Date(dateString)
  if (Number.isNaN(parsed.getTime())) return dateString
  const quarter = Math.floor(parsed.getMonth() / 3) + 1
  return `Q${quarter} ${parsed.getFullYear()}`
}

function formatDecimalPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  return (value * 100).toFixed(1) + "%"
}

function formatRatio(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—"
  return formatMultipleMetric(value)
}

function PercentileBadge({ metric, pct }: { metric: string; pct: number }) {
  const interp = getPeerInterpretation(metric, pct)
  if (!interp) return <span className="font-medium tabular-nums">{pct}th percentile</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-medium tabular-nums text-slate-700">{pct}th pct.</span>
      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border leading-none ${interp.colorClass}`}>
        {interp.label}
      </span>
    </span>
  )
}

export type InstitutionProfileRow = {
  id: string
  name: string
  city?: string
  state?: string
  totalAssets: number
  reportDate?: string
  creConcentration?: number
  nplRatio?: number
  noncurrent_to_loans_ratio?: number
  noncurrent_to_assets_ratio?: number
  loanLossReserve?: number
  cet1Ratio?: number
  leverageRatio?: number
  capitalRatios?: {
    creToTier1Tier2: number | null
    creToEquity: number | null
    constructionToTier1Tier2: number | null
    multifamilyToTier1Tier2: number | null
    coverage?: { hasTier1Tier2: boolean }
  }
  capitalCategory?: { category: string; label: string; binding: string; basis: string }
  totalUnusedCommitments?: number
  creUnusedCommitments?: number
  opportunityScore: number
  earningsScore: number
  vulnerabilityScore: number
  roaLatest?: number | null
  roaDelta4Q?: number | null
  netIncomeTTM?: number | null
  netIncomeYoYPct?: number | null
  nimLatest?: number | null
  nimDelta4Q?: number | null
  earningsBufferPct?: number | null
  totalLoans?: number
  creLoans?: number
  nonaccrualLoans?: number
  pastDue3090?: number
  pastDue90Plus?: number
  constructionLoans?: number
  multifamilyLoans?: number
  nonResidentialLoans?: number
  otherRealEstateLoans?: number
  trend?: Array<{
    reportDate: string
    creConcentration?: number
    nplRatio?: number
    roa?: number
    netIncome?: number
    netInterestMargin?: number
  }>
}

type InstitutionProfileDrawerProps = {
  row: InstitutionProfileRow | null
  cohort: InstitutionProfileRow[]
  asOfQuarter: string
  onClose: () => void
  compareRows?: InstitutionProfileRow[]
  onAddToCompare?: (row: InstitutionProfileRow) => void
  onRemoveFromCompare?: (id: string, reportDate?: string) => void
  onClearCompare?: () => void
}

export function InstitutionProfileDrawer({
  row,
  cohort,
  asOfQuarter,
  onClose,
  compareRows = [],
  onAddToCompare,
  onRemoveFromCompare,
}: InstitutionProfileDrawerProps) {
  const displayRows = compareRows.length >= 1 ? compareRows : (row ? [row] : [])
  const rowForCopy = row ?? displayRows[0]

  const buildSnapshot = useCallback((): string => {
    if (!rowForCopy) return ""
    const nplVal = rowForCopy.nplRatio ?? 0
    const ntlVal = rowForCopy.noncurrent_to_loans_ratio ?? 0
    const ntaVal = rowForCopy.noncurrent_to_assets_ratio ?? 0
    const reserveVal = rowForCopy.loanLossReserve ?? 0

    const creAssets = rowForCopy.creConcentration != null ? rowForCopy.creConcentration.toFixed(1) : "—"
    const creCapital = rowForCopy.capitalRatios?.creToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.creToTier1Tier2) : "—"
    const constructionCapital = rowForCopy.capitalRatios?.constructionToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.constructionToTier1Tier2) : "—"
    const multifamilyCapital = rowForCopy.capitalRatios?.multifamilyToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.multifamilyToTier1Tier2) : "—"
    const npl = Number.isFinite(nplVal) ? (nplVal * 100).toFixed(1) : "—"
    const noncurrentLoans = Number.isFinite(ntlVal) ? (ntlVal * 100).toFixed(1) : "—"
    const noncurrentAssets = Number.isFinite(ntaVal) ? (ntaVal * 100).toFixed(1) : "—"
    const reserveCoverage = Number.isFinite(reserveVal) ? (reserveVal * 100).toFixed(1) : "—"
    const capitalUsed = rowForCopy.cet1Ratio != null && rowForCopy.cet1Ratio !== 0 ? rowForCopy.cet1Ratio : rowForCopy.leverageRatio
    const capitalUsedVal = capitalUsed != null ? capitalUsed.toFixed(1) : "—"
    const capitalLabel = rowForCopy.cet1Ratio != null && rowForCopy.cet1Ratio !== 0 ? "CET1" : "Leverage"
    const roa = rowForCopy.roaLatest != null ? rowForCopy.roaLatest.toFixed(2) : "—"
    const netIncomeTTM = rowForCopy.netIncomeTTM != null ? formatMoney(rowForCopy.netIncomeTTM) : "—"
    const nim = rowForCopy.nimLatest != null ? rowForCopy.nimLatest.toFixed(2) : "—"
    const earningsBuffer = rowForCopy.earningsBufferPct != null ? rowForCopy.earningsBufferPct.toFixed(1) : "—"

    const peerLines = buildPeerCohort(cohort).map((metric) => {
      const pct = peerPercentile(rowForCopy, metric)
      if (pct == null) return `${metric.label}: —`
      const label = getPeerInterpretation(metric.label, pct)?.label ?? ""
      return `${metric.label}: ${pct}th pct. — ${label} (${metric.hint})`
    })

    const lines = [
      `${rowForCopy.name} — Institution Snapshot (${asOfQuarter})`,
      `Location: ${rowForCopy.city ?? "—"}, ${rowForCopy.state ?? "—"}`,
      `Total Assets: ${formatAssets(rowForCopy.totalAssets)}`,
      "", "Structural Exposure:", "",
      `CRE / Assets: ${creAssets}%`, `CRE / Capital: ${creCapital}`,
      `Construction / Capital: ${constructionCapital}`, `Multifamily / Capital: ${multifamilyCapital}`,
      `NPL Ratio: ${npl}%`, `Noncurrent / Loans: ${noncurrentLoans}%`,
      `Noncurrent / Assets: ${noncurrentAssets}%`, `Reserve Coverage: ${reserveCoverage}%`,
      `Capital Ratio Used: ${capitalUsedVal}% (${capitalLabel})`,
      "", "Earnings:", "",
      `ROA: ${roa}%`, `Net Income (TTM): ${netIncomeTTM}`, `NIM: ${nim}%`, `Earnings Buffer: ${earningsBuffer}%`,
      "", "Peer Positioning (vs. selected cohort):", "",
      ...peerLines,
    ]
    return lines.join("\n")
  }, [rowForCopy, cohort, asOfQuarter])

  const handleCopy = useCallback(async () => {
    const text = buildSnapshot()
    if (!text) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement("textarea")
        ta.value = text
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      toast({ title: "Snapshot copied.", variant: "default" })
    } catch {
      toast({ title: "Copy failed", variant: "destructive" })
    }
  }, [buildSnapshot])

  const isCompareMode = displayRows.length >= 1
  if (!row && compareRows.length === 0) return null

  const availableToAdd = cohort.filter(
    (c) => !displayRows.some((r) => r.id === c.id && (r.reportDate ?? "") === (c.reportDate ?? ""))
  )
  const sortedAvailable = [...availableToAdd].sort((a, b) => (a.name || "").localeCompare(b.name || ""))

  return (
    <Dialog open={!!row || compareRows.length > 0} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[96vw] max-w-6xl max-h-[90vh] overflow-y-auto p-6">
        <DialogHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pr-8">
          <DialogTitle className="text-lg font-semibold text-slate-800">Compare institutions</DialogTitle>
          <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0 border-primary/30 text-primary hover:bg-primary/5">
            <Copy className="h-4 w-4 mr-2" />
            Copy Snapshot
          </Button>
        </DialogHeader>
        <div className="mt-6 space-y-6 pr-4">
          {isCompareMode ? (
            <>
              {onAddToCompare && sortedAvailable.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-600">Add institution:</span>
                  <Select value="__add__" onValueChange={(value) => {
                    if (value === "__add__") return
                    const r = cohort.find((c) => `${c.id}-${c.reportDate ?? ""}` === value)
                    if (r) { onAddToCompare(r); toast({ title: "Added to compare", variant: "default" }) }
                  }}>
                    <SelectTrigger className="w-[280px]"><SelectValue placeholder="Add institution…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__add__">Add institution…</SelectItem>
                      {sortedAvailable.map((item) => (
                        <SelectItem key={`${item.id}-${item.reportDate ?? "na"}`} value={`${item.id}-${item.reportDate ?? ""}`}>
                          {item.name}{item.state ? ` (${item.state})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <ComparisonTable
                rows={displayRows} cohort={cohort} asOfQuarter={asOfQuarter}
                formatAssets={formatAssets} formatQuarter={formatQuarter}
                formatDecimalPercent={formatDecimalPercent} formatMoney={formatMoney}
                formatPercentMetric={formatPercentMetric} formatDeltaPercentPoints={formatDeltaPercentPoints}
                formatRatio={formatRatio} getCreCapitalColor={getCreCapitalColor}
                onRemove={onRemoveFromCompare}
              />
              <PeerPositioningComparisonChart rows={displayRows} cohort={cohort} />
              {rowForCopy && displayRows.length === 1 && (
                <>
                  <div className="rounded-lg border border-slate-200/80 bg-slate-50/50 px-4 py-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">{rowForCopy.city ?? "—"}, {rowForCopy.state ?? "—"}</p>
                    <p className="text-sm font-semibold text-slate-800 mt-0.5">Total Assets: {formatAssets(rowForCopy.totalAssets)}</p>
                  </div>
                  <ScreeningListSection row={rowForCopy} formatAssets={formatAssets} formatQuarter={formatQuarter} formatDecimalPercent={formatDecimalPercent} formatMoney={formatMoney} formatPercentMetric={formatPercentMetric} formatDeltaPercentPoints={formatDeltaPercentPoints} formatRatio={formatRatio} getCreCapitalColor={getCreCapitalColor} />
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Structural Exposure</h4>
                    <div className="space-y-1.5 text-sm text-slate-700">
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="CRE / Assets">CRE / Assets</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.creConcentration != null ? rowForCopy.creConcentration.toFixed(1) + "%" : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="CRE / Capital">CRE / Capital</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.capitalRatios?.creToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.creToTier1Tier2) : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Construction / Capital">Construction / Capital</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.capitalRatios?.constructionToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.constructionToTier1Tier2) : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Multifamily / Capital">Multifamily / Capital</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.capitalRatios?.multifamilyToTier1Tier2 != null ? formatCapitalMultiple(rowForCopy.capitalRatios.multifamilyToTier1Tier2) : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="NPL Ratio">NPL Ratio</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.nplRatio != null ? (rowForCopy.nplRatio * 100).toFixed(1) + "%" : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Noncurrent / Loans">Noncurrent / Loans</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.noncurrent_to_loans_ratio != null ? (rowForCopy.noncurrent_to_loans_ratio * 100).toFixed(1) + "%" : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Noncurrent / Assets">Noncurrent / Assets</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.noncurrent_to_assets_ratio != null ? (rowForCopy.noncurrent_to_assets_ratio * 100).toFixed(1) + "%" : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Reserve Coverage">Reserve Coverage</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.loanLossReserve != null ? (rowForCopy.loanLossReserve * 100).toFixed(1) + "%" : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Total UC">Total UC</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.totalUnusedCommitments != null ? formatAssets(rowForCopy.totalUnusedCommitments) : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="CRE UC">CRE UC</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.creUnusedCommitments != null ? formatAssets(rowForCopy.creUnusedCommitments) : "—"}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Capital">Capital</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.cet1Ratio != null && rowForCopy.cet1Ratio !== 0 ? rowForCopy.cet1Ratio.toFixed(1) + "% (CET1)" : rowForCopy.leverageRatio != null ? rowForCopy.leverageRatio.toFixed(1) + "% (Leverage)" : "—"}</span></p>
                    </div>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Earnings</h4>
                    <div className="space-y-1.5 text-sm text-slate-700">
                      <p className="flex justify-between gap-4"><span className="text-slate-500"><DefTerm term="ROA">ROA</DefTerm></span><span className="font-medium tabular-nums text-right">{rowForCopy.roaLatest != null ? rowForCopy.roaLatest.toFixed(2) + "%" : "—"}{rowForCopy.roaDelta4Q != null ? ` (Δ4Q: ${formatDeltaPp(rowForCopy.roaDelta4Q)})` : ""}</span></p>
                      <p className="flex justify-between gap-4"><span className="text-slate-500"><DefTerm term="Net Income (TTM)">Net Income (TTM)</DefTerm></span><span className="font-medium tabular-nums text-right">{rowForCopy.netIncomeTTM != null ? formatMoney(rowForCopy.netIncomeTTM) : "—"}{rowForCopy.netIncomeYoYPct != null ? ` (YoY: ${rowForCopy.netIncomeYoYPct >= 0 ? "+" : ""}${rowForCopy.netIncomeYoYPct.toFixed(1)}%)` : ""}</span></p>
                      <p className="flex justify-between gap-4"><span className="text-slate-500"><DefTerm term="NIM">NIM</DefTerm></span><span className="font-medium tabular-nums text-right">{rowForCopy.nimLatest != null ? rowForCopy.nimLatest.toFixed(2) + "%" : "—"}{rowForCopy.nimDelta4Q != null ? ` (Δ4Q: ${formatDeltaPp(rowForCopy.nimDelta4Q)})` : ""}</span></p>
                      <p className="flex justify-between"><span className="text-slate-500"><DefTerm term="Earnings Buffer">Earnings Buffer</DefTerm></span><span className="font-medium tabular-nums">{rowForCopy.earningsBufferPct != null ? rowForCopy.earningsBufferPct.toFixed(1) + "%" : "—"}</span></p>
                    </div>
                  </div>
                  <InstitutionDetailSections cert={rowForCopy.id} />
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-1">Peer Positioning</h4>
                    <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">
                      Ranked within the selected cohort.&nbsp;
                      <span className="text-red-500 font-medium">Red = stress indicator</span> · <span className="text-green-600 font-medium">Green = strength indicator</span>
                    </p>
                    <div className="space-y-2 text-sm text-slate-700">
                      {(() => {
                        const rows2 = buildPeerCohort(cohort).map((metric) => ({
                          label: metric.label,
                          hint: metric.hint,
                          pct: peerPercentile(rowForCopy, metric),
                        }))
                        return rows2.map(({ label, hint, pct }) => (
                          <div key={label} className="rounded-md bg-slate-50 border border-slate-100 px-3 py-2">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-600 font-medium text-[13px]"><DefTerm term={label}>{label}</DefTerm></span>
                              {pct != null ? <PercentileBadge metric={label} pct={pct} /> : <span className="text-slate-400">—</span>}
                            </div>
                            <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{hint}</p>
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-600">Select an institution from the table or dropdown to compare.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PeerPositioningComparisonChart({ rows, cohort }: { rows: InstitutionProfileRow[]; cohort: InstitutionProfileRow[] }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const chartSeries = useMemo(() => rows.map((row, idx) => ({
    key: `inst_${idx}`,
    label: `${row.name}${row.state ? ` (${row.state})` : ""}`,
    color: ["hsl(38 95% 55%)", "#0ea5e9", "#334155", "#10b981", "#f59e0b", "#a855f7"][idx % 6],
    row,
  })), [rows])

  const chartData = useMemo(() => {
    return buildPeerCohort(cohort).map((metric) => {
      const out: Record<string, string | number | null> = { metric: metric.label }
      chartSeries.forEach((series) => { out[series.key] = peerPercentile(series.row, metric) })
      return out
    })
  }, [cohort, chartSeries])

  if (rows.length === 0) return null

  const renderChart = (height: number) => (
    <ResponsiveContainer width="100%" height={height} debounce={0}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 24 }} barCategoryGap={18}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="metric" width={96} tick={{ fontSize: 11, fill: "#334155", fontWeight: 500 }} tickLine={false} axisLine={false} />
        <Legend verticalAlign="top" align="left" wrapperStyle={{ fontSize: "12px", color: "#334155", paddingBottom: "8px" }} formatter={(value) => <span className="text-slate-700">{value}</span>} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null
          const metricStr = String(label)
          const meta = PEER_META[metricStr]
          return (
            <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm text-sm max-w-[260px]">
              <p className="font-medium text-slate-800 mb-1">{metricStr}</p>
              {payload.map((item) => {
                const pct = item.value as number | null
                const interp = pct != null ? getPeerInterpretation(metricStr, pct) : null
                return (
                  <div key={item.dataKey as string} className="flex items-center justify-between gap-3 py-0.5">
                    <span className="text-slate-600 text-xs">{item.name}</span>
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className="tabular-nums">{pct == null ? "—" : `${pct}th`}</span>
                      {interp && <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${interp.colorClass}`}>{interp.label}</span>}
                    </span>
                  </div>
                )
              })}
              {meta && <p className="text-[10px] text-slate-400 mt-1.5 leading-snug border-t border-slate-100 pt-1.5">{meta.hint}</p>}
            </div>
          )
        }} />
        {chartSeries.map((series) => <Bar key={series.key} name={series.label} dataKey={series.key} fill={series.color} radius={[2, 2, 2, 2]} maxBarSize={14} />)}
      </BarChart>
    </ResponsiveContainer>
  )

  return (
    <>
      <div className="rounded-lg border border-slate-200/80 bg-white p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-1">Peer Positioning Comparison</h4>
        <p className="text-xs text-slate-500 mb-1">Percentile ranking within the selected cohort. Hover bars for interpretation.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mb-3 text-[10px] text-slate-500">
          <span><span className="text-red-500 font-medium">CRE / Assets · NPL Ratio</span> — higher percentile = more stressed / concentrated (distressed opportunity signal)</span>
          <span><span className="text-green-600 font-medium">Net Income · NIM</span> — higher percentile = stronger earnings (less likely to need to sell)</span>
        </div>
        <button type="button" className="w-full rounded-md border border-dashed border-slate-200 p-1 text-left transition hover:border-primary/40 cursor-zoom-in" onClick={() => setIsExpanded(true)} aria-label="Expand peer positioning chart" title="Click to enlarge chart">
          <div className="h-[260px] min-h-[260px] w-full">{renderChart(260)}</div>
        </button>
        <p className="mt-2 text-[11px] text-slate-500">Click chart to expand</p>
      </div>
      <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
        <DialogContent className="w-[96vw] max-w-[1200px] h-[90vh] p-4 sm:p-6">
          <DialogHeader><DialogTitle>Peer Positioning Comparison</DialogTitle></DialogHeader>
          <div className="h-[calc(90vh-120px)] w-full">{renderChart(560)}</div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ScreeningListSection({ row, formatAssets, formatQuarter, formatDecimalPercent, formatMoney, formatPercentMetric, formatDeltaPercentPoints, formatRatio, getCreCapitalColor }: {
  row: InstitutionProfileRow
  formatAssets: (v: number | undefined) => string
  formatQuarter: (d?: string) => string
  formatDecimalPercent: (v: number | undefined) => string
  formatMoney: (v: number | null | undefined) => string
  formatPercentMetric: (v: number | null | undefined, d?: number) => string
  formatDeltaPercentPoints: (v: number | null | undefined, d?: number) => string
  formatRatio: (v: number | null | undefined) => string
  getCreCapitalColor: (v: number | undefined) => string
}) {
  const creMix = row.creLoans ? {
    construction: ((row.constructionLoans ?? 0) / row.creLoans) * 100,
    multifamily: ((row.multifamilyLoans ?? 0) / row.creLoans) * 100,
    nonRes: ((row.nonResidentialLoans ?? 0) / row.creLoans) * 100,
    other: ((row.otherRealEstateLoans ?? 0) / row.creLoans) * 100,
  } : null

  const metrics: Array<{ label: string; term?: string; value: string; className?: string }> = [
    { label: "Report", value: formatQuarter(row.reportDate) },
    { label: "Total Assets", value: formatAssets(row.totalAssets) },
    { label: "Total Loans", value: formatMoney(row.totalLoans) },
    { label: "CRE Loans", value: formatMoney(row.creLoans) },
    { label: "CRE Concentration", value: row.creConcentration != null ? formatDecimalPercent(row.creConcentration / 100) : "—" },
    { label: "NPL ($)", value: formatMoney(row.nonaccrualLoans) },
    { label: "NPL Ratio", value: formatDecimalPercent(row.nplRatio) },
    { label: "Noncurrent / Loans", value: formatDecimalPercent(row.noncurrent_to_loans_ratio) },
    { label: "Noncurrent ($)", value: formatMoney((row.noncurrent_to_loans_ratio ?? 0) * (row.totalLoans ?? 0)) },
    { label: "Past Due 30-89 / Assets", value: formatDecimalPercent(row.pastDue3090) },
    { label: "Past Due 90+ / Assets", value: formatDecimalPercent(row.pastDue90Plus) },
    { label: "Reserve Coverage", value: formatDecimalPercent(row.loanLossReserve) },
    { label: "CET1", value: row.cet1Ratio != null ? formatPercentMetric(row.cet1Ratio, 1) : "—" },
    { label: "Leverage", value: row.leverageRatio != null ? formatPercentMetric(row.leverageRatio, 1) : "—" },
    { label: "CRE / (T1+T2)", value: formatRatio(row.capitalRatios?.creToTier1Tier2 ?? undefined), className: getCreCapitalColor(row.capitalRatios?.creToTier1Tier2 ?? undefined) },
    { label: "CRE / Equity", value: formatRatio(row.capitalRatios?.creToEquity ?? undefined), className: getCreCapitalColor(row.capitalRatios?.creToEquity ?? undefined) },
    { label: "Const / (T1+T2)", value: formatRatio(row.capitalRatios?.constructionToTier1Tier2 ?? undefined), className: getCreCapitalColor(row.capitalRatios?.constructionToTier1Tier2 ?? undefined) },
    { label: "MF / (T1+T2)", value: formatRatio(row.capitalRatios?.multifamilyToTier1Tier2 ?? undefined), className: getCreCapitalColor(row.capitalRatios?.multifamilyToTier1Tier2 ?? undefined) },
    { label: "ROA (Latest)", value: row.roaLatest != null ? formatPercentMetric(row.roaLatest, 2) : "—" },
    { label: "ROA Δ (4Q)", value: row.roaDelta4Q != null ? formatDeltaPercentPoints(row.roaDelta4Q, 2) : "—" },
    { label: "Net Income (TTM)", value: row.netIncomeTTM != null ? formatMoney(row.netIncomeTTM) : "—" },
    { label: "NI YoY %", value: row.netIncomeYoYPct != null ? formatDeltaPercentPoints(row.netIncomeYoYPct, 1) : "—" },
    { label: "NIM (Latest)", value: row.nimLatest != null ? formatPercentMetric(row.nimLatest, 2) : "—" },
    { label: "NIM Δ (4Q)", value: row.nimDelta4Q != null ? formatDeltaPercentPoints(row.nimDelta4Q, 2) : "—" },
    { label: "Earnings Buffer %", value: row.earningsBufferPct != null ? formatPercentMetric(row.earningsBufferPct, 1) : "—" },
    { label: "Total UC", value: formatMoney(row.totalUnusedCommitments) },
    { label: "CRE UC", value: formatMoney(row.creUnusedCommitments) },
  ]
  if (creMix) {
    metrics.push(
      { label: "CRE Mix: Construction", term: "CRE Mix", value: creMix.construction.toFixed(1) + "%" },
      { label: "CRE Mix: Multifamily", term: "CRE Mix", value: creMix.multifamily.toFixed(1) + "%" },
      { label: "CRE Mix: Non-Res", term: "CRE Mix", value: creMix.nonRes.toFixed(1) + "%" },
      { label: "CRE Mix: Other", term: "CRE Mix", value: creMix.other.toFixed(1) + "%" },
    )
  }
  if (row.trend?.length) {
    metrics.push(
      { label: "CRE Concentration (4Q)", value: row.trend.map((e) => `${formatQuarter(e.reportDate)}: ${e.creConcentration != null ? e.creConcentration.toFixed(1) + "%" : "—"}`).join("; ") },
      { label: "NPL Ratio (4Q)", value: row.trend.map((e) => `${formatQuarter(e.reportDate)}: ${e.nplRatio != null ? (e.nplRatio * 100).toFixed(1) + "%" : "—"}`).join("; ") },
    )
  }

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Target Screening List</h4>
      <div className="space-y-1.5 text-sm text-slate-700">
        {metrics.map((m) => (
          <p key={m.label} className={`flex justify-between ${m.className ?? ""}`}>
            <span className="text-slate-500"><DefTerm term={m.term ?? m.label}>{m.label}</DefTerm></span>
            <span className="font-medium tabular-nums text-right">{m.value}</span>
          </p>
        ))}
      </div>
    </div>
  )
}

function ComparisonTable({ rows, cohort, formatAssets, formatQuarter, formatDecimalPercent, formatMoney, formatPercentMetric, formatDeltaPercentPoints, formatRatio, getCreCapitalColor, onRemove }: {
  rows: InstitutionProfileRow[]
  cohort: InstitutionProfileRow[]
  asOfQuarter: string
  formatAssets: (v: number | undefined) => string
  formatQuarter: (d?: string) => string
  formatDecimalPercent: (v: number | undefined) => string
  formatMoney: (v: number | null | undefined) => string
  formatPercentMetric: (v: number | null | undefined, d?: number) => string
  formatDeltaPercentPoints: (v: number | null | undefined, d?: number) => string
  formatRatio: (v: number | null | undefined) => string
  getCreCapitalColor: (v: number | undefined) => string
  onRemove?: (id: string, reportDate?: string) => void
}) {
  // Once per cohort, not once per cell. See buildPeerCohort.
  const peerCohort = useMemo(() => buildPeerCohort(cohort), [cohort])

  const metricKeys: Array<{ key: string; fn: (r: InstitutionProfileRow) => string; section?: string }> = [
    { section: "Report", key: "Report", fn: (r) => formatQuarter(r.reportDate) },
    { section: "Location", key: "City, State", fn: (r) => `${r.city ?? "—"}, ${r.state ?? "—"}` },
    { key: "Total Assets", fn: (r) => formatAssets(r.totalAssets) },
    { section: "Target Screening List", key: "Total Loans", fn: (r) => formatMoney(r.totalLoans) },
    { key: "CRE Loans", fn: (r) => formatMoney(r.creLoans) },
    { key: "CRE Concentration", fn: (r) => r.creConcentration != null ? formatDecimalPercent(r.creConcentration / 100) : "—" },
    { key: "NPL ($)", fn: (r) => formatMoney(r.nonaccrualLoans) },
    { key: "NPL Ratio", fn: (r) => formatDecimalPercent(r.nplRatio) },
    { key: "Noncurrent / Loans", fn: (r) => formatDecimalPercent(r.noncurrent_to_loans_ratio) },
    { key: "Past Due 30-89 / Assets", fn: (r) => formatDecimalPercent(r.pastDue3090) },
    { key: "Past Due 90+ / Assets", fn: (r) => formatDecimalPercent(r.pastDue90Plus) },
    { key: "Reserve Coverage", fn: (r) => formatDecimalPercent(r.loanLossReserve) },
    { key: "CET1", fn: (r) => r.cet1Ratio != null ? formatPercentMetric(r.cet1Ratio, 1) : "—" },
    { key: "Leverage", fn: (r) => r.leverageRatio != null ? formatPercentMetric(r.leverageRatio, 1) : "—" },
    { key: "Total UC", fn: (r) => formatMoney(r.totalUnusedCommitments) },
    { key: "CRE UC", fn: (r) => formatMoney(r.creUnusedCommitments) },
    { section: "Structural Exposure", key: "CRE / Assets", fn: (r) => r.creConcentration != null ? r.creConcentration.toFixed(1) + "%" : "—" },
    { key: "CRE / Capital", fn: (r) => r.capitalRatios?.creToTier1Tier2 != null ? formatRatio(r.capitalRatios.creToTier1Tier2) : "—" },
    { key: "Capital", fn: (r) => r.cet1Ratio != null && r.cet1Ratio !== 0 ? r.cet1Ratio.toFixed(1) + "% (CET1)" : r.leverageRatio != null ? r.leverageRatio.toFixed(1) + "% (Leverage)" : "—" },
    { section: "Earnings", key: "ROA", fn: (r) => r.roaLatest != null ? r.roaLatest.toFixed(2) + "%" : "—" },
    { key: "Net Income (TTM)", fn: (r) => r.netIncomeTTM != null ? formatMoney(r.netIncomeTTM) : "—" },
    { key: "NIM", fn: (r) => r.nimLatest != null ? r.nimLatest.toFixed(2) + "%" : "—" },
    { key: "Earnings Buffer", fn: (r) => r.earningsBufferPct != null ? r.earningsBufferPct.toFixed(1) + "%" : "—" },
    // Peer rows come from the shared metric set, so this table can no longer
    // drift from the chart and the single-bank list above it — it had already
    // lost Net Income that way. The cohort arrays are built once here rather
    // than inside each cell renderer.
    ...peerCohort.map((metric, i) => ({
      section: i === 0 ? "Peer Positioning" : undefined,
      key: metric.label,
      fn: (r: InstitutionProfileRow) => {
        const pct = peerPercentile(r, metric)
        if (pct == null) return "—"
        return `${pct}th pct. — ${getPeerInterpretation(metric.label, pct)?.label ?? ""}`
      },
    })),
  ]

  let currentSection = ""
  return (
    <div className="overflow-auto max-h-[60vh]">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="sticky top-0 z-20 bg-white text-left py-2 pr-4 font-medium text-slate-600">Metric</th>
            {rows.map((r) => (
              <th key={`${r.id}-${r.reportDate}`} className="sticky top-0 z-20 bg-white text-left py-2 px-2 font-medium text-slate-700 min-w-[140px]">
                {r.name}{r.state ? ` (${r.state})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metricKeys.flatMap(({ key, fn, section }, idx) => {
            const out: React.ReactNode[] = []
            if (section && section !== currentSection) {
              currentSection = section
              out.push(
                <tr key={`section-${section}`} className="border-t border-slate-200">
                  <td colSpan={(rows.length ?? 0) + 1} className="py-2 pt-4 text-xs font-semibold uppercase tracking-wide text-primary">{section}</td>
                </tr>
              )
            }
            out.push(
              <tr key={`metric-${idx}-${section ?? ""}-${key}`} className="border-b border-slate-100">
                <td className="py-1.5 pr-4 text-slate-500"><DefTerm term={key}>{key}</DefTerm></td>
                {rows.map((r) => <td key={`${r.id}-${r.reportDate}`} className="py-1.5 px-2 tabular-nums">{fn(r)}</td>)}
              </tr>
            )
            return out
          })}
        </tbody>
      </table>
      {onRemove && rows.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-200">
          <p className="text-xs font-medium text-slate-600 mb-2">Remove from compare:</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <Button key={`${r.id}-${r.reportDate ?? "na"}`} variant="outline" size="sm" onClick={() => onRemove(r.id, r.reportDate)} className="text-slate-600 hover:text-red-600 hover:border-red-300">
                <X className="h-4 w-4 mr-1.5" />
                {r.name}{r.state ? ` (${r.state})` : ""}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Per-institution detail from Market Intelligence ──────────────────────────
//
// /api/mi/institution/<cert> → { trend, history, behavior }. Loaded when one
// bank is open in the drawer; the narrative (an OpenAI call upstream) is only
// requested when the user presses the button for it.

/** Call Report money is in $ thousands; show it as $K / $M / $B. */
function formatThousands(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—"
  // Sign first: "-$50.0M", not "$-50.0M" — unexplained exits go negative when
  // nonaccruals grow faster than the prior past-dues predicted.
  return (v < 0 ? "-" : "") + formatAssets(Math.abs(v) * 1000)
}

function formatPct(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return "—"
  return `${v.toFixed(decimals)}%`
}

const VERDICT_TONE: Record<string, string> = {
  stable: "border-emerald-200 bg-emerald-50 text-emerald-900",
  watch: "border-amber-200 bg-amber-50 text-amber-900",
  deteriorating: "border-red-200 bg-red-50 text-red-900",
}

// ── Trend charts ─────────────────────────────────────────────────────────────
//
// Small multiples over the quarters the API returns, one panel per theme. The
// series are the API's own fields; the panels only choose which to draw
// together. Reference lines mark the 2006 interagency CRE-concentration
// guidance (300% CRE / capital, 100% construction / capital) — supervisory
// thresholds, not anything computed here.

type TrendSeries = { key: Extract<keyof MiTrendQuarter, string>; label: string; color: string; decimals?: number }
type TrendPanel = { title: string; hint: string; series: TrendSeries[]; references?: Array<{ y: number; label: string }>; unit: "pct" | "usd" }

const TREND_PANELS: TrendPanel[] = [
  {
    title: "Asset quality",
    hint: "% of loans. Rising NPL and noncurrent with a flat reserve is the stress pattern.",
    unit: "pct",
    series: [
      { key: "nplPct", label: "NPL", color: "#dc2626" },
      { key: "noncurrentPct", label: "Noncurrent", color: "#f59e0b" },
      { key: "reservePct", label: "Reserve", color: "#0ea5e9" },
    ],
  },
  {
    title: "Capital",
    hint: "% ratios. Leverage for every filer; CET1 and total risk-based only for banks outside the CBLR framework.",
    unit: "pct",
    series: [
      { key: "leveragePct", label: "Leverage", color: "#0f766e", decimals: 1 },
      { key: "cet1Pct", label: "CET1", color: "#2563eb", decimals: 1 },
      { key: "totalRbcPct", label: "Total RBC", color: "#7c3aed", decimals: 1 },
    ],
  },
  {
    title: "CRE exposure",
    hint: "% of capital. Dashed lines are the interagency guidance thresholds (300% CRE, 100% construction).",
    unit: "pct",
    series: [
      { key: "creToCapitalPct", label: "CRE / capital", color: "#b45309", decimals: 0 },
      { key: "constructionToCapitalPct", label: "Construction / capital", color: "#d97706", decimals: 0 },
    ],
    references: [
      { y: 300, label: "300%" },
      { y: 100, label: "100%" },
    ],
  },
  {
    title: "Earnings",
    hint: "% of average assets (ROA) and of earning assets (NIM), annualised.",
    unit: "pct",
    series: [
      { key: "roaPct", label: "ROA", color: "#16a34a" },
      { key: "nimPct", label: "NIM", color: "#64748b" },
    ],
  },
]

/** Balance series from behavior.points — Call Report $ thousands. */
const BALANCE_SERIES: Array<{ key: string; label: string; color: string }> = [
  { key: "nonaccrualCre", label: "CRE nonaccrual", color: "#dc2626" },
  { key: "modificationsCre", label: "CRE modifications", color: "#f59e0b" },
  { key: "oreoCre", label: "CRE OREO", color: "#7c3aed" },
  { key: "heldForSale", label: "Held for sale", color: "#0ea5e9" },
]

const CHART_AXIS_TICK = { fontSize: 10, fill: "#64748b" }

function TrendPanelChart({ panel, points, leverageOnly }: { panel: TrendPanel; points: MiTrendQuarter[]; leverageOnly: boolean }) {
  // Drop a series the bank never reports (CBLR filers have no CET1 / total RBC)
  // rather than drawing an empty line and a dead legend entry.
  const series = panel.series.filter((s) => {
    if (leverageOnly && (s.key === "cet1Pct" || s.key === "totalRbcPct")) return false
    return points.some((p) => p[s.key] != null)
  })
  if (series.length === 0) return null
  const decimals = Math.max(...series.map((s) => s.decimals ?? 2))
  return (
    <div className="rounded-md border border-slate-200/80 p-3">
      <p className="text-xs font-semibold text-slate-700">{panel.title}</p>
      <p className="text-[11px] text-slate-500 leading-snug mb-1">{panel.hint}</p>
      <ResponsiveContainer width="100%" height={170} debounce={0}>
        <LineChart data={points} margin={{ top: 10, right: panel.references ? 34 : 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="label" tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${v}%`} domain={["auto", "auto"]} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              return (
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm text-xs">
                  <p className="font-medium text-slate-800 mb-1">{String(label)}</p>
                  {payload.map((item) => (
                    <div key={String(item.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
                      <span className="flex items-center gap-1.5 text-slate-600"><span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.name}</span>
                      <span className="tabular-nums">{formatPct(item.value as number | null, decimals)}</span>
                    </div>
                  ))}
                </div>
              )
            }}
          />
          <Legend verticalAlign="top" align="right" iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: "10px", color: "#475569", paddingBottom: "4px" }} />
          {panel.references?.map((r) => (
            <ReferenceLine key={r.y} y={r.y} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: r.label, position: "right", fontSize: 9, fill: "#94a3b8" }} />
          ))}
          {series.map((s) => (
            <Line key={s.key} type="monotone" name={s.label} dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: s.color }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function TrendCharts({ points, leverageOnly }: { points: MiTrendQuarter[]; leverageOnly: boolean }) {
  if (points.length < 2) return null
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {TREND_PANELS.map((panel) => <TrendPanelChart key={panel.title} panel={panel} points={points} leverageOnly={leverageOnly} />)}
    </div>
  )
}

function BalanceChart({ points }: { points: Array<Record<string, number | string | null>> }) {
  const series = BALANCE_SERIES.filter((s) => points.some((p) => typeof p[s.key] === "number" && (p[s.key] as number) !== 0))
  if (points.length < 2 || series.length === 0) return null
  return (
    <div className="rounded-md border border-slate-200/80 p-3">
      <p className="text-xs font-semibold text-slate-700">CRE problem-asset balances</p>
      <p className="text-[11px] text-slate-500 leading-snug mb-1">Quarter-end balances in dollars. Nonaccrual moving to OREO or held-for-sale is the bank acting; modifications building is pressure it has not yet acted on.</p>
      <ResponsiveContainer width="100%" height={190} debounce={0}>
        <LineChart data={points} margin={{ top: 10, right: 12, bottom: 0, left: -4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="label" tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={CHART_AXIS_TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => formatThousands(v)} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              return (
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm text-xs">
                  <p className="font-medium text-slate-800 mb-1">{String(label)}</p>
                  {payload.map((item) => (
                    <div key={String(item.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
                      <span className="flex items-center gap-1.5 text-slate-600"><span className="inline-block h-2 w-2 rounded-full" style={{ background: item.color }} />{item.name}</span>
                      <span className="tabular-nums">{formatThousands(item.value as number | null)}</span>
                    </div>
                  ))}
                </div>
              )
            }}
          />
          <Legend verticalAlign="top" align="right" iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: "10px", color: "#475569", paddingBottom: "4px" }} />
          {series.map((s) => (
            <Line key={s.key} type="monotone" name={s.label} dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: s.color }} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function RollForwardRow({ step, first }: { step: MiRollForwardStep; first: string }) {
  return (
    <TableRow>
      <TableCell className="py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap">{first}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatThousands(step.priorNonaccrual)}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatThousands(step.newNonaccrualProxy)}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatThousands(step.chargeOffs)}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatThousands(step.oreoTransferProxy)}</TableCell>
      <TableCell className={`py-1.5 text-xs tabular-nums text-right ${step.unexplainedExit > 0 ? "font-medium text-sky-800" : ""}`}>{formatThousands(step.unexplainedExit)}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right text-slate-500">{formatPct(step.unexplainedExitPctOfCre)}</TableCell>
      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatThousands(step.currentNonaccrual)}</TableCell>
    </TableRow>
  )
}

function RollForwardHeader() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="h-8 text-xs">Quarter</TableHead>
        <TableHead className="h-8 text-xs text-right">Prior nonaccrual</TableHead>
        <TableHead className="h-8 text-xs text-right">New (proxy)</TableHead>
        <TableHead className="h-8 text-xs text-right">Charge-offs</TableHead>
        <TableHead className="h-8 text-xs text-right">To OREO (proxy)</TableHead>
        <TableHead className="h-8 text-xs text-right">Unexplained exit</TableHead>
        <TableHead className="h-8 text-xs text-right">% of CRE</TableHead>
        <TableHead className="h-8 text-xs text-right">Current nonaccrual</TableHead>
      </TableRow>
    </TableHeader>
  )
}

export function InstitutionDetailSections({ cert }: { cert: string }) {
  const [meta, setMeta] = useState<MiMeta | null>(null)
  const [detail, setDetail] = useState<MiInstitution | null>(null)
  const [error, setError] = useState<{ title: string; detail: string } | null>(null)
  const [narrativeState, setNarrativeState] = useState<"idle" | "loading" | "error">("idle")

  useEffect(() => {
    let mounted = true
    setDetail(null)
    setError(null)
    setNarrativeState("idle")
    loadMiMeta().then((m) => { if (mounted) setMeta(m) }).catch(() => {})
    loadInstitution(cert)
      .then((d) => { if (mounted) setDetail(d) })
      .catch((err) => {
        if (!mounted) return
        const mi = err instanceof MiError ? err : null
        setError({ title: mi && !mi.unavailable ? "Could not load institution detail" : MI_UNAVAILABLE_TITLE, detail: err instanceof Error ? err.message : String(err) })
      })
    return () => { mounted = false }
  }, [cert])

  const signalDefs = useMemo(() => signalsByKey(meta), [meta])

  const loadNarrative = useCallback(async () => {
    setNarrativeState("loading")
    try {
      const d = await loadInstitution(cert, { narrative: true })
      setDetail(d)
      setNarrativeState("idle")
    } catch {
      setNarrativeState("error")
    }
  }, [cert])

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 text-sm" role="alert">
        <p className="font-semibold text-red-800">{error.title}</p>
        <p className="text-red-700/80 text-xs mt-0.5">{error.detail}</p>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-primary">Loading institution detail…</h4>
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-4 rounded" />)}
      </div>
    )
  }

  const { trend, history, behavior, narrative } = detail
  const fired = behavior?.latest?.fired ?? []
  const verdictTone = VERDICT_TONE[trend?.verdict?.tone ?? ""] ?? "border-slate-200 bg-slate-50 text-slate-800"

  return (
    <>
      {/* Trend — eight quarters */}
      {trend && (
        <Card className="border-slate-200/80 shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-primary">Trend — {trend.points.length} quarters</CardTitle>
            <CardDescription className="text-xs">
              {trend.leverageOnly ? "Files under the Community Bank Leverage Ratio framework: leverage is the only capital ratio reported." : "Capital, asset quality and earnings by quarter."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className={`rounded-md border px-3 py-2 text-xs ${verdictTone}`}>
              <span className="font-semibold">{trend.verdict.heading}.</span> {trend.verdict.text}
            </div>
            <TrendCharts points={trend.points} leverageOnly={trend.leverageOnly} />
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8 text-xs">Quarter</TableHead>
                    <TableHead className="h-8 text-xs text-right">NPL</TableHead>
                    <TableHead className="h-8 text-xs text-right">Noncurrent</TableHead>
                    <TableHead className="h-8 text-xs text-right">Leverage</TableHead>
                    {!trend.leverageOnly && <TableHead className="h-8 text-xs text-right">CET1</TableHead>}
                    <TableHead className="h-8 text-xs text-right">CRE / Capital</TableHead>
                    <TableHead className="h-8 text-xs text-right">Const / Capital</TableHead>
                    <TableHead className="h-8 text-xs text-right">Reserve</TableHead>
                    <TableHead className="h-8 text-xs text-right">ROA</TableHead>
                    <TableHead className="h-8 text-xs text-right">NIM</TableHead>
                    <TableHead className="h-8 text-xs">Capital</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trend.points.map((p) => (
                    <TableRow key={p.quarter}>
                      <TableCell className="py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap">{p.label}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.nplPct)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.noncurrentPct)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.leveragePct, 1)}</TableCell>
                      {!trend.leverageOnly && <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.cet1Pct, 1)}</TableCell>}
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.creToCapitalPct, 0)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.constructionToCapitalPct, 0)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.reservePct)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.roaPct)}</TableCell>
                      <TableCell className="py-1.5 text-xs tabular-nums text-right">{formatPct(p.nimPct)}</TableCell>
                      <TableCell className="py-1.5 text-xs text-slate-600 whitespace-nowrap">{p.capital?.label ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Acquisition history */}
      <Card className="border-slate-200/80 shadow-none">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-primary">Acquisition History</CardTitle>
          <CardDescription className="text-xs">Institutions this bank has absorbed, per FDIC structure records.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {history?.acquisitions?.length ? (
            <ul className="space-y-1 text-sm text-slate-700">
              {history.acquisitions.map((a) => (
                <li key={`${a.date}-${a.absorbedCert}`} className="flex gap-3">
                  <span className="tabular-nums text-slate-500 shrink-0">{a.date}</span>
                  <span>{a.description} <span className="text-slate-400 text-xs">(CERT {a.absorbedCert})</span></span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No acquisitions on record.</p>
          )}
        </CardContent>
      </Card>

      {/* Balance-Sheet Actions */}
      {behavior && (
        <Card className="border-slate-200/80 shadow-none">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-primary">Balance-Sheet Actions</CardTitle>
            <CardDescription className="text-xs">
              What the bank did with its CRE book in {behavior.latest?.quarter ? formatQuarter(behavior.latest.quarter) : "the latest quarter"}: signals that fired, the nonaccrual roll-forward, and a plain-language reading. Dollar figures are Call Report values.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-4">
            <div>
              <p className="text-[11px] font-medium text-slate-500 mb-1.5">Signals fired this quarter</p>
              {fired.length === 0 ? (
                <p className="text-sm text-slate-500">None.{behavior.latest?.unjudged?.length ? ` ${behavior.latest.unjudged.length} signal${behavior.latest.unjudged.length === 1 ? "" : "s"} could not be judged for this bank.` : ""}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {fired.map((key) => {
                    const def = signalDefs.get(key)
                    return (
                      <span key={key} title={def?.rule ?? key}
                        className={`inline-flex flex-col rounded-md border px-2.5 py-1.5 text-xs leading-tight ${def?.side === "pressure" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-sky-300 bg-sky-50 text-sky-900"}`}>
                        <span className="font-semibold">{def?.label ?? key}</span>
                        {def && <span className="text-[10px] opacity-80">{def.meaning}</span>}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>

            {behavior.reading?.text && (
              <div className="space-y-2 text-sm text-slate-700 leading-relaxed">
                {behavior.reading.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              </div>
            )}

            {behavior.points?.length > 0 && <BalanceChart points={behavior.points} />}

            {behavior.rollForward?.length > 0 && (
              <div>
                <p className="text-[11px] font-medium text-slate-500 mb-1.5">CRE nonaccrual roll-forward</p>
                <div className="overflow-x-auto">
                  <Table>
                    <RollForwardHeader />
                    <TableBody>
                      {behavior.rollForward.map((s) => <RollForwardRow key={s.quarter} step={s} first={s.label} />)}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {behavior.latestByCategory?.length > 0 && (
              <div>
                <p className="text-[11px] font-medium text-slate-500 mb-1.5">Latest quarter by CRE category</p>
                <div className="overflow-x-auto">
                  <Table>
                    <RollForwardHeader />
                    <TableBody>
                      {behavior.latestByCategory.map((c) => <RollForwardRow key={c.category} step={c.step} first={c.label} />)}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            <div className="pt-1">
              {narrative?.text ? (
                <div>
                  <p className="text-[11px] font-medium text-slate-500 mb-1.5">Narrative</p>
                  <div className="space-y-2 text-sm text-slate-700 leading-relaxed">
                    {narrative.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={loadNarrative} disabled={narrativeState === "loading"}>
                    {narrativeState === "loading" ? "Writing narrative…" : "Generate narrative"}
                  </Button>
                  <span className="text-[11px] text-slate-500">
                    {narrativeState === "error" ? "Narrative unavailable right now." : "Asks Market Intelligence to write an eight-quarter summary (uses an LLM call)."}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )
}
