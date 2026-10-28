import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRaise, isLikelyOpen, isNewLaunch, parseFormD, parseTerms, type OfferingRecord } from "./form-d"

/** Shaped like the real primary_doc.xml, including the nested dateOfFirstSale wrapper. */
function xml(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) =>
      k === "dateOfFirstSale"
        ? `<dateOfFirstSale><value>${v}</value></dateOfFirstSale>`
        : `<${k}>${v}</${k}>`
    )
    .join("\n")
  return `<?xml version="1.0"?><edgarSubmission>${body}</edgarSubmission>`
}

const ctx = { cik: "0002017189", accession: "0002017189-26-000007", formType: "D/A", filedAt: "2026-07-23" }

test("parses the offering figures from a Form D", () => {
  const r = parseFormD(
    xml({
      entityName: "Safe Harbor Equity Distressed Debt Fund 4, L.P.",
      totalOfferingAmount: "300000000",
      totalAmountSold: "64168863",
      totalRemaining: "235831137",
      totalNumberAlreadyInvested: "40",
      minimumInvestmentAccepted: "100000",
      dateOfFirstSale: "2024-03-15",
      industryGroupType: "Pooled Investment Fund",
      investmentFundType: "Other Investment Fund",
    }),
    ctx
  )
  assert.equal(r.entityName, "Safe Harbor Equity Distressed Debt Fund 4, L.P.")
  assert.equal(r.cik, "2017189", "CIK is stored unpadded")
  assert.equal(r.offeringAmount, 300_000_000)
  assert.equal(r.totalSold, 64_168_863)
  assert.equal(r.investorCount, 40)
  assert.equal(r.minimumInvestment, 100_000)
  assert.equal(r.dateOfFirstSale, "2024-03-15")
  assert.equal(r.fundType, "Other Investment Fund")
})

test('an "Indefinite" target is a real answer, not missing data', () => {
  const r = parseFormD(xml({ totalOfferingAmount: "Indefinite", totalRemaining: "Indefinite", totalAmountSold: "650000000" }), ctx)
  assert.equal(r.offeringAmount, "indefinite")
  assert.equal(r.remaining, "indefinite")
  assert.equal(r.totalSold, 650_000_000)
})

test("XML entities in fund names are decoded", () => {
  const r = parseFormD(xml({ entityName: "R &amp; R Capital Opportunity Fund LLC" }), ctx)
  assert.equal(r.entityName, "R & R Capital Opportunity Fund LLC")
  assert.equal(
    parseFormD(xml({ entityName: "SEGLO PRIVATE CREDIT &amp; OPPORTUNITY FUND LLC" }), ctx).entityName,
    "SEGLO PRIVATE CREDIT & OPPORTUNITY FUND LLC"
  )
  assert.equal(parseFormD(xml({ entityName: "Smith &#38; Co Fund" }), ctx).entityName, "Smith & Co Fund")
  assert.equal(parseFormD(xml({ entityName: "O&apos;Brien Credit LP" }), ctx).entityName, "O'Brien Credit LP")
})

test("absent fields are null, never zero", () => {
  const r = parseFormD(xml({ entityName: "Some Fund LP" }), ctx)
  assert.equal(r.offeringAmount, null)
  assert.equal(r.totalSold, null)
  assert.equal(r.investorCount, null, "a fund reporting no count is not a fund with no investors")
  assert.equal(r.dateOfFirstSale, null)
})

