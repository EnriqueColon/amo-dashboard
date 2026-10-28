import { test } from "node:test"
import assert from "node:assert/strict"
import { buildManagerRaises, buildPeerCohort } from "./cohort"
import type { OfferingRecord } from "./form-d"
import { PEERS, peerById, type Peer } from "./registry"
import {
  fundraisingSignals,
  managerSignals,
  PEER_SIGNALS,
  PEER_SIGNAL_THRESHOLDS,
  peerSignalSpec,
  signalFiringRates,
  vehicleSignals,
  type VehicleSeries,
} from "./signals"
import type { QuarterPoint } from "./xbrl"

const ASOF = "2026-10-21"
const WINDOW = "2025-10-21"

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string }): OfferingRecord {
  return {
    accession: "x", formType: "D", entityName: "Fund LP", location: "Miami, FL", jurisdiction: "DE",
    offeringAmount: null, totalSold: null, remaining: null, investorCount: null,
    minimumInvestment: null, dateOfFirstSale: null, industryGroup: null, fundType: null, hasNonAccreditedInvestors: null, salesRecipients: [], relatedPersons: [],
    ...over,
  }
}
function peer(vehicles: Peer["vehicles"]): Peer {
  return { id: "t", manager: "T", layer: "miami-dade", location: "Miami, FL", relevance: "direct",
    evidence: "A fixture used to exercise the signal rules against known inputs.", aliases: [], vehicles }
}
function q(end: string, value: number | null): QuarterPoint {
  return { end, label: end, value }
}
function raiseOf(records: OfferingRecord[], cik = "1") {
  const m = buildManagerRaises(peer([{ cik, name: "Fund LP", kind: "private" }]), new Map([[cik, records]]), ASOF, WINDOW)
  return m.raises[0]
}

test("every signal declares a family, side, meaning and rule", () => {
  const keys = PEER_SIGNALS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const s of PEER_SIGNALS) {
    assert.ok(s.meaning.length > 20, s.key)
    assert.ok(s.rule.length > 20, s.key)
    assert.ok(["fundraising", "liquidity", "portfolio"].includes(s.family))
    assert.ok(["action", "pressure"].includes(s.side))
  }
  // The inferred and sparsely-tagged ones must admit it in the rule text.
  assert.ok(peerSignalSpec("raiseStalled")?.rule.includes("Inferred"))
  assert.ok(peerSignalSpec("pikBuild")?.rule.includes("two of the twelve"))
  assert.ok(peerSignalSpec("netOutflow")?.rule.includes("Non-traded"))
})

test("a target cut fires and names both figures", () => {
  const r = raiseOf([
    rec({ cik: "1", filedAt: "2024-03-01", offeringAmount: 500_000_000, totalSold: 0 }),
    rec({ cik: "1", filedAt: "2026-07-01", formType: "D/A", offeringAmount: 300_000_000, totalSold: 64_000_000 }),
  ])
  const cut = fundraisingSignals(r).find((s) => s.key === "targetCut")
  assert.equal(cut?.state, "fired")
  assert.match(cut?.detail ?? "", /\$500\.0M.*\$300\.0M/)
})

test("a stalled raise needs both silence and an unmet offering", () => {
  const silent = raiseOf([rec({ cik: "1", filedAt: "2024-01-01", offeringAmount: 100_000_000, totalSold: 10_000_000 })])
  assert.equal(fundraisingSignals(silent).find((s) => s.key === "raiseStalled")?.state, "fired")

  // Fully subscribed and silent: finished, not stalled.
  const done = raiseOf([rec({ cik: "1", filedAt: "2024-01-01", offeringAmount: 100_000_000, totalSold: 100_000_000 })])
  assert.equal(fundraisingSignals(done).find((s) => s.key === "raiseStalled")?.state, "quiet")

  // Recent filing, unmet: open, not stalled.
  const live = raiseOf([rec({ cik: "1", filedAt: "2026-08-01", offeringAmount: 100_000_000, totalSold: 10_000_000 })])
  assert.equal(fundraisingSignals(live).find((s) => s.key === "raiseStalled")?.state, "quiet")
})

test("acceleration needs a measurable year and a raise above the floor", () => {
  const tiny = raiseOf([
    rec({ cik: "1", filedAt: "2025-01-01", offeringAmount: 10_000_000, totalSold: 100_000 }),
    rec({ cik: "1", filedAt: "2026-07-01", formType: "D/A", offeringAmount: 10_000_000, totalSold: 1_000_000 }),
  ])
  assert.equal(fundraisingSignals(tiny).find((s) => s.key === "raiseAccelerating")?.state, "quiet",
    "a $1M raise must not fire on a 90% jump")

  const real = raiseOf([
    rec({ cik: "1", filedAt: "2025-01-01", offeringAmount: 300_000_000, totalSold: 20_000_000 }),
    rec({ cik: "1", filedAt: "2026-07-01", formType: "D/A", offeringAmount: 300_000_000, totalSold: 60_000_000 }),
  ])
  const acc = fundraisingSignals(real).find((s) => s.key === "raiseAccelerating")
  assert.equal(acc?.state, "fired", "$40M of $60M arrived in the year")

  const single = raiseOf([rec({ cik: "1", filedAt: "2026-07-01", offeringAmount: 300_000_000, totalSold: 60_000_000 })])
  assert.equal(fundraisingSignals(single).find((s) => s.key === "raiseAccelerating")?.state, "unjudged")
})

