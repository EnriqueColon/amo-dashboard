/**
 * Market Research — routes for the tab ported from Market Intelligence.
 *
 * Two halves. The publisher feed (`/feed`): the daily sweep of fourteen
 * research publishers by OpenAI web search, cached per day in intel.db,
 * with everything found before today kept as an archive; a market memo can
 * be written from any selection. The firm's library (`/reports`, `/upload`
 * …): PDFs the team uploads, stored on disk, with metadata read from the
 * first pages and an OpenAI summary on request. No admin token anywhere —
 * the session is the only gate, by the owner's decision.
 */
import type { Express, Request, Response } from "express"
import { fetchResearchFeed, type ResearchReport } from "./feed"
import { generateResearchMemo } from "./memo"
import { countFeedArchive, deleteReport, getReport, getSummary, listReports, upsertResearchReport } from "./db"
import { deleteLocalReport, readLocalReport, saveReportToDisk } from "./storage"
import { detectProducerFromSignals, extractMetadataFromUpload, humanizeFilename, type ExtractedMetadata } from "./register-helpers"
import { summarizeUploadedReport } from "./summarize"
import { forgetKeysStartingWith } from "../cache-shim"

const MAX_UPLOAD = 25 * 1024 * 1024

function sendError(res: Response, err: unknown, status = 502) {
  res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
}

function safeFilename(input: string): string {
  const base = input.trim().replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim()
  if (!base) return "report.pdf"
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`
}

export function registerResearchRoutes(app: Express): void {
  // ── Publisher feed ───────────────────────────────────────────────────────
  app.get("/api/intel/research/feed", async (_req: Request, res: Response) => {
    try {
      const feed = await fetchResearchFeed()
      res.json({ ...feed, archiveTotal: countFeedArchive() })
    } catch (err) {
      sendError(res, err)
    }
  })

  // Forget today's sweep and run it again (the tool's Refresh button).
  app.post("/api/intel/research/feed/refresh", async (_req: Request, res: Response) => {
    try {
      forgetKeysStartingWith("research-feed-")
      const feed = await fetchResearchFeed()
      res.json({ ...feed, archiveTotal: countFeedArchive() })
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post("/api/intel/research/memo", async (req: Request, res: Response) => {
    const reports = Array.isArray(req.body?.reports) ? (req.body.reports as ResearchReport[]) : []
    if (reports.length === 0) return void res.status(400).json({ ok: false, error: "Select at least one report." })
    try {
      res.json(await generateResearchMemo(reports))
    } catch (err) {
      sendError(res, err)
    }
  })

  // ── The firm's library ───────────────────────────────────────────────────
  app.get("/api/intel/research/reports", (req: Request, res: Response) => {
    const s = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).trim() : "")
    try {
      res.json({ ok: true, items: listReports({ q: s("q") || undefined, producer: s("producer") || undefined, from: s("from") || undefined, to: s("to") || undefined }) })
    } catch (err) {
      sendError(res, err, 500)
    }
  })

  // One PDF as base64 JSON (client/src/lib/intel/research-api.ts); stored,
  // then registered with metadata read from its first pages.
  app.post("/api/intel/research/upload", async (req: Request, res: Response) => {
    const { name, type, base64 } = req.body ?? {}
    if (typeof base64 !== "string" || !base64) return void res.status(400).json({ ok: false, error: "No file." })
    const filename = String(name || "uploaded.pdf")
    if (!(String(type || "").includes("pdf") || filename.toLowerCase().endsWith(".pdf"))) {
      return void res.status(400).json({ ok: false, error: "Only PDF files are accepted." })
    }
    const bytes = Buffer.from(base64, "base64")
    if (bytes.length > MAX_UPLOAD) return void res.status(413).json({ ok: false, error: "File exceeds 25 MB." })
    if (bytes.length < 16) return void res.status(400).json({ ok: false, error: "Empty file." })
    try {
      const now = new Date()
      const stored = await saveReportToDisk(`market-research/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${Date.now()}-${filename}`, bytes)

      let extracted: ExtractedMetadata | null = null
      try {
        extracted = await Promise.race([extractMetadataFromUpload(stored.url), new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000))])
      } catch {
        extracted = null
      }
      const fallbackTitle = humanizeFilename(filename) || "Untitled Report"
      const title = extracted?.title || fallbackTitle
      const producer = extracted?.producer || detectProducerFromSignals(title, filename) || "unknown"
      const result = upsertResearchReport({
        producer,
        title,
        landingUrl: stored.url,
        documentUrl: stored.url,
        documentType: "pdf",
        publishedDate: extracted?.publishedDateISO,
        tags: {
          source: "manual_upload",
          originalFilename: filename,
          uploadedAt: now.toISOString(),
          metadataStatus: extracted ? "extracted" : "fallback",
          extractedMetadata: extracted ?? undefined,
        },
      })
      res.json({ ok: true, id: result.id, action: result.action, title, producer })
    } catch (err) {
      sendError(res, err, 500)
    }
  })

  app.post("/api/intel/research/summarize", async (req: Request, res: Response) => {
    const id = Number(req.body?.reportId)
    if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ ok: false, error: "Invalid report id." })
    try {
      const result = await summarizeUploadedReport(id)
      res.status(result.ok ? 200 : 400).json(result)
    } catch (err) {
      sendError(res, err, 500)
    }
  })

  app.get("/api/intel/research/summary", (req: Request, res: Response) => {
    const id = Number(req.query.reportId)
    if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ ok: false, error: "Invalid report id." })
    const summary = getSummary(id)
    if (!summary) return void res.status(404).json({ ok: false, error: "No summary yet." })
    res.json({ ok: true, summary })
  })

  app.get("/api/intel/research/report-file", async (req: Request, res: Response) => {
    const id = Number(req.query.id)
    if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ ok: false, error: "Invalid report id." })
    const report = getReport(id)
    if (!report) return void res.status(404).json({ ok: false, error: "Report not found." })
    const bytes = await readLocalReport(report.document_url)
    if (!bytes) return void res.status(404).json({ ok: false, error: "Report file is missing on disk." })
    const disposition = req.query.download === "1" ? "attachment" : "inline"
    res.setHeader("content-type", "application/pdf")
    res.setHeader("content-disposition", `${disposition}; filename="${safeFilename(report.title || `report-${id}.pdf`)}"`)
    res.setHeader("cache-control", "private, no-store, max-age=0")
    res.send(bytes)
  })

  app.post("/api/intel/research/delete", async (req: Request, res: Response) => {
    const id = Number(req.body?.id)
    if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ ok: false, error: "Invalid report id." })
    const row = deleteReport(id)
    if (!row) return void res.status(404).json({ ok: false, error: "Report not found." })
    await deleteLocalReport(row.document_url)
    res.json({ ok: true, id: row.id, title: row.title })
  })
}

/** Today's publisher sweep, for the daily warm-up. */
export async function warmResearch(): Promise<{ reports: number; notes: string[] }> {
  const feed = await fetchResearchFeed()
  return { reports: feed.reports.length, notes: feed.notes }
}
