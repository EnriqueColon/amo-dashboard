import type Database from 'better-sqlite3';
import { queryGroupedFacilities } from '../lending/facilities';

const DEFAULT_COUNTY = 'MIAMI-DADE';
const DASHBOARD_URL = 'http://165.22.35.75:5000';

// Caps on what gets embedded inline in the email body — full detail is always
// in the attached CSVs. Wide/long tables in an email are a UX tradeoff, not a
// data limit.
const MAX_CLEAN_ROWS_INLINE = 50;
const MAX_RELATIONSHIPS_INLINE = 10;
const ACTIVE_WINDOW_DAYS = 90;

export interface WeeklyReport {
  startDate: string;
  endDate: string;
  html: string;
  cleanCsv: string;
  facilityCsv: string;
  cleanCount: number;
  facilityCount: number;
}

function escapeCsv(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtAmt(v: number | null | undefined): string {
  if (!v || !isFinite(v) || v <= 0) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtMonth(d: string | null): string {
  if (!d) return '—';
  const [y, m] = d.split('-');
  return `${MONTH_NAMES[Number(m) - 1] || m} ${y}`;
}

function fmtDay(d: string): string {
  const [, m, dd] = d.split('-');
  return `${MONTH_NAMES[Number(m) - 1] || m} ${Number(dd)}`;
}

// Every calendar day in [startDate, endDate], so quiet days (weekends,
// holidays) render as honest zero bars rather than silently vanishing.
function eachDate(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= end && out.length < 60) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function isRecentlyActive(lastDate: string | null): boolean {
  if (!lastDate) return false;
  const d = new Date(lastDate + 'T00:00:00');
  return Date.now() - d.getTime() < ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
}

// Mirrors client/src/pages/Reporting.tsx's cleanField — same regexes, so the
// email shows the same "garbage OCR"/misplaced-address filtering as the UI.
const GARBAGE_RE = /[¢£€§©®™°±×÷\u0080-\uFFFF]/;
const ADDRESS_RE = /^\d+\s.*(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|HWY|CIR|TER|STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|HIGHWAY|CIRCLE|TERRACE)\b/i;
function cleanField(v: string | null | undefined, isAddress = false): string | null {
  if (!v || v.trim().length < 3) return null;
  const ratio = (v.match(GARBAGE_RE) || []).length / v.length;
  if (ratio > 0.06) return null;
  if (!isAddress && ADDRESS_RE.test(v.trim())) return null;
  return v.trim();
}

// Mirrors client/src/pages/Reporting.tsx's deriveClassification.
function deriveClassification(row: any): string {
  if (row.classification) return row.classification;
  if (row.txn_type === 'MERS_RELEASE') return 'WarehouseRelease';
  if (['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT'].includes(row.txn_type)) return 'LoanSale';
  return 'NeedsReview';
}
const CLASS_STYLE: Record<string, string> = {
  LoanSale:         'color:#047857;background:#d1fae5;border-color:#a7f3d0;',
  WarehouseRelease: 'color:#1d4ed8;background:#dbeafe;border-color:#bfdbfe;',
  NeedsReview:      'color:#b45309;background:#fef3c7;border-color:#fde68a;',
};

const FACILITY_TYPE_LABEL: Record<string, string> = {
  warehouse_or_revolving_credit_facility: 'Warehouse / Revolving',
  syndicated_credit_agreement:            'Syndicated Credit',
  consumer_or_business_line_of_credit:    'Consumer / Business LOC',
};

// Per-county — a Miami-Dade book/page URL built from a Broward row resolves to
// a real but unrelated Miami-Dade document. Same guard as /api/reporting/export.
function docLink(r: any): string {
  const county = String(r.county || DEFAULT_COUNTY).toUpperCase();
  if (county !== 'MIAMI-DADE' || !r.rec_book || !r.rec_page) return '';
  return 'https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage'
       + `?redact=false&sBook=${encodeURIComponent(r.rec_book)}`
       + `&sBookType=O+&sPage=${encodeURIComponent(r.rec_page)}`;
}

const th = 'padding:5px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.02em;color:#64748b;border-bottom:1px solid #e2e8f0;white-space:nowrap;';
const thR = th + 'text-align:right;';
const td = 'padding:5px 8px;font-size:11px;color:#334155;border-bottom:1px solid #f1f5f9;white-space:nowrap;';
const tdR = td + 'text-align:right;';

// ── Email-safe bar charts ─────────────────────────────────────────────────────
// Email clients run no JavaScript and Outlook desktop renders HTML with the
// Word engine (no SVG, no flexbox, unreliable div sizing) — the one chart
// construction that renders everywhere is nested tables whose bar is a <td>
// with a background color and a percentage width. No hover layer exists in
// email, so every bar carries its value as a direct label.
const CHART_BAR_COLOR = '#2563eb';
const CHART_TRACK_COLOR = '#eef2f7';

function chartBarRow(labelHtml: string, valueText: string, pct: number): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const cell = (w: number, filled: boolean) =>
    `<td width="${w}%" style="${filled ? `background:${CHART_BAR_COLOR};border-radius:3px;` : ''}font-size:2px;line-height:10px;">&nbsp;</td>`;
  const fill = p <= 0 ? cell(100, false)
    : p >= 100 ? cell(100, true)
    : cell(p, true) + cell(100 - p, false);
  return `<tr>
    <td style="padding:2px 10px 2px 0;font-size:11px;color:#64748b;white-space:nowrap;">${labelHtml}</td>
    <td style="width:100%;padding:2px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:${CHART_TRACK_COLOR};border-radius:3px;"><tr>${fill}</tr></table>
    </td>
    <td style="padding:2px 0 2px 10px;font-size:11px;font-weight:600;color:#0f172a;font-family:monospace;text-align:right;">${valueText}</td>
  </tr>`;
}

function barChart(title: string, items: Array<{ label: string; value: number }>): string {
  const max = Math.max(0, ...items.map(i => i.value));
  if (!items.length || max === 0) return '';
  const body = items
    .map(i => chartBarRow(escapeHtml(i.label), String(i.value), (i.value / max) * 100))
    .join('');
  return `<div style="margin:0 0 18px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;color:#94a3b8;margin:0 0 6px;">${escapeHtml(title)}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${body}</table>
  </div>`;
}

function truncName(s: string | null, n: number): string {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function buildWeeklyReport(db: Database.Database, startDate: string, endDate: string): WeeklyReport {
  // ── Clean AMO events (aom_events_clean) — the Reporting page's table ─────
  const cleanRows = db.prepare(`
    SELECT cfn, rec_date, assignor_canon AS assignor, assignee_canon AS assignee,
           assignor_type, assignee_type, txn_type, county, classification,
           property_address, folio_parcel, signatory_officer,
           loan_amount, consideration_amount, rec_book, rec_page
    FROM aom_events_clean
    WHERE rec_date >= ? AND rec_date <= ? AND txn_type != 'SELF_ASSIGN'
    ORDER BY rec_date DESC
  `).all(startDate, endDate) as any[];

  const cleanCsvHeaders = [
    'CFN', 'Date', 'County', 'Assignor', 'Assignee', 'Assignor Type', 'Assignee Type',
    'Txn Type', 'Classification', 'Property Address', 'Folio', 'Signatory',
    'Loan Amount', 'Consideration', 'Book', 'Page',
  ];
  const cleanCsv = [
    cleanCsvHeaders.join(','),
    ...cleanRows.map(r => [
      r.cfn, r.rec_date, r.county || DEFAULT_COUNTY, r.assignor, r.assignee,
      r.assignor_type, r.assignee_type, r.txn_type, deriveClassification(r),
      r.property_address, r.folio_parcel, r.signatory_officer,
      r.loan_amount, r.consideration_amount, r.rec_book, r.rec_page,
    ].map(escapeCsv).join(',')),
  ].join('\n');

  const cleanInline = cleanRows.slice(0, MAX_CLEAN_ROWS_INLINE);
  const cleanTableRows = cleanInline.map(r => {
    const link = docLink(r);
    const cfnCell = link
      ? `<a href="${link}" style="color:#2563eb;text-decoration:none;">${escapeHtml(r.cfn)}</a>`
      : escapeHtml(r.cfn);
    const cls = deriveClassification(r);
    const property = cleanField(r.property_address, true);
    const folio = cleanField(r.folio_parcel);
    const signatory = cleanField(r.signatory_officer);
    const loanAmt = fmtAmt(r.loan_amount) !== '—' ? fmtAmt(r.loan_amount) : fmtAmt(r.consideration_amount);
    return `<tr>
      <td style="${td}font-family:monospace;">${cfnCell}</td>
      <td style="${td}">${escapeHtml(r.rec_date)}</td>
      <td style="${td}">${escapeHtml(r.county || DEFAULT_COUNTY)}</td>
      <td style="${td}max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.assignor)}">${escapeHtml(r.assignor)} <span style="color:#94a3b8;">(${escapeHtml(r.assignor_type || '—')})</span></td>
      <td style="${td}max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.assignee)}">${escapeHtml(r.assignee)} <span style="color:#94a3b8;">(${escapeHtml(r.assignee_type || '—')})</span></td>
      <td style="${td}max-width:160px;overflow:hidden;text-overflow:ellipsis;">${property ? escapeHtml(property) : '—'}</td>
      <td style="${td}font-family:monospace;">${folio ? escapeHtml(folio) : '—'}</td>
      <td style="${tdR}font-family:monospace;color:#059669;">${loanAmt}</td>
      <td style="${td}max-width:130px;overflow:hidden;text-overflow:ellipsis;">${signatory ? escapeHtml(signatory) : '—'}</td>
      <td style="${td}"><span style="display:inline-block;border:1px solid;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:600;${CLASS_STYLE[cls] || 'color:#64748b;background:#f1f5f9;border-color:#e2e8f0;'}">${escapeHtml(cls)}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" style="${td}color:#94a3b8;">No filings in this window</td></tr>`;

  const cleanTruncNote = cleanRows.length > MAX_CLEAN_ROWS_INLINE
    ? `<p style="font-size:11px;color:#94a3b8;margin:6px 0 0;">Showing ${MAX_CLEAN_ROWS_INLINE} most recent of ${cleanRows.length} — full list attached as CSV.</p>`
    : '';

  // Daily filing volume across the window — one bar per calendar day.
  const byDay = new Map<string, number>();
  for (const r of cleanRows) byDay.set(r.rec_date, (byDay.get(r.rec_date) || 0) + 1);
  const dailyChart = barChart(
    'Filings per day',
    eachDate(startDate, endDate).map(d => ({ label: fmtDay(d), value: byDay.get(d) || 0 })),
  );

  // ── Lending relationships — a snapshot of the tab's most-active pairs ────
  // NOT scoped to the 15-day window: facility filings are rare (a handful a
  // month across the whole dataset — see SESSION_LOG.md), so a 15-day slice
  // would usually be empty. This mirrors what the Lending Relationships tab
  // shows by default (its own default sort is filings DESC — "most active").
  // Full set for the CSV attachment; only the top N render inline in the email body.
  const { total: relTotal, rows: relRowsAll } = queryGroupedFacilities(db, {
    limit: 5000, offset: 0,
  });
  const relRows = relRowsAll.slice(0, MAX_RELATIONSHIPS_INLINE);

  const facilityCsvHeaders = [
    'Lender', 'Borrower', 'Type', 'Credit Limit', 'Amount Type', 'Filings', 'First Filing', 'Last Filing',
  ];
  const facilityCsv = [
    facilityCsvHeaders.join(','),
    ...relRowsAll.map((r: any) => [
      r.lender, r.borrower, r.facility_type, r.facility_amount, r.facility_amount_type,
      r.filings, r.first_date, r.last_date,
    ].map(escapeCsv).join(',')),
  ].join('\n');

  const relTableRows = relRows.map((r: any) => {
    const typeLabel = r.facility_type ? (FACILITY_TYPE_LABEL[r.facility_type] || r.facility_type) : '—';
    const activity = r.first_date === r.last_date ? fmtMonth(r.last_date) : `${fmtMonth(r.first_date)} &rarr; ${fmtMonth(r.last_date)}`;
    const activeBadge = isRecentlyActive(r.last_date)
      ? ' <span style="display:inline-block;border:1px solid #a7f3d0;border-radius:4px;padding:0 5px;font-size:9px;font-weight:600;color:#047857;background:#ecfdf5;">Active</span>'
      : '';
    return `<tr>
      <td style="${td}max-width:170px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.lender) || '—'}</td>
      <td style="${td}max-width:170px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.borrower) || '—'}</td>
      <td style="${td}">${escapeHtml(typeLabel)}</td>
      <td style="${tdR}font-family:monospace;">${fmtAmt(r.facility_amount)}</td>
      <td style="${tdR}font-family:monospace;color:#2563eb;">${r.filings}</td>
      <td style="${td}">${activity}${activeBadge}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" style="${td}color:#94a3b8;">No lending relationships on record</td></tr>`;

  const relTruncNote = relTotal > MAX_RELATIONSHIPS_INLINE
    ? `<p style="font-size:11px;color:#94a3b8;margin:6px 0 0;">Showing top ${MAX_RELATIONSHIPS_INLINE} of ${relTotal} relationships by filing count.</p>`
    : '';

  // Filing count per relationship, for the same top pairs the table shows.
  const relChart = barChart(
    'Filings per relationship',
    relRows.map((r: any) => ({
      label: `${truncName(r.lender, 26)} → ${truncName(r.borrower, 26)}`,
      value: r.filings,
    })),
  );

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:900px;margin:0 auto;color:#0f172a;">
  <h1 style="font-size:18px;margin:0 0 4px;">AMO Dashboard — Activity Report</h1>
  <p style="font-size:13px;color:#64748b;margin:0 0 20px;">Clean AMO events: ${escapeHtml(startDate)} to ${escapeHtml(endDate)} (rolling 15-day window). Lending relationships: current snapshot.</p>

  <h2 style="font-size:15px;margin:0 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">Clean AMO Events — Last 15 Days</h2>
  <p style="font-size:13px;margin:0 0 10px;"><strong>${cleanRows.length}</strong> filings recorded.</p>
  ${dailyChart}
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${th}">CFN</th><th style="${th}">Date</th><th style="${th}">County</th>
        <th style="${th}">Assignor</th><th style="${th}">Assignee</th><th style="${th}">Property</th>
        <th style="${th}">Folio</th><th style="${thR}">Loan Amt</th><th style="${th}">Signatory</th>
        <th style="${th}">Class.</th>
      </tr></thead>
      <tbody>${cleanTableRows}</tbody>
    </table>
  </div>
  ${cleanTruncNote}

  <h2 style="font-size:15px;margin:24px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">Lending Relationships — Most Active</h2>
  <p style="font-size:13px;margin:0 0 10px;"><strong>${relTotal}</strong> lender&ndash;borrower relationships on record.</p>
  ${relChart}
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${th}">Lender</th><th style="${th}">Borrower</th><th style="${th}">Type</th>
        <th style="${thR}">Credit Limit</th><th style="${thR}">Filings</th><th style="${th}">Activity</th>
      </tr></thead>
      <tbody>${relTableRows}</tbody>
    </table>
  </div>
  ${relTruncNote}

  <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;">Full detail attached as CSV — clean events for this window, and every lending relationship on record (not just the top ${MAX_RELATIONSHIPS_INLINE} shown above).
  Dashboard: <a href="${DASHBOARD_URL}" style="color:#2563eb;">${DASHBOARD_URL}</a></p>
</div>`.trim();

  return {
    startDate, endDate, html, cleanCsv, facilityCsv,
    cleanCount: cleanRows.length, facilityCount: relTotal,
  };
}
