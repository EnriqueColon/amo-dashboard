/**
 * Shared OpenAI API client (Responses API).
 * Replaces the previous Anthropic (Claude) integration in lib/claude.ts.
 *
 * Tiers mirror the old Claude model split:
 * - "fast"  (was claude-haiku-4-5)  → gpt-4.1-mini
 * - "smart" (was claude-sonnet-4-6) → gpt-4.1-mini (upgrade via OPENAI_SMART_MODEL)
 *
 * Web search is OpenAI's hosted `web_search` tool on the Responses API and is
 * enabled per call site only where live grounding is actually needed.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
const DEFAULT_TIMEOUT_MS = 55_000

export type OpenAiTier = "fast" | "smart"

function modelForTier(tier: OpenAiTier): string {
  // Both tiers default to gpt-4.1-mini: cheap, supports web search, and does
  // NOT require OpenAI organization verification (gpt-5 models do).
  // Set OPENAI_SMART_MODEL / OPENAI_FAST_MODEL to upgrade (e.g. gpt-5-mini
  // after verifying the org at platform.openai.com/settings/organization).
  if (tier === "smart") {
    return process.env.OPENAI_SMART_MODEL?.trim() || "gpt-4.1-mini"
  }
  return process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4.1-mini"
}

/** GPT-5 / o-series reasoning models reject sampling params like temperature. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model)
}

export function getOpenAiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined
}

export type CallOpenAiOptions = {
  system: string
  user: string
  /** "fast" = gpt-5-mini (default), "smart" = OPENAI_SMART_MODEL or gpt-5-mini */
  tier?: OpenAiTier
  maxTokens?: number
  /** Ignored for reasoning models (gpt-5 family), which reject it. */
  temperature?: number
  /** Enable OpenAI's hosted web search tool. */
  webSearch?: boolean
  /**
   * Restrict hosted web search to these hosts, so an unrecognized source never
   * enters the model's context. Opt-in per call site: omit it and search behaves
   * exactly as before.
   *
   * Requires a model that supports the tool's `filters` parameter — the mini
   * models reject it — so pass `searchFilterModel` alongside, or the request
   * falls back to unrestricted search. Ignored unless `webSearch` is true.
   */
  searchAllowedDomains?: string[]
  /**
   * Model to use when `searchAllowedDomains` is set, overriding the tier.
   * Defaults to OPENAI_SEARCH_FILTER_MODEL or gpt-4.1: as of this writing
   * gpt-4.1-mini and gpt-4o-mini return 400 for `filters`.
   */
  searchFilterModel?: string
  /** Exact model, overriding the tier. For call sites whose output is checked and cached. */
  model?: string
  timeoutMs?: number
}

type ResponsesOutputContent = {
  type: string
  text?: string
}

type ResponsesOutputItem = {
  type: string
  content?: ResponsesOutputContent[]
}

type ResponsesApiResponse = {
  output?: ResponsesOutputItem[]
  output_text?: string
  status?: string
  error?: { code?: string; message?: string } | null
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

/**
 * OpenAI's hosted web search inserts inline markdown citations into the output
 * text — e.g. "([trepp.com](https://trepp.com/...?utm_source=openai))" — and
 * appends a utm_source tracking param to cited URLs. The app renders plain
 * text (and parses JSON), so the markup has to go.
 *
 * The publisher name is kept as a plain-text attribution, e.g. "(trepp.com)":
 * these citations are the only audit trail behind a figure, and deleting them
 * outright leaves bare unverifiable numbers in the memo.
 */
function stripInlineCitations(text: string): string {
  let out = text

  // Parenthesized citation clusters: "([a.com](url))" or "([a](u1), [b](u2))".
  out = out.replace(/\s*\((?:\s*[,;]?\s*\[[^\]]*\]\([^)\s]*\))+\s*\)/g, (cluster) => {
    const publishers: string[] = []
    const linkPattern = /\[([^\]]*)\]\(([^)\s]*)\)/g
    let match: RegExpExecArray | null
    while ((match = linkPattern.exec(cluster))) {
      const label = match[1].trim()
      // Bare-domain labels are already the publisher; otherwise use the host.
      const name = /^[\w.-]+\.[a-z]{2,}$/i.test(label) ? label.toLowerCase() : hostnameOf(match[2])
      if (name && !publishers.includes(name)) publishers.push(name)
    }
    return publishers.length ? ` (${publishers.join(", ")})` : ""
  })

  // Remaining inline markdown links. Bare-domain labels are citations — keep
  // just the URL (useful in source lists, rare in prose). Descriptive labels
  // become "label — url" to match the app's plain-text source format.
  out = out.replace(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const cleanLabel = label.trim()
      if (!cleanLabel || /^[\w.-]+\.[a-z]{2,}$/i.test(cleanLabel)) return url
      return `${cleanLabel} — ${url}`
    }
  )

  // Tracking param OpenAI appends to cited URLs.
  out = out.replace(/\?utm_source=openai&/g, "?").replace(/[?&]utm_source=openai/g, "")

  // Tidy whitespace left behind by removed citations.
  return out.replace(/[ \t]+([.,;])/g, "$1").replace(/[ \t]{2,}/g, " ")
}