test("liquidity signals are unjudged for a listed vehicle, not fired on the wrong meaning", () => {
  const series: VehicleSeries = {
    repurchases: [q("2025-03-31", 10), q("2025-06-30", 10), q("2025-09-30", 10), q("2025-12-31", 10), q("2026-03-31", 9_000_000_000)],
    netFlow: [q("2025-12-31", -1), q("2026-03-31", -1)],
  }
  for (const key of ["redemptionAcceleration", "netOutflow"] as const) {
    const listed = vehicleSignals(series, "listed").find((s) => s.key === key)
    assert.equal(listed?.state, "unjudged", key)
    assert.match(listed?.missing ?? "", /buyback|capital-markets/)
  }
  // The same figures on a non-traded vehicle do fire.
  assert.equal(vehicleSignals(series, "non-traded").find((s) => s.key === "redemptionAcceleration")?.state, "fired")
  assert.equal(vehicleSignals(series, "non-traded").find((s) => s.key === "netOutflow")?.state, "fired")
})

test("redemption acceleration judges against the vehicle's own prior high", () => {
  const steady: VehicleSeries = {
    repurchases: [q("2025-03-31", 100_000_000), q("2025-06-30", 100_000_000), q("2025-09-30", 100_000_000), q("2025-12-31", 100_000_000), q("2026-03-31", 110_000_000)],
  }
  assert.equal(vehicleSignals(steady, "non-traded").find((s) => s.key === "redemptionAcceleration")?.state, "quiet",
    "a 10% rise on a large steady programme is not acceleration")

  const spike: VehicleSeries = {
    repurchases: [q("2025-03-31", 100_000_000), q("2025-06-30", 100_000_000), q("2025-09-30", 100_000_000), q("2025-12-31", 100_000_000), q("2026-03-31", 200_000_000)],
  }
  assert.equal(vehicleSignals(spike, "non-traded").find((s) => s.key === "redemptionAcceleration")?.state, "fired")
})

test("a small absolute spike does not fire without reaching the floor", () => {
  const small: VehicleSeries = {
    repurchases: [q("2025-03-31", 1_000), q("2025-06-30", 1_000), q("2025-09-30", 1_000), q("2025-12-31", 1_000), q("2026-03-31", 1_000_000)],
  }
  assert.equal(vehicleSignals(small, "non-traded").find((s) => s.key === "redemptionAcceleration")?.state, "quiet",
    `$1M is below the $${PEER_SIGNAL_THRESHOLDS.redemptionAbsoluteFloor / 1e6}M floor`)
})

test("the portfolio share is preferred over the absolute floor when reported", () => {
  const series: VehicleSeries = {
    repurchases: [q("2025-03-31", 1_000_000), q("2025-06-30", 1_000_000), q("2025-09-30", 1_000_000), q("2025-12-31", 1_000_000), q("2026-03-31", 10_000_000)],
    investmentsAtFairValue: [q("2026-03-31", 100_000_000)],
  }
  // $10M is under the absolute floor but is 10% of a small portfolio.
  const r = vehicleSignals(series, "non-traded").find((s) => s.key === "redemptionAcceleration")
  assert.equal(r?.state, "fired")
  assert.match(r?.detail ?? "", /10\.0% of the portfolio/)
})

test("PIK is unjudged when the filer does not tag it, which is the common case", () => {
  const r = vehicleSignals({ investmentIncome: [q("2026-03-31", 100)] }, "non-traded").find((s) => s.key === "pikBuild")
  assert.equal(r?.state, "unjudged")
  assert.match(r?.missing ?? "", /not tagged/)
})

test("PIK build fires on a rise in its share of income, not on its level", () => {
  const ends = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]
  const flat: VehicleSeries = {
    pikIncome: ends.map((e) => q(e, 10)),
    investmentIncome: ends.map((e) => q(e, 100)),
  }
  assert.equal(vehicleSignals(flat, "non-traded").find((s) => s.key === "pikBuild")?.state, "quiet",
    "a constant 10% share is not a build, however large")

  const rising: VehicleSeries = {
    pikIncome: [q(ends[0], 5), q(ends[1], 6), q(ends[2], 7), q(ends[3], 8), q(ends[4], 12)],
    investmentIncome: ends.map((e) => q(e, 100)),
  }
  const r = vehicleSignals(rising, "non-traded").find((s) => s.key === "pikBuild")
  assert.equal(r?.state, "fired")
  assert.match(r?.detail ?? "", /5\.0% to 12\.0%/)
})

