import assert from "node:assert/strict"
import { test } from "node:test"

import {
  dedupeBills,
  describeFromRecord,
  normalizeBillTitle,
  selectRelevantBills,
  toSourcedBill,
  type SourcedBill,
} from "./legal-updates-legislation.ts"
import { bearsOnFirmOperations } from "./legal-updates-relevance.ts"

/** The predicate the action passes in, so these tests exercise the real policy. */
const isRelevant = (title: string) => bearsOnFirmOperations({ title })

const bill = (over: Partial<SourcedBill> = {}): SourcedBill => ({
  displayNumber: "H.R. 7730",
  title: "Bankruptcy Threshold Adjustment Act",
  statusLabel: "Passed House & Senate (President next)",
  statusDate: "2026-09-28",
  url: "https://www.govtrack.us/congress/bills/119/hr7730",
  ...over,
})

test("a record entry becomes a sourced bill", () => {
  // Shape taken from a live govtrack response for H.R. 7730.
  assert.deepEqual(
    toSourcedBill({
      display_number: "H.R. 7730",
      title: "H.R. 7730: Bankruptcy Threshold Adjustment Act",
      title_without_number: "Bankruptcy Threshold Adjustment Act",
      current_status_label: "Passed House & Senate (President next)",
      current_status_date: "2026-09-28",
      link: "https://www.govtrack.us/congress/bills/119/hr7730",
      sponsor: { name: "Rep. Ben Cline [R-VA6]" },
    }),
    { ...bill(), sponsor: "Rep. Ben Cline [R-VA6]" }
  )
})

test("an entry missing anything that identifies the bill is discarded", () => {
  // Rather than defaulted. A bill with no number is not a bill we can show or verify.
  assert.equal(toSourcedBill({ title_without_number: "Some Act", current_status_date: "2026-01-01", link: "https://x" }), null)
  assert.equal(toSourcedBill({ display_number: "S. 1", current_status_date: "2026-01-01", link: "https://x" }), null)
  assert.equal(toSourcedBill({ display_number: "S. 1", title_without_number: "Act", link: "https://x" }), null)
  assert.equal(toSourcedBill({ display_number: "S. 1", title_without_number: "Act", current_status_date: "2026-01-01" }), null)
})

test("the number is preferred over the number-bearing title", () => {
  const sourced = toSourcedBill({
    display_number: "S. 5477",
    title: "S. 5477: Federal Receivership Fairness Act",
    title_without_number: "Federal Receivership Fairness Act",
    current_status_date: "2026-09-23",
    link: "https://www.govtrack.us/congress/bills/119/s5477",
  })
  // Otherwise the rendered title reads "S. 5477 – S. 5477: Federal Receivership Fairness Act".
  assert.equal(sourced?.title, "Federal Receivership Fairness Act")
})

test("a bill surfacing under several searches appears once, at its latest action", () => {
  const deduped = dedupeBills([
    bill({ statusDate: "2026-03-01", statusLabel: "Introduced" }),
    bill({ statusDate: "2026-09-28" }),
    bill({ displayNumber: "S. 5477", title: "Federal Receivership Fairness Act" }),
  ])
  assert.equal(deduped.length, 2)
  const hr = deduped.find((b) => b.displayNumber === "H.R. 7730")
  assert.equal(hr?.statusDate, "2026-09-28", "the later action wins")
})

test("companion bills in the two chambers collapse to the one that moved", () => {
  // Observed live: the same Act arrived as H.R. 7730 and S. 3977, and as both "…Act" and
  // "…Act of 2026". Three rows for one piece of legislation.
  const deduped = dedupeBills([
    bill({ displayNumber: "H.R. 7730", title: "Bankruptcy Threshold Adjustment Act", statusDate: "2026-09-28" }),
    bill({ displayNumber: "S. 3977", title: "Bankruptcy Threshold Adjustment Act of 2026", statusDate: "2026-08-03" }),
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].displayNumber, "H.R. 7730", "the later action is the live one")
})

test("different legislation is not collapsed by the title normaliser", () => {
  const deduped = dedupeBills([
    bill({ displayNumber: "S. 5477", title: "Federal Receivership Fairness Act" }),
    bill({ displayNumber: "H.R. 9670", title: "Medical Bankruptcy Fairness Act" }),
  ])
  assert.equal(deduped.length, 2)
})

test("the title normaliser ignores session years and punctuation", () => {
  assert.equal(
    normalizeBillTitle("Bankruptcy Threshold Adjustment Act of 2026"),
    normalizeBillTitle("Bankruptcy Threshold Adjustment Act")
  )
  assert.notEqual(normalizeBillTitle("Foreclosure Fairness Act"), normalizeBillTitle("Foreclosure Reform Act"))
})

test("relevance is judged on the authoritative title, newest first", () => {
  const selected = selectRelevantBills([
    bill({ displayNumber: "H.R. 1", title: "Transforming Education for the Future Act", statusDate: "2026-09-30" }),
    bill({ displayNumber: "S. 5477", title: "Federal Receivership Fairness Act", statusDate: "2026-09-23" }),
    bill({ displayNumber: "H.R. 7730", title: "Bankruptcy Threshold Adjustment Act", statusDate: "2026-09-28" }),
  ], isRelevant)
  assert.deepEqual(
    selected.map((b) => b.displayNumber),
    ["H.R. 7730", "S. 5477"],
    "the education bill is real but not this firm's business"
  )
})

test("the limit is respected", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    bill({ displayNumber: `S. ${i + 1}`, title: "Foreclosure Fairness Act", statusDate: `2026-09-0${i + 1}` })
  )
  assert.equal(selectRelevantBills(many, isRelevant, 5).length, 5)
})

test("the record alone produces a quotable description", () => {
  // The fallback when summarisation fails. Every clause here comes from the record.
  const text = describeFromRecord(bill({ sponsor: "Rep. Ben Cline [R-VA6]" }))
  assert.match(text, /H\.R\. 7730/)
  assert.match(text, /Bankruptcy Threshold Adjustment Act/)
  assert.match(text, /2026-09-28/)
  assert.match(text, /Rep\. Ben Cline/)
})

test("a missing sponsor does not leave a dangling sentence", () => {
  assert.equal(describeFromRecord(bill()).includes("Sponsored by"), false)
  assert.match(describeFromRecord(bill()), /Passed House & Senate \(President next\)\.$/)
})