/** The control case: Safe Harbor Equity Distressed Debt Fund 4's real trail. */
function shcpFund4(): OfferingRecord[] {
  const base = { cik: "2017189", entityName: "Safe Harbor Equity Distressed Debt Fund 4, L.P.", location: "Miami Beach, FL", jurisdiction: "DE", remaining: null, dateOfFirstSale: "2024-03-15", industryGroup: "Pooled Investment Fund", fundType: "Other Investment Fund", minimumInvestment: 100_000, hasNonAccreditedInvestors: false, salesRecipients: [], relatedPersons: [] }
  return [
    { ...base, accession: "0002017189-24-000001", formType: "D", filedAt: "2024-03-28", offeringAmount: 500_000_000, totalSold: 0, investorCount: 0 },
    { ...base, accession: "0002017189-25-000002", formType: "D/A", filedAt: "2025-07-22", offeringAmount: 300_000_000, totalSold: 52_918_863, investorCount: 30 },
    { ...base, accession: "0002017189-26-000007", formType: "D/A", filedAt: "2026-07-23", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 },
  ]
}

test("reproduces the Safe Harbor Fund 4 trail exactly", () => {
  const r = buildRaise(shcpFund4(), "2026-10-21")
  assert.ok(r)
  assert.equal(r.cik, "2017189")
  assert.equal(r.target, 300_000_000)
  assert.equal(r.sold, 64_168_863)
  assert.equal(r.investorCount, 40)
  assert.equal(r.firstFiled, "2024-03-28")
  assert.equal(r.lastFiled, "2026-07-23")

  // 21.4% of a $300M target.
  assert.ok(r.progress != null)
  assert.equal(Math.round(r.progress * 1000) / 10, 21.4)

  // $1.60M average ticket.
  assert.ok(r.averageTicket != null)
  assert.equal(Math.round(r.averageTicket / 10_000) / 100, 1.6)

  // +$11.25M and +10 investors over the twelve months to July 2026.
  assert.equal(r.soldLastYear, 11_250_000)
  assert.equal(r.investorsLastYear, 10)

  // The target was cut from $500M to $300M.
  assert.equal(r.targetCut, true)
  assert.equal(r.targetHigh, 500_000_000)
})

test("filings are ordered oldest first regardless of input order", () => {
  const shuffled = [shcpFund4()[2], shcpFund4()[0], shcpFund4()[1]]
  const r = buildRaise(shuffled, "2026-10-21")
  assert.deepEqual(r?.filings.map((f) => f.filedAt), ["2024-03-28", "2025-07-22", "2026-07-23"])
})

test("progress is null against an indefinite target rather than a computed number", () => {
  const r = buildRaise(
    [{ ...shcpFund4()[2], offeringAmount: "indefinite" }],
    "2026-10-21"
  )
  assert.equal(r?.target, "indefinite")
  assert.equal(r?.progress, null)
  assert.equal(r?.sold, 64_168_863, "the amount sold is still reported")
  assert.equal(r?.targetCut, false, "an indefinite target was never cut")
})

test("a raise with one filing has no pace, and that is null not zero", () => {
  const r = buildRaise([shcpFund4()[0]], "2024-06-01")
  assert.equal(r?.soldLastYear, null)
  assert.equal(r?.investorsLastYear, null)
})

test("pace ignores a prior filing too recent to measure a year against", () => {
  const trail = [
    { ...shcpFund4()[1], filedAt: "2026-05-01", totalSold: 60_000_000, investorCount: 36 },
    shcpFund4()[2],
  ]
  const r = buildRaise(trail, "2026-10-21")
  assert.equal(r?.soldLastYear, null, "two filings three months apart cannot give a yearly pace")
})

test("staleness is counted in whole quarters since the last filing", () => {
  assert.equal(buildRaise(shcpFund4(), "2026-07-23")?.quartersSinceFiling, 0)
  assert.equal(buildRaise(shcpFund4(), "2026-10-21")?.quartersSinceFiling, 0)
  assert.equal(buildRaise(shcpFund4(), "2027-02-01")?.quartersSinceFiling, 2)
  assert.equal(buildRaise(shcpFund4(), "2027-08-01")?.quartersSinceFiling, 4)
})

test("a year of silence reads as closed, because the annual amendment is mandatory while open", () => {
  assert.equal(isLikelyOpen(buildRaise(shcpFund4(), "2026-10-21")!), true)
  assert.equal(isLikelyOpen(buildRaise(shcpFund4(), "2027-08-01")!), false)
})

