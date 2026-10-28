import assert from "node:assert/strict"
import { test } from "node:test"

import type { ScreeningRow } from "./analytics/screening.ts"
import {
  describeTest,
  institutionMatches,
  normalizeApplicability,
  resolveApplicability,
  selectMatching,
} from "./legal-applicability.ts"

/**
 * `creConcentration` and `creToTier1Tier2` are both "CRE concentration" and mean different
 * things, so every fixture sets both explicitly rather than letting a default imply they agree.
 */
function bank(over: Partial<ScreeningRow> & { id: string }): ScreeningRow {
  return {
    name: `Bank ${over.id}`,
    state: "FLORIDA",
    totalAssets: 1e9,
    creConcentration: 40,
    opportunityScore: 50,
    earningsScore: 50,
    vulnerabilityScore: 50,
    trend: [],
    capitalRatios: {
      creToTier1Tier2: 2,
      creToEquity: 2,
      constructionToTier1Tier2: 0.5,
      multifamilyToTier1Tier2: 0.3,
    },
    ...over,
  } as ScreeningRow
}

// ── The unit trap ──────────────────────────────────────────────────────────────

test("a 300% threshold is measured against capital, not against total loans", () => {
  // The distinction that makes this whole module necessary. This bank has CRE at 55% of its loan
  // book and 340% of its capital, which is what the 2006 guidance limb actually asks about.
  const concentrated = bank({
    id: "1",
    creConcentration: 55,
    capitalRatios: {
      creToTier1Tier2: 3.4,
      creToEquity: 3.4,
      constructionToTier1Tier2: 0.5,
      multifamilyToTier1Tier2: 0.3,
    },
  })

  assert.ok(institutionMatches(concentrated, { minCreToCapitalPct: 300 }))
})

test("the 300% test does not silently match nothing", () => {
  // Resolved against `creConcentration` instead, every test above 100 would match zero
  // institutions and read as a rule that happens to affect no one. Guard the direction.
  const universe = [
    bank({ id: "a", capitalRatios: ratios(1.2) }),
    bank({ id: "b", capitalRatios: ratios(3.1) }),
    bank({ id: "c", capitalRatios: ratios(4.8) }),
  ]
  const { matched } = resolveApplicability({ minCreToCapitalPct: 300 }, universe)
  assert.equal(matched, 2)
})

test("the construction limb reads its own ratio, not the total CRE one", () => {
  const row = bank({
    id: "1",
    capitalRatios: {
      creToTier1Tier2: 1.0,
      creToEquity: 1.0,
      constructionToTier1Tier2: 1.4,
      multifamilyToTier1Tier2: 0.2,
    },
  })
  assert.ok(institutionMatches(row, { minConstructionToCapitalPct: 100 }))
  assert.equal(institutionMatches(row, { minCreToCapitalPct: 100 }), true)
  assert.equal(institutionMatches(row, { minCreToCapitalPct: 300 }), false)
})

function ratios(cre: number): ScreeningRow["capitalRatios"] {
  return {
    creToTier1Tier2: cre,
    creToEquity: cre,
    constructionToTier1Tier2: 0.4,
    multifamilyToTier1Tier2: 0.2,
  }
}

// ── Missing data ───────────────────────────────────────────────────────────────

test("an institution with no capital ratios is excluded from a concentration test", () => {
  // Excluded rather than included, so the count reads as "at least this many" — FDIC omits the
  // capital inputs for some filers and counting them would inflate the affected set.
  const unknown = bank({ id: "1", capitalRatios: undefined })
  assert.equal(institutionMatches(unknown, { minCreToCapitalPct: 300 }), false)
})

test("a missing ratio does not affect a test that never asked about it", () => {
  const unknown = bank({ id: "1", totalAssets: 5e10, capitalRatios: undefined })
  assert.ok(institutionMatches(unknown, { minTotalAssetsUsd: 1e10 }))
})

// ── Asset bands ────────────────────────────────────────────────────────────────

