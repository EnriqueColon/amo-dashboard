import type { RetrievedSource } from "./schema"

const RSS_TIMEOUT_MS = 12_000
const URL_RESOLVE_TIMEOUT_MS = 4_000

/**
 * Articles handed to the memo prompt. Costs no extra requests — the feeds are
 * already fetched in full and the surplus was being discarded — and matters
 * because the memo may only quote figures from recognized publishers, so a
 * wider pool is what keeps citable material in front of the model.
 */
const MAX_SOURCES = 10
const PER_REGION_QUOTA = 3

type QuerySpec = {
  region: "national" | "florida" | "miami"
  label: string
  query: string
}

const QUERIES: QuerySpec[] = [
  {
    region: "national",
    label: "US distressed CRE debt",
    query:
      '"commercial real estate" (CMBS OR "special servicing" OR delinquency OR "note sale" OR "loan sale" OR foreclosure OR workout OR receivership) debt',
  },
  {
    region: "florida",
    label: "Florida distressed CRE debt",
    query:
      'Florida ("commercial real estate" OR CRE) (foreclosure OR workout OR "loan sale" OR "note sale" OR "special servicing" OR CMBS OR delinquency)',
  },
  {
    region: "miami",
    label: "Miami distressed CRE debt",
    query:
      '"Miami" OR "Miami-Dade" ("commercial real estate" OR CRE) (foreclosure OR workout OR "loan sale" OR "note sale" OR "special servicing" OR CMBS OR delinquency)',
  },
]

async function fetchWithTimeout(input: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers()
    headers.set("User-Agent", "MarketIntelligence/1.0 (industry-outlook@marketintel.local)")
    headers.set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8")
    headers.set("Accept-Language", "en-US,en;q=0.9")
    return await fetch(input, { headers, signal: controller.signal, cache: "no-store" })
  } finally {
    clearTimeout(id)
  }
}

async function resolveGoogleNewsRedirect(url: string): Promise<string> {
  try {
    const parsed = new URL(url)
    const isGoogleNews =
      parsed.hostname.toLowerCase().includes("news.google.com") &&
      parsed.pathname.includes("/rss/articles/")
    if (!isGoogleNews) return url

    const res = await fetchWithTimeout(url, URL_RESOLVE_TIMEOUT_MS)
    const finalUrl = (res.url || "").trim()
    if (!finalUrl) return url

    try {
      const finalParsed = new URL(finalUrl)
      if (finalParsed.hostname.toLowerCase().includes("news.google.com")) {
        return url
      }
      if (finalUrl.startsWith("http://") || finalUrl.startsWith("https://")) {
        return finalUrl
      }
    } catch {
      return url
    }
    return url
  } catch {
    return url
  }
}

/**
 * CDATA unwrapping is not optional here: Google News wraps every <description>
 * in it, and stripHtml's tag pattern treats "<![CDATA[...]]>" as a single tag
 * and deletes the payload with it. Without this the prompt received headlines
 * with no article content at all.
 */
function extractTag(block: string, tag: string) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  const match = block.match(regex)
  if (!match) return ""
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#039": "'",
  "#34": '"',
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      const key = entity.toLowerCase()
      if (HTML_ENTITIES[key]) return HTML_ENTITIES[key]
      if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16))
      if (/^#\d+$/.test(entity)) return String.fromCodePoint(Number(entity.slice(1)))
      return whole
    })
    .replace(/&amp;/g, "&")
}

function stripHtml(value: string) {
  return decodeHtmlEntities((value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function parseRssItems(xml: string) {
  const out: Array<{ title: string; link: string; dateRaw: string; source: string; description: string }> = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(xml))) {
    const block = m[1]
    out.push({
      // No "Untitled" placeholder: toSource drops an item with no title, which
      // is the right outcome — an untitled article is not usable evidence.
      title: extractTag(block, "title"),
      link: extractTag(block, "link") || "",
      dateRaw: extractTag(block, "pubDate") || extractTag(block, "dc:date") || "",
      source: extractTag(block, "source") || "",
      description: extractTag(block, "description") || "",
    })
  }
  return out
}

function parseAtomItems(xml: string) {
  const out: Array<{ title: string; link: string; dateRaw: string; source: string; summary: string }> = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = entryRegex.exec(xml))) {
    const block = m[1]
    const linkMatch = block.match(/<link[^>]+href="([^"]+)"/i)
    out.push({
      title: extractTag(block, "title"),
      link: linkMatch ? linkMatch[1] : "",
      dateRaw: extractTag(block, "updated") || extractTag(block, "published") || "",
      source: extractTag(block, "source") || "",
      summary: extractTag(block, "summary") || extractTag(block, "content") || "",
    })
  }
  return out
}

function toSource(
  region: RetrievedSource["region"],
  title: string,
  url: string,
  source: string,
  dateRaw: string,
  snippet: string
): RetrievedSource | null {
  const cleanUrl = (url || "").trim()
  if (!cleanUrl || !title) return null
  return {
    title: stripHtml(title),
    url: cleanUrl,
    region,
    publisher: stripHtml(source),
    date: dateRaw || undefined,
    snippet: stripHtml(snippet),
  }
}

function dedupeSources(items: RetrievedSource[]) {
  const seen = new Set<string>()
  const out: RetrievedSource[] = []
  for (const item of items) {
    const key = item.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function googleNewsRssUrl(query: string) {
  return `https://news.google.com/rss/search?${new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" }).toString()}`
}

async function fetchQuery(spec: QuerySpec): Promise<RetrievedSource[]> {
  const url = googleNewsRssUrl(spec.query)
  const res = await fetchWithTimeout(url, RSS_TIMEOUT_MS)
  if (!res.ok) return []
  const xml = await res.text()
  const isAtom = xml.slice(0, 400).toLowerCase().includes("<feed")
  const sources: RetrievedSource[] = []
  if (isAtom) {
    for (const entry of parseAtomItems(xml)) {
      const source = toSource(spec.region, entry.title, entry.link, entry.source, entry.dateRaw, entry.summary)
      if (source) sources.push(source)
    }
  } else {
    for (const item of parseRssItems(xml)) {
      const source = toSource(spec.region, item.title, item.link, item.source, item.dateRaw, item.description)
      if (source) sources.push(source)
    }
  }
  return sources
}

export async function retrieveSources(): Promise<RetrievedSource[]> {
  const results = await Promise.all(QUERIES.map((spec) => fetchQuery(spec)))
  const flat = dedupeSources(results.flat())

  const byRegion = {
    national: flat.filter((x) => x.region === "national"),
    florida: flat.filter((x) => x.region === "florida"),
    miami: flat.filter((x) => x.region === "miami"),
  }

  const picked: RetrievedSource[] = []
  picked.push(...byRegion.national.slice(0, PER_REGION_QUOTA))
  picked.push(...byRegion.florida.slice(0, PER_REGION_QUOTA))
  picked.push(...byRegion.miami.slice(0, PER_REGION_QUOTA))

  const remaining = flat.filter((x) => !picked.includes(x))
  for (const item of remaining) {
    if (picked.length >= MAX_SOURCES) break
    picked.push(item)
  }

  // Skip Google News redirect resolution — it adds up to 4s × N items and
  // regularly pushes the route past Vercel's 60s limit. The redirect URLs
  // still contain the headline, publisher, and snippet needed for the prompt.
  return dedupeSources(picked.slice(0, MAX_SOURCES))
}
