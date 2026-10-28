import { test } from "node:test"
import assert from "node:assert/strict"
import type { AdvFund } from "./adv"
import type { ManagerRaises, VehicleRaise } from "./cohort"
import {
  attribute,
  buildContinuationView,
  continuationKind,
  continuationQuery,
  knownPeople,
  predecessorOf,
  searchTerms,
  type AdvisedFund,
  type ContinuationHit,
} from "./continuation"
import type { Raise, RelatedPerson } from "./form-d"
import type { Peer } from "./registry"

const person = (name: string, kind: RelatedPerson["kind"] = "person"): RelatedPerson => ({ name, kind, relationships: [], clarification: null })

function raise(over: Partial<Raise> & { cik: string; fundName: string }): Raise {
  return {
    location: null,
    layerHint: null,
    filings: [{ cik: over.cik, accession: "0001-26-000001", formType: "D", filedAt: "2026-01-02", entityName: over.fundName, location: null, jurisdiction: null, offeringAmount: null, totalSold: null, remaining: null, investorCount: null, minimumInvestment: null, dateOfFirstSale: null, industryGroup: null, fundType: null, hasNonAccreditedInvestors: null, salesRecipients: [], relatedPersons: [] }],
    target: null,
    sold: null,
    investorCount: null,
    minimumInvestment: null,
    firstSale: null,
    firstFiled: "2026-01-02",
    lastFiled: "2026-01-02",
    fileNumber: null,
    progress: null,
    averageTicket: null,
    soldLastYear: null,
    investorsLastYear: null,
    targetCut: false,
    targetHigh: null,
    quartersSinceFiling: 0,
    salesRecipients: [],
    relatedPersons: [],
    hasNonAccreditedInvestors: null,
    terms: null,
    exemptionChanges: [],
    ...over,
  }
}

const vehicleRaise = (cik: string, name: string, people: RelatedPerson[]): VehicleRaise => ({
  raise: raise({ cik, fundName: name, relatedPersons: people, fileNumber: `021-${cik}` }),
  cik,
  vehicleName: name,
  role: "fund",
  kind: "private",
  open: true,
  newLaunch: false,
})

const peer: Peer = {
  id: "pretium-partners",
  manager: "Pretium Partners",
  layer: "national",
  location: "New York, NY",
  relevance: "adjacent",
  evidence: "",
  aliases: ["Pretium", "Pretium Real Estate Debt", "PRTM"],
  vehicles: [
    { cik: "100", name: "Pretium Residential Credit Fund III, LP", kind: "private" },
    { cik: "101", name: "Pretium Real Estate Debt Fund, LP", kind: "private" },
  ],
}

const manager: ManagerRaises = {
  peerId: peer.id,
  manager: peer.manager,
  layer: "national",
  location: peer.location,
  relevance: "adjacent",
  isSelf: false,
  raises: [
    vehicleRaise("100", "Pretium Residential Credit Fund III, LP", [person("Donald Mullen"), person("Pretium Residential Credit GP III, LLC", "entity")]),
    vehicleRaise("101", "Pretium Real Estate Debt Fund, LP", [person("Donald Mullen"), person("Jonathan Pruzan")]),
  ],
  totalRaised: null,
  totalSought: null,
  indefiniteTargets: 0,
  raiseCount: 2,
  openRaiseCount: 2,
  newLaunchCount: 0,
  targetCutCount: 0,
  lastFiled: "2026-01-02",
  inMarket: true,
}

