import { test } from "node:test"
import assert from "node:assert/strict"
import { PEER_FIELD_CATALOG, derivedFields, peerFieldSpec, PRIVATE_FUND_LIMITS } from "./catalog"
import {
  activeRaises,
  buildManagerRaises,
  buildPeerCohort,
  defaultLaunchWindowStart,
  newLaunches,
  selfPositioning,
} from "./cohort"
import type { OfferingRecord } from "./form-d"
import { PEERS, peerById, type Peer } from "./registry"

const ASOF = "2026-10-21"
const WINDOW = "2025-10-21"

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string }): OfferingRecord {
  return {
    accession: `000${over.cik}-26-00000${over.filedAt.slice(-1)}`,
    formType: "D",
    entityName: "Test Fund LP",
    location: "Miami, FL",
    jurisdiction: "DE",
    offeringAmount: null,
    totalSold: null,
    remaining: null,
    investorCount: null,
    minimumInvestment: null,
    dateOfFirstSale: null,
    industryGroup: "Pooled Investment Fund",
    fundType: "Other Investment Fund",
    hasNonAccreditedInvestors: null, salesRecipients: [], relatedPersons: [],
    ...over,
  }
}

/** A manager with one fund and two sleeves, each reporting its own slice. */
function sleevedPeer(): Peer {
  return {
    id: "test-manager",
    manager: "Test Manager",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "direct",
    evidence: "A fixture standing in for a fund raised across an onshore LP and two offshore sleeves.",
    aliases: [],
    vehicles: [
      { cik: "100", name: "Test Fund VI LP", kind: "private" },
      { cik: "101", name: "Test Fund VI International LP", kind: "private", role: "sleeve" },
      { cik: "102", name: "Test Fund VI Master LP", kind: "private", role: "sleeve" },
    ],
  }
}

function sleevedRecords(): Map<string, OfferingRecord[]> {
  return new Map([
    ["100", [rec({ cik: "100", filedAt: "2026-08-01", offeringAmount: 500_000_000, totalSold: 100_000_000, investorCount: 20 })]],
    ["101", [rec({ cik: "101", filedAt: "2026-08-01", offeringAmount: 500_000_000, totalSold: 30_000_000, investorCount: 8 })]],
    ["102", [rec({ cik: "102", filedAt: "2026-08-01", offeringAmount: 500_000_000, totalSold: 10_000_000, investorCount: 2 })]],
  ])
}

test("capital sums over every vehicle but raises are counted over funds only", () => {
  const m = buildManagerRaises(sleevedPeer(), sleevedRecords(), ASOF, WINDOW)
  assert.equal(m.totalRaised, 140_000_000, "the sleeves' slices are part of the raise")
  assert.equal(m.raiseCount, 1, "one raise across three filers")
  assert.equal(m.raises.length, 3, "all three vehicles are still listed")
  assert.equal(m.totalSought, 500_000_000, "the sleeves restate the same ask and must not triple it")
})

test("a vehicle that returned no filing is skipped, not counted as a raise of zero", () => {
  const partial = new Map(sleevedRecords())
  partial.delete("101")
  const m = buildManagerRaises(sleevedPeer(), partial, ASOF, WINDOW)
  assert.equal(m.raises.length, 2)
  assert.equal(m.totalRaised, 110_000_000)

  const none = buildManagerRaises(sleevedPeer(), new Map(), ASOF, WINDOW)
  assert.equal(none.raises.length, 0)
  assert.equal(none.totalRaised, null, "null, not 0 — a fetch failure is not a manager who raised nothing")
  assert.equal(none.raiseCount, 0)
  assert.equal(none.inMarket, false)
})

test("indefinite offering amounts are counted, not summed into the ask", () => {
  const peer = sleevedPeer()
  const records = new Map([
    ["100", [rec({ cik: "100", filedAt: "2026-08-01", offeringAmount: "indefinite", totalSold: 75_000_000 })]],
  ])
  const m = buildManagerRaises(peer, records, ASOF, WINDOW)
  assert.equal(m.totalSought, null, "nothing numeric to sum")
  assert.equal(m.indefiniteTargets, 1)
  assert.equal(m.totalRaised, 75_000_000, "what was raised is still known")
})

