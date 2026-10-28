import { test } from "node:test"
import assert from "node:assert/strict"
import { layerForLocation } from "./edgar-contract"
import {
  PEERS,
  UNRESOLVED_WATCH,
  fundVehiclesInScope,
  nonTradedVehiclesInScope,
  peerById,
  peersForLayer,
  peersInScope,
  registeredVehiclesInScope,
  selfPeer,
  vehiclesInScope,
} from "./registry"

test("ids are unique and slug-shaped", () => {
  const ids = PEERS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/)
})

test("every CIK is unique across the whole registry", () => {
  const ciks = PEERS.flatMap((p) => p.vehicles.map((v) => v.cik))
  const dupes = ciks.filter((c, i) => ciks.indexOf(c) !== i)
  assert.deepEqual(dupes, [], "a CIK in two managers would double-count a raise")
})

test("CIKs are stored unpadded, as Archives paths use them", () => {
  for (const p of PEERS) {
    for (const v of p.vehicles) {
      assert.match(v.cik, /^[1-9]\d*$/, `${p.manager}: ${v.cik}`)
    }
  }
})

test("every peer has at least one vehicle, or it has nothing to show", () => {
  for (const p of PEERS) assert.ok(p.vehicles.length > 0, p.manager)
})

test("every peer carries evidence for its relevance claim", () => {
  for (const p of PEERS) {
    assert.ok(p.evidence.trim().length > 40, `${p.manager} needs a real evidence note`)
    assert.ok(p.relevance === "direct" || p.relevance === "adjacent")
  }
})

test("Safe Harbor is in the registry exactly once, as self, in Miami-Dade", () => {
  const selves = PEERS.filter((p) => p.isSelf)
  assert.equal(selves.length, 1)
  const self = selfPeer()
  assert.equal(self?.id, "safe-harbor-capital-partners")
  assert.equal(self?.layer, "miami-dade")
  assert.equal(self?.vehicles.length, 4, "four fund vintages")
  assert.deepEqual(
    self?.vehicles.map((v) => v.cik).sort(),
    ["1637588", "1685329", "1778808", "2017189"].sort()
  )
})

test("each peer's stated location agrees with the layer it is filed under", () => {
  for (const p of PEERS) {
    if (p.layer === "national") continue
    assert.equal(
      layerForLocation(p.location),
      p.layer,
      `${p.manager} is filed as ${p.layer} but sits in ${p.location}`
    )
  }
})

test("layers are cumulative upward, so a local peer is still a peer nationally", () => {
  const local = peersInScope("miami-dade")
  const state = peersInScope("florida")
  const national = peersInScope("national")
  assert.ok(local.length > 0)
  assert.ok(state.length > local.length)
  assert.equal(national.length, PEERS.length)
  for (const p of local) {
    assert.ok(state.some((q) => q.id === p.id), `${p.manager} missing from the Florida view`)
    assert.ok(national.some((q) => q.id === p.id), `${p.manager} missing from the national view`)
  }
})

test("the Florida layer holds no Miami-Dade manager and vice versa", () => {
  for (const p of peersForLayer("florida")) assert.notEqual(layerForLocation(p.location), "miami-dade")
  for (const p of peersForLayer("miami-dade")) assert.equal(layerForLocation(p.location), "miami-dade")
})

test("Safe Harbor appears in all three layers' scopes", () => {
  for (const layer of ["miami-dade", "florida", "national"] as const) {
    assert.ok(peersInScope(layer).some((p) => p.isSelf), `self missing from ${layer}`)
  }
})

test("vehicles flatten with their manager attached", () => {
  const all = vehiclesInScope("national")
  assert.equal(all.length, PEERS.flatMap((p) => p.vehicles).length)
  const shcp = all.filter((v) => v.peerId === "safe-harbor-capital-partners")
  assert.equal(shcp.length, 4)
  assert.equal(shcp[0].manager, "Safe Harbor Capital Partners")
})

test("the registered tier exists nationally and is empty locally", () => {
  assert.equal(registeredVehiclesInScope("miami-dade").length, 0, "no Miami-Dade filer reports quarterly")
  assert.ok(registeredVehiclesInScope("national").length >= 8, "the quarterly tier lives in the national layer")
  for (const v of registeredVehiclesInScope("national")) assert.equal(v.kind, "registered")
})

