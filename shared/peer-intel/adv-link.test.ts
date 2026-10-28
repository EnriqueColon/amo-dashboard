import { test } from "node:test"
import assert from "node:assert/strict"
import type { AdvFund } from "./adv"
import { advForVehicle, advisersToRead, fundKey, managerAdv, summarise, type AdvExtract } from "./adv-link"
import type { Peer } from "./registry"

const adviser = (crd: string, name: string) => ({ crd, secNumber: null, name, basis: "test", confirmedOn: "2026-10-27" })

function fund(over: Partial<AdvFund> & { name: string }): AdvFund {
  return {
    fundId: null,
    state: null,
    country: null,
    generalPartners: [],
    umbrellaAdvisers: [],
    exclusion3c1: null,
    exclusion3c7: null,
    isMasterFund: null,
    feeders: [],
    isFeederFund: null,
    master: null,
    fundOfFunds: null,
    fundTypes: [],
    grossAssetValue: null,
    minimumInvestment: null,
    beneficialOwners: null,
    pctOwnedByRelated: null,
    pctOwnedByFundsOfFunds: null,
    salesLimitedToQualifiedClients: null,
    pctOwnedByNonUs: null,
    isSubadviser: null,
    otherAdvisersAdvise: null,
    clientsSolicited: null,
    pctClientsInvested: null,
    reliedOnRegulationD: null,
    formDFileNumber: null,
    annualAudit: null,
    gaap: null,
    auditors: [],
    statementsDistributed: null,
    opinion: null,
    usesPrimeBroker: null,
    primeBrokers: [],
    usesCustodian: null,
    custodians: [],
    administrators: [],
    pctAssetsValuedByOthers: null,
    marketers: [],
    ...over,
  }
}

function extractWith(entries: Record<string, { adviserName: string; funds: AdvFund[]; fundsReported?: number | null; notes?: string[] }>): AdvExtract {
  const advisers: AdvExtract["advisers"] = {}
  for (const [crd, e] of Object.entries(entries)) {
    advisers[crd] = {
      crd,
      adviserName: e.adviserName,
      filingType: "Annual Amendment - All Sections",
      filedOn: "2026-03-31",
      fundsReported: e.fundsReported ?? e.funds.length,
      funds: e.funds,
      notes: e.notes ?? [],
      fetchedOn: "2026-10-27",
      pdfBytes: 1,
      pages: 1,
    }
  }
  return { refreshedOn: "2026-10-27", advisers }
}

const peer = (over: Partial<Peer>): Peer => ({
  id: "x",
  manager: "X",
  layer: "national",
  location: "Miami, FL",
  relevance: "direct",
  evidence: "",
  aliases: [],
  vehicles: [],
  ...over,
})

test("a manager's adviser is read unless every tracked vehicle has its own", () => {
  const blackstoneLike = peer({
    adviser: adviser("296294", "BDC ADVISORS"),
    vehicles: [
      { cik: "1", name: "Listed REIT", kind: "registered" },
      { cik: "2", name: "Non-traded REIT", kind: "registered", adviser: adviser("288053", "REIT ADVISORS") },
      { cik: "3", name: "BDC", kind: "registered", adviser: adviser("296294", "BDC ADVISORS") },
    ],
  })
  assert.deepEqual(
    advisersToRead(blackstoneLike).map((s) => [s.crd, s.scope]),
    [["288053", "vehicle"], ["296294", "vehicle"]],
    "the manager's CRD is already read as a vehicle's, and is not read twice"
  )

  const apolloLike = peer({
    adviser: adviser("143161", "UMBRELLA"),
    vehicles: [{ cik: "4", name: "BDC", kind: "registered", adviser: adviser("156115", "CREDIT MANAGEMENT") }],
  })
  assert.deepEqual(advisersToRead(apolloLike).map((s) => s.crd), ["156115"], "the 165 MB umbrella filing is skipped")

  const plain = peer({ adviser: adviser("305314", "SAFE HARBOR"), vehicles: [{ cik: "5", name: "Fund 4, L.P.", kind: "private" }] })
  assert.deepEqual(advisersToRead(plain).map((s) => [s.crd, s.scope]), [["305314", "manager"]])
  assert.deepEqual(advisersToRead(peer({ noAdviser: { checkedOn: "2026-10-26", note: "none" } })), [])
})

