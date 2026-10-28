import assert from "node:assert/strict"
import { test } from "node:test"

import { buildDigestDetailPrompt, fetchPageText, htmlToText } from "./legal-updates-pages.ts"

/** Shape taken from the OCC's September 2026 roundup page, trimmed. */
const OCC_PAGE = `<!doctype html><html><head><title>x</title><style>.a{}</style><script>var y=1</script></head>
<body><nav><a href="/">Home</a> <a href="/news">News</a></nav>
<main>
<p>News Release 2026-79 | September 17, 2026</p>
<h1>OCC Announces Enforcement Actions for September 2026</h1>
<p>WASHINGTON&mdash;The Office of the Comptroller of the Currency (OCC) today released enforcement actions for September 2026.</p>
<ul>
<li>Order of Prohibition against A. Person, former Personal Banker, for U.S. Bank, N.A., Cincinnati, Ohio. (Docket No. AA-ENF-2026-38.)</li>
<li>Order of Prohibition against B. Person, former Branch Banker at PNC Bank, N.A., Wilmington, Delaware. (Docket No. AA-ENF-2026-6.)</li>
</ul>
<p>Media Contact &amp; details</p>
</main>
<footer>Copyright</footer></body></html>`

test("the main region is read and the chrome is not", () => {
  const text = htmlToText(OCC_PAGE)
  assert.match(text, /OCC Announces Enforcement Actions for September 2026/)
  assert.doesNotMatch(text, /Home|Copyright|var y/)
  assert.match(text, /WASHINGTON—The Office/, "entities are decoded")
  assert.match(text, /Media Contact & details/)
})

test("each list item stays on its own line, so actions arrive already counted", () => {
  const lines = htmlToText(OCC_PAGE).split("\n")
  const actions = lines.filter((l) => l.startsWith("Order of Prohibition"))
  assert.equal(actions.length, 2)
})

test("a page with no main or article falls back to the body", () => {
  assert.equal(htmlToText("<html><body><p>Only this.</p></body></html>"), "Only this.")
})

test("a page that is not HTML, or cannot be fetched, yields nothing", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response("%PDF-1.5", { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch
    assert.equal(await fetchPageText("https://example.gov/x.pdf"), undefined)
    globalThis.fetch = (async () => new Response("gone", { status: 404, headers: { "content-type": "text/html" } })) as typeof fetch
    assert.equal(await fetchPageText("https://example.gov/missing"), undefined)
    globalThis.fetch = (async () => { throw new Error("network") }) as typeof fetch
    assert.equal(await fetchPageText("https://example.gov/down"), undefined)
    globalThis.fetch = (async () => new Response(OCC_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch
    assert.match((await fetchPageText("https://www.occ.gov/x.html")) ?? "", /Enforcement Actions for September 2026/)
  } finally {
    globalThis.fetch = original
  }
})

test("a long page is cut at the cap, visibly", async () => {
  const original = globalThis.fetch
  try {
    const long = `<main><p>${"word ".repeat(500)}</p></main>`
    globalThis.fetch = (async () => new Response(long, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch
    const text = (await fetchPageText("https://example.gov/long", 1000, 50)) ?? ""
    assert.ok(text.endsWith("[…]"))
    assert.ok(text.split(/\s+/).length <= 52)
  } finally {
    globalThis.fetch = original
  }
})

test("the digest prompt is keyed by item id and forbids naming individuals", () => {
  const prompt = buildDigestDetailPrompt([
    { key: "enforcement-0-occ-enforcement", title: "OCC Enforcement Actions for September 2026", date: "2026-09-17", text: "Order of Prohibition against…" },
  ])
  assert.match(prompt, /enforcement-0-occ-enforcement/)
  assert.match(prompt, /Never name an individual/)
  assert.match(prompt, /do not add anything you know or believe about these institutions from elsewhere/)
  // The FDIC's releases give counts without names; the prompt must not invite guessing.
  assert.match(prompt, /do not guess at names/)
  assert.doesNotMatch(prompt, /\bsearch\b/i)
})
