import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildCompanyConceptUrl,
  buildFilingIndexUrl,
  buildFtsUrl,
  buildPrimaryDocUrl,
  buildSubmissionsUrl,
  edgarHeaders,
  isExcludedName,
  layerForLocation,
  padCik,
  retryDelayMs,
  shouldRetry,
  unpadCik,
} from "./edgar-contract"

test("full-text search uses q, never keys", () => {
  const url = buildFtsUrl({ q: '"real estate credit"', forms: ["D"] })
  assert.match(url, /[?&]q=/)
  assert.ok(!url.includes("keys="), "keys= is silently ignored by EDGAR and returns the whole firehose")
  assert.match(url, /forms=D/)
})

test("location filter is plural locationCodes", () => {
  const url = buildFtsUrl({ q: '"mortgage fund"', forms: ["D"], locationCodes: "FL" })
  assert.match(url, /locationCodes=FL/)
  assert.ok(!/[?&]locationCode=/.test(url), "singular locationCode is ignored")
})

test("a date range is only sent when both bounds are given", () => {
  assert.ok(!buildFtsUrl({ q: "x", startdt: "2026-01-01" }).includes("startdt"))
  const both = buildFtsUrl({ q: "x", startdt: "2026-01-01", enddt: "2026-10-21" })
  assert.match(both, /startdt=2026-01-01/)
  assert.match(both, /enddt=2026-10-21/)
})

test("CIK padding matches each host's convention", () => {
  assert.equal(padCik("2017189"), "0002017189")
  assert.equal(padCik(2017189), "0002017189")
  assert.equal(padCik("0002017189"), "0002017189")
  assert.equal(unpadCik("0002017189"), "2017189")
  assert.throws(() => padCik("0"))
  assert.throws(() => padCik("abc"))
})

test("structured URLs are built for the right host", () => {
  assert.equal(buildSubmissionsUrl("2017189"), "https://data.sec.gov/submissions/CIK0002017189.json")
  assert.equal(
    buildCompanyConceptUrl("1812554", "us-gaap", "PaymentsForRepurchaseOfCommonStock"),
    "https://data.sec.gov/api/xbrl/companyconcept/CIK0001812554/us-gaap/PaymentsForRepurchaseOfCommonStock.json"
  )
})

test("archive URLs strip dashes from the accession but keep them in the index filename", () => {
  assert.equal(
    buildPrimaryDocUrl("2017189", "0002017189-26-000007"),
    "https://www.sec.gov/Archives/edgar/data/2017189/000201718926000007/primary_doc.xml"
  )
  assert.equal(
    buildFilingIndexUrl("2017189", "0002017189-26-000007"),
    "https://www.sec.gov/Archives/edgar/data/2017189/000201718926000007/0002017189-26-000007-index.html"
  )
  assert.throws(() => buildPrimaryDocUrl("2017189", "not-an-accession"))
})

test("a User-Agent without a contact address is refused before the request", () => {
  assert.match(edgarHeaders("someone@example.com")["User-Agent"], /someone@example\.com/)
  assert.throws(() => edgarHeaders("   "))
})

test("only transient statuses are retried, and never past the cap", () => {
  assert.equal(shouldRetry(500, 1), true)
  assert.equal(shouldRetry(503, 1), true)
  assert.equal(shouldRetry(429, 1), true)
  assert.equal(shouldRetry(400, 1), false)
  assert.equal(shouldRetry(404, 1), false)
  assert.equal(shouldRetry(403, 1), false, "403 is a bad User-Agent; retrying cannot fix it")
  assert.equal(shouldRetry(500, 3), false)
})

test("retry backoff never undercuts the rate-limit spacing", () => {
  assert.ok(retryDelayMs(1) >= 200)
  assert.ok(retryDelayMs(2) > retryDelayMs(1))
})

test("Miami-Dade cities land in the local layer, the rest of Florida in the state layer", () => {
  assert.equal(layerForLocation("Miami Beach, FL"), "miami-dade")
  assert.equal(layerForLocation("Coral Gables, FL"), "miami-dade")
  assert.equal(layerForLocation("Coconut Grove, FL"), "miami-dade")
  assert.equal(layerForLocation("Aventura, FL"), "miami-dade")
  assert.equal(layerForLocation("Doral, FL"), "miami-dade")
  assert.equal(layerForLocation("Fort Lauderdale, FL"), "florida", "Broward is the state layer, not Miami-Dade")
  assert.equal(layerForLocation("Boca Raton, FL"), "florida")
  assert.equal(layerForLocation("Tampa, FL"), "florida")
  assert.equal(layerForLocation("New York, NY"), "national")
  assert.equal(layerForLocation(""), "national")
  assert.equal(layerForLocation(null), "national")
})

test("city matching is case- and spacing-tolerant", () => {
  assert.equal(layerForLocation("MIAMI BEACH, FL"), "miami-dade")
  assert.equal(layerForLocation("  miami beach ,  fl  "), "miami-dade")
})

test("name exclusions drop the categories that collide with fund-name search", () => {
  assert.equal(isExcludedName("Smith Qualified Opportunity Zone Fund LP"), true)
  assert.equal(isExcludedName("CIFC CLO Opportunity Fund VI LP"), true)
  assert.equal(isExcludedName("Digital Assets Opportunity Fund LP"), true)
  assert.equal(isExcludedName("Veridis Legal Opportunity Fund, LP"), true)
  assert.equal(isExcludedName("Thompson Creek Performing Arts Opportunity Fund"), true)
  assert.equal(isExcludedName("Capital Circle Ventures Opportunity Fund I"), true)
  assert.equal(isExcludedName("Safe Harbor Equity Distressed Debt Fund 4, L.P."), false)
  assert.equal(isExcludedName("BH3 Debt Opportunity Fund III L.P."), false)
  assert.equal(isExcludedName("Bayview Commercial Real Estate Credit Fund Domestic, L.P."), false)
  assert.equal(isExcludedName("Naso CRE Bridge Loan Fund, L.P"), false)
})
