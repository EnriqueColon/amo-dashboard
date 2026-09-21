// Roll-up email: the same market seen over three horizons — last 15 days,
// last 30 days, last 360 days — each against the period just before it.
//
// Asked for by the recipients (owner, 19 Sep 2026): "activity in roll-up last
// 15 days, last month, and the last 360 days … with charts so they can see
// changes from those time frames." "Last month" is read as the trailing 30
// days so all three windows roll forward from the same date.
//
// Two rules keep the comparisons honest:
//
//  1. Each county's windows end on ITS OWN latest recorded date. Miami-Dade is
//     collected weekly and Broward daily, so a shared end date would put
//     several empty days at the end of Miami-Dade's 15-day window and read as a
//     slowdown that never happened.
//  2. A "vs prior period" change only counts a county that has full data in
//     both periods. Broward loan transfers start on 22 Jul 2026; folding it into
//     a 360-day comparison would manufacture growth out of a coverage change.
//
// Email constraints shape every chart: no JavaScript, and Outlook desktop
// renders with the Word engine (no SVG, no flexbox, images often blocked), so
// every chart is built from table cells with background colours and fixed
// heights, and carries its numbers as text. Colours: county and transaction
// palettes validated with the dataviz skill's validator (all checks pass; the
// sub-3:1 slots are always shown with labels or a table beside them).
import type Database from 'better-sqlite3';
import { queryGroupedFacilities } from '../lending/facilities';
import { REPORTING_EXCLUDE } from '../reporting/exclusions';
import { loanRows, COUNTED_LOAN_AMOUNT, LOAN_REPEAT_MIN_AMOUNT } from '../reporting/loanVolume';

const DASHBOARD_URL = 'http://165.22.35.75:5000';
const DAY = 86_400_000;

// ── Palette ──────────────────────────────────────────────────────────────────
const INK = '#0b1b33';          // primary text
const INK_2 = '#4a5568';        // secondary text
const MUTED = '#8a94a6';        // axis labels, captions
const HAIR = '#e6e9ef';         // hairlines
const TRACK = '#f1f4f8';        // empty bar track
const PAPER = '#ffffff';
const PLANE = '#f4f6f9';        // page behind the card
const NAVY = '#0d366b';         // header band (blue ramp step 700)
const UP = '#006300';           // ▲ text
const DOWN = '#d03b3b';         // ▼ text
const COUNTY_COLOR: Record<string, string> = { 'MIAMI-DADE': '#2a78d6', BROWARD: '#1baf7a' };
const COUNTY_LABEL: Record<string, string> = { 'MIAMI-DADE': 'Miami-Dade', BROWARD: 'Broward' };
const COUNTIES = ['MIAMI-DADE', 'BROWARD'];
// Recency ramp for the 52-week chart: older weeks → last 30 days → last 15 days.
// One hue, light→dark; validated as an ordinal ramp.
const RECENCY = { older: '#86b6ef', d30: '#3987e5', d15: '#184f95' };
// Transaction mix, categorical slots 1-5 in fixed order.
const MIX: Array<{ key: string; label: string; color: string; desc: string }> = [
  { key: 'MARKET_TRANSFER',   label: 'Market transfer', color: '#2a78d6', desc: 'institution → institution' },
  { key: 'ORIGINATION',       label: 'Origination',     color: '#eb6834', desc: 'lender entering the market' },
  { key: 'INSTITUTIONAL_OUT', label: 'Inst. out',       color: '#1baf7a', desc: 'institution → non-institution' },
  { key: 'PRIVATE',           label: 'Private',         color: '#eda100', desc: 'neither side an institution' },
  { key: 'MERS_RELEASE',      label: 'MERS release',    color: '#e87ba4', desc: 'registry record-keeping' },
];

const FONT = `-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`;
const NUM = `font-variant-numeric:tabular-nums;`;