function searchFilterModel(explicit?: string): string {
  return explicit?.trim() || process.env.OPENAI_SEARCH_FILTER_MODEL?.trim() || "gpt-4.1"
}

/** A 400 naming the tool's `filters` parameter — the model does not support it. */
function isSearchFilterRejection(err: unknown): boolean {
  return err instanceof Error && /OpenAI API error 400/.test(err.message) && /filters/i.test(err.message)
}

async function postResponses(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    })

    if (!res.ok) {
      let detail = ""
      try {
        const errJson = (await res.json()) as ResponsesApiResponse
        detail = errJson?.error?.message ? `: ${errJson.error.message}` : ""
      } catch {
        /* keep status-only message */
      }
      throw new Error(`OpenAI API error ${res.status}${detail}`)
    }

    const data = (await res.json()) as ResponsesApiResponse

    if (data.error?.message) {
      throw new Error(`OpenAI API error: ${data.error.message}`)
    }

    // Prefer the convenience field when present; otherwise concatenate the
    // text parts of message output items (web_search_call items carry no text).
    let text = (data.output_text || "").trim()
    if (!text) {
      text = (data.output || [])
        .filter((item) => item.type === "message" && Array.isArray(item.content))
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("")
        .trim()
    }

    text = stripInlineCitations(text).trim()

    if (!text) throw new Error("OpenAI returned an empty response")
    return text
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Calls the OpenAI Responses API and returns the concatenated text output.
 * Throws on missing key, HTTP error, timeout, or empty response.
 */
export async function callOpenAi(options: CallOpenAiOptions): Promise<string> {
  const apiKey = getOpenAiApiKey()
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY")

  const {
    system,
    user,
    tier = "fast",
    maxTokens = 1200,
    temperature = 0.2,
    webSearch = false,
    searchAllowedDomains,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const restrictSearch = Boolean(webSearch && searchAllowedDomains?.length)

  const buildBody = (model: string, tools?: unknown[]): Record<string, unknown> => {
    const reasoning = isReasoningModel(model)
    const body: Record<string, unknown> = {
      model,
      // Reasoning tokens count against max_output_tokens on GPT-5 models, so we
      // add headroom to preserve the visible-output budget call sites expect.
      max_output_tokens: reasoning ? maxTokens + 2000 : maxTokens,
      instructions: system,
      input: user,
    }
    if (reasoning) {
      // "low" keeps latency close to the old Haiku calls while still supporting
      // web search (which rejects "minimal").
      body.reasoning = { effort: "low" }
    } else {
      body.temperature = temperature
    }
    if (tools) body.tools = tools
    return body
  }

  const unrestricted = () =>
    postResponses(
      apiKey,
      buildBody(options.model?.trim() || modelForTier(tier), webSearch ? [{ type: "web_search" }] : undefined),
      timeoutMs
    )

  if (!restrictSearch) return unrestricted()

  const filtered = buildBody(searchFilterModel(options.searchFilterModel), [
    { type: "web_search", filters: { allowed_domains: searchAllowedDomains } },
  ])

  try {
    return await postResponses(apiKey, filtered, timeoutMs)
  } catch (err) {
    // Never let an unsupported parameter take a feature down: degrade to
    // unrestricted search, which the downstream evidence guard still covers.
    if (!isSearchFilterRejection(err)) throw err
    console.warn(
      `openai: web_search domain filtering rejected by ${filtered.model}; retrying unrestricted. ${(err as Error).message}`
    )
    return unrestricted()
  }
}

/**
 * Calls OpenAI and extracts the first JSON object from the response.
 * Returns null if the call fails or no parseable JSON is found.
 */
export async function callOpenAiJson(
  options: CallOpenAiOptions,
  notes?: string[]
): Promise<any | null> {
  try {
    const text = await callOpenAi(options)
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      notes?.push("Could not find JSON object in OpenAI response.")
      return null
    }
    try {
      return JSON.parse(match[0])
    } catch {
      notes?.push("Failed to parse JSON from OpenAI response.")
      return null
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    notes?.push(`OpenAI call failed: ${message}`)
    return null
  }
}
