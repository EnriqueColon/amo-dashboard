import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { coverDate, parseAdvFiling, tickedOptions, yesNo, type AdvLine } from "./adv"

/**
 * Real lines, as `adv-pdf.mts` read them from Safe Harbor's Form ADV on
 * 2026-10-26: the cover, the 7.B.(1) header, and four of its seven fund
 * records — Funds 2, 3 and 4 and Fund 4's Cayman feeder. The answers asserted
 * below were checked against the PDF by eye and against the firm's Form D.
 */
const FIXTURE = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "adv-305314.json"), "utf8")) as { lines: AdvLine[] }

const line = (text: string, marks: Array<[number, boolean]> = []): AdvLine => ({
  page: 1,
  y: 0,
  text,
  marks: marks.map(([x, ticked]) => ({ x, width: 13, height: 16, ink: ticked ? 0.83 : 0.79, ticked })),
})

test("a yes/no line is read by the order of its boxes, never their exact position", () => {
  assert.equal(yesNo(line("q?", [[708, true], [731, false]])), true)
  assert.equal(yesNo(line("q?", [[697, false], [722, true]])), false, "the boxes sit further left on some lines")
  assert.equal(yesNo(line("q?", [[688, false], [708, true]])), false)
  assert.equal(yesNo(line("q?", [[708, false], [731, false]])), null, "unanswered is null, not a guess")
  assert.equal(yesNo(line("q?", [[708, true], [731, true]])), null, "both ticked is not an answer either")
  assert.equal(yesNo(line("q?", [[708, true]])), null, "one box is not a yes/no question")
  assert.equal(yesNo(undefined), null)
})

test("an option list is read by position in the printed order", () => {
  const types = ["hedge", "liquidity", "pe", "real estate", "securitized", "vc", "other"]
  const l = line("hedge fund liquidity fund …", [[43, false], [116, false], [194, false], [302, true], [397, false], [520, false], [633, false]])
  assert.deepEqual(tickedOptions(l, types), ["real estate"])
  assert.deepEqual(tickedOptions(line("x", [[43, true]]), types), [], "fewer boxes than options is not read")
  assert.equal(coverDate("5/4/2026 11:19:59 AM"), "2026-05-04")
  assert.equal(coverDate("not a date"), null)
})

test("the cover gives the adviser, the filing type and the date; the header gives the fund count", () => {
  const f = parseAdvFiling("305314", FIXTURE.lines)
  assert.equal(f.adviserName, "SAFE HARBOR CAPITAL PARTNERS")
  assert.equal(f.filingType, "Other-Than-Annual Amendment - All Sections")
  assert.equal(f.filedOn, "2026-05-04")
  assert.equal(f.fundsReported, 7)
  assert.equal(f.funds.length, 4, "the fixture carries four of the seven records")
  assert.ok(f.notes.includes("header says 7 funds, parsed 4"), `notes: ${f.notes.join(" | ")}`)
  assert.equal(f.notes.filter((n) => /gross asset value not read/.test(n)).length, 0, "every record's GAV is read")
})

