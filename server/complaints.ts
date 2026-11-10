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
 *   GET  /api/complaints/qc                 (quality control: run health, coverage, spend, consistency checks,
 *                                            this month's audit sample and measured accuracy)
 *   POST /api/complaints/qc/audit           { case_id, verdict: 'correct'|'wrong', fields?, note? }
 */
import type { Express, Request, Response } from 'express'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getDb } from './db'

const MODEL = process.env.COMPLAINTS_MODEL || 'gpt-5.5'

function ensureReviewTable() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS foreclosure_audits (
      case_id TEXT PRIMARY KEY, verdict TEXT NOT NULL, wrong_fields TEXT, note TEXT, audited_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS foreclosure_reviews (
      case_id TEXT PRIMARY KEY, decision TEXT NOT NULL, address TEXT, note TEXT, reviewed_at TEXT NOT NULL
    );`)
  if (tablesExist()) {
    const cols = new Set((db.prepare(`PRAGMA table_info(foreclosure_cases)`).all() as { name: string }[]).map(c => c.name))
    if (!cols.has('county')) {
      db.exec(`ALTER TABLE foreclosure_cases ADD COLUMN county TEXT NOT NULL DEFAULT 'MIAMI-DADE'`)
    }
    if (!cols.has('metadata_json')) {
      db.exec(`ALTER TABLE foreclosure_cases ADD COLUMN metadata_json TEXT`)
    }
  }
}

function tablesExist(): boolean {
  const t = getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('foreclosure_cases','foreclosure_extractions')`).all()
  return t.length === 2
}

const COUNTY_NAMES: Record<string, string> = {
  'MIAMI-DADE': 'Miami-Dade',
  DUVAL: 'Duval',
  HILLSBOROUGH: 'Hillsborough',
  MONROE: 'Monroe',
  LEON: 'Leon',
  'NEW-YORK': 'New York (Manhattan)',
  KINGS: 'Kings (Brooklyn)',
  QUEENS: 'Queens',
  BRONX: 'Bronx',
  RICHMOND: 'Richmond (Staten Island)',
  NASSAU: 'Nassau',
  SUFFOLK: 'Suffolk',
  WESTCHESTER: 'Westchester',
}
/** One clean county name per row ('MIAMI-DADE' -> 'Miami-Dade'), from the pipeline's own county column, never from free text in the complaint. */
export function countyLabel(c: string | null | undefined): string {
  const k = String(c || 'MIAMI-DADE').toUpperCase()
  return COUNTY_NAMES[k] ?? k.split(/[-\s]+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join('-')
}

/** The day the tool first pulled the case in (foreclosure_cases.first_seen, a UTC timestamp), as an Eastern-time date. */
export function collectedOn(firstSeen: string | null | undefined): string | null {
  if (!firstSeen) return null
  const d = new Date(firstSeen)
  if (Number.isNaN(d.getTime())) return String(firstSeen).slice(0, 10)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

type Row = {
  case_id: string; case_number: string; case_type: string; filing_date: string | null; case_style: string | null
  complaint_status: string; complaint_pdf: string | null; note: string | null; county: string | null; first_seen: string | null; metadata_json: string | null
  result_json: string | null; extracted_at: string | null
  decision: string | null; review_address: string | null; review_note: string | null
}

/** Counties whose complaint rows stay in the database but are not shown anywhere (owner, 10 Nov 2026: Hillsborough's
 * foreclosure step is stopped and its one manual run is hidden). SQL condition on `foreclosure_cases c`. */
export const VISIBLE_COMPLAINTS_SQL = `COALESCE(c.county, 'MIAMI-DADE') NOT IN ('HILLSBOROUGH')`

const BASE_SQL = `
  SELECT c.case_id, c.case_number, c.case_type, c.filing_date, c.case_style, c.complaint_status,
         c.complaint_pdf, c.note, c.county, c.first_seen, c.metadata_json, e.result_json, e.extracted_at,
         r.decision, r.address AS review_address, r.note AS review_note
  FROM foreclosure_cases c
  LEFT JOIN foreclosure_extractions e ON e.case_id = c.case_id AND e.model = ?
  LEFT JOIN foreclosure_reviews r ON r.case_id = c.case_id
  WHERE ${VISIBLE_COMPLAINTS_SQL}`


// ─── The old collector's spreadsheet, column for column ───────────────────────────────────────────
// Order and names follow the "Complaints" tab of the Lido workbook (docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md §2),
// then the extra fields this pipeline reads that the sheet does not carry. Several notes or properties
// appear joined with "; " as in the sheet. Nothing here is an extra judgement: every value is what the
// complaint said, or is computed in code from it.
const join = (xs: any[]) => { const v = xs.filter(x => x != null && x !== ''); return v.length ? v.join('; ') : null }
const usd = (v: any) => (v == null ? null : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }))
const yn = (v: any) => (v === true ? 'Yes' : v === false ? 'No' : null)

