/**
 * Market Research — check every report link before it is saved.
 *
 * The daily feed gets its reports from an OpenAI web search, and the model
 * sometimes writes a plausible link from the title instead of the real one
 * (16 Nov 2026: Trepp's "$4.42 Billion of Private-Label CMBS Debt Reaches Hard
 * Maturity in November" was saved as /trepptalk/refinancing/4-42-billion-…,
 * a 404; the article is /trepptalk/cmbs-hard-maturities-november-2026).
 *
 * For each link:
 *   - opens (2xx, not a "page not found" page)  -> kept            ("ok")
 *   - dead (404/410, soft 404, bad URL)          -> look it up in the
 *     publisher's sitemap; a candidate is accepted only when the page's own
 *     title matches the report title                -> replaced     ("fixed")
 *     otherwise the link is removed and the title shows without one ("dropped")
 *   - the site refuses automated checks (403/429/5xx/timeout) -> kept as is
 *     ("unverified"): we cannot tell, and these usually open in a browser.
 */

export type LinkStatus = "ok" | "fixed" | "dropped" | "unverified"
export type LinkResult = { status: LinkStatus; url: string; was: string; httpStatus: number | null }

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
const PAGE_TIMEOUT_MS = 12_000
const SITEMAP_TIMEOUT_MS = 20_000
const MAX_CHILD_SITEMAPS = 15
const MAX_CANDIDATES = 5
const TITLE_MATCH = 0.75

// ── text matching (pure; covered by link-check.test.ts) ──────────────────────

const STOP = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "by", "with", "at", "from", "as", "is", "are", "its", "it", "vs",
  "www", "com", "html", "htm", "php", "aspx",
])

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y"
  if (t.length > 4 && t.endsWith("es") && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1)
  return t
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem)
}

/** Words of a URL's last path segment(s), e.g. /trepptalk/cmbs-hard-maturities-november-2026 -> cmbs hard maturity november 2026 */
export function slugTokens(url: string): string[] {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean)
    const last = segs[segs.length - 1] ?? ""
    return tokens(decodeURIComponent(last).replace(/\.[a-z]{2,5}$/i, ""))
  } catch {
    return []
  }
}

/** How well a sitemap URL's slug fits a report title: share of slug words found in the title, plus the overlap count. */
export function slugScore(title: string, url: string): { coverage: number; overlap: number } {
  const slug = slugTokens(url)
  if (slug.length === 0) return { coverage: 0, overlap: 0 }
  const t = new Set(tokens(title))
  const overlap = new Set(slug.filter((w) => t.has(w))).size
  return { coverage: overlap / new Set(slug).size, overlap }
}

/** Dice similarity of two titles' word sets (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** Best match of a report title against a page title, trying the parts around " | " / " - " (site-name suffixes). */
export function pageTitleMatches(reportTitle: string, pageTitle: string): number {
  const parts = [pageTitle, ...pageTitle.split(/\s+[|\-–—:]\s+/)]
  return Math.max(...parts.map((p) => titleSimilarity(reportTitle, p)))
}

export function rankCandidates(title: string, urls: string[], limit = MAX_CANDIDATES): string[] {
  return urls
    .map((u) => ({ u, ...slugScore(title, u) }))
    .filter((c) => c.overlap >= 2 && c.coverage >= 0.5)
    .sort((a, b) => b.coverage - a.coverage || b.overlap - a.overlap)
    .slice(0, limit)
    .map((c) => c.u)
}

export function extractPageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return decodeEntities((og?.[1] ?? t?.[1] ?? "").trim())
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
}

export function looksLikeNotFound(pageTitle: string): boolean {
  return /\b(404|page not found|not found|page (is )?missing|no longer available)\b/i.test(pageTitle)
}

export function parseSitemap(xml: string): { locs: string[]; isIndex: boolean } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]))
  return { locs, isIndex: /<sitemapindex[\s>]/i.test(xml) }
}

// ── network ──────────────────────────────────────────────────────────────────

type Probe = { status: number | null; finalUrl: string; html: string }

async function get(url: string, timeoutMs: number, maxBytes: number): Promise<Probe> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    let html = ""
    if (res.body && res.ok) {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let n = 0
      while (n < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        n += value.byteLength
        html += dec.decode(value, { stream: true })
      }
      reader.cancel().catch(() => {})
    } else {
      res.body?.cancel().catch(() => {})
    }
    return { status: res.status, finalUrl: res.url || url, html }
  } catch {
    return { status: null, finalUrl: url, html: "" }
  }
}

type Verdict = "ok" | "dead" | "unknown"

