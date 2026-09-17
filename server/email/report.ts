import type Database from 'better-sqlite3';
import { queryGroupedFacilities } from '../lending/facilities';
// Same exclusion list as the Reporting tab. The lending-relationships section
// below needs none: on 2–17 Sep none of the four names appeared in it.
import { REPORTING_EXCLUDE } from '../reporting/exclusions';
import { loanRows, COUNTED_LOAN_AMOUNT, LOAN_REPEAT_MIN_AMOUNT } from '../reporting/loanVolume';

const DEFAULT_COUNTY = 'MIAMI-DADE';
const DASHBOARD_URL = 'http://165.22.35.75:5000';

// Caps on what gets embedded inline in the email body — full detail is always
// in the attached CSVs.
//
// The body used to embed the 50 most recent rows. That could not summarise 514
// transactions however they were chosen, and the choice it made was actively
// misleading: Broward is collected daily and Miami-Dade weekly, so Broward's
// data runs days ahead and all 50 "most recent" rows were Broward — the county
// with 60% of the activity never appeared in the body at all. The owner asked
// for a summary built from every row instead (17 Sep 2026).
const TOP_PAIRS = 10;
const TOP_PARTIES = 8;
const TOP_DEALS = 10;
const MAX_RELATIONSHIPS_INLINE = 10;

const COUNTY_LABEL: Record<string, string> = { 'MIAMI-DADE': 'Miami-Dade', BROWARD: 'Broward' };
const COUNTY_COLOR: Record<string, string> = { 'MIAMI-DADE': '#2563eb', BROWARD: '#0d9488' };
const COUNTIES = ['MIAMI-DADE', 'BROWARD'];

// Same labels and definitions as the dashboard (client/src/pages/CleanEvents.tsx
// TXN_TYPES), so a reader moving from the email to the screen sees one vocabulary.
const TXN_META: Record<string, { label: string; desc: string }> = {
  MARKET_TRANSFER:   { label: 'Market Transfer', desc: 'Institution → institution (secondary market)' },
  ORIGINATION:       { label: 'Origination',     desc: 'Individual / private → institution (new supply)' },
  INSTITUTIONAL_OUT: { label: 'Inst. Out',       desc: 'Institution → individual (payoff, REO, distressed)' },
  PRIVATE:           { label: 'Private',         desc: 'Individual → individual' },
  MERS_RELEASE:      { label: 'MERS Release',    desc: 'Registry housekeeping' },
};
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

// Stacked variant: one bar per day, split by county. Same nested-table
// construction as chartBarRow — each segment is a coloured <td> whose width is
// its share of the longest day — so it renders in Outlook desktop too. Segment
// widths are rounded independently, so the filled cells can sum a point or two
// off the true total; the printed value label is the exact figure.
function stackedBarChart(
  title: string,
  items: Array<{ label: string; parts: Record<string, number> }>,
  keys: string[],
): string {
  const totals = items.map(i => keys.reduce((a, k) => a + (i.parts[k] || 0), 0));
  const max = Math.max(0, ...totals);
  if (!items.length || max === 0) return '';
  const body = items.map((item, idx) => {
    const segs = keys
      .map(k => ({ k, pct: Math.round(((item.parts[k] || 0) / max) * 100) }))
      .filter(s => s.pct > 0);
    const used = segs.reduce((a, s) => a + s.pct, 0);
    const cells = segs
      .map(s => `<td width="${s.pct}%" style="background:${COUNTY_COLOR[s.k]};font-size:2px;line-height:10px;">&nbsp;</td>`)
      .join('')
      + (used < 100 ? `<td width="${100 - used}%" style="font-size:2px;line-height:10px;">&nbsp;</td>` : '');
    return `<tr>
      <td style="padding:2px 10px 2px 0;font-size:11px;color:#64748b;white-space:nowrap;">${escapeHtml(item.label)}</td>
      <td style="width:100%;padding:2px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${CHART_TRACK_COLOR};"><tr>${cells}</tr></table>
      </td>
      <td style="padding:2px 0 2px 10px;font-size:11px;font-weight:600;color:#0f172a;font-family:monospace;text-align:right;">${totals[idx]}</td>
    </tr>`;
  }).join('');
  const legend = keys
    .map(k => `<span style="display:inline-block;width:8px;height:8px;background:${COUNTY_COLOR[k]};border-radius:2px;margin:0 4px 0 12px;"></span>${escapeHtml(COUNTY_LABEL[k] || k)}`)
    .join('');
  return `<div style="margin:0 0 18px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;color:#94a3b8;margin:0 0 6px;">${escapeHtml(title)}<span style="text-transform:none;letter-spacing:0;font-weight:400;color:#64748b;">${legend}</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${body}</table>
  </div>`;
}

function countyOf(r: any): string {
  return String(r.county || DEFAULT_COUNTY).toUpperCase();
}