test("Fund 4: every field of a full record, as filed", () => {
  const f = parseAdvFiling("305314", FIXTURE.lines)
  const fund = f.funds.find((x) => x.name === "SAFE HARBOR EQUITY DISTRESSED DEBT FUND 4, L.P.")!
  assert.ok(fund, "Fund 4 is in the fixture")
  assert.equal(fund.fundId, "805-3969958162")
  assert.equal(fund.state, "Delaware")
  assert.equal(fund.country, "United States")
  assert.deepEqual(fund.generalPartners, ["SHE DDF4 GP, LLC"])
  assert.deepEqual(fund.umbrellaAdvisers, [])
  assert.equal(fund.exclusion3c1, true, "3(c)(1) ticked")
  assert.equal(fund.exclusion3c7, false, "3(c)(7) not ticked — the Form D claims it, the ADV does not")
  assert.equal(fund.isMasterFund, true)
  assert.deepEqual(fund.feeders, [{ name: "SAFE HARBOR EQUITY DISTRESSED DEBT FUND 4 FEEDER, L.P.", fundId: "805-9876746577" }])
  assert.equal(fund.isFeederFund, false)
  assert.equal(fund.master, null)
  assert.equal(fund.fundOfFunds, false)
  assert.deepEqual(fund.fundTypes, ["real estate fund"])
  assert.equal(fund.grossAssetValue, 186_673_253)
  assert.equal(fund.minimumInvestment, 1_000_000)
  assert.equal(fund.beneficialOwners, 30)
  assert.equal(fund.pctOwnedByRelated, 3)
  assert.equal(fund.pctOwnedByFundsOfFunds, 2)
  assert.equal(fund.salesLimitedToQualifiedClients, true)
  assert.equal(fund.pctOwnedByNonUs, 11)
  assert.equal(fund.isSubadviser, false)
  assert.equal(fund.otherAdvisersAdvise, false)
  assert.equal(fund.clientsSolicited, false)
  assert.equal(fund.pctClientsInvested, 0)
  assert.equal(fund.reliedOnRegulationD, true)
  assert.equal(fund.formDFileNumber, "021-509018")
  assert.equal(fund.annualAudit, true)
  assert.equal(fund.gaap, true)
  assert.deepEqual(fund.auditors, [
    { name: "DELOITTE & TOUCHE LLP", city: "MIAMI", state: "Florida", country: "United States", independent: true, pcaobRegistered: true, pcaobNumber: "34", pcaobInspected: true },
  ])
  assert.equal(fund.statementsDistributed, false, "the (g) line's No box is the ticked one")
  assert.equal(fund.opinion, "unqualified")
  assert.equal(fund.usesPrimeBroker, false)
  assert.deepEqual(fund.primeBrokers, [])
  assert.equal(fund.usesCustodian, true)
  assert.deepEqual(
    fund.custodians.map((c) => [c.name, c.city, c.state, c.relatedPerson]),
    [["CITY NATIONAL BANK", "LOS ANGELES", "California", false], ["COLUMN NATIONAL ASSOCIATION", "SAN FRANCISCO", "California", false]]
  )
})

test("the feeder names its master; Funds 2 and 3 carry their own figures", () => {
  const f = parseAdvFiling("305314", FIXTURE.lines)
  const feeder = f.funds.find((x) => /FUND 4 FEEDER/.test(x.name))!
  assert.equal(feeder.isFeederFund, true)
  assert.equal(feeder.master?.name, "SAFE HARBOR EQUITY DISTRESSED DEBT FUND 4, L.P.")
  assert.equal(feeder.master?.fundId, "805-3969958162")
  assert.equal(feeder.country, "Cayman Islands")
  const fund3 = f.funds.find((x) => /FUND 3, L\.P\./.test(x.name))!
  assert.equal(fund3.grossAssetValue, 84_147_927)
  assert.equal(fund3.beneficialOwners, 46)
  const fund2 = f.funds.find((x) => /FUND 2, L\.P\./.test(x.name))!
  assert.equal(fund2.grossAssetValue, 1_542_678)
  assert.equal(fund2.beneficialOwners, 20)
})

test("a filing whose 7.B.(1) says 'No Information Filed' yields no funds and says so", () => {
  const lines: AdvLine[] = [
    line("FORM ADV"),
    line("Primary Business Name: MADISON REALTY CAPITAL CRD Number: 158988"),
    line("Annual Amendment - All Sections Rev. 10/2021"),
    line("3/31/2026 5:23:15 PM"),
    line("SECTION 7.B.(1) Private Fund Reporting"),
    line("No Information Filed"),
    line("SECTION 7.B.(2) Private Fund Reporting"),
    line("No Information Filed"),
  ]
  const f = parseAdvFiling("158988", lines)
  assert.equal(f.adviserName, "MADISON REALTY CAPITAL")
  assert.equal(f.filingType, "Annual Amendment - All Sections")
  assert.equal(f.filedOn, "2026-03-31")
  assert.equal(f.fundsReported, null)
  assert.deepEqual(f.funds, [])
  assert.ok(f.notes.includes("7.B.(1) reports no private funds"))
  const wrongCrd = parseAdvFiling("1", lines)
  assert.ok(wrongCrd.notes.some((n) => /cover says CRD 158988, expected 1/.test(n)))
})