test("asset thresholds are inclusive at the boundary the rule names", () => {
  const exactly10bn = bank({ id: "1", totalAssets: 1e10 })
  assert.ok(institutionMatches(exactly10bn, { minTotalAssetsUsd: 1e10 }))
  assert.ok(institutionMatches(exactly10bn, { maxTotalAssetsUsd: 1e10 }))
})

test("a community-bank relief band excludes the large banks", () => {
  const universe = [
    bank({ id: "small", totalAssets: 4e8 }),
    bank({ id: "mid", totalAssets: 5e9 }),
    bank({ id: "large", totalAssets: 8e10 }),
  ]
  const matched = selectMatching({ maxTotalAssetsUsd: 1e10 }, universe)
  assert.deepEqual(matched.map((r) => r.id), ["mid", "small"])
})

// ── Normalization ──────────────────────────────────────────────────────────────

test("an item with no stated scope resolves to no test at all", () => {
  // Must be null rather than an empty test: an empty test matches everyone and would put a
  // confident, meaningless number on the card.
  assert.equal(normalizeApplicability(undefined), null)
  assert.equal(normalizeApplicability({}), null)
  assert.equal(normalizeApplicability({ basis: "banks of all sizes" }), null)
})

test("a plainly universal rule is a usable test, unlike an absent one", () => {
  const test = normalizeApplicability({ appliesToAllInstitutions: true })
  assert.ok(test)
  assert.equal(test.appliesToAllInstitutions, true)
})

test("appliesToAllInstitutions selects the whole universe", () => {
  const universe = [bank({ id: "a" }), bank({ id: "b" })]
  const { matched, universe: size } = resolveApplicability(
    { appliesToAllInstitutions: true },
    universe
  )
  assert.equal(matched, 2)
  assert.equal(size, 2)
})

test("nonsense thresholds are rejected rather than clamped", () => {
  // Clamping would silently answer a different question than the rule asked.
  assert.equal(normalizeApplicability({ minTotalAssetsUsd: -5 }), null)
  assert.equal(normalizeApplicability({ minTotalAssetsUsd: Number.NaN }), null)
  assert.equal(normalizeApplicability({ minCreToCapitalPct: 1e9 }), null)
  assert.equal(normalizeApplicability({ minTotalAssetsUsd: "10bn" }), null)
})

test("an inverted asset band is treated as a misread, not a narrow rule", () => {
  assert.equal(
    normalizeApplicability({ minTotalAssetsUsd: 1e11, maxTotalAssetsUsd: 1e9 }),
    null
  )
})

test("a usable threshold survives alongside an unusable one", () => {
  const test = normalizeApplicability({ minTotalAssetsUsd: 1e10, minCreToCapitalPct: -3 })
  assert.ok(test)
  assert.equal(test.minTotalAssetsUsd, 1e10)
  assert.equal(test.minCreToCapitalPct, undefined)
})

// ── Examples and description ───────────────────────────────────────────────────

test("examples are the largest matches, so a wrong test is recognisable", () => {
  const universe = [
    bank({ id: "tiny", totalAssets: 1e8 }),
    bank({ id: "huge", totalAssets: 9e10 }),
    bank({ id: "big", totalAssets: 4e10 }),
    bank({ id: "medium", totalAssets: 2e9 }),
  ]
  const { examples } = resolveApplicability({ appliesToAllInstitutions: true }, universe)
  assert.deepEqual(examples.map((e) => e.cert), ["huge", "big", "medium"])
})

test("the description states the numbers actually applied", () => {
  // Derived from the sanitized test rather than echoing the model's prose, so the claim on the
  // card and the count beside it cannot drift.
  assert.equal(
    describeTest({ minTotalAssetsUsd: 1e10, minCreToCapitalPct: 300 }),
    "assets of $10bn or more and CRE at or above 300% of capital"
  )
  assert.equal(describeTest({ maxTotalAssetsUsd: 1e9 }), "assets under $1bn")
  assert.equal(
    describeTest({ minTotalAssetsUsd: 5e8, maxTotalAssetsUsd: 1e10 }),
    "assets between $500m and $10bn"
  )
  assert.equal(describeTest({ appliesToAllInstitutions: true }), "all insured institutions")
})