test("a target cut is counted at manager level", () => {
  const records = new Map([
    [
      "100",
      [
        rec({ cik: "100", filedAt: "2024-03-01", offeringAmount: 500_000_000, totalSold: 0 }),
        rec({ cik: "100", filedAt: "2026-03-01", formType: "D/A", offeringAmount: 300_000_000, totalSold: 60_000_000 }),
      ],
    ],
  ])
  const m = buildManagerRaises(sleevedPeer(), records, ASOF, WINDOW)
  assert.equal(m.targetCutCount, 1)
  assert.equal(m.raises[0].raise.targetHigh, 500_000_000)
})

test("a manager silent for over a year is not in market", () => {
  const stale = new Map([
    ["100", [rec({ cik: "100", filedAt: "2023-01-01", offeringAmount: 100_000_000, totalSold: 50_000_000 })]],
  ])
  const m = buildManagerRaises(sleevedPeer(), stale, ASOF, WINDOW)
  assert.equal(m.openRaiseCount, 0)
  assert.equal(m.inMarket, false)
  assert.equal(m.lastFiled, "2023-01-01")
})

test("the launch window defaults to twelve months", () => {
  assert.equal(defaultLaunchWindowStart("2026-10-21"), "2025-10-21")
  assert.equal(defaultLaunchWindowStart("2026-01-05"), "2025-01-05")
})

test("a cohort over the real registry covers every manager in scope", () => {
  const cohort = buildPeerCohort("miami-dade", new Map(), ASOF)
  assert.equal(cohort.layer, "miami-dade")
  assert.equal(cohort.managers.length, PEERS.filter((p) => p.layer === "miami-dade").length)
  assert.ok(cohort.self, "Safe Harbor is a Miami-Dade manager and must appear as self")
  assert.equal(cohort.self?.isSelf, true)
  assert.equal(cohort.totals.totalRaised, null, "no records supplied")
  assert.equal(cohort.coverage.unresolvedVehicles, cohort.totals.vehicles, "nothing resolved, and Miami-Dade is all private")
})

test("coverage reports the two tiers, and the quarterly tier is national only", () => {
  assert.equal(buildPeerCohort("miami-dade", new Map(), ASOF).coverage.registeredVehicles, 0)
  assert.ok(buildPeerCohort("national", new Map(), ASOF).coverage.registeredVehicles >= 12)
})

test("a registered vehicle with no Form D is expected, not a gap", () => {
  // Nothing resolved, so every vehicle is absent from byCik. The registered
  // ones must not be counted as unresolved: they raise through a registered
  // offering and file no Form D at all.
  const national = buildPeerCohort("national", new Map(), ASOF)
  assert.equal(national.coverage.registeredWithoutFormD, national.coverage.registeredVehicles)
  assert.equal(national.coverage.unresolvedVehicles, national.coverage.privateVehicles)
  assert.equal(
    national.coverage.registeredWithoutFormD + national.coverage.unresolvedVehicles,
    national.totals.vehicles
  )

  // Miami-Dade has no registered vehicle, so every gap there is a real one.
  const local = buildPeerCohort("miami-dade", new Map(), ASOF)
  assert.equal(local.coverage.registeredWithoutFormD, 0)
  assert.equal(local.coverage.unresolvedVehicles, local.totals.vehicles)
})

test("managers are ordered by capital raised, and self stays in the list", () => {
  const shcp = peerById("safe-harbor-capital-partners")!
  const records = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 })]],
    ["1912768", [rec({ cik: "1912768", filedAt: "2026-08-11", offeringAmount: "indefinite", totalSold: 248_500_000, investorCount: 38 })]],
  ])
  const cohort = buildPeerCohort("miami-dade", records, ASOF)
  const ranked = cohort.managers.filter((m) => m.totalRaised != null)
  assert.equal(ranked[0].peerId, "rialto-capital-management", "Rialto raised more")
  assert.ok(cohort.managers.some((m) => m.peerId === shcp.id))
  assert.equal(cohort.totals.totalRaised, 312_668_863)
  assert.equal(cohort.totals.managersRaising, 2)
})

