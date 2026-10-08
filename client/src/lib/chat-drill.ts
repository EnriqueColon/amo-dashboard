/**
 * Ask the Data — "click a table row to see the records behind it".
 *
 * A table in an answer is Markdown the model wrote; nothing in it says which
 * lookup produced which row. This module rebuilds that link so a row can be
 * expanded in place without another model call:
 *
 *   Tier 1 — match the row's cells against the results of the lookups the
 *            model ran for this answer (the server streams the drillable part
 *            of each tool result). A canonical entity name, a period or a CFN
 *            is distinctive enough to identify the row, and the lookup's own
 *            arguments give the exact county / date window / role.
 *   Tier 2 — if nothing matches (a run_sql table, renamed values), read the
 *            column headers: Assignor / Assignee / Month / County / Type map
 *            to filing filters, with county and dates defaulted from whatever
 *            the model's lookups used. Approximate — the panel states the
 *            filter it applied so a wrong guess is visible.
 *   (Tier 3 — "Ask about this row" — lives in the page: it is a model turn.)
 *
 * Everything here is pure; the fetch happens in the page.
 */

export interface DrillStep {
  name: string;
  args: Record<string, unknown>;
  result?: any;
}

export type Drill =
  | { kind: 'filings'; params: Record<string, string>; label: string; exact: boolean }
  | { kind: 'facility_filings'; params: Record<string, string>; label: string; exact: boolean }
  | { kind: 'record'; record: Record<string, unknown>; recordType: 'filing' | 'facility_filing'; label: string; exact: true };

const TXN_TYPES = new Set(['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT', 'PRIVATE', 'SELF_ASSIGN', 'MERS_RELEASE']);

// ── text normalisation ───────────────────────────────────────────────────────

