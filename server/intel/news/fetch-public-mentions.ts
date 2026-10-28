import { unstable_cache } from "../cache-shim"
import { classifyArticleAccess, KNOWN_PAYWALL_DOMAINS, type AccessStatus } from "./news-access"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"

export type PublicMentionItem = {
  id: string
  title: string
  source?: string
  date?: string
  url?: string
  snippet?: string
  categories?: string[]
  region: "national" | "florida" | "miami"
  topic: string
  access_status: AccessStatus
  resolved_url?: string
  detection_reason?: string
  feedName?: string
  feedUrl?: string
  undated?: boolean
}

export type PublicMentionsResponse = {
  news: PublicMentionItem[]
  notes: string[]
}

const MAX_AGE_DAYS = 7
const RSS_TIMEOUT_MS = 12_000
const GDELT_TIMEOUT_MS = 12_000
const MAX_ITEMS = 20
const CLASSIFY_LIMIT = 30
const CLASSIFY_CONCURRENCY = 4
const GDELT_ENABLE_IF_FEEDS_LT = 15
const GDELT_MAX_INCLUDE = 7
const GDELT_MAX_RECORDS = 200
const UNDATED_CAP = 3

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers((init as any)?.headers || undefined)
    if (!headers.has("User-Agent")) headers.set("User-Agent", "MarketIntelligence/1.0 (public-mentions@marketintel.local)")
    if (!headers.has("Accept")) headers.set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8")
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9")
    return await fetch(input, { ...init, headers, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function normalizeDate(date?: string) {
  if (!date) return undefined
  const raw = String(date).trim()
  if (/^\d{14}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  if (/^\d{8}T\d{6}Z$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toISOString().slice(0, 10)
}

function parseDateToMs(dateStr?: string) {
  const raw = (dateStr || "").trim()
  if (!raw) return null
  const s = raw.toLowerCase().trim()

  if (/^\d{14}$/.test(raw)) {
    const yyyy = Number(raw.slice(0, 4))
    const mm = Number(raw.slice(4, 6))
    const dd = Number(raw.slice(6, 8))
    const hh = Number(raw.slice(8, 10))
    const mi = Number(raw.slice(10, 12))
    const ss = Number(raw.slice(12, 14))
    if ([yyyy, mm, dd, hh, mi, ss].every((n) => Number.isFinite(n))) {
      const ms = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss)
      return Number.isNaN(ms) ? null : ms
    }
  }
  if (/^\d{8}$/.test(raw)) {
    const yyyy = Number(raw.slice(0, 4))
    const mm = Number(raw.slice(4, 6))
    const dd = Number(raw.slice(6, 8))
    if ([yyyy, mm, dd].every((n) => Number.isFinite(n))) {
      const ms = Date.UTC(yyyy, mm - 1, dd, 0, 0, 0)
      return Number.isNaN(ms) ? null : ms
    }
  }
  if (/^\d{8}t\d{6}z$/.test(s)) {
    const yyyy = Number(s.slice(0, 4))
    const mm = Number(s.slice(4, 6))
    const dd = Number(s.slice(6, 8))
    const hh = Number(s.slice(9, 11))
    const mi = Number(s.slice(11, 13))
    const ss = Number(s.slice(13, 15))
    if ([yyyy, mm, dd, hh, mi, ss].every((n) => Number.isFinite(n))) {
      const ms = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss)
      return Number.isNaN(ms) ? null : ms
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00Z`)
    return Number.isNaN(ms) ? null : ms
  }
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

function isWithinLastDays(dateStr: string | undefined, days: number) {
  const ms = parseDateToMs(dateStr)
  if (ms === null) return false
  const now = Date.now()
  if (ms > now + 60_000) return false
  return now - ms <= days * 86400000
}

function extractTag(block: string, tag: string) {
  const pattern = `<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`
  const match = block.match(new RegExp(pattern, "i"))
  if (!match) return undefined
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()
}

function extractAllTags(block: string, tag: string) {
  const pattern = `<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`
  const matches = block.match(new RegExp(pattern, "gi")) || []
  return matches
    .map((m) => {
      const inner = m.match(new RegExp(pattern, "i"))
      const value = inner?.[1] ? inner[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : ""
      return value
    })
    .filter(Boolean)
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&(?:apos|rsquo|lsquo);/gi, "'")
    .replace(/&(?:ldquo|rdquo);/gi, "\"")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return ""
      }
    })
    .replace(/&#([0-9]+);/g, (_m, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10))
      } catch {
        return ""
      }
    })
}

function stripHtml(value?: string) {
  if (!value) return undefined
  const decoded = decodeHtmlEntities(value)
  const withoutTags = decoded.replace(/<[^>]*>/g, " ")
  const collapsed = withoutTags.replace(/\s+/g, " ").trim()
  return collapsed || undefined
}

function normalizeTitleForKey(title: string) {
  return (title || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeUrlForKey(url: string) {
  const raw = (url || "").trim()
  if (!raw) return ""
  try {
    const u = new URL(raw)
    u.hash = ""
    const dropPrefixes = ["utm_", "utm-", "fbclid", "gclid", "mc_cid", "mc_eid", "cmpid"]
    const keys = Array.from(u.searchParams.keys())
    for (const k of keys) {
      const lk = k.toLowerCase()
      if (dropPrefixes.some((p) => lk.startsWith(p))) u.searchParams.delete(k)
    }
    u.hostname = u.hostname.replace(/^www\./, "").toLowerCase()
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
    return u.toString()
  } catch {
    return raw
  }
}

function dedupeKey(it: { url?: string; title?: string; source?: string }) {
  const byUrl = normalizeUrlForKey(it.url || "")
  if (byUrl) return `u:${byUrl}`
  const t = normalizeTitleForKey(it.title || "")
  const s = (it.source || "").trim().toLowerCase()
  return `t:${s}:${t}`
}

function hasUsMarkerText(text: string) {
  const t = (text || "").toLowerCase()
  return (
    /\bu\.s\.\b|\bunited states\b|\bamerica\b|\bus\b|\busa\b|\bamerican\b/.test(t) ||
    /\bnew york\b|\bnyc\b|\bchicago\b|\blos angeles\b|\bmiami\b|\bflorida\b|\btexas\b|\bcalifornia\b/.test(t)
  )
}

function hasNonLatinChars(title: string) {
  const s = (title || "").trim()
  if (!s) return false
  return /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F]/u.test(s)
}

function hasForeignCurrency(text: string) {
  const t = (text || "").toLowerCase()
  return /£|€|₽|₩|¥|\bgbp\b|\beur\b|\brub\b|\bkrw\b|\bjpy\b|\bcny\b/.test(t)
}

function hasObviousNonUsGeo(text: string) {
  const t = (text || "").toLowerCase()
  return (
    /\bcanada\b|\bedmonton\b|\balberta\b|\bontario\b|\btoronto\b|\bvancouver\b|\bottawa\b|\bmontreal\b/.test(t) ||
    /\buk\b|\bunited kingdom\b|\bbritain\b|\bbritish\b|\bengland\b|\bscotland\b|\bwales\b|\bnorthern ireland\b|\blondon\b|\bmanchester\b|\bbirmingham\b/.test(
      t
    ) ||
    /\baustralia\b|\bsydney\b|\bmelbourne\b|\bperth\b|\bbrisbane\b/.test(t) ||
    /\bireland\b|\bdublin\b/.test(t) ||
    /\bgermany\b|\bberlin\b|\bfrance\b|\bparis\b|\bitaly\b|\brome\b|\bspain\b|\bmadrid\b/.test(t) ||
    /\bjapan\b|\btokyo\b|\bkorea\b|\bseoul\b|\brussia\b|\bmoscow\b|\bukraine\b|\bkyiv\b|\bchina\b|\bbeijing\b|\bshanghai\b|\bhong kong\b/.test(t)
  )
}

function isLikelyNonUsTldUrl(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase()
    return [".ca", ".au", ".ie", ".nz", ".za", ".in", ".uk"].some((tld) => host.endsWith(tld))
  } catch {
    return false
  }
}

function hasCreKeyword(text: string) {
  const t = (text || "").toLowerCase()
  return (
    /\boffice\b|\bretail\b|\bindustrial\b|\bmultifamily\b|\bwarehouse\b|\bproperty\b|\breal estate\b|\bcre\b|\bcmbs\b|\bcommercial mortgage\b|\bcommercial real estate\b/.test(
      t
    )
  )
}

function hasBroadRealEstateContext(text: string) {
  const t = (text || "").toLowerCase()
  return /real estate|property|development|transaction|sale|listing|deed|financing|loan|refinancing|mortgage|lender|office|retail|industrial|multifamily|apartment|hotel|hospitality|warehouse|condo|home|waterfront|marina|beach|luxury/.test(
    t
  )
}

function strongDistressKeyword(text: string) {
  const t = (text || "").toLowerCase()
  return /\bcmbs\b|special servicing|delinquen|default|bankrupt|note sale|loan sale|receivership|foreclos/.test(t)
}

function marketSignalKeyword(text: string) {
  const t = (text || "").toLowerCase()
  return /refinanc|refi|recap|bridge loan|private credit|debt fund|credit fund|lender|loan\b|maturity|extension|discount|auction|ucc|rescue capital/.test(
    t
  )
}

function categoryHasCreSignal(categories?: string[]) {
  const vals = (categories || []).map((c) => c.toLowerCase())
  return vals.some((c) =>
    /commercial real estate|refinancing|loan|office|retail|multifamily|industrial/.test(c)
  )
}

function hasCreContext(text: string, categories?: string[]) {
  return hasCreKeyword(text) || categoryHasCreSignal(categories)
}

function hasConsumerPersonalContext(text: string) {
  const t = (text || "").toLowerCase()
  if (/gofundme|go fund me|animal rescue|pet rescue|fitness|workout plan|lifestyle|recipe|diet\b/.test(t)) return true
  if (/personal bankruptcy|student loan|credit card|auto loan|car loan|personal loan|payday loan|medical debt|criminal debt\b/.test(t)) return true
  if (/pension|retirement fund|social security\b/.test(t)) return true
  if (/\btaxes?\b/.test(t) && !/property tax|real estate tax|transfer tax|stamp duty\b/.test(t)) return true
  if (/school|university|college|campus|education facility\b/.test(t)) return true
  if (/foreclos/.test(t) && /homeowner|residential|single-family|family home|mortgage help|eviction\b/.test(t)) return true
  return false
}

function isEntertainmentGossip(text: string) {
  const t = (text || "").toLowerCase()
  if (!/movie|box office|oscar|grammy|celebrity|hollywood|tv show|film|streaming|music chart/.test(t)) return false
  return !hasBroadRealEstateContext(t)
}

function passesHardPreFilter(
  level: "national" | "florida" | "miami",
  item: { title?: string; summary?: string; source?: string; url?: string; feedName?: string; feedUrl?: string; categories?: string[] },
  origin: "rss" | "gdelt"
) {
  const title = (item.title || "").trim()
  const summary = (item.summary || "").trim()
  const source = (item.source || "").trim()
  const url = (item.url || "").trim()
  const text = `${title} ${summary} ${source} ${url}`.toLowerCase()

  if (title && hasNonLatinChars(title)) return false
  const hasUs = hasUsMarkerText(text)
  if (hasForeignCurrency(text) && !hasUs) return false
  if (hasObviousNonUsGeo(text) && !hasUs) return false
  if (isLikelyNonUsTldUrl(url) && !hasUs) return false

  if (origin === "rss") {
    const broadContext = hasBroadRealEstateContext(text)
    if (!broadContext) return false
  } else {
    if (!hasCreKeyword(text)) return false
    if (!strongDistressKeyword(text)) return false
  }

  if (hasConsumerPersonalContext(text)) return false
  if (isEntertainmentGossip(text)) return false
  return true
}

function tagTopic(text: string) {
  const t = (text || "").toLowerCase()
  if (/(waterfront|coastal|beachfront|oceanfront|intracoastal|marina|condo|home|residential|luxury|single-family)/.test(t)) {
    return "Waterfront/Residential"
  }
  if (strongDistressKeyword(t) || /foreclos|receivership|special servicing|cmbs|default|delinquen|bankrupt/.test(t)) {
    return "Foreclosure/Distress"
  }
  if (/loan|financ|refinanc|mortgage|lender|private credit|debt fund|credit fund|bridge loan|mezzanine|maturity|extension/.test(t)) {
    return "Debt/Financing"
  }
  if (/development|construction|groundbreaking|permit|entitlement|rezoning/.test(t)) {
    return "Development/Construction"
  }
  if (/office|retail|industrial|multifamily|warehouse|commercial|cre/.test(t)) {
    return "Commercial Real Estate"
  }
  return "General Real Estate"
}

function regionTag(text: string) {
  const t = (text || "").toLowerCase()
  if (/miami|miami-dade|brickell|doral|wynwood|miami beach|fort lauderdale|broward/.test(t)) return "miami"
  if (/florida|tampa|orlando|jacksonville|fort lauderdale|broward|palm beach|west palm/.test(t)) return "florida"
  return "national"
}

type FeedSpec = { name: string; url: string; kind: "rss" | "atom" | "guess" }

function feedsForLevel(level: "national" | "florida" | "miami"): FeedSpec[] {
  const withWhen = (q: string) => `${q} when:7d`
  const baseQueries = [
    '"special servicing"',
    '"CMBS delinquency" OR "CMBS default"',
    '"maturity wall" OR refinancing',
    '"loan sale" OR "note sale"',
    '"receivership" OR "foreclosure" OR "workout" OR "restructuring" OR "nonaccrual" OR "commercial mortgage"',
  ]
  const localQueries = [
    '"commercial real estate" OR "real estate" OR CRE OR "office market" OR "retail market" OR "multifamily market" OR "industrial market"',
    '"waterfront" OR "coastal" OR "beachfront" OR "oceanfront" OR "intracoastal" OR "bayfront" OR "waterfront estate" OR "oceanfront estate"',
    '"luxury home" OR "mansion" OR "penthouse" OR "estate sale" OR "record sale"',
    '"debt fund" OR "private equity" OR "private credit" OR "credit fund" OR "bridge loan" OR "mezzanine" OR "recapitalization"',
    '"refinancing" OR "loan extension" OR "maturity extension" OR "lender" OR "financing"',
    '"auction" OR "UCC" OR "note sale" OR "loan sale" OR "foreclosure" OR "receivership" OR "distressed"',
  ]
  const region =
    level === "national"
      ? "United States OR U.S. OR US"
      : level === "florida"
        ? "Florida OR Miami OR Tampa OR Orlando OR Jacksonville OR Fort Lauderdale"
        : "Miami OR Miami-Dade OR Brickell OR Miami Beach OR Fort Lauderdale OR Broward OR Doral"

  const queries = [...baseQueries, ...localQueries].map((q) =>
    withWhen(`(${q}) ("commercial real estate" OR CRE OR "commercial mortgage" OR office OR retail OR multifamily OR industrial OR warehouse OR property) (${region})`)
  )

  const googleUrl = (q: string) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`

  const feeds: FeedSpec[] = [
    ...queries.map((q, idx) => ({ name: `Google News ${idx + 1}`, url: googleUrl(q), kind: "rss" as const })),
    // Open-access CRE publications
    { name: "GlobeSt National", url: "https://feeds.feedblitz.com/globest/national", kind: "rss" },
    { name: "GlobeSt Southeast", url: "https://feeds.feedblitz.com/globest/southeast", kind: "rss" },
    { name: "GlobeSt Miami", url: "https://feeds.feedblitz.com/globest/miami", kind: "rss" },
    { name: "Bisnow", url: "https://www.bisnow.com/feed", kind: "rss" },
    { name: "Bisnow South Florida", url: "https://www.bisnow.com/south-florida/feed", kind: "rss" },
    { name: "Commercial Observer", url: "https://commercialobserver.com/feed/", kind: "rss" },
    { name: "The Real Deal", url: "https://therealdeal.com/feed/", kind: "rss" },
    { name: "The Real Deal South Florida", url: "https://therealdeal.com/miami/feed/", kind: "rss" },
    { name: "CRE Daily", url: "https://credaily.com/feed/", kind: "rss" },
    { name: "Propmodo", url: "https://propmodo.com/feed/", kind: "rss" },
    { name: "Trepp Talk", url: "https://www.trepp.com/trepptalk/rss.xml", kind: "rss" },
    { name: "South Florida Business Journal", url: "https://feeds.bizjournals.com/bizj_southflorida", kind: "rss" },
    { name: "Miami Herald Business", url: "https://www.miamiherald.com/news/business/real-estate/?widgetName=rssfeed&widgetContentId=712015&getXmlFeed=true", kind: "rss" },
  ]
  return feeds
}

function parseRssItems(xml: string): Array<{
  title: string
  link: string
  dateRaw: string
  source: string
  description: string
  categories: string[]
}> {
  const items: Array<{ title: string; link: string; dateRaw: string; source: string; description: string; categories: string[] }> = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(xml))) {
    const block = m[1]
    const title = extractTag(block, "title") || ""
    const link = extractTag(block, "link") || ""
    const pubDate = extractTag(block, "pubDate") || ""
    const dcDate = extractTag(block, "dc:date") || extractTag(block, "date") || ""
    const updated = extractTag(block, "updated") || ""
    const dateRaw = pubDate || dcDate || updated || ""
    const source = extractTag(block, "source") || ""
    const description = extractTag(block, "description") || ""
    const categories = extractAllTags(block, "category")
    items.push({ title, link, dateRaw, source, description, categories })
  }
  return items
}

function parseAtomItems(xml: string): Array<{ title: string; link: string; dateRaw: string; source: string; summary: string }> {
  const out: Array<{ title: string; link: string; dateRaw: string; source: string; summary: string }> = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = entryRegex.exec(xml))) {
    const block = m[1]
    const title = extractTag(block, "title") || ""
    const linkMatch = block.match(/<link[^>]+href="([^"]+)"/i)
    const link = linkMatch ? linkMatch[1] : ""
    const updated = extractTag(block, "updated") || extractTag(block, "published") || ""
    const source = extractTag(block, "source") || ""
    const summary = extractTag(block, "summary") || extractTag(block, "content") || ""
    out.push({ title, link, dateRaw: updated, source, summary })
  }
  return out
}

