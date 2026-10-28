import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEVELOPMENT_MAX_AGE_DAYS,
  developmentsQuery,
  hasUsablePhrase,
  identifyingPhrases,
  isRecent,
  rankDevelopments,
  scoreDevelopment,
  type DevelopmentItem,
  type ScoredDevelopment,
} from "./developments"
import { PEERS } from "./registry"

const ASOF = "2026-10-21"

function item(title: string, over: Partial<DevelopmentItem> = {}): DevelopmentItem {
  return { title, url: "https://example.com/a", publishedAt: "2026-10-01", source: "Example", ...over }
}

test("a one-word name cannot identify a manager", () => {
  // Bridge, Ladder, Camden, Apollo, Ares, Integra, Omnia, Naso, Pretium are all
  // in the registry and all are ordinary words.
  assert.deepEqual(identifyingPhrases("Bridge", ["Bridge"]), [])
  assert.equal(hasUsablePhrase("Bridge", ["Bridge"]), false)
  // The full name is safe.
  assert.ok(identifyingPhrases("Bridge Investment Group", ["Bridge"]).includes("Bridge Investment Group"))
  assert.deepEqual(
    identifyingPhrases("Bridge Investment Group", ["Bridge"]).filter((p) => p === "Bridge"),
    [],
    "the one-word alias is dropped, not kept alongside"
  )
})

