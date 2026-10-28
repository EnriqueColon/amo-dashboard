import { test } from "node:test"
import assert from "node:assert/strict"
import {
  aggregateNetFlow,
  buildVehicleTrend,
  liquidityRows,
  PEER_TREND_QUARTERS,
  pikShareSeries,
  looksLikeNav,
  portfolioRows,
  type VehicleTrend,
} from "./liquidity"
import type { QuarterPoint } from "./xbrl"

function q(end: string, value: number | null): QuarterPoint {
  return { end, label: end.slice(0, 7), value }
}

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]

/** Blue Owl Credit Income's real quarterly flows, from the step 3 audit. */
function blueOwl(): VehicleTrend {
  const subs = [1_930_000_000, 1_570_000_000, 2_040_000_000, 1_370_000_000, 670_403_000, 117_461_000]
  const reps = [193_197_000, 203_922_000, 464_234_000, 317_633_000, 1_009_048_000, 963_530_000]
  return buildVehicleTrend(
    {
      cik: "1812554",
      manager: "Blue Owl Capital",
      vehicleName: "Blue Owl Credit Income Corp.",
      quoted: "non-traded",
      series: {
        subscriptions: ENDS.map((e, i) => q(e, subs[i])),
        repurchases: ENDS.map((e, i) => q(e, reps[i])),
        investmentsAtFairValue: ENDS.map((e, i) => q(e, 33_000_000_000 + i * 500_000_000)),
        pikIncome: ENDS.map((e, i) => q(e, 40_000_000 + i * 8_000_000)),
        investmentIncome: ENDS.map((e) => q(e, 800_000_000)),
      },
      netFlow: ENDS.map((e, i) => q(e, subs[i] - reps[i])),
      missingMetrics: ["navPerShare"],
    },
    "blue-owl"
  )
}

/** A listed vehicle, where the same tags mean a buyback and an equity raise. */
function listed(): VehicleTrend {
  return buildVehicleTrend(
    {
      cik: "1061630",
      manager: "Blackstone",
      vehicleName: "Blackstone Mortgage Trust, Inc. (BXMT)",
      quoted: "listed",
      series: {
        subscriptions: ENDS.map((e) => q(e, 1_000_000)),
        repurchases: ENDS.map((e) => q(e, 50_000_000)),
        investmentsAtFairValue: ENDS.map((e, i) => q(e, 20_000_000_000 - i * 900_000_000)),
      },
      // A listed vehicle gets no net flow by construction.
      netFlow: [],
      missingMetrics: ["pikIncome", "navPerShare"],
    },
    "blackstone"
  )
}

test("series are trimmed to the trend window before storage", () => {
  const long = Array.from({ length: 30 }, (_, i) => q(`20${20 + Math.floor(i / 4)}-03-31`, i))
  const trend = buildVehicleTrend(
    { cik: "1", manager: "M", vehicleName: "V", quoted: "non-traded", series: { repurchases: long }, netFlow: long, missingMetrics: [] },
    "m"
  )
  assert.equal(trend.series.repurchases?.length, PEER_TREND_QUARTERS)
  assert.equal(trend.netFlow.length, PEER_TREND_QUARTERS)
  // The newest are kept, not the oldest.
  assert.equal(trend.series.repurchases?.[PEER_TREND_QUARTERS - 1].value, 29)
})

test("a metric the filer does not tag is absent, not an empty array", () => {
  const trend = buildVehicleTrend(
    { cik: "1", manager: "M", vehicleName: "V", series: { repurchases: [] }, netFlow: [], missingMetrics: ["pikIncome"] },
    "m"
  )
  assert.equal(trend.series.repurchases, undefined)
  assert.deepEqual(trend.missingMetrics, ["pikIncome"])
})