test("fund names fold to one key across case, punctuation and entity suffix, keeping parentheticals", () => {
  assert.equal(fundKey("SAFE HARBOR EQUITY DISTRESSED DEBT FUND 4, L.P."), fundKey("Safe Harbor Equity Distressed Debt Fund 4, L.P."))
  assert.equal(fundKey("BH3 DEBT OPPORTUNITY FUND III L.P."), fundKey("BH3 Debt Opportunity Fund III, LP"))
  assert.equal(fundKey("Camden Credit Opportunity Fund, LLC - Series V"), fundKey("CAMDEN CREDIT OPPORTUNITY FUND, LLC SERIES V"))
  assert.notEqual(
    fundKey("Bayview Opportunity Fund Domestic (Employee) VII, L.P."),
    fundKey("Bayview Opportunity Fund Domestic VII, L.P."),
    "a parenthetical tells sibling vehicles apart and must survive"
  )
})

test("a fund links by Form D file number before name, and a master and feeder both attach", () => {
  const p = peer({
    adviser: adviser("157053", "BAYVIEW"),
    vehicles: [
      { cik: "10", name: "Bayview Opportunity Fund Domestic VII, L.P.", kind: "private" },
      { cik: "11", name: "Bayview Opportunity Fund Domestic (Employee) VII, L.P.", kind: "private" },
      { cik: "12", name: "Suttons Bay Fund, L.P.", kind: "private" },
    ],
  })
  const master = fund({ name: "BAYVIEW OPPORTUNITY MASTER FUND VII, L.P.", fundId: "805-1", formDFileNumber: "021-446363", isMasterFund: true, grossAssetValue: 1_000 })
  const feeder = fund({ name: "BAYVIEW OPPORTUNITY (US) FEEDER VII, L.P.", fundId: "805-2", formDFileNumber: "021-446363", isFeederFund: true, grossAssetValue: 400 })
  const byName = fund({ name: "SUTTONS BAY FUND, L.P.", fundId: "805-3", formDFileNumber: null, grossAssetValue: 50 })
  const other = fund({ name: "WHITETAIL MSR MASTER FUND A, L.P.", fundId: "805-4", formDFileNumber: "021-9", grossAssetValue: 2_000 })
  const extract = extractWith({ "157053": { adviserName: "BAYVIEW ASSET MANAGEMENT, LLC", funds: [master, feeder, byName, other] } })

  const view = managerAdv(p, extract, [
    { cik: "10", name: "Bayview Opportunity Fund Domestic VII, L.P.", fileNumber: "021-446363" },
    { cik: "11", name: "Bayview Opportunity Fund Domestic (Employee) VII, L.P.", fileNumber: "021-446364" },
    { cik: "12", name: "Suttons Bay Fund, L.P.", fileNumber: null },
  ])!
  assert.ok(view)
  assert.deepEqual(
    view.linked.map((l) => [l.fund.fundId, l.vehicleCik, l.linkBasis]),
    [["805-1", "10", "file-number"], ["805-2", "10", "file-number"], ["805-3", "12", "name"]]
  )
  assert.deepEqual(advForVehicle(view, "10").map((l) => l.fund.fundId), ["805-1", "805-2"], "master first, then its feeder")
  assert.deepEqual(advForVehicle(view, "11"), [], "no ADV fund quotes the employee vehicle's file number")
  assert.deepEqual(view.others.map((o) => o.fundId), ["805-4"])
  assert.equal(view.summary.funds, 4)
  assert.equal(view.summary.feeders, 1)
  assert.equal(view.summary.grossAssetValue, 3_050, "the feeder's 400 is inside the master's and is not added")
  assert.equal(view.summary.grossAssetValueFunds, 3)
  assert.equal(view.filings[0].fundsParsed, 4)
  assert.deepEqual(view.linked[0].series.map((s) => [s.year, s.basis, s.grossAssetValue]), [[2026, "current", 1_000]], "without history, the series is the current point alone")
  assert.deepEqual(view.years.map((y) => [y.year, y.funds, y.grossAssetValue]), [[2026, 4, 3_050]])

  const withHistory = managerAdv(p, extract, [{ cik: "10", name: "Bayview Opportunity Fund Domestic VII, L.P.", fileNumber: "021-446363" }], {
    builtOn: "2026-10-27",
    source: "test",
    coverage: { from: "2023-03-30", to: "2024-03-28" },
    funds: {
      "805-1": {
        crd: "157053",
        names: ["BAYVIEW OPPORTUNITY MASTER FUND VII, L.P."],
        points: [
          { filedOn: "2023-03-30", filingId: 1, annual: true, grossAssetValue: 600, owners: 40, annualAudit: true, statementsDistributed: true, opinion: "unqualified", isFeederFund: false },
          { filedOn: "2024-03-28", filingId: 2, annual: true, grossAssetValue: 900, owners: 55, annualAudit: true, statementsDistributed: true, opinion: "unqualified", isFeederFund: false },
        ],
      },
      "805-4": {
        crd: "157053",
        names: ["WHITETAIL MSR MASTER FUND A, L.P."],
        points: [{ filedOn: "2024-03-28", filingId: 2, annual: true, grossAssetValue: 1_500, owners: 3, annualAudit: true, statementsDistributed: true, opinion: "unqualified", isFeederFund: false }],
      },
    },
  })!
  const master7 = withHistory.linked.find((l) => l.fund.fundId === "805-1")!
  assert.deepEqual(master7.series.map((s) => [s.year, s.basis, s.grossAssetValue, s.owners]), [[2023, "annual", 600, 40], [2024, "annual", 900, 55], [2026, "current", 1_000, null]])
  assert.deepEqual(master7.notes.map((n) => n.text), ["gross assets rose 50% between the 2023 and 2024 filings", "owners rose from 40 to 55"])
  assert.deepEqual(withHistory.years.map((y) => [y.year, y.funds, y.grossAssetValue]), [[2023, 1, 600], [2024, 2, 2_400], [2026, 4, 3_050]])
})