test("the query refuses to be built without a safe phrase", () => {
  assert.equal(developmentsQuery("Ares", ["Ares"]), null)
  const q = developmentsQuery("Ares Management", ["ASIF", "Ares Strategic Income"])
  assert.ok(q)
  assert.match(q, /"Ares Management"/)
  assert.ok(!q.includes('"ASIF"'), "a four-letter ticker is one word and unsafe")
  assert.match(q, /AND \("fund" OR/, "a fund context term is always required")
})

test("the longest spelling wins when phrases duplicate", () => {
  const phrases = identifyingPhrases("Blue Owl Capital", ["Blue Owl", "blue owl capital"])
  assert.ok(phrases.includes("Blue Owl Capital"))
  assert.equal(phrases.filter((p) => p.toLowerCase().replace(/\s+/g, " ") === "blue owl capital").length, 1)
})

const BRIDGE = { peerId: "bridge-investment-group", manager: "Bridge Investment Group", aliases: ["Bridge", "Bridge Debt Strategies", "BRDG"] }

test("a headline about a bridge is not news about Bridge Investment Group", () => {
  const d = scoreDevelopment(item("City closes Brooklyn Bridge for repairs after inspection"), BRIDGE)
  assert.equal(d.kept, false)
  assert.equal(d.kept === false && d.reason, "no name match")
})

test("a real fund close is kept, with the matching phrase recorded", () => {
  const d = scoreDevelopment(item("Bridge Investment Group closes Debt Strategies Fund VI at $2.5bn"), BRIDGE)
  assert.equal(d.kept, true)
  if (!d.kept) return
  assert.equal(d.item.matchedPhrase, "Bridge Investment Group")
  assert.ok(d.item.matchedTerms.includes("closes"))
  assert.ok(d.item.score > 0)
})

test("the name must appear in the title, not merely in the URL", () => {
  const d = scoreDevelopment(
    item("Manager closes new credit fund", { url: "https://example.com/bridge-investment-group/news" }),
    BRIDGE
  )
  assert.equal(d.kept, false, "a slug or domain can contain anything")
})

test("mentioning a manager is not a development about it", () => {
  const d = scoreDevelopment(item("Bridge Investment Group names new Denver office address"), BRIDGE)
  assert.equal(d.kept, false)
  assert.equal(d.kept === false && d.reason, "no development term")
})

test("single-asset coverage is dropped even when it names the manager", () => {
  const d = scoreDevelopment(
    item("Bridge Investment Group acquires 240,000 square feet office tower in Phoenix"),
    BRIDGE
  )
  assert.equal(d.kept, false)
  assert.equal(d.kept === false && d.reason, "looks like single-asset coverage")
})

test("a development that happens to mention a building still survives", () => {
  const d = scoreDevelopment(
    item("Bridge Investment Group raises $2.5bn and closes oversubscribed fund after strong commitments"),
    BRIDGE
  )
  assert.equal(d.kept, true, "three development terms outweigh one noise term")
})

test("gating and redemption language is treated as a development", () => {
  for (const title of [
    "Starwood Capital limits redemptions at its non-traded REIT",
    "Starwood Capital fund gated as withdrawal requests rise",
  ]) {
    const d = scoreDevelopment(item(title), { peerId: "starwood", manager: "Starwood Capital", aliases: ["Starwood", "SREIT"] })
    assert.equal(d.kept, true, title)
  }
})

test("ranking is newest first and deduplicates the same story across managers", () => {
  const base: ScoredDevelopment = {
    title: "Blue Owl closes credit fund", url: "u", publishedAt: "2026-10-01", source: "s",
    peerId: "blue-owl", manager: "Blue Owl Capital", matchedPhrase: "Blue Owl Capital",
    matchedTerms: ["closes"], matchedNoise: [], score: 3,
  }
  const ranked = rankDevelopments([
    { ...base, publishedAt: "2026-09-01" },
    { ...base, title: "BLUE OWL CLOSES CREDIT FUND", score: 9 },
    { ...base, title: "Another story", publishedAt: "2026-10-10" },
  ])
  assert.equal(ranked.length, 2, "the same title in different case is one story")
  assert.equal(ranked[0].title, "Another story", "newest first")
  const dedup = ranked.find((r) => /blue owl closes/i.test(r.title))!
  assert.equal(dedup.score, 9, "the better-scoring copy is kept")
})

test("an item with no date is not recent, because it cannot be shown to be", () => {
  assert.equal(isRecent(item("x", { publishedAt: null }), ASOF), false)
})

test("stale items are dropped and future-dated ones tolerated by a day", () => {
  assert.equal(isRecent(item("x", { publishedAt: "2026-10-20" }), ASOF), true)
  assert.equal(isRecent(item("x", { publishedAt: "2026-01-01" }), ASOF), false)
  assert.equal(isRecent(item("x", { publishedAt: "2026-10-22" }), ASOF), true, "a timezone can put a feed a day ahead")
  assert.equal(isRecent(item("x", { publishedAt: "2026-11-30" }), ASOF), false)
  const edge = new Date(Date.parse(`${ASOF}T00:00:00Z`) - DEVELOPMENT_MAX_AGE_DAYS * 86_400_000)
    .toISOString().slice(0, 10)
  assert.equal(isRecent(item("x", { publishedAt: edge }), ASOF), true, "exactly at the limit is in")
})

test("every manager in the registry is either coverable or knowably not", () => {
  const uncoverable = PEERS.filter((p) => !hasUsablePhrase(p.manager, p.aliases)).map((p) => p.manager)
  // Every registry name is at least two words, so all are coverable; this test
  // fails loudly if a one-word manager is ever added.
  assert.deepEqual(uncoverable, [], `these managers cannot be searched safely: ${uncoverable.join(", ")}`)
  for (const peer of PEERS) assert.ok(developmentsQuery(peer.manager, peer.aliases), peer.manager)
})

test("a term cannot match inside a longer word", () => {
  // "Issues Pessimistic Forecast" matched "sues" and read as litigation.
  const d = scoreDevelopment(
    item("Keefe Bruyette & Woods Issues Pessimistic Forecast for Ladder Capital"),
    { peerId: "ladder-capital", manager: "Ladder Capital", aliases: ["Ladder", "LADR"] }
  )
  assert.equal(d.kept, false, "an analyst forecast is not a lawsuit")

  const real = scoreDevelopment(
    item("Investors sued Ladder Capital over fund disclosures"),
    { peerId: "ladder-capital", manager: "Ladder Capital", aliases: ["Ladder", "LADR"] }
  )
  assert.equal(real.kept, true, "the actual word still matches")
})

test("sell-side price-target coverage is noise, not a development", () => {
  for (const title of [
    "B. Riley Cuts Price Target on Ladder Capital to $12 From $13, Keeps Buy Rating",
    "Citizens JMP Maintains BrightSpire Capital With Buy Rating, Cuts Target Price",
  ]) {
    const d = scoreDevelopment(item(title), { peerId: "x", manager: title.includes("Ladder") ? "Ladder Capital" : "BrightSpire Capital", aliases: [] })
    assert.equal(d.kept, false, title)
  }
})

test("a real redemption story survives the analyst filter", () => {
  const d = scoreDevelopment(
    item("Two Blue Owl Private Credit Funds See Redemption Requests Well Above 5%"),
    { peerId: "blue-owl", manager: "Blue Owl Capital", aliases: ["Blue Owl"] }
  )
  assert.equal(d.kept, true)
  if (d.kept) assert.ok(d.item.matchedTerms.includes("redemption"))
})

test("the same story from several publishers collapses to one", () => {
  const base = {
    url: "u", publishedAt: "2026-10-05", source: "s", peerId: "blue-owl",
    manager: "Blue Owl Capital", matchedPhrase: "Blue Owl", matchedTerms: ["redemptions"], matchedNoise: [], score: 6,
  }
  const ranked = rankDevelopments([
    { ...base, title: "Private credit roundup: Blue Owl redemptions ease - Reuters" },
    { ...base, title: "Private credit roundup: Blue Owl redemptions ease - Yahoo Finance" },
    { ...base, title: "Private credit roundup: Blue Owl redemptions ease" },
  ] as ScoredDevelopment[])
  assert.equal(ranked.length, 1, "the publisher suffix is not part of the story")
})

test("a hyphenated headline is not truncated by the publisher strip", () => {
  const base = {
    url: "u", publishedAt: "2026-10-05", source: "s", peerId: "x", manager: "Blue Owl Capital",
    matchedPhrase: "Blue Owl", matchedTerms: ["closes"], matchedNoise: [], score: 3,
  }
  const ranked = rankDevelopments([
    { ...base, title: "Blue Owl closes fund - Reuters" },
    { ...base, title: "Blue Owl closes second fund - Reuters" },
  ] as ScoredDevelopment[])
  assert.equal(ranked.length, 2, "different stories stay distinct")
})
