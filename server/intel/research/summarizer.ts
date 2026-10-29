/**
 * Summarizes extracted report text using OpenAI API.
 */

export type ReportSummary = {
  summary: string
  bullets: string[]
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    task,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ])
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function extractJsonObject(text: string): string | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  return match ? match[0] : undefined
}

async function callOpenAI(prompt: string): Promise<ReportSummary | null> {
  const API_KEY = process.env.OPENAI_API_KEY?.trim()
  if (!API_KEY) return null

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_SUMMARY_MODEL?.trim() || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a commercial real estate analyst. Respond with valid JSON only. Do not invent facts.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
    cache: "no-store",
  })

  if (!response.ok) return null

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string" || !content.trim()) return null

  const jsonText = extractJsonObject(content)
  if (!jsonText) return null

  try {
    const parsed = JSON.parse(jsonText)
    const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : ""
    const bullets = Array.isArray(parsed?.bullets)
      ? parsed.bullets.filter((b: unknown) => typeof b === "string").map((b: string) => b.trim()).filter(Boolean)
      : []
    if (summary || bullets.length > 0) {
      return { summary: summary || bullets[0] || "", bullets }
    }
    return null
  } catch {
    return null
  }
}

function parseSummaryJson(raw: string): ReportSummary | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText)
    const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : ""
    const bullets = Array.isArray(parsed?.bullets)
      ? parsed.bullets
          .filter((b: unknown) => typeof b === "string")
          .map((b: string) => b.trim())
          .filter(Boolean)
      : []
    if (summary || bullets.length > 0) {
      return { summary: summary || bullets[0] || "", bullets }
    }
    return null
  } catch {
    return null
  }
}

function readResponsesOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text
  }
  const chunks: string[] = []
  const output = Array.isArray(data?.output) ? data.output : []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) {
        chunks.push(c.text)
      }
    }
  }
  return chunks.join("\n").trim()
}

/**
 * Strong fallback for scanned/image-heavy PDFs:
 * upload PDF to OpenAI and ask for structured summary JSON directly from file contents.
 */
export async function summarizeReportPdfWithOpenAI(
  pdfBytes: Buffer,
  reportTitle: string,
  reportSource: string
): Promise<ReportSummary | null> {
  const API_KEY = process.env.OPENAI_API_KEY?.trim()
  if (!API_KEY || !pdfBytes?.length) return null

  const uploadTimeoutMs = envInt("OPENAI_PDF_UPLOAD_TIMEOUT_MS", 20000)
  const summaryTimeoutMs = envInt("OPENAI_PDF_SUMMARY_TIMEOUT_MS", 35000)

  let fileId: string | null = null
  try {
    const fileForm = new FormData()
    fileForm.append("purpose", "user_data")
    fileForm.append(
      "file",
      new Blob([pdfBytes], { type: "application/pdf" }),
      "report.pdf"
    )

    const fileRes = await withTimeout(
      fetch("https://api.openai.com/v1/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
        body: fileForm,
        cache: "no-store",
      }),
      uploadTimeoutMs,
      "OpenAI file upload timed out."
    )
    if (!fileRes.ok) return null
    const fileJson = await fileRes.json()
    fileId = typeof fileJson?.id === "string" ? fileJson.id : null
    if (!fileId) return null

    const prompt = `Summarize this commercial real estate PDF report.
Report: ${reportTitle}
Source: ${reportSource}

Return JSON with EXACT keys:
{
  "summary": "2-4 sentence executive summary",
  "bullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"]
}`

    const responseRes = await withTimeout(
      fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_SUMMARY_PDF_MODEL?.trim() || "gpt-4o",
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: "You are a commercial real estate analyst. Respond with valid JSON only. Do not invent facts.",
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_file", file_id: fileId },
              ],
            },
          ],
          max_output_tokens: 1200,
        }),
        cache: "no-store",
      }),
      summaryTimeoutMs,
      "OpenAI PDF summary timed out."
    )
    if (!responseRes.ok) return null
    const responseJson = await responseRes.json()
    const outputText = readResponsesOutputText(responseJson)
    if (!outputText) return null
    return parseSummaryJson(outputText)
  } catch {
    return null
  } finally {
    if (fileId) {
      void fetch(`https://api.openai.com/v1/files/${fileId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
      }).catch(() => {})
    }
  }
}

/**
 * Summarize extracted report text into executive summary + bullets.
 */
export async function summarizeReportText(
  text: string,
  reportTitle: string,
  reportSource: string
): Promise<ReportSummary | null> {
  const clipped = text.length > 40_000 ? text.slice(0, 40_000) + "\n\n[Content truncated...]" : text

  const prompt = `Summarize this commercial real estate report in 3-5 bullet points. Focus on key rankings, outlook, and actionable insights. Max 300 words for the summary.

Report: ${reportTitle}
Source: ${reportSource}

EXTRACTED TEXT:
${clipped}

Return JSON with EXACT keys:
{
  "summary": "2-4 sentence executive summary",
  "bullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"]
}`

  return callOpenAI(prompt)
}
