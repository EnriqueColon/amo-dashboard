/**
 * Complaints (beta) — Miami-Dade circuit-civil foreclosure complaints (RPMF-Commercial and
 * RPMF-Non-Homestead), read from the tables collector/complaints_collect.py and
 * collector/complaints_extract.py fill: foreclosure_cases, foreclosure_extractions.
 *
 * Whether a case "qualifies" is worked out here from the stored extraction every time it is read;
 * it is never a stored label (owner decision 2 Nov 2026). The review list holds only cases that
 * qualify, or might, and have something a person must settle (an unresolved or missing address,
 * a missing principal, an unreadable reinstatement clause). Unresolved items on cases that do not
 * qualify are ignored. A person's answer goes in foreclosure_reviews and is never overwritten by
 * the pipeline.
 *
 * Endpoints (behind the same auth as the rest of /api):
 *   GET  /api/complaints/summary
 *   GET  /api/complaints?view=qualifying|review|all
 *   GET  /api/complaints/:caseId            (full detail incl. notes, properties, address readings)
 *   GET  /api/complaints/:caseId/page/:n    (PNG of one page of the complaint, for the review box)
 *   POST /api/complaints/:caseId/review     { decision, address?, note? }
 */
import type { Express, Request, Response } from 'express'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getDb } from './db'

const MODEL = process.env.COMPLAINTS_MODEL || 'gpt-5.5'

function ensureReviewTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS foreclosure_reviews (
      case_id TEXT PRIMARY KEY, decision TEXT NOT NULL, address TEXT, note TEXT, reviewed_at TEXT NOT NULL
    );`)
}

function tablesExist(): boolean {
  const t = getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('foreclosure_cases','foreclosure_extractions')`).all()
  return t.length === 2
}

type Row = {
  case_id: string; case_number: string; case_type: string; filing_date: string | null; case_style: string | null
  complaint_status: string; complaint_pdf: string | null; note: string | null
  result_json: string | null; extracted_at: string | null
  decision: string | null; review_address: string | null; review_note: string | null
}

const BASE_SQL = `
  SELECT c.case_id, c.case_number, c.case_type, c.filing_date, c.case_style, c.complaint_status,
         c.complaint_pdf, c.note, e.result_json, e.extracted_at,
         r.decision, r.address AS review_address, r.note AS review_note
  FROM foreclosure_cases c
  LEFT JOIN foreclosure_extractions e ON e.case_id = c.case_id AND e.model = ?
  LEFT JOIN foreclosure_reviews r ON r.case_id = c.case_id`

function shape(row: Row, detail = false) {
  const res = row.result_json ? JSON.parse(row.result_json) : null
  const notes: any[] = res?.notes ?? []
  const props: any[] = res?.properties ?? []
  const verdict: boolean | null | undefined = res ? res.computed_meets_criteria : undefined
  const reviewed = !!row.decision
  const principal = notes.length ? Math.max(...notes.map(n => n.test_principal ?? 0)) || null : null
  const first = props[0] ?? {}
  const address = row.decision === 'address_entered' ? row.review_address : first.property_address ?? null
  const out: any = {
    case_id: row.case_id, case_number: row.case_number, case_type: row.case_type,
    filing_date: row.filing_date, case_style: row.case_style,
    status: row.complaint_status === 'downloaded' ? (res ? 'extracted' : 'downloaded') : row.complaint_status,
    plaintiff: res?.plaintiff ?? null,
    is_foreclosure: res ? res.is_mortgage_foreclosure !== false : null,
    verdict: res == null ? 'pending' : verdict === true ? 'qualifies' : verdict === false ? 'no' : 'unclear',
    principal,
    default_date: notes[0]?.default_date ?? null,
    right_to_reinstate_clause: notes[0]?.right_to_reinstate_clause ?? null,
    address, address_source: first.address_source ?? null,
    properties: props.length, notes: notes.length,
    flags: res?.review_flags ?? [],
    needs_review: !!(res?.needs_review) && !reviewed,
    review_reasons: res?.review_reasons ?? [],
    review: reviewed ? { decision: row.decision, address: row.review_address, note: row.review_note } : null,
    extracted_at: row.extracted_at,
  }
  if (detail && res) {
    out.result = {
      defendants: res.defendants, attorney: res.attorney, guarantors: res.guarantors,
      foreclosure_reason: res.foreclosure_reason, lien_priority_quote: res.lien_priority_quote,
      notes, properties: props, county_court: res.county_court, date_filed: res.date_filed,
    }
  }
  return out
}

