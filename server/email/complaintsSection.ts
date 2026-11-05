/**
 * Monday-email section for Complaints (beta): foreclosure complaints (every county, each lead names its county) filed in the
 * last 7 days, which of them qualify, and how many leads wait for a person to settle something.
 * Same rules as the dashboard page (server/complaints.ts): "qualifies" is worked out from the
 * stored extraction, never stored; the review count covers only leads that qualify or might.
 * Renders nothing when the complaints pipeline has not run on this database.
 */
import type Database from 'better-sqlite3';
import { countyLabel } from '../complaints'

type Ui = {
  esc: (v: any) => string; fmtMoney: (v: number) => string; trunc: (s: string | null | undefined, n: number) => string
  MUTED: string; HAIR: string; INK: string; dashboardUrl: string
}

export function buildComplaintsSection(db: Database.Database, sendDate: string, ui: Ui):
  { sub: string; body: string } | null {
  const have = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('foreclosure_cases','foreclosure_extractions')`).all()
  if (have.length < 2) return null
  db.exec(`CREATE TABLE IF NOT EXISTS foreclosure_reviews (
    case_id TEXT PRIMARY KEY, decision TEXT NOT NULL, address TEXT, note TEXT, reviewed_at TEXT NOT NULL)`)

  const model = process.env.COMPLAINTS_MODEL || 'gpt-5.5'
  const since = new Date(Date.parse(sendDate) - 7 * 86400000).toISOString().slice(0, 10)
  const rows = db.prepare(`
    SELECT c.case_number, c.case_type, c.county, c.filing_date, c.complaint_status, e.result_json, r.decision
    FROM foreclosure_cases c
    LEFT JOIN foreclosure_extractions e ON e.case_id = c.case_id AND e.model = ?
    LEFT JOIN foreclosure_reviews r ON r.case_id = c.case_id`).all(model) as any[]
  if (!rows.length) return null

  const parsed = rows.map(r => {
    const res = r.result_json ? JSON.parse(r.result_json) : null
    const notes: any[] = res?.notes ?? []
    const principal = notes.length ? Math.max(...notes.map(n => n.test_principal ?? 0)) || null : null
    return {
      ...r, res, principal, plaintiff: res?.plaintiff ?? null,
      address: res?.properties?.[0]?.property_address ?? null,
      qualifies: res?.computed_meets_criteria === true,
      needsReview: !!res?.needs_review && !r.decision,
    }
  })
  const week = parsed.filter(p => (p.filing_date ?? '') >= since)
  const weekQual = week.filter(p => p.qualifies).sort((a, b) => (b.principal ?? 0) - (a.principal ?? 0))
  const open = parsed.filter(p => p.needsReview).length
  const notPublic = week.filter(p => p.complaint_status === 'complaint_not_public').length
  const waiting = week.filter(p => !p.res && p.complaint_status !== 'complaint_not_public' && p.complaint_status !== 'below_band_threshold').length

  const { esc, fmtMoney, trunc, MUTED, HAIR, INK } = ui
  const list = weekQual.length ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:${INK};">
      ${weekQual.slice(0, 10).map(p => `<tr>
        <td valign="top" style="padding:7px 0;border-bottom:1px solid ${HAIR};"><b>${esc(trunc(p.plaintiff, 44))}</b>
          <div style="font-size:11px;color:${MUTED};">${esc(countyLabel(p.county))} · ${esc(p.case_number)} · ${esc(p.case_type)} · ${esc(p.address ? trunc(p.address, 56) : 'no property address in the complaint')}</div></td>
        <td align="right" valign="top" style="padding:7px 0 7px 8px;border-bottom:1px solid ${HAIR};white-space:nowrap;">${p.principal ? fmtMoney(p.principal) : '—'}</td>
      </tr>`).join('')}
    </table>
    ${weekQual.length > 10 ? `<div style="font-size:11px;color:${MUTED};margin:6px 0 0;">${weekQual.length - 10} more on the dashboard's Complaints page.</div>` : ''}`
    : `<div style="font-size:12px;color:${MUTED};">No complaint filed in the last 7 days meets the test so far.</div>`

  const notes = [
    open ? `<b>${open}</b> qualifying lead${open === 1 ? '' : 's'} need a person to settle an address or figure — open <a href="${ui.dashboardUrl}/#/complaints" style="color:${INK};">Complaints → Needs review</a>.` : '',
    notPublic ? `${notPublic} complaint${notPublic === 1 ? ' is' : 's are'} listed by the Clerk but not viewable (retried weekly).` : '',
    waiting ? `${waiting} filed this week ${waiting === 1 ? 'is' : 'are'} not read yet.` : '',
  ].filter(Boolean)

  return {
    sub: `${week.length} foreclosure complaint${week.length === 1 ? '' : 's'} filed since ${since} (Commercial and Non-Homestead Residential, all counties); ${weekQual.length} meet${weekQual.length === 1 ? 's' : ''} the test: principal of $500,000 or more and no reinstatement clause in the mortgage. Beta.`,
    body: list + (notes.length ? `<div style="font-size:12px;color:${MUTED};margin:10px 0 0;line-height:1.5;">${notes.join('<br>')}</div>` : ''),
  }
}
