import { callOpenAiJson, getOpenAiApiKey } from "../openai"

// Centralized PDF extraction with multi-engine fallbacks + OCR.
// Kept in a separate module to avoid runtime/bundler crashes from PDF parsers.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { extractTextWithFallbacks, MIN_CHARS } from "./pdf-text-extraction.mjs"

export type ArticleDigest = {
  inputType: "url" | "text" | "file"
  inputLabel?: string
  extraction?: {
    text: string
    page_text: string[]
    method: "engineA" | "engineB" | "ocr"
    coverage: {
      num_pages: number
      pages_with_text: number
      total_chars: number
      chars_per_page: number[]
      used_ocr: boolean
    }
    errors: Array<{ stage: string; message: string; stack?: string }>
    notes?: string[]
  }
  executiveSummary: string
  keyBullets: string[]
  whyItMatters: string[]
  entities: string[]
  redFlags: string[]
  followUps: string[]
  confidence: number
  generatedAt: string
  notes?: string[]
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

function extractJsonObject(text: string) {
  const match = text.match(/\{[\s\S]*\}/)
  return match ? match[0] : undefined
}

function stripHtml(html: string) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ")
  return withoutTags.replace(/\s+/g, " ").trim()
}

function safeTruncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED: content exceeded ${maxChars} characters]`
}

function buildFallback(
  inputType: ArticleDigest["inputType"],
  inputLabel: string | undefined,
  sourceText: string | undefined,
  extraction?: ArticleDigest["extraction"],
  notes?: string[]
): ArticleDigest {
  const hasKey = Boolean(getOpenAiApiKey())
  notes?.push(
    hasKey
      ? "Using fallback digest (AI unavailable or parse failed)."
      : "OPENAI_API_KEY not found; using fallback digest."
  )

  const text = (sourceText || "").trim()
  const teaser = text ? safeTruncate(text, 420) : undefined

  return {
    inputType,
    inputLabel,
    extraction,
    executiveSummary:
      teaser ||
      "All extractors failed to produce readable text. The document may be image-only (scanned), encrypted/restricted, or requires OCR tools.",
    keyBullets: [
      teaser
        ? "This digest is based on extracted text (best-effort)."
        : "Primary extractors did not produce text; OCR may be required or tools may be missing.",
      "For higher accuracy, paste the most relevant sections (executive summary, terms, parties, numbers).",
    ],
    whyItMatters: [
      "This digest is intended to quickly identify asset type, geography, counterparties, and the core transaction/event.",
      "Use the original document/article to validate details before acting.",
    ],
    entities: [],
    redFlags: [
      "Some sources (paywalls / scanned PDFs) may prevent full text extraction.",
      "If only partial text was available, conclusions may be incomplete.",
    ],
    followUps: [
      "What are the named parties and their roles (buyer/seller/lender/servicer)?",
      "What asset type, location, and size are involved?",
      "What is the stated motivation (distress, refinancing, workout, portfolio sale)?",
    ],
    confidence: teaser ? 45 : 20,
    generatedAt: new Date().toISOString(),
    notes,
  }
}

async function callAi(prompt: string, notes: string[]): Promise<any | null> {
  if (!getOpenAiApiKey()) return null

  // No web search: digests must stay grounded in the provided text only.
  return callOpenAiJson(
    {
      system:
        "You are a careful analyst. Always respond with valid JSON only, matching the requested schema. Do not invent facts.",
      user: prompt,
      tier: "smart",
      temperature: 0.2,
      maxTokens: 1200,
    },
    notes
  )
}

function normalizeDigest(
  parsed: any,
  inputType: ArticleDigest["inputType"],
  inputLabel: string | undefined,
  fallbackText: string | undefined,
  extraction: ArticleDigest["extraction"] | undefined,
  notes: string[]
): ArticleDigest {
  const fallback = buildFallback(inputType, inputLabel, fallbackText, extraction, [])
  const executiveSummary =
    typeof parsed?.executiveSummary === "string" && parsed.executiveSummary.trim()
      ? parsed.executiveSummary.trim()
      : fallback.executiveSummary

  const coverage = extraction?.coverage
  const totalChars = coverage?.total_chars ?? (fallbackText ? fallbackText.length : 0)
  const pagesWithText = coverage?.pages_with_text ?? 0
  const numPages = coverage?.num_pages ?? 0
  const coverageRatio = numPages ? pagesWithText / Math.max(1, numPages) : pagesWithText > 0 ? 1 : 0
  const textStrength = Math.min(1, totalChars / 5000)
  const coverageCap = Math.round(100 * Math.min(1, 0.25 + 0.75 * Math.max(coverageRatio, textStrength)))

  const digest: ArticleDigest = {
    inputType,
    inputLabel,
    extraction,
    executiveSummary,
    keyBullets: asStringArray(parsed?.keyBullets, 10),
    whyItMatters: asStringArray(parsed?.whyItMatters, 8),
    entities: asStringArray(parsed?.entities, 18),
    redFlags: asStringArray(parsed?.redFlags, 10),
    followUps: asStringArray(parsed?.followUps, 10),
    confidence: Math.min(
      clampNumber(parsed?.confidence, 0, 100, fallback.confidence),
      coverageCap || 100
    ),
    generatedAt: new Date().toISOString(),
    notes,
  }

  if (digest.keyBullets.length === 0) digest.keyBullets = fallback.keyBullets
  if (digest.whyItMatters.length === 0) digest.whyItMatters = fallback.whyItMatters
  if (digest.redFlags.length === 0) digest.redFlags = fallback.redFlags
  if (digest.followUps.length === 0) digest.followUps = fallback.followUps

  return digest
}

export async function digestFromUrl(url: string): Promise<ArticleDigest> {
  const notes: string[] = []
  const cleanUrl = (url || "").trim()
  if (!cleanUrl) return buildFallback("url", undefined, undefined, undefined, ["No URL provided."])

  let extractedText: string | undefined
  let extraction: ArticleDigest["extraction"] | undefined
  try {
    const res = await fetch(cleanUrl, {
      // We do NOT want to cache user-provided sources.
      cache: "no-store",
      headers: {
        "User-Agent": "MarketIntelligence/1.0 (digest@marketintel.local)",
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*",
      },
    })
    if (res.ok) {
      const contentType = res.headers.get("content-type") || ""
      if (contentType.toLowerCase().includes("application/pdf")) {
        const ab = await res.arrayBuffer()
        const buf = Buffer.from(ab)
        const ex = await extractTextWithFallbacks(buf, { maxPages: 80, ocrPages: 3 })
        extraction = ex
        extractedText = ex.text ? safeTruncate(ex.text, 45_000) : undefined
        if (!extractedText) notes.push("PDF extraction returned empty after fallbacks.")
      } else {
        const body = await res.text()
        const stripped = stripHtml(body)
        extractedText = stripped ? safeTruncate(stripped, 45_000) : undefined
        if (!extractedText) notes.push("Fetched page but extracted text was empty.")
      }
    } else {
      notes.push(`Failed to fetch URL content: ${res.status} ${res.statusText}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
    notes.push(`URL fetch failed: ${message}`)
  }

  const extractionStatus = extraction
    ? `Extraction Status:
- method: ${extraction.method}
- pages: ${extraction.coverage.num_pages}
- pages_with_text: ${extraction.coverage.pages_with_text}
- total_chars: ${extraction.coverage.total_chars}
- used_ocr: ${extraction.coverage.used_ocr}
- errors: ${extraction.errors.length}`
    : "Extraction Status: (URL HTML extraction, no PDF extractor used)"

  const prompt = `You are a meticulous market intelligence analyst focused on distressed commercial real estate debt and related counterparties.

Create a "bullet-proof" digest of the provided content. Do NOT invent facts. If something isn't in the text, list it under redFlags and lower confidence.

If the content includes a transaction/event, extract: asset type, geography, sizes/amounts, parties, and what happened.

Content source: URL
URL: ${cleanUrl}

${extractionStatus}

EXTRACTED TEXT (may be truncated):
${extractedText ? extractedText : "[No extracted text was available; use best-effort from URL only, but do not guess facts.]"}

Return JSON with EXACT keys:
{
  "executiveSummary": "2-5 sentences, plain English, no hype",
  "keyBullets": ["... up to 10 bullets ..."],
  "whyItMatters": ["... up to 8 bullets ..."],
  "entities": ["... named entities (firms/people/agencies) if present ..."],
  "redFlags": ["... uncertainties, missing info, paywall limits ..."],
  "followUps": ["... concrete questions to validate/act ..."],
  "confidence": 0-100
}`

  try {
    const parsed = await callAi(prompt, notes)
    if (!parsed) return buildFallback("url", cleanUrl, extractedText, extraction, notes)
    return normalizeDigest(parsed, "url", cleanUrl, extractedText, extraction, notes)
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
    notes.push(`Digest failed: ${message}`)
    return buildFallback("url", cleanUrl, extractedText, extraction, notes)
  }
}

