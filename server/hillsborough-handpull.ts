/**
 * Manual Complaint Intake: counties whose complaints a person downloads (HAND_COUNTIES).
 * Hillsborough (trial from 16 Nov 2026) and Broward (added 16 Nov 2026; case list from lis pendens in the
 * county feed, collector/broward_complaints_intake.py; the person skips Homestead cases on the case page).
 *
 * The Clerk's document site (HOVER) blocks programs, so a person downloads each complaint in a normal
 * browser and drops the PDF on the #/complaint-intake (Data → Manual Complaint Intake) page. Everything else is automatic:
 *   - collector/run_hillsborough_handpull_daily.sh stores each day's new Commercial / Non-Homestead
 *     foreclosures from the Clerk's free daily case file; the $250,000-or-more band is "To download";
 *   - an upload is saved to COMPLAINTS_DIR, marked downloaded, and read at once by
 *     `hillsborough_complaints.py --read-case` (same reader and $500,000 test as every other county).
 * Uploaded (read) Hillsborough complaints show on the Complaints tab like any county (owner, 16 Nov 2026);
 * the Monday email leaves them out until the trial is agreed (EMAIL_COMPLAINTS_SQL).
 * This server never contacts HOVER.
 *
 *   GET  /api/hillsborough-test                    to-download list, done list, per-day counts
 *   POST /api/hillsborough-test/:caseId/upload     body: the PDF (Content-Type: application/pdf)
 *   POST /api/hillsborough-test/:caseId/skip       { reason }  e.g. complaint not on HOVER yet
 *   POST /api/hillsborough-test/:caseId/unskip
 *   POST /api/hillsborough-test/:caseId/reread     read the stored PDF again (after a failed read)
 */
import express, { type Express, type Request, type Response } from 'express'
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getDb } from './db'
import { shape, type Row } from './complaints'

const MODEL = process.env.COMPLAINTS_MODEL || 'gpt-5.5'
const ROOT = process.cwd()
const PDF_DIR = process.env.COMPLAINTS_DIR || path.join(ROOT, 'complaints_pdfs')
const COLLECTOR = path.join(ROOT, 'collector')
const MAX_PDF_BYTES = 60 * 1024 * 1024
const WINDOW_DAYS = 7 // the list shows cases filed (or first listed) in the last week
/** Counties whose complaints a person downloads (Data -> Manual Complaint Intake). Broward: owner, 16 Nov 2026. */
export const HAND_COUNTIES = ['HILLSBOROUGH', 'BROWARD']
const HAND_SQL = `c.county IN (${HAND_COUNTIES.map(c => `'${c}'`).join(', ')})`
const FILE_PREFIX: Record<string, string> = { HILLSBOROUGH: 'HC', BROWARD: 'BR' }

const reading = new Map<string, { started: string; error?: string }>()

