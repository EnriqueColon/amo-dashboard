import { test } from "node:test"
import assert from "node:assert/strict"
import {
  dedupeFacts,
  durationToQuarters,
  instantToQuarters,
  metricSpec,
  netFlow,
  parseConceptFacts,
  PEER_METRICS,
  toQuarters,
  trailingQuarters,
  type XbrlFact,
} from "./xbrl"

function d(start: string, end: string, val: number, filed = "2026-01-01", extra: Partial<XbrlFact> = {}): XbrlFact {
  return { start, end, val, filed, form: "10-Q", ...extra }
}
function i(end: string, val: number, filed = "2026-01-01"): XbrlFact {
  return { end, val, filed, form: "10-Q" }
}

/**
 * Blue Owl Credit Income's real PaymentsForRepurchaseOfCommonStock trail for
 * 2025-2026, including the duplicated comparatives, as EDGAR serves it.
 */
function blueOwlRepurchases(): XbrlFact[] {
  return [
    d("2025-01-01", "2025-03-31", 193_197_000, "2025-05-08"),
    d("2025-01-01", "2025-03-31", 193_197_000, "2026-05-11"),
    d("2025-01-01", "2025-06-30", 397_119_000, "2025-08-07"),
    d("2025-01-01", "2025-06-30", 397_119_000, "2026-08-06"),
    d("2025-01-01", "2025-09-30", 861_353_000, "2025-11-06"),
    d("2025-01-01", "2025-12-31", 1_178_986_000, "2026-03-03", { form: "10-K" }),
    d("2026-01-01", "2026-03-31", 1_009_048_000, "2026-05-11"),
    d("2026-01-01", "2026-06-30", 1_972_578_000, "2026-08-06"),
  ]
}

test("repeated comparatives collapse to one fact per period", () => {
  const deduped = dedupeFacts(blueOwlRepurchases())
  assert.equal(deduped.length, 6, "eight facts, six distinct periods")
  assert.equal(deduped.filter((f) => f.restated).length, 0, "the repeats agree, so nothing is restated")
  assert.deepEqual(
    deduped.map((f) => f.end),
    ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]
  )
})

test("a genuine restatement keeps the latest filing and is flagged", () => {
  const facts = [
    d("2026-01-01", "2026-03-31", 100, "2026-05-11"),
    d("2026-01-01", "2026-03-31", 120, "2026-08-06"),
  ]
  const [fact] = dedupeFacts(facts)
  assert.equal(fact.val, 120, "a restatement is the better number")
  assert.equal(fact.restated, true)
})

test("restatement is flagged regardless of which order the facts arrive", () => {
  const forward = dedupeFacts([
    d("2026-01-01", "2026-03-31", 100, "2026-05-11"),
    d("2026-01-01", "2026-03-31", 120, "2026-08-06"),
  ])
  const backward = dedupeFacts([
    d("2026-01-01", "2026-03-31", 120, "2026-08-06"),
    d("2026-01-01", "2026-03-31", 100, "2026-05-11"),
  ])
  assert.equal(forward[0].val, 120)
  assert.equal(backward[0].val, 120)
  assert.equal(forward[0].restated, true)
  assert.equal(backward[0].restated, true)
})

test("year-to-date differencing reproduces Blue Owl's quarterly redemptions", () => {
  const q = durationToQuarters(blueOwlRepurchases())
  const by = new Map(q.map((p) => [p.end, p.value]))

  // 2025: 193.197 YTD at Q1, so Q1 is the YTD figure itself.
  assert.equal(by.get("2025-03-31"), 193_197_000)
  assert.equal(by.get("2025-06-30"), 397_119_000 - 193_197_000)
  assert.equal(by.get("2025-09-30"), 861_353_000 - 397_119_000)
  assert.equal(by.get("2025-12-31"), 1_178_986_000 - 861_353_000)
  // The four quarters must sum back to the reported full year.
  const y2025 = q.filter((p) => p.end.startsWith("2025")).map((p) => p.value as number)
  assert.equal(y2025.reduce((a, b) => a + b, 0), 1_178_986_000)

  // 2026 is its own fiscal year, so Q1 resets rather than differencing off 2025.
  assert.equal(by.get("2026-03-31"), 1_009_048_000)
  assert.equal(by.get("2026-06-30"), 1_972_578_000 - 1_009_048_000)
})

test("the figures carry the year-on-year story the panel reports", () => {
  const q = durationToQuarters(blueOwlRepurchases())
  const by = new Map(q.map((p) => [p.end, p.value as number]))
  // Redemptions roughly quintupled in Q1 and quadrupled in Q2.
  assert.ok(by.get("2026-03-31")! / by.get("2025-03-31")! > 5)
  assert.ok(by.get("2026-06-30")! / by.get("2025-06-30")! > 4)
})