function advFund(over: Partial<AdvFund> & { name: string }): AdvFund {
  return {
    fundId: null, state: null, country: null, generalPartners: [], umbrellaAdvisers: [], exclusion3c1: null, exclusion3c7: null,
    isMasterFund: null, feeders: [], isFeederFund: null, master: null, fundOfFunds: null, fundTypes: [], grossAssetValue: null,
    minimumInvestment: null, beneficialOwners: null, pctOwnedByRelated: null, pctOwnedByFundsOfFunds: null,
    salesLimitedToQualifiedClients: null, pctOwnedByNonUs: null, isSubadviser: null, otherAdvisersAdvise: null, clientsSolicited: null,
    pctClientsInvested: null, reliedOnRegulationD: null, formDFileNumber: null, annualAudit: null, gaap: null, auditors: [],
    statementsDistributed: null, opinion: null, usesPrimeBroker: null, primeBrokers: [], usesCustodian: null, custodians: [],
    administrators: [], pctAssetsValuedByOthers: null, marketers: [],
    ...over,
  }
}

/** As Pretium's ADV has it: the annex fund is only a feeder name on the master's record; the CV is its own record. */
const adv: AdvisedFund[] = [
  {
    crd: "171026",
    fund: advFund({
      name: "RCAF AGGREGATOR, LP",
      fundId: "805-1",
      fundTypes: ["hedge fund"],
      grossAssetValue: 3_297_114_103,
      beneficialOwners: 10,
      isMasterFund: true,
      feeders: [{ name: "PRETIUM RESIDENTIAL CREDIT ANNEX FUND, LP", fundId: "805-2" }],
      formDFileNumber: "021-473242",
    }),
  },
  {
    crd: "171026",
    fund: advFund({ name: "PRETIUM HOMES CV MASTER FUND, LP", fundId: "805-3", fundTypes: ["real estate fund"], grossAssetValue: 400_000_000, beneficialOwners: 7, isMasterFund: true, formDFileNumber: "021-9003" }),
  },
]

test("a name is marked by one of four words, and CV only as an upper-case token before a fund word", () => {
  assert.deepEqual(continuationKind("Bridge Multifamily CV LP"), { kind: "cv", term: "CV" })
  assert.deepEqual(continuationKind("Bridge Multifamily CV PV LP"), { kind: "cv", term: "CV" })
  assert.deepEqual(continuationKind("ARES SENIOR DIRECT LENDING CV MASTER FUND"), { kind: "cv", term: "CV" })
  assert.deepEqual(continuationKind("JFL-PURIS Continuation Fund, L.P."), { kind: "continuation", term: "continuation" })
  assert.deepEqual(continuationKind("H.I.G. Europe Realty Partners III Annex Fund, L.P."), { kind: "annex", term: "annex" })
  assert.deepEqual(continuationKind("Vista Extension Fund II"), { kind: "extension", term: "extension" })
  assert.equal(continuationKind("Cv Holdings LLC"), null, "a mixed-case 'Cv' is a name, not the marker")
  assert.equal(continuationKind("Pretium CV Platform Holdco, LP"), null, "CV before 'Platform' is not a continuation vehicle")
  assert.equal(continuationKind("Pretium Residential Credit Fund III, LP"), null)
})

test("search terms are the manager's names, then GP entities, then the people on most of its raises; one query per term", () => {
  const terms = searchTerms(peer, manager)
  assert.deepEqual(terms, [
    "Pretium Real Estate Debt",
    "Pretium Partners",
    "Pretium",
    "Pretium Residential Credit GP III, LLC",
    "Donald Mullen",
    "Jonathan Pruzan",
  ])
  assert.ok(!terms.includes("PRTM"), "a ticker matches nothing in a Form D")
  assert.equal(continuationQuery("Pretium Partners"), '"Pretium Partners" (continuation OR annex OR CV OR extension)')
  assert.equal(continuationQuery('Say "hi"'), '"Say hi" (continuation OR annex OR CV OR extension)')
  const many = searchTerms({ manager: "Big Firm", aliases: ["a1 x", "a2 x", "a3 x", "a4 x", "a5 x"] }, manager)
  assert.equal(many.length, 4 + 3, "names are capped at four; three people exist here")
})

