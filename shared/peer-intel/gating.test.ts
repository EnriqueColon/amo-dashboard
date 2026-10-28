import { test } from "node:test"
import assert from "node:assert/strict"
import {
  assessGating,
  AT_CAP_THRESHOLD,
  extractRepurchaseCap,
  extractRepurchaseRows,
  extractSharesOutstanding,
  plainText,
} from "./gating"

/** Blue Owl Credit Income's Q2 2026 10-Q, as the flattened text reads. */
const BLUE_OWL = `
The Company intends to limit the number of shares to be repurchased in each quarter to no more than
5.00% of its outstanding shares of common stock. While the Company intends to continue to conduct
quarterly tender offers as described above, the Company is not required to do so.
Offer Date Class Tender Offer Expiration Tender Offer (in thousands) Purchase Price per Share Shares Repurchased
February 27, 2026 S March 31, 2026 194,086 9.08 21,371,701
February 27, 2026 D March 31, 2026 44,477 9.09 4,893,111
February 27, 2026 I March 31, 2026 724,544 9.11 79,537,341
May 22, 2026 S June 30, 2026 174,160 9.05 19,244,245
May 22, 2026 D June 30, 2026 30,906 9.06 3,411,226
May 22, 2026 I June 30, 2026 749,908 9.08 82,588,966
Note 10. Earnings Per Share For the Three Months Ended June 30, 2026 2025 S D I S D I
Weighted average shares of common stock outstanding—basic and diluted 677,788,032 45,717,405
1,402,819,846 607,882,907 58,468,742 1,172,654,549
Earnings (loss) per common share—basic and diluted $ 0.16 $ 0.17 $ 0.18 $ 0.19 $ 0.20 $ 0.21
`.replace(/\s+/g, " ")

const VEHICLE = { cik: "1812554", manager: "Blue Owl Capital", vehicleName: "Blue Owl Credit Income Corp." }

test("the stated cap is read with the sentence it came from", () => {
  const cap = extractRepurchaseCap(BLUE_OWL)
  assert.ok(cap)
  assert.equal(cap.fraction, 0.05)
  assert.equal(cap.basis, "shares")
  assert.match(cap.quote, /no more than 5\.00% of its outstanding shares/)
})

test("a cap against net asset value is recognised as a different basis", () => {
  const cap = extractRepurchaseCap(
    "The Fund intends to limit repurchases to no more than 5% of its aggregate net asset value per quarter."
  )
  assert.equal(cap?.basis, "nav")
  assert.equal(cap?.fraction, 0.05)
})

test("an implausible percentage is not a repurchase cap", () => {
  // A sentence about owning 25% of voting securities must not be read as a cap.
  assert.equal(
    extractRepurchaseCap("the Company is deemed to control a portfolio company if it owns more than 25% of the shares."),
    null
  )
  assert.equal(extractRepurchaseCap("no cap is stated anywhere in this document"), null)
})

test("every class row in the repurchase table is read", () => {
  const rows = extractRepurchaseRows(BLUE_OWL)
  assert.equal(rows.length, 6)
  const q2 = rows.filter((r) => r.expiration === "2026-06-30")
  assert.equal(q2.length, 3, "three classes in the quarter")
  assert.deepEqual(q2.map((r) => r.shareClass), ["S", "D", "I"])
  assert.equal(q2.find((r) => r.shareClass === "I")?.shares, 82_588_966)
  assert.equal(q2.find((r) => r.shareClass === "I")?.amountThousands, 749_908)
})

test("the amount reconciles with shares times price, which is how we know the column", () => {
  const i = extractRepurchaseRows(BLUE_OWL).find((r) => r.expiration === "2026-06-30" && r.shareClass === "I")!
  const implied = (i.shares * (i.pricePerShare as number)) / 1000
  assert.ok(Math.abs(implied - i.amountThousands) / i.amountThousands < 0.001,
    "the column is what was bought, not what was requested")
})