test("portfolio shrink measures four quarters, and growth stays quiet", () => {
  const ends = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]
  const shrinking: VehicleSeries = { investmentsAtFairValue: [q(ends[0], 1_000_000_000), q(ends[1], 980_000_000), q(ends[2], 960_000_000), q(ends[3], 940_000_000), q(ends[4], 900_000_000)] }
  assert.equal(vehicleSignals(shrinking, "non-traded").find((s) => s.key === "portfolioShrink")?.state, "fired")

  const growing: VehicleSeries = { investmentsAtFairValue: ends.map((e, i) => q(e, 1_000_000_000 + i * 10_000_000)) }
  assert.equal(vehicleSignals(growing, "non-traded").find((s) => s.key === "portfolioShrink")?.state, "quiet")
})

test("a short series is unjudged rather than judged on two points", () => {
  const short: VehicleSeries = { repurchases: [q("2026-03-31", 500_000_000)], investmentsAtFairValue: [q("2026-03-31", 1)] }
  const r = vehicleSignals(short, "non-traded")
  assert.equal(r.find((s) => s.key === "redemptionAcceleration")?.state, "unjudged")
  assert.equal(r.find((s) => s.key === "portfolioShrink")?.state, "unjudged")
})

test("a manager fires when any one of its funds fires, and the detail names which", () => {
  const p = peer([
    { cik: "1", name: "Fund I", kind: "private" },
    { cik: "2", name: "Fund II", kind: "private" },
  ])
  const records = new Map([
    ["1", [rec({ cik: "1", filedAt: "2026-08-01", offeringAmount: 100_000_000, totalSold: 50_000_000 })]],
    ["2", [
      rec({ cik: "2", filedAt: "2024-01-01", offeringAmount: 500_000_000, totalSold: 0 }),
      rec({ cik: "2", filedAt: "2026-08-01", formType: "D/A", offeringAmount: 200_000_000, totalSold: 10_000_000 }),
    ]],
  ])
  const m = managerSignals(buildManagerRaises(p, records, ASOF, WINDOW), new Map())
  const cut = m.signals.find((s) => s.key === "targetCut")
  assert.equal(cut?.state, "fired", "one fund of two cutting is still a manager cutting")
  assert.match(cut?.detail ?? "", /Fund II/)
})

test("sleeves do not contribute fundraising signals", () => {
  const p = peer([
    { cik: "1", name: "Fund VI", kind: "private" },
    { cik: "2", name: "Fund VI Offshore", kind: "private", role: "sleeve" },
  ])
  const records = new Map([
    ["1", [rec({ cik: "1", filedAt: "2026-08-01", offeringAmount: 100_000_000, totalSold: 50_000_000 })]],
    ["2", [
      rec({ cik: "2", filedAt: "2024-01-01", offeringAmount: 500_000_000, totalSold: 0 }),
      rec({ cik: "2", filedAt: "2026-08-01", formType: "D/A", offeringAmount: 100_000_000, totalSold: 1_000_000 }),
    ]],
  ])
  const m = managerSignals(buildManagerRaises(p, records, ASOF, WINDOW), new Map())
  assert.equal(m.signals.find((s) => s.key === "targetCut")?.state, "quiet",
    "a sleeve restating the ask must not read as the manager cutting it")
})

test("a manager is unjudged on a signal only when no vehicle can judge it", () => {
  const m = managerSignals(
    buildManagerRaises(peer([{ cik: "1", name: "Fund", kind: "private" }]),
      new Map([["1", [rec({ cik: "1", filedAt: "2026-08-01", offeringAmount: 100, totalSold: 1 })]]]), ASOF, WINDOW),
    new Map()
  )
  for (const key of ["redemptionAcceleration", "netOutflow", "pikBuild", "portfolioShrink"] as const) {
    assert.equal(m.signals.find((s) => s.key === key)?.state, "unjudged", key)
  }
  assert.equal(m.actionCount + m.pressureCount, m.firedKeys.length)
})

/**
 * The acceptance rule: a manager's signals must not change with the layer.
 * Signals read only the manager's own trail, so a cumulative layer that adds
 * other managers cannot move them.
 */
