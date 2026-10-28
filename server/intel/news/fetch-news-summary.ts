import { unstable_cache } from "../cache-shim"
import { classifyArticleAccess, type AccessStatus, KNOWN_PAYWALL_DOMAINS } from "./news-access"
import { callOpenAiJson, getOpenAiApiKey } from "../openai"
import { findOpenBackfillSources } from "./fetch-open-backfill"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"

export type NewsSummaryInput = {
  title: string
  url?: string
  source?: string
  date?: string
  summary?: string
}

export type NewsBrief = {
  title: string
  url?: string
  source?: string
  date?: string

  access_status: AccessStatus
  detection_reason: string
  http_status: number
  content_length_chars: number
  extracted_text_length_chars: number

  summarization_mode: "full_summary" | "intelligence_brief" | "paywall_signal"
  confidence_label: "High" | "Medium" | "Low"

  banner?: string
  executiveSummary: string
  dealSpecifics?: {
    assetType?: string
    location?: string
    loanAmount?: string
    lender?: string
    borrower?: string
    dealStatus?: string
  }
  keyBullets: string[]
  whyItMatters: string[]
  entities: string[]
  redFlags: string[]
  followUps: string[]
  confidence: number
  generatedAt: string
  relatedOpenSources?: Array<{ title: string; url: string }>
  notes: string[]
}

function asStringArray(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const cleaned = item.replace(/^\s*[-•]\s*/g, "").trim()
    if (!cleaned) continue
    out.push(cleaned)
    if (out.length >= max) break
  }
  return out
}

function clampNumber(n: unknown, lo: number, hi: number, fallback: number) {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN
  if (Number.isNaN(v)) return fallback
  return Math.max(lo, Math.min(hi, v))
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

function parseRelatedFromModel(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ title: string; url: string }> = []
  for (const v of value) {
    if (!v || typeof v !== "object") continue
    const title = typeof (v as any).title === "string" ? (v as any).title.trim() : ""
    const url = typeof (v as any).url === "string" ? (v as any).url.trim() : ""
    if (!title || !url) continue
    out.push({ title, url })
    if (out.length >= 6) break
  }
  return out
}

async function validateOpenSources(
  sources: Array<{ title: string; url: string }>
): Promise<Array<{ title: string; url: string }>> {
  // Concurrency-limited validation to keep latency bounded.
  const out: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  let idx = 0
  const limit = 4

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
        // If we can't fetch/classify (bot checks, transient network), still include the link
        // as long as it passes domain filters. The user can click to validate.
        seen.add(u)
        out.push({ title: s.title, url: u })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, sources.length) }, () => worker()))
  return out.slice(0, 5)
}

function safeTruncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED]`
}

function tokenize(title: string) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 5)
    .slice(0, 8)
}

async function fetchRelatedFromRss(level: "national" | "florida" | "miami", title: string, excludeUrl?: string) {
  // Preferred but optional: find related open-ish sources from the same feed (not web search).
  try {
    const tokens = tokenize(title).slice(0, 4)
    if (!tokens.length) return []
    const q = tokens.join(" ")
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
    const res = await fetch(rssUrl, { cache: "no-store" })
    if (!res.ok) return []
    const xml = await res.text()
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    const extractTag = (block: string, tag: string) => {
      const pattern = `<(?:[a-zA-Z0-9]+:)?${tag}>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`
      const match = block.match(new RegExp(pattern, "i"))
      if (!match) return ""
      return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()
    }
    const rawItems: Array<{ title: string; url: string }> = []
    let m: RegExpExecArray | null
    while ((m = itemRegex.exec(xml))) {
      const block = m[1]
      const t = extractTag(block, "title") || "Untitled"
      const u = extractTag(block, "link") || ""
      if (!u) continue
      if (excludeUrl && u === excludeUrl) continue
      rawItems.push({ title: t, url: u })
      if (rawItems.length >= 10) break
    }

    const out: Array<{ title: string; url: string }> = []
    for (const it of rawItems) {
      try {
        const c = await classifyArticleAccess({ url: it.url, title: it.title, includeExtractedText: false })
        const resolved = (c.resolved_url || it.url || "").trim()
        const host = (() => {
          try {
            return new URL(resolved).hostname.replace(/^www\./, "").toLowerCase()
          } catch {
            return ""
          }
        })()
        if (host === "news.google.com" || host.endsWith(".news.google.com")) continue
        const isKnownPaywall = (KNOWN_PAYWALL_DOMAINS as readonly string[]).some(
          (d) => host === d || host.endsWith(`.${d}`)
        )
        if (c.access_status === "paywalled") continue
        if (isKnownPaywall) continue
        out.push({ title: it.title, url: resolved })
        if (out.length >= 3) break
      } catch {
        // ignore
      }
    }

    return out
  } catch {
    return []
  }
}

async function callAiJson(prompt: string, notes: string[]) {
  if (!getOpenAiApiKey()) return null
  return callOpenAiJson(
    {
      system:
        "Return ONLY valid JSON. Do not invent facts. Use your web search tool when needed to supplement the provided content.",
      user: prompt,
      tier: "fast",
      temperature: 0.2,
      maxTokens: 4000,
      webSearch: true,
    },
    notes
  )
}

function isDegradedBrief(brief: NewsBrief): boolean {
  if (brief.notes.some((n) => /openai call failed|could not find json|failed to parse json/i.test(n))) return true
  if (!brief.keyBullets.length) return true
  return false
}

/**
 * Cached entry point: each article's brief is generated once per calendar day
 * (keyed by URL + level) and served instantly afterwards. Degraded briefs
 * (AI failure/parse error) are never cached — they throw inside the cache
 * wrapper and we fall back to a fresh uncached attempt.
 */
export async function summarizeNewsItem(
  input: NewsSummaryInput & { level?: "national" | "florida" | "miami" }
): Promise<NewsBrief> {
  const day = newsCalendarDayET()
  const level = input.level ?? "national"
  const urlKey = normalizeUrlForKey(input.url || "") || `title:${(input.title || "").slice(0, 120)}`
  try {
    return await unstable_cache(
      async () => {
        const brief = await summarizeNewsItemUncached(input)
        if (isDegradedBrief(brief)) throw new Error("degraded brief — not caching")
        return brief
      },
      ["news-brief-v4", day, level, urlKey],
      { revalidate: NEWS_TAB_REVALIDATE_SECONDS }
    )()
  } catch {
    return summarizeNewsItemUncached(input)
  }
}

async function summarizeNewsItemUncached(
  input: NewsSummaryInput & { level?: "national" | "florida" | "miami" }
): Promise<NewsBrief> {
  const notes: string[] = []
  const title = (input.title || "").trim() || "Untitled"
  const url = (input.url || "").trim() || undefined
  const source = input.source
  const date = input.date
  const snippet = (input.summary || "").trim()

  const access = url
    ? await classifyArticleAccess({ url, title, includeExtractedText: true })
    : {
        access_status: "partial" as const,
        http_status: 0,
        content_length_chars: 0,
        extracted_text_length_chars: snippet.length,
        detection_reason: "missing_url",
        extracted_text: snippet,
      }

  const access_status = access.access_status
  const summarization_mode =
    access_status === "open"
      ? "full_summary"
      : access_status === "partial"
        ? "intelligence_brief"
        : "paywall_signal"
  const confidence_label: "High" | "Medium" | "Low" =
    access_status === "open" ? "High" : access_status === "partial" ? "Medium" : "Low"

  const banner =
    access_status === "open"
      ? undefined
      : "This source is paywalled or limited-access. This brief uses only publicly available information."

  const extractedText = (access.extracted_text || "").trim()
  const clippedText = extractedText ? safeTruncate(extractedText, 18_000) : ""

  // Optional related sources (open/partial only) when access is limited.
  const rssRelated =
    access_status === "open" ? [] : await fetchRelatedFromRss(input.level ?? "national", title, url)

  const backfillRelated =
    access_status === "open"
      ? []
      : await findOpenBackfillSources({
          title,
          date,
          level: input.level ?? "national",
          excludeUrl: url,
        })

  if (summarization_mode === "paywall_signal") {
    // The primary source is paywalled — reconstruct the story from open coverage
    // of the same event via web search, so the user still gets a full briefing.
    const prompt = `You are a senior market intelligence analyst at a distressed CRE debt investment firm.

