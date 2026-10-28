import { test } from "node:test"
import assert from "node:assert/strict"
import { buildManagerRaises } from "./cohort"
import type { OfferingRecord } from "./form-d"
import type { Peer } from "./registry"
import {
  buildPacingReading,
  buildVintagePacing,
  managersWithLadders,
  priorSoldAt,
  type VintagePoint,
} from "./vintage"

const ASOF = "2026-10-21"
const WINDOW = "2025-10-21"

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string }): OfferingRecord {
  return {
    accession: `000${over.cik}-${over.filedAt.slice(2, 4)}-${over.filedAt.replace(/-/g, "").slice(-6)}`,
    formType: "D/A",
    entityName: "Test Fund LP",
    location: "Miami Beach, FL",
    jurisdiction: "DE",
    offeringAmount: null,
    totalSold: null,
    remaining: null,
    investorCount: null,
    minimumInvestment: null,
    dateOfFirstSale: null,
    industryGroup: "Pooled Investment Fund",
    fundType: "Other Investment Fund",
    hasNonAccreditedInvestors: null,
    salesRecipients: [],
    relatedPersons: [],
    ...over,
  }
}

/**
 * A four-vintage ladder shaped like Safe Harbor's, with Fund 4's trail taken
 * from the real filings. The names are deliberately out of order against the
 * dates — "Fund 1" starts last — so that ordering by name would fail.
 */
function ladderPeer(): Peer {
  return {
    id: "ladder",
    manager: "Ladder Manager",
    layer: "miami-dade",
    location: "Miami Beach, FL",
    relevance: "direct",
    evidence: "fixture",
    aliases: [],
    isSelf: true,
    vehicles: [
      { cik: "4", name: "Fund 4", kind: "private" },
      { cik: "3", name: "Fund 3", kind: "private" },
      { cik: "2", name: "Fund 2", kind: "private" },
      { cik: "1", name: "Fund 1", kind: "private" },
      { cik: "9", name: "Fund 4 Offshore Feeder", kind: "private", role: "sleeve" },
    ],
  }
}

function ladderRecords(): Map<string, OfferingRecord[]> {
  return new Map([
    // Two points 71 months apart.
    ["2", [
      rec({ cik: "2", filedAt: "2017-02-01", formType: "D", dateOfFirstSale: "2017-01-15", offeringAmount: 50_000_000, totalSold: 5_000_000 }),
      rec({ cik: "2", filedAt: "2023-01-10", dateOfFirstSale: "2017-01-15", offeringAmount: 50_000_000, totalSold: 24_300_000 }),
    ]],
    // Start 2021-05-15; points at months 0, 20, 40.
    ["3", [
      rec({ cik: "3", filedAt: "2021-05-20", formType: "D", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 0 }),
      rec({ cik: "3", filedAt: "2023-01-20", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 40_000_000 }),
      rec({ cik: "3", filedAt: "2024-09-20", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 61_700_000 }),
    ]],
    // Safe Harbor Fund 4's real trail: original filed 13 days after first sale, then two amendments.
    ["4", [
      rec({ cik: "4", filedAt: "2024-03-28", formType: "D", dateOfFirstSale: "2024-03-15", offeringAmount: 500_000_000, totalSold: 0, investorCount: 0 }),
      rec({ cik: "4", filedAt: "2025-07-22", dateOfFirstSale: "2024-03-15", offeringAmount: 300_000_000, totalSold: 52_918_863, investorCount: 30 }),
      rec({ cik: "4", filedAt: "2026-07-23", dateOfFirstSale: "2024-03-15", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 }),
    ]],
    // Named "Fund 1" but starts after everything else.
    ["1", [
      rec({ cik: "1", filedAt: "2026-02-01", formType: "D", dateOfFirstSale: "2026-01-20", offeringAmount: 20_000_000, totalSold: 10_300_000 }),
    ]],
    ["9", [
      rec({ cik: "9", filedAt: "2026-07-23", dateOfFirstSale: "2024-03-15", offeringAmount: 300_000_000, totalSold: 8_000_000 }),
    ]],
  ])
}

function ladder() {
  return buildVintagePacing(buildManagerRaises(ladderPeer(), ladderRecords(), ASOF, WINDOW))
}

test("vintages are ordered by start date, not by name", () => {
  const p = ladder()
  assert.deepEqual(
    p.vintages.map((v) => [v.ordinal, v.vehicleName]),
    [[1, "Fund 2"], [2, "Fund 3"], [3, "Fund 4"], [4, "Fund 1"]],
    "'Fund 1' started last and so is the fourth vintage"
  )
  assert.equal(p.vintages[0].startBasis, "first-sale")
})