test("PIK share is a share of income, and null where either side is missing", () => {
  const share = pikShareSeries(
    [q("2026-03-31", 10), q("2026-06-30", 30)],
    [q("2026-03-31", 100), q("2026-06-30", 100)]
  )
  assert.equal(share[0].value, 0.1)
  assert.equal(share[1].value, 0.3)

  assert.deepEqual(pikShareSeries(undefined, [q("2026-03-31", 100)]), [], "no PIK, no series")
  assert.deepEqual(pikShareSeries([q("2026-03-31", 10)], undefined), [])
  assert.equal(pikShareSeries([q("2026-03-31", 10)], [q("2026-03-31", 0)])[0].value, null, "never divide by zero income")
  assert.equal(pikShareSeries([q("2026-03-31", null)], [q("2026-03-31", 100)])[0].value, null)
})

test("liquidity rows reproduce Blue Owl's real reversal", () => {
  const [row] = liquidityRows([blueOwl()])
  assert.equal(row.label, "2026-06")
  assert.equal(row.subscriptions, 117_461_000)
  assert.equal(row.repurchases, 963_530_000)
  assert.equal(row.netFlow, 117_461_000 - 963_530_000)
  assert.ok((row.netFlow as number) < 0)
  // Two consecutive quarters of outflow: Q1 and Q2 2026.
  assert.equal(row.outflowStreak, 2)
  // The window still nets positive, because 2025 was strongly positive.
  assert.ok((row.windowNetFlow as number) > 0, "a single quarter must not be mistaken for the window")
})

test("listed vehicles are excluded from liquidity rather than shown blank", () => {
  const rows = liquidityRows([blueOwl(), listed()])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].manager, "Blue Owl Capital")
})

test("redemptions as a share of the book is null when the book is not tagged", () => {
  const noBook = buildVehicleTrend(
    {
      cik: "9", manager: "M", vehicleName: "V", quoted: "non-traded",
      series: { subscriptions: [q("2026-06-30", 1)], repurchases: [q("2026-06-30", 100)] },
      netFlow: [q("2026-06-30", -99)], missingMetrics: ["investmentsAtFairValue"],
    },
    "m"
  )
  assert.equal(liquidityRows([noBook])[0].redemptionShare, null)
  assert.ok(liquidityRows([blueOwl()])[0].redemptionShare != null)
})

test("liquidity rows lead with the largest outflow", () => {
  const smaller = buildVehicleTrend(
    {
      cik: "8", manager: "Small", vehicleName: "Small Fund", quoted: "non-traded",
      series: { subscriptions: [q("2026-06-30", 10)], repurchases: [q("2026-06-30", 20)] },
      netFlow: [q("2026-06-30", -10)], missingMetrics: [],
    },
    "small"
  )
  const rows = liquidityRows([smaller, blueOwl()])
  assert.equal(rows[0].manager, "Blue Owl Capital", "the biggest outflow first")
})

test("portfolio rows include listed vehicles, where the figures mean the same", () => {
  const rows = portfolioRows([blueOwl(), listed()])
  assert.equal(rows.length, 2)
  const bxmt = rows.find((r) => r.vehicleName.includes("BXMT"))!
  assert.equal(bxmt.quoted, "listed")
  // Its book shrinks across the window, which is the signal regardless of listing.
  assert.ok((bxmt.investmentsChange as number) < -0.05)
})

test("portfolio rows report the PIK share and its change in points", () => {
  const row = portfolioRows([blueOwl()])[0]
  // 40M to 80M against flat 800M income: 5% to 10%.
  assert.equal(row.pikShare, 0.1)
  assert.ok(row.pikShareChange != null)
  assert.equal(Math.round(row.pikShareChange * 10) / 10, 5)
})

test("a metric the filer does not tag is null and named, never zero", () => {
  const row = portfolioRows([blueOwl()])[0]
  assert.equal(row.navPerShare, null)
  assert.ok(row.notReported.includes("navPerShare"))
  const bxmt = portfolioRows([listed()])[0]
  assert.equal(bxmt.pikShare, null)
  assert.ok(bxmt.notReported.includes("pikIncome"))
})

