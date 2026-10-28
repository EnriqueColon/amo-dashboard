/**
 * The Real Deal as a subscriber source for the News tab: the pure half.
 *
 * TRD is a WordPress site whose public REST API (`/wp-json/wp/v2/posts`) returns every post with
 * its full body, its market, sector and story-type terms, and an editorial standfirst (the
 * `excerpt`). Nothing on a post marks it subscriber-only; the metered paywall is applied in the
 * reader's browser. So the tool reads the API and never logs in — the firm's subscriptions matter
 * when a user opens the link, not here. The fetch lives in `app/services/trd.ts`; this file turns
 * API posts into ranked picks and is the only place the ranking rules exist.
 *
 * Every pick carries the rules that scored it (`reasons`), so the panel can say why an article is
 * at the top rather than asking the reader to trust a number. The score is deterministic over the
 * post's own fields; no model is involved.
 *
 * Taxonomy ids below were read from `/wp-json/wp/v2/{market,sector,story_type}` on 2026-10-27.
 * They are WordPress term ids and do not change, but a term can be added; an unknown id is kept as
 * `market:<id>` rather than dropped, so it is visible in the verify output.
 */

export const TRD_API_URL = "https://therealdeal.com/wp-json/wp/v2/posts"
export const TRD_SOURCE_NAME = "The Real Deal"

export const TRD_TERMS = {
  market: {
    9574: "miami",
    9571: "national",
    9572: "new-york",
    9579: "tristate",
    9570: "la",
    9569: "chicago",
    9573: "san-francisco",
    9575: "texas",
    9577: "dallas",
    9578: "houston",
    9576: "austin",
    26031: "hamptons",
    40372: "tampa",
    40373: "orlando",
  },
  sector: {
    27942: "commercial",
    26534: "residential",
    9610: "development",
    9606: "politics",
    66438: "finance",
    60795: "retail",
    101314: "multifamily",
    64005: "office",
    62182: "affordable-housing",
    71487: "hospitality",
    10073: "tech",
  },
  storyType: {
    26772: "news",
    26770: "blurb",
    26773: "reports",
    26774: "features",
    60739: "data",
    26776: "magazine-feature",
    54509: "column",
    26777: "promo",
    26775: "magazine-ranking",
    53253: "commercial-real-estate",
    58007: "weekend-wrapup",
    53445: "breaking-news",
    53252: "celebrity-real-estate",
  },
} as const

/** The two queries the service runs, named so the verify script and the notes can cite them. */
export const TRD_QUERIES = [
  { name: "Miami market", params: { market: 9574 } },
  { name: "Commercial sector", params: { sector: 27942 } },
] as const

/** The shape of a post as `_fields=` trims it. `content` is optional: the fixture and a cheap fetch omit it. */
export type TrdApiPost = {
  id: number
  date_gmt: string
  modified_gmt?: string
  link: string
  title: { rendered: string }
  excerpt: { rendered: string }
  content?: { rendered: string }
  market?: number[]
  sector?: number[]
  story_type?: number[]
}

export type TrdArticle = {
  id: number
  title: string
  url: string
  /** YYYY-MM-DD, the UTC date of `date_gmt`. */
  date: string
  publishedAt: string
  excerpt: string
  /** Plain body text, capped at `TEXT_CAP` characters; used for scoring only and never stored. */
  text: string
  markets: string[]
  sectors: string[]
  storyTypes: string[]
}

export type NewsTopic =
  | "Foreclosure/Distress"
  | "Debt/Financing"
  | "Development/Construction"
  | "Commercial Real Estate"
  | "Waterfront/Residential"
  | "General Real Estate"

export type NewsRegion = "national" | "florida" | "miami"

export type TrdPick = {
  id: string
  source: typeof TRD_SOURCE_NAME
  title: string
  url: string
  date: string
  snippet: string
  topic: NewsTopic
  region: NewsRegion
  score: number
  /** The rules that produced the score, in the order applied. */
  reasons: string[]
  storyType: string
  sectors: string[]
  markets: string[]
}

export type TrdSelection = {
  picks: TrdPick[]
  /** Posts that survived the age and story-type gates and were scored. */
  candidates: number
  excluded: { stale: number; promo: number; celebrity: number; missing: number; duplicate: number }
}

const TEXT_CAP = 3_000
/** Ten, at the user's request on 2026-10-27; it was five at first. */
const DEFAULT_LIMIT = 10
const DEFAULT_MAX_AGE_DAYS = 7

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
}