/** Same table the Python reader creates (collector/complaints_extract.py STORE_SCHEMA); a fresh DB may lack it. */
function ensureExtractions() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS foreclosure_extractions (
    case_id TEXT NOT NULL, model TEXT NOT NULL, extracted_at TEXT NOT NULL, meets_criteria INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, result_json TEXT NOT NULL, PRIMARY KEY (case_id, model))`)
}

function caseRow(caseId: string): Row | undefined {
  ensureExtractions()
  return getDb().prepare(`
    SELECT c.case_id, c.case_number, c.case_type, c.filing_date, c.case_style, c.complaint_status,
           c.complaint_pdf, c.note, c.county, c.first_seen, c.metadata_json, e.result_json, e.extracted_at,
           NULL AS decision, NULL AS review_address, NULL AS review_note
    FROM foreclosure_cases c
    LEFT JOIN foreclosure_extractions e ON e.case_id = c.case_id AND e.model = ?
    WHERE c.case_id = ? AND ${HAND_SQL}`).get(MODEL, caseId) as Row | undefined
}

function startRead(caseId: string) {
  if (reading.has(caseId) && !reading.get(caseId)!.error) return
  reading.set(caseId, { started: new Date().toISOString() })
  const venv = path.join(COLLECTOR, '.venv', 'bin', 'python3')
  const py = fs.existsSync(venv) ? venv : 'python3'
  const child = spawn(py, ['-u', 'complaints_read_case.py', caseId], {
    cwd: COLLECTOR,
    env: { ...process.env, AMO_DB_PATH: process.env.AMO_DB_PATH || path.join(ROOT, 'miami_dade_amo.db'), COMPLAINTS_DIR: PDF_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let tail = ''
  const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-2000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('close', code => {
    if (code === 0) reading.delete(caseId)
    else {
      // Last error line, without terminal colour codes.
      const last = tail.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean).pop() ?? ''
      reading.set(caseId, { started: reading.get(caseId)?.started ?? '', error: `The read failed: ${last}`.slice(0, 300) })
      console.warn(`[hillsborough-test] read ${caseId} failed:`, tail)
    }
  })
}

export function registerHillsboroughHandpullRoutes(app: Express) {
  app.get('/api/hillsborough-test', (_req: Request, res: Response) => {
    const db = getDb()
    const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='foreclosure_cases'`).get()
    if (!has) return res.json({ window_days: WINDOW_DAYS, todo: [], done: [], skipped: [], below_band: 0, days: [], last_case_seen: null })
    ensureExtractions()
    const rows = db.prepare(`
      SELECT c.case_id, c.case_number, c.case_type, c.filing_date, c.case_style, c.complaint_status,
             c.complaint_pdf, c.note, c.county, c.first_seen, c.metadata_json, c.last_attempt, e.result_json, e.extracted_at,
             NULL AS decision, NULL AS review_address, NULL AS review_note
      FROM foreclosure_cases c
      LEFT JOIN foreclosure_extractions e ON e.case_id = c.case_id AND e.model = ?
      WHERE ${HAND_SQL} AND (c.filing_date >= date('now', ?) OR substr(c.first_seen, 1, 10) >= date('now', ?))
      ORDER BY c.filing_date DESC, c.case_number`).all(MODEL, `-${WINDOW_DAYS} day`, `-${WINDOW_DAYS} day`) as (Row & { last_attempt: string | null })[]
    const out = rows.map(r => {
      let meta: any = null
      try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : null } catch { meta = null }
      const s = shape(r)
      const rd = reading.get(r.case_id)
      return {
        case_id: r.case_id, case_number: r.case_number, case_type: r.case_type, filing_date: r.filing_date, county: r.county,
        case_style: r.case_style, first_seen: r.first_seen, status: r.complaint_status, note: r.note,
        uploaded_at: r.complaint_status === 'downloaded' ? r.last_attempt : null,
        plaintiffs: meta?.plaintiffs ?? [], defendants: meta?.defendants ?? [],
        reading: !!rd && !rd.error && !r.result_json, read_error: rd?.error ?? null,
        read: !!r.result_json, verdict: s.verdict, principal: s.principal, address: s.address,
        reason: s.result_reason, has_pdf: !!r.complaint_pdf,
      }
    })
    const todo = out.filter(r => r.status === 'pending')
    const done = out.filter(r => r.status === 'downloaded')
    const skipped = out.filter(r => r.status === 'skipped_by_hand')
    const below = out.filter(r => r.status === 'below_band_threshold').length
    // Per day the test ran: cases uploaded, read, and qualifying (Eastern dates).
    const byDay = new Map<string, { uploaded: number; qualifies: number }>()
    for (const r of done) {
      if (!r.uploaded_at) continue
      const d = new Date(r.uploaded_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      const v = byDay.get(d) ?? { uploaded: 0, qualifies: 0 }
      v.uploaded++
      if (r.verdict === 'qualifies') v.qualifies++
      byDay.set(d, v)
    }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, v]) => ({ day, ...v }))
    const last = db.prepare(`SELECT MAX(first_seen) AS t FROM foreclosure_cases c WHERE ${HAND_SQL}`).get() as { t: string | null }
    res.json({ window_days: WINDOW_DAYS, counties: HAND_COUNTIES, todo, done, skipped, below_band: below, days, last_case_seen: last.t })
  })

  app.post('/api/hillsborough-test/:caseId/upload',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: MAX_PDF_BYTES }),
    (req: Request, res: Response) => {
      const caseId = String(req.params.caseId)
      const row = caseRow(caseId)
      if (!row) return res.status(404).json({ error: 'Not a case on the Manual Complaint Intake list' })
      const buf = req.body as Buffer
      if (!Buffer.isBuffer(buf) || buf.length < 1000) return res.status(400).json({ error: 'No file received' })
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'That file is not a PDF' })
      fs.mkdirSync(PDF_DIR, { recursive: true })
      const safe = row.case_number.replace(/[^A-Z0-9-]/gi, '')
      const file = path.join(PDF_DIR, `${FILE_PREFIX[row.county ?? ''] ?? 'XX'}_${safe}_COMPLAINT.pdf`)
      fs.writeFileSync(file, buf)
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      const db = getDb()
      db.prepare(`UPDATE foreclosure_cases SET complaint_status = 'downloaded', complaint_pdf = ?, complaint_sha256 = ?,
                  attempts = attempts + 1, last_attempt = ?, note = 'uploaded by hand (hand-pull test)' WHERE case_id = ?`)
        .run(file, sha, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), caseId)
      // A replaced file must be read again.
      db.prepare(`DELETE FROM foreclosure_extractions WHERE case_id = ?`).run(caseId)
      reading.delete(caseId)
      startRead(caseId)
      res.json({ ok: true, bytes: buf.length })
    })

  // The Chrome add-on that fills HOVER's search boxes (tools/hover-helper; zip rebuilt per its README).
  app.get('/api/complaint-intake/helper.zip', (_req: Request, res: Response) => {
    const zip = path.join(ROOT, 'tools', 'hover-helper.zip')
    if (!fs.existsSync(zip)) return res.status(404).json({ error: 'helper not packaged' })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="hover-helper.zip"')
    fs.createReadStream(zip).pipe(res)
  })

  app.post('/api/hillsborough-test/:caseId/reread', (req: Request, res: Response) => {
    const row = caseRow(String(req.params.caseId))
    if (!row?.complaint_pdf) return res.status(404).json({ error: 'No uploaded file for this case' })
    reading.delete(row.case_id)
    startRead(row.case_id)
    res.json({ ok: true })
  })

  app.post('/api/hillsborough-test/:caseId/skip', (req: Request, res: Response) => {
    const row = caseRow(String(req.params.caseId))
    if (!row || row.complaint_status !== 'pending') return res.status(404).json({ error: 'Not waiting for download' })
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200) || 'skipped'
    getDb().prepare(`UPDATE foreclosure_cases SET complaint_status = 'skipped_by_hand', note = ?, last_attempt = ? WHERE case_id = ?`)
      .run(reason, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), row.case_id)
    res.json({ ok: true })
  })

  app.post('/api/hillsborough-test/:caseId/unskip', (req: Request, res: Response) => {
    const row = caseRow(String(req.params.caseId))
    if (!row || row.complaint_status !== 'skipped_by_hand') return res.status(404).json({ error: 'Not skipped' })
    getDb().prepare(`UPDATE foreclosure_cases SET complaint_status = 'pending', note = NULL WHERE case_id = ?`).run(row.case_id)
    res.json({ ok: true })
  })
}
