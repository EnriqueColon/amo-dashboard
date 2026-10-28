/**
 * The registered tier's quarterly story: money in, money out, and what the
 * portfolio is doing underneath.
 *
 * This is the half of the brief that only exists for vehicles filing periodic
 * reports — "evergreen fund liquidity" and "portfolio performance, particularly
 * signs of stress". Every private fund in the registry reports none of it, at
 * any point in its life, so these panels cover the national layer and say so
 * plainly everywhere else rather than rendering an empty chart.
 *
 * Pure: series in, rows and aggregates out.
 */

import type { QuarterPoint } from "./xbrl"
import type { VehicleQuotation } from "./registry"

/**
 * Eight quarters, matching the institution drawer's trend window — long enough
 * to see a turn, short enough to keep the cached payload small. The series are
 * trimmed to this before being stored, because a full history for twelve
 * vehicles across eight metrics would add most of a megabyte to an entry that
 * is otherwise 144 KB.
 */
export const PEER_TREND_QUARTERS = 8

/** One registered vehicle's trimmed series, as the client receives them. */
export type VehicleTrend = {
  cik: string
  peerId: string
  manager: string
  vehicleName: string
  quoted?: VehicleQuotation
  /** Quarterly series, trimmed to the trailing window. Absent when not tagged. */
  series: Partial<Record<string, QuarterPoint[]>>
  /** Capital in less capital out. Empty for a listed vehicle, where it would mislead. */
  netFlow: QuarterPoint[]
  /** Metric keys this filer tags under no candidate concept. */
  missingMetrics: string[]
}

function trim(points: readonly QuarterPoint[] | undefined, count: number): QuarterPoint[] {
  return points ? points.slice(-count) : []
}

/**
 * Payment-in-kind income as a share of investment income, per quarter.
 *
 * Derived rather than reported, and the more useful form: PIK rising in dollars
 * while a book grows says little, but PIK taking a larger share of income is
 * the sign that borrowers are paying in paper instead of cash. Null in any
 * quarter where either side is missing.
 */
export function pikShareSeries(
  pik: readonly QuarterPoint[] | undefined,
  income: readonly QuarterPoint[] | undefined
): QuarterPoint[] {
  if (!pik?.length || !income?.length) return []
  const incomeByEnd = new Map(income.map((p) => [p.end, p.value]))
  return pik.map((p) => {
    const total = incomeByEnd.get(p.end)
    const share = p.value != null && total != null && total > 0 ? p.value / total : null
    return { end: p.end, label: p.label, value: share }
  })
}

/** Trim one vehicle's metrics for storage, and derive the PIK share. */
export function buildVehicleTrend(
  source: {
    cik: string
    manager: string
    vehicleName: string
    quoted?: VehicleQuotation
    series: Record<string, QuarterPoint[]>
    netFlow: QuarterPoint[]
    missingMetrics: string[]
  },
  peerId: string,
  quarters = PEER_TREND_QUARTERS
): VehicleTrend {
  const series: Partial<Record<string, QuarterPoint[]>> = {}
  for (const [key, points] of Object.entries(source.series)) {
    const trimmed = trim(points, quarters)
    if (trimmed.length) series[key] = trimmed
  }
  const share = pikShareSeries(source.series.pikIncome, source.series.investmentIncome)
  if (share.length) series.pikShare = trim(share, quarters)

  return {
    cik: source.cik,
    peerId,
    manager: source.manager,
    vehicleName: source.vehicleName,
    ...(source.quoted ? { quoted: source.quoted } : {}),
    series,
    netFlow: trim(source.netFlow, quarters),
    missingMetrics: source.missingMetrics,
  }
}

function latest(points: readonly QuarterPoint[]): QuarterPoint | undefined {
  return [...points].reverse().find((p) => p.value != null)
}

function valueAt(points: readonly QuarterPoint[] | undefined, end: string): number | null {
  return points?.find((p) => p.end === end)?.value ?? null
}