export function decodeEntities(input: string): string {
  return (input || "")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const code = parseInt(h, 16)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

export function stripHtml(html: string): string {
  const withoutBlocks = (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
  const text = withoutBlocks.replace(/<\/(p|div|li|h[1-6]|br)>/gi, " ").replace(/<[^>]*>/g, " ")
  return decodeEntities(text).replace(/\s+/g, " ").trim()
}

function termSlugs(ids: number[] | undefined, table: Record<number, string>, kind: string): string[] {
  return (ids || []).map((id) => table[id] ?? `${kind}:${id}`)
}

function toIsoDate(dateGmt: string): { date: string; publishedAt: string } | null {
  const raw = (dateGmt || "").trim()
  if (!raw) return null
  const iso = /z$|[+-]\d{2}:\d{2}$/i.test(raw) ? raw : `${raw}Z`
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  return { date: d.toISOString().slice(0, 10), publishedAt: d.toISOString() }
}

/** An API post as the scorer reads it, or null when a field the panel needs is missing. */
export function normalizeTrdPost(post: TrdApiPost): TrdArticle | null {
  const title = stripHtml(post?.title?.rendered || "")
  const url = (post?.link || "").trim()
  const when = toIsoDate(post?.date_gmt || "")
  if (!title || !url || !when || !Number.isFinite(post?.id)) return null
  // TRD closes every standfirst with a "[…]" or "…" continuation; the panel shows it as a sentence.
  const excerpt = stripHtml(post.excerpt?.rendered || "").replace(/\s*(\[…\]|\[\.\.\.\]|…)\s*$/u, "").trim()
  const text = stripHtml(post.content?.rendered || "").slice(0, TEXT_CAP)
  return {
    id: post.id,
    title,
    url,
    date: when.date,
    publishedAt: when.publishedAt,
    excerpt,
    text,
    markets: termSlugs(post.market, TRD_TERMS.market, "market"),
    sectors: termSlugs(post.sector, TRD_TERMS.sector, "sector"),
    storyTypes: termSlugs(post.story_type, TRD_TERMS.storyType, "story_type"),
  }
}

// --- Ranking ---------------------------------------------------------------------------------
//
// The topic rules are the ones Industry-Specific News applies to feed items (`tagTopic` in
// `fetch-public-mentions.ts`) with one change of order: distress is tested before residential, so
// a condo foreclosure reads as distress rather than as a residential story. They are applied to
// the headline and standfirst, which are editorial; the body is only consulted for a distress
// term the headline omits, because a 3,000-character body mentions "office" and "loan" too often
// for a word match to mean anything.

type TopicMatch = { topic: NewsTopic; base: number; term: string | null }

const TOPIC_RULES: Array<{ topic: NewsTopic; base: number; re: RegExp }> = [
  {
    topic: "Foreclosure/Distress",
    base: 6,
    re: /\bcmbs\b|special servicing|delinquen\w*|\bdefault\w*|bankrupt\w*|note sale|loan sale|receivership|receiver\b|foreclos\w*|distress\w*|workout|restructur\w*|nonaccrual|lis pendens|deed in lieu|short sale|wiped out/,
  },
  {
    topic: "Debt/Financing",
    base: 4,
    re: /\bloans?\b|financ\w*|refinanc\w*|mortgage|lender|private credit|debt fund|credit fund|bridge loan|mezzanine|maturity|extension|recap\w*/,
  },
  {
    topic: "Development/Construction",
    base: 3,
    re: /development|developer|construction|groundbreaking|permit|entitlement|rezoning|tower|project/,
  },
  {
    topic: "Commercial Real Estate",
    base: 2,
    re: /\boffice\b|retail|industrial|multifamily|warehouse|commercial|\bcre\b|apartments?\b|hotel|mall/,
  },
  {
    topic: "Waterfront/Residential",
    base: 1,
    re: /waterfront|coastal|beachfront|oceanfront|intracoastal|marina|condo|\bhomes?\b|residential|luxury|single-family|mansion|estate\b|penthouse/,
  },
]

const DISTRESS_RE = TOPIC_RULES[0].re

export function topicOf(headline: string): TopicMatch {
  const t = (headline || "").toLowerCase()
  for (const rule of TOPIC_RULES) {
    const m = rule.re.exec(t)
    if (m) return { topic: rule.topic, base: rule.base, term: m[0] }
  }
  return { topic: "General Real Estate", base: 0, term: null }
}

const MIAMI_RE = /miami|miami-dade|brickell|doral|wynwood|miami beach|fort lauderdale|broward|sunny isles|coral gables|aventura|hialeah|coconut grove|hollywood, fl|pompano/
const FLORIDA_RE = /florida|tampa|orlando|jacksonville|palm beach|west palm|boca raton|jupiter|naples|sarasota|st\. petersburg/

export function regionOf(article: Pick<TrdArticle, "title" | "excerpt" | "markets">): NewsRegion {
  const t = `${article.title} ${article.excerpt}`.toLowerCase()
  if (MIAMI_RE.test(t)) return "miami"
  if (FLORIDA_RE.test(t)) return "florida"
  // TRD's "Miami" market is its South Florida desk; a Palm Beach story carries it without naming Miami.
  if (article.markets.includes("miami")) return "florida"
  return "national"
}

export type TrdScore = { score: number; reasons: string[]; topic: NewsTopic; region: NewsRegion }

export function scoreTrdArticle(article: TrdArticle): TrdScore {
  const reasons: string[] = []
  let score = 0

  const head = `${article.title} ${article.excerpt}`
  const topic = topicOf(head)
  score += topic.base
  reasons.push(
    topic.term
      ? `${topic.topic} (+${topic.base}): "${topic.term}" in the headline or standfirst`
      : "General Real Estate (+0): no topic term in the headline or standfirst"
  )

  if (topic.topic !== "Foreclosure/Distress" && article.text) {
    const m = DISTRESS_RE.exec(article.text.toLowerCase())
    if (m) {
      score += 2
      reasons.push(`Distress term in the body (+2): "${m[0]}"`)
    }
  }

  const hasCommercial = article.sectors.includes("commercial")
  const hasFinance = article.sectors.includes("finance")
  const hasDevelopment = article.sectors.includes("development")
  if (hasCommercial) {
    score += 2
    reasons.push("Commercial sector (+2)")
  }
  if (hasFinance) {
    score += 2
    reasons.push("Finance sector (+2)")
  }
  if (hasDevelopment) {
    score += 1
    reasons.push("Development sector (+1)")
  }
  if (article.sectors.includes("residential") && !hasCommercial && !hasFinance && !hasDevelopment) {
    score -= 2
    reasons.push("Residential sector only (−2)")
  }

  if (article.markets.includes("miami")) {
    score += 3
    reasons.push("Miami market (+3): TRD's South Florida desk")
  } else if (article.markets.includes("national")) {
    score += 1
    reasons.push("National market (+1)")
  }

  const original = article.storyTypes.some((s) => s === "news" || s === "breaking-news" || s === "data" || s === "reports")
  if (original) {
    score += 1
    reasons.push("Original reporting (+1)")
  } else if (article.storyTypes.includes("blurb")) {
    reasons.push("Blurb (+0): a re-report of another outlet's story")
  }

  return { score, reasons, topic: topic.topic, region: regionOf(article) }
}

function isStale(article: TrdArticle, now: Date, maxAgeDays: number): boolean {
  const ms = Date.parse(article.publishedAt)
  if (Number.isNaN(ms)) return true
  if (ms > now.getTime() + 60 * 60 * 1000) return true
  return now.getTime() - ms > maxAgeDays * 86_400_000
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/**
 * Rank the posts the two queries returned and keep the top `limit`. Deterministic: score, then
 * newest, then id. A post seen under both queries counts once.
 */
export function selectTrdTop(
  posts: TrdApiPost[],
  opts: { now: Date; limit?: number; maxAgeDays?: number }
): TrdSelection {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const excluded = { stale: 0, promo: 0, celebrity: 0, missing: 0, duplicate: 0 }
  const seenIds = new Set<number>()
  const seenUrls = new Set<string>()
  const scored: Array<{ article: TrdArticle; result: TrdScore }> = []

  for (const post of posts) {
    const article = normalizeTrdPost(post)
    if (!article) {
      excluded.missing += 1
      continue
    }
    const urlKey = canonicalUrl(article.url)
    if (seenIds.has(article.id) || seenUrls.has(urlKey)) {
      excluded.duplicate += 1
      continue
    }
    seenIds.add(article.id)
    seenUrls.add(urlKey)
    if (isStale(article, opts.now, maxAgeDays)) {
      excluded.stale += 1
      continue
    }
    if (article.storyTypes.includes("promo")) {
      excluded.promo += 1
      continue
    }
    if (article.storyTypes.includes("celebrity-real-estate")) {
      excluded.celebrity += 1
      continue
    }
    scored.push({ article, result: scoreTrdArticle(article) })
  }

  scored.sort((a, b) => {
    if (b.result.score !== a.result.score) return b.result.score - a.result.score
    const byDate = b.article.publishedAt.localeCompare(a.article.publishedAt)
    if (byDate !== 0) return byDate
    return b.article.id - a.article.id
  })

  const picks: TrdPick[] = scored.slice(0, limit).map(({ article, result }) => ({
    id: `trd-${article.id}`,
    source: TRD_SOURCE_NAME,
    title: article.title,
    url: article.url,
    date: article.date,
    snippet: article.excerpt,
    topic: result.topic,
    region: result.region,
    score: result.score,
    reasons: result.reasons,
    storyType: article.storyTypes[0] ?? "unknown",
    sectors: article.sectors,
    markets: article.markets,
  }))

  return { picks, candidates: scored.length, excluded }
}

// --- The Read view -----------------------------------------------------------------------------
//
// A post's `content.rendered` is WordPress HTML: the article's paragraphs and sub-headings, with
// "related story" cards (`<article>`/`<figure>`/`<section>` blocks carrying an image, a headline and
// a "Read more" h4) and the occasional embed spliced between them. The Read view shows the
// article's own text and nothing else: cards, images, embeds and scripts are removed whole, and
// what remains is split into paragraphs, headings, quotes and list items with inline markup
// reduced to text. Links inside paragraphs are dropped with their text kept, so a sentence that
// cites an earlier story still reads.

export type ArticleBlock = { kind: "p" | "h" | "quote" | "li"; text: string }

export type TrdArticleView = {
  id: number
  title: string
  url: string
  date: string
  modified: string | null
  blocks: ArticleBlock[]
  wordCount: number
}

const REMOVED_BLOCKS = /<(article|figure|section|aside|script|style|iframe|noscript|svg|form|nav|footer|header)\b[\s\S]*?<\/\1>/gi

export function articleBlocks(html: string): ArticleBlock[] {
  let h = html || ""
  // Nested cards: repeat until nothing more is removed.
  for (let i = 0; i < 5; i += 1) {
    const next = h.replace(REMOVED_BLOCKS, " ")
    if (next === h) break
    h = next
  }
  h = h.replace(/<img\b[^>]*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
  const blocks: ArticleBlock[] = []
  const re = /<(p|h[1-6]|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(h)) !== null) {
    const tag = m[1].toLowerCase()
    const inner = m[2]
    // A blockquote holds its own paragraphs; take them as one quote.
    const text = stripHtml(inner)
    if (!text) continue
    const kind: ArticleBlock["kind"] = tag === "p" ? "p" : tag === "li" ? "li" : tag === "blockquote" ? "quote" : "h"
    blocks.push({ kind, text })
  }
  // A blockquote's inner <p>s also match on their own; drop a paragraph that repeats the quote.
  const quotes = new Set(blocks.filter((b) => b.kind === "quote").map((b) => b.text))
  return blocks.filter((b, i) => !(b.kind === "p" && quotes.has(b.text) && blocks.findIndex((q) => q.kind === "quote" && q.text === b.text) !== i))
}

/** The Read view of one post, or null when the API gave no usable body. */
export function buildTrdArticleView(post: TrdApiPost): TrdArticleView | null {
  const article = normalizeTrdPost(post)
  if (!article) return null
  const blocks = articleBlocks(post.content?.rendered || "")
  if (blocks.length === 0) return null
  const modified = post.modified_gmt ? toIsoDate(post.modified_gmt)?.date ?? null : null
  const wordCount = blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0)
  return { id: article.id, title: article.title, url: article.url, date: article.date, modified, blocks, wordCount }
}

export function trdPostUrl(id: number): string {
  const u = new URL(`${TRD_API_URL}/${id}`)
  u.searchParams.set("_fields", "id,date_gmt,modified_gmt,link,title,excerpt,content,market,sector,story_type")
  return u.toString()
}

/** The `after=` value for the API: ISO 8601 without the zone, which WordPress reads as site time (ET for TRD). */
export function trdSinceParam(now: Date, maxAgeDays = DEFAULT_MAX_AGE_DAYS): string {
  // One extra day so the site-time reading of a UTC instant cannot drop the oldest qualifying post;
  // `selectTrdTop` applies the exact window.
  const since = new Date(now.getTime() - (maxAgeDays + 1) * 86_400_000)
  return since.toISOString().slice(0, 19)
}

export function trdQueryUrl(params: Record<string, number>, since: string, perPage = 100): string {
  const u = new URL(TRD_API_URL)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  u.searchParams.set("after", since)
  u.searchParams.set("per_page", String(perPage))
  u.searchParams.set("orderby", "date")
  u.searchParams.set("order", "desc")
  u.searchParams.set("_fields", "id,date_gmt,modified_gmt,link,title,excerpt,content,market,sector,story_type")
  return u.toString()
}