test("signals are identical in every layer a manager appears in", () => {
  const shcp = peerById("safe-harbor-capital-partners")!
  const records = new Map<string, OfferingRecord[]>([
    ["2017189", [
      rec({ cik: "2017189", filedAt: "2024-03-28", offeringAmount: 500_000_000, totalSold: 0, investorCount: 0 }),
      rec({ cik: "2017189", filedAt: "2026-07-23", formType: "D/A", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 }),
    ]],
  ])
  const perLayer = (["miami-dade", "florida", "national"] as const).map((layer) => {
    const cohort = buildPeerCohort(layer, records, ASOF)
    const m = cohort.managers.find((x) => x.peerId === shcp.id)!
    return managerSignals(m, new Map())
  })
  const [local, state, national] = perLayer.map((m) => JSON.stringify(m.signals))
  assert.equal(local, state)
  assert.equal(state, national)
  assert.ok(perLayer[0].firedKeys.includes("targetCut"))
})

test("firing rates are measured over judged managers only", () => {
  const all = [
    { peerId: "a", manager: "A", signals: [{ key: "targetCut" as const, state: "fired" as const }], firedKeys: ["targetCut" as const], actionCount: 0, pressureCount: 1 },
    { peerId: "b", manager: "B", signals: [{ key: "targetCut" as const, state: "quiet" as const }], firedKeys: [], actionCount: 0, pressureCount: 0 },
    { peerId: "c", manager: "C", signals: [{ key: "targetCut" as const, state: "unjudged" as const }], firedKeys: [], actionCount: 0, pressureCount: 0 },
  ]
  const row = signalFiringRates(all).find((r) => r.key === "targetCut")!
  assert.equal(row.fired, 1)
  assert.equal(row.quiet, 1)
  assert.equal(row.unjudged, 1)
  assert.equal(row.rate, 0.5, "one of two judged, not one of three")

  const none = signalFiringRates([]).find((r) => r.key === "targetCut")!
  assert.equal(none.rate, null, "no judged managers means no rate, not zero")
})

test("the real registry produces a signal set for every manager", () => {
  const cohort = buildPeerCohort("national", new Map(), ASOF)
  assert.equal(cohort.managers.length, PEERS.length)
  for (const m of cohort.managers) {
    const s = managerSignals(m, new Map())
    assert.equal(s.signals.length, PEER_SIGNALS.length, m.manager)
  }
})

test("pace is unjudged on a stale trail, not reported as recent", () => {
  // Two filings a year apart, both years ago. soldLastYear measures between
  // filings, so without a currency gate this reads as accelerating forever.
  const stale = raiseOf([
    rec({ cik: "1", filedAt: "2021-10-01", offeringAmount: 100_000_000, totalSold: 20_000_000 }),
    rec({ cik: "1", filedAt: "2022-10-25", formType: "D/A", offeringAmount: 100_000_000, totalSold: 60_000_000 }),
  ])
  const acc = fundraisingSignals(stale).find((s) => s.key === "raiseAccelerating")
  assert.equal(acc?.state, "unjudged")
  assert.match(acc?.missing ?? "", /recent pace is unknown/)
})

test("the pace detail names the window it actually measured", () => {
  const live = raiseOf([
    rec({ cik: "1", filedAt: "2025-09-01", offeringAmount: 300_000_000, totalSold: 20_000_000 }),
    rec({ cik: "1", filedAt: "2026-09-01", formType: "D/A", offeringAmount: 300_000_000, totalSold: 60_000_000 }),
  ])
  const acc = fundraisingSignals(live).find((s) => s.key === "raiseAccelerating")
  assert.equal(acc?.state, "fired")
  assert.match(acc?.detail ?? "", /twelve months to 2026-09-01/, "not 'the last twelve months'")
})

test("a long-dormant fund reads as closed, not stalled", () => {
  const dormant = raiseOf([rec({ cik: "1", filedAt: "2021-01-01", offeringAmount: "indefinite", totalSold: 50_000_000 })])
  const stalled = fundraisingSignals(dormant).find((s) => s.key === "raiseStalled")
  assert.equal(stalled?.state, "quiet", "an indefinite-target fund must not read as stalled for ever")
  assert.match(stalled?.detail ?? "", /closed rather than stalled/)

  // Recently gone quiet with an unmet offering is the real signal.
  const recent = raiseOf([rec({ cik: "1", filedAt: "2025-06-01", offeringAmount: "indefinite", totalSold: 50_000_000 })])
  assert.equal(fundraisingSignals(recent).find((s) => s.key === "raiseStalled")?.state, "fired")
})

test("the stalled window is bounded at both ends", () => {
  const q = (filedAt: string) =>
    fundraisingSignals(raiseOf([rec({ cik: "1", filedAt, offeringAmount: 100_000_000, totalSold: 1_000_000 })]))
      .find((s) => s.key === "raiseStalled")?.state
  assert.equal(q("2026-09-01"), "quiet", "still filing")
  assert.equal(q("2025-06-01"), "fired", "about five quarters quiet")
  assert.equal(q("2022-01-01"), "quiet", "nineteen quarters quiet: closed")
})
