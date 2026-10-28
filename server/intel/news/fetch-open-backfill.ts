import { classifyArticleAccess, KNOWN_PAYWALL_DOMAINS } from "./news-access"
import { callOpenAiJson, getOpenAiApiKey } from "../openai"

export type OpenBackfillSource = { title: string; url: string }

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

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

function isKnownPaywallHost(host: string) {
  return (KNOWN_PAYWALL_DOMAINS as readonly string[]).some((d) => host === d || host.endsWith(`.${d}`))
}

function parseCandidateArray(value: unknown): OpenBackfillSource[] {
  if (!Array.isArray(value)) return []
  const out: OpenBackfillSource[] = []
  for (const v of value) {
    if (!v || typeof v !== "object") continue
    const title = typeof (v as any).title === "string" ? (v as any).title.trim() : ""
    const url = typeof (v as any).url === "string" ? (v as any).url.trim() : ""
    if (!title || !url) continue
    out.push({ title, url })
    if (out.length >= 12) break
  }
  return out
}

async function callAiJson(prompt: string): Promise<any | null> {
  if (!getOpenAiApiKey()) return null
  return callOpenAiJson({
    system:
      "Return ONLY valid JSON. Do not invent facts. No markdown. Use your web search tool to find real, current open-access sources.",
    user: prompt,
    tier: "smart",
    temperature: 0.2,
    maxTokens: 1400,
    webSearch: true,
  })
}

async function googleNewsRssTokenFallback(title: string, excludeUrl?: string): Promise<OpenBackfillSource[]> {
  // Simple token search against Google News RSS for related sources.
  const tokens = (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 5)
    .slice(0, 4)
  if (!tokens.length) return []
  const q = tokens.join(" ")
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
  try {
    const res = await fetch(rssUrl, { cache: "no-store" })
    if (!res.ok) return []
    const xml = await res.text()
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    const extractTag = (block: string, tag: string) => {
      const pattern = `<(?:[a-zA-Z0-9]+:)?${tag}>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`
      const m = block.match(new RegExp(pattern, "i"))
      if (!m) return ""
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()
    }
    const out: OpenBackfillSource[] = []
    let m: RegExpExecArray | null
    while ((m = itemRegex.exec(xml))) {
      const block = m[1]
      const t = extractTag(block, "title") || "Untitled"
      const u = extractTag(block, "link") || ""
      if (!u) continue
      if (excludeUrl && u === excludeUrl) continue
      out.push({ title: t, url: u })
      if (out.length >= 10) break
    }
    return out
  } catch {
    return []
  }
}

async function validateOpenSourcesConcurrently(
  sources: OpenBackfillSource[],
  maxConcurrency = 4
): Promise<OpenBackfillSource[]> {
  const out: OpenBackfillSource[] = []
  const seen = new Set<string>()
  let idx = 0

  const worker = async () => {
    while (idx < sources.length) {
      const i = idx
      idx += 1
      const s = sources[i]
      const u = normalizeUrlForKey(s.url)
      if (!u) continue
      const host = safeHost(u)
      if (!host) continue
      if (host === "news.google.com" || host.endsWith(".news.google.com")) continue
      if (isKnownPaywallHost(host)) continue
      if (seen.has(u)) continue
      try {
        const c = await classifyArticleAccess({ url: u, title: s.title, includeExtractedText: false })
        if (c.access_status === "paywalled") continue
        const resolved = normalizeUrlForKey((c.resolved_url || u).trim())
        const resolvedHost = safeHost(resolved)
        if (!resolved || !resolvedHost) continue
        if (resolvedHost === "news.google.com" || resolvedHost.endsWith(".news.google.com")) continue
        if (isKnownPaywallHost(resolvedHost)) continue
        if (seen.has(resolved)) continue
        seen.add(resolved)
        out.push({ title: s.title, url: resolved })
      } catch {
        // If we can't fetch/classify, still include if it passes domain filters.
        seen.add(u)
        out.push({ title: s.title, url: u })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, sources.length) }, () => worker()))
  return out
}

export async function findOpenBackfillSources(input: {
  title: string
  date?: string
  level: "national" | "florida" | "miami"
  excludeUrl?: string
}): Promise<Array<{ title: string; url: string }>> {
  const title = (input.title || "").trim()
  if (!title) return []

  const region =
    input.level === "national" ? "United States" : input.level === "florida" ? "Florida" : "Miami Metro (Miami-Dade / South Florida)"

  const prompt = `You are a market intelligence analyst focused on distressed commercial real estate debt.
Find 5-8 RELATED OPEN-ACCESS sources from the past 7 days (avoid paywalls like WSJ/Bloomberg/FT/NYT/Economist).
Focus on: CMBS stress, special servicing, delinquencies/defaults, refinancing stress, note/loan sales, workouts, receiverships, foreclosures.
Return ONLY valid JSON:
{
  "sources": [{"title": "...", "url": "https://..."}]
}

REGION: ${region}
DATE (if provided): ${input.date || "Unknown"}
HEADLINE: ${title}
EXCLUDE_URL (if provided): ${input.excludeUrl || "none"}`

  const parsed = await callAiJson(prompt)
  const modelCandidates = parseCandidateArray(parsed?.sources)

  const fallbackCandidates = modelCandidates.length
    ? []
    : await googleNewsRssTokenFallback(title, input.excludeUrl)

  const combined = [...modelCandidates, ...fallbackCandidates]
  if (!combined.length) return []

  const validated = await validateOpenSourcesConcurrently(combined, 4)
  // Keep only first 5 unique validated sources.
  const uniq: OpenBackfillSource[] = []
  const seen = new Set<string>()
  for (const s of validated) {
    const u = normalizeUrlForKey(s.url)
    if (!u) continue
    if (seen.has(u)) continue
    seen.add(u)
    uniq.push({ title: s.title, url: u })
    if (uniq.length >= 5) break
  }
  return uniq
}

