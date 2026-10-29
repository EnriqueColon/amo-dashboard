/**
 * Summarise an uploaded report: read the PDF from disk, extract its text
 * (pdftotext, then OCR for scanned pages), summarise with OpenAI; when the
 * text is too thin, hand the file itself to OpenAI (the tool's file
 * fallback). The summary is stored on intel.db under the report.
 */
import { getReport, saveSummary } from "./db"
import { readLocalReport, isLocalReportUrl } from "./storage"
import { extractTextWithFallbacks } from "../news/pdf-text-extraction.mjs"
import { summarizeReportPdfWithOpenAI, summarizeReportText, type ReportSummary } from "./summarizer"

export type StoredSummary = {
  executiveSummary: string
  keyTakeaways: string[]
  notableStats: string[]
  risks: string[]
  opportunities: string[]
  whatToWatch_30_90: string[]
  metadata: {
    producer: string
    title: string
    publishedDate?: string
    landingUrl: string
    documentUrl: string
    documentType: "pdf" | "html"
    summarizedAt: string
    warning?: string
  }
}

export async function summarizeUploadedReport(reportId: number): Promise<{ ok: true; summary: StoredSummary } | { ok: false; error: string }> {
  const report = getReport(reportId)
  if (!report) return { ok: false, error: "Report not found." }
  if (!isLocalReportUrl(report.document_url)) return { ok: false, error: "Only uploaded reports can be summarised here." }
  const bytes = await readLocalReport(report.document_url)
  if (!bytes) return { ok: false, error: "The report file is missing on disk." }

  let text = ""
  try {
    const extraction = await extractTextWithFallbacks(bytes, { maxPages: 20, ocrPages: 3 })
    text = String(extraction?.text ?? "").trim()
  } catch {
    text = ""
  }

  let aiSummary: ReportSummary | null = null
  let warning: string | undefined
  if (text.length >= 100) {
    aiSummary = await summarizeReportText(text, report.title, report.producer)
  }
  if (!aiSummary) {
    aiSummary = await summarizeReportPdfWithOpenAI(bytes, report.title, report.producer)
    if (aiSummary) warning = "Summary generated from the file itself because direct text extraction was limited."
  }
  if (!aiSummary) return { ok: false, error: "AI summarisation failed: neither the extracted text nor the file produced a usable summary." }

  const summary: StoredSummary = {
    executiveSummary: aiSummary.summary || "",
    keyTakeaways: aiSummary.bullets || [],
    notableStats: [],
    risks: [],
    opportunities: [],
    whatToWatch_30_90: [],
    metadata: {
      producer: report.producer,
      title: report.title,
      publishedDate: report.published_date ?? undefined,
      landingUrl: report.landing_url,
      documentUrl: report.document_url,
      documentType: report.document_type,
      summarizedAt: new Date().toISOString(),
      warning,
    },
  }
  saveSummary(report.id, summary)
  return { ok: true, summary }
}