test("shares outstanding sums the current period's classes, not the largest figures", () => {
  // The section also carries the prior year's columns. Summing the largest
  // values over-counted Blue Owl by over a billion shares.
  assert.equal(extractSharesOutstanding(BLUE_OWL), 677_788_032 + 45_717_405 + 1_402_819_846)
})

test("a single-class filer is read as one figure", () => {
  assert.equal(
    extractSharesOutstanding("Weighted average shares of common stock outstanding—basic and diluted 123,456,789"),
    123_456_789
  )
})

test("an odd run of figures is refused rather than halved wrongly", () => {
  assert.equal(
    extractSharesOutstanding("Weighted average shares outstanding 100,000,000 200,000,000 300,000,000"),
    null
  )
  assert.equal(extractSharesOutstanding("nothing here"), null)
})

test("Blue Owl's Q2 2026 reads as at its cap, which is proration", () => {
  const a = assessGating(VEHICLE, BLUE_OWL)
  assert.ok(a)
  assert.equal(a.quarter, "2026-06-30")
  assert.deepEqual(a.classes, ["S", "D", "I"])
  assert.equal(a.sharesRepurchased, 19_244_245 + 3_411_226 + 82_588_966)
  assert.equal(a.amountThousands, 174_160 + 30_906 + 749_908)
  assert.equal(a.sharesOutstanding, 2_126_325_283)

  // 4.95% against a 5.00% cap: 99% of the cap used.
  assert.ok(a.utilisation != null)
  assert.equal(Math.round(a.utilisation * 10_000) / 100, 4.95)
  assert.ok(a.capUsed != null && a.capUsed > AT_CAP_THRESHOLD)
  assert.equal(a.verdict, "at-cap", "the offer was taken to its limit, so holders were prorated")
})

test("a vehicle well inside its cap reads as below-cap", () => {
  const easy = BLUE_OWL.replace("749,908 9.08 82,588,966", "74,990 9.08 8,258,896")
  const a = assessGating(VEHICLE, easy)
  assert.equal(a?.verdict, "below-cap")
  assert.ok((a?.capUsed ?? 1) < AT_CAP_THRESHOLD)
})

test("no cap or no table means unassessable, never a guess", () => {
  assert.equal(assessGating(VEHICLE, "a filing with neither a cap nor a repurchase table"), null)
  assert.equal(assessGating(VEHICLE, BLUE_OWL.replace(/5\.00% of its outstanding shares/, "an unstated share")), null)
})

test("a missing denominator is unknown, not assumed", () => {
  const noEps = BLUE_OWL.replace(/Weighted average shares[\s\S]*$/, "")
  const a = assessGating(VEHICLE, noEps)
  assert.ok(a)
  assert.equal(a.sharesOutstanding, null)
  assert.equal(a.utilisation, null)
  assert.equal(a.verdict, "unknown", "without a denominator nothing can be concluded")
  assert.equal(a.sharesRepurchased, 105_244_437, "what was repurchased is still known")
})

test("plainText strips markup and entities without joining words", () => {
  const t = plainText("<p>Shares&nbsp;repurchased</p><td>5.00%</td>")
  assert.match(t, /Shares repurchased/)
  assert.match(t, /5\.00%/)
  assert.ok(!t.includes("<"))
})

test("a cap worded as a NAV cap is recognised", () => {
  // Blackstone's vehicles word it differently from Blue Owl's.
  const cap = extractRepurchaseCap("subject to a 5% cap on NAV for Class S shares and a 1% early repurchase deduction.")
  assert.equal(cap?.fraction, 0.05)
  assert.equal(cap?.basis, "nav")
})

test("a truncated document yields nothing rather than a partial verdict", () => {
  // The guard against a failed download lives in the service, where a short
  // response is a fetch failure; here a document without a cap or table simply
  // cannot be assessed.
  assert.equal(assessGating(VEHICLE, BLUE_OWL.slice(0, 200)), null)
})