export async function digestFromText(text: string, label?: string): Promise<ArticleDigest> {
  const notes: string[] = []
  const t = (text || "").trim()
  if (!t) return buildFallback("text", label, undefined, undefined, ["No text provided."])

  const clipped = safeTruncate(t, 55_000)
  const prompt = `You are a meticulous market intelligence analyst focused on distressed commercial real estate debt and related counterparties.

Create a "bullet-proof" digest of the provided text. Do NOT invent facts. If something isn't in the text, list it under redFlags and lower confidence.

Extraction Status:
- method: raw_text
- total_chars: ${clipped.length}

TEXT (may be truncated):
${clipped}

Return JSON with EXACT keys:
{
  "executiveSummary": "2-5 sentences, plain English, no hype",
  "keyBullets": ["... up to 10 bullets ..."],
  "whyItMatters": ["... up to 8 bullets ..."],
  "entities": ["... named entities (firms/people/agencies) if present ..."],
  "redFlags": ["... uncertainties, missing info ..."],
  "followUps": ["... concrete questions to validate/act ..."],
  "confidence": 0-100
}`

  try {
    const parsed = await callAi(prompt, notes)
    if (!parsed) return buildFallback("text", label, clipped, undefined, notes)
    return normalizeDigest(parsed, "text", label, clipped, undefined, notes)
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
    notes.push(`Digest failed: ${message}`)
    return buildFallback("text", label, clipped, undefined, notes)
  }
}