export type SheetField = { key: string; label: string; value: string | null; group: string; wide?: boolean }

function sheetFields(row: Row, res: any, address: string | null, meta: any = null): SheetField[] {
  const notes: any[] = res?.notes ?? []
  const props: any[] = res?.properties ?? []
  const att = res?.attorney ?? {}
  const f = (group: string, key: string, label: string, value: any, wide = false): SheetField =>
    ({ group, key, label, value: value == null || value === '' ? null : String(value), wide })
  const sumUnpaid = notes.filter(n => n.unpaid_principal != null).reduce((a, n) => a + Number(n.unpaid_principal), 0)
  const metaPlaintiffs = join(meta?.plaintiffs ?? [])
  const metaDefendants = join(meta?.defendants ?? [])
  const metaAttorneys = join(meta?.attorneys?.filter((a: string) => a && a !== 'No Attorney') ?? [])
  return [
    f('Case', 'case_number', 'Case Number', row.case_number),
    f('Case', 'case_type', 'Clerk Case Type', row.case_type),
    f('Case', 'document_title', 'Document Title', res?.document_title, true),
    f('Case', 'county', 'County', countyLabel(row.county)),
    f('Case', 'court_printed', 'Court (as printed in the complaint)', res?.county_court, true),
    f('Case', 'date_filed', 'Date Filed', res?.date_filed ?? row.filing_date),
    f('Case', 'clerk_filing_date', 'Clerk Filing Date', row.filing_date),
    f('Case', 'collected_on', 'Date Collected', collectedOn(row.first_seen)),
    f('Parties', 'plaintiff', 'Plaintiff', res?.plaintiff ?? metaPlaintiffs, true),
    f('Parties', 'attorney_name', 'Plaintiff Attorney Name', att.name ?? metaAttorneys),
    f('Parties', 'attorney_email', 'Plaintiff Attorney Email', (att.emails ?? []).join('; ')),
    f('Parties', 'attorney_phone', 'Plaintiff Attorney Phone', att.phone),
    f('Parties', 'attorney_firm', 'Plaintiff Attorney Firm', att.firm),
    f('Parties', 'defendants', 'Defendant', join(res?.defendants ?? []) ?? metaDefendants, true),
    f('Property', 'address', 'Property Address', address ?? join(props.map(p => p.property_address)), true),
    f('Property', 'address_source', 'Address Source', join(props.map(p => p.address_source)), true),
    f('Property', 'address_body', 'Address Printed in Complaint Body', join(props.map(p => p.address_body)), true),
    f('Property', 'legal', 'Property Legal Description', join(props.map(p => p.legal_description)), true),
    f('Property', 'property_county', 'Property County', join(props.map(p => p.property_county))),
    f('Loan', 'orig_amount', 'Original Loan Amount', join(notes.map(n => usd(n.original_principal)))),
    f('Loan', 'orig_date', 'Original Loan Date', join(notes.map(n => n.note_date))),
    f('Loan', 'note_rate', 'Original Loan Note Rate', join(notes.map(n => n.note_rate_text)), true),
    f('Loan', 'maturity', 'Maturity Date', join(notes.map(n => n.maturity_date))),
    f('Loan', 'ext_maturity', 'Latest Extended Maturity', join(notes.map(n => n.latest_extended_maturity))),
    f('Loan', 'guarantor', 'Guarantor', join(res?.guarantors ?? []), true),
    f('Default', 'default_reason', 'Default Reason', join(notes.map(n => n.default_reason)), true),
    f('Default', 'default_date', 'Default Date', join(notes.map(n => n.default_date))),
    f('Default', 'other_default_dates', 'Other Default Dates Mentioned', join(notes.flatMap(n => n.other_default_dates ?? []))),
    f('Amounts', 'unpaid', 'Unpaid Balance(s)', join(notes.map(n => usd(n.unpaid_principal)))),
    f('Amounts', 'unpaid_sum', 'Sum of Unpaid Balance(s)', notes.length ? usd(sumUnpaid) : null),
    f('Amounts', 'deferred', 'Deferred Principal', join(notes.map(n => usd(n.deferred_principal)))),
    f('Amounts', 'test_principal', 'Principal Used for the $500,000 Test', join(notes.map(n => usd(n.test_principal)))),
    f('Amounts', 'default_rate', 'Default Rate (default interest)', join(notes.map(n => n.default_interest_text)), true),
    f('Amounts', 'late_fee', 'Late Fee', join(notes.map(n => n.late_fee_text)), true),
    f('Criteria', 'reinstate', 'Right To Reinstate', join(notes.map(n => yn(n.right_to_reinstate_clause)))),
    f('Criteria', 'fannie', 'Fannie Mae / Freddie Mac Incl.?', join(notes.map(n => yn(n.fannie_freddie_form)))),
    f('Criteria', 'sba', 'SBA?', join(notes.map(n => yn(n.sba_mentioned)))),
    f('Criteria', 'meets', 'Meets Criteria?', res == null ? null : res.is_mortgage_foreclosure === false ? 'Not a mortgage foreclosure'
      : res.computed_meets_criteria === true ? 'Meets criteria' : res.computed_meets_criteria === false ? 'Does not meet criteria' : 'Cannot tell'),
    f('Criteria', 'priority_number', 'Priority # of the Plaintiff as Lender', res?.lien_priority_number),
    f('Criteria', 'priority_source', 'Priority # Source', res?.lien_priority_quote ? `p.${res.lien_priority_page ?? '?'}: ${res.lien_priority_quote}` : null, true),
    f('Source', 'pdf', 'PDF Link', row.complaint_pdf ? `/api/complaints/${row.case_id}/pdf` : null),
    f('Source', 'pages', 'Pages Processed', res?._pages),
    f('Source', 'flags', 'Review Flags', join(res?.review_flags ?? [])),
  ]
}

