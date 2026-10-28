/** The morning page's helpers. Run: npm run test:news-morning */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  byTopic,
  cleanHeadline,
  daysBeforeET,
  isSinceYesterday,
  longDateET,
  mergeLevels,
  newestFirst,
  topicChips,
  usefulSnippet,
  withoutUrls,
  type MorningItem,
} from "./morning"

const item = (over: Partial<MorningItem> & { id: string }): MorningItem => ({
  title: `Story ${over.id}`,
  region: "national",
  topic: "Commercial Real Estate",
  ...over,
})

test("mergeLevels keeps the first occurrence of a URL and remembers the feed level", () => {
  const merged = mergeLevels([
    { level: "national", items: [item({ id: "a", url: "https://x.com/one/" })] },
    { level: "florida", items: [item({ id: "b", url: "https://www.x.com/one" }), item({ id: "c", url: "https://x.com/two" })] },
  ])
  assert.deepEqual(
    merged.map((m) => [m.id, m.feedLevel]),
    [
      ["a", "national"],
      ["c", "florida"],
    ]
  )
})

test("mergeLevels falls back to source and title when there is no URL", () => {
  const merged = mergeLevels([
    { level: "national", items: [item({ id: "a", source: "GlobeSt", title: "Same" })] },
    { level: "miami", items: [item({ id: "b", source: "GlobeSt", title: "same" }), item({ id: "c", source: "Bisnow", title: "Same" })] },
  ])
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "c"]
  )
})

test("withoutUrls drops items the subscriber cards already show", () => {
  const list = [item({ id: "a", url: "https://therealdeal.com/miami/2026/10/27/x/" }), item({ id: "b", url: "https://y.com/z" })]
  const kept = withoutUrls(list, ["https://www.therealdeal.com/miami/2026/10/27/x", undefined])
  assert.deepEqual(
    kept.map((k) => k.id),
    ["b"]
  )
})

test("newestFirst: by date descending, undated last, readable before paywalled within a day", () => {
  const sorted = newestFirst([
    item({ id: "old", date: "2026-10-20", access_status: "open" }),
    item({ id: "undated" }),
    item({ id: "new-paywalled", date: "2026-10-27", access_status: "paywalled" }),
    item({ id: "new-open", date: "2026-10-27", access_status: "open" }),
  ])
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["new-open", "new-paywalled", "old", "undated"]
  )
})

test("daysBeforeET crosses month and year boundaries by the calendar", () => {
  assert.equal(daysBeforeET("2026-10-28", 1), "2026-10-27")
  assert.equal(daysBeforeET("2026-11-01", 1), "2026-10-31")
  assert.equal(daysBeforeET("2027-01-01", 1), "2026-12-31")
  assert.equal(daysBeforeET("2026-03-01", 1), "2026-02-28")
})

test("isSinceYesterday: today and yesterday only, never undated or future", () => {
  assert.equal(isSinceYesterday("2026-10-28", "2026-10-28"), true)
  assert.equal(isSinceYesterday("2026-10-27", "2026-10-28"), true)
  assert.equal(isSinceYesterday("2026-10-26", "2026-10-28"), false)
  assert.equal(isSinceYesterday("2026-10-29", "2026-10-28"), false)
  assert.equal(isSinceYesterday(undefined, "2026-10-28"), false)
  assert.equal(isSinceYesterday("Oct 27", "2026-10-28"), false)
})

test("topicChips counts across sections, All first, then alphabetical; byTopic filters", () => {
  const items = [item({ id: "a", topic: "Debt/Financing" }), item({ id: "b" }), item({ id: "c", topic: "Debt/Financing" }), item({ id: "d", topic: "" })]
  assert.deepEqual(topicChips(items), [
    { topic: "All", count: 4 },
    { topic: "Commercial Real Estate", count: 1 },
    { topic: "Debt/Financing", count: 2 },
  ])
  assert.equal(byTopic(items, "All").length, 4)
  assert.deepEqual(
    byTopic(items, "Debt/Financing").map((i) => i.id),
    ["a", "c"]
  )
})

test("cleanHeadline drops a trailing outlet that matches the source and keeps other dashes", () => {
  assert.equal(cleanHeadline("Corporate bond market liquidity expands across US and Europe - Livemint", "Livemint"), "Corporate bond market liquidity expands across US and Europe")
  assert.equal(cleanHeadline("Soffer could rebuild Broward casino - The Business Journals", "The Business Journals"), "Soffer could rebuild Broward casino")
  assert.equal(cleanHeadline("Office loan sale - a first for the lender", "GlobeSt"), "Office loan sale - a first for the lender")
  assert.equal(cleanHeadline("Plain headline", undefined), "Plain headline")
})

test("usefulSnippet hides a description that only repeats the headline", () => {
  const title = "Corporate bond market liquidity expands across US and Europe - Livemint"
  assert.equal(usefulSnippet(title, "Corporate bond market liquidity expands across US and Europe Livemint", "Livemint"), undefined)
  assert.equal(usefulSnippet(title, "Corporate bond market liquidity expands across US and Europe - Livemint", "Livemint"), undefined)
  assert.equal(usefulSnippet(title, "Corporate bond market liquidity expands across US and Europe", "Livemint"), undefined)
  assert.equal(usefulSnippet(title, "   ", "Livemint"), undefined)
  assert.equal(
    usefulSnippet(title, "Dealers report tighter spreads and deeper order books in both markets.", "Livemint"),
    "Dealers report tighter spreads and deeper order books in both markets."
  )
})

test("longDateET formats the Eastern calendar day without shifting it", () => {
  assert.equal(longDateET("2026-10-28"), "Wednesday, October 28, 2026")
  assert.equal(longDateET("2026-01-01"), "Thursday, January 1, 2026")
})