test("peerById resolves and misses cleanly", () => {
  assert.equal(peerById("bh3-management")?.manager, "BH3 Management")
  assert.equal(peerById("nobody"), undefined)
})

test("sleeves are excluded from the fund count but kept for summing capital", () => {
  const all = vehiclesInScope("national")
  const funds = fundVehiclesInScope("national")
  assert.ok(funds.length < all.length, "some vehicles are sleeves of a larger raise")
  for (const v of funds) assert.notEqual(v.role, "sleeve")

  // Bridge Debt Strategies Fund VI is one raise across four CIKs.
  const bridge = all.filter((v) => v.peerId === "bridge-investment-group")
  const bridgeFunds = funds.filter((v) => v.peerId === "bridge-investment-group")
  assert.equal(bridge.length, 6)
  assert.equal(bridgeFunds.length, 2, "two vintages, not six raises")
})

test("a vehicle without an explicit role counts as a fund", () => {
  const self = selfPeer()!
  for (const v of self.vehicles) assert.equal(v.role, undefined)
  assert.equal(fundVehiclesInScope("miami-dade").filter((v) => v.peerId === self.id).length, 4)
})

test("Rialto is a Miami-Dade direct peer, found by targeted lookup", () => {
  const rialto = peerById("rialto-capital-management")
  assert.equal(rialto?.layer, "miami-dade")
  assert.equal(rialto?.relevance, "direct")
  assert.ok((rialto?.vehicles.length ?? 0) >= 9)
  assert.ok(peersForLayer("miami-dade").some((p) => p.id === "rialto-capital-management"))
})

test("every manager resolved by lookup is in the registry, and the watch list is empty", () => {
  for (const id of [
    "rialto-capital-management",
    "madison-realty-capital",
    "bridge-investment-group",
    "pretium-partners",
    "gelt-financial",
  ]) {
    assert.ok(peerById(id), `${id} missing`)
  }
  assert.deepEqual([...UNRESOLVED_WATCH], [], "a name here must have come back empty from a real lookup")
})

test("the private credit tier is kept, and marked adjacent rather than direct", () => {
  for (const id of ["blue-owl", "apollo", "ares", "hps"]) {
    const p = peerById(id)
    assert.ok(p, `${id} missing`)
    assert.equal(p?.layer, "national")
    assert.equal(p?.relevance, "adjacent", "broader private credit is not a CRE lender")
  }
})

test("no omitted feeder shell slipped in", () => {
  // Madison files one "Holdings LLC" per vintage, each a $125,000 target fully
  // sold to 125 investors. They are structural, not raises.
  for (const v of vehiclesInScope("national")) {
    assert.ok(!/Holdings LLC$/i.test(v.name), `${v.name} is a feeder shell and should be omitted`)
  }
})

test("every registered vehicle declares whether its shares trade", () => {
  // The distinction decides what the flows mean: for a non-traded vehicle
  // repurchases are investors being paid out, for a listed one they are a
  // buyback. A registered vehicle without it would be silently misread.
  for (const v of registeredVehiclesInScope("national")) {
    assert.ok(
      v.quoted === "listed" || v.quoted === "non-traded",
      `${v.manager} / ${v.name} must declare listed or non-traded`
    )
  }
})

test("quotation is only set where it means something", () => {
  for (const v of vehiclesInScope("national")) {
    if (v.kind === "private") {
      assert.equal(v.quoted, undefined, `${v.name}: a private fund's units do not trade`)
    }
  }
})

test("the non-traded subset is where investor liquidity is observable", () => {
  const nonTraded = nonTradedVehiclesInScope("national")
  const registered = registeredVehiclesInScope("national")
  assert.ok(nonTraded.length > 0)
  assert.ok(nonTraded.length < registered.length, "some of the tier is listed")
  for (const v of nonTraded) assert.equal(v.quoted, "non-traded")
  assert.equal(nonTradedVehiclesInScope("miami-dade").length, 0)
})