function judge(original: string, p: Probe): Verdict {
  if (p.status === 404 || p.status === 410) return "dead"
  if (p.status == null || p.status < 200 || p.status >= 300) return "unknown"
  if (looksLikeNotFound(extractPageTitle(p.html))) return "dead"
  // Redirected to the site's home page = the article is gone.
  try {
    const from = new URL(original).pathname.replace(/\/+$/, "")
    const to = new URL(p.finalUrl).pathname.replace(/\/+$/, "")
    if (from && !to) return "dead"
  } catch {
    /* ignore */
  }
  return "ok"
}

/** Per-sweep cache of each site's sitemap URLs. */
export type SitemapCache = Map<string, Promise<string[]>>

async function sitemapUrls(origin: string, cache: SitemapCache): Promise<string[]> {
  let p = cache.get(origin)
  if (!p) {
    p = loadSitemap(origin)
    cache.set(origin, p)
  }
  return p
}

async function loadSitemap(origin: string): Promise<string[]> {
  const roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]
  const robots = await get(`${origin}/robots.txt`, SITEMAP_TIMEOUT_MS, 200_000)
  for (const m of robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.unshift(m[1])

  for (const root of [...new Set(roots)]) {
    const top = await get(root, SITEMAP_TIMEOUT_MS, 30_000_000)
    if (!top.html) continue
    const parsed = parseSitemap(top.html)
    if (!parsed.isIndex) {
      if (parsed.locs.length) return parsed.locs
      continue
    }
    // Sitemap index: prefer article-like children, newest-looking last in the file first.
    const children = [...parsed.locs]
      .sort((a, b) => Number(/post|blog|article|insight|research|news|talk|report/i.test(b)) - Number(/post|blog|article|insight|research|news|talk|report/i.test(a)))
      .slice(0, MAX_CHILD_SITEMAPS)
    const out: string[] = []
    for (const c of children) {
      const child = await get(c, SITEMAP_TIMEOUT_MS, 30_000_000)
      out.push(...parseSitemap(child.html).locs.filter((u) => !/\.xml(\.gz)?$/i.test(u)))
    }
    if (out.length) return out
  }
  return []
}

async function lookUp(title: string, origin: string, cache: SitemapCache): Promise<string | null> {
  const urls = await sitemapUrls(origin, cache)
  for (const cand of rankCandidates(title, urls)) {
    const p = await get(cand, PAGE_TIMEOUT_MS, 400_000)
    if (judge(cand, p) !== "ok") continue
    if (pageTitleMatches(title, extractPageTitle(p.html)) >= TITLE_MATCH) return p.finalUrl || cand
  }
  return null
}

function originOf(url: string, fallbackSite?: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin
  } catch {
    /* fall through */
  }
  if (!fallbackSite) return null
  const host = fallbackSite.replace(/^https?:\/\//, "").split("/")[0]
  return `https://${host.startsWith("www.") ? host : `www.${host}`}`
}

/** Check one report link; see the header comment for the outcomes. */
export async function checkReportLink(title: string, url: string, site: string | undefined, cache: SitemapCache): Promise<LinkResult> {
  const was = url
  let valid = false
  try {
    const u = new URL(url)
    valid = u.protocol === "http:" || u.protocol === "https:"
  } catch {
    valid = false
  }
  let httpStatus: number | null = null
  if (valid) {
    const p = await get(url, PAGE_TIMEOUT_MS, 400_000)
    httpStatus = p.status
    const v = judge(url, p)
    if (v === "ok") return { status: "ok", url, was, httpStatus }
    if (v === "unknown") return { status: "unverified", url, was, httpStatus }
  }
  const origin = originOf(url, site)
  const found = origin ? await lookUp(title, origin, cache) : null
  if (found) return { status: "fixed", url: found, was, httpStatus }
  return { status: "dropped", url: "", was, httpStatus }
}

/** Check many links, a few at a time. */
export async function checkReportLinks<T extends { title: string; url: string; publisher: string }>(
  reports: T[],
  siteFor: (publisher: string) => string | undefined,
  concurrency = 5,
): Promise<Array<{ report: T; result: LinkResult }>> {
  const cache: SitemapCache = new Map()
  const out: Array<{ report: T; result: LinkResult }> = new Array(reports.length)
  let i = 0
  const worker = async () => {
    while (i < reports.length) {
      const k = i++
      const r = reports[k]
      // A report with no link at all still gets a sitemap lookup on its publisher's site.
      out[k] = { report: r, result: await checkReportLink(r.title, r.url ?? "", siteFor(r.publisher), cache) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, reports.length) }, worker))
  return out
}

export function summarize(results: Array<{ result: LinkResult }>): Record<LinkStatus, number> {
  const s: Record<LinkStatus, number> = { ok: 0, fixed: 0, dropped: 0, unverified: 0 }
  for (const { result } of results) s[result.status]++
  return s
}
