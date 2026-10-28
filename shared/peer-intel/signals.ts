/**
 * Peer signals: what a competitor is actually doing, judged on its own history.
 *
 * The same acceptance rule as the bank-behaviour signals
 * (`lib/analytics/bank-behavior-signals.ts`): a manager must produce **identical
 * signals in the Miami-Dade, Florida and national layers**. So every rule fires
 * on absolute floors and the manager's own trail, never on where it sits among
 * peers. Layer percentiles are context for the reader and inputs to ranking;
 * they can never change whether a signal fires. That is what makes three
 * cumulative layers coherent rather than three different verdicts on one firm.
 *
 * Thresholds are gathered in `PEER_SIGNAL_THRESHOLDS` so they can be moved in
 * one place. They are starting proposals: unlike the bank signals, there is no
 * backtest here, because there is no public record of which managers were
 * "right" to be raising. They are deliberately conservative — a signal that
 * fires on half the cohort tells you nothing.
 *
 * Every input is null-safe: a missing figure leaves a signal **unjudged**, which
 * is a third state distinct from fired and quiet. A manager who does not tag
 * payment-in-kind income (ten of the twelve registered vehicles) has no PIK
 * signal, not a quiet one.
 */

import type { ManagerRaises, VehicleRaise } from "./cohort"
import type { QuarterPoint } from "./xbrl"
import type { VehicleQuotation } from "./registry"

export type PeerSignalKey =
  | "raiseStalled"
  | "targetCut"
  | "raiseAccelerating"
  | "newVehicle"
  | "redemptionAcceleration"
  | "netOutflow"
  | "pikBuild"
  | "portfolioShrink"

/**
 * `fundraising` signals read the Form D trail and are available for every peer.
 * `liquidity` and `portfolio` signals need periodic reports, so they exist only
 * for the registered tier — and the liquidity ones only for non-traded
 * vehicles, where repurchases mean investors being paid out rather than a
 * buyback.
 */
export type PeerSignalFamily = "fundraising" | "liquidity" | "portfolio"

/** `pressure` is a condition worth watching; `action` is the manager doing something. */
export type PeerSignalSide = "action" | "pressure"

export type PeerSignalSpec = {
  key: PeerSignalKey
  label: string
  family: PeerSignalFamily
  side: PeerSignalSide
  /** What it means for a reader deciding where to spend attention. */
  meaning: string
  /** The firing rule in words, for the chip's tooltip. */
  rule: string
}

export const PEER_SIGNAL_THRESHOLDS = {
  /** Quarters of silence after which an unmet raise reads as stalled. */
  stalledQuarters: 4,
  /**
   * Quarters of silence past which a raise is simply over.
   *
   * Beyond this it is a closed fund, not a stalled one, and saying "stalled"
   * about a 2019 vintage is not peer intelligence. It also bounds the pace
   * signals: `soldLastYear` measures between *filings*, not against today, so
   * without a currency gate a fund whose last two filings were 2021 and 2022
   * reads as accelerating forever.
   */
  dormantQuarters: 12,
  /** A raise is "accelerating" when the last twelve months beat this share of the total raised. */
  acceleratingShareOfTotal: 0.4,
  /** …and must have taken at least this much, so a tiny fund does not fire on noise. */
  acceleratingMinimumSold: 5_000_000,
  /** Redemptions must reach this multiple of the vehicle's own prior-four-quarter high. */
  redemptionOwnHistoryMultiple: 1.5,
  /** …and this share of investments at fair value, when that is reported. */
  redemptionShareOfPortfolio: 0.02,
  /** …or, when the portfolio is not reported, this absolute quarterly figure. */
  redemptionAbsoluteFloor: 50_000_000,
  /** Consecutive quarters of net outflow that fire the net-outflow signal. */
  netOutflowQuarters: 2,
  /** PIK income as a share of investment income, rise over four quarters, in percentage points. */
  pikBuildPointRise: 2,
  /** Portfolio shrink over four quarters, as a share of the earlier balance. */
  portfolioShrinkShare: 0.05,
} as const