The article below is PAYWALLED — you cannot read it directly. Use your web search tool to find OPEN coverage of the SAME story or event (other outlets, press releases, court records, trade publications) and reconstruct a comprehensive briefing from those open sources.
Do NOT invent facts. Only report what open sources support. If key details could not be confirmed, note them in redFlags.

PAYWALLED HEADLINE: ${title}
SOURCE: ${source || "Unknown"}
DATE: ${date || "Unknown"}
PUBLIC SNIPPET/PREVIEW: ${snippet || "[none]"}

Produce a COMPREHENSIVE briefing — not just a headline summary. An executive needs enough detail to decide whether to act or investigate further.

Return JSON with EXACT keys:
{
  "executiveSummary": "6-8 sentences covering: what happened, who is involved, key figures (dollar amounts, percentages, dates), geographic context, and direct implications for distressed CRE debt investors",
  "dealSpecifics": {
    "assetType": "property type if mentioned (office, multifamily, retail, etc.) or null",
    "location": "city/market if mentioned or null",
    "loanAmount": "dollar amount if mentioned or null",
    "lender": "lender name if mentioned or null",
    "borrower": "borrower/sponsor name if mentioned or null",
    "dealStatus": "open, closed, distressed, in workout, foreclosure, etc. or null"
  },
  "keyBullets": ["up to 10 bullets — each with a specific fact, figure, named entity, or date from open coverage. Lead with the most important."],
  "whyItMatters": ["up to 6 bullets — implications for distressed debt investors, lenders, or market participants"],
  "entities": ["named firms, individuals, properties, regulators — up to 15"],
  "redFlags": ["details that could not be confirmed from open sources, data gaps — up to 8"],
  "followUps": ["concrete next steps to validate or act on this — up to 6"],
  "relatedOpenSources": [{"title":"...","url":"..."}],
  "confidence": 0-100
}`

    const parsed = await callAiJson(prompt, notes)
    const modelRelated = parseRelatedFromModel(parsed?.relatedOpenSources)
    const validatedModelRelated = modelRelated.length ? await validateOpenSources(modelRelated) : []
    const merged = [...backfillRelated, ...rssRelated, ...validatedModelRelated]
    const relatedOpenSources = merged.length ? merged.slice(0, 5) : undefined

    const reconstructed =
      parsed && typeof parsed.executiveSummary === "string" && parsed.executiveSummary.trim()

    return {
      title,
      url,
      source,
      date,
      access_status,
      detection_reason: access.detection_reason,
      http_status: access.http_status,
      content_length_chars: access.content_length_chars,
      extracted_text_length_chars: access.extracted_text_length_chars,
      summarization_mode,
      confidence_label: reconstructed ? "Medium" : "Low",
      banner: reconstructed
        ? "The original article is paywalled. This brief was reconstructed from open coverage of the same story."
        : "This source is paywalled or limited-access. This brief is grounded in open sources (when available) plus any public snippet/preview.",
      executiveSummary: reconstructed
        ? parsed.executiveSummary.trim()
        : (snippet
            ? `${title} — ${snippet}`.slice(0, 360)
            : `${title}. This page appears paywalled or blocked; summary uses only public info.`.slice(0, 360)),
      dealSpecifics: parsed?.dealSpecifics ?? undefined,
      keyBullets: reconstructed
        ? asStringArray(parsed?.keyBullets, 10)
        : [
            `Access: paywalled/blocked (${access.detection_reason}).`,
            source ? `Source: ${source}.` : "Source not provided.",
            date ? `Date: ${date}.` : "Date not provided.",
          ],
      whyItMatters: reconstructed
        ? asStringArray(parsed?.whyItMatters, 6)
        : [
            "This headline may signal distress activity (special servicing, delinquencies, note sales, refinancing stress).",
            "Use open sources to confirm the facts before acting.",
          ],
      entities: asStringArray(parsed?.entities, 15),
      redFlags: reconstructed
        ? asStringArray(parsed?.redFlags, 8)
        : [
            "The full article could not be accessed; key details may be missing.",
            "Treat conclusions as directional until validated by an open source.",
          ],
      followUps: reconstructed
        ? asStringArray(parsed?.followUps, 6)
        : [
            "Find 1–2 open sources covering the same event.",
            "Confirm asset type, location, transaction size, and named counterparties.",
          ],
      confidence: reconstructed ? clampNumber(parsed?.confidence, 0, 100, 50) : 20,
      generatedAt: new Date().toISOString(),
      relatedOpenSources,
      notes,
    }
  }

  if (summarization_mode === "intelligence_brief") {
    const prompt = `You are a senior market intelligence analyst at a distressed CRE debt investment firm.