// Names and addresses are truncated in code, not with CSS. Outlook desktop
// renders with the Word engine and ignores max-width/text-overflow on cells, so
// one portfolio loan listing 16 addresses stretched the whole table sideways.
function titleName(s: string | null | undefined): string {
  return s && s !== '—' ? escapeHtml(s) : '—';
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
      AND ${REPORTING_EXCLUDE}
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

  // ── Summary, built from EVERY row in the window ─────────────────────────────
  const empty = `<tr><td colspan="6" style="${td}color:#94a3b8;">No filings in this window</td></tr>`;

  // 1. Coverage per county. The two are collected on different schedules
  // (Miami-Dade weekly, Broward daily), so each carries its own date range —
  // without it, a county whose data ends earlier reads as a county that went
  // quiet.
  const coverage = COUNTIES.map(c => {
    const rows = cleanRows.filter(r => countyOf(r) === c);
    const dates = rows.map(r => r.rec_date).sort();
    return { c, n: rows.length, first: dates[0], last: dates[dates.length - 1] };
  });
  const coverageLine = coverage
    .filter(x => x.n > 0)
    .map(x => `<span style="color:${COUNTY_COLOR[x.c]};font-weight:600;">${COUNTY_LABEL[x.c]}</span> <strong>${x.n}</strong> <span style="color:#94a3b8;">(${fmtDay(x.first)}–${fmtDay(x.last)})</span>`)
    .join(' &nbsp;·&nbsp; ');

  const countySplit = (rows: any[]) => {
    const md = rows.filter(r => countyOf(r) === 'MIAMI-DADE').length;
    return { md, bw: rows.length - md };
  };
  const splitCells = (rows: any[]) => {
    const { md, bw } = countySplit(rows);
    return `<td style="${tdR}font-family:monospace;color:${COUNTY_COLOR['MIAMI-DADE']};">${md || '—'}</td>`
         + `<td style="${tdR}font-family:monospace;color:${COUNTY_COLOR.BROWARD};">${bw || '—'}</td>`;
  };
  const groupBy = (key: (r: any) => string) => {
    const m = new Map<string, any[]>();
    for (const r of cleanRows) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  };

  // 2. Who sold to whom. No dollar column, deliberately: most transfers state no
  // amount, and the largest pair in the first window this was built against —
  // Wells Fargo → Freedom Mortgage, 127 transfers — stated none, so a dollar
  // column would have ranked the biggest trade as the smallest. Dollars live
  // only in Largest Deals, where every row has one.
  const pairRows = groupBy(r => `${r.assignor}\u0000${r.assignee}`)
    .slice(0, TOP_PAIRS)
    .map(([k, rows]) => {
      const [seller, buyer] = k.split('\u0000');
      return `<tr>
        <td style="${td}">${titleName(truncName(seller, 36))}</td>
        <td style="${td}color:#94a3b8;">→</td>
        <td style="${td}">${titleName(truncName(buyer, 36))}</td>
        <td style="${tdR}font-family:monospace;font-weight:600;">${rows.length}</td>
        ${splitCells(rows)}
      </tr>`;
    }).join('') || empty;

  // 3. Most active sellers and buyers.
  const partyTable = (title: string, key: (r: any) => string) => {
    const body = groupBy(key).slice(0, TOP_PARTIES).map(([name, rows]) => `<tr>
        <td style="${td}">${titleName(truncName(name, 30))}</td>
        <td style="${tdR}font-family:monospace;font-weight:600;">${rows.length}</td>
        ${splitCells(rows)}
      </tr>`).join('') || empty;
    return `<table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="${th}">${title}</th><th style="${thR}">Total</th>
        <th style="${thR}color:${COUNTY_COLOR['MIAMI-DADE']};">M-D</th><th style="${thR}color:${COUNTY_COLOR.BROWARD};">BRW</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  };

  // 4. Largest deals — one row per LOAN, not per filing. Uses the same rule and
  // the same SQL as the dashboard's dollar volume (reporting/loanVolume.ts): a
  // $1M+ loan re-filed against several properties, or passed down a chain of
  // assignments, appears once with its filing count. Otherwise a single
  // portfolio loan fills several of the ten slots.
  const dealWhere = `rec_date >= ? AND rec_date <= ? AND txn_type != 'SELF_ASSIGN'
                     AND loan_amount > 0 AND ${REPORTING_EXCLUDE}`;
  const deals = db.prepare(`
    SELECT * FROM (
      SELECT cfn, rec_date, county, assignor_canon AS assignor, assignee_canon AS assignee,
             property_address, loan_amount, rec_book, rec_page,
             ${COUNTED_LOAN_AMOUNT} AS counted,
             COUNT(*) OVER (PARTITION BY loan_amount) AS same_amount_filings
      FROM ${loanRows('aom_events_clean', dealWhere)}
    )
    WHERE counted > 0
    ORDER BY loan_amount DESC LIMIT ${TOP_DEALS}
  `).all(startDate, endDate) as any[];
  const dealRows = deals.map(r => {
    const link = docLink(r);
    const amount = `<strong>${fmtAmt(r.loan_amount)}</strong>`;
    // Only $1M+ repeats are merged, so only there does a count mean "one loan
    // filed N times". Below that, same-amount rows are separate loans.
    const filings = r.loan_amount >= LOAN_REPEAT_MIN_AMOUNT && r.same_amount_filings > 1
      ? ` <span style="color:#94a3b8;font-weight:400;">· ${r.same_amount_filings} filings</span>` : '';
    const property = cleanField(r.property_address, true);
    const c = countyOf(r);
    return `<tr>
      <td style="${tdR}font-family:monospace;color:#059669;">${link ? `<a href="${link}" style="color:#059669;text-decoration:none;">${amount}</a>` : amount}${filings}</td>
      <td style="${td}">${fmtDay(r.rec_date)}</td>
      <td style="${td}color:${COUNTY_COLOR[c] || '#334155'};">${COUNTY_LABEL[c] || escapeHtml(c)}</td>
      <td style="${td}">${titleName(truncName(r.assignor, 34))} <span style="color:#94a3b8;">→</span> ${titleName(truncName(r.assignee, 34))}</td>
      <td style="${td}color:#64748b;" title="${property ? escapeHtml(property) : ''}">${property ? escapeHtml(truncName(property, 48)) : '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" style="${td}color:#94a3b8;">No filings stated a loan amount in this window</td></tr>`;
  const withAmount = cleanRows.filter(r => r.loan_amount > 0).length;

  // 5. Transaction mix.
  const txnMix = groupBy(r => r.txn_type || 'UNKNOWN')
    .map(([t, rows]) => {
      const meta = TXN_META[t];
      return `<tr>
        <td style="${td}font-weight:600;">${escapeHtml(meta?.label || t)}</td>
        <td style="${td}color:#64748b;">${escapeHtml(meta?.desc || '')}</td>
        <td style="${tdR}font-family:monospace;font-weight:600;">${rows.length}</td>
        ${splitCells(rows)}
      </tr>`;
    }).join('') || empty;

  // Daily volume, split by county.
  const byDay = new Map<string, Record<string, number>>();
  for (const r of cleanRows) {
    const d = byDay.get(r.rec_date) || {};
    const c = countyOf(r);
    d[c] = (d[c] || 0) + 1;
    byDay.set(r.rec_date, d);
  }
  const dailyChart = stackedBarChart(
    'Filings per day',
    eachDate(startDate, endDate).map(d => ({ label: fmtDay(d), parts: byDay.get(d) || {} })),
    COUNTIES,
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
  <p style="font-size:14px;margin:0 0 4px;"><strong>${cleanRows.length}</strong> loan transfers</p>
  <p style="font-size:12px;margin:0 0 14px;">${coverageLine || '<span style="color:#94a3b8;">No filings in this window</span>'}</p>
  ${dailyChart}

  <h3 style="font-size:13px;margin:18px 0 6px;">Who sold to whom</h3>
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${th}">Seller</th><th style="${th}"></th><th style="${th}">Buyer</th>
        <th style="${thR}">Transfers</th>
        <th style="${thR}color:${COUNTY_COLOR['MIAMI-DADE']};">M-D</th><th style="${thR}color:${COUNTY_COLOR.BROWARD};">BRW</th>
      </tr></thead>
      <tbody>${pairRows}</tbody>
    </table>
  </div>

  <h3 style="font-size:13px;margin:18px 0 6px;">Most active</h3>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    <td width="50%" valign="top" style="padding-right:10px;">${partyTable('Sellers', r => r.assignor)}</td>
    <td width="50%" valign="top" style="padding-left:10px;">${partyTable('Buyers', r => r.assignee)}</td>
  </tr></table>

  <h3 style="font-size:13px;margin:18px 0 2px;">Largest deals</h3>
  <p style="font-size:11px;color:#94a3b8;margin:0 0 6px;">Each loan listed once, even when it was filed against several properties. ${withAmount} of ${cleanRows.length} transfers state an amount.</p>
  <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${thR}">Loan amount</th><th style="${th}">Date</th><th style="${th}">County</th>
        <th style="${th}">Seller → Buyer</th><th style="${th}">Property</th>
      </tr></thead>
      <tbody>${dealRows}</tbody>
    </table>
  </div>

  <h3 style="font-size:13px;margin:18px 0 6px;">Transaction mix</h3>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>
      <th style="${th}">Type</th><th style="${th}">Meaning</th><th style="${thR}">Total</th>
      <th style="${thR}color:${COUNTY_COLOR['MIAMI-DADE']};">M-D</th><th style="${thR}color:${COUNTY_COLOR.BROWARD};">BRW</th>
    </tr></thead>
    <tbody>${txnMix}</tbody>
  </table>
  <p style="font-size:11px;color:#94a3b8;margin:8px 0 0;">Every transfer in the window is attached as a CSV.</p>

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