// ── Windows ──────────────────────────────────────────────────────────────────
interface Win { key: '15' | '30' | '360'; days: number; label: string; short: string }
const WINDOWS: Win[] = [
  { key: '15',  days: 15,  label: 'Last 15 days',  short: '15D' },
  { key: '30',  days: 30,  label: 'Last 30 days',  short: '30D' },
  { key: '360', days: 360, label: 'Last 360 days', short: '360D' },
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const fmtDayY = (d: string) => `${fmtDay(d)}, ${d.slice(0, 4)}`;

function esc(v: any): string {
  return v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function trunc(s: string | null | undefined, n: number): string {
  if (!s) return '—';
  return esc(s.length > n ? s.slice(0, n - 1) + '…' : s);
}
function fmtInt(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function fmtMoney(v: number): string {
  if (!v) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  return `$${Math.round(v / 1e3)}K`;
}
function csv(v: any): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function weekdays(from: string, to: string): number {
  let n = 0;
  for (let t = ms(from); t <= ms(to); t += DAY) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

interface Row {
  cfn: string; rec_date: string; county: string; seller: string; buyer: string;
  txn_type: string; loan_amount: number | null; property_address: string | null;
  rec_book: string | null; rec_page: string | null;
}

// Per-county date range for a window, offset back by `back` windows (0 =
// current, 1 = the period just before it).
function range(asOf: Record<string, string>, county: string, days: number, back = 0) {
  const end = ms(asOf[county]) - back * days * DAY;
  return { from: iso(end - (days - 1) * DAY), to: iso(end) };
}

export interface RollupReport {
  subject: string;
  html: string;
  cleanCsv: string;
  facilityCsv: string;
  cleanCount: number;
  facilityCount: number;
  asOf: Record<string, string>;
}

export function buildRollupReport(db: Database.Database, sendDate: string): RollupReport {
  // ── Data-through date per county, and where each county's history starts ──
  const bounds = db.prepare(`
    SELECT county, MIN(rec_date) AS first, MAX(rec_date) AS last
    FROM aom_events_clean WHERE rec_date <= ? GROUP BY county`).all(sendDate) as any[];
  const asOf: Record<string, string> = {};
  const since: Record<string, string> = {};
  for (const b of bounds) if (COUNTIES.includes(b.county)) { asOf[b.county] = b.last; since[b.county] = b.first; }
  const counties = COUNTIES.filter(c => asOf[c]);

  // normalize.py empties aom_events_clean and refills it in place over roughly
  // 90 minutes every night, so a report can be built against a table that is
  // momentarily empty. Everything below assumes at least one county: the
  // per-county date arithmetic, the 52-week axis, and the SQL that interpolates
  // one `(county = ? AND rec_date BETWEEN ? AND ?)` clause per county — with no
  // counties that last one collapsed to `WHERE ()` and died on a SQLite syntax
  // error, which reads like a code bug rather than "the table is being rebuilt".
  // Return an empty report instead and let the caller decide; sendWeeklyReport
  // refuses to send on cleanCount === 0.
  if (!counties.length) {
    return {
      subject: `AMO Market Monitor — ${fmtDay(sendDate)}: no data`,
      html: '', cleanCsv: '', facilityCsv: '',
      cleanCount: 0, facilityCount: 0, asOf: {},
    };
  }

  // Everything needed: two 360-day periods per county. ~40k rows.
  const earliest = counties.map(c => range(asOf, c, 360, 1).from).sort()[0];
  const all = db.prepare(`
    SELECT cfn, rec_date, county, assignor_canon AS seller, assignee_canon AS buyer, txn_type,
           loan_amount, property_address, rec_book, rec_page
    FROM aom_events_clean
    WHERE rec_date >= ? AND rec_date <= ? AND txn_type != 'SELF_ASSIGN' AND ${REPORTING_EXCLUDE}
  `).all(earliest, sendDate) as Row[];

  const inWin = (r: Row, days: number, back = 0) => {
    if (!asOf[r.county]) return false;
    const { from, to } = range(asOf, r.county, days, back);
    return r.rec_date >= from && r.rec_date <= to;
  };
  // A county counts toward a period-over-period change only if its history
  // covers the whole prior period.
  const comparable = (days: number) => counties.filter(c => since[c] <= range(asOf, c, days, 1).from);

  // Dollar volume with each loan counted once — the dashboard's own rule and SQL.
  const volume = (days: number, back = 0, only?: string[]) => {
    const cs = only || counties;
    if (!cs.length) return 0;
    const parts = cs.map(c => `(county = '${c}' AND rec_date BETWEEN ? AND ?)`).join(' OR ');
    const params = cs.flatMap(c => { const r = range(asOf, c, days, back); return [r.from, r.to]; });
    const where = `(${parts}) AND txn_type != 'SELF_ASSIGN' AND ${REPORTING_EXCLUDE}`;
    const row = db.prepare(`SELECT SUM(${COUNTED_LOAN_AMOUNT}) AS v FROM ${loanRows('aom_events_clean', where)}`)
      .get(...params) as any;
    return row?.v || 0;
  };

  // ── Per-window figures ─────────────────────────────────────────────────────
  const stats = WINDOWS.map(w => {
    const cur = all.filter(r => inWin(r, w.days));
    const cmp = comparable(w.days);
    const curCmp = cur.filter(r => cmp.includes(r.county)).length;
    const prevCmp = all.filter(r => cmp.includes(r.county) && inWin(r, w.days, 1)).length;
    const change = prevCmp > 0 ? (curCmp - prevCmp) / prevCmp : null;
    const vol = volume(w.days);
    const volCmp = cmp.length ? volume(w.days, 0, cmp) : 0;
    const volPrev = cmp.length ? volume(w.days, 1, cmp) : 0;
    const byCounty: Record<string, number> = {};
    for (const r of cur) byCounty[r.county] = (byCounty[r.county] || 0) + 1;
    // Transfers per business day, per county — a county's 360-day pace is taken
    // over the days it actually has data for.
    const pace: Record<string, number> = {};
    for (const c of counties) {
      const { from, to } = range(asOf, c, w.days);
      const start = from < since[c] ? since[c] : from;
      pace[c] = (byCounty[c] || 0) / Math.max(1, weekdays(start, to));
    }
    const mix: Record<string, number> = {};
    for (const r of cur) mix[r.txn_type] = (mix[r.txn_type] || 0) + 1;
    // The same mix held apart by county, so a shift in one county is not
    // averaged away by the other.
    const mixCounty: Record<string, Record<string, number>> = {};
    for (const r of cur) {
      const m = mixCounty[r.county] || (mixCounty[r.county] = {});
      m[r.txn_type] = (m[r.txn_type] || 0) + 1;
    }
    return {
      w, cur, n: cur.length, cmp, change, vol,
      volChange: volPrev > 0 ? (volCmp - volPrev) / volPrev : null,
      byCounty, pace, mix, mixCounty,
      sellers: new Set(cur.map(r => r.seller)).size,
      buyers: new Set(cur.map(r => r.buyer)).size,
    };
  });
  const [s15, s30, s360] = stats;

  // ── Leaderboards: rank by the last 30 days, show all three windows ────────
  // Momentum = the firm's daily pace over 30 days ÷ its daily pace over 360
  // days, each county's 360-day pace measured over the days that county has
  // data for (so a Broward-heavy firm is not "surging" just because Broward
  // coverage began in July).
  const baseDays = (c: string) => {
    const { from, to } = range(asOf, c, 360);
    return (ms(to) - ms(from < since[c] ? since[c] : from)) / DAY + 1;
  };
  function board(side: 'seller' | 'buyer', limit: number) {
    const m = new Map<string, { n15: number; n30: number; n360: number; base: number; c30: Record<string, number>; c360: Record<string, number> }>();
    for (const r of s360.cur) {
      const k = r[side];
      const e = m.get(k) || { n15: 0, n30: 0, n360: 0, base: 0, c30: {}, c360: {} };
      e.n360++;
      e.c360[r.county] = (e.c360[r.county] || 0) + 1;
      e.base += 1 / baseDays(r.county);
      if (inWin(r, 30)) { e.n30++; e.c30[r.county] = (e.c30[r.county] || 0) + 1; }
      if (inWin(r, 15)) e.n15++;
      m.set(k, e);
    }
    return Array.from(m.entries())
      .map(([name, e]) => ({ name, ...e, momentum: e.base > 0 ? (e.n30 / 30) / e.base : 0 }))
      .sort((a, b) => b.n30 - a.n30 || b.n360 - a.n360)
      .slice(0, limit);
  }
  const topSellers = board('seller', 8);
  const topBuyers = board('buyer', 8);

  // Firms whose last-30-day pace moved furthest from their own 360-day norm.
  // Floors keep one-off filers out: at least 12 transfers in 30 days to be
  // "heating up", at least 60 over the year to be "cooling".
  function movers() {
    const m = new Map<string, { n30: number; n360: number; base: number }>();
    for (const r of s360.cur) {
      for (const k of [r.seller, r.buyer]) {
        const e = m.get(k) || { n30: 0, n360: 0, base: 0 };
        e.n360++; e.base += 1 / baseDays(r.county);
        if (inWin(r, 30)) e.n30++;
        m.set(k, e);
      }
    }
    const list = Array.from(m.entries()).map(([name, e]) => ({ name, ...e, ratio: (e.n30 / 30) / e.base }));
    return {
      up: list.filter(x => x.n30 >= 12 && x.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio).slice(0, 5),
      down: list.filter(x => x.n360 >= 60 && x.ratio <= 0.5).sort((a, b) => a.ratio - b.ratio).slice(0, 5),
    };
  }
  const mv = movers();

  // Seller → buyer pairs, ranked by the last 30 days.
  const pairs = (() => {
    const m = new Map<string, { s: string; b: string; n15: number; n30: number; n360: number; c30: Record<string, number> }>();
    for (const r of s360.cur) {
      const k = r.seller + '\u0000' + r.buyer;
      const e = m.get(k) || { s: r.seller, b: r.buyer, n15: 0, n30: 0, n360: 0, c30: {} };
      e.n360++;
      if (inWin(r, 30)) { e.n30++; e.c30[r.county] = (e.c30[r.county] || 0) + 1; }
      if (inWin(r, 15)) e.n15++;
      m.set(k, e);
    }
    return Array.from(m.values()).sort((a, b) => b.n30 - a.n30 || b.n360 - a.n360).slice(0, 8);
  })();

  // Largest loans of the last 30 days, each loan once (dashboard rule).
  const dealParts = counties.map(c => `(county = '${c}' AND rec_date BETWEEN ? AND ?)`).join(' OR ');
  const dealParams = counties.flatMap(c => { const r = range(asOf, c, 30); return [r.from, r.to]; });
  const deals = db.prepare(`
    SELECT * FROM (
      SELECT cfn, rec_date, county, assignor_canon AS seller, assignee_canon AS buyer, loan_amount,
             ${COUNTED_LOAN_AMOUNT} AS counted,
             COUNT(*) OVER (PARTITION BY loan_amount) AS filings
      FROM ${loanRows('aom_events_clean', `(${dealParts}) AND txn_type != 'SELF_ASSIGN' AND loan_amount > 0 AND ${REPORTING_EXCLUDE}`)}
    ) WHERE counted > 0 ORDER BY loan_amount DESC LIMIT 6`).all(...dealParams) as any[];

  // 52 calendar weeks (Mon–Sun) ending with the week of the latest data.
  const latest = counties.map(c => asOf[c]).sort().pop()!;
  const lastMon = ms(latest) - ((new Date(ms(latest)).getUTCDay() + 6) % 7) * DAY;
  const weeks = Array.from({ length: 52 }, (_, i) => {
    const start = lastMon - (51 - i) * 7 * DAY;
    return { start: iso(start), end: iso(start + 6 * DAY), n: 0, partial: false };
  });
  const wIndex = (d: string) => Math.floor((ms(d) - ms(weeks[0].start)) / (7 * DAY));
  for (const r of all) {
    const i = wIndex(r.rec_date);
    if (i >= 0 && i < 52) weeks[i].n++;
  }
  // The final week is partial whenever a county's data stops before Sunday.
  weeks[51].partial = counties.some(c => asOf[c] < weeks[51].end);

  // ── Lending relationships: the ones filed most recently ─────────────────
  const { total: relTotal, rows: relAll } = queryGroupedFacilities(db, { limit: 5000, offset: 0 });
  const relRecent = [...relAll].sort((a: any, b: any) => String(b.last_date).localeCompare(String(a.last_date))).slice(0, 5);

  // ── Attachments ───────────────────────────────────────────────────────────
  const cleanCsv = [
    ['CFN', 'Date', 'County', 'Seller', 'Buyer', 'Transaction type', 'Loan amount', 'Property', 'Book', 'Page'].join(','),
    ...s30.cur.sort((a, b) => b.rec_date.localeCompare(a.rec_date)).map(r => [
      r.cfn, r.rec_date, COUNTY_LABEL[r.county] || r.county, r.seller, r.buyer, r.txn_type,
      r.loan_amount, r.property_address, r.rec_book, r.rec_page,
    ].map(csv).join(',')),
  ].join('\n');
  const facilityCsv = [
    ['Lender', 'Borrower', 'Type', 'Credit limit', 'Amount type', 'Filings', 'First filing', 'Last filing'].join(','),
    ...relAll.map((r: any) => [r.lender, r.borrower, r.facility_type, r.facility_amount, r.facility_amount_type,
      r.filings, r.first_date, r.last_date].map(csv).join(',')),
  ].join('\n');

  // ═════════════════════════════════════════════════════════════════════════
  // HTML
  // ═════════════════════════════════════════════════════════════════════════
  const delta = (x: number | null, basis?: string) => {
    if (x == null || !isFinite(x)) return `<span style="color:${MUTED};">no prior period</span>`;
    const pct = Math.round(x * 100);
    if (pct === 0) return `<span style="color:${INK_2};">■ flat</span>`;
    const up = pct > 0;
    return `<span style="color:${up ? UP : DOWN};font-weight:600;">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`
      + `<span style="color:${MUTED};"> vs prior${basis ? ` · ${basis}` : ''}</span>`;
  };
  const cmpNote = (cmp: string[]) => cmp.length === counties.length ? '' : cmp.map(c => COUNTY_LABEL[c]).join(' + ') + ' only';

  // ── County separation ─────────────────────────────────────────────────────
  // Every figure in this email is the two counties added together, which hides
  // the thing the recipients actually compare. The old weekly email answered it
  // with "M-D" and "BRW" columns beside every total; that costs two columns per
  // table, and this email's tables already carry three (15D/30D/360D), so six
  // numeric columns would wrap in Outlook and on phones.
  //
  // Instead the split rides UNDER the row it belongs to: a colour-coded line of
  // counts, plus the existing magnitude bar restacked by county. Same answer,
  // no extra columns. It renders only when both counties have data, so a
  // Miami-Dade-only period does not print a row of zeroes.
  const multiCounty = counties.length > 1;

  const countyCounts = (by: Record<string, number>, prefix = '') => {
    if (!multiCounty) return '';
    const parts = counties
      .filter(c => (by[c] || 0) > 0)
      .map(c => `<span style="color:${COUNTY_COLOR[c]};font-weight:600;">${COUNTY_LABEL[c]}</span>&nbsp;${fmtInt(by[c])}`);
    if (!parts.length) return '';
    return `<div style="font-size:10px;color:${MUTED};margin:3px 0 0;${NUM}">${prefix}${parts.join(' &nbsp;·&nbsp; ')}</div>`;
  };

  // A magnitude bar split into one segment per county. `max` scales it against
  // the largest row in the same table so the bars stay comparable.
  const countyBar = (by: Record<string, number>, max: number, height = 3) => {
    const total = counties.reduce((a, c) => a + (by[c] || 0), 0);
    const width = Math.max(1, Math.round((total / Math.max(1, max)) * 100));
    const segs = counties
      .filter(c => (by[c] || 0) > 0)
      .map(c => {
        const share = Math.max(1, Math.round(((by[c] || 0) / Math.max(1, total)) * 100));
        return `<td width="${share}%" height="${height}" bgcolor="${COUNTY_COLOR[c]}" style="background:${COUNTY_COLOR[c]};font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td>`;
      }).join('');
    return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;"><tr>
      <td width="${width}%" style="font-size:1px;line-height:1px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${segs || `<td height="${height}" bgcolor="${RECENCY.older}" style="background:${RECENCY.older};font-size:1px;line-height:1px;">&nbsp;</td>`}</tr></table></td>
      <td style="font-size:1px;line-height:1px;">&nbsp;</td>
    </tr></table>`;
  };

  const section = (title: string, sub: string, body: string) => `
  <tr><td style="padding:26px 32px 0 32px;">
    <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:${NAVY};margin:0 0 2px;">${title}</div>
    ${sub ? `<div style="font-size:12px;color:${MUTED};margin:0 0 12px;">${sub}</div>` : '<div style="height:10px;"></div>'}
    ${body}
  </td></tr>`;

  // KPI tiles
  const tile = (s: typeof s15) => `
    <td width="33%" valign="top" style="padding:0 5px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${HAIR};border-radius:10px;background:${PAPER};">
        <tr><td style="padding:14px 14px 12px 14px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${INK_2};">${s.w.label}</div>
          <div style="font-size:30px;font-weight:700;color:${INK};line-height:1.15;margin:6px 0 2px;">${fmtInt(s.n)}</div>
          <div style="font-size:11px;color:${MUTED};margin:0 0 8px;">loan transfers</div>
          <div style="font-size:12px;line-height:1.5;">${delta(s.change, cmpNote(s.cmp))}</div>
          <div style="border-top:1px solid ${HAIR};margin:10px 0 8px;font-size:1px;line-height:1px;">&nbsp;</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:${INK_2};${NUM}">
            <tr><td style="padding:1px 0;">Stated volume</td><td align="right" style="padding:1px 0;color:${INK};font-weight:600;">${fmtMoney(s.vol)}</td></tr>
            <tr><td style="padding:1px 0;">Per business day</td><td align="right" style="padding:1px 0;color:${INK};font-weight:600;">${(counties.reduce((a, c) => a + s.pace[c], 0)).toFixed(1)}</td></tr>
            <tr><td style="padding:1px 0;">Active sellers</td><td align="right" style="padding:1px 0;color:${INK};font-weight:600;">${fmtInt(s.sellers)}</td></tr>
          </table>
          ${multiCounty ? `<div style="border-top:1px solid ${HAIR};margin:9px 0 7px;font-size:1px;line-height:1px;">&nbsp;</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}">
            ${counties.map(c => `<tr>
              <td style="padding:1px 0;color:${INK_2};">${swatch(COUNTY_COLOR[c])}&nbsp;${COUNTY_LABEL[c]}</td>
              <td align="right" style="padding:1px 0;color:${INK};font-weight:600;">${fmtInt(s.byCounty[c] || 0)}</td>
            </tr>`).join('')}
          </table>` : ''}
        </td></tr>
      </table>
    </td>`;

  // Pulse: two plain sentences written from the numbers.
  const paceNow = counties.reduce((a, c) => a + s15.pace[c], 0);
  const paceYear = counties.reduce((a, c) => a + s360.pace[c], 0);
  const paceRatio = paceYear > 0 ? paceNow / paceYear - 1 : 0;
  const pulse = [
    `Over the last 15 days the market recorded <b>${fmtInt(s15.n)}</b> loan transfers — `
      + (Math.abs(paceRatio) < 0.05 ? 'in line with' : `<b>${Math.round(Math.abs(paceRatio) * 100)}% ${paceRatio > 0 ? 'above' : 'below'}</b>`)
      + ` its 360-day daily pace.`,
    topSellers[0] && topBuyers[0]
      ? `<b>${esc(topSellers[0].name)}</b> led selling and <b>${esc(topBuyers[0].name)}</b> led buying over the last 30 days`
        + (pairs[0] ? `; the busiest pairing was ${esc(pairs[0].s)} → ${esc(pairs[0].b)} (${pairs[0].n30}).` : '.')
      : '',
  ].filter(Boolean).join(' ');

  // Chart 1 — 52-week columns, coloured by recency.
  const maxW = Math.max(1, ...weeks.map(w => w.n));
  const H = 110;
  const d30Start = range(asOf, 'MIAMI-DADE' in asOf ? 'MIAMI-DADE' : counties[0], 30).from;
  const d15Start = range(asOf, 'MIAMI-DADE' in asOf ? 'MIAMI-DADE' : counties[0], 15).from;
  const colColor = (w: typeof weeks[0]) => w.end >= d15Start ? RECENCY.d15 : w.end >= d30Start ? RECENCY.d30 : RECENCY.older;
  const cols = weeks.map(w => {
    const h = Math.max(w.n > 0 ? 2 : 0, Math.round((w.n / maxW) * H));
    const bar = h > 0
      ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td height="${h}" bgcolor="${colColor(w)}" style="height:${h}px;background:${colColor(w)};${w.partial ? `opacity:0.55;` : ''}border-radius:2px 2px 0 0;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`
      : '';
    return `<td valign="bottom" height="${H}" style="height:${H}px;padding:0 1px;">${bar}</td>`;
  }).join('');
  // Month labels: one cell spanning each run of weeks that start in the same month.
  const monthRuns: Array<{ m: string; span: number }> = [];
  for (const w of weeks) {
    const m = MON[Number(w.start.slice(5, 7)) - 1];
    if (monthRuns.length && monthRuns[monthRuns.length - 1].m === m) monthRuns[monthRuns.length - 1].span++;
    else monthRuns.push({ m, span: 1 });
  }
  const monthCells = monthRuns.map(r => `<td colspan="${r.span}" style="padding:5px 0 0 1px;font-size:9px;color:${MUTED};border-top:1px solid ${HAIR};">${r.span >= 2 ? r.m : ''}</td>`).join('');
  const peak = weeks.reduce((a, b) => (b.n > a.n ? b : a));
  const full = weeks.filter(w => !w.partial);
  const avgWeek = full.reduce((a, w) => a + w.n, 0) / Math.max(1, full.length);
  const swatch = (c: string) => `<span style="display:inline-block;width:9px;height:9px;background:${c};border-radius:2px;vertical-align:middle;"></span>`;
  const trendChart = `
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${cols}</tr><tr>${monthCells}</tr></table>
    <div style="font-size:11px;color:${INK_2};margin:8px 0 0;line-height:1.7;">
      ${swatch(RECENCY.older)}&nbsp;Earlier weeks &nbsp;&nbsp;${swatch(RECENCY.d30)}&nbsp;Last 30 days &nbsp;&nbsp;${swatch(RECENCY.d15)}&nbsp;Last 15 days
      <span style="color:${MUTED};"> &nbsp;·&nbsp; average ${fmtInt(avgWeek)}/week · peak ${fmtInt(peak.n)} (week of ${fmtDay(peak.start)})${weeks[51].partial ? ' · final week still being collected' : ''}</span>
    </div>`;

  // Chart 2 — pace per business day, by county and window.
  const maxPace = Math.max(0.1, ...stats.flatMap(s => counties.map(c => s.pace[c])));
  const hbar = (label: string, value: number, max: number, color: string, text: string) => {
    const p = Math.max(1, Math.round((value / max) * 100));
    return `<tr>
      <td width="92" style="padding:3px 10px 3px 0;font-size:11px;color:${INK_2};white-space:nowrap;">${label}</td>
      <td style="padding:3px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${TRACK};border-radius:4px;"><tr>
          <td width="${p}%" height="12" bgcolor="${color}" style="background:${color};border-radius:4px;font-size:1px;line-height:1px;">&nbsp;</td>
          ${p < 100 ? `<td width="${100 - p}%" style="font-size:1px;line-height:1px;">&nbsp;</td>` : ''}
        </tr></table>
      </td>
      <td width="64" align="right" style="padding:3px 0 3px 10px;font-size:12px;font-weight:600;color:${INK};${NUM}white-space:nowrap;">${text}</td>
    </tr>`;
  };
  const paceChart = counties.map(c => `
    <div style="font-size:12px;font-weight:600;color:${INK};margin:0 0 4px;">${swatch(COUNTY_COLOR[c])}&nbsp;${COUNTY_LABEL[c]}
      <span style="font-weight:400;color:${MUTED};">· data through ${fmtDay(asOf[c])}${since[c] > range(asOf, c, 360).from ? ` · history starts ${fmtDay(since[c])}` : ''}</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
      ${stats.map(s => hbar(s.w.label, s.pace[c], maxPace, COUNTY_COLOR[c], s.pace[c].toFixed(1))).join('')}
    </table>`).join('');

  // Chart 3 — transaction mix, 100% stacked, one row per window.
  const mixRow = (label: string, mix: Record<string, number>, n: number, sub = false) => {
    const total = Math.max(1, n);
    let used = 0;
    const segs = MIX.map((t, i) => {
      const cnt = mix[t.key] || 0;
      let p = Math.round((cnt / total) * 100);
      if (i === MIX.length - 1) p = Math.max(0, 100 - used);
      used += p;
      return p > 0 ? `<td width="${p}%" height="${sub ? 10 : 16}" bgcolor="${t.color}" style="background:${t.color};border-right:2px solid ${PAPER};font-size:1px;line-height:1px;">&nbsp;</td>` : '';
    }).join('');
    return `<tr>
      <td width="92" style="padding:${sub ? '2px 10px 2px 12px' : '4px 10px 4px 0'};font-size:${sub ? 10 : 11}px;color:${sub ? MUTED : INK_2};white-space:nowrap;">${label}</td>
      <td style="padding:${sub ? 2 : 4}px 0;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${segs}</tr></table></td>
    </tr>`;
  };
  // Each window as one bar, and — when both counties have data — the same
  // window again as a thinner bar per county directly beneath it.
  const mixRows = (s: typeof s15) => mixRow(s.w.label, s.mix, s.n)
    + (multiCounty ? counties.map(c => mixRow(COUNTY_LABEL[c], s.mixCounty[c] || {}, s.byCounty[c] || 0, true)).join('') : '');
  const mixTable = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 0;font-size:12px;${NUM}">
      <tr>
        <td style="padding:5px 0;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${HAIR};">Type</td>
        ${stats.map(s => `<td align="right" style="padding:5px 0 5px 8px;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${HAIR};">${s.w.short}</td>`).join('')}
      </tr>
      ${MIX.map(t => `<tr>
        <td style="padding:5px 0;border-bottom:1px solid ${HAIR};color:${INK};">${swatch(t.color)}&nbsp;${t.label} <span style="color:${MUTED};">· ${t.desc}</span></td>
        ${stats.map(s => `<td align="right" style="padding:5px 0 5px 8px;border-bottom:1px solid ${HAIR};color:${INK};">${Math.round(((s.mix[t.key] || 0) / Math.max(1, s.n)) * 100)}%</td>`).join('')}
      </tr>`).join('')}
    </table>`;

  // Leaderboards
  const momentumBadge = (x: number) => {
    if (!isFinite(x) || x === 0) return `<span style="color:${MUTED};">—</span>`;
    const up = x >= 1.15, down = x <= 0.85;
    const color = up ? UP : down ? DOWN : INK_2;
    return `<span style="color:${color};font-weight:600;white-space:nowrap;">${up ? '▲' : down ? '▼' : '■'} ${x.toFixed(1)}×</span>`;
  };
  const board3 = (title: string, rows: ReturnType<typeof board>) => {
    const max360 = Math.max(1, ...rows.map(r => r.n360));
    const head = (t: string, right = true) => `<td ${right ? 'align="right"' : ''} style="padding:6px 0 6px ${right ? 8 : 0}px;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${HAIR};white-space:nowrap;">${t}</td>`;
    return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}">
      <tr>${head(title, false)}${head('15D')}${head('30D')}${head('360D')}${head('Pace')}</tr>
      ${rows.map((r, i) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid ${HAIR};color:${INK};">
          <span style="color:${MUTED};">${i + 1}</span>&nbsp; ${trunc(r.name, 30)}
          ${countyBar(r.c360, max360)}
          ${countyCounts(r.c30, '30D: ')}
        </td>
        <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK_2};">${fmtInt(r.n15)}</td>
        <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK};font-weight:700;">${fmtInt(r.n30)}</td>
        <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK_2};">${fmtInt(r.n360)}</td>
        <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};">${momentumBadge(r.momentum)}</td>
      </tr>`).join('')}
    </table>`;
  };

  const moverList = (title: string, list: typeof mv.up, up: boolean) => `
    <td width="50%" valign="top" style="padding:0 6px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${HAIR};border-radius:10px;">
        <tr><td style="padding:12px 14px;">
          <div style="font-size:12px;font-weight:700;color:${up ? UP : DOWN};margin:0 0 6px;">${up ? '▲' : '▼'} ${title}</div>
          ${list.length ? list.map(x => `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}"><tr>
              <td style="padding:3px 0;color:${INK};">${trunc(x.name, 26)}</td>
              <td align="right" style="padding:3px 0;color:${INK_2};white-space:nowrap;">${x.n30} in 30D · <b style="color:${up ? UP : DOWN};">${x.ratio.toFixed(1)}×</b></td>
            </tr></table>`).join('')
            : `<div style="font-size:12px;color:${MUTED};">No firm moved that far from its usual pace.</div>`}
        </td></tr>
      </table>
    </td>`;

  const pairTable = `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}">
    <tr>
      <td style="padding:6px 0;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${HAIR};">Seller → buyer</td>
      ${['15D', '30D', '360D'].map(t => `<td align="right" style="padding:6px 0 6px 8px;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:${MUTED};border-bottom:1px solid ${HAIR};">${t}</td>`).join('')}
    </tr>
    ${pairs.map(p => `<tr>
      <td style="padding:6px 0;border-bottom:1px solid ${HAIR};color:${INK};">${trunc(p.s, 26)} <span style="color:${MUTED};">→</span> ${trunc(p.b, 26)}
        ${countyCounts(p.c30, '30D: ')}</td>
      <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK_2};">${fmtInt(p.n15)}</td>
      <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK};font-weight:700;">${fmtInt(p.n30)}</td>
      <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK_2};">${fmtInt(p.n360)}</td>
    </tr>`).join('')}
  </table>`;

  const dealTable = deals.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}">
    ${deals.map(d => `<tr>
      <td style="padding:7px 0;border-bottom:1px solid ${HAIR};font-weight:700;color:${INK};white-space:nowrap;">${fmtMoney(d.loan_amount)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${HAIR};color:${INK};">${trunc(d.seller, 24)} <span style="color:${MUTED};">→</span> ${trunc(d.buyer, 24)}
        ${d.loan_amount >= LOAN_REPEAT_MIN_AMOUNT && d.filings > 1 ? `<span style="color:${MUTED};"> · ${d.filings} filings, one loan</span>` : ''}</td>
      <td align="right" style="padding:7px 0;border-bottom:1px solid ${HAIR};color:${MUTED};white-space:nowrap;">${fmtDay(d.rec_date)} · ${COUNTY_LABEL[d.county] || esc(d.county)}</td>
    </tr>`).join('')}
  </table>` : `<div style="font-size:12px;color:${MUTED};">No transfer in the last 30 days stated a loan amount.</div>`;

  const relTable = `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;${NUM}">
    ${relRecent.map((r: any) => `<tr>
      <td style="padding:6px 0;border-bottom:1px solid ${HAIR};color:${INK};">${trunc(r.lender, 30)} <span style="color:${MUTED};">→</span> ${trunc(r.borrower, 30)}</td>
      <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${INK};font-weight:600;white-space:nowrap;">${r.facility_amount ? fmtMoney(r.facility_amount) : '—'}</td>
      <td align="right" style="padding:6px 0 6px 8px;border-bottom:1px solid ${HAIR};color:${MUTED};white-space:nowrap;">last filed ${r.last_date ? fmtDay(r.last_date) : '—'}</td>
    </tr>`).join('')}
  </table>`;

  const coverageLine = counties.map(c => `${COUNTY_LABEL[c]} through ${fmtDay(asOf[c])}`).join(' · ');
  const subject = `AMO Market Monitor — ${fmtDay(sendDate)}: ${fmtInt(s15.n)} transfers in 15 days`
    + (s15.change != null ? ` (${s15.change >= 0 ? '+' : '−'}${Math.abs(Math.round(s15.change * 100))}%)` : '');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>AMO Market Monitor</title></head>
<body style="margin:0;padding:0;background:${PLANE};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="${PLANE}" style="background:${PLANE};font-family:${FONT};">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table width="680" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:${PAPER};border-radius:14px;overflow:hidden;border:1px solid ${HAIR};">

  <tr><td bgcolor="${NAVY}" style="background:${NAVY};padding:26px 32px 22px 32px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#9ec5f4;font-weight:700;">AMO Market Monitor</div>
    <div style="font-size:22px;font-weight:700;color:#ffffff;margin:6px 0 4px;line-height:1.25;">Mortgage assignment activity — Miami-Dade &amp; Broward</div>
    <div style="font-size:12px;color:#cde2fb;">${fmtDayY(sendDate)} &nbsp;·&nbsp; Data ${coverageLine}</div>
  </td></tr>

  <tr><td style="padding:22px 32px 0 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6fe;border-left:3px solid ${COUNTY_COLOR['MIAMI-DADE']};border-radius:0 8px 8px 0;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:1.55;color:${INK};">
        <span style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:${NAVY};">The pulse</span><br>${pulse}
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:18px 27px 0 27px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${stats.map(tile).join('')}</tr></table>
  </td></tr>

  ${section('52-week trend', 'Loan transfers per week, both counties. The darker the column, the more recent the window it belongs to.', trendChart)}

  ${section('Pace by window', 'Average loan transfers per business day — the fairest way to compare windows of different lengths.', paceChart)}

  ${section('What kind of activity', 'Share of transfers by transaction type in each window.',
    `<table width="100%" cellpadding="0" cellspacing="0">${stats.map(mixRows).join('')}</table>${mixTable}`)}

  ${section('Most active sellers', 'Ranked by the last 30 days. <b>Pace</b> = the last 30 days against the firm\'s own 360-day average (1.0× = usual).', board3('Seller', topSellers))}

  ${section('Most active buyers', 'Ranked by the last 30 days.', board3('Buyer', topBuyers))}

  ${section('Momentum', 'Firms whose last 30 days moved furthest from their own 360-day pace.',
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px;"><tr>${moverList('Heating up', mv.up, true)}${moverList('Cooling off', mv.down, false)}</tr></table>`)}

  ${section('Top relationships', 'Who sold to whom, ranked by the last 30 days.', pairTable)}

  ${section('Largest loans — last 30 days', 'Each loan counted once, even when filed against several properties.', dealTable)}

  ${section('Lending relationships', `Most recently filed of ${fmtInt(relTotal)} lender–borrower credit relationships on record.`, relTable)}

  <tr><td style="padding:28px 32px 26px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${HAIR};"><tr><td style="padding:16px 0 0;font-size:11px;line-height:1.6;color:${MUTED};">
      <a href="${DASHBOARD_URL}" style="color:${COUNTY_COLOR['MIAMI-DADE']};font-weight:600;text-decoration:none;">Open the dashboard →</a><br>
      <b style="color:${INK_2};">How to read this.</b> Counts are recorded mortgage assignments, dated by recording, not sale date.
      Each window ends on each county's latest collected date. "Vs prior" compares a window with the one of equal length just before it,
      using only counties with complete data in both (Broward loan data begins ${since.BROWARD ? fmtDay(since.BROWARD) + ', ' + since.BROWARD.slice(0, 4) : '—'}).
      Stated volume counts only transfers that state an amount (about 57%) and each loan once.
      Excluded, as on the dashboard's Reporting tab: self-transfers, MERS, Wilmington Savings, Fannie Mae and Freddie Mac.
      Attached: every transfer in the last 30 days, and every lending relationship on record.
    </td></tr></table>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;

  return { subject, html, cleanCsv, facilityCsv, cleanCount: s15.n, facilityCount: relTotal, asOf };
}