export async function digestFromFile(formData: FormData): Promise<ArticleDigest> {
  const notes: string[] = []
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return buildFallback("file", undefined, undefined, undefined, ["No file uploaded."])
  }

  const maxBytes = 15 * 1024 * 1024
  if (file.size > maxBytes) {
    return buildFallback(
      "file",
      file.name,
      undefined,
      undefined,
      [`File is too large (${Math.round(file.size / (1024 * 1024))}MB). Max 15MB.`]
    )
  }

  const name = file.name || "uploaded-file"
  const type = (file.type || "").toLowerCase()
  const ab = await file.arrayBuffer()
  const buf = Buffer.from(ab)

  let extractedText: string | undefined
  let extraction: ArticleDigest["extraction"] | undefined
  try {
    if (type.includes("pdf") || name.toLowerCase().endsWith(".pdf")) {
      const ex = await extractTextWithFallbacks(buf, { maxPages: 80, ocrPages: 3 })
      extraction = ex
      extractedText = ex.text ? safeTruncate(ex.text, 55_000) : undefined
      if (!extractedText) notes.push("PDF extraction returned empty after fallbacks.")
    } else if (
      type.startsWith("text/") ||
      name.toLowerCase().endsWith(".txt") ||
      name.toLowerCase().endsWith(".md") ||
      name.toLowerCase().endsWith(".csv") ||
      name.toLowerCase().endsWith(".json") ||
      name.toLowerCase().endsWith(".html")
    ) {
      extractedText = safeTruncate(buf.toString("utf-8"), 55_000)
    } else {
      notes.push(`Unsupported file type: ${type || "unknown"}. Try PDF or a text-based file, or paste text.`)
      return buildFallback("file", name, undefined, undefined, notes)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
    notes.push(`Failed to extract file text: ${message}`)
    return buildFallback("file", name, undefined, extraction, notes)
  }

  const extractionStatus = extraction
    ? `Extraction Status:
- method: ${extraction.method}
- pages: ${extraction.coverage.num_pages}
- pages_with_text: ${extraction.coverage.pages_with_text}
- total_chars: ${extraction.coverage.total_chars}
- used_ocr: ${extraction.coverage.used_ocr}
- errors: ${extraction.errors.length}`
    : "Extraction Status: (non-PDF file)"

  const prompt = `You are a meticulous market intelligence analyst focused on distressed commercial real estate debt and related counterparties.

Create a "bullet-proof" digest of the provided document text. Do NOT invent facts. If something isn't in the text, list it under redFlags and lower confidence.

DOCUMENT NAME: ${name}
${extractionStatus}
TEXT (may be truncated):
${extractedText ? extractedText : "[No extracted text]"}

Return JSON with EXACT keys:
{
  "executiveSummary": "2-5 sentences, plain English, no hype",
  "keyBullets": ["... up to 10 bullets ..."],
  "whyItMatters": ["... up to 8 bullets ..."],
  "entities": ["... named entities (firms/people/agencies) if present ..."],
  "redFlags": ["... uncertainties, missing info ..."],
  "followUps": ["... concrete questions to validate/act ..."],
  "confidence": 0-100
}`

  try {
    const parsed = await callAi(prompt, notes)
    // Final guard: only claim "no readable text" after we truly have none.
    const totalChars = extraction?.coverage?.total_chars ?? (extractedText ? extractedText.length : 0)
    const pagesWithText = extraction?.coverage?.pages_with_text ?? 0
    if (!parsed) return buildFallback("file", name, extractedText, extraction, notes)
    if (totalChars >= MIN_CHARS || pagesWithText > 0) {
      return normalizeDigest(parsed, "file", name, extractedText, extraction, notes)
    }
    // If the extractors returned almost nothing, force a fallback digest that is honest about the outcome.
    notes.push("Extraction was below minimum coverage threshold; summary may be incomplete.")
    return normalizeDigest(parsed, "file", name, extractedText, extraction, notes)
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
    notes.push(`Digest failed: ${message}`)
    return buildFallback("file", name, extractedText, extraction, notes)
  }
}