The article below is partially accessible. Use your live web search to find the full story, recent coverage, and related context about this topic. Combine what you find with the snippet/text provided.
Do NOT invent facts not supported by sources. If uncertain, note it in redFlags.

TITLE: ${title}
SOURCE: ${source || "Unknown"}
DATE: ${date || "Unknown"}
SNIPPET/PREVIEW: ${snippet || "[none]"}
PARTIAL EXTRACTED TEXT: ${clippedText || "[none]"}

Produce a COMPREHENSIVE briefing — not just a headline summary. An executive needs enough detail to decide whether to act or investigate further.

Return JSON with EXACT keys:
{
  "executiveSummary": "6-8 sentences covering: what happened, who is involved, key figures (dollar amounts, percentages, dates), geographic context, and direct implications for distressed CRE debt investors",
  "dealSpecifics": {
    "assetType": "property type if mentioned (office, multifamily, retail, etc.) or null",
    "location": "city/market if mentioned or null",
    "loanAmount": "dollar amount if mentioned or null",
    "lender": "lender name if mentioned or null",
    "borrower": "borrower/sponsor name if mentioned or null",
    "dealStatus": "open, closed, distressed, in workout, foreclosure, etc. or null"
  },
  "keyBullets": ["up to 10 bullets — each with a specific fact, figure, named entity, or date. Lead with the most important."],
  "whyItMatters": ["up to 6 bullets — implications for distressed debt investors, lenders, or market participants"],
  "entities": ["named firms, individuals, properties, regulators — up to 15"],
  "redFlags": ["data gaps, access limitations, unconfirmed claims — up to 8"],
  "followUps": ["concrete next steps to validate or act on this — up to 6"],
  "relatedOpenSources": [{"title":"...","url":"..."}],
  "confidence": 0-100
}`
    const parsed = await callAiJson(prompt, notes)
    const exec =
      parsed && typeof parsed.executiveSummary === "string" && parsed.executiveSummary.trim()
        ? parsed.executiveSummary.trim()
        : (snippet ? `${title} — ${snippet}` : title).slice(0, 320)

    const modelRelated = parseRelatedFromModel(parsed?.relatedOpenSources)
    const validatedModelRelated = modelRelated.length ? await validateOpenSources(modelRelated) : []
    const merged = [...backfillRelated, ...rssRelated, ...validatedModelRelated]
    const relatedOpenSources = merged.length ? merged.slice(0, 5) : undefined

    return {
      title,
      url,
      source,
      date,
      access_status,
      detection_reason: access.detection_reason,
      http_status: access.http_status,
      content_length_chars: access.content_length_chars,
      extracted_text_length_chars: access.extracted_text_length_chars,
      summarization_mode,
      confidence_label,
      banner,
      executiveSummary: exec,
      dealSpecifics: parsed?.dealSpecifics ?? undefined,
      keyBullets: asStringArray(parsed?.keyBullets, 10),
      whyItMatters: asStringArray(parsed?.whyItMatters, 6),
      entities: asStringArray(parsed?.entities, 15),
      redFlags: asStringArray(parsed?.redFlags, 8),
      followUps: asStringArray(parsed?.followUps, 6),
      confidence: clampNumber(parsed?.confidence, 0, 100, snippet ? 55 : 45),
      generatedAt: new Date().toISOString(),
      relatedOpenSources,
      notes,
    }
  }

  // full_summary
  const prompt = `You are a senior market intelligence analyst at a distressed CRE debt investment firm.

