/**
 * Market Research tables on intel.db — the tool's three Postgres tables
 * (research_reports, research_summaries, research_feed_cache) as SQLite,
 * with the same columns, behind plain functions instead of SQL at every
 * call site. Created on first use.
 */
import { createHash } from "crypto"
import { getIntelDb } from "../db"
import type { ArchivedReport, ResearchReport } from "./feed"

let ready = false
function db() {
  const d = getIntelDb()
  if (!ready) {
    d.exec(`
      -- Reports the firm holds: uploaded PDFs (document_url local-report://…) and,
      -- if producer ingestion is ever ported, discovered publications.
      CREATE TABLE IF NOT EXISTS research_reports (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        producer       TEXT NOT NULL,
        title          TEXT NOT NULL,
        landing_url    TEXT NOT NULL,
        document_url   TEXT NOT NULL,
        document_type  TEXT NOT NULL,
        published_date TEXT,
        tags           TEXT NOT NULL DEFAULT '{}',
        url_hash       TEXT NOT NULL UNIQUE,
        discovered_at  TEXT NOT NULL,
        last_seen_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_summaries (
        report_id      INTEGER PRIMARY KEY,
        summary_json   TEXT NOT NULL,
        model_provider TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      -- Publications found by the daily publisher sweep, kept a year so the
      -- page can show what was found before today.
      CREATE TABLE IF NOT EXISTS research_feed_cache (
        report_key     TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        publisher      TEXT NOT NULL,
        published_date TEXT,
        topic          TEXT,
        summary        TEXT,
        key_findings   TEXT NOT NULL DEFAULT '[]',
        url            TEXT,
        fetched_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_feed_cache_fetched ON research_feed_cache(fetched_at);
    `)
    ready = true
  }
  return d
}

const now = () => new Date().toISOString()

export type ReportRow = {
  id: number
  producer: string
  title: string
  landing_url: string
  document_url: string
  document_type: "pdf" | "html"
  published_date: string | null
  tags: Record<string, unknown>
  discovered_at: string
  last_seen_at: string
  has_summary: boolean
}

export type UpsertReportInput = {
  producer: string
  title: string
  landingUrl: string
  documentUrl: string
  documentType: "pdf" | "html"
  publishedDate?: string
  tags?: Record<string, unknown>
}