export type LiquidityRow = {
  cik: string
  peerId: string
  manager: string
  vehicleName: string
  /** The newest quarter with a usable net flow. */
  quarter: string | null
  label: string | null
  subscriptions: number | null
  repurchases: number | null
  netFlow: number | null
  /** Repurchases as a share of investments at fair value, when the portfolio is reported. */
  redemptionShare: number | null
  /** Consecutive quarters of net outflow ending at the newest. */
  outflowStreak: number
  /** Net flow across the whole window, which a single quarter can misrepresent. */
  windowNetFlow: number | null
}

/**
 * One row per non-traded vehicle, newest outflow first.
 *
 * Listed vehicles are excluded entirely rather than shown as blanks: for them
 * share repurchases are a buyback and issuance an equity raise, so a "net flow"
 * would read as investor demand when it is a capital-markets decision. That
 * distinction is in `PeerVehicle.quoted`.
 */
export function liquidityRows(trends: readonly VehicleTrend[]): LiquidityRow[] {
  return trends
    .filter((t) => t.quoted === "non-traded" && t.netFlow.length > 0)
    .map((t) => {
      const newest = latest(t.netFlow)
      const end = newest?.end ?? null
      const flows = t.netFlow.filter((p) => p.value != null)

      let streak = 0
      for (let i = flows.length - 1; i >= 0; i--) {
        if ((flows[i].value as number) < 0) streak++
        else break
      }

      const repurchases = end ? valueAt(t.series.repurchases, end) : null
      const portfolio = end ? valueAt(t.series.investmentsAtFairValue, end) : null

      return {
        cik: t.cik,
        peerId: t.peerId,
        manager: t.manager,
        vehicleName: t.vehicleName,
        quarter: end,
        label: newest?.label ?? null,
        subscriptions: end ? valueAt(t.series.subscriptions, end) : null,
        repurchases,
        netFlow: newest?.value ?? null,
        redemptionShare: repurchases != null && portfolio != null && portfolio > 0 ? repurchases / portfolio : null,
        outflowStreak: streak,
        windowNetFlow: flows.length ? flows.reduce((a, p) => a + (p.value as number), 0) : null,
      }
    })
    .sort((a, b) => (a.netFlow ?? 0) - (b.netFlow ?? 0))
}

/**
 * Is this series actually a net asset value?
 *
 * A NAV per share moves, because the portfolio under it moves. A figure that is
 * byte-identical across every quarter reported is something else tagged under
 * the same concept — a par value, or a class's fixed subscription price. HPS
 * Corporate Lending Fund tags exactly 1000.00 in six consecutive filings while
 * its real NAV is around $25, and rendering that beside a peer's $24.62 would
 * tell a reader its NAV is forty times its peers'.
 *
 * So a constant series is reported as not available, with the reason, rather
 * than shown or silently dropped. Requires three points before judging: two
 * identical quarters is a coincidence, not a pattern.
 */
export function looksLikeNav(points: readonly QuarterPoint[] | undefined): boolean {
  const values = (points ?? []).map((p) => p.value).filter((v): v is number => v != null)
  if (values.length < 3) return values.length > 0
  return new Set(values).size > 1
}

export type PortfolioRow = {
  cik: string
  peerId: string
  manager: string
  vehicleName: string
  quoted?: VehicleQuotation
  quarter: string | null
  label: string | null
  investments: number | null
  /** Change over the window, as a share of the earliest balance in it. */
  investmentsChange: number | null
  pikShare: number | null
  /** Change in the PIK share over the window, in percentage points. */
  pikShareChange: number | null
  navPerShare: number | null
  /**
   * Set when a NAV series was present but rejected as constant — so the panel
   * can say "reported but not a NAV" rather than "not reported", which are
   * different facts about the filer.
   */
  navRejected?: boolean
  unrealised: number | null
  /** Metrics this filer does not tag, so a panel can name them rather than show blanks. */
  notReported: string[]
}

/**
 * One row per registered vehicle, whether listed or not.
 *
 * Unlike the liquidity rows, these figures mean the same thing for both kinds:
 * a shrinking book and a rising payment-in-kind share are the same signal in a
 * listed REIT as in a non-traded BDC.
 */
