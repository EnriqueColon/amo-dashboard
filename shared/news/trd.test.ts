/**
 * The Real Deal selection: entity decoding, normalisation, the ranking rules, and the gates, run
 * over a 24-post fixture captured from the live API on 2026-10-27 (bodies trimmed to their first
 * paragraphs). Run: npm run test:news-trd
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  articleBlocks,
  buildTrdArticleView,
  decodeEntities,
  normalizeTrdPost,
  regionOf,
  scoreTrdArticle,
  selectTrdTop,
  stripHtml,
  topicOf,
  trdQueryUrl,
  trdSinceParam,
  type TrdApiPost,
} from "./trd"

const FIXTURE = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "trd-posts.json"), "utf8")) as TrdApiPost[]
const NOW = new Date("2026-10-27T18:00:00Z")

function post(over: Partial<TrdApiPost> & { id: number }): TrdApiPost {
  return {
    date_gmt: "2026-10-27T12:00:00",
    link: `https://therealdeal.com/miami/2026/10/27/post-${over.id}/`,
    title: { rendered: `Post ${over.id}` },
    excerpt: { rendered: "<p>Standfirst.</p>" },
    market: [],
    sector: [],
    story_type: [26772],
    ...over,
  }
}

test("decodeEntities handles numeric, hex and named entities", () => {
  assert.equal(decodeEntities("Palm Beach&#8217;s &#x201C;Ham&#x201D; &amp; cheese &hellip;"), "Palm Beach’s “Ham” & cheese …")
  assert.equal(decodeEntities("&unknown; stays"), "&unknown; stays")
})

test("stripHtml drops tags and scripts and collapses whitespace", () => {
  assert.equal(stripHtml("<p>One</p>\n<p>Two <b>bold</b></p><script>x()</script>"), "One Two bold")
})

test("normalizeTrdPost maps terms to slugs, keeps unknown ids visible, and trims the standfirst", () => {
  const a = normalizeTrdPost(
    post({
      id: 1,
      title: { rendered: "Fortune, Ch&#226;teau score $463M loan" },
      excerpt: { rendered: "<p>A big loan for a hotel [&hellip;]</p>" },
      market: [9574, 999999],
      sector: [9610, 26534],
      story_type: [26772],
    })
  )
  assert.ok(a)
  assert.equal(a.title, "Fortune, Château score $463M loan")
  assert.equal(a.excerpt, "A big loan for a hotel")
  assert.equal(a.date, "2026-10-27")
  assert.deepEqual(a.markets, ["miami", "market:999999"])
  assert.deepEqual(a.sectors, ["development", "residential"])
  assert.deepEqual(a.storyTypes, ["news"])
})

test("normalizeTrdPost returns null when the title, link or date is missing", () => {
  assert.equal(normalizeTrdPost(post({ id: 2, title: { rendered: "" } })), null)
  assert.equal(normalizeTrdPost(post({ id: 3, link: "" })), null)
  assert.equal(normalizeTrdPost(post({ id: 4, date_gmt: "not a date" })), null)
})

test("topicOf tests distress before residential", () => {
  assert.equal(topicOf("Brickell condo tower faces foreclosure").topic, "Foreclosure/Distress")
  assert.equal(topicOf("Developer scores $463M loan for St. Regis").topic, "Debt/Financing")
  assert.equal(topicOf("Mill Creek brings multifamily project to Pompano Beach").topic, "Development/Construction")
  assert.equal(topicOf("Investor picks up Boca office complex").topic, "Commercial Real Estate")
  assert.equal(topicOf("Jupiter waterfront mansion trades for $13M").topic, "Waterfront/Residential")
  assert.equal(topicOf("Movers & Shakers").topic, "General Real Estate")
})

test("regionOf: named places win, then the Miami market reads as Florida", () => {
  assert.equal(regionOf({ title: "Fort Lauderdale tower", excerpt: "", markets: ["miami"] }), "miami")
  assert.equal(regionOf({ title: "Palm Beach estate", excerpt: "", markets: ["miami"] }), "florida")
  assert.equal(regionOf({ title: "Quiet deal", excerpt: "", markets: ["miami"] }), "florida")
  assert.equal(regionOf({ title: "Flatiron office", excerpt: "", markets: ["new-york"] }), "national")
})

test("scoreTrdArticle records every rule it applies", () => {
  const a = normalizeTrdPost(
    post({
      id: 5,
      title: { rendered: "Lender moves to foreclose on Wynwood office" },
      market: [9574],
      sector: [27942],
      story_type: [26772],
    })
  )!
  const s = scoreTrdArticle(a)
  assert.equal(s.topic, "Foreclosure/Distress")
  assert.equal(s.region, "miami")
  assert.equal(s.score, 6 + 2 + 3 + 1)
  assert.deepEqual(s.reasons, [
    'Foreclosure/Distress (+6): "foreclose" in the headline or standfirst',
    "Commercial sector (+2)",
    "Miami market (+3): TRD's South Florida desk",
    "Original reporting (+1)",
  ])
})

test("a distress term only in the body adds two and names the term", () => {
  const a = normalizeTrdPost(
    post({
      id: 6,
      title: { rendered: "Investor alleges $20M stake in Loop office wiped" },
      content: { rendered: "<p>The bank began foreclosure proceedings last month.</p>" },
      market: [9569],
      sector: [27942],
      story_type: [26772],
    })
  )!
  const s = scoreTrdArticle(a)
  assert.equal(s.topic, "Commercial Real Estate")
  assert.ok(s.reasons.includes('Distress term in the body (+2): "foreclosure"'))
  assert.equal(s.score, 2 + 2 + 2 + 1)
})

test("residential-only posts are penalised and blurbs earn nothing for reporting", () => {
  const a = normalizeTrdPost(
    post({ id: 7, title: { rendered: "Jupiter mansion trades for $13M" }, market: [9574], sector: [26534], story_type: [26770] })
  )!
  const s = scoreTrdArticle(a)
  assert.equal(s.score, 1 - 2 + 3)
  assert.ok(s.reasons.includes("Residential sector only (−2)"))
  assert.ok(s.reasons.includes("Blurb (+0): a re-report of another outlet's story"))
})

test("selectTrdTop drops stale, promo and celebrity posts, dedupes, and keeps the limit", () => {
  const posts: TrdApiPost[] = [
    post({ id: 10, date_gmt: "2026-10-15T12:00:00", sector: [27942] }), // stale
    post({ id: 11, story_type: [26777], sector: [27942] }), // promo
    post({ id: 12, story_type: [53252], sector: [27942] }), // celebrity
    post({ id: 13, sector: [27942], market: [9574] }),
    post({ id: 13, sector: [27942], market: [9574] }), // duplicate id
    post({ id: 14, link: "https://www.therealdeal.com/miami/2026/10/27/post-13", sector: [27942] }), // duplicate url
    post({ id: 15, date_gmt: "2026-10-28T12:00:00" }), // in the future: stale
    ...[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((id) => post({ id, sector: [27942] })),
  ]
  const sel = selectTrdTop(posts, { now: NOW })
  assert.equal(sel.picks.length, 10)
  assert.deepEqual(sel.excluded, { stale: 2, promo: 1, celebrity: 1, missing: 0, duplicate: 2 })
  assert.equal(sel.candidates, 12)
  assert.equal(sel.picks[0].id, "trd-13", "the Miami-market post outranks the rest")
  for (const p of sel.picks) {
    assert.ok(p.title && p.url && p.date && p.reasons.length > 0)
    assert.equal(p.source, "The Real Deal")
  }
})

test("ordering is score, then newest, then id", () => {
  const posts: TrdApiPost[] = [
    post({ id: 30, date_gmt: "2026-10-26T12:00:00", sector: [27942] }),
    post({ id: 31, date_gmt: "2026-10-27T12:00:00", sector: [27942] }),
    post({ id: 32, date_gmt: "2026-10-27T12:00:00", sector: [27942] }),
  ]
  const sel = selectTrdTop(posts, { now: NOW })
  assert.deepEqual(
    sel.picks.map((p) => p.id),
    ["trd-32", "trd-31", "trd-30"]
  )
})

test("fixture: ten picks within the week, every one explained, loans and distress above a mansion", () => {
  const sel = selectTrdTop(FIXTURE, { now: NOW })
  assert.equal(sel.picks.length, 10)
  assert.equal(sel.excluded.stale, 0)
  for (const p of sel.picks) {
    assert.ok(p.date >= "2026-10-20" && p.date <= "2026-10-27", p.date)
    assert.ok(p.reasons.length >= 2, p.title)
    assert.ok(p.snippet.length > 0, `standfirst missing on ${p.title}`)
    assert.ok(!/<|&#|&amp;/.test(p.title + p.snippet), "no markup leaks into the panel")
  }
  const ids = sel.picks.map((p) => p.id)
  assert.ok(ids.includes("trd-1060123"), "the $463M St. Regis loan is a top-ten story")
  assert.ok(!ids.includes("trd-1059931"), "the Jupiter mansion is not")
  assert.equal(sel.picks.length, 10)
  assert.ok(sel.candidates >= 10)
  const byId = new Map(sel.picks.map((p) => [p.id, p]))
  const loan = byId.get("trd-1060123")!
  assert.equal(loan.topic, "Debt/Financing")
  assert.equal(loan.region, "miami")
  assert.ok(sel.picks.every((p, i) => i === 0 || sel.picks[i - 1].score >= p.score), "sorted by score")
})

test("articleBlocks keeps the article's text and drops cards, images, embeds and scripts", () => {
  const html = `
    <p>The developers scored a <a href="/x">nine-figure</a> loan.</p>
    <div class="related"><article><figure><img src="a.jpg"></figure><h4>Read more</h4><p>Dream Hotel to anchor project</p></article></div>
    <h2>Terms</h2>
    <p>Centennial Bank lent &#36;145 million &amp; more.</p>
    <blockquote><p>“We are thrilled,” he said.</p></blockquote>
    <ul><li>Item one</li><li>Item two</li></ul>
    <section><p>Sign up for our newsletter</p></section>
    <iframe src="https://example.com/embed"></iframe>
    <script>track()</script>
    <figure><img src="b.jpg"><figcaption>A caption</figcaption></figure>
  `
  assert.deepEqual(articleBlocks(html), [
    { kind: "p", text: "The developers scored a nine-figure loan." },
    { kind: "h", text: "Terms" },
    { kind: "p", text: "Centennial Bank lent $145 million & more." },
    { kind: "quote", text: "“We are thrilled,” he said." },
    { kind: "li", text: "Item one" },
    { kind: "li", text: "Item two" },
  ])
})

test("buildTrdArticleView: title, dates, word count; null without a body", () => {
  const view = buildTrdArticleView(
    post({
      id: 40,
      title: { rendered: "Loan &#8216;closes&#8217;" },
      modified_gmt: "2026-10-28T09:00:00",
      content: { rendered: "<p>One two three.</p><p>Four five.</p>" },
    })
  )
  assert.ok(view)
  assert.equal(view.title, "Loan ‘closes’")
  assert.equal(view.date, "2026-10-27")
  assert.equal(view.modified, "2026-10-28")
  assert.equal(view.wordCount, 5)
  assert.equal(view.blocks.length, 2)
  assert.equal(buildTrdArticleView(post({ id: 41 })), null)
})

test("fixture: every post's body reads as paragraphs with no markup and no card text", () => {
  for (const p of FIXTURE) {
    const view = buildTrdArticleView(p)
    assert.ok(view, `no view for ${p.id}`)
    assert.ok(view.blocks.length >= 1 && view.wordCount >= 20, `${p.id}: ${view.blocks.length} blocks, ${view.wordCount} words`)
    for (const b of view.blocks) {
      assert.ok(!/<|&#|&amp;|&nbsp;/.test(b.text), `${p.id}: markup in "${b.text.slice(0, 60)}"`)
      assert.notEqual(b.text, "Read more")
    }
  }
})

test("query helpers: the window has a day of slack and the URL names every field", () => {
  assert.equal(trdSinceParam(NOW, 7), "2026-10-19T18:00:00")
  const url = new URL(trdQueryUrl({ market: 9574 }, "2026-10-19T18:00:00"))
  assert.equal(url.searchParams.get("market"), "9574")
  assert.equal(url.searchParams.get("after"), "2026-10-19T18:00:00")
  assert.equal(url.searchParams.get("per_page"), "100")
  assert.equal(url.searchParams.get("_fields"), "id,date_gmt,modified_gmt,link,title,excerpt,content,market,sector,story_type")
})
