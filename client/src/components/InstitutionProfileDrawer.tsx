import { useCallback, useMemo, useState } from "react"
import { Copy, X } from "lucide-react"
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "@/hooks/use-toast"
import {
  formatMoney,
  formatCapitalMultiple,
  formatPercent as formatPercentMetric,
  formatDeltaPercentPoints,
  formatMultiple as formatMultipleMetric,
} from "@/lib/metrics"
import { getCreCapitalColor } from "@/lib/score-colors"
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

function percentileRank(value: number, sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0
  const below = sortedValues.filter((v) => v < value).length
  return Math.round((below / sortedValues.length) * 100)
}

// ── Peer metric interpretation config ────────────────────────────────────────
// direction: 'high-risk' = high percentile means MORE stress/exposure (bad for bank, good PE target)
//            'high-good' = high percentile means stronger performance (good for bank, bad PE target)
type PeerMetricMeta = {
  direction: 'high-risk' | 'high-good'
  thresholds: Array<{ min: number; label: string; colorClass: string }>
  hint: string // shown below label in the section header
}

const PEER_META: Record<string, PeerMetricMeta> = {
  'CRE / Assets': {
    direction: 'high-risk',
    hint: 'High percentile = more CRE-concentrated than peers → elevated exposure',
    thresholds: [
      { min: 75, label: 'High Exposure',   colorClass: 'bg-red-50 text-red-600 border-red-200' },
      { min: 50, label: 'Moderate',        colorClass: 'bg-amber-50 text-amber-600 border-amber-200' },
      { min: 25, label: 'Below Average',   colorClass: 'bg-slate-50 text-slate-500 border-slate-200' },
      { min: 0,  label: 'Low Exposure',    colorClass: 'bg-green-50 text-green-600 border-green-200' },
    ],
  },
  'NPL Ratio': {
    direction: 'high-risk',
    hint: 'High percentile = more problem loans than peers → increased credit stress',
    thresholds: [
      { min: 75, label: 'Elevated Stress',  colorClass: 'bg-red-50 text-red-600 border-red-200' },
      { min: 50, label: 'Above Average',    colorClass: 'bg-amber-50 text-amber-600 border-amber-200' },
      { min: 25, label: 'Below Average',    colorClass: 'bg-slate-50 text-slate-500 border-slate-200' },
      { min: 0,  label: 'Clean Book',       colorClass: 'bg-green-50 text-green-600 border-green-200' },
    ],
  },
  'Net Income': {
    direction: 'high-good',
    hint: 'High percentile = more profitable than peers → less likely to sell at discount',
    thresholds: [
      { min: 75, label: 'Top Performer',   colorClass: 'bg-green-50 text-green-600 border-green-200' },
      { min: 50, label: 'Above Average',   colorClass: 'bg-slate-50 text-slate-500 border-slate-200' },
      { min: 25, label: 'Below Average',   colorClass: 'bg-amber-50 text-amber-600 border-amber-200' },
      { min: 0,  label: 'Underperformer', colorClass: 'bg-red-50 text-red-600 border-red-200' },
    ],
  },
  'NIM': {
    direction: 'high-good',
    hint: 'High percentile = wider net interest margin than peers → healthier spread income',
    thresholds: [
      { min: 75, label: 'High Margin',     colorClass: 'bg-green-50 text-green-600 border-green-200' },
      { min: 50, label: 'Average',         colorClass: 'bg-slate-50 text-slate-500 border-slate-200' },
      { min: 25, label: 'Thin Margin',     colorClass: 'bg-amber-50 text-amber-600 border-amber-200' },
      { min: 0,  label: 'Compressed',      colorClass: 'bg-red-50 text-red-600 border-red-200' },
    ],
  },
}