test("the aggregate sums only vehicles reporting both sides of a quarter", () => {
  const partial = buildVehicleTrend(
    {
      cik: "7", manager: "Partial", vehicleName: "Partial Fund", quoted: "non-traded",
      // Reports only the newest quarter.
      series: { subscriptions: [q("2026-06-30", 100_000_000)], repurchases: [q("2026-06-30", 200_000_000)] },
      netFlow: [q("2026-06-30", -100_000_000)], missingMetrics: [],
    },
    "partial"
  )
  const agg = aggregateNetFlow([blueOwl(), partial])
  const newest = agg.points[agg.points.length - 1]
  assert.equal(newest.end, "2026-06-30")
  assert.equal(newest.vehicles, 2, "both reported this quarter")
  assert.equal(newest.subscriptions, 117_461_000 + 100_000_000)

  const earlier = agg.points.find((p) => p.end === "2025-03-31")!
  assert.equal(earlier.vehicles, 1, "only Blue Owl reported that quarter")
  assert.equal(earlier.subscriptions, 1_930_000_000)
})

test("the aggregate ignores listed vehicles and counts those in outflow", () => {
  const agg = aggregateNetFlow([blueOwl(), listed()])
  assert.equal(agg.contributing, 1, "listed vehicles are not part of the tier flow")
  assert.equal(agg.inOutflow, 1)
  assert.ok((agg.newest?.netFlow as number) < 0)
})

test("no non-traded vehicle means no aggregate, not a zero", () => {
  const agg = aggregateNetFlow([listed()])
  assert.deepEqual(agg.points, [])
  assert.equal(agg.newest, null)
  assert.equal(agg.contributing, 0)
  assert.equal(agg.inOutflow, 0)
})

test("an empty tier yields empty rows rather than throwing", () => {
  assert.deepEqual(liquidityRows([]), [])
  assert.deepEqual(portfolioRows([]), [])
  assert.equal(aggregateNetFlow([]).newest, null)
})

test("a NAV that never moves is not a NAV", () => {
  // HPS Corporate Lending Fund tags exactly 1000.00 in six consecutive
  // filings while its real NAV is about $25. That is a par or subscription
  // price under the same concept.
  const constant = ENDS.map((e) => q(e, 1000))
  assert.equal(looksLikeNav(constant), false)

  const moving = ENDS.map((e, i) => q(e, 24.5 + i * 0.1))
  assert.equal(looksLikeNav(moving), true)
})

test("two identical quarters is a coincidence, not a pattern", () => {
  assert.equal(looksLikeNav([q("2026-03-31", 25), q("2026-06-30", 25)]), true, "too few to judge")
  assert.equal(looksLikeNav([q("2026-03-31", 25)]), true)
  assert.equal(looksLikeNav([]), false, "nothing reported is not a usable NAV either")
  assert.equal(looksLikeNav(undefined), false)
})

test("a rejected NAV is reported as rejected, not as missing", () => {
  const hps = buildVehicleTrend(
    {
      cik: "1838126", manager: "HPS Investment Partners", vehicleName: "HPS Corporate Lending Fund",
      quoted: "non-traded",
      series: { navPerShare: ENDS.map((e) => q(e, 1000)), investmentsAtFairValue: ENDS.map((e) => q(e, 24_000_000_000)) },
      netFlow: [], missingMetrics: [],
    },
    "hps"
  )
  const row = portfolioRows([hps])[0]
  assert.equal(row.navPerShare, null, "the implausible figure is not shown")
  assert.equal(row.navRejected, true, "and the panel can say why")
  assert.ok(!row.notReported.includes("navPerShare"), "it was reported — just not usable")
})

test("a filer that tags no NAV at all is missing, not rejected", () => {
  const row = portfolioRows([blueOwl()])[0]
  assert.equal(row.navPerShare, null)
  assert.equal(row.navRejected, undefined)
  assert.ok(row.notReported.includes("navPerShare"))
})

test("a plausible NAV still comes through", () => {
  const ok = buildVehicleTrend(
    {
      cik: "1", manager: "M", vehicleName: "V", quoted: "non-traded",
      series: { navPerShare: ENDS.map((e, i) => q(e, 24.5 + i * 0.05)) },
      netFlow: [], missingMetrics: [],
    },
    "m"
  )
  const row = portfolioRows([ok])[0]
  assert.ok(row.navPerShare != null)
  assert.equal(row.navRejected, undefined)
})