test("a hit is attributed by ADV name (a feeder's included), by an identifying phrase, or by shared people — never by a one-word token", () => {
  const known = knownPeople(manager)
  assert.deepEqual(attribute("Pretium Residential Credit Annex Fund, LP", [], peer, adv, known), [
    { basis: "adv", crd: "171026", fundId: "805-2" },
  ])
  assert.deepEqual(attribute("Pretium Real Estate Debt Annex Fund, LP", [], peer, [], known), [
    { basis: "name", phrase: "Pretium Real Estate Debt" },
  ])
  assert.deepEqual(attribute("RCAF Continuation Fund, LP", [person("Donald Mullen"), person("Someone Else")], peer, [], known), [
    { basis: "people", names: ["Donald Mullen"] },
  ])
  assert.deepEqual(attribute("Pretium Continuation Fund, LP", [person("Nobody Known")], peer, [], known), [], "'Pretium' alone is one word")
})

test("the predecessor is the tracked vehicle whose name the stem begins", () => {
  const tracked = peer.vehicles.map((v) => ({ cik: v.cik, name: v.name }))
  assert.deepEqual(predecessorOf("Pretium Residential Credit Annex Fund, LP", "annex", tracked), { cik: "100", name: "Pretium Residential Credit Fund III, LP" })
  assert.equal(predecessorOf("Bridge Multifamily CV LP", "CV", tracked), null)
  assert.equal(predecessorOf("Annex Fund I", "annex", tracked), null, "no stem, no guess")
})

test("the view merges Form D hits with the ADV's funds and drops what nothing attributes", () => {
  const hits: ContinuationHit[] = [
    {
      cik: "900",
      name: "Pretium Residential Credit Annex Fund, LP",
      raise: raise({ cik: "900", fundName: "Pretium Residential Credit Annex Fund, LP", fileNumber: "021-9001", sold: 180_000_000, investorCount: 12, firstSale: "2023-02-01", relatedPersons: [person("Donald Mullen")] }),
    },
    { cik: "901", name: "Pretium Continuation Fund, LP", raise: raise({ cik: "901", fundName: "Pretium Continuation Fund, LP", relatedPersons: [person("Nobody Known")] }) },
    { cik: "902", name: "Pretium Residential Credit Fund IV, LP", raise: raise({ cik: "902", fundName: "Pretium Residential Credit Fund IV, LP" }) },
  ]
  const view = buildContinuationView(peer, manager, adv, hits, ["Pretium Partners"], true)
  assert.deepEqual(
    view.vehicles.map((v) => v.name),
    ["PRETIUM HOMES CV MASTER FUND, LP", "Pretium Residential Credit Annex Fund, LP"],
    "the CV from the ADV alone, the annex fund once (merged); the fund IV hit carries no term; largest first"
  )
  const v = view.vehicles[1]
  assert.equal(v.kind, "annex")
  assert.deepEqual(v.attribution.map((a) => a.basis), ["adv", "people"])
  assert.equal(v.formD?.sold, 180_000_000)
  assert.equal(v.formD?.fileNumber, "021-9001")
  assert.equal(v.adv?.grossAssetValue, null, "a feeder named on its master's record has no figure of its own")
  assert.equal(v.adv?.feederOf, "RCAF AGGREGATOR, LP")
  assert.deepEqual(v.predecessor, { cik: "100", name: "Pretium Residential Credit Fund III, LP" })
  assert.equal(v.tracked, false)
  assert.deepEqual(view.unconfirmed, [{ cik: "901", name: "Pretium Continuation Fund, LP" }])
  const cv = view.vehicles[0]
  assert.equal(cv.formD, null)
  assert.equal(cv.adv?.grossAssetValue, 400_000_000)
  assert.equal(cv.adv?.feederOf, null)

  const advOnly = buildContinuationView(peer, manager, adv, [], [], false)
  assert.equal(advOnly.vehicles.length, 2)
  assert.deepEqual(advOnly.vehicles[1].attribution, [{ basis: "adv", crd: "171026", fundId: "805-2" }])
  assert.equal(advOnly.searched, false)
  assert.equal(buildContinuationView(peer, manager, [], [], [], false).vehicles.length, 0)
})
