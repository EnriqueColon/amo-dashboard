import { test } from "node:test"
import assert from "node:assert/strict"
import { extractPageTitle, looksLikeNotFound, pageTitleMatches, parseSitemap, rankCandidates, slugTokens } from "./link-check"

const TITLE = "$4.42 Billion of Private-Label CMBS Debt Reaches Hard Maturity in November"

test("slug words are stemmed so 'maturities' meets 'Maturity'", () => {
  assert.deepEqual(slugTokens("https://www.trepp.com/trepptalk/cmbs-hard-maturities-november-2026"), ["cmb", "hard", "maturity", "november", "2026"])
})

test("the real Trepp article ranks first among other months' articles (16 Nov 2026 case)", () => {
  const urls = [
    "https://www.trepp.com/trepptalk/cmbs-hard-maturities-november-2026",
    "https://www.trepp.com/trepptalk/october-2026-cmbs-hard-maturities-refinancing-risk",
    "https://www.trepp.com/trepptalk/september-2026-cmbs-hard-maturities",
    "https://www.trepp.com/trepptalk/q2-bank-earnings-increase-but-concerns-still-loom",
    "https://www.trepp.com/about-us",
  ]
  const ranked = rankCandidates(TITLE, urls)
  assert.equal(ranked[0], urls[0])
  assert.ok(!ranked.includes(urls[3]) && !ranked.includes(urls[4]))
})

test("a candidate is accepted on its page title, not on the slug", () => {
  assert.ok(pageTitleMatches(TITLE, "$4.42 Billion of Private-Label CMBS Debt Reaches Hard Maturity in November") >= 0.75)
  assert.ok(pageTitleMatches(TITLE, "$4.42 Billion of Private-Label CMBS Debt Reaches Hard Maturity in November | Trepp") >= 0.75)
  // Same series, different month: must be rejected.
  assert.ok(pageTitleMatches(TITLE, "$3.10 Billion of Private-Label CMBS Debt Reaches Hard Maturity in October") < 0.75)
})

test("page titles and not-found pages", () => {
  assert.equal(extractPageTitle('<html><head><title>  A &amp; B | Site </title></head>'), "A & B | Site")
  assert.equal(extractPageTitle('<meta property="og:title" content="OG wins"><title>t</title>'), "OG wins")
  assert.ok(looksLikeNotFound("404: Page Not Found"))
  assert.ok(looksLikeNotFound("Page not found | Trepp"))
  assert.ok(!looksLikeNotFound(TITLE))
})

test("sitemap parsing: urlset and index", () => {
  const set = parseSitemap('<urlset><url><loc>https://x.com/a</loc></url><url><loc><![CDATA[https://x.com/b?x=1&amp;y=2]]></loc></url></urlset>')
  assert.deepEqual(set, { locs: ["https://x.com/a", "https://x.com/b?x=1&y=2"], isIndex: false })
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>').isIndex, true)
})

test("product/sales pages are recognised; research and articles are not", async () => {
  const { isProductPage } = await import("./link-check")
  assert.ok(isProductPage("https://www.costar.com/products/market-analytics"))
  assert.ok(isProductPage("https://www.costar.com/products/fund-data"))
  assert.ok(isProductPage("https://www.example.com/en/solutions/data"))
  assert.ok(!isProductPage("https://www.costar.com/article/1210761604/commercial-real-estates-price-recovery-splits"))
  assert.ok(!isProductPage("https://www.colliers.com/en/research/nrep-usofc-us-office-market-outlook-report-q3-2026"))
  assert.ok(!isProductPage("https://www.costar.com/sites/costar.com.na/files/2026-02/MarketActivityTrackerQ42025.pdf"))
  assert.ok(!isProductPage("https://www.cbre.com/insights/reports/us-retail-services-capabilities"))
})