/** Strip Markdown emphasis/links/code and collapse whitespace; case-folded. */
export function normCell(s: unknown): string {
  return String(s ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isBlankish(n: string): boolean {
  return !n || n === '—' || n === '-' || n === 'TOTAL' || n === 'N/A' || /^[$+-]?\d[\d,.\s%$KMB]*$/.test(n);
}

function cellsMatch(cells: string[], value: unknown): boolean {
  const v = normCell(value);
  if (!v) return false;
  return cells.some(c => c === v || (c.endsWith('…') && c.length > 8 && v.startsWith(c.slice(0, -1))) || (c.endsWith('...') && c.length > 10 && v.startsWith(c.slice(0, -3))));
}

function cellsContain(cells: string[], value: unknown): boolean {
  const v = normCell(value);
  return !!v && cells.some(c => c.includes(v));
}

// ── periods ──────────────────────────────────────────────────────────────────

export interface Period { key: string; from: string; to: string; label: string }

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6,
  JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};

function lastDay(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function month(y: number, m: number): Period | null {
  if (m < 1 || m > 12 || y < 1900 || y > 2100) return null;
  const mm = String(m).padStart(2, '0');
  return { key: `${y}-${mm}`, from: `${y}-${mm}-01`, to: lastDay(y, m), label: `${y}-${mm}` };
}
function quarter(y: number, q: number): Period | null {
  if (q < 1 || q > 4 || y < 1900 || y > 2100) return null;
  const m0 = (q - 1) * 3 + 1;
  return { key: `${y}-Q${q}`, from: `${y}-${String(m0).padStart(2, '0')}-01`, to: lastDay(y, m0 + 2), label: `Q${q} ${y}` };
}
function year(y: number): Period | null {
  if (y < 1900 || y > 2100) return null;
  return { key: `${y}`, from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` };
}

/** Parse the ways a model writes a month / quarter / year / day. Null if not a period. */
export function parsePeriod(raw: unknown): Period | null {
  const s = normCell(raw).replace(/\./g, '');
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { key: s, from: s, to: s, label: s };
  if ((m = s.match(/^(\d{4})[-/ ](\d{1,2})$/))) return month(+m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) return month(+m[2], +m[1]);
  if ((m = s.match(/^(\d{4})[- ]?Q([1-4])$/))) return quarter(+m[1], +m[2]);
  if ((m = s.match(/^Q([1-4])[- ]?(?:OF )?(\d{4})$/))) return quarter(+m[2], +m[1]);
  if ((m = s.match(/^([A-Z]+)[- ,]+(\d{4})$/)) && MONTHS[m[1]]) return month(+m[2], MONTHS[m[1]]);
  if ((m = s.match(/^(\d{4})[- ,]+([A-Z]+)$/)) && MONTHS[m[2]]) return month(+m[1], MONTHS[m[2]]);
  if ((m = s.match(/^([A-Z]+)[- ]'?(\d{2})$/)) && MONTHS[m[1]]) return month(2000 + +m[2], MONTHS[m[1]]);
  if ((m = s.match(/^(?:FY ?|YEAR )?(\d{4})$/))) return year(+m[1]);
  return null;
}

function firstPeriod(cells: string[]): Period | null {
  for (const c of cells) { const p = parsePeriod(c); if (p) return p; }
  return null;
}

// ── labels ───────────────────────────────────────────────────────────────────

function countyLabel(c?: string): string {
  const u = (c ?? '').toUpperCase();
  if (u === 'ALL') return 'all counties';
  if (u === 'BROWARD') return 'Broward';
  return 'Miami-Dade';
}

export function describeFilingsParams(p: Record<string, string>): string {
  const bits: string[] = [];
  if (p.cfn) bits.push(`CFN ${p.cfn}`);
  if (p.entity) bits.push(p.role === 'assignee' ? `acquired by ${p.entity}` : p.role === 'assignor' ? `sold by ${p.entity}` : `involving ${p.entity}`);
  if (p.counterparty) bits.push(`with ${p.counterparty}`);
  bits.push(countyLabel(p.county));
  if (p.from && p.to) bits.push(p.from === p.to ? p.from : `${p.from} → ${p.to}`);
  else if (p.from) bits.push(`from ${p.from}`);
  else if (p.to) bits.push(`through ${p.to}`);
  if (p.txn_type) bits.push(p.txn_type.toLowerCase().replace(/_/g, ' '));
  else if (p.exclude_self_assign === 'true') bits.push('excluding self-assigns');
  return bits.join(' · ');
}

export function describeFacilityParams(p: Record<string, string>): string {
  const bits: string[] = [];
  if (p.cfn) bits.push(`CFN ${p.cfn}`);
  if (p.lender) bits.push(`lender ${p.lender}`);
  if (p.borrower) bits.push(`borrower ${p.borrower}`);
  return bits.join(' · ') || 'all facility filings';
}

function clean(p: Record<string, string | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

function filings(p: Record<string, string | undefined | null>, exact: boolean): Drill {
  const params = clean(p);
  return { kind: 'filings', params, label: describeFilingsParams(params), exact };
}
function facility(p: Record<string, string | undefined | null>, exact: boolean): Drill {
  const params = clean(p);
  return { kind: 'facility_filings', params, label: describeFacilityParams(params), exact };
}

// ── tier 1: match against lookup results ─────────────────────────────────────

function fromStep(step: DrillStep, cells: string[]): Drill | null {
  const r = step.result;
  if (!r || typeof r !== 'object') return null;
  const a = step.args ?? {};

  switch (step.name) {
    case 'get_top_entities': {
      for (const row of r.rows ?? []) {
        if (!cellsMatch(cells, row.entity)) continue;
        return filings({
          entity: row.entity, role: r.role, county: r.county, from: r.from, to: r.to,
          txn_type: a.txn_type as string | undefined,
          exclude_self_assign: a.txn_type ? undefined : 'true',
        }, true);
      }
      return null;
    }
    case 'get_monthly_volume': {
      const p = firstPeriod(cells);
      if (!p) return null;
      for (const row of r.rows ?? []) {
        const rp = parsePeriod(row.period);
        if (rp && rp.key === p.key) return filings({ entity: r.entity ?? undefined, county: r.county, from: rp.from, to: rp.to }, true);
      }
      return null;
    }
    case 'get_entity_profile': {
      const name = r.entity?.entity as string | undefined;
      if (!name) return null;
      const county = r.scope?.county as string | undefined;
      for (const row of r.acquired_from ?? []) if (cellsMatch(cells, row.counterparty)) return filings({ entity: name, role: 'assignee', counterparty: row.counterparty, county: 'ALL' }, true);
      for (const row of r.sold_to ?? []) if (cellsMatch(cells, row.counterparty)) return filings({ entity: name, role: 'assignor', counterparty: row.counterparty, county: 'ALL' }, true);
      const p = firstPeriod(cells);
      if (p) for (const row of r.monthly_activity ?? []) { const rp = parsePeriod(row.month); if (rp && rp.key === p.key) return filings({ entity: name, county, from: rp.from, to: rp.to }, true); }
      for (const row of r.lending_relationships ?? []) if (cellsMatch(cells, row.lender) || cellsMatch(cells, row.borrower)) return facility({ lender: row.lender, borrower: row.borrower }, true);
      for (const row of r.transaction_type_mix ?? []) if (cellsMatch(cells, row.txn_type) || cellsMatch(cells, String(row.txn_type).replace(/_/g, ' '))) return filings({ entity: name, county, txn_type: row.txn_type }, true);
      return null;
    }
    case 'search_entities': {
      for (const row of r.matches ?? []) if (cellsMatch(cells, row.entity)) return filings({ entity: row.entity, county: 'ALL' }, true);
      return null;
    }
    case 'list_filings': {
      for (const row of r.rows ?? []) if (row.cfn && cellsContain(cells, row.cfn)) return { kind: 'record', record: row, recordType: 'filing', label: `CFN ${row.cfn}`, exact: true };
      return null;
    }
    case 'list_facility_filings': {
      for (const row of r.rows ?? []) if (row.cfn && cellsContain(cells, row.cfn)) return { kind: 'record', record: row, recordType: 'facility_filing', label: `CFN ${row.cfn}`, exact: true };
      return null;
    }
    case 'get_lending_relationships': {
      // Grouped rows carry the exact grouping keys; drilling by them reproduces
      // the row's filing count, where a name LIKE would miss recorded variants.
      let best: Drill | null = null;
      for (const row of r.rows ?? []) {
        const borrowerName = row.is_family && row.borrower_parent ? row.borrower_parent : row.borrower;
        const l = cellsMatch(cells, row.lender);
        const b = cellsMatch(cells, borrowerName) || cellsMatch(cells, row.borrower) || cellsMatch(cells, row.borrower_parent);
        const pair = {
          lender_key: row.lender_key, borrower_group_key: row.group_key,
          lender: row.lender_key ? undefined : row.lender, borrower: row.group_key ? undefined : borrowerName,
        };
        if (l && b) return { ...facility(pair, true), label: `${row.lender} → ${borrowerName}` };
        if (!best && (l || b)) best = l
          ? { ...facility({ lender_key: row.lender_key, lender: row.lender_key ? undefined : row.lender }, true), label: `lender ${row.lender}` }
          : { ...facility({ borrower_group_key: row.group_key, borrower: row.group_key ? undefined : borrowerName }, true), label: `borrower ${borrowerName}` };
      }
      return best;
    }
    case 'run_sql': {
      // A SQL row whose string values appear in the table row: use the column
      // names to decide what each matched value means.
      const cols: string[] = r.columns ?? [];
      for (const row of r.rows ?? []) {
        const hit: Record<string, string> = {};
        let matched = 0;
        for (const col of cols) {
          const v = row[col];
          if (v === null || v === undefined) continue;
          if (typeof v === 'string' && !cellsMatch(cells, v)) continue;
          if (typeof v === 'number' && !cells.includes(String(v))) continue;
          const role = roleForHeader(col);
          const period = parsePeriod(v);
          if (/\bcfn\b|instrument/i.test(col) && typeof v === 'string') { hit.cfn = v; matched++; }
          else if (role === 'lender' && typeof v === 'string') { hit.lender = v; matched++; }
          else if (role === 'borrower' && typeof v === 'string') { hit.borrower = v; matched++; }
          else if (role && typeof v === 'string') {
            if (!hit.entity) { hit.entity = v; hit.role = role; } else if (!hit.counterparty) hit.counterparty = v;
            matched++;
          }
          else if (period && /period|month|quarter|year|date/i.test(col)) { hit.from = period.from; hit.to = period.to; matched++; }
          else if (/county/i.test(col) && typeof v === 'string') hit.county = v;
          else if (/txn|type/i.test(col) && typeof v === 'string' && TXN_TYPES.has(v.toUpperCase())) hit.txn_type = v.toUpperCase();
        }
        if (!matched) continue;
        if (hit.lender || hit.borrower) return facility({ lender: hit.lender, borrower: hit.borrower, cfn: hit.cfn }, false);
        if (hit.cfn || hit.entity || hit.from) return filings({ ...hit, role: hit.role === 'either' ? undefined : hit.role }, false);
      }
      return null;
    }
    default:
      return null;
  }
}

// ── tier 2: column headers ───────────────────────────────────────────────────

type HeaderRole = 'assignor' | 'assignee' | 'either' | 'lender' | 'borrower' | null;

function roleForHeader(h: string): HeaderRole {
  const s = normCell(h);
  if (!s) return null;
  if (/LENDER|SECURED PARTY|PROVIDER|\bBANK\b/.test(s) && !/BORROWER/.test(s)) return 'lender';
  if (/BORROWER/.test(s)) return 'borrower';
  if (/ASSIGNOR|SELLER|GRANTOR|\bFROM\b|SOLD BY|TRANSFEROR/.test(s)) return 'assignor';
  if (/ASSIGNEE|BUYER|ACQUIRER|PURCHASER|GRANTEE|\bTO\b|INVESTOR|TRANSFEREE|BOUGHT BY/.test(s)) return 'assignee';
  if (/ENTITY|INSTITUTION|COMPANY|\bNAME\b|COUNTERPARTY|SERVICER|FUND|TRUST|PARTY|FIRM|ORGANI[SZ]ATION|CANON/.test(s)) return 'either';
  return null;
}

function isPeriodHeader(h: string): boolean {
  return /MONTH|QUARTER|YEAR|PERIOD|DATE|WHEN/.test(normCell(h));
}

export interface DrillDefaults {
  county: string;                 // dashboard scope: MIAMI-DADE | BROWARD | ALL
  from?: string; to?: string;     // window the model's lookups used, if any
}

function fromHeaders(headers: string[], cells: string[], defaults: DrillDefaults): Drill | null {
  const n = Math.min(headers.length, cells.length);
  let entity: string | undefined, role: HeaderRole = null, counterparty: string | undefined;
  let lender: string | undefined, borrower: string | undefined;
  let period: Period | null = null;
  let county: string | undefined, txn: string | undefined;

  for (let i = 0; i < n; i++) {
    const h = headers[i];
    const raw = cells[i];
    const c = normCell(raw);
    if (isBlankish(c)) continue;
    const r = roleForHeader(h);
    if (r === 'lender') { lender = lender ?? raw.trim(); continue; }
    if (r === 'borrower') { borrower = borrower ?? raw.trim(); continue; }
    if (r && !parsePeriod(c)) {
      if (!entity) { entity = raw.trim(); role = r; } else if (!counterparty) counterparty = raw.trim();
      continue;
    }
    if (!period && (isPeriodHeader(h) || parsePeriod(c))) { period = parsePeriod(c); if (period) continue; }
    if (/COUNTY/.test(normCell(h))) { county = /BROWARD/.test(c) ? 'BROWARD' : /MIAMI|DADE/.test(c) ? 'MIAMI-DADE' : undefined; continue; }
    if (/TYPE|CATEGORY/.test(normCell(h))) { const t = c.replace(/[\s-]+/g, '_'); if (TXN_TYPES.has(t)) txn = t; }
  }

  if (lender || borrower) return facility({ lender, borrower }, false);
  if (!entity && !period) return null;
  return filings({
    entity, role: role === 'either' ? undefined : role ?? undefined, counterparty,
    county: county ?? defaults.county,
    from: period?.from ?? defaults.from, to: period?.to ?? defaults.to,
    txn_type: txn,
  }, false);
}

// ── entry point ──────────────────────────────────────────────────────────────

/** County / date window the model's lookups used, as defaults for tier 2. */
export function defaultsFromSteps(steps: DrillStep[], dashboardCounty: string): DrillDefaults {
  const d: DrillDefaults = { county: dashboardCounty };
  for (const s of steps) {
    const a = s.args ?? {};
    if (!d.from && typeof a.from === 'string') d.from = a.from.length === 7 ? `${a.from}-01` : a.from;
    if (!d.to && typeof a.to === 'string') d.to = a.to;
    if (typeof a.county === 'string' && a.county) d.county = a.county.toUpperCase();
  }
  return d;
}

export function resolveDrill(headers: string[], rawCells: string[], steps: DrillStep[], defaults: DrillDefaults): Drill | null {
  const cells = rawCells.map(normCell);
  if (!cells.some(c => !isBlankish(c))) return null;
  // Most recent lookups first: a follow-up answer usually tables its own lookups.
  for (let i = steps.length - 1; i >= 0; i--) {
    const d = fromStep(steps[i], cells);
    if (d) return d;
  }
  return fromHeaders(headers, rawCells, defaults);
}

/** One-line description of the row, for the "Ask about this row" prompt. */
export function describeRow(headers: string[], cells: string[]): string {
  const n = Math.max(headers.length, cells.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = (headers[i] ?? '').trim();
    const c = (cells[i] ?? '').trim();
    if (!c) continue;
    parts.push(h ? `${h}: ${c}` : c);
  }
  return parts.join('; ');
}