export const PEER_SIGNALS: readonly PeerSignalSpec[] = [
  {
    key: "newVehicle",
    label: "New vehicle",
    family: "fundraising",
    side: "action",
    meaning: "A competitor has opened a new fund and is in the market now.",
    rule: "First sale, or first filing where no sale is reported, inside the last twelve months.",
  },
  {
    key: "raiseAccelerating",
    label: "Raise accelerating",
    family: "fundraising",
    side: "action",
    meaning: "Capital is arriving faster than it did — the manager is winning allocations.",
    rule: `At least ${(PEER_SIGNAL_THRESHOLDS.acceleratingShareOfTotal * 100).toFixed(0)}% of everything the fund has ever raised arrived in the twelve months to its latest filing, on a raise of at least $${(PEER_SIGNAL_THRESHOLDS.acceleratingMinimumSold / 1e6).toFixed(0)}M. Unjudged on a raise that has not filed for ${PEER_SIGNAL_THRESHOLDS.stalledQuarters} quarters, since the pace is measured between filings.`,
  },
  {
    key: "raiseStalled",
    label: "Raise stalled",
    family: "fundraising",
    side: "pressure",
    meaning: "The offering is open on paper but nothing has been filed for a year.",
    rule: `No Form D amendment for between ${PEER_SIGNAL_THRESHOLDS.stalledQuarters} and ${PEER_SIGNAL_THRESHOLDS.dormantQuarters} quarters while the stated offering is unmet. Inferred — Form D has no closed flag — so a fund that quietly closed reads the same way; past ${PEER_SIGNAL_THRESHOLDS.dormantQuarters} quarters it is treated as closed rather than stalled.`,
  },
  {
    key: "targetCut",
    label: "Offering cut",
    family: "fundraising",
    side: "pressure",
    meaning: "The manager reduced what it is asking for, which it does not announce.",
    rule: "An amendment states a smaller offering amount than an earlier filing in the same trail.",
  },
  {
    key: "redemptionAcceleration",
    label: "Redemptions accelerating",
    family: "liquidity",
    side: "pressure",
    meaning: "Investors are pulling money out faster than this vehicle has seen before.",
    rule: `Quarterly repurchases at least ${PEER_SIGNAL_THRESHOLDS.redemptionOwnHistoryMultiple}x the vehicle's own prior-four-quarter high, and either ${(PEER_SIGNAL_THRESHOLDS.redemptionShareOfPortfolio * 100).toFixed(0)}% of investments at fair value or above $${(PEER_SIGNAL_THRESHOLDS.redemptionAbsoluteFloor / 1e6).toFixed(0)}M. Non-traded vehicles only.`,
  },
  {
    key: "netOutflow",
    label: "Net outflow",
    family: "liquidity",
    side: "pressure",
    meaning: "The vehicle is paying out more than it is taking in — the clearest read on investor demand.",
    rule: `Capital out exceeds capital in for ${PEER_SIGNAL_THRESHOLDS.netOutflowQuarters} consecutive quarters. Non-traded vehicles only, where issuance and repurchases are subscriptions and redemptions rather than an equity raise and a buyback.`,
  },
  {
    key: "pikBuild",
    label: "PIK build",
    family: "portfolio",
    side: "pressure",
    meaning: "More income is being paid in kind, which usually means borrowers cannot pay cash.",
    rule: `Payment-in-kind income as a share of investment income rose at least ${PEER_SIGNAL_THRESHOLDS.pikBuildPointRise} percentage points over four quarters. Only two of the twelve registered vehicles tag PIK, so this is unjudged for the rest.`,
  },
  {
    key: "portfolioShrink",
    label: "Portfolio shrinking",
    family: "portfolio",
    side: "action",
    meaning: "The book is getting smaller — running off, selling down, or not replacing repayments.",
    rule: `Investments at fair value down at least ${(PEER_SIGNAL_THRESHOLDS.portfolioShrinkShare * 100).toFixed(0)}% over four quarters.`,
  },
]

export function peerSignalSpec(key: PeerSignalKey): PeerSignalSpec | undefined {
  return PEER_SIGNALS.find((s) => s.key === key)
}

/** Fired, quiet, or not judged at all for want of an input. */
export type SignalState = "fired" | "quiet" | "unjudged"

export type SignalResult = {
  key: PeerSignalKey
  state: SignalState
  /** The figures behind the verdict, for the tooltip and the deterministic reading. */
  detail?: string
  /** Why it could not be judged, when unjudged. */
  missing?: string
}

