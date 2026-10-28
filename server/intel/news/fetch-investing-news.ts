import { unstable_cache } from "../cache-shim"
import { classifyArticleAccess } from "./news-access"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"
import type { PublicMentionItem } from "./fetch-public-mentions"

export type InvestingNewsResponse = {
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
    const headers = new Headers((init as RequestInit & { headers?: Headers })?.headers || undefined)
    if (!headers.has("User-Agent")) headers.set("User-Agent", "MarketIntelligence/1.0 (investing-news@marketintel.local)")
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
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(?:apos|rsquo|lsquo);/gi, "'")
    .replace(/&(?:ldquo|rdquo);/gi, '"')
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

/** General Finance News is focused only on United States, Florida, and Miami. */
function hasUsFloridaMiamiRelevance(text: string, source?: string, feedName?: string) {
  const t = (text || "").toLowerCase()
  const us =
    /\bu\.s\.\b|\bunited states\b|\bamerica\b|\bus\b|\busa\b|\bamerican\b/.test(t) ||
    /\bnew york\b|\bnyc\b|\bchicago\b|\blos angeles\b|\btexas\b|\bcalifornia\b/.test(t) ||
    /\bfed\b|\bfederal reserve\b|\bpowell\b|\bfomc\b|\bu\.s\. treasury\b/.test(t)
  const florida = /\bflorida\b|\btampa\b|\borlando\b|\bjacksonville\b|\bpalm beach\b|\bwest palm\b/.test(t)
  const miami =
    /\bmiami\b|miami-dade|\bbrickell\b|\bdoral\b|\bwynwood\b|miami beach|\bfort lauderdale\b|\bbroward\b/.test(t)
  if (us || florida || miami) return true
  const s = (source || "").toLowerCase()
  const f = (feedName || "").toLowerCase()
  const usFloridaMiamiSources = [
    "cnbc",
    "yahoo finance",
    "marketwatch",
  ]
  return usFloridaMiamiSources.some((name) => s.includes(name) || f.includes(name))
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
    /\buk\b|\bunited kingdom\b|\bbritain\b|\bbritish\b|\bengland\b|\bscotland\b|\bwales\b|\bnorthern ireland\b|\blondon\b|\bmanchester\b|\bbirmingham\b/.test(t) ||
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

/** General Finance excludes real estate—real estate news belongs in Industry Specific News. */
function hasRealEstateFocus(text: string, feedName?: string) {
  const t = (text || "").toLowerCase()
  const f = (feedName || "").toLowerCase()
  const reFeeds = ["globest", "bisnow", "commercial observer"]
  if (reFeeds.some((name) => f.includes(name))) return true
  return (
    /\breal estate\b|\bcommercial real estate\b|\bcre\b|\bproperty\b|\bmultifamily\b|\boffice market\b|\bretail market\b|\bindustrial market\b/.test(t) ||
    /\breit\b|\breal estate investment trust\b|\bcommercial mortgage\b|\bmortgage\b|\bcmbs\b/.test(t) ||
    /\bwarehouse\b|\bapartment\b|\bcondo\b|\bhotel\b|\bhospitality\b|\bdevelopment\b|\bground lease\b/.test(t) ||
    /\bcap rate\b|\bcap rates\b|\bnoi\b|\bground lease\b/.test(t)
  )
}

/** General finance: WSJ-style coverage—Fed, rates, earnings, M&A, banks, markets, IPOs (excludes real estate). */
function hasGeneralFinanceKeyword(text: string) {
  const t = (text || "").toLowerCase()
  return (
    /\binterest rate\b|\binterest rates\b|\bfed\b|\bfederal reserve\b|\bpowell\b|\bmonetary policy\b|\bfomc\b|\brate cut\b|\brate hike\b/.test(t) ||
    /\btreasury\b|\btreasury yield\b|\b10-year\b|\bbasis point\b|\bbps\b|\bsofr\b|\blibor\b|\bprime rate\b/.test(t) ||
    /\birr\b|\binternal rate of return\b|\breturn on investment\b|\broi\b|\byield\b/.test(t) ||
    /\binflation\b|\bcpi\b|\bpce\b|\bgdp\b|\bunemployment\b|\bjobs report\b/.test(t) ||
    /\bcredit spread\b|\bdefault rate\b|\bdistressed debt\b|\bhigh yield\b|\bjunk bond\b|\bcorporate bond\b|\binvestment grade\b|\bbond issuance\b|\bcorporate debt\b/.test(t) ||
    /\bdebt ceiling\b|\bfiscal\b|\bbudget\b|\bdeficit\b|\bgovernment spending\b/.test(t) ||
    /\bsec\b|\bregulatory\b|\bcftc\b|\benforcement\b|\bcompliance\b|\bfines\b/.test(t) ||
    /\bwall street\b|\bs&p 500\b|\bdow jones\b|\bnasdaq\b|\bstock market\b|\bequity market\b|\bbond market\b/.test(t) ||
    /\bearnings\b|\bquarterly results\b|\brevenue\b|\bprofit\b|\bnet income\b|\beps\b|\bguidance\b/.test(t) ||
    /\bmerger\b|\bacquisition\b|\bm&a\b|\bacquire\b|\bdeal\b|\bbuyout\b/.test(t) ||
    /\bipo\b|\binitial public offering\b|\bgoes public\b|\bspac\b/.test(t) ||
    /\bbank\b|\bbanking\b|\bhedge fund\b|\basset manager\b|\binvestment bank\b|\bjpmorgan\b|\bgoldman\b|\bmorgan stanley\b/.test(t) ||
    /\bshare buyback\b|\bbuyback\b|\bdividend\b|\bshareholder\b|\bstock buyback\b/.test(t) ||
    /\btrading\b|\bstocks\b|\bequities\b|\bbonds\b/.test(t) ||
    /\bmarket outlook\b|\beconomic forecast\b|\bcentral bank\b/.test(t)
  )
}

function hasBroadRealEstateContext(text: string) {
  const t = (text || "").toLowerCase()
  return /real estate|property|development|transaction|sale|listing|deed|financing|loan|refinancing|mortgage|lender|office|retail|industrial|multifamily|apartment|hotel|hospitality|warehouse|condo|home|waterfront|marina|beach|luxury/.test(t)
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

function passesInvestingPreFilter(
  level: "national" | "florida" | "miami",
  item: { title?: string; summary?: string; snippet?: string; source?: string; url?: string; feedName?: string; feedUrl?: string; categories?: string[] },
  origin: "rss" | "gdelt"
) {
  const title = (item.title || "").trim()
  const summary = ((item.summary ?? item.snippet) || "").trim()
  const source = (item.source || "").trim()
  const url = (item.url || "").trim()
  const text = `${title} ${summary} ${source} ${url}`.toLowerCase()

  if (title && hasNonLatinChars(title)) return false
  const hasUs = hasUsMarkerText(text)
  if (hasForeignCurrency(text) && !hasUs) return false
  if (hasObviousNonUsGeo(text) && !hasUs) return false
  if (isLikelyNonUsTldUrl(url) && !hasUs) return false

  if (!hasUsFloridaMiamiRelevance(text, source, item.feedName)) return false

  if (hasRealEstateFocus(text, item.feedName)) return false

  if (origin === "rss") {
    const generalFinance = hasGeneralFinanceKeyword(text)
    if (!generalFinance) return false
  } else {
    const generalFinance = hasGeneralFinanceKeyword(text)
    if (!generalFinance) return false
  }

  if (hasConsumerPersonalContext(text)) return false
  if (isEntertainmentGossip(text)) return false
  return true
}

function tagInvestingTopic(text: string) {
  const t = (text || "").toLowerCase()
  if (/\bearnings\b|\bquarterly results\b|\brevenue\b|\bprofit\b|\beps\b|\bguidance\b/.test(t)) return "Earnings"
  if (/\bmerger\b|\bacquisition\b|\bm&a\b|\bacquire\b|\bbuyout\b/.test(t)) return "M&A"
  if (/\bipo\b|\binitial public offering\b|\bgoes public\b|\bspac\b/.test(t)) return "IPO"
  if (/\bbank\b|\bbanking\b|\bhedge fund\b|\binvestment bank\b|\bjpmorgan\b|\bgoldman\b|\bmorgan stanley\b/.test(t)) return "Banking/Financial"
  if (/\bshare buyback\b|\bbuyback\b|\bdividend\b|\bshareholder\b/.test(t)) return "Corporate Finance"
  if (/\bsec\b|\bregulatory\b|\bcftc\b|\benforcement\b|\bcompliance\b/.test(t)) return "Regulation/SEC"
  if (/\bdebt ceiling\b|\bfiscal\b|\bbudget\b|\bdeficit\b|\bgovernment spending\b/.test(t)) return "Fiscal Policy/Budget"
  if (/\bcredit spread\b|\bcorporate bond\b|\binvestment grade\b|\bhigh yield\b|\bcorporate debt\b|\bbond issuance\b/.test(t)) return "Credit & Debt Markets"
  if (/\binterest rate\b|\bfed\b|\bfederal reserve\b|\bmonetary policy\b|\bfomc\b|\brate cut\b|\brate hike\b/.test(t)) return "Interest Rates/Fed"
  if (/\btreasury\b|\b10-year\b|\bbasis point\b|\bsofr\b|\blibor\b|\bprime rate\b/.test(t)) return "Rates/Yields"
  if (/\birr\b|\binternal rate of return\b|\breturn on investment\b|\broi\b|\byield\b/.test(t)) return "Investment Returns"
  if (/\binflation\b|\bcpi\b|\bpce\b|\bgdp\b|\bunemployment\b|\bjobs report\b/.test(t)) return "Economic Data"
  if (/\bprivate equity\b|\bprivate credit\b|\bdebt fund\b|\bcredit fund\b/.test(t)) return "Private Equity/Credit"
  if (/\bcapital raise\b|\bfund raising\b|\bfundraising\b/.test(t)) return "Capital Markets"
  if (/\binvestment firm\b|\basset manager\b/.test(t)) return "Investment Firms"
  if (/\bstock\b|\bequity\b|\bmarket\b|\btrading\b/.test(t)) return "Markets"
  return "General Finance"
}

function regionTag(text: string) {
  const t = (text || "").toLowerCase()
  if (/miami|miami-dade|brickell|doral|wynwood|miami beach|fort lauderdale|broward/.test(t)) return "miami"
  if (/florida|tampa|orlando|jacksonville|fort lauderdale|broward|palm beach|west palm/.test(t)) return "florida"
  return "national"
}

type FeedSpec = { name: string; url: string; kind: "rss" | "atom" | "guess" }

function feedsForInvestingLevel(level: "national" | "florida" | "miami"): FeedSpec[] {
  const withWhen = (q: string) => `${q} when:7d`
  const region =
    level === "national"
      ? "United States OR U.S. OR US"
      : level === "florida"
        ? "Florida OR Miami OR Tampa OR Orlando OR Jacksonville OR Fort Lauderdale"
        : "Miami OR Miami-Dade OR Brickell OR Miami Beach OR Fort Lauderdale OR Broward OR Doral"

  const generalFinanceQueries = [
    // Banking & lender health — most relevant to distressed CRE investors
    `"regional bank" OR "community bank" OR "bank earnings" OR "bank stress" OR "CRE loans" OR "commercial real estate exposure" (${region})`,
    `"JPMorgan" OR "Wells Fargo" OR "Bank of America" OR "Goldman Sachs" OR "Morgan Stanley" earnings OR results (${region})`,
    // Private credit & capital markets
    `"private credit" OR "private equity" OR "debt fund" OR "credit fund" OR "CLO" OR "direct lending" OR "dry powder" (${region})`,
    `"credit spread" OR "corporate bond" OR "investment grade" OR "high yield" OR "bond issuance" OR "capital raise" (${region})`,
    // M&A, IPO, Corporate events
    `"merger" OR "acquisition" OR "M&A" OR "buyout" OR "deal announced" (${region})`,
    `"IPO" OR "initial public offering" OR "goes public" OR "fund closing" OR "fund raise" (${region})`,
    // Regulation & lending standards
    `"SEC" OR "FDIC" OR "OCC" OR "Basel" OR "lending standards" OR "reserve requirements" OR "regulatory" OR "enforcement" (${region})`,
    `"earnings" OR "quarterly results" OR "revenue" OR "profit" OR "guidance" (${region})`,
    // Macro & rates — capped lower in round-robin via MAX_PER_TOPIC_FED
    `"Federal Reserve" OR "FOMC" OR "rate cut" OR "rate hike" OR "monetary policy" (${region})`,
    `"treasury yield" OR "basis points" OR "SOFR" OR "interest rate" OR "10-year" (${region})`,
    `"inflation" OR "CPI" OR "PCE" OR "GDP" OR "jobs report" OR "unemployment" (${region})`,
    `"fiscal" OR "budget" OR "deficit" OR "debt ceiling" OR "government spending" (${region})`,
  ].map((q) => withWhen(q))

  const googleUrl = (q: string) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`

  const feeds: FeedSpec[] = [
    ...generalFinanceQueries.map((q, idx) => ({ name: `Google News Finance ${idx + 1}`, url: googleUrl(q), kind: "rss" as const })),
    // Broader financial press — kept but Fed/rates articles from these are balanced by topic cap
    { name: "CNBC Finance", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", kind: "rss" },
    { name: "Reuters Finance", url: "https://feeds.reuters.com/reuters/businessNews", kind: "rss" },
    { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss", kind: "rss" },
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
          topic: "General Investing",
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
          topic: "General Investing",
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

async function fetchGdeltInvesting(level: "national" | "florida" | "miami"): Promise<PublicMentionItem[]> {
  const financeTerms = '("interest rate" OR "Federal Reserve" OR "Fed" OR "treasury yield" OR "IRR" OR "monetary policy" OR "inflation" OR "CPI" OR "FOMC" OR "rate cut" OR "earnings" OR "quarterly results" OR "merger" OR "acquisition" OR "M&A" OR "IPO" OR "hedge fund" OR "investment bank" OR "stock market" OR "S&P 500" OR "share buyback" OR "dividend" OR "credit spread" OR "corporate bond" OR "investment grade" OR "high yield" OR "debt ceiling" OR "fiscal" OR "budget" OR "deficit" OR "SEC" OR "regulatory" OR "enforcement" OR "compliance")'
  const region =
    level === "national"
      ? ""
      : level === "florida"
        ? ' (Florida OR Miami OR Tampa OR Orlando OR Jacksonville OR "Fort Lauderdale")'
        : ' (Miami OR "Miami-Dade" OR Brickell OR "Miami Beach" OR "Fort Lauderdale" OR Broward OR Doral)'
  const q = `(${financeTerms})${region}`.trim()

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
    const data = (await res.json()) as { articles?: Array<{ title?: string; url?: string; sourceCollection?: string; sourceCountry?: string; seendate?: string; datetime?: string; summary?: string }> }
    const articles: typeof data.articles = Array.isArray(data?.articles) ? data.articles : []
    const out: PublicMentionItem[] = []
    for (const a of articles ?? []) {
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
        topic: "Capital Markets",
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

async function fetchInvestingNewsImpl(
  level: "national" | "florida" | "miami"
): Promise<InvestingNewsResponse> {
  const notes: string[] = []
  const feeds = feedsForInvestingLevel(level)
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
    if (seen.has(k)) continue
    if (it.date && !isWithinLastDays(it.date, MAX_AGE_DAYS)) continue
    if (hasNonLatinChars(it.title)) continue
    if (hasConsumerPersonalContext(`${it.title} ${it.snippet || ""} ${it.source || ""} ${it.url || ""}`)) continue
    if (!passesInvestingPreFilter(level, it, "rss")) continue
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
    if (feedCandidates.length >= MAX_ITEMS * 3) break
  }

  for (const res of feedResults) {
    const keptHard = keptByFeed.get(res.spec.name) || 0
    const status = res.status === null ? "error" : String(res.status)
    console.log(
      `[investing-news] feed=${res.spec.name} url=${res.spec.url} status=${status} parsed=${res.parsedCount} kept_date=${res.keptAfterDate} kept_hard=${keptHard}`
    )
  }

  const gdeltRaw = feedCandidates.length < GDELT_ENABLE_IF_FEEDS_LT ? await fetchGdeltInvesting(level) : []
  const gdeltCandidates = gdeltRaw
    .filter((x) => passesInvestingPreFilter(level, x, "gdelt"))
    .slice(0, GDELT_MAX_INCLUDE)

  const combined = [...feedCandidates, ...gdeltCandidates]

  if (combined.length === 0) {
    notes.push("No qualifying general finance news (non–real estate) were found in the past 7 days.")
    return { news: [], notes }
  }

  const relaxGeo = level !== "national" && combined.length < 20
  const ranked = combined
    .map((x) => {
      const text = `${x.title || ""} ${x.snippet || ""} ${x.source || ""} ${x.url || ""}`
      const topic = tagInvestingTopic(text)
      let base =
        topic === "Earnings"
          ? 5
          : topic === "M&A"
            ? 5
            : topic === "IPO"
              ? 5
              : topic === "Banking/Financial"
                ? 5
                : topic === "Corporate Finance"
                  ? 4
                  : topic === "Regulation/SEC"
                    ? 5
                    : topic === "Fiscal Policy/Budget"
                      ? 5
                      : topic === "Credit & Debt Markets"
                        ? 5
                        : topic === "Interest Rates/Fed"
                          ? 5
                          : topic === "Rates/Yields"
                            ? 5
                            : topic === "Investment Returns"
                              ? 5
                              : topic === "Economic Data"
                                ? 4
                                : topic === "Markets"
                                  ? 4
                                  : topic === "Private Equity/Credit"
                                    ? 5
                                    : topic === "Capital Markets"
                                      ? 5
                                      : topic === "Investment Firms"
                                        ? 4
                                        : 2
      const geo = relaxGeo
        ? 0
        : regionTag(text) === "miami"
          ? level === "miami"
            ? 4
            : 0
          : regionTag(text) === "florida"
            ? level === "florida"
              ? 3
              : 0
            : 0
      const datePenalty = x.undated ? 2 : 0
      return { x, score: base + geo - datePenalty }
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => r.x)

  const classified = await classifyTop(ranked)

  const byTopic = new Map<string, PublicMentionItem[]>()
  const dupe = new Set<string>()
  for (const item of classified) {
    const key = dedupeKey(item)
    if (dupe.has(key)) continue
    dupe.add(key)
    const text = `${item.title || ""} ${item.snippet || ""} ${item.source || ""} ${item.url || ""}`
    const topic = tagInvestingTopic(text)
    const region: PublicMentionItem["region"] =
      item.source === "South Florida Business Journal" || (item.feedName || "").includes("South Florida Business Journal")
        ? "florida"
        : (regionTag(text) as PublicMentionItem["region"])
    const enriched = { ...item, region, topic }
    const list = byTopic.get(topic) || []
    list.push(enriched)
    byTopic.set(topic, list)
  }

  const MAX_PER_TOPIC = 4
  // Fed/rates topics are capped lower so they don't crowd out banking, private
  // credit, earnings, and other categories that are more directly actionable.
  const FED_TOPICS = new Set(["Interest Rates/Fed", "Rates/Yields", "Fiscal Policy/Budget"])
  const MAX_PER_FED_TOPIC = 2
  const out: PublicMentionItem[] = []
  const topics = Array.from(byTopic.keys())
  for (let round = 0; round < MAX_PER_TOPIC && out.length < MAX_ITEMS; round++) {
    for (const topic of topics) {
      const cap = FED_TOPICS.has(topic) ? MAX_PER_FED_TOPIC : MAX_PER_TOPIC
      if (round >= cap) continue
      const list = byTopic.get(topic)!
      if (round < list.length && out.length < MAX_ITEMS) {
        out.push(list[round])
      }
    }
  }
  for (const topic of topics) {
    const cap = FED_TOPICS.has(topic) ? MAX_PER_FED_TOPIC : MAX_PER_TOPIC
    const list = byTopic.get(topic)!
    for (let i = cap; i < list.length && out.length < MAX_ITEMS; i++) {
      out.push(list[i])
    }
  }

  const regionCounts = out.reduce(
    (acc, item) => {
      acc[item.region] += 1
      return acc
    },
    { national: 0, florida: 0, miami: 0 } as Record<"national" | "florida" | "miami", number>
  )
  console.info("investing_news: counts", {
    level,
    fetched: normalizedFeeds.length,
    keptAfterJunk,
    regionCounts,
    returned: out.length,
  })

  return { news: out, notes }
}

export async function fetchInvestingNews(
  level: "national" | "florida" | "miami"
): Promise<InvestingNewsResponse> {
  const day = newsCalendarDayET()
  return unstable_cache(
    async () => fetchInvestingNewsImpl(level),
    ["investing-news-v4", day, level],
    { revalidate: NEWS_TAB_REVALIDATE_SECONDS }
  )()
}