test("a missing intermediate period leaves the next quarter null, not inflated", () => {
  // A 10-K filed with no Q3 10-Q: Q4 cannot be derived.
  const q = durationToQuarters([
    d("2026-01-01", "2026-03-31", 100, "2026-05-01"),
    d("2026-01-01", "2026-06-30", 250, "2026-08-01"),
    d("2026-01-01", "2026-12-31", 900, "2027-03-01", { form: "10-K" }),
  ])
  const by = new Map(q.map((p) => [p.end, p.value]))
  assert.equal(by.get("2026-03-31"), 100)
  assert.equal(by.get("2026-06-30"), 150)
  assert.equal(by.get("2026-12-31"), null, "three quarters of flow must not land in one bar")
})

test("a year reported only as a full year yields no quarter", () => {
  const q = durationToQuarters([d("2026-01-01", "2026-12-31", 900, "2027-03-01", { form: "10-K" })])
  assert.equal(q.length, 1)
  assert.equal(q[0].value, null)
  assert.equal(q[0].fiscalQuarter, 4)
})

test("a non-calendar fiscal year differences correctly with no special case", () => {
  // June year end: the fiscal year starts 2025-07-01.
  const q = durationToQuarters([
    d("2025-07-01", "2025-09-30", 40, "2025-11-01"),
    d("2025-07-01", "2025-12-31", 90, "2026-02-01"),
    d("2025-07-01", "2026-03-31", 150, "2026-05-01"),
    d("2025-07-01", "2026-06-30", 220, "2026-09-01", { form: "10-K" }),
  ])
  const by = new Map(q.map((p) => [p.end, p.value]))
  assert.equal(by.get("2025-09-30"), 40, "the first fiscal quarter is the YTD figure")
  assert.equal(by.get("2025-12-31"), 50)
  assert.equal(by.get("2026-03-31"), 60)
  assert.equal(by.get("2026-06-30"), 70)
  // Labels stay calendar so periods line up across filers.
  assert.equal(q.find((p) => p.end === "2025-12-31")?.label, "Q4 2025")
  assert.equal(q.find((p) => p.end === "2025-12-31")?.fiscalQuarter, 2)
})

test("two fiscal years never difference across the boundary", () => {
  const q = durationToQuarters([
    d("2025-01-01", "2025-12-31", 1000, "2026-03-01", { form: "10-K" }),
    d("2026-01-01", "2026-03-31", 50, "2026-05-01"),
  ])
  assert.equal(q.find((p) => p.end === "2026-03-31")?.value, 50, "Q1 resets; it is not 50 − 1000")
})

test("instant facts are used as reported, with no differencing", () => {
  const q = instantToQuarters([
    i("2026-03-31", 35_500_450_000),
    i("2026-06-30", 35_690_147_000),
    i("2026-06-30", 35_690_147_000, "2026-11-01"),
  ])
  assert.equal(q.length, 2, "the repeat collapses")
  assert.equal(q[1].value, 35_690_147_000)
  assert.equal(q[1].label, "Q2 2026")
})

test("toQuarters routes by declared basis, not by guessing from the data", () => {
  const facts = [d("2026-01-01", "2026-03-31", 10), i("2026-03-31", 99)]
  assert.equal(toQuarters("duration", facts)[0].value, 10)
  assert.equal(toQuarters("instant", facts)[0].value, 99)
})

test("net flow needs both sides, and is null when either is missing", () => {
  const subs = durationToQuarters([
    d("2026-01-01", "2026-03-31", 670_403_000, "2026-05-11"),
    d("2026-01-01", "2026-06-30", 787_864_000, "2026-08-06"),
  ])
  const reps = durationToQuarters([
    d("2026-01-01", "2026-03-31", 1_009_048_000, "2026-05-11"),
    d("2026-01-01", "2026-06-30", 1_972_578_000, "2026-08-06"),
  ])
  const flow = netFlow(subs, reps)
  // Blue Owl's real Q2 2026: $117.5M in against $963.5M out.
  assert.equal(flow.find((p) => p.end === "2026-03-31")?.value, 670_403_000 - 1_009_048_000)
  assert.equal(flow.find((p) => p.end === "2026-06-30")?.value, 117_461_000 - 963_530_000)
  assert.ok((flow.find((p) => p.end === "2026-06-30")?.value ?? 0) < 0, "a net outflow")

  assert.equal(netFlow(subs, []).every((p) => p.value === null), true, "half a picture is no picture")
})

test("parsing picks the USD unit and drops malformed rows", () => {
  const parsed = parseConceptFacts({
    units: {
      USD: [
        { start: "2026-01-01", end: "2026-03-31", val: 100, form: "10-Q", filed: "2026-05-01", accn: "x" },
        { start: "2026-01-01", end: "2026-06-30" },
        { val: 5 },
      ],
    },
  })
  assert.equal(parsed?.unit, "USD")
  assert.equal(parsed?.facts.length, 1, "a row without both end and val is not a fact")
  assert.equal(parsed?.facts[0].val, 100)
})

test("a per-share unit is accepted when that is all the filer tagged", () => {
  const parsed = parseConceptFacts({ units: { "USD/shares": [{ end: "2026-06-30", val: 9.21 }] } })
  assert.equal(parsed?.unit, "USD/shares")
  assert.equal(parsed?.facts[0].val, 9.21)
})