function values(points: readonly QuarterPoint[]): Array<{ end: string; value: number }> {
  return points.filter((p): p is QuarterPoint & { value: number } => p.value != null).map((p) => ({ end: p.end, value: p.value }))
}

function usd(v: number): string {
  const sign = v < 0 ? "-" : ""
  const a = Math.abs(v)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`
  return `${sign}$${Math.round(a).toLocaleString()}`
}

/**
 * The fundraising signals for one raise.
 *
 * These read only the Form D trail, so they are available for every peer in
 * every layer — which is the point: the local and state layers have nothing
 * else.
 */
export function fundraisingSignals(vehicle: VehicleRaise): SignalResult[] {
  const r = vehicle.raise
  const out: SignalResult[] = []

  out.push({
    key: "newVehicle",
    state: vehicle.newLaunch ? "fired" : "quiet",
    ...(vehicle.newLaunch && (r.firstSale ?? r.firstFiled)
      ? { detail: `first sale ${r.firstSale ?? r.firstFiled}` }
      : {}),
  })

  const stale = r.quartersSinceFiling != null && r.quartersSinceFiling >= PEER_SIGNAL_THRESHOLDS.stalledQuarters
  if (stale) {
    // The pace is measured between filings, so on a stale trail it describes a
    // window that closed years ago. Reporting it as recent would be wrong.
    out.push({
      key: "raiseAccelerating",
      state: "unjudged",
      missing: `nothing filed for ${r.quartersSinceFiling} quarters, so recent pace is unknown`,
    })
  } else if (r.sold == null || r.soldLastYear == null) {
    out.push({ key: "raiseAccelerating", state: "unjudged", missing: "no filing far enough back to measure a year" })
  } else if (r.sold < PEER_SIGNAL_THRESHOLDS.acceleratingMinimumSold) {
    out.push({ key: "raiseAccelerating", state: "quiet", detail: `${usd(r.sold)} raised, below the floor` })
  } else {
    const share = r.soldLastYear / r.sold
    out.push({
      key: "raiseAccelerating",
      state: share >= PEER_SIGNAL_THRESHOLDS.acceleratingShareOfTotal ? "fired" : "quiet",
      detail: `${usd(r.soldLastYear)} of ${usd(r.sold)} in the twelve months to ${r.lastFiled} (${(share * 100).toFixed(0)}%)`,
    })
  }

  // A raise with nothing left to ask for has not stalled; it is finished.
  const unmet = typeof r.target === "number" && r.sold != null ? r.sold < r.target : r.target === "indefinite"
  if (r.quartersSinceFiling == null) {
    out.push({ key: "raiseStalled", state: "unjudged", missing: "no filing date" })
  } else {
    // Stalled means recently gone quiet with an unmet offering. Past
    // `dormantQuarters` the fund is simply over, and an indefinite-target
    // vehicle would otherwise read as stalled for the rest of time.
    const quiet = r.quartersSinceFiling >= PEER_SIGNAL_THRESHOLDS.stalledQuarters
    const dormant = r.quartersSinceFiling > PEER_SIGNAL_THRESHOLDS.dormantQuarters
    out.push({
      key: "raiseStalled",
      state: quiet && !dormant && unmet ? "fired" : "quiet",
      detail: dormant
        ? `last filed ${r.lastFiled}, ${r.quartersSinceFiling} quarters ago — closed rather than stalled`
        : `last filed ${r.lastFiled}, ${r.quartersSinceFiling} quarter(s) ago`,
    })
  }

  out.push({
    key: "targetCut",
    state: r.targetCut ? "fired" : "quiet",
    ...(r.targetCut && r.targetHigh != null && typeof r.target === "number"
      ? { detail: `cut from ${usd(r.targetHigh)} to ${usd(r.target)}` }
      : {}),
  })

  return out
}

export type VehicleSeries = {
  repurchases?: QuarterPoint[]
  subscriptions?: QuarterPoint[]
  netFlow?: QuarterPoint[]
  investmentsAtFairValue?: QuarterPoint[]
  pikIncome?: QuarterPoint[]
  investmentIncome?: QuarterPoint[]
}

/**
 * The liquidity and portfolio signals for one registered vehicle.
 *
 * `quoted` decides whether the liquidity family is judged at all: for a listed
 * vehicle, repurchases are a buyback and say little about investor demand, so
 * those signals are left unjudged rather than fired on the wrong meaning.
 */
export function vehicleSignals(series: VehicleSeries, quoted: VehicleQuotation | undefined): SignalResult[] {
  const out: SignalResult[] = []
  const listed = quoted !== "non-traded"

  // — Redemptions accelerating
  const reps = values(series.repurchases ?? [])
  if (listed) {
    out.push({
      key: "redemptionAcceleration",
      state: "unjudged",
      missing: quoted === "listed" ? "listed vehicle: repurchases are a buyback, not redemptions" : "not a non-traded vehicle",
    })
  } else if (reps.length < 5) {
    out.push({ key: "redemptionAcceleration", state: "unjudged", missing: "fewer than five quarters of repurchases" })
  } else {
    const latest = reps[reps.length - 1]
    const priorHigh = Math.max(...reps.slice(-5, -1).map((r) => r.value))
    const portfolio = values(series.investmentsAtFairValue ?? []).find((p) => p.end === latest.end)?.value
    const bigEnough =
      portfolio != null
        ? latest.value >= portfolio * PEER_SIGNAL_THRESHOLDS.redemptionShareOfPortfolio
        : latest.value >= PEER_SIGNAL_THRESHOLDS.redemptionAbsoluteFloor
    const fired = priorHigh > 0 && latest.value >= priorHigh * PEER_SIGNAL_THRESHOLDS.redemptionOwnHistoryMultiple && bigEnough
    out.push({
      key: "redemptionAcceleration",
      state: fired ? "fired" : "quiet",
      detail: `${usd(latest.value)} against a prior four-quarter high of ${usd(priorHigh)}${
        portfolio != null ? `, ${((latest.value / portfolio) * 100).toFixed(1)}% of the portfolio` : ""
      }`,
    })
  }

  // — Net outflow
  const flow = values(series.netFlow ?? [])
  if (listed) {
    out.push({
      key: "netOutflow",
      state: "unjudged",
      missing: quoted === "listed" ? "listed vehicle: issuance and repurchases are capital-markets decisions" : "not a non-traded vehicle",
    })
  } else if (flow.length < PEER_SIGNAL_THRESHOLDS.netOutflowQuarters) {
    out.push({ key: "netOutflow", state: "unjudged", missing: "both sides of the flow are not reported for enough quarters" })
  } else {
    const recent = flow.slice(-PEER_SIGNAL_THRESHOLDS.netOutflowQuarters)
    const fired = recent.every((p) => p.value < 0)
    out.push({
      key: "netOutflow",
      state: fired ? "fired" : "quiet",
      detail: recent.map((p) => usd(p.value)).join(", then "),
    })
  }

  // — PIK build
  const pik = values(series.pikIncome ?? [])
  const income = values(series.investmentIncome ?? [])
  if (!pik.length) {
    out.push({ key: "pikBuild", state: "unjudged", missing: "payment-in-kind income is not tagged by this filer" })
  } else if (pik.length < 5 || income.length < 5) {
    out.push({ key: "pikBuild", state: "unjudged", missing: "fewer than five quarters of income" })
  } else {
    const shareAt = (end: string) => {
      const p = pik.find((x) => x.end === end)?.value
      const i = income.find((x) => x.end === end)?.value
      return p != null && i != null && i > 0 ? p / i : null
    }
    const now = shareAt(pik[pik.length - 1].end)
    const then = shareAt(pik[pik.length - 5].end)
    if (now == null || then == null) {
      out.push({ key: "pikBuild", state: "unjudged", missing: "income not reported in one of the compared quarters" })
    } else {
      const rise = (now - then) * 100
      out.push({
        key: "pikBuild",
        state: rise >= PEER_SIGNAL_THRESHOLDS.pikBuildPointRise ? "fired" : "quiet",
        detail: `${(then * 100).toFixed(1)}% to ${(now * 100).toFixed(1)}% of investment income over four quarters`,
      })
    }
  }

  // — Portfolio shrinking
  const port = values(series.investmentsAtFairValue ?? [])
  if (port.length < 5) {
    out.push({ key: "portfolioShrink", state: "unjudged", missing: "fewer than five quarters of investments at fair value" })
  } else {
    const now = port[port.length - 1]
    const then = port[port.length - 5]
    const change = then.value > 0 ? (now.value - then.value) / then.value : null
    if (change == null) {
      out.push({ key: "portfolioShrink", state: "unjudged", missing: "no earlier balance to compare against" })
    } else {
      out.push({
        key: "portfolioShrink",
        state: change <= -PEER_SIGNAL_THRESHOLDS.portfolioShrinkShare ? "fired" : "quiet",
        detail: `${usd(then.value)} to ${usd(now.value)} over four quarters (${(change * 100).toFixed(1)}%)`,
      })
    }
  }

  return out
}

export type ManagerSignals = {
  peerId: string
  manager: string
  /** One entry per signal, deduped across the manager's vehicles. */
  signals: SignalResult[]
  firedKeys: PeerSignalKey[]
  /** Fired signals on the `action` side. */
  actionCount: number
  /** Fired signals on the `pressure` side. */
  pressureCount: number
}

/**
 * Roll a manager's vehicles up to one set of signals.
 *
 * A signal fires for the manager if it fires for **any** of its vehicles, which
 * is the right reading: one fund of six cutting its offering is still a
 * competitor cutting an offering. The detail carries the vehicle it came from so
 * the drawer can say which. A signal is `unjudged` for the manager only when it
 * is unjudged everywhere — otherwise a single untagged vehicle would silence a
 * verdict its siblings support.
 */
export function managerSignals(
  manager: ManagerRaises,
  seriesByCik: ReadonlyMap<string, { series: VehicleSeries; quoted?: VehicleQuotation }>
): ManagerSignals {
  const perKey = new Map<PeerSignalKey, Array<SignalResult & { vehicle: string }>>()
  const record = (result: SignalResult, vehicle: string) => {
    const list = perKey.get(result.key) ?? []
    list.push({ ...result, vehicle })
    perKey.set(result.key, list)
  }

  for (const vehicle of manager.raises) {
    if (vehicle.role === "sleeve") continue
    for (const result of fundraisingSignals(vehicle)) record(result, vehicle.vehicleName)
  }
  for (const [cik, entry] of seriesByCik) {
    const vehicle = manager.raises.find((r) => r.cik === cik)
    const name = vehicle?.vehicleName ?? cik
    for (const result of vehicleSignals(entry.series, entry.quoted)) record(result, name)
  }

  const signals: SignalResult[] = []
  for (const spec of PEER_SIGNALS) {
    const results = perKey.get(spec.key) ?? []
    if (!results.length) {
      signals.push({ key: spec.key, state: "unjudged", missing: "no vehicle carries this measure" })
      continue
    }
    const fired = results.find((r) => r.state === "fired")
    if (fired) {
      signals.push({ key: spec.key, state: "fired", ...(fired.detail ? { detail: `${fired.vehicle}: ${fired.detail}` } : {}) })
      continue
    }
    const quiet = results.find((r) => r.state === "quiet")
    if (quiet) {
      signals.push({ key: spec.key, state: "quiet", ...(quiet.detail ? { detail: `${quiet.vehicle}: ${quiet.detail}` } : {}) })
      continue
    }
    signals.push({ key: spec.key, state: "unjudged", ...(results[0].missing ? { missing: results[0].missing } : {}) })
  }

  const firedKeys = signals.filter((s) => s.state === "fired").map((s) => s.key)
  const sideOf = (key: PeerSignalKey) => peerSignalSpec(key)?.side
  return {
    peerId: manager.peerId,
    manager: manager.manager,
    signals,
    firedKeys,
    actionCount: firedKeys.filter((k) => sideOf(k) === "action").length,
    pressureCount: firedKeys.filter((k) => sideOf(k) === "pressure").length,
  }
}

/** How often each signal fires across a layer, for the cohort summary and threshold tuning. */
export function signalFiringRates(all: readonly ManagerSignals[]): Array<{
  key: PeerSignalKey
  fired: number
  quiet: number
  unjudged: number
  /** Share of *judged* managers that fired, so an unjudged tier does not deflate it. */
  rate: number | null
}> {
  return PEER_SIGNALS.map((spec) => {
    const states = all.map((m) => m.signals.find((s) => s.key === spec.key)?.state ?? "unjudged")
    const fired = states.filter((s) => s === "fired").length
    const quiet = states.filter((s) => s === "quiet").length
    const unjudged = states.filter((s) => s === "unjudged").length
    const judged = fired + quiet
    return { key: spec.key, fired, quiet, unjudged, rate: judged ? fired / judged : null }
  })
}