export function portfolioRows(trends: readonly VehicleTrend[]): PortfolioRow[] {
  return trends
    .map((t) => {
      const investments = t.series.investmentsAtFairValue ?? []
      const newestInv = latest(investments)
      const present = investments.filter((p) => p.value != null)
      const earliest = present[0]
      const change =
        newestInv?.value != null && earliest?.value != null && earliest.value > 0 && earliest.end !== newestInv.end
          ? (newestInv.value - earliest.value) / earliest.value
          : null

      const shares = (t.series.pikShare ?? []).filter((p) => p.value != null)
      const pikNow = shares[shares.length - 1]?.value ?? null
      const pikThen = shares.length > 1 ? shares[0].value : null
      const navSeries = t.series.navPerShare ?? []
      const navUsable = looksLikeNav(navSeries)
      const navPoint = navUsable ? latest(navSeries) : undefined
      const unrealisedPoint = latest(t.series.unrealizedGainLoss ?? [])

      return {
        cik: t.cik,
        peerId: t.peerId,
        manager: t.manager,
        vehicleName: t.vehicleName,
        ...(t.quoted ? { quoted: t.quoted } : {}),
        quarter: newestInv?.end ?? navPoint?.end ?? null,
        label: newestInv?.label ?? navPoint?.label ?? null,
        investments: newestInv?.value ?? null,
        investmentsChange: change,
        pikShare: pikNow,
        pikShareChange: pikNow != null && pikThen != null ? (pikNow - pikThen) * 100 : null,
        navPerShare: navPoint?.value ?? null,
        ...(navSeries.length && !navUsable ? { navRejected: true } : {}),
        unrealised: unrealisedPoint?.value ?? null,
        notReported: t.missingMetrics,
      }
    })
    .sort((a, b) => (b.investments ?? -1) - (a.investments ?? -1))
}

export type FlowAggregate = {
  /** Per quarter, oldest first, summed across every non-traded vehicle. */
  points: Array<{ end: string; label: string; subscriptions: number | null; repurchases: number | null; netFlow: number | null; vehicles: number }>
  /** The newest quarter in which at least one vehicle reported both sides. */
  newest: { end: string; label: string; subscriptions: number | null; repurchases: number | null; netFlow: number | null; vehicles: number } | null
  /** Non-traded vehicles contributing, and how many are in net outflow in the newest quarter. */
  contributing: number
  inOutflow: number
}

/**
 * Capital in and out across the whole non-traded tier, per quarter.
 *
 * The single most useful figure the registered tier produces, and the one the
 * brief's "evergreen fund liquidity" ask is really after: whether the
 * semi-liquid complex is taking money in or paying it out. Each quarter counts
 * only the vehicles that reported both sides of it, and says how many those
 * were, so a quarter where half the tier has not filed cannot read as a
 * collapse in flows.
 */
export function aggregateNetFlow(trends: readonly VehicleTrend[]): FlowAggregate {
  const nonTraded = trends.filter((t) => t.quoted === "non-traded")
  const byEnd = new Map<string, { label: string; subs: number; reps: number; vehicles: number }>()

  for (const trend of nonTraded) {
    for (const point of trend.netFlow) {
      if (point.value == null) continue
      const subs = valueAt(trend.series.subscriptions, point.end)
      const reps = valueAt(trend.series.repurchases, point.end)
      if (subs == null || reps == null) continue
      const held = byEnd.get(point.end) ?? { label: point.label, subs: 0, reps: 0, vehicles: 0 }
      held.subs += subs
      held.reps += reps
      held.vehicles += 1
      byEnd.set(point.end, held)
    }
  }

  const points = [...byEnd.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([end, v]) => ({
      end,
      label: v.label,
      subscriptions: v.subs,
      repurchases: v.reps,
      netFlow: v.subs - v.reps,
      vehicles: v.vehicles,
    }))

  const newest = points[points.length - 1] ?? null
  const inOutflow = newest
    ? nonTraded.filter((t) => (valueAt(t.netFlow, newest.end) ?? 0) < 0).length
    : 0

  return { points, newest, contributing: nonTraded.length, inOutflow }
}