test("the summary counts audit answers and opinions, and a manager with no entry gets no view", () => {
  const s = summarise([
    fund({ name: "a", annualAudit: true, opinion: "unqualified", statementsDistributed: true, reliedOnRegulationD: true, fundTypes: ["real estate fund"], grossAssetValue: 10 }),
    fund({ name: "b", annualAudit: true, opinion: "report-not-yet-received", statementsDistributed: false, reliedOnRegulationD: true, fundTypes: ["real estate fund"], grossAssetValue: 5 }),
    fund({ name: "c", annualAudit: false, opinion: null, statementsDistributed: null, fundTypes: ["other private fund"], grossAssetValue: 20 }),
    fund({ name: "d", annualAudit: null, opinion: "not-unqualified", fundTypes: [], grossAssetValue: null }),
  ])
  assert.deepEqual(s.audit, { audited: 2, notAudited: 1, unanswered: 1 })
  assert.deepEqual(s.opinions, { unqualified: 1, notUnqualified: 1, reportNotYetReceived: 1, unanswered: 1 })
  assert.equal(s.statementsNotDistributed, 1)
  assert.equal(s.regulationD, 2)
  assert.deepEqual(s.byType, [
    { type: "other private fund", funds: 1, grossAssetValue: 20 },
    { type: "real estate fund", funds: 2, grossAssetValue: 15 },
    { type: "type not reported", funds: 1, grossAssetValue: 0 },
  ])
  assert.equal(summarise([]).grossAssetValue, null, "no figure is not zero")

  const extract = extractWith({ "1": { adviserName: "SOMEONE ELSE", funds: [] } })
  assert.equal(managerAdv(peer({ adviser: adviser("2", "UNREAD") }), extract, []), null)
  assert.equal(managerAdv(peer({ adviser: adviser("1", "READ") }), null, []), null)
  const empty = managerAdv(peer({ adviser: adviser("1", "READ") }), extractWith({ "1": { adviserName: "READ", funds: [], fundsReported: null, notes: ["7.B.(1) reports no private funds"] } }), [])!
  assert.equal(empty.summary.funds, 0)
  assert.deepEqual(empty.filings[0].notes, ["7.B.(1) reports no private funds"])
})