const usd0 = (v: number | null | undefined) => (v == null ? 'unknown' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))
const FLAG_WORDS: Record<string, string> = {
  address_unresolved: 'the property address readings disagree',
  address_missing: 'the complaint gives no property street address',
  principal_missing: 'the unpaid principal could not be found',
  reinstatement_unreadable: 'the mortgage pages are unreadable, so the reinstatement clause could not be checked',
  no_note_extracted: 'no promissory note was found',
}

/** Plain-English reason for the result chip, built from the same fields the rules use (never a separate guess). */
function resultReason(row: Row, res: any, notes: any[]): string {
  if (!res && row.complaint_status === 'below_band_threshold' && /^Claim Amount at Filing/i.test(row.note ?? ''))
    return `Does not qualify: the Clerk's docket records the ${row.note!.replace(/: below the \$500,000 threshold$/, '').replace(/^Claim Amount/, 'claim amount')}, which cannot reach the $500,000 threshold. This is the Clerk's docket entry, not a reading of the complaint, so the complaint was not downloaded or read.`
  if (!res && row.complaint_status === 'below_band_threshold')
    return `Does not qualify: the Clerk filed this case in a claim band under $250,000 (${row.case_type}), which cannot reach the $500,000 threshold. This is the Clerk's filing band, not a reading of the complaint, so the complaint was not downloaded or read.`
  if (row.complaint_status === 'complaint_not_public')
    return 'The Clerk lists a complaint entry for this case but has attached no document yet, so there is nothing to read. The tool checks again every week for 8 weeks.'
  if (!res) {
    if (row.county && row.county !== 'MIAMI-DADE' && row.complaint_status === 'pending') {
      return 'Unpaid balance not available yet: case discovered from the county civil filings index; awaiting the complaint document to verify the unpaid principal and reinstatement clause.'
    }
    return 'The complaint is downloaded and waiting to be read. It is read in the next daily run.'
  }
  if (res.is_mortgage_foreclosure === false)
    return 'Not a mortgage foreclosure: ' + (res.foreclosure_reason || 'the complaint does not seek to foreclose a mortgage securing a note') + ' Only mortgage foreclosures are tested against the criteria.'
  const big = notes.filter(n => n.meets_amount)
  const top = notes.length ? Math.max(...notes.map(n => n.test_principal ?? 0)) || null : null
  const clauseOn = (n: any) => `the mortgage contains the borrower's right-to-reinstate clause${n.right_to_reinstate_page ? ` (page ${n.right_to_reinstate_page})` : ''}`
  if (res.computed_meets_criteria === true) {
    const n = big.find(x => x.right_to_reinstate_clause === false) ?? big[0]
    return `Qualifies: the unpaid principal of ${usd0(n?.test_principal ?? top)} is at least $500,000 and the mortgage has no right-to-reinstate clause${n?.right_to_reinstate_page ? ` (checked on page ${n.right_to_reinstate_page}; riders included)` : ''}.`
  }
  if (res.computed_meets_criteria === false) {
    if (!big.length)
      return `Does not qualify: the largest unpaid principal demanded is ${usd0(top)}, below the $500,000 threshold.`
    return `Does not qualify: the unpaid principal of ${usd0(big[0].test_principal)} meets the $500,000 threshold, but ${clauseOn(big[0])}, so the borrower can reinstate the loan.`
  }
  const why = [...new Set<string>((res.review_flags ?? []).map((f: string) => FLAG_WORDS[f]).filter(Boolean))]
  return 'Cannot tell yet: ' + (why.length ? why.join('; ') : 'a value the test needs could not be read') + '. It is on the review list.'
}