test("a launch is dated from first sale, falling back to the first filing", () => {
  const r = buildRaise(shcpFund4(), "2026-10-21")!
  assert.equal(isNewLaunch(r, "2024-01-01"), true)
  assert.equal(isNewLaunch(r, "2025-01-01"), false, "first sale was March 2024")

  const noSale = buildRaise(shcpFund4().map((f) => ({ ...f, dateOfFirstSale: null })), "2026-10-21")!
  assert.equal(isNewLaunch(noSale, "2024-01-01"), true, "falls back to the 2024-03-28 first filing")
})

test("no filings yields no raise", () => {
  assert.equal(buildRaise([], "2026-10-21"), null)
  assert.equal(buildRaise([{ ...shcpFund4()[0], filedAt: "garbage" }], "2026-10-21"), null)
})

// ---------------------------------------------------------- structure and terms
//
// Each fixture is the real section XML from the filer named, compacted and with
// addresses dropped — so the parser is held to what issuers actually file.

const SHCP_FUND4_TERMS = `<edgarSubmission><primaryIssuer><cik>0002017189</cik><entityName>Safe Harbor Equity Distressed Debt Fund 4, L.P.</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Limited Partnership</entityType><yearOfInc><withinFiveYears>true</withinFiveYears><value>2022</value></yearOfInc></primaryIssuer><issuerList><issuer><cik>0002017088</cik><entityName>Safe Harbor Equity Distressed Debt Fund 4 Feeder, L.P.</entityName><jurisdictionOfInc>CAYMAN ISLANDS</jurisdictionOfInc><entityType>Limited Partnership</entityType><yearOfInc><withinFiveYears>true</withinFiveYears><value>2023</value></yearOfInc></issuer></issuerList><relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>Rafael</firstName><lastName>Serrano</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Director</relationship></relatedPersonRelationshipList><relationshipClarification>Manager of SHE DDF4 GP, LLC the General Partner of the Issuer</relationshipClarification></relatedPersonInfo></relatedPersonsList><offeringData><federalExemptionsExclusions><item>06b</item><item>3C</item><item>3C.1</item><item>3C.7</item></federalExemptionsExclusions><durationOfOffering><moreThanOneYear>true</moreThanOneYear></durationOfOffering><typesOfSecuritiesOffered><isEquityType>true</isEquityType><isPooledInvestmentFundType>true</isPooledInvestmentFundType><isOtherType>true</isOtherType><descriptionOfOtherType>Limited partnership interests. In sole discretion of General Partner to accept lesser minimum investment amounts.</descriptionOfOtherType></typesOfSecuritiesOffered><minimumInvestmentAccepted>100000</minimumInvestmentAccepted><salesCommissionsFindersFees><salesCommissions><dollarAmount>2000000</dollarAmount><isEstimate>true</isEstimate></salesCommissions><findersFees><dollarAmount>0</dollarAmount></findersFees><clarificationOfResponse>Courtney Group is no longer engaged by Issuers, and no commission or other remuneration was or will be paid to Courtney Group in connection with this offering.</clarificationOfResponse></salesCommissionsFindersFees><useOfProceeds><grossProceedsUsed><dollarAmount>0</dollarAmount></grossProceedsUsed></useOfProceeds></offeringData></edgarSubmission>`

