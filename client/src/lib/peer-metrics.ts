/**
 * Peer positioning: ranking one bank against a cohort.
 *
 * This module holds the SINGLE definition of which metrics are ranked and which
 * direction each one points. It is deliberately pure — no React, no recharts —
 * so the direction rules can be asserted by a guardrail
 * (`script/check-metric-directions.ts`) without rendering anything.
 *
 * ── Why direction gets its own module ────────────────────────────────────────
 * A percentile is a number with no inherent polarity. Whether the 90th
 * percentile should be coloured red or green depends entirely on the metric:
 * high NPL is stress, high NIM is strength. When that polarity is decided
 * separately at each place a metric is displayed, the copies drift and one of
 * them ends up inverted — showing the safest banks as the most stressed. The fix
 * is structural: one metric list, one threshold table, everything reads from it.
 */

/** The subset of an institution row that peer ranking needs. */
export type PeerRow = {
  creConcentration?: number
  nplRatio?: number
  netIncomeTTM?: number | null
  nimLatest?: number | null
}

/**
 * Percentile of `value` within `values` — the share of the cohort strictly below
 * it. Order-independent, so `values` need not be sorted.
 */
export function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 0
  const below = values.filter((v) => v < value).length
  return Math.round((below / values.length) * 100)
}

/**
 * direction is the contract each threshold table must satisfy:
 *   'high-risk' a high percentile means MORE stress/exposure. Red at the top,
 *               green at the bottom. (Bad for the bank, interesting as a target.)
 *   'high-good' a high percentile means STRONGER performance. Green at the top,
 *               red at the bottom.
 *
 * It is documentation for whoever writes the colours below AND the property the
 * guardrail checks them against — so a table whose colours contradict its stated
 * direction fails the build rather than silently shipping inverted.
 */
export type PeerDirection = 'high-risk' | 'high-good'

export type PeerMetricMeta = {
  direction: PeerDirection
  /** Descending by `min`. First match wins. */
  thresholds: Array<{ min: number; label: string; colorClass: string }>
  hint: string
}

export const PEER_META: Record<string, PeerMetricMeta> = {
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
      { min: 0,  label: 'Underperformer',  colorClass: 'bg-red-50 text-red-600 border-red-200' },
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

export function getPeerInterpretation(metric: string, pct: number) {
  const meta = PEER_META[metric]
  if (!meta) return null
  for (const t of meta.thresholds) {
    if (pct >= t.min) return { label: t.label, colorClass: t.colorClass }
  }
  return null
}

/**
 * The metric set, in display order. Every peer-positioning surface iterates this
 * — the single-bank list, the comparison chart, and the comparison table — so a
 * metric added here appears in all three. Adding it to one by hand is how the
 * comparison table came to be missing Net Income.
 */
export const PEER_METRICS: Array<{
  label: string
  value: (r: PeerRow) => number | null | undefined
}> = [
  { label: 'CRE / Assets', value: (r) => r.creConcentration },
  { label: 'NPL Ratio',    value: (r) => r.nplRatio },
  { label: 'Net Income',   value: (r) => r.netIncomeTTM },
  { label: 'NIM',          value: (r) => r.nimLatest },
]

export type PeerCohortMetric = {
  label: string
  hint: string
  values: number[]
  valueFor: (r: PeerRow) => number | null | undefined
}

/**
 * Collect each metric's cohort values ONCE.
 *
 * The cost of getting this wrong is not subtle: the comparison table used to
 * rebuild the whole cohort array inside its per-bank cell renderer, making the
 * work metrics x compared-banks x cohort-size on every render — a few thousand
 * banks rescanned for each column, producing numbers identical in every column.
 */
export function buildPeerCohort(cohort: PeerRow[]): PeerCohortMetric[] {
  return PEER_METRICS.map(({ label, value }) => ({
    label,
    hint: PEER_META[label].hint,
    valueFor: value,
    values: cohort
      .map(value)
      .filter((v): v is number => v != null && Number.isFinite(v)),
  }))
}

/** Percentile of one bank on one metric, or null when the bank lacks the value. */
export function peerPercentile(row: PeerRow, metric: PeerCohortMetric): number | null {
  const v = metric.valueFor(row)
  return v != null && Number.isFinite(v) ? percentileRank(v, metric.values) : null
}