function getPeerInterpretation(metric: string, pct: number) {
  const meta = PEER_META[metric]
  if (!meta) return null
  for (const t of meta.thresholds) {
    if (pct >= t.min) return { label: t.label, colorClass: t.colorClass }
  }
  return null
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
    coverage: { hasTier1Tier2: boolean }
  }
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

    const creAssetsValues = cohort.map((r) => r.creConcentration).filter((v): v is number => v != null && Number.isFinite(v))
    const nplValues = cohort.map((r) => r.nplRatio).filter((v): v is number => v != null && Number.isFinite(v))
    const netIncomeValues = cohort.map((r) => r.netIncomeTTM).filter((v): v is number => v != null && Number.isFinite(v))
    const nimValues = cohort.map((r) => r.nimLatest).filter((v): v is number => v != null && Number.isFinite(v))

    const creAssetsPct = rowForCopy.creConcentration != null ? percentileRank(rowForCopy.creConcentration, creAssetsValues) : "—"
    const nplPct = rowForCopy.nplRatio != null ? percentileRank(rowForCopy.nplRatio, nplValues) : "—"
    const netIncomePct = rowForCopy.netIncomeTTM != null ? percentileRank(rowForCopy.netIncomeTTM, netIncomeValues) : "—"
    const nimPct = rowForCopy.nimLatest != null ? percentileRank(rowForCopy.nimLatest, nimValues) : "—"

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
      `CRE / Assets: ${creAssetsPct === "—" ? "—" : `${creAssetsPct}th pct. — ${getPeerInterpretation('CRE / Assets', creAssetsPct as number)?.label ?? ""} (↑ high = more concentrated)`}`,
      `NPL Ratio: ${nplPct === "—" ? "—" : `${nplPct}th pct. — ${getPeerInterpretation('NPL Ratio', nplPct as number)?.label ?? ""} (↑ high = more stressed)`}`,
      `Net Income: ${netIncomePct === "—" ? "—" : `${netIncomePct}th pct. — ${getPeerInterpretation('Net Income', netIncomePct as number)?.label ?? ""} (↑ high = more profitable)`}`,
      `NIM: ${nimPct === "—" ? "—" : `${nimPct}th pct. — ${getPeerInterpretation('NIM', nimPct as number)?.label ?? ""} (↑ high = wider margin)`}`,
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
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-primary mb-1">Peer Positioning</h4>
                    <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">
                      Ranked within the selected cohort.&nbsp;
                      <span className="text-red-500 font-medium">Red = stress indicator</span> · <span className="text-green-600 font-medium">Green = strength indicator</span>
                    </p>
                    <div className="space-y-2 text-sm text-slate-700">
                      {(() => {
                        const creVals = cohort.map((r) => r.creConcentration).filter((v): v is number => v != null && Number.isFinite(v))
                        const nplVals = cohort.map((r) => r.nplRatio).filter((v): v is number => v != null && Number.isFinite(v))
                        const niVals  = cohort.map((r) => r.netIncomeTTM).filter((v): v is number => v != null && Number.isFinite(v))
                        const nimVals = cohort.map((r) => r.nimLatest).filter((v): v is number => v != null && Number.isFinite(v))
                        const rows2 = [
                          { label: 'CRE / Assets', hint: PEER_META['CRE / Assets'].hint, pct: rowForCopy.creConcentration != null ? percentileRank(rowForCopy.creConcentration, creVals) : null },
                          { label: 'NPL Ratio',    hint: PEER_META['NPL Ratio'].hint,    pct: rowForCopy.nplRatio != null      ? percentileRank(rowForCopy.nplRatio, nplVals) : null },
                          { label: 'Net Income',   hint: PEER_META['Net Income'].hint,   pct: rowForCopy.netIncomeTTM != null  ? percentileRank(rowForCopy.netIncomeTTM, niVals) : null },
                          { label: 'NIM',          hint: PEER_META['NIM'].hint,          pct: rowForCopy.nimLatest != null     ? percentileRank(rowForCopy.nimLatest, nimVals) : null },
                        ]
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
    const creAssetsValues = cohort.map((r) => r.creConcentration).filter((v): v is number => v != null && Number.isFinite(v))
    const nplValues = cohort.map((r) => r.nplRatio).filter((v): v is number => v != null && Number.isFinite(v))
    const netIncomeValues = cohort.map((r) => r.netIncomeTTM).filter((v): v is number => v != null && Number.isFinite(v))
    const nimValues = cohort.map((r) => r.nimLatest).filter((v): v is number => v != null && Number.isFinite(v))

    const metricRows: Array<{ metric: string; valueForRow: (r: InstitutionProfileRow) => number | null }> = [
      { metric: "CRE / Assets", valueForRow: (r) => r.creConcentration != null ? percentileRank(r.creConcentration, creAssetsValues) : null },
      { metric: "NPL Ratio", valueForRow: (r) => r.nplRatio != null ? percentileRank(r.nplRatio, nplValues) : null },
      { metric: "Net Income", valueForRow: (r) => r.netIncomeTTM != null ? percentileRank(r.netIncomeTTM, netIncomeValues) : null },
      { metric: "NIM", valueForRow: (r) => r.nimLatest != null ? percentileRank(r.nimLatest, nimValues) : null },
    ]

    return metricRows.map(({ metric, valueForRow }) => {
      const out: Record<string, string | number | null> = { metric }
      chartSeries.forEach((series) => { out[series.key] = valueForRow(series.row) })
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
    { section: "Peer Positioning", key: "CRE / Assets", fn: (r) => { const pct = r.creConcentration != null ? percentileRank(r.creConcentration, cohort.map((c) => c.creConcentration).filter((v): v is number => v != null && Number.isFinite(v))) : null; if (pct == null) return "—"; const i = getPeerInterpretation('CRE / Assets', pct); return `${pct}th pct. — ${i?.label ?? ""}`; } },
    { key: "NPL Ratio", fn: (r) => { const pct = r.nplRatio != null ? percentileRank(r.nplRatio, cohort.map((c) => c.nplRatio).filter((v): v is number => v != null && Number.isFinite(v))) : null; if (pct == null) return "—"; const i = getPeerInterpretation('NPL Ratio', pct); return `${pct}th pct. — ${i?.label ?? ""}`; } },
    { key: "NIM", fn: (r) => { const pct = r.nimLatest != null ? percentileRank(r.nimLatest, cohort.map((c) => c.nimLatest).filter((v): v is number => v != null && Number.isFinite(v))) : null; if (pct == null) return "—"; const i = getPeerInterpretation('NIM', pct); return `${pct}th pct. — ${i?.label ?? ""}`; } },
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
