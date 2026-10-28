import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPeerCohort } from "./cohort"
import { agentsForManager, agentUsage, distributionRows, distributionSummary } from "./distribution"
import { parseFormD, type OfferingRecord, type SalesRecipient } from "./form-d"

const ASOF = "2026-10-21"

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string }): OfferingRecord {
  return {
    accession: "0001980247-26-003892", formType: "D", entityName: "Fund LP", location: "Tampa, FL",
    jurisdiction: "DE", offeringAmount: null, totalSold: null, remaining: null, investorCount: null,
    minimumInvestment: null, dateOfFirstSale: null, industryGroup: null, fundType: null,
    hasNonAccreditedInvestors: null, salesRecipients: [], relatedPersons: [], ...over,
  }
}

function agent(name: string, crd: string | null, location = "SALT LAKE CITY, UT"): SalesRecipient {
  return { name, crd, associatedBrokerDealer: null, location, states: ["All States"], foreignSolicitation: false }
}

/** Silverview's five real broker-dealers, as filed. */
const SILVERVIEW_AGENTS = [
  agent("NORTH CAPITAL PRIVATE SECURITIES CORPORATION", "000154559"),
  agent("OLD CITY SECURITIES LLC", "000171910"),
  agent("FNEX CAPITAL, LLC", "000166316"),
  agent("PROFOR ADVISORS", "000136084"),
  agent("CALAMAR FINANCIAL GROUP, LLC", "000283992"),
]

test("the sales compensation list is parsed, and 'None' is absent not a name", () => {
  const xml = `<?xml version="1.0"?><edgarSubmission>
    <salesCompensationList>
      <recipient>
        <recipientName>NORTH CAPITAL PRIVATE SECURITIES CORPORATION</recipientName>
        <recipientCRDNumber>000154559</recipientCRDNumber>
        <associatedBDName>None</associatedBDName>
        <associatedBDCRDNumber>None</associatedBDCRDNumber>
        <recipientAddress><street1>623 E FT UNION BLVD</street1><city>SALT LAKE CITY</city><stateOrCountry>UT</stateOrCountry></recipientAddress>
        <statesOfSolicitationList><value>All States</value></statesOfSolicitationList>
        <foreignSolicitation>false</foreignSolicitation>
      </recipient>
    </salesCompensationList>
    <hasNonAccreditedInvestors>false</hasNonAccreditedInvestors>
  </edgarSubmission>`
  const r = parseFormD(xml, { cik: "1980247", accession: "0001980247-26-003892", formType: "D/A", filedAt: "2026-06-05" })
  assert.equal(r.salesRecipients.length, 1)
  const [a] = r.salesRecipients
  assert.equal(a.name, "NORTH CAPITAL PRIVATE SECURITIES CORPORATION")
  assert.equal(a.crd, "000154559")
  assert.equal(a.associatedBrokerDealer, null, '"None" means absent, not a firm called None')
  assert.equal(a.location, "SALT LAKE CITY, UT")
  assert.deepEqual(a.states, ["All States"])
  assert.equal(a.foreignSolicitation, false)
  assert.equal(r.hasNonAccreditedInvestors, false)
})

test("a related person is read as the entity it is, not as an investor", () => {
  // A fund files its GP here, with "--" standing in for a first name.
  const xml = `<?xml version="1.0"?><edgarSubmission><relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>--</firstName><lastName>Silverview Credit Partners LP</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Promoter</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList></edgarSubmission>`
  const r = parseFormD(xml, { cik: "1", accession: "0000000001-26-000001", formType: "D", filedAt: "2026-06-05" })
  assert.equal(r.relatedPersons.length, 1)
  assert.equal(r.relatedPersons[0].name, "Silverview Credit Partners LP", "the placeholder is dropped")
  assert.deepEqual(r.relatedPersons[0].relationships, ["Executive Officer", "Promoter"])
})