test("active raises exclude sleeves and closed raises", () => {
  const records = new Map(sleevedRecords())
  records.set("100", [rec({ cik: "100", filedAt: "2026-08-01", offeringAmount: 500_000_000, totalSold: 100_000_000 })])
  const cohort = {
    ...buildPeerCohort("miami-dade", new Map(), ASOF),
    managers: [buildManagerRaises(sleevedPeer(), records, ASOF, WINDOW)],
  }
  const active = activeRaises(cohort)
  assert.equal(active.length, 1, "three filers, one raise")
  assert.equal(active[0].cik, "100")
})

test("new launches are dated from first sale and exclude sleeves", () => {
  const records = new Map([
    ["100", [rec({ cik: "100", filedAt: "2026-06-01", dateOfFirstSale: "2026-05-01", offeringAmount: 100_000_000, totalSold: 5_000_000 })]],
    ["101", [rec({ cik: "101", filedAt: "2026-06-01", dateOfFirstSale: "2026-05-01", offeringAmount: 100_000_000, totalSold: 1_000_000 })]],
  ])
  const cohort = {
    ...buildPeerCohort("miami-dade", new Map(), ASOF),
    managers: [buildManagerRaises(sleevedPeer(), records, ASOF, WINDOW)],
  }
  assert.equal(newLaunches(cohort).length, 1)
  assert.equal(cohort.managers[0].newLaunchCount, 1)
})

test("self positioning stays silent below three comparable raises", () => {
  const two = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 })]],
    ["1912768", [rec({ cik: "1912768", filedAt: "2026-08-11", offeringAmount: 200_000_000, totalSold: 248_500_000 })]],
  ])
  assert.equal(selfPositioning(buildPeerCohort("miami-dade", two, ASOF)), null, "a percentile over two funds is noise")
})

test("self positioning ranks the firm's own raise against its peers", () => {
  const records = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 })]],
    ["1912768", [rec({ cik: "1912768", filedAt: "2026-08-11", offeringAmount: 400_000_000, totalSold: 200_000_000 })]],
    ["2026136", [rec({ cik: "2026136", filedAt: "2026-09-04", offeringAmount: 200_000_000, totalSold: 100_000_000 })]],
    ["2143451", [rec({ cik: "2143451", filedAt: "2026-07-06", offeringAmount: 100_000_000, totalSold: 50_000_000 })]],
  ])
  const pos = selfPositioning(buildPeerCohort("miami-dade", records, ASOF))
  assert.ok(pos)
  assert.equal(pos.peerCount, 3)
  assert.equal(pos.rankBySold, 3, "two peers raised more than $64.2M")
  assert.equal(pos.medianSold, 100_000_000)
  assert.equal(pos.medianProgress, 0.5)
})

test("every catalog key is unique and every derived field carries a formula", () => {
  const keys = PEER_FIELD_CATALOG.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const spec of derivedFields()) {
    assert.ok(spec.source.length > 10, `${spec.key} needs a formula, not a field name`)
  }
  assert.equal(peerFieldSpec("progress")?.kind, "derived")
  assert.equal(peerFieldSpec("totalSold")?.kind, "reported")
  assert.equal(peerFieldSpec("nope"), undefined)
})

test("the figures most open to misreading carry a caveat", () => {
  for (const key of ["offeringAmount", "totalSold", "investorCount", "progress", "isLikelyOpen", "totalSought"]) {
    assert.ok(peerFieldSpec(key)?.caveat, `${key} must say how it can mislead`)
  }
  assert.ok(PRIVATE_FUND_LIMITS.length >= 4)
  // The reporting limits must not read as "this does not exist": a private fund
  // computes its portfolio and performance, it just does not publish them.
  const joined = PRIVATE_FUND_LIMITS.join(" ")
  assert.match(joined, /not public/, "the limit is publication, not existence")
  assert.match(joined, /Form PF/, "the confidential SEC filing is named")
  assert.match(joined, /no redemption programme/, "the one structural limit is stated as such")
  assert.match(joined, /secondary sales/, "and is not overstated into 'no exit'")
})