function normalizeDate(input?: string): string | null {
  if (!input) return null
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** The tool's upsert: keyed on the document URL's hash, the longer title wins, tags merge. */
export function upsertResearchReport(input: UpsertReportInput): { id: number; action: "inserted" | "updated" } {
  const d = db()
  const hash = createHash("sha256").update(input.documentUrl || input.landingUrl).digest("hex")
  const existing = d.prepare("SELECT id, title, tags, published_date FROM research_reports WHERE url_hash = ?").get(hash) as
    | { id: number; title: string; tags: string; published_date: string | null }
    | undefined
  const ts = now()
  if (!existing) {
    const r = d
      .prepare(
        `INSERT INTO research_reports (producer, title, landing_url, document_url, document_type, published_date, tags, url_hash, discovered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.producer, input.title, input.landingUrl, input.documentUrl, input.documentType, normalizeDate(input.publishedDate), JSON.stringify(input.tags ?? {}), hash, ts, ts)
    return { id: Number(r.lastInsertRowid), action: "inserted" }
  }
  let tags: Record<string, unknown> = {}
  try {
    tags = JSON.parse(existing.tags || "{}")
  } catch {
    tags = {}
  }
  const merged = Object.keys(tags).length === 0 ? input.tags ?? {} : { ...tags, ...(input.tags ?? {}) }
  d.prepare(
    `UPDATE research_reports SET producer = ?, title = ?, landing_url = ?, document_url = ?, document_type = ?,
       published_date = COALESCE(?, published_date), tags = ?, last_seen_at = ? WHERE id = ?`
  ).run(
    input.producer,
    input.title.length > existing.title.length ? input.title : existing.title,
    input.landingUrl,
    input.documentUrl,
    input.documentType,
    normalizeDate(input.publishedDate),
    JSON.stringify(merged),
    ts,
    existing.id
  )
  return { id: existing.id, action: "updated" }
}

function toRow(r: Record<string, unknown>): ReportRow {
  let tags: Record<string, unknown> = {}
  try {
    tags = JSON.parse(String(r.tags ?? "{}"))
  } catch {
    tags = {}
  }
  return {
    id: Number(r.id),
    producer: String(r.producer),
    title: String(r.title),
    landing_url: String(r.landing_url),
    document_url: String(r.document_url),
    document_type: r.document_type === "html" ? "html" : "pdf",
    published_date: (r.published_date as string | null) ?? null,
    tags,
    discovered_at: String(r.discovered_at),
    last_seen_at: String(r.last_seen_at),
    has_summary: Boolean(r.has_summary),
  }
}

export function listReports(filter: { q?: string; producer?: string; from?: string; to?: string } = {}): ReportRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.q) {
    where.push("(lower(rr.title) LIKE ? OR lower(rr.document_url) LIKE ? OR lower(rr.tags) LIKE ?)")
    const like = `%${filter.q.toLowerCase()}%`
    params.push(like, like, like)
  }
  if (filter.producer) {
    where.push("rr.producer = ?")
    params.push(filter.producer)
  }
  if (filter.from) {
    where.push("rr.published_date >= ?")
    params.push(filter.from)
  }
  if (filter.to) {
    where.push("rr.published_date <= ?")
    params.push(filter.to)
  }
  const rows = db()
    .prepare(
      `SELECT rr.*, (rs.report_id IS NOT NULL) AS has_summary
         FROM research_reports rr LEFT JOIN research_summaries rs ON rs.report_id = rr.id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY COALESCE(rr.published_date, substr(rr.discovered_at, 1, 10)) DESC, rr.discovered_at DESC
        LIMIT 500`
    )
    .all(...params) as Record<string, unknown>[]
  return rows.map(toRow)
}

export function getReport(id: number): ReportRow | null {
  const r = db()
    .prepare("SELECT rr.*, (rs.report_id IS NOT NULL) AS has_summary FROM research_reports rr LEFT JOIN research_summaries rs ON rs.report_id = rr.id WHERE rr.id = ?")
    .get(id) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

export function deleteReport(id: number): ReportRow | null {
  const row = getReport(id)
  if (!row) return null
  const d = db()
  d.transaction(() => {
    d.prepare("DELETE FROM research_summaries WHERE report_id = ?").run(id)
    d.prepare("DELETE FROM research_reports WHERE id = ?").run(id)
  })()
  return row
}

export function getSummary(reportId: number): unknown | null {
  const r = db().prepare("SELECT summary_json FROM research_summaries WHERE report_id = ?").get(reportId) as { summary_json: string } | undefined
  if (!r) return null
  try {
    return JSON.parse(r.summary_json)
  } catch {
    return null
  }
}

export function saveSummary(reportId: number, summary: unknown, provider = "openai"): void {
  const ts = now()
  db()
    .prepare(
      `INSERT INTO research_summaries (report_id, summary_json, model_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(report_id) DO UPDATE SET summary_json = excluded.summary_json, model_provider = excluded.model_provider, updated_at = excluded.updated_at`
    )
    .run(reportId, JSON.stringify(summary), provider, ts, ts)
}

/** The daily sweep's publications, upserted by publisher + title, with entries older than a year purged. */
export function saveFeedReports(reports: ResearchReport[]): number {
  const d = db()
  const ts = now()
  const up = d.prepare(
    `INSERT INTO research_feed_cache (report_key, title, publisher, published_date, topic, summary, key_findings, url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(report_key) DO UPDATE SET topic = excluded.topic, summary = excluded.summary, key_findings = excluded.key_findings, url = excluded.url, fetched_at = excluded.fetched_at`
  )
  let saved = 0
  d.transaction(() => {
    for (const r of reports) {
      const key = `${r.publisher.toLowerCase().trim()}::${r.title.toLowerCase().trim()}`.slice(0, 500)
      up.run(key, r.title, r.publisher, r.publishedDate || null, r.topic || "Market Outlook", r.summary || null, JSON.stringify(r.keyFindings ?? []), r.url || null, ts)
      saved++
    }
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    d.prepare("DELETE FROM research_feed_cache WHERE fetched_at < ?").run(cutoff)
  })()
  return saved
}

export function loadFeedArchive(): ArchivedReport[] {
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
  const rows = db()
    .prepare("SELECT * FROM research_feed_cache WHERE fetched_at >= ? ORDER BY fetched_at DESC, publisher ASC LIMIT 500")
    .all(cutoff) as Array<Record<string, unknown>>
  return rows.map((r) => {
    let keyFindings: string[] = []
    try {
      const parsed = JSON.parse(String(r.key_findings ?? "[]"))
      if (Array.isArray(parsed)) keyFindings = parsed.filter((x): x is string => typeof x === "string")
    } catch {
      keyFindings = []
    }
    return {
      id: String(r.report_key),
      title: String(r.title),
      publisher: String(r.publisher),
      publishedDate: String(r.published_date ?? ""),
      topic: String(r.topic ?? "Market Outlook"),
      summary: String(r.summary ?? ""),
      keyFindings,
      url: String(r.url ?? ""),
      fetchedAt: String(r.fetched_at),
    }
  })
}

export function countFeedArchive(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM research_feed_cache").get() as { n: number }).n
}