test("an offering with no agents parses to an empty list, not a failure", () => {
  const r = parseFormD("<edgarSubmission><entityName>Fund</entityName></edgarSubmission>", {
    cik: "1", accession: "0000000001-26-000001", formType: "D", filedAt: "2026-06-05",
  })
  assert.deepEqual(r.salesRecipients, [])
  assert.deepEqual(r.relatedPersons, [])
  assert.equal(r.hasNonAccreditedInvestors, null, "unstated is null, not false")
})

function silverviewCohort() {
  return buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [rec({ cik: "1980247", filedAt: "2026-06-05", formType: "D/A", offeringAmount: "indefinite", totalSold: 262_593_673, investorCount: 232, minimumInvestment: 0, hasNonAccreditedInvestors: false, salesRecipients: SILVERVIEW_AGENTS })]],
      ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", formType: "D/A", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40, minimumInvestment: 100_000, hasNonAccreditedInvestors: false })]],
    ]),
    ASOF
  )
}

test("distribution reproduces Silverview's real raise, and contrasts it with ours", () => {
  const rows = distributionRows(silverviewCohort())
  // The firm's own row is pinned first wherever it appears.
  assert.equal(rows[0].isSelf, true)
  const self = rows[0]
  assert.equal(self.investorCount, 40)
  assert.equal(self.channel, "direct", "no agent named on Fund 4")
  assert.equal(Math.round((self.averageTicket as number) / 10_000) / 100, 1.6)

  const sv = rows.find((r) => r.manager === "Silverview Capital")!
  assert.equal(sv.investorCount, 232)
  assert.equal(sv.agents.length, 5)
  assert.equal(sv.channel, "intermediated")
  // $262.6M across 232 investors is a $1.13M average.
  assert.equal(Math.round((sv.averageTicket as number) / 10_000) / 100, 1.13)
  assert.equal(sv.minimumInvestment, 0)
  assert.equal(sv.hasNonAccredited, false)
})

test("agents are grouped on CRD, which survives name variation", () => {
  const cohort = buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [rec({ cik: "1980247", filedAt: "2026-06-05", totalSold: 100, salesRecipients: [agent("NORTH CAPITAL PRIVATE SECURITIES CORPORATION", "000154559")] })]],
      ["1980377", [rec({ cik: "1980377", filedAt: "2026-06-05", totalSold: 50, salesRecipients: [agent("North Capital Private Securities Corp.", "154559")] })]],
    ]),
    ASOF
  )
  const agents = agentUsage(cohort)
  assert.equal(agents.length, 1, "the same CRD is one firm however it is spelled")
  assert.equal(agents[0].funds, 2)
  assert.equal(agents[0].associatedRaised, 150)
})

test("an agent with no CRD groups on its normalised name", () => {
  const cohort = buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [rec({ cik: "1980247", filedAt: "2026-06-05", salesRecipients: [agent("Profor  Advisors", null)] })]],
      ["1980377", [rec({ cik: "1980377", filedAt: "2026-06-05", salesRecipients: [agent("PROFOR ADVISORS", null)] })]],
    ]),
    ASOF
  )
  assert.equal(agentUsage(cohort).length, 1)
})

test("agent usage leads with the firm used by the most managers", () => {
  const shared = agent("SHARED PLACEMENT LLC", "000999999")
  const cohort = buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [rec({ cik: "1980247", filedAt: "2026-06-05", totalSold: 100, salesRecipients: [...SILVERVIEW_AGENTS, shared] })]],
      ["1933138", [rec({ cik: "1933138", filedAt: "2026-06-05", totalSold: 100, salesRecipients: [shared] })]],
    ]),
    ASOF
  )
  const agents = agentUsage(cohort)
  assert.equal(agents[0].crd, "000999999", "used by two managers, so it leads")
  assert.equal(agents[0].managers.length, 2)
})

