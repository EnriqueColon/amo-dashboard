
export type AccessStatus = "open" | "partial" | "paywalled"

export type ArticleAccessInfo = {
  access_status: AccessStatus
  resolved_url?: string
  http_status: number
  content_length_chars: number
  extracted_text_length_chars: number
  detection_reason: string
  extracted_text?: string
}

export const ACCESS_TEXT_MIN_CHARS = 1200
export const ACCESS_TEXT_TINY_CHARS = 200

export const KNOWN_PAYWALL_DOMAINS = [
  "wsj.com",
  "bloomberg.com",
  "ft.com",
  "nytimes.com",
  "economist.com",
  "theinformation.com",
  "theathletic.com",
] as const

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

function domainMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`)
}

function stripHtmlToText(html: string) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ")
  return withoutTags.replace(/\s+/g, " ").trim()
}

function hasLoginForm(htmlLower: string) {
  return (
    htmlLower.includes("type=\"password\"") ||
    htmlLower.includes("type='password'") ||
    (htmlLower.includes("<form") && (htmlLower.includes("log in") || htmlLower.includes("sign in")))
  )
}

function hasBotChallenge(htmlLower: string) {
  return (
    htmlLower.includes("verify you are human") ||
    htmlLower.includes("enable cookies") ||
    htmlLower.includes("cf-chl") ||
    htmlLower.includes("cloudflare") && htmlLower.includes("attention required")
  )
}

function detectPaywallMarkers(htmlLower: string) {
  // Strong markers: suggest a real access wall vs generic footer text.
  const strong = [
    "subscribe to continue",
    "subscribe now to continue",
    "subscribe to read",
    "subscribe to keep reading",
    "already a subscriber",
    "start your subscription",
    "sign in to continue",
    "log in to continue",
    "metered paywall",
    "you have reached your limit",
    "continue reading with a subscription",
    "to continue reading",
  ]
  for (const s of strong) {
    if (htmlLower.includes(s)) return { hit: true as const, reason: "subscribe_wall" as const }
  }

  // Weak markers: may appear on open pages; only use with low extracted text.
  const weak = ["subscribe", "subscription", "sign in", "log in", "paywall", "metered"]
  for (const w of weak) {
    if (htmlLower.includes(w)) return { hit: true as const, reason: "weak_paywall_marker" as const }
  }
  return { hit: false as const, reason: "" as const }
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "MarketIntelligence/1.0 (news-access@marketintel.local)",
        Accept: "text/html,*/*",
      },
    })
  } finally {
    clearTimeout(id)
  }
}

export async function classifyArticleAccess(options: {
  url: string
  title?: string
  includeExtractedText?: boolean
}): Promise<ArticleAccessInfo> {
  const url = (options.url || "").trim()
  const includeExtractedText = options.includeExtractedText ?? false
  if (!url) {
    return {
      access_status: "partial",
      resolved_url: undefined,
      http_status: 0,
      content_length_chars: 0,
      extracted_text_length_chars: 0,
      detection_reason: "missing_url",
      extracted_text: includeExtractedText ? "" : undefined,
    }
  }

  const host = hostOf(url)
  const knownPaywall = KNOWN_PAYWALL_DOMAINS.some((d) => domainMatches(host, d))

  // Google News RSS/article wrapper pages often don't contain enough readable text to classify.
  // Treat as partial so the UI doesn't show a misleading "paywalled" lock for the wrapper.
  if (domainMatches(host, "news.google.com")) {
    return {
      access_status: "partial",
      resolved_url: url,
      http_status: 200,
      content_length_chars: 0,
      extracted_text_length_chars: 0,
      detection_reason: "google_news_wrapper",
      extracted_text: includeExtractedText ? "" : undefined,
    }
  }

  let http_status = 0
  let html = ""
  let content_length_chars = 0
  let resolved_url: string | undefined = undefined
  try {
    const res = await fetchWithTimeout(url, 8_000)
    resolved_url = (res as any)?.url || undefined
    http_status = res.status
    if (!res.ok) {
      // Don’t break the pipeline: treat as limited access (cannot retrieve).
      return {
        access_status: "paywalled",
        resolved_url,
        http_status,
        content_length_chars: 0,
        extracted_text_length_chars: 0,
        detection_reason: http_status === 401 || http_status === 403 ? "http_401_403" : "http_error",
        extracted_text: includeExtractedText ? "" : undefined,
      }
    }
    html = await res.text()
    content_length_chars = html.length
  } catch (err) {
    console.warn("news_access: fetch failed", { url, host, err })
    return {
      access_status: "paywalled",
      resolved_url,
      http_status,
      content_length_chars: 0,
      extracted_text_length_chars: 0,
      detection_reason: "fetch_error",
      extracted_text: includeExtractedText ? "" : undefined,
    }
  }

  const htmlLower = html.toLowerCase()

  if (hasBotChallenge(htmlLower)) {
    return {
      access_status: "paywalled",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: 0,
      detection_reason: "bot_challenge",
      extracted_text: includeExtractedText ? "" : undefined,
    }
  }

  if (hasLoginForm(htmlLower)) {
    return {
      access_status: "paywalled",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: 0,
      detection_reason: "login_form",
      extracted_text: includeExtractedText ? "" : undefined,
    }
  }

  const markers = detectPaywallMarkers(htmlLower)
  const extracted = stripHtmlToText(html)
  const extractedLen = extracted.length

  // “Open” if we have substantial extracted text and no strong paywall signal.
  if (extractedLen >= ACCESS_TEXT_MIN_CHARS && markers.reason !== "subscribe_wall") {
    return {
      access_status: "open",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: extractedLen,
      detection_reason: knownPaywall ? "known_paywall_domain_but_text_ok" : "text_ok",
      extracted_text: includeExtractedText ? extracted : undefined,
    }
  }

  // Strong paywall marker wins.
  if (markers.reason === "subscribe_wall") {
    return {
      access_status: "paywalled",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: extractedLen,
      detection_reason: knownPaywall ? "known_paywall_domain" : "subscribe_wall",
      extracted_text: includeExtractedText ? extracted : undefined,
    }
  }

  // If weak markers + low text → treat as paywalled.
  if (markers.reason === "weak_paywall_marker" && extractedLen < ACCESS_TEXT_MIN_CHARS) {
    return {
      access_status: "paywalled",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: extractedLen,
      detection_reason: knownPaywall ? "known_paywall_domain" : "weak_paywall_marker",
      extracted_text: includeExtractedText ? extracted : undefined,
    }
  }

  // Otherwise: classify by extracted length.
  if (extractedLen >= ACCESS_TEXT_TINY_CHARS) {
    return {
      access_status: "partial",
      resolved_url,
      http_status,
      content_length_chars,
      extracted_text_length_chars: extractedLen,
      detection_reason: extractedLen < ACCESS_TEXT_MIN_CHARS ? "insufficient_text" : "unknown",
      extracted_text: includeExtractedText ? extracted : undefined,
    }
  }

  // Very little text available: treat as paywalled/blocked by default.
  return {
    access_status: "paywalled",
    resolved_url,
    http_status,
    content_length_chars,
    extracted_text_length_chars: extractedLen,
    detection_reason: knownPaywall ? "known_paywall_domain" : "insufficient_text",
    extracted_text: includeExtractedText ? extracted : undefined,
  }
}