const GELT_TERMS = `<edgarSubmission><primaryIssuer><cik>0001796479</cik><entityName>Gelt Financial, LLC</entityName><jurisdictionOfInc>DELAWARE</jurisdictionOfInc><entityType>Limited Liability Company</entityType><yearOfInc><overFiveYears>true</overFiveYears></yearOfInc></primaryIssuer><relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>H. Jack</firstName><lastName>Miller</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList><relationshipClarification></relationshipClarification></relatedPersonInfo></relatedPersonsList><offeringData><federalExemptionsExclusions><item>06c</item></federalExemptionsExclusions><durationOfOffering><moreThanOneYear>false</moreThanOneYear></durationOfOffering><typesOfSecuritiesOffered><isEquityType>true</isEquityType></typesOfSecuritiesOffered><minimumInvestmentAccepted>10000</minimumInvestmentAccepted><salesCommissionsFindersFees><salesCommissions><dollarAmount>0</dollarAmount></salesCommissions><findersFees><dollarAmount>0</dollarAmount></findersFees><clarificationOfResponse></clarificationOfResponse></salesCommissionsFindersFees><useOfProceeds><grossProceedsUsed><dollarAmount>0</dollarAmount></grossProceedsUsed><clarificationOfResponse></clarificationOfResponse></useOfProceeds></offeringData></edgarSubmission>`

/** BH3 writes "." and Bridge "[none]" in the first-name field of an entity; Silverview "--". */
const ENTITY_PLACEHOLDERS = `<edgarSubmission><relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>.</firstName><lastName>BH3 Debt Opportunity Fund II GP, LLC</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList><relationshipClarification>General Partner of the Issuer</relationshipClarification></relatedPersonInfo><relatedPersonInfo><relatedPersonName><firstName>[none]</firstName><lastName>Bridge Debt Strategies Fund VI GP LLC</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList></relatedPersonInfo><relatedPersonInfo><relatedPersonName><firstName>--</firstName><lastName>Silverview Credit Partners LP</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Promoter</relationship></relatedPersonRelationshipList></relatedPersonInfo><relatedPersonInfo><relatedPersonName><firstName>Daniel</firstName><lastName>Lebensohn</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList></relatedPersonInfo></relatedPersonsList></edgarSubmission>`

test("terms: Safe Harbor Fund 4, read from the primary issuer and not its co-issuer", () => {
  const t = parseTerms(SHCP_FUND4_TERMS)
  assert.equal(t.entityType, "Limited Partnership")
  assert.equal(t.yearOfInc, 2022, "the primary's year, not the feeder's 2023 that also appears in the filing")
  assert.equal(t.formedOverFiveYearsAgo, false)
  assert.deepEqual(t.coIssuers, [
    { cik: "2017088", name: "Safe Harbor Equity Distressed Debt Fund 4 Feeder, L.P.", jurisdiction: "CAYMAN ISLANDS", entityType: "Limited Partnership", yearOfInc: 2023 },
  ])
  assert.deepEqual(t.exemptions, ["06b", "3C", "3C.1", "3C.7"])
  assert.deepEqual(t.securities, ["equity", "pooled-fund", "other"])
  assert.match(t.securitiesOther ?? "", /sole discretion of General Partner to accept lesser minimum/)
  assert.equal(t.moreThanOneYear, true)
  assert.deepEqual(t.salesCommissions, { amount: 2_000_000, estimate: true })
  assert.deepEqual(t.findersFees, { amount: 0, estimate: false })
  assert.match(t.feesClarification ?? "", /Courtney Group is no longer engaged/)
  assert.deepEqual(t.proceedsToInsiders, { amount: 0, estimate: false })
  assert.equal(t.proceedsClarification, null, "an absent note is null, not an empty string")
})

test("terms: an issuer over five years old has no year, and says so", () => {
  const t = parseTerms(GELT_TERMS)
  assert.equal(t.yearOfInc, null)
  assert.equal(t.formedOverFiveYearsAgo, true)
  assert.equal(t.entityType, "Limited Liability Company")
  assert.deepEqual(t.exemptions, ["06c"], "Rule 506(c): may advertise")
  assert.equal(t.moreThanOneYear, false)
  assert.deepEqual(t.coIssuers, [])
  assert.equal(t.feesClarification, null)
})