type FeedFetchResult = {
  spec: FeedSpec
  status: number | null
  parsedCount: number
  keptAfterDate: number
  items: PublicMentionItem[]
}

async function fetchFeed(spec: FeedSpec): Promise<FeedFetchResult> {
  let status: number | null = null
  try {
    const res = await fetchWithTimeout(spec.url, { next: { revalidate: 900 } } as unknown as RequestInit, RSS_TIMEOUT_MS)
    status = res.status
    if (!res.ok) {
      return { spec, status, parsedCount: 0, keptAfterDate: 0, items: [] }
    }
    const xml = await res.text()
    const lower = xml.slice(0, 400).toLowerCase()
    const kind =
      spec.kind !== "guess"
        ? spec.kind
        : lower.includes("<feed") && lower.includes("http://www.w3.org/2005/atom")
          ? "atom"
          : "rss"

    const items: PublicMentionItem[] = []
    let parsedCount = 0
    let keptAfterDate = 0
    if (kind === "atom") {
      const entries = parseAtomItems(xml)
      parsedCount = entries.length
      for (const e of entries) {
        const dateRaw = e.dateRaw || ""
        const dateMs = dateRaw ? parseDateToMs(dateRaw) : null
        const isDated = dateMs !== null
        if (isDated && !isWithinLastDays(dateRaw, MAX_AGE_DAYS)) continue
        const date = isDated ? normalizeDate(dateRaw) : ""
        keptAfterDate += 1
        items.push({
          id: `rss-${spec.name}-${e.title.slice(0, 24)}`,
          title: stripHtml(e.title) || "",
          url: (e.link || "").trim(),
          source: stripHtml(e.source) || spec.name,
          date,
          snippet: stripHtml(e.summary),
          region: "national",
          topic: "General Real Estate",
          access_status: "partial",
          feedName: spec.name,
          feedUrl: spec.url,
          undated: !isDated,
        })
      }
    } else {
      const entries = parseRssItems(xml)
      parsedCount = entries.length
      for (const it of entries) {
        const dateRaw = it.dateRaw || ""
        const dateMs = dateRaw ? parseDateToMs(dateRaw) : null
        const isDated = dateMs !== null
        if (isDated && !isWithinLastDays(dateRaw, MAX_AGE_DAYS)) continue
        const date = isDated ? normalizeDate(dateRaw) : ""
        keptAfterDate += 1
        items.push({
          id: `rss-${spec.name}-${it.title.slice(0, 24)}`,
          title: stripHtml(it.title) || "",
          url: (it.link || "").trim(),
          source: stripHtml(it.source) || spec.name,
          date,
          snippet: stripHtml(it.description),
          categories: it.categories,
          region: "national",
          topic: "General Real Estate",
          access_status: "partial",
          feedName: spec.name,
          feedUrl: spec.url,
          undated: !isDated,
        })
      }
    }
    return {
      spec,
      status,
      parsedCount,
      keptAfterDate,
      items: items.filter((x) => x.url && x.title),
    }
  } catch {
    return { spec, status, parsedCount: 0, keptAfterDate: 0, items: [] }
  }
}