Read the full article text below carefully and produce a COMPREHENSIVE briefing — not a headline summary.
An executive needs enough detail to decide whether to act or investigate further.
Do NOT invent facts. Cite specific sentences from the article when making claims. If key details are missing, note them in redFlags.

TITLE: ${title}
SOURCE: ${source || "Unknown"}
DATE: ${date || "Unknown"}

FULL ARTICLE TEXT:
${clippedText || "[No extracted text]"}

Return JSON with EXACT keys:
{
  "executiveSummary": "6-8 sentences covering: what happened, who is involved (named firms, individuals), key figures (dollar amounts, percentages, loan sizes, dates), geographic context, and direct implications for distressed CRE debt investors",
  "dealSpecifics": {
    "assetType": "property type (office, multifamily, retail, industrial, mixed-use, etc.) or null",
    "location": "city/market or null",
    "loanAmount": "dollar amount of loan/deal or null",
    "lender": "lender or servicer name or null",
    "borrower": "borrower/sponsor name or null",
    "dealStatus": "open, closed, distressed, in workout, foreclosure, note sale, etc. or null"
  },
  "keyBullets": ["up to 10 bullets — each with a specific fact, figure, named entity, or date from the article. Lead with the most important."],
  "whyItMatters": ["up to 6 bullets — implications for distressed debt investors, lenders, or market participants"],
  "entities": ["all named firms, individuals, properties, regulators mentioned — up to 15"],
  "redFlags": ["missing data, unverified claims, access limitations, conflicts of interest — up to 8"],
  "followUps": ["concrete next steps to validate or act on this intelligence — up to 6"],
  "relatedOpenSources": [{"title":"...","url":"..."}],
  "confidence": 0-100
}`
  const parsed = await callAiJson(prompt, notes)
  const exec =
    parsed && typeof parsed.executiveSummary === "string" && parsed.executiveSummary.trim()
      ? parsed.executiveSummary.trim()
      : (snippet || title).slice(0, 320)

  const modelRelated = parseRelatedFromModel(parsed?.relatedOpenSources)
  const validatedModelRelated = modelRelated.length ? await validateOpenSources(modelRelated) : []
  const merged = [...backfillRelated, ...rssRelated, ...validatedModelRelated]
  const relatedOpenSources = merged.length ? merged.slice(0, 5) : undefined

  return {
    title,
    url,
    source,
    date,
    access_status,
    detection_reason: access.detection_reason,
    http_status: access.http_status,
    content_length_chars: access.content_length_chars,
    extracted_text_length_chars: access.extracted_text_length_chars,
    summarization_mode,
    confidence_label,
    banner,
    executiveSummary: exec,
    dealSpecifics: parsed?.dealSpecifics ?? undefined,
    keyBullets: asStringArray(parsed?.keyBullets, 10),
    whyItMatters: asStringArray(parsed?.whyItMatters, 6),
    entities: asStringArray(parsed?.entities, 15),
    redFlags: asStringArray(parsed?.redFlags, 8),
    followUps: asStringArray(parsed?.followUps, 6),
    confidence: clampNumber(parsed?.confidence, 0, 100, 70),
    generatedAt: new Date().toISOString(),
    relatedOpenSources,
    notes,
  }
}

