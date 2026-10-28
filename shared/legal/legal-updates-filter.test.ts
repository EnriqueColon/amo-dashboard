import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MAX_ITEM_AGE_DAYS,
  dedupeByTitle,
  dropStaleItems,
  isStale,
  normalizeTitleForKey,
  parseItemDateToMs,
} from "./legal-updates-filter.ts"

const NOW = Date.UTC(2026, 8, 29) // the day the duplicate was reported
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString().slice(0, 10)

const HVCRE = "Final Rule on Treatment of High Volatility Commercial Real Estate (HVCRE) Exposures"

/** The five cards a user was served on the Legal Landscape tab: one rule, once per issuer. */
const REPORTED_REGULATORY_PAYLOAD = [
  { title: HVCRE, source: "Federal Reserve, FDIC, OCC", url: "https://federalreserve.gov/hvcre" },
  { title: HVCRE, source: "FDIC", url: "https://fdic.gov/hvcre" },
  { title: HVCRE, source: "OCC", url: "https://occ.gov/hvcre" },
  { title: HVCRE, source: "Federal Reserve", url: "https://federalreserve.gov/hvcre" },
  { title: HVCRE, source: "FDIC, OCC", url: "https://fdic.gov/hvcre-2" },
]

test("collapses a joint rule restated once per issuing agency", () => {
  const out = dedupeByTitle(REPORTED_REGULATORY_PAYLOAD)
  assert.equal(out.length, 1)
  assert.equal(out[0].source, "Federal Reserve, FDIC, OCC", "keeps the first, richest attribution")
})

test("differing URLs do not keep duplicates alive", () => {
  const urls = new Set(REPORTED_REGULATORY_PAYLOAD.map((i) => i.url))
  assert.equal(urls.size, 4, "guards the premise: URL-keyed dedupe would have kept four")
  assert.equal(dedupeByTitle(REPORTED_REGULATORY_PAYLOAD).length, 1)
})

test("matches across casing, punctuation, entity and whitespace drift", () => {
  const out = dedupeByTitle([
    { title: HVCRE },
    { title: "Final Rule on Treatment of High Volatility Commercial Real Estate HVCRE Exposures" },
    { title: "  final rule on treatment of high volatility   commercial real estate (hvcre) exposures " },
    { title: "Final Rule on Treatment of High Volatility Commercial Real Estate &amp; (HVCRE) Exposures" },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].title, HVCRE, "the verbatim official title is the one kept")
})

test("decodes entities rather than letting them become words", () => {
  assert.equal(normalizeTitleForKey("Truth &amp; Lending"), normalizeTitleForKey("Truth & Lending"))
  assert.notEqual(normalizeTitleForKey("Truth &amp; Lending"), "truth amp lending")
})

test("keeps genuinely distinct developments", () => {
  const out = dedupeByTitle([
    { title: HVCRE },
    { title: "Interagency Guidance on Commercial Real Estate Loan Accommodations" },
    { title: "SB 1234 — Foreclosure Procedure Reform" },
  ])
  assert.equal(out.length, 3)
})

test("drops items whose title normalizes to nothing", () => {
  assert.deepEqual(dedupeByTitle([{ title: "" }, { title: "   " }, { title: "***" }]), [])
})

test("collapses one development surfacing in two sections", () => {
  const out = dedupeByTitle([
    { title: "Bank X Consent Order", section: "regulatory" },
    { title: "Bank X Consent Order", section: "enforcement" },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].section, "regulatory", "section order decides the winner")
})

test("normalizeTitleForKey is stable under repeated application", () => {
  const once = normalizeTitleForKey(HVCRE)
  assert.equal(normalizeTitleForKey(once), once)
})

test("drops the 2019 rule the 90-day prompt should never have returned", () => {
  const { kept, dropped } = dropStaleItems([{ date: "2019-11-19" }], NOW)
  assert.equal(kept.length, 0)
  assert.equal(dropped.length, 1)
})

test("keeps developments inside the window and drops those beyond it", () => {
  const { kept, dropped } = dropStaleItems(
    [{ date: daysAgo(1) }, { date: daysAgo(89) }, { date: daysAgo(179) }, { date: daysAgo(400) }],
    NOW
  )
  assert.equal(kept.length, 3, "the window is deliberately wider than the prompt's 90 days")
  assert.equal(dropped.length, 1)
})

test("a future date is what is coming, not a defect", () => {
  // The news feeds reject these; an effective date or scheduled vote is the point of this tab.
  const { kept } = dropStaleItems([{ date: daysAgo(-120) }], NOW)
  assert.equal(kept.length, 1)
})

test("an item with no usable date survives rather than being silently withheld", () => {
  const { kept } = dropStaleItems([{ date: undefined }, { date: "" }, { date: "sometime in 2019" }], NOW)
  assert.equal(kept.length, 3)
})

test("the boundary is the configured age, exactly", () => {
  const onTheDay = NOW - MAX_ITEM_AGE_DAYS * 86400000
  assert.equal(isStale(new Date(onTheDay).toISOString().slice(0, 10), NOW), false)
  assert.equal(isStale(new Date(onTheDay - 86400000).toISOString().slice(0, 10), NOW), true)
})

test("parses the YYYY-MM-DD the prompt asks for, without timezone drift", () => {
  assert.equal(parseItemDateToMs("2019-11-19"), Date.UTC(2019, 10, 19))
  assert.equal(parseItemDateToMs("2019-11-19"), Date.parse("2019-11-19T00:00:00Z"))
})

test("accepts other formats only when they name a specific day", () => {
  for (const s of ["November 19, 2019", "19 Nov 2019", "11/19/2019", "Nov. 19, 2019"]) {
    assert.equal(parseItemDateToMs(s), Date.parse("November 19, 2019"), s)
  }
})

test("refuses prose that Date.parse would silently pin to January 1", () => {
  // "Fall 2026" parses to 2026-01-01, nine months early — early enough to withhold a live item.
  for (const s of ["Fall 2026", "sometime in 2019", "2019", "Q1 2026", "not a date", "", undefined]) {
    assert.equal(parseItemDateToMs(s), null, String(s))
  }
})

test("dedupe runs before the staleness filter without either undoing the other", () => {
  const items = [
    { title: HVCRE, date: "2019-11-19" },
    { title: HVCRE, date: "2019-11-19" },
    { title: "Interagency Guidance on CRE Loan Accommodations", date: daysAgo(10) },
  ]
  const { kept } = dropStaleItems(dedupeByTitle(items), NOW)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].title, "Interagency Guidance on CRE Loan Accommodations")
})