test("an empty or shapeless response is null, not an empty success", () => {
  assert.equal(parseConceptFacts({}), null)
  assert.equal(parseConceptFacts({ units: {} }), null)
  assert.equal(parseConceptFacts(null), null)
})

test("trailing quarters returns the newest, oldest first", () => {
  const q = durationToQuarters(blueOwlRepurchases())
  const last3 = trailingQuarters(q, 3)
  assert.equal(last3.length, 3)
  assert.equal(last3[2].end, "2026-06-30")
  assert.ok(last3[0].end < last3[2].end)
})

test("every metric declares candidates, basis and measured coverage", () => {
  const keys = PEER_METRICS.map((m) => m.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const m of PEER_METRICS) {
    assert.ok(m.candidates.length > 0, m.key)
    assert.ok(m.coverage.includes("/12"), `${m.key} must state measured coverage`)
    assert.ok(m.basis === "duration" || m.basis === "instant")
  }
  // The two near-universal flows, and the sign convention that makes net flow mean something.
  assert.equal(metricSpec("subscriptions")?.coverage, "12/12")
  assert.equal(metricSpec("repurchases")?.coverage, "11/12")
  // The ones whose meaning flips by vehicle kind must say so.
  assert.ok(metricSpec("repurchases")?.note?.includes("buyback"))
  assert.ok(metricSpec("pikIncome")?.note?.includes("two of the twelve"))
})

test("a directly reported quarter wins over the year-to-date derivation", () => {
  // Blue Owl tags Q2 2026 investment income twice: a 181-day year-to-date
  // figure and a 91-day quarter, which reconcile. Taking both put two points
  // on one period; the reported one is authoritative.
  const q = durationToQuarters([
    d("2026-01-01", "2026-03-31", 833_503_000, "2026-05-11"),
    d("2026-01-01", "2026-06-30", 1_674_985_000, "2026-08-06"),
    d("2026-04-01", "2026-06-30", 841_482_000, "2026-08-06"),
  ])
  const ends = q.map((p) => p.end)
  assert.equal(new Set(ends).size, ends.length, "one point per period")
  const q2 = q.find((p) => p.end === "2026-06-30")
  assert.equal(q2?.value, 841_482_000)
  assert.equal(q2?.origin, "reported")
  // And it agrees with what differencing would have produced.
  assert.equal(1_674_985_000 - 833_503_000, 841_482_000)
})

test("origin distinguishes a reported quarter from a differenced one", () => {
  const q = durationToQuarters([
    d("2026-01-01", "2026-03-31", 100, "2026-05-01"),
    d("2026-01-01", "2026-06-30", 250, "2026-08-01"),
  ])
  assert.equal(q.find((p) => p.end === "2026-03-31")?.origin, "reported", "a one-quarter span is reported")
  assert.equal(q.find((p) => p.end === "2026-06-30")?.origin, "derived")
})

test("a half-year span is never mistaken for a quarter", () => {
  // 2026-04-01 to 2026-06-30 spans two calendar-month boundaries but three
  // months of activity; measuring in months put it in the year-to-date series.
  const q = durationToQuarters([d("2026-04-01", "2026-06-30", 91_000, "2026-08-01")])
  assert.equal(q.length, 1)
  assert.equal(q[0].value, 91_000)
  assert.equal(q[0].origin, "reported")

  const half = durationToQuarters([
    d("2026-01-01", "2026-03-31", 10, "2026-05-01"),
    d("2026-01-01", "2026-06-30", 30, "2026-08-01"),
  ])
  assert.equal(half.find((p) => p.end === "2026-06-30")?.value, 20)
})

test("a year-to-date second quarter differences against a reported first quarter", () => {
  // The filer tagged Q1 as a standalone quarter and Q2 only as year-to-date.
  const q = durationToQuarters([
    d("2026-01-01", "2026-03-31", 40, "2026-05-01"),
    d("2026-01-01", "2026-06-30", 95, "2026-08-01"),
  ])
  assert.equal(q.find((p) => p.end === "2026-06-30")?.value, 55)
})

test("no duplicated period survives mixed tagging across many years", () => {
  const facts: XbrlFact[] = []
  for (const year of [2024, 2025, 2026]) {
    facts.push(d(`${year}-01-01`, `${year}-03-31`, 100, `${year}-05-01`))
    facts.push(d(`${year}-01-01`, `${year}-06-30`, 250, `${year}-08-01`))
    facts.push(d(`${year}-04-01`, `${year}-06-30`, 150, `${year}-08-01`))
    facts.push(d(`${year}-01-01`, `${year}-09-30`, 400, `${year}-11-01`))
    facts.push(d(`${year}-07-01`, `${year}-09-30`, 150, `${year}-11-01`))
  }
  const q = durationToQuarters(facts)
  const ends = q.map((p) => p.end)
  assert.equal(new Set(ends).size, ends.length, "mixed tagging must still yield one point per period")
  assert.equal(q.filter((p) => p.end.endsWith("-06-30")).length, 3)
  for (const p of q.filter((p) => p.end.endsWith("-06-30"))) {
    assert.equal(p.value, 150, "the reported quarter, not the 150 derived from year-to-date")
    assert.equal(p.origin, "reported")
  }
})