test("terms: a filing with none of the sections yields empty values, not a throw", () => {
  const t = parseTerms("<edgarSubmission></edgarSubmission>")
  assert.deepEqual(t.coIssuers, [])
  assert.deepEqual(t.exemptions, [])
  assert.deepEqual(t.securities, [])
  assert.equal(t.entityType, null)
  assert.equal(t.moreThanOneYear, null)
  assert.deepEqual(t.salesCommissions, { amount: null, estimate: false }, "not reported is null, never zero")
})

test("related persons: placeholder first names mark an entity and are dropped from the name", () => {
  const r = parseFormD(ENTITY_PLACEHOLDERS, ctx)
  assert.deepEqual(
    r.relatedPersons.map((p) => [p.name, p.kind]),
    [
      ["BH3 Debt Opportunity Fund II GP, LLC", "entity"],
      ["Bridge Debt Strategies Fund VI GP LLC", "entity"],
      ["Silverview Credit Partners LP", "entity"],
      ["Daniel Lebensohn", "person"],
    ]
  )
  assert.equal(r.relatedPersons[0].clarification, "General Partner of the Issuer")
  assert.equal(r.relatedPersons[1].clarification, null)
})

test("related persons: a person keeps a multi-part first name and the filer's role note", () => {
  const gelt = parseFormD(GELT_TERMS, ctx).relatedPersons
  assert.deepEqual(gelt, [{ name: "H. Jack Miller", kind: "person", relationships: ["Executive Officer"], clarification: null }])
  const shcp = parseFormD(SHCP_FUND4_TERMS, ctx).relatedPersons[0]
  assert.equal(shcp.name, "Rafael Serrano")
  assert.deepEqual(shcp.relationships, ["Executive Officer", "Director"])
  assert.match(shcp.clarification ?? "", /General Partner of the Issuer/)
})

test("a raise carries the newest terms, dates each co-issuer, and records exemption changes", () => {
  const solo = SHCP_FUND4_TERMS.replace(/<issuerList>[\s\S]*?<\/issuerList>/, "").replace("<item>3C.7</item>", "")
  const trail = [
    parseFormD(solo, { cik: "2017189", accession: "a1", formType: "D", filedAt: "2024-03-28" }),
    parseFormD(SHCP_FUND4_TERMS, { cik: "2017189", accession: "a2", formType: "D/A", filedAt: "2025-07-22" }),
    parseFormD(SHCP_FUND4_TERMS, { cik: "2017189", accession: "a3", formType: "D/A", filedAt: "2026-07-23" }),
  ]
  const r = buildRaise(trail, "2026-10-21")!
  assert.equal(r.terms?.coIssuers[0].firstSeen, "2025-07-22", "the feeder first appears on the second filing")
  assert.deepEqual(r.exemptionChanges, [{ filedAt: "2025-07-22", added: ["3C.7"], removed: [] }], "3(c)(7) added with the feeder")
  assert.deepEqual(r.terms?.salesCommissions, { amount: 2_000_000, estimate: true })
  for (const f of r.filings) assert.equal(f.terms, null, "stored filings carry no terms — they would multiply in the cache")
})

test("adding or dropping only the 3(c) umbrella code is not an exemption change", () => {
  // H.I.G. Bayside: an amendment added "3C" beside an unchanged 3(c)(7).
  const without = SHCP_FUND4_TERMS.replace("<item>3C</item>", "")
  const trail = [
    parseFormD(without, { cik: "2017189", accession: "b1", formType: "D", filedAt: "2024-03-20" }),
    parseFormD(SHCP_FUND4_TERMS, { cik: "2017189", accession: "b2", formType: "D/A", filedAt: "2024-09-09" }),
  ]
  assert.deepEqual(buildRaise(trail, "2026-10-21")!.exemptionChanges, [])
})

test("a raise built from filings without terms has none, and no changes", () => {
  const r = buildRaise(shcpFund4(), "2026-10-21")!
  assert.equal(r.terms, null)
  assert.deepEqual(r.exemptionChanges, [])
})