test("sleeves are omitted from the curves and counted", () => {
  const p = ladder()
  assert.equal(p.sleevesOmitted, 1)
  assert.ok(!p.vintages.some((v) => v.cik === "9"), "the feeder is not a vintage of its own")
})

test("months run from first sale, and a filing before it reads as month 0", () => {
  const p = ladder()
  const fund4 = p.vintages.find((v) => v.vehicleName === "Fund 4")!
  assert.deepEqual(fund4.points.map((pt) => pt.month), [0, 16, 28], "28 months from 2024-03-15 to 2026-07-23")
  assert.equal(fund4.monthsIn, 28)
  assert.equal(fund4.points[0].sold, 0)
})

test("the comparison is the newest vintage with a curve against the one before it", () => {
  const p = ladder()
  const c = p.comparison!
  // Fund 1 is the newest vintage and has a curve, so it is the subject; Fund 4 is its predecessor.
  assert.equal(c.newest.vehicleName, "Fund 1")
  assert.equal(c.prior.vehicleName, "Fund 4")
  assert.equal(c.newest.month, 0)
  assert.equal(c.newest.sold, 10_300_000)
  assert.equal(c.priorAtMonth?.basis, "point", "Fund 4 has a filing at month 0")
  assert.equal(c.priorAtMonth?.sold, 0)
  assert.equal(c.pace, null, "no pace against a prior figure of zero")
  assert.equal(c.targetMultiple, 20_000_000 / 300_000_000)
})