export function registerComplaintsRoutes(app: Express) {
  ensureReviewTable()

  app.get('/api/complaints/summary', (_req: Request, res: Response) => {
    if (!tablesExist()) return res.json({ active: false })
    const rows = (getDb().prepare(BASE_SQL).all(MODEL) as Row[]).map(r => shape(r))
    const count = (f: (r: any) => boolean) => rows.filter(f).length
    const last = getDb().prepare(`SELECT MAX(first_seen) AS t FROM foreclosure_cases`).get() as { t: string | null }
    res.json({
      active: true, model: MODEL, last_case_seen: last.t,
      cases: rows.length,
      commercial: count(r => r.case_type === 'RPMF-Commercial'),
      non_homestead: count(r => r.case_type === 'RPMF-Non-Homestead'),
      extracted: count(r => r.status === 'extracted'),
      not_public: count(r => r.status === 'complaint_not_public'),
      waiting: count(r => r.status === 'pending' || r.status === 'downloaded'),
      qualifies: count(r => r.verdict === 'qualifies'),
      unclear: count(r => r.verdict === 'unclear'),
      not_foreclosures: count(r => r.is_foreclosure === false),
      review_open: count(r => r.needs_review),
    })
  })

  app.get('/api/complaints', (req: Request, res: Response) => {
    if (!tablesExist()) return res.json({ active: false, rows: [] })
    const view = String(req.query.view ?? 'qualifying')
    let rows = (getDb().prepare(BASE_SQL + ' ORDER BY c.filing_date DESC, c.case_number DESC').all(MODEL) as Row[])
      .map(r => shape(r))
    if (view === 'qualifying') rows = rows.filter(r => r.verdict === 'qualifies' || r.verdict === 'unclear')
    else if (view === 'review') rows = rows.filter(r => r.needs_review)
    else if (view === 'not_public') rows = rows.filter(r => r.status === 'complaint_not_public')
    res.json({ active: true, view, rows: rows.slice(0, 1000) })
  })

  app.get('/api/complaints/:caseId', (req: Request, res: Response) => {
    if (!tablesExist()) return res.status(503).json({ error: 'not set up' })
    const row = getDb().prepare(BASE_SQL + ' WHERE c.case_id = ?').get(MODEL, req.params.caseId) as Row | undefined
    if (!row) return res.status(404).json({ error: 'case not found' })
    res.json(shape(row, true))
  })

  app.get('/api/complaints/:caseId/page/:n', (req: Request, res: Response) => {
    const n = Number(req.params.n)
    if (!Number.isInteger(n) || n < 1 || n > 1000) return res.status(400).json({ error: 'bad page' })
    const row = getDb().prepare(`SELECT complaint_pdf FROM foreclosure_cases WHERE case_id = ?`)
      .get(req.params.caseId) as { complaint_pdf: string | null } | undefined
    if (!row?.complaint_pdf || !fs.existsSync(row.complaint_pdf)) return res.status(404).json({ error: 'no document' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-page-'))
    const stem = path.join(dir, 'p')
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
    execFile('pdftoppm', ['-r', '110', '-f', String(n), '-l', String(n), '-png', '-singlefile', row.complaint_pdf, stem],
      { timeout: 30000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
      (err) => {
        try {
          if (err || !fs.existsSync(stem + '.png')) return res.status(500).json({ error: 'could not render the page' })
          res.setHeader('Content-Type', 'image/png')
          res.send(fs.readFileSync(stem + '.png'))
        } finally { cleanup() }
      })
  })

  app.post('/api/complaints/:caseId/review', (req: Request, res: Response) => {
    const { decision, address, note } = req.body ?? {}
    if (!['address_entered', 'no_address_in_complaint', 'dismissed'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be address_entered, no_address_in_complaint or dismissed' })
    }
    if (decision === 'address_entered' && !String(address ?? '').trim()) {
      return res.status(400).json({ error: 'type the address as printed in the complaint' })
    }
    const exists = getDb().prepare(`SELECT 1 FROM foreclosure_cases WHERE case_id = ?`).get(req.params.caseId)
    if (!exists) return res.status(404).json({ error: 'case not found' })
    getDb().prepare(`
      INSERT INTO foreclosure_reviews (case_id, decision, address, note, reviewed_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(case_id) DO UPDATE SET decision=excluded.decision, address=excluded.address,
        note=excluded.note, reviewed_at=excluded.reviewed_at`)
      .run(req.params.caseId, decision, decision === 'address_entered' ? String(address).trim() : null,
           note ? String(note).slice(0, 500) : null)
    res.json({ ok: true })
  })
}
