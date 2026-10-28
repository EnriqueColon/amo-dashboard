import { test } from "node:test"
import assert from "node:assert/strict"
import { buildManagerRaises } from "./cohort"
import type { OfferingRecord, OfferingTerms } from "./form-d"
import { peerById, type Peer } from "./registry"
import { describeExemptions, describeSecurities, formationLine, minimumChanges, structureRows } from "./structure"

const ASOF = "2026-10-21"
const WINDOW = "2025-10-21"

function terms(over: Partial<OfferingTerms> = {}): OfferingTerms {
  return {
    entityType: "Limited Partnership",
    yearOfInc: 2025,
    formedOverFiveYearsAgo: false,
    coIssuers: [],
    exemptions: ["06b", "3C", "3C.7"],
    securities: ["pooled-fund"],
    securitiesOther: null,
    moreThanOneYear: true,
    salesCommissions: { amount: 0, estimate: false },
    findersFees: { amount: 0, estimate: false },
    feesClarification: null,
    proceedsToInsiders: { amount: 0, estimate: false },
    proceedsClarification: null,
    ...over,
  }
}

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string; accession: string }): OfferingRecord {
  return {
    formType: "D/A", entityName: "Fund LP", location: "New York, NY", jurisdiction: "DELAWARE",
    offeringAmount: 1_000_000_000, totalSold: 100_000_000, remaining: null, investorCount: 10,
    minimumInvestment: 0, dateOfFirstSale: "2025-09-01", industryGroup: "Pooled Investment Fund",
    fundType: "Other Investment Fund", hasNonAccreditedInvestors: false, salesRecipients: [], relatedPersons: [],
    ...over,
  }
}

test("exemptions read as plain words, with the 3(c) umbrella dropped beside its sub-item", () => {
  assert.deepEqual(
    describeExemptions(["06b", "3C", "3C.1", "3C.5", "3C.7"]).map((e) => e.label),
    ["Rule 506(b)", "3(c)(1)", "3(c)(5)", "3(c)(7)"]
  )
  assert.match(describeExemptions(["06c"])[0].meaning, /may advertise/)
  assert.match(describeExemptions(["3C.5"])[0].meaning, /mortgage and real-estate/)
  assert.equal(describeExemptions(["3C"])[0].label, "Section 3(c)", "the umbrella alone is still shown")
  assert.deepEqual(describeExemptions(["3C.9"])[0], { code: "3C.9", label: "3(c)(9)", meaning: "an Investment Company Act exclusion" })
  assert.equal(describeExemptions(["zz"])[0].label, "zz", "an unknown code is shown as filed, not hidden")
})

test("securities and formation read as plain words", () => {
  assert.deepEqual(describeSecurities(["equity", "pooled-fund", "other"]), ["equity", "pooled investment fund interests", "other"])
  assert.equal(formationLine(terms({ yearOfInc: 2022 }), "DELAWARE"), "Delaware limited partnership, formed 2022")
  assert.equal(formationLine(terms({ yearOfInc: null, formedOverFiveYearsAgo: true, entityType: "Limited Liability Company" }), "DELAWARE"), "Delaware limited liability company, formed over five years ago")
  assert.equal(formationLine(terms({ yearOfInc: null, entityType: null }), null), "entity type not reported")
})

test("the minimum's history records each change and ignores filings that omit it", () => {
  const raise = buildManagerRaises(
    { ...(peerById("safe-harbor-capital-partners") as Peer) },
    new Map([["2017189", [
      rec({ cik: "2017189", accession: "a1", filedAt: "2024-03-28", minimumInvestment: 250_000 }),
      rec({ cik: "2017189", accession: "a2", filedAt: "2025-07-22", minimumInvestment: null }),
      rec({ cik: "2017189", accession: "a3", filedAt: "2026-07-23", minimumInvestment: 100_000 }),
    ]]]),
    ASOF, WINDOW
  ).raises[0].raise
  assert.deepEqual(minimumChanges(raise), [{ filedAt: "2026-07-23", from: 250_000, to: 100_000 }])
})

test("an untracked co-issuer is labelled so, and is not a double count", () => {
  // Safe Harbor Fund 4 files jointly with its Cayman feeder, which the registry does not track.
  const shcp = peerById("safe-harbor-capital-partners") as Peer
  const m = buildManagerRaises(shcp, new Map([["2017189", [
    rec({ cik: "2017189", accession: "a3", filedAt: "2026-07-23", offeringAmount: 300_000_000, terms: terms({
      coIssuers: [{ cik: "2017088", name: "Safe Harbor Equity Distressed Debt Fund 4 Feeder, L.P.", jurisdiction: "CAYMAN ISLANDS", entityType: "Limited Partnership", yearOfInc: 2023 }],
      salesCommissions: { amount: 2_000_000, estimate: true },
    }) }),
  ]]]), ASOF, WINDOW)
  const [row] = structureRows(m, [m])
  assert.equal(row.coIssuers[0].tracking, "untracked")
  assert.equal(row.coIssuers[0].doubleCounted, false)
  assert.ok(Math.abs((row.commissionShare ?? 0) - 2_000_000 / 300_000_000) < 1e-12, "commissions over the offering amount")
})

test("a tracked co-issuer whose own trail holds the same filing is flagged as counted twice", () => {
  // Bridge Debt Strategies Fund VI and its International sleeve are both tracked.
  const bridge = peerById("bridge-investment-group") as Peer
  const shared = "0002151824-26-000001"
  const m = buildManagerRaises(bridge, new Map([
    ["2151824", [rec({ cik: "2151824", accession: shared, filedAt: "2026-08-27", terms: terms({
      coIssuers: [{ cik: "2151821", name: "Bridge Debt Strategies Fund VI International LP", jurisdiction: "DELAWARE", entityType: "Limited Partnership", yearOfInc: 2025 }],
    }) })]],
    ["2151821", [rec({ cik: "2151821", accession: shared, filedAt: "2026-08-27", terms: terms() })]],
  ]), ASOF, WINDOW)
  const fund = structureRows(m, [m]).find((r) => r.cik === "2151824")!
  assert.equal(fund.coIssuers[0].tracking, "this-manager")
  assert.equal(fund.coIssuers[0].trackedAs, "Bridge Debt Strategies Fund VI International LP")
  assert.equal(fund.coIssuers[0].doubleCounted, true, "the same accession in both trails")
})

test("rows put funds before sleeves, skip vehicles cached without terms, and never divide by an indefinite offering", () => {
  const bridge = peerById("bridge-investment-group") as Peer
  const m = buildManagerRaises(bridge, new Map([
    ["2151821", [rec({ cik: "2151821", accession: "s1", filedAt: "2026-08-27", offeringAmount: "indefinite", terms: terms({ salesCommissions: { amount: 500_000, estimate: true } }) })]],
    ["2151824", [rec({ cik: "2151824", accession: "f1", filedAt: "2026-08-27", terms: terms() })]],
    ["2151822", [rec({ cik: "2151822", accession: "m1", filedAt: "2026-08-27" })]],
  ]), ASOF, WINDOW)
  const rows = structureRows(m, [m])
  assert.deepEqual(rows.map((r) => r.role), ["fund", "sleeve"])
  assert.ok(!rows.some((r) => r.cik === "2151822"), "no terms, no row — not an empty one")
  assert.equal(rows[1].commissionShare, null, "no share of an indefinite offering")
})