test("Fund 4 against Fund 3: interpolated at month 28, between filings at 20 and 40", () => {
  // Drop Fund 1 so Fund 4 is the newest, which is the real Safe Harbor case.
  const records = ladderRecords()
  records.delete("1")
  const peer = ladderPeer()
  peer.vehicles = peer.vehicles.filter((v) => v.cik !== "1")
  const p = buildVintagePacing(buildManagerRaises(peer, records, ASOF, WINDOW))
  const c = p.comparison!
  assert.equal(c.newest.vehicleName, "Fund 4")
  assert.equal(c.prior.vehicleName, "Fund 3")
  assert.equal(c.newest.month, 28)
  assert.equal(c.priorAtMonth?.basis, "interpolated")
  assert.deepEqual(c.priorAtMonth?.between, [20, 40])
  // Straight line from 40.0M at month 20 to 61.7M at month 40, read at month 28.
  const expected = 40_000_000 + (8 / 20) * 21_700_000
  assert.ok(Math.abs((c.priorAtMonth?.sold ?? 0) - expected) < 1, "linear between the bracketing filings")
  assert.ok(c.pace! > 1.05, "Fund 4 is ahead of Fund 3's dollar pace")
  assert.equal(c.targetMultiple, 3, "the offering tripled")
  assert.deepEqual(c.priorLast, { sold: 61_700_000, month: 40 })

  const reading = buildPacingReading(p)
  assert.match(reading, /Fund 4 has raised \$64\.2M in 28 months/)
  assert.match(reading, /between its filings at 20 months and 40 months, not a reported one/, "interpolation is stated")
  assert.match(reading, /running ahead/)
  assert.match(reading, /3\.0× the size of its predecessor's, cut from \$500\.0M/)
  assert.match(reading, /Fund 3 last reported \$61\.7M at 40 months, 62% of its offering/)
  assert.match(reading, /show direction rather than a measured trajectory/)
})

test("when the prior's trail ends before the newest's month there is no same-month figure", () => {
  const pts: VintagePoint[] = [
    { month: 0, filedAt: "2020-01-01", sold: 0, target: 1, investorCount: null, cik: "x", accession: "a" },
    { month: 12, filedAt: "2021-01-01", sold: 10, target: 1, investorCount: null, cik: "x", accession: "b" },
  ]
  assert.equal(priorSoldAt(pts, 24), null, "no extrapolation past the last filing")
  assert.equal(priorSoldAt([pts[1]], 6), null, "no extrapolation before the first filing either")
  assert.deepEqual(priorSoldAt(pts, 6), { sold: 5, basis: "interpolated", between: [0, 12] })
  assert.deepEqual(priorSoldAt(pts, 12), { sold: 10, basis: "point", between: null })
  assert.equal(priorSoldAt([], 3), null)
})

test("beyond the prior's trail the reading says so rather than inventing a pace", () => {
  const peer = ladderPeer()
  peer.vehicles = peer.vehicles.filter((v) => ["2", "3"].includes(v.cik))
  const records = new Map([...ladderRecords()].filter(([k]) => ["2", "3"].includes(k)))
  // Fund 3 is at month 40; Fund 2's trail runs to month 71, so interpolation works. Cut it short.
  records.set("2", [records.get("2")![0]])
  const p = buildVintagePacing(buildManagerRaises(peer, records, ASOF, WINDOW))
  const c = p.comparison!
  assert.equal(c.priorAtMonth, null)
  assert.equal(c.pace, null)
  assert.deepEqual(c.priorLast, { sold: 5_000_000, month: 0 })
  const reading = buildPacingReading(p)
  assert.match(reading, /trail ends at 0 months with \$5\.0M, before the point the newer fund has reached/)
  assert.match(reading, /already passed that figure/)
})

test("an indefinite offering yields no target multiple and no subscribed share", () => {
  const records = ladderRecords()
  records.set("1", [rec({ cik: "1", filedAt: "2026-02-01", formType: "D", dateOfFirstSale: "2026-01-20", offeringAmount: "indefinite", totalSold: 10_300_000 })])
  const p = buildVintagePacing(buildManagerRaises(ladderPeer(), records, ASOF, WINDOW))
  assert.equal(p.comparison?.targetMultiple, null)
  assert.equal(p.vintages[3].progress, null)
  assert.match(buildPacingReading(p), /states no cap, so there is no share of offering to measure/)
  assert.doesNotMatch(buildPacingReading(p), /NaN|Infinity/)
})

test("two filings in the same month collapse to one point, the later standing", () => {
  const records = new Map([
    ["3", [
      rec({ cik: "3", filedAt: "2021-05-20", formType: "D", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 0 }),
      rec({ cik: "3", filedAt: "2021-05-28", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 2_000_000 }),
    ]],
  ])
  const peer = ladderPeer()
  peer.vehicles = peer.vehicles.filter((v) => v.cik === "3")
  const p = buildVintagePacing(buildManagerRaises(peer, records, ASOF, WINDOW))
  assert.equal(p.vintages[0].points.length, 1)
  assert.equal(p.vintages[0].points[0].sold, 2_000_000)
})

test("a filing with no amount sold contributes no point rather than a zero", () => {
  const records = new Map([
    ["3", [
      rec({ cik: "3", filedAt: "2021-05-20", formType: "D", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: null }),
      rec({ cik: "3", filedAt: "2023-01-20", dateOfFirstSale: "2021-05-15", offeringAmount: 100_000_000, totalSold: 40_000_000 }),
    ]],
  ])
  const peer = ladderPeer()
  peer.vehicles = peer.vehicles.filter((v) => v.cik === "3")
  const p = buildVintagePacing(buildManagerRaises(peer, records, ASOF, WINDOW))
  assert.deepEqual(p.vintages[0].points.map((pt) => [pt.month, pt.sold]), [[20, 40_000_000]])
})

test("one vintage means no comparison, and the reading says so", () => {
  const peer = ladderPeer()
  peer.vehicles = peer.vehicles.filter((v) => v.cik === "4")
  const records = new Map([["4", ladderRecords().get("4")!]])
  const p = buildVintagePacing(buildManagerRaises(peer, records, ASOF, WINDOW))
  assert.equal(p.comparison, null)
  assert.match(buildPacingReading(p), /one fund with a readable raise on file/)
  assert.match(buildPacingReading(p), /no earlier vintage to pace it against/)
})

test("no readable filing at all means no curve, said plainly", () => {
  const p = buildVintagePacing(buildManagerRaises(ladderPeer(), new Map(), ASOF, WINDOW))
  assert.equal(p.vintages.length, 0)
  assert.match(buildPacingReading(p), /no curve to draw/)
})

test("managersWithLadders keeps only managers with two or more vintages that have a curve", () => {
  const full = buildManagerRaises(ladderPeer(), ladderRecords(), ASOF, WINDOW)
  const single = buildManagerRaises(
    { ...ladderPeer(), id: "single", vehicles: [{ cik: "4", name: "Fund 4", kind: "private" }] },
    new Map([["4", ladderRecords().get("4")!]]),
    ASOF,
    WINDOW
  )
  const ladders = managersWithLadders([full, single])
  assert.deepEqual(ladders.map((l) => l.peerId), ["ladder"])
})
