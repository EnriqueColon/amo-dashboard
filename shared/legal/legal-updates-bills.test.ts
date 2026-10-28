import assert from "node:assert/strict"
import { test } from "node:test"

import {
  billKey,
  billKeyFor,
  congressForYear,
  parseBillReference,
  parseCongressGovUrl,
  significantWords,
  titlesAgree,
  type BillReference,
} from "./legal-updates-bills.ts"

test("reads the federal bill forms, longest first", () => {
  const cases: [string, BillReference][] = [
    ["S. 1234 — U.S. Senate", { jurisdiction: "federal", billType: "senate_bill", number: 1234 }],
    ["H.R. 5678", { jurisdiction: "federal", billType: "house_bill", number: 5678 }],
    ["HR 5678", { jurisdiction: "federal", billType: "house_bill", number: 5678 }],
    ["S.J.Res. 5", { jurisdiction: "federal", billType: "senate_joint_resolution", number: 5 }],
    ["H.J.Res. 7", { jurisdiction: "federal", billType: "house_joint_resolution", number: 7 }],
    ["S.Res. 12", { jurisdiction: "federal", billType: "senate_resolution", number: 12 }],
    ["H.Con.Res. 3", { jurisdiction: "federal", billType: "house_concurrent_resolution", number: 3 }],
  ]
  for (const [text, expected] of cases) {
    assert.deepEqual(parseBillReference(text), expected, text)
  }
})

test("a joint resolution is not read as a plain bill with stray text", () => {
  // The risk of ordering the patterns wrongly: "S.J.Res. 5" contains an "S." and a number.
  assert.deepEqual(parseBillReference("S.J.Res. 5"), {
    jurisdiction: "federal",
    billType: "senate_joint_resolution",
    number: 5,
  })
})

test("Florida numbering does not collide with federal numbering", () => {
  // "SB 106" and "S. 106" are different bills in different legislatures. The period is what tells
  // them apart, so this is the case that keeps the two pattern sets from overlapping.
  assert.deepEqual(parseBillReference("SB 106"), {
    jurisdiction: "florida",
    chamber: "senate",
    number: 106,
  })
  assert.deepEqual(parseBillReference("S. 106"), {
    jurisdiction: "federal",
    billType: "senate_bill",
    number: 106,
  })
})

test("committee substitutes keep the bill's number", () => {
  assert.deepEqual(parseBillReference("CS/CS/HB 1205"), {
    jurisdiction: "florida",
    chamber: "house",
    number: 1205,
  })
})

test("an item with no bill number anywhere parses to nothing", () => {
  assert.equal(parseBillReference("Florida Legislature Adjourns Regular Session"), null)
  assert.equal(parseBillReference(undefined), null)
})

test("a congress.gov URL yields the congress as well as the bill", () => {
  assert.deepEqual(
    parseCongressGovUrl("https://www.congress.gov/bill/119th-congress/senate-bill/1234"),
    { jurisdiction: "federal", billType: "senate_bill", number: 1234, congress: 119 }
  )
  assert.equal(parseCongressGovUrl("https://www.congress.gov/bill/119th-congress/not-a-type/1"), null)
  assert.equal(parseCongressGovUrl("https://www.flsenate.gov/Session/Bill/2026/106"), null)
})

test("congress numbering matches the known boundaries", () => {
  assert.equal(congressForYear(2025), 119)
  assert.equal(congressForYear(2026), 119)
  assert.equal(congressForYear(2027), 120)
  assert.equal(congressForYear(1789), 1)
})

test("the four fabricated items from the live feed are all caught", () => {
  // Verbatim from a live run on 2026-09-30. Every number is a real bill; not one of the titles is.
  // Looked up on govtrack at the time, which is where the authoritative column comes from.
  const fabrications: [string, string][] = [
    ["S. 1234 – Commercial Real Estate Credit Enhancement Act", "SSI Savings Penalty Elimination Act"],
    ["H.R. 5678 – Commercial Property Foreclosure Reform Act", "No Pay for Disarray Act"],
    ["S. 2345 – Commercial Mortgage Lending Transparency Act", "Short on Competition Act"],
    [
      "S. 3456 – Distressed Commercial Property Acquisition Act",
      "Law Enforcement Officer and Firefighter Recreation Pass Act",
    ],
  ]
  for (const [claimed, authoritative] of fabrications) {
    assert.equal(titlesAgree(claimed, authoritative), false, claimed)
  }
})

test("the same bill keys the same way however the item is worded", () => {
  // The status table is keyed on this. If a reworded title produced a different key, the bill
  // would look unseen tomorrow and the tracker would report a move that never happened.
  const monday = billKeyFor({
    title: "H.R. 7730 – Bankruptcy Threshold Adjustment Act",
    source: "H.R. 7730 — U.S. House",
    url: "https://www.congress.gov/bill/119th-congress/house-bill/7730",
  })
  const tuesday = billKeyFor({
    title: "Bankruptcy Threshold Adjustment Act (H.R. 7730), as passed",
    source: "H.R. 7730",
  })
  assert.equal(monday, tuesday)
  assert.equal(monday, "US house_bill 7730")
})

test("the two legislatures cannot collide in the status table", () => {
  // "SB 110" and "S. 110" are different bills. Sharing a key would make one overwrite the other.
  assert.notEqual(
    billKey({ jurisdiction: "florida", chamber: "senate", number: 110 }),
    billKey({ jurisdiction: "federal", billType: "senate_bill", number: 110 })
  )
})

test("an item with no bill in it has no key rather than a made-up one", () => {
  assert.equal(billKeyFor({ title: "Florida Legislature Adjourns Regular Session" }), null)
})

test("a genuine citation survives a wording difference between short and long title", () => {
  // The common honest case: the item gives the short title, the record gives the official one.
  assert.ok(
    titlesAgree(
      "S. 4102 – Commercial Real Estate Loan Flexibility Act",
      "A bill to provide flexibility for certain commercial real estate loans held by insured depository institutions"
    )
  )
})

test("agreement is not manufactured by boilerplate alone", () => {
  // Without a noise list, "Act" plus "Florida" would make any two titles look like the same bill.
  assert.equal(titlesAgree("Florida Insurance Act", "Florida Education Act"), false)
})

test("bill numbers cannot count as title agreement", () => {
  assert.equal(significantWords("S. 1234 Act").has("1234"), false)
})

test("a distinctive single word carries a very short title", () => {
  assert.ok(titlesAgree("Foreclosure Fairness", "The Foreclosure Fairness Act of 2026"))
})