test("the summary separates intermediated from direct and gives the median ticket", () => {
  const s = distributionSummary(silverviewCohort())
  assert.equal(s.intermediated, 1)
  assert.ok(s.direct >= 1)
  assert.equal(s.agents, 5)
  assert.ok(s.medianTicket != null)
  // Only one manager uses each agent in this fixture, so nothing is "most used".
  assert.equal(s.mostUsed, null, "a single-manager agent is not a shared channel")
})

test("a manager with no readable raise is unknown, not direct", () => {
  const rows = distributionRows(buildPeerCohort("florida", new Map(), ASOF))
  assert.ok(rows.length > 0)
  assert.ok(rows.every((r) => r.channel === "unknown"))
  assert.ok(rows.every((r) => r.agents.length === 0))
})

test("a manager's agents are deduplicated across its own funds", () => {
  const cohort = buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [rec({ cik: "1980247", filedAt: "2026-06-05", salesRecipients: SILVERVIEW_AGENTS })]],
      ["1980377", [rec({ cik: "1980377", filedAt: "2026-06-05", salesRecipients: SILVERVIEW_AGENTS })]],
    ]),
    ASOF
  )
  const sv = cohort.managers.find((m) => m.manager === "Silverview Capital")!
  assert.equal(agentsForManager(sv).length, 5, "two funds, same five agents, listed once")
})

test("placeholder agent names are dropped, not treated as firms", () => {
  // Filers write "N/A" into recipientName. Taken literally it produced a
  // broker-dealer called N/A on sixteen funds, leading the agent table.
  for (const placeholder of ["N/A", "n/a", "None", "NA", "--", "-", "Not Applicable"]) {
    const xml = `<edgarSubmission><salesCompensationList><recipient>
      <recipientName>${placeholder}</recipientName>
    </recipient></salesCompensationList></edgarSubmission>`
    const r = parseFormD(xml, { cik: "1", accession: "0000000001-26-000001", formType: "D", filedAt: "2026-06-05" })
    assert.deepEqual(r.salesRecipients, [], `"${placeholder}" must not become a firm`)
  }
})

test("a real firm whose name merely contains those letters survives", () => {
  const xml = `<edgarSubmission><salesCompensationList><recipient>
    <recipientName>NATIONAL ADVISORS LLC</recipientName><recipientCRDNumber>000111111</recipientCRDNumber>
  </recipient></salesCompensationList></edgarSubmission>`
  const r = parseFormD(xml, { cik: "1", accession: "0000000001-26-000001", formType: "D", filedAt: "2026-06-05" })
  assert.equal(r.salesRecipients.length, 1)
  assert.equal(r.salesRecipients[0].name, "NATIONAL ADVISORS LLC")
})

test("agents are hoisted to the raise, not kept on every filing", () => {
  // The per-filing copies are stored in the weekly cache; keeping them on all
  // nine filings of sixty-five vehicles added 155 KB that nothing renders.
  const cohort = buildPeerCohort(
    "florida",
    new Map<string, OfferingRecord[]>([
      ["1980247", [
        rec({ cik: "1980247", filedAt: "2025-06-05", salesRecipients: SILVERVIEW_AGENTS }),
        rec({ cik: "1980247", filedAt: "2026-06-05", formType: "D/A", salesRecipients: SILVERVIEW_AGENTS, relatedPersons: [{ name: "Silverview Credit Partners LP", kind: "entity", relationships: ["Promoter"], clarification: null }] }),
      ]],
    ]),
    ASOF
  )
  const raise = cohort.managers.find((m) => m.manager === "Silverview Capital")!.raises[0].raise
  assert.equal(raise.salesRecipients.length, 5, "the raise keeps the newest filing's agents")
  assert.equal(raise.relatedPersons.length, 1)
  for (const filing of raise.filings) {
    assert.deepEqual(filing.salesRecipients, [], "not repeated per filing")
    assert.deepEqual(filing.relatedPersons, [])
  }
  // The trail still has everything it renders.
  assert.equal(raise.filings.length, 2)
  assert.ok(raise.filings.every((f) => f.accession && f.filedAt && f.formType))
})