async function fetchGdelt(level: "national" | "florida" | "miami"): Promise<PublicMentionItem[]> {
  const q =
    level === "national"
      ? '("special servicing" OR delinquency OR CMBS OR "note sale" OR "loan sale" OR foreclosure OR receivership OR workout OR "distressed debt") ("commercial real estate" OR CRE OR office OR retail OR multifamily OR industrial)'
      : level === "florida"
        ? '("special servicing" OR delinquency OR CMBS OR "note sale" OR "loan sale" OR foreclosure OR receivership OR workout OR "distressed debt") ("commercial real estate" OR CRE OR office OR retail OR multifamily OR industrial) (Florida OR Miami OR Tampa OR Orlando OR Jacksonville OR "Fort Lauderdale")'
        : '("special servicing" OR delinquency OR CMBS OR "note sale" OR "loan sale" OR foreclosure OR receivership OR workout OR "distressed debt") ("commercial real estate" OR CRE OR office OR retail OR multifamily OR industrial) (Miami OR "Miami-Dade" OR Brickell OR "Miami Beach" OR "Fort Lauderdale" OR Broward OR Doral)'

  const end = new Date()
  const start = new Date(Date.now() - MAX_AGE_DAYS * 86400000)
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(
      d.getUTCHours()
    ).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`

  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?" +
    new URLSearchParams({
      query: q,
      mode: "ArtList",
      format: "json",
      maxrecords: String(GDELT_MAX_RECORDS),
      startdatetime: fmt(start),
      enddatetime: fmt(end),
      sourceCountry: "US",
      sort: "HybridRel",
    }).toString()

  try {
    const res = await fetchWithTimeout(url, { cache: "no-store" } as unknown as RequestInit, GDELT_TIMEOUT_MS)
    if (!res.ok) return []
    const data = (await res.json()) as any
    const articles: any[] = Array.isArray(data?.articles) ? data.articles : []
    const out: PublicMentionItem[] = []
    for (const a of articles) {
      const title = typeof a?.title === "string" ? a.title : ""
      const link = typeof a?.url === "string" ? a.url : ""
      const source = typeof a?.sourceCollection === "string" ? a.sourceCollection : typeof a?.sourceCountry === "string" ? a.sourceCountry : ""
      const seendate = typeof a?.seendate === "string" ? a.seendate : ""
      const date = normalizeDate(seendate) || normalizeDate(a?.datetime)
      const summary = typeof a?.summary === "string" ? a.summary : ""
      const cleanTitle = stripHtml(title) || ""
      if (!cleanTitle || !link) continue
      if (date && !isWithinLastDays(date, MAX_AGE_DAYS)) continue
      out.push({
        id: `gdelt-${cleanTitle.slice(0, 24)}`,
        title: cleanTitle,
        url: link,
        source: stripHtml(source) || "GDELT",
        date,
        snippet: stripHtml(summary),
        region: "national",
        topic: "Foreclosure/Distress",
        access_status: "partial",
      })
    }
    return out
  } catch {
    return []
  }
}

async function classifyTop(items: PublicMentionItem[]): Promise<PublicMentionItem[]> {
  const top = items.slice(0, CLASSIFY_LIMIT)
  const rest = items.slice(CLASSIFY_LIMIT).map((x) => ({ ...x, access_status: "partial" as const, detection_reason: "unclassified" }))
  let idx = 0
  const out: PublicMentionItem[] = new Array(top.length)
  const worker = async () => {
    while (idx < top.length) {
      const i = idx
      idx += 1
      const item = top[i]
      const url = (item.url || "").trim()
      if (!url) {
        out[i] = { ...item, access_status: "partial", detection_reason: "missing_url" }
        continue
      }
      try {
        // Fast-path: skip fetching articles from known paywalled publishers
        const host = (() => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase() } catch { return "" } })()
        const isKnownPaywall = host && KNOWN_PAYWALL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
        if (isKnownPaywall) {
          out[i] = { ...item, access_status: "paywalled", detection_reason: "known_paywall_domain" }
          continue
        }
        const c = await classifyArticleAccess({ url, title: item.title, includeExtractedText: false })
        out[i] = {
          ...item,
          access_status: c.access_status,
          resolved_url: c.resolved_url,
          detection_reason: c.detection_reason,
        }
      } catch {
        out[i] = { ...item, access_status: "partial", detection_reason: "classify_error" }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, top.length) }, () => worker()))
  return [...out, ...rest]
}

async function fetchPublicMentionsImpl(
  level: "national" | "florida" | "miami"
): Promise<PublicMentionsResponse> {
  const notes: string[] = []
  const feeds = feedsForLevel(level)
  const feedResults = await Promise.all(feeds.map((f) => fetchFeed(f)))
  const feedItems = feedResults.flatMap((res) => res.items)

  const normalizedFeeds = feedItems
    .map((x) => ({
      ...x,
      title: stripHtml(x.title) || x.title,
      snippet: stripHtml(x.snippet),
      source: (x.source || "").trim(),
      url: (x.url || "").trim(),
    }))
    .filter((x) => x.url && x.title)

  const seen = new Set<string>()
  const keptByFeed = new Map<string, number>()
  const feedCandidates: PublicMentionItem[] = []
  let undatedKept = 0
  let keptAfterJunk = 0
  for (const it of normalizedFeeds) {
    const k = dedupeKey(it)
    const text = `${it.title || ""} ${it.snippet || ""} ${it.source || ""} ${it.url || ""}`
    if (seen.has(k)) {
      continue
    }
    if (it.date && !isWithinLastDays(it.date, MAX_AGE_DAYS)) {
      continue
    }
    if (hasNonLatinChars(it.title)) {
      continue
    }
    if (hasConsumerPersonalContext(`${it.title} ${it.snippet || ""} ${it.source || ""} ${it.url || ""}`)) {
      continue
    }
    if (!passesHardPreFilter(level, it, "rss")) {
      continue
    }
    if (it.undated) {
      if (undatedKept >= UNDATED_CAP) continue
      undatedKept += 1
    }
    seen.add(k)
    feedCandidates.push(it)
    keptAfterJunk += 1
    if (it.feedName) {
      keptByFeed.set(it.feedName, (keptByFeed.get(it.feedName) || 0) + 1)
    }
    const maxItems = MAX_ITEMS
    if (feedCandidates.length >= maxItems * 3) break
  }

  for (const res of feedResults) {
    const keptHard = keptByFeed.get(res.spec.name) || 0
    const status = res.status === null ? "error" : String(res.status)
    console.log(
      `[public-mentions] feed=${res.spec.name} url=${res.spec.url} status=${status} parsed=${res.parsedCount} kept_date=${res.keptAfterDate} kept_hard=${keptHard}`
    )
  }
  // GDELT fallback only if RSS coverage is thin.
  const gdeltRaw = feedCandidates.length < GDELT_ENABLE_IF_FEEDS_LT ? await fetchGdelt(level) : []
  const gdeltCandidates = gdeltRaw
    .filter((x) => passesHardPreFilter(level, x, "gdelt"))
    .slice(0, GDELT_MAX_INCLUDE)

  const combined = [...feedCandidates, ...gdeltCandidates]

  if (combined.length === 0) {
    notes.push("No qualifying public mentions were found in the past 7 days.")
    return { news: [], notes }
  }

  // Rank by distress/CRE relevance + geo boost (for FL/Miami).
  // relaxGeo: lower threshold so FL/Miami levels always get national CRE as fill
  const relaxGeo = level !== "national" && combined.length < 30
  const ranked = combined
    .map((x) => {
      const text = `${x.title || ""} ${x.snippet || ""} ${x.source || ""} ${x.url || ""}`
      const distress = strongDistressKeyword(text)
      const cre = hasCreContext(text, x.categories)
      const topic = tagTopic(text)
      let base =
        topic === "Foreclosure/Distress"
          ? 6
          : topic === "Debt/Financing"
            ? 4
            : topic === "Development/Construction"
              ? 3
              : topic === "Commercial Real Estate"
                ? 2
                : topic === "Waterfront/Residential"
                  ? 1
                  : cre
                    ? 1
                    : 0
      const geoTag = regionTag(text)
      // For FL/Miami levels: boost geo-matched articles but keep national CRE
      // visible as fill (score +1) rather than leaving them at 0.
      const geo = relaxGeo
        ? 0
        : geoTag === "miami"
          ? level === "miami"
            ? 4
            : level === "florida"
              ? 2
              : 0
          : geoTag === "florida"
            ? level === "florida"
              ? 3
              : 0
            : level === "florida" || level === "miami"
              ? 1  // national CRE articles fill when geo-specific coverage is thin
              : 0
      const datePenalty = x.undated ? 2 : 0
      return { x, score: base + geo - datePenalty }
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => r.x)

  // Classify access for top 30 items.
  const classified = await classifyTop(ranked)

  // Final map: tags + access, cap to MAX_ITEMS.
  const out: PublicMentionItem[] = []
  const dupe = new Set<string>()
  for (const item of classified) {
    const key = dedupeKey(item)
    if (dupe.has(key)) continue
    dupe.add(key)
    const text = `${item.title || ""} ${item.snippet || ""} ${item.source || ""} ${item.url || ""}`
    const region =
      item.source === "South Florida Business Journal" || (item.feedName || "").includes("South Florida Business Journal")
        ? "florida"
        : regionTag(text)
    out.push({
      ...item,
      region,
      topic: tagTopic(text),
    })
    const maxItems = MAX_ITEMS
    if (out.length >= maxItems) break
  }
  const regionCounts = out.reduce(
    (acc, item) => {
      acc[item.region] += 1
      return acc
    },
    { national: 0, florida: 0, miami: 0 } as Record<"national" | "florida" | "miami", number>
  )
  console.info("public_mentions: counts", {
    level,
    fetched: normalizedFeeds.length,
    keptAfterJunk,
    regionCounts,
    returned: out.length,
  })

  return { news: out, notes }
}

export async function fetchPublicMentions(
  level: "national" | "florida" | "miami"
): Promise<PublicMentionsResponse> {
  const day = newsCalendarDayET()
  return unstable_cache(
    async () => fetchPublicMentionsImpl(level),
    ["public-mentions-v4", day, level],
    { revalidate: NEWS_TAB_REVALIDATE_SECONDS }
  )()
}