function shape(row: Row, detail = false) {
  const res = row.result_json ? JSON.parse(row.result_json) : null
  let meta: any = null
  try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : null } catch { meta = null }
  const notes: any[] = res?.notes ?? []
  const props: any[] = res?.properties ?? []
  const verdict: boolean | null | undefined = res ? res.computed_meets_criteria : undefined
  const reviewed = !!row.decision
  const principal = notes.length ? Math.max(...notes.map(n => n.test_principal ?? 0)) || null : null
  const first = props[0] ?? {}
  const address = row.decision === 'address_entered' ? row.review_address : first.property_address ?? null
  const out: any = {
    case_id: row.case_id, case_number: row.case_number, case_type: row.case_type,
    county: row.county ?? 'MIAMI-DADE',
    county_label: countyLabel(row.county),
    collected_on: collectedOn(row.first_seen),
    filing_date: row.filing_date, case_style: row.case_style,
    status: row.complaint_status === 'downloaded' ? (res ? 'extracted' : 'downloaded') : row.complaint_status,
    plaintiff: res?.plaintiff ?? (meta?.plaintiffs?.[0] ?? null),
    is_foreclosure: res ? res.is_mortgage_foreclosure !== false : null,
    result_reason: resultReason(row, res, notes),
    verdict: res == null ? (row.complaint_status === 'below_band_threshold' ? 'no' : 'pending') : verdict === true ? 'qualifies' : verdict === false ? 'no' : 'unclear',
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
    sheet: sheetFields(row, res, address, meta),
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

/**
 * Every complaint as the Complaints tab summarises it, plus the defendants and
 * PDF link, for the Reporting feed (server/feed.ts). null when the complaints
 * tables do not exist (local dev DBs).
 */
export function complaintFeedRows(): any[] | null {
  if (!tablesExist()) return null
  return (getDb().prepare(BASE_SQL).all(MODEL) as Row[]).map(r => {
    const { sheet, ...s } = shape(r)
    const res = r.result_json ? JSON.parse(r.result_json) : null
    const p0 = res?.properties?.[0] ?? {}
    return {
      ...s,
      address: s.address ?? p0.address_mortgage ?? p0.address_note ?? p0.address_body ?? null,
      defendants: Array.isArray(res?.defendants) ? res.defendants : [],
      pdf_url: r.complaint_pdf ? `/api/complaints/${r.case_id}/pdf` : null,
    }
  })
}

export function registerComplaintsRoutes(app: Express) {
  ensureReviewTable()
  registerComplaintsQcRoutes(app) // first: '/api/complaints/qc' must not be read as a case id

  app.get('/api/complaints/summary', (_req: Request, res: Response) => {
    if (!tablesExist()) return res.json({ active: false })
    const rows = (getDb().prepare(BASE_SQL).all(MODEL) as Row[]).map(r => shape(r))
    const count = (f: (r: any) => boolean) => rows.filter(f).length
    const last = getDb().prepare(`SELECT MAX(first_seen) AS t FROM foreclosure_cases c WHERE ${VISIBLE_COMPLAINTS_SQL}`).get() as { t: string | null }
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


  app.get('/api/complaints/export.csv', (req: Request, res: Response) => {
    if (!tablesExist()) return res.status(503).json({ error: 'not set up' })
    const view = String(req.query.view ?? 'all')
    let rows = (getDb().prepare(BASE_SQL + ' ORDER BY c.filing_date DESC, c.case_number DESC').all(MODEL) as Row[]).map(r => shape(r))
    if (view === 'qualifying') rows = rows.filter(r => r.verdict === 'qualifies' || r.verdict === 'unclear')
    else if (view === 'review') rows = rows.filter(r => r.needs_review)
    const withData = rows.filter(r => r.sheet.some((f: SheetField) => f.key === 'plaintiff' && f.value))
    const cols: SheetField[] = (withData[0] ?? rows[0])?.sheet ?? []
    const esc = (v: string | null) => { const t = v ?? ''; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const lines = [cols.map(c => esc(c.label)).join(',')]
    for (const r of rows) lines.push(r.sheet.map((f: SheetField) => esc(f.value)).join(','))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="complaints-${view}-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send('﻿' + lines.join('\n'))
  })

  app.get('/api/complaints/:caseId/pdf', (req: Request, res: Response) => {
    const row = getDb().prepare(`SELECT complaint_pdf FROM foreclosure_cases WHERE case_id = ?`)
      .get(req.params.caseId) as { complaint_pdf: string | null } | undefined
    if (!row?.complaint_pdf || !fs.existsSync(row.complaint_pdf)) return res.status(404).json({ error: 'no document' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline')
    fs.createReadStream(row.complaint_pdf).pipe(res)
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
    const row = getDb().prepare(BASE_SQL + ' AND c.case_id = ?').get(MODEL, req.params.caseId) as Row | undefined
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

// ─── Quality control (shown on the Collection Log tab) ───────────────────────────────────────────────
// Two questions: did we collect everything (run health, coverage, backlog, errors, spend) and is what we
// read correct (automatic consistency checks on every extraction, plus a monthly sample a person checks
// against the complaint and a running accuracy figure from those checks).
// Prices are USD per 1M tokens (input, output), from web listings on 2 Nov 2026, NOT checked against
// OpenAI's own page; same table as collector/complaints_extract.py.
const PRICES: Record<string, [number, number]> = { 'gpt-5.5': [5, 30], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5-nano': [0.05, 0.4] }
const DAILY_CAP = Number(process.env.COMPLAINTS_DAILY_BUDGET_USD || 15)
const STALE_HOURS = 36
const AUDIT_SAMPLE = 10

const tokens = (s: string) => new Set((s.toUpperCase().match(/[A-Z0-9]{3,}/g) ?? [])
  .filter(w => !['LLC', 'INC', 'THE', 'NOT', 'ITS', 'INDIVIDUAL', 'CAPACITY', 'TRUST', 'TRUSTEE', 'BANK', 'NATIONAL',
    'ASSOCIATION', 'COMPANY', 'CORP', 'AND', 'OWNER', 'SOLELY', 'ETC', 'DBA', 'FKA'].includes(w)))
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000
const hash = (str: string) => { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

type Check = { key: string; title: string; what: string; cases: { case_number: string; detail: string }[] }

function consistencyChecks(rows: Row[]): Check[] {
  const checks: Check[] = [
    { key: 'filed_date', title: 'Filing date differs from the Clerk\'s', what: 'The e-filing stamp on the complaint and the Clerk\'s filing date should agree to within a day.', cases: [] },
    { key: 'plaintiff', title: 'Plaintiff does not match the Clerk\'s case name', what: 'No word in common between the plaintiff read from the complaint and the plaintiff in the Clerk\'s case name.', cases: [] },
    { key: 'date_order', title: 'Dates out of order', what: 'The note should predate the default, and the default should predate the filing; maturity should follow the note.', cases: [] },
    { key: 'principal_big', title: 'Unpaid principal well above the original loan', what: 'More than 125% of the original principal is unusual and may be a misread figure (it can be real if advances were added).', cases: [] },
    { key: 'no_note', title: 'Foreclosure with no note extracted', what: 'The complaint was judged a mortgage foreclosure but no note was found.', cases: [] },
    { key: 'qualifies_no_address', title: 'Qualifies but has no property address', what: 'These leads cannot be valued until an address is settled (they are on the review list).', cases: [] },
  ]
  const by = Object.fromEntries(checks.map(c => [c.key, c]))
  for (const r of rows) {
    if (!r.result_json) continue
    const res = JSON.parse(r.result_json)
    const num = r.case_number
    if (res.date_filed && r.filing_date && daysApart(res.date_filed, r.filing_date) > 1)
      by.filed_date.cases.push({ case_number: num, detail: `complaint ${res.date_filed} vs Clerk ${r.filing_date}` })
    const clerkPlaintiff = (r.case_style ?? '').split(/\s+vs?\.?\s+/i)[0]
    if (res.plaintiff && clerkPlaintiff) {
      const a = tokens(res.plaintiff), b = tokens(clerkPlaintiff)
      if (a.size && b.size && ![...a].some(w => b.has(w)))
        by.plaintiff.cases.push({ case_number: num, detail: `read "${String(res.plaintiff).slice(0, 40)}" vs Clerk "${clerkPlaintiff.slice(0, 40)}"` })
    }
    for (const n of res.notes ?? []) {
      const d = (a?: string, b?: string) => !!a && !!b && a > b
      if (d(n.note_date, n.default_date) || d(n.default_date, res.date_filed) || d(n.note_date, n.maturity_date))
        by.date_order.cases.push({ case_number: num, detail: `note ${n.note_date ?? '—'}, default ${n.default_date ?? '—'}, maturity ${n.maturity_date ?? '—'}, filed ${res.date_filed ?? '—'}` })
      if (n.original_principal && n.unpaid_principal && n.unpaid_principal > 1.25 * n.original_principal)
        by.principal_big.cases.push({ case_number: num, detail: `unpaid ${n.unpaid_principal} vs original ${n.original_principal}` })
    }
    if (res.is_mortgage_foreclosure !== false && !(res.notes ?? []).length)
      by.no_note.cases.push({ case_number: num, detail: String(res.foreclosure_reason ?? '').slice(0, 90) })
    if (res.computed_meets_criteria === true && !(res.properties ?? []).some((p: any) => p.property_address) && !r.decision)
      by.qualifies_no_address.cases.push({ case_number: num, detail: res.plaintiff ?? '' })
  }
  return checks
}

export function registerComplaintsQcRoutes(app: Express) {
  app.get('/api/complaints/qc', (_req: Request, res: Response) => {
    if (!tablesExist()) return res.json({ active: false })
    const db = getDb()
    const rows = db.prepare(BASE_SQL).all(MODEL) as Row[]

    // Run health
    const hasRuns = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='foreclosure_runs'`).get()
    const runs = hasRuns ? db.prepare(`SELECT * FROM foreclosure_runs ORDER BY id DESC LIMIT 14`).all() as any[] : []
    const lastOk = runs.find(r => r.status === 'ok')
    const hoursSince = lastOk?.finished_at ? (Date.now() - Date.parse(lastOk.finished_at)) / 3600000 : null
    const health = !runs.length ? 'never_run' : runs[0].status === 'error' ? 'last_run_failed'
      : hoursSince != null && hoursSince > STALE_HOURS ? 'stale' : 'ok'

    // Coverage by filing week (Monday start), last 8 weeks
    const weekOf = (d: string) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10) }
    const weeks: Record<string, any> = {}
    for (const r of rows) {
      if (!r.filing_date) continue
      const w = weekOf(r.filing_date)
      const x = weeks[w] ??= { week: w, found: 0, extracted: 0, not_public: 0, waiting: 0, errors: 0 }
      x.found++
      if (r.complaint_status === 'complaint_not_public') x.not_public++
      else if (r.result_json) x.extracted++
      else x.waiting++
      if ((r.note ?? '').startsWith('error:')) x.errors++
    }
    const coverage = Object.values(weeks).sort((a: any, b: any) => b.week.localeCompare(a.week)).slice(0, 8)
    const problems = rows.filter(r => (r.note ?? '').startsWith('error:')).slice(0, 15)
      .map(r => ({ case_number: r.case_number, note: r.note }))

    // Spend per day, from the tokens stored with each extraction
    const spendRows = db.prepare(`SELECT substr(extracted_at,1,10) AS day, model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, COUNT(*) AS n
      FROM foreclosure_extractions GROUP BY day, model ORDER BY day DESC LIMIT 60`).all() as any[]
    const spendByDay: Record<string, { day: string; complaints: number; usd: number }> = {}
    for (const s of spendRows) {
      const [pi, po] = PRICES[s.model] ?? [30, 120]
      const x = spendByDay[s.day] ??= { day: s.day, complaints: 0, usd: 0 }
      x.complaints += s.n
      x.usd += ((s.i ?? 0) * pi + (s.o ?? 0) * po) / 1e6
    }
    const spend = Object.values(spendByDay).slice(0, 14).map(x => ({ ...x, usd: Math.round(x.usd * 100) / 100 }))

    // Automatic consistency checks
    const checks = consistencyChecks(rows)

    // Monthly audit sample: stable for the month (hash of month + case id), mostly leads that qualify
    const month = new Date().toISOString().slice(0, 7)
    const extracted = rows.filter(r => r.result_json)
    const parsed = extracted.map(r => ({ r, res: JSON.parse(r.result_json as string) }))
    const rank = (list: typeof parsed) => [...list].sort((a, b) => hash(month + a.r.case_id) - hash(month + b.r.case_id))
    const quals = rank(parsed.filter(p => p.res.computed_meets_criteria === true)).slice(0, 6)
    const others = rank(parsed.filter(p => p.res.computed_meets_criteria !== true)).slice(0, AUDIT_SAMPLE - quals.length)
    const audits = db.prepare(`SELECT * FROM foreclosure_audits`).all() as any[]
    const auditBy = Object.fromEntries(audits.map(a => [a.case_id, a]))
    const sample = [...quals, ...others].map(({ r, res }) => {
      const n = (res.notes ?? [])[0] ?? {}
      const p = (res.properties ?? [])[0] ?? {}
      return {
        case_id: r.case_id, case_number: r.case_number, plaintiff: res.plaintiff,
        is_foreclosure: res.is_mortgage_foreclosure !== false,
        qualifies: res.computed_meets_criteria === true,
        fields: [
          { label: 'Unpaid principal', value: n.test_principal ?? null, page: n.unpaid_principal_page ?? null },
          { label: 'Default date', value: n.default_date ?? null, page: n.default_date_page ?? null },
          { label: 'Reinstatement clause in mortgage', value: n.right_to_reinstate_clause ?? null, page: n.right_to_reinstate_page ?? null },
          { label: 'Property address', value: p.property_address ?? null, page: p.address_mortgage_page ?? p.address_note_page ?? null },
        ],
        audit: auditBy[r.case_id] ?? null,
      }
    })
    const done = audits.length, wrong = audits.filter(a => a.verdict === 'wrong').length
    const monthDone = audits.filter(a => String(a.audited_at).startsWith(month))
    res.json({
      active: true, model: MODEL, daily_cap_usd: DAILY_CAP, stale_after_hours: STALE_HOURS,
      health, hours_since_last_ok_run: hoursSince == null ? null : Math.round(hoursSince * 10) / 10,
      runs, coverage, problems, spend, checks,
      audit: {
        month, sample, sample_size: sample.length,
        sample_done: sample.filter(s => s.audit).length,
        total_audited: done, total_wrong: wrong,
        accuracy_pct: done ? Math.round(((done - wrong) / done) * 1000) / 10 : null,
        this_month_audited: monthDone.length,
      },
    })
  })

  app.post('/api/complaints/qc/audit', (req: Request, res: Response) => {
    const { case_id, verdict, fields, note } = req.body ?? {}
    if (!['correct', 'wrong'].includes(verdict)) return res.status(400).json({ error: 'verdict must be correct or wrong' })
    if (!getDb().prepare(`SELECT 1 FROM foreclosure_cases WHERE case_id = ?`).get(String(case_id ?? ''))) {
      return res.status(404).json({ error: 'case not found' })
    }
    getDb().prepare(`
      INSERT INTO foreclosure_audits (case_id, verdict, wrong_fields, note, audited_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(case_id) DO UPDATE SET verdict=excluded.verdict, wrong_fields=excluded.wrong_fields,
        note=excluded.note, audited_at=excluded.audited_at`)
      .run(String(case_id), verdict, Array.isArray(fields) ? fields.join(', ').slice(0, 200) : null,
           note ? String(note).slice(0, 500) : null)
    res.json({ ok: true })
  })
}
