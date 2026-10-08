/**
 * Tools the "Ask the Data" assistant can call.
 *
 * The model never sees the database directly. It sees these function
 * signatures, decides which to call, and reads the JSON they return. Every
 * tool is read-only and bounded (row caps, LIMITs) so a bad question costs at
 * most a slow query, never a write.
 *
 * Two kinds of tool live here:
 *   - Curated tools: fixed queries mirroring what the dashboard pages show.
 *     Predictable, cheap, and they already encode the data caveats (county
 *     scoping, case-insensitive grouping, the facility_amount trap).
 *   - run_sql: a guarded read-only SELECT against a separate readonly
 *     connection, for questions the curated tools cannot express. The schema
 *     the model is given for this lives in prompt.ts next to its caveats.
 */

import Database from 'better-sqlite3';
import path from 'path';
import zlib from 'zlib';
import { queryGroupedFacilities } from '../lending/facilities';

const DEFAULT_COUNTY = 'MIAMI-DADE';
const MAX_ROWS = 200;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (db: Database.Database, args: Record<string, any>) => unknown;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** 'MIAMI-DADE' | 'BROWARD' | null (= all counties). Unknown input → default. */
function normalizeCounty(v: unknown): string | null {
  const raw = String(v ?? '').trim().toUpperCase();
  if (!raw) return DEFAULT_COUNTY;
  if (raw === 'ALL') return null;
  if (raw === 'MIAMI-DADE' || raw === 'MIAMI DADE' || raw === 'MIAMIDADE' || raw === 'DADE') return 'MIAMI-DADE';
  if (raw === 'BROWARD') return 'BROWARD';
  return DEFAULT_COUNTY;
}

function countyClause(county: string | null, alias = ''): { sql: string; params: any[] } {
  if (!county) return { sql: '', params: [] };
  return { sql: `AND COALESCE(${alias}county, '${DEFAULT_COUNTY}') = ?`, params: [county] };
}

function clampLimit(v: unknown, dflt: number, max = MAX_ROWS): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

function isoDate(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? (s.length === 7 ? `${s}-01` : s) : undefined;
}

function dateClause(col: string, from?: string, to?: string): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  if (from) { parts.push(`AND ${col} >= ?`); params.push(from); }
  if (to)   { parts.push(`AND ${col} <= ?`); params.push(to); }
  return { sql: parts.join(' '), params };
}

// ── Tool: dataset overview ───────────────────────────────────────────────────

const getDatasetOverview: ToolSpec = {
  name: 'get_dataset_overview',
  description:
    'Coverage of the dataset: per-county filing counts, date ranges, how many filings have been processed into clean loan-transfer events, how many PDFs have been read, lending-relationship counts, and whole months with no data. Call this first when a question depends on what the data covers, or when asked "what data do you have".',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run(db) {
    const perCounty = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county,
             COUNT(*) AS filings, MIN(rec_date) AS first_date, MAX(rec_date) AS last_date,
             COUNT(DISTINCT doc_type) AS doc_types
      FROM assignments GROUP BY 1 ORDER BY filings DESC
    `).all() as any[];
    const cleanPerCounty = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county, COUNT(*) AS clean_events,
             MIN(rec_date) AS first_date, MAX(rec_date) AS last_date
      FROM aom_events_clean GROUP BY 1
    `).all() as any[];
    const docTypes = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county, doc_type, COUNT(*) AS n
      FROM assignments GROUP BY 1, 2 ORDER BY n DESC LIMIT 20
    `).all();
    const txnTypes = db.prepare(`SELECT txn_type, COUNT(*) AS n FROM aom_events_clean GROUP BY 1 ORDER BY n DESC`).all();
    const extractions = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county, COUNT(*) AS pdfs_read
      FROM pdf_extractions GROUP BY 1
    `).all();
    const facilities = db.prepare(`
      SELECT COUNT(*) AS filings, COUNT(DISTINCT COALESCE(lender_key, UPPER(facility_lender_name)) || '|' || COALESCE(borrower_key, UPPER(facility_borrower_name))) AS relationships,
             MIN(rec_date) AS first_date, MAX(rec_date) AS last_date
      FROM credit_facility_events
    `).get();
    const entities = db.prepare(`SELECT COUNT(*) AS n FROM entity_nodes`).get() as any;
    const lastCollected = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county, MAX(date_to) AS last_collected_through
      FROM collection_log WHERE status = 'OK' GROUP BY 1
    `).all();

    // Whole months with zero filings between a county's first and last month.
    const months = db.prepare(`
      SELECT COALESCE(county, '${DEFAULT_COUNTY}') AS county, substr(rec_date, 1, 7) AS month
      FROM assignments WHERE rec_date IS NOT NULL AND rec_date <> '' GROUP BY 1, 2
    `).all() as Array<{ county: string; month: string }>;
    const byCounty = new Map<string, Set<string>>();
    for (const r of months) {
      if (!byCounty.has(r.county)) byCounty.set(r.county, new Set());
      byCounty.get(r.county)!.add(r.month);
    }
    const gaps: Array<{ county: string; missing_months: string[] }> = [];
    byCounty.forEach((set, county) => {
      const sorted = Array.from(set).sort();
      const missing: string[] = [];
      let [y, m] = sorted[0].split('-').map(Number);
      const last = sorted[sorted.length - 1];
      for (;;) {
        m += 1; if (m > 12) { m = 1; y += 1; }
        const cur = `${y}-${String(m).padStart(2, '0')}`;
        if (cur >= last) break;
        if (!set.has(cur)) missing.push(cur);
      }
      if (missing.length) gaps.push({ county, missing_months: missing });
    });

    return {
      filings_by_county: perCounty,
      clean_loan_transfer_events_by_county: cleanPerCounty,
      top_document_types: docTypes,
      transaction_types: txnTypes,
      pdfs_read_by_county: extractions,
      lending_relationships: facilities,
      resolved_entities: entities.n,
      last_collected_through: lastCollected,
      months_with_no_data: gaps,
      notes: [
        '"filings" counts every recorded document in the raw index (assignments table). "clean_loan_transfer_events" are the subset normalized into assignor→assignee loan transfers with resolved names (aom_events_clean).',
        'Broward filings are indexed but very few have been processed into clean events or read as PDFs, so any entity-level or lending-relationship figure is effectively Miami-Dade only.',
        'months_with_no_data are collection gaps, not market stops.',
      ],
    };
  },
};

// ── Tool: entity search ──────────────────────────────────────────────────────

const searchEntities: ToolSpec = {
  name: 'search_entities',
  description:
    'Find resolved entities (lenders, servicers, trusts, funds, investors) whose canonical name or a known alias contains the search text. Use this to turn a user\'s informal name ("Mr Cooper", "Wells") into the exact canonical entity name before calling get_entity_profile or list_filings. Returns volumes so you can pick the most likely match.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Part of the entity name, case-insensitive.' },
      limit: { type: 'integer', description: 'Max results (default 15, max 50).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run(db, args) {
    const q = String(args.query ?? '').trim();
    if (!q) return { error: 'query is required' };
    const limit = clampLimit(args.limit, 15, 50);
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT n.entity, n.entity_type, n.inbound_vol AS acquired, n.outbound_vol AS sold,
             n.total_vol, n.degree AS counterparties, n.first_seen, n.last_seen,
             (SELECT GROUP_CONCAT(variant, ' | ') FROM (
                SELECT variant FROM entity_aliases a WHERE a.canonical = n.entity LIMIT 5)) AS known_aliases
      FROM entity_nodes n
      WHERE n.entity LIKE ? COLLATE NOCASE
         OR n.entity IN (SELECT canonical FROM entity_aliases WHERE variant LIKE ? COLLATE NOCASE)
      ORDER BY n.total_vol DESC LIMIT ?
    `).all(like, like, limit);
    // Raw (unresolved) names that match but never became an entity node —
    // useful when the user names a small or one-off party.
    const raw = db.prepare(`
      SELECT name, SUM(n) AS filings FROM (
        SELECT assignor AS name, COUNT(*) AS n FROM aom_events_clean WHERE assignor LIKE ? COLLATE NOCASE GROUP BY 1
        UNION ALL
        SELECT assignee AS name, COUNT(*) AS n FROM aom_events_clean WHERE assignee LIKE ? COLLATE NOCASE GROUP BY 1
      ) GROUP BY name ORDER BY filings DESC LIMIT 10
    `).all(like, like);
    return { matches: rows, raw_recorded_name_matches: raw, note: 'Volumes are counts of clean loan-transfer events across all counties (entity figures are not county-scoped).' };
  },
};

// ── Tool: entity profile ─────────────────────────────────────────────────────

const getEntityProfile: ToolSpec = {
  name: 'get_entity_profile',
  description:
    'Full profile for one canonical entity: volumes, classification, top counterparties it acquired from and sold to, transaction-type mix, and monthly activity. Requires the exact canonical name (use search_entities first).',
  parameters: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Exact canonical entity name as returned by search_entities.' },
      county: { type: 'string', description: "'MIAMI-DADE' (default), 'BROWARD' or 'ALL' — applies to filings/monthly activity only." },
      months: { type: 'integer', description: 'How many trailing months of monthly activity to include (default 24, max 60).' },
    },
    required: ['entity'],
    additionalProperties: false,
  },
  run(db, args) {
    const entity = String(args.entity ?? '').trim();
    if (!entity) return { error: 'entity is required' };
    const node = db.prepare(`SELECT * FROM entity_nodes WHERE entity = ? COLLATE NOCASE`).get(entity) as any;
    if (!node) return { error: `No entity named "${entity}". Use search_entities to find the canonical name.` };
    const name = node.entity;
    const county = normalizeCounty(args.county);
    const cc = countyClause(county);
    const months = clampLimit(args.months, 24, 60);

    const acquiredFrom = db.prepare(`
      SELECT source_entity AS counterparty, transaction_count AS transfers, first_seen_date, last_seen_date
      FROM entity_relationships WHERE target_entity = ? ORDER BY transaction_count DESC LIMIT 10
    `).all(name);
    const soldTo = db.prepare(`
      SELECT target_entity AS counterparty, transaction_count AS transfers, first_seen_date, last_seen_date
      FROM entity_relationships WHERE source_entity = ? ORDER BY transaction_count DESC LIMIT 10
    `).all(name);
    const txnMix = db.prepare(`
      SELECT txn_type,
             SUM(CASE WHEN assignee_canon = ? THEN 1 ELSE 0 END) AS as_assignee,
             SUM(CASE WHEN assignor_canon = ? THEN 1 ELSE 0 END) AS as_assignor
      FROM aom_events_clean
      WHERE (assignee_canon = ? OR assignor_canon = ?) ${cc.sql}
      GROUP BY txn_type ORDER BY (as_assignee + as_assignor) DESC
    `).all(name, name, name, name, ...cc.params);
    const monthly = db.prepare(`
      SELECT month, acquired, sold FROM (
        SELECT substr(rec_date, 1, 7) AS month,
               SUM(CASE WHEN assignee_canon = ? THEN 1 ELSE 0 END) AS acquired,
               SUM(CASE WHEN assignor_canon = ? THEN 1 ELSE 0 END) AS sold
        FROM aom_events_clean
        WHERE (assignee_canon = ? OR assignor_canon = ?) ${cc.sql}
        GROUP BY month ORDER BY month DESC LIMIT ?
      ) ORDER BY month
    `).all(name, name, name, name, ...cc.params, months);
    const aliases = db.prepare(`SELECT variant FROM entity_aliases WHERE canonical = ? LIMIT 20`).all(name).map((r: any) => r.variant);
    const facilities = db.prepare(`
      SELECT facility_lender_name AS lender, facility_borrower_name AS borrower, facility_type, facility_amount, facility_amount_type, COUNT(*) AS filings, MIN(rec_date) AS first_date, MAX(rec_date) AS last_date
      FROM credit_facility_events
      WHERE facility_lender_name LIKE ? COLLATE NOCASE OR facility_borrower_name LIKE ? COLLATE NOCASE
      GROUP BY 1, 2, 3, 4, 5 ORDER BY filings DESC LIMIT 10
    `).all(`%${name}%`, `%${name}%`);

    return {
      entity: node,
      aliases,
      acquired_from: acquiredFrom,
      sold_to: soldTo,
      transaction_type_mix: txnMix,
      monthly_activity: monthly,
      lending_relationships: facilities,
      scope: { county: county ?? 'ALL', note: 'entity totals and counterparties are cross-county; transaction mix and monthly activity respect the county parameter.' },
    };
  },
};

// ── Tool: top entities ───────────────────────────────────────────────────────

const getTopEntities: ToolSpec = {
  name: 'get_top_entities',
  description:
    'Rank entities by number of clean loan-transfer events in a date window: top acquirers (assignees) or top sellers (assignors). Supports filtering by transaction type and entity classification. Use for "who bought the most loans in 2025", "most active private credit buyers last quarter", etc.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['assignee', 'assignor'], description: 'assignee = acquirer/buyer of the loan; assignor = seller.' },
      county: { type: 'string', description: "'MIAMI-DADE' (default), 'BROWARD' or 'ALL'." },
      from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
      to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
      txn_type: { type: 'string', enum: ['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT', 'PRIVATE', 'SELF_ASSIGN', 'MERS_RELEASE'], description: 'Optional. Default excludes SELF_ASSIGN.' },
      entity_type: { type: 'string', enum: ['BANK', 'TRUST', 'PRIVATE_CREDIT', 'SERVICER', 'GSE', 'MERS', 'OTHER'], description: 'Optional classification filter on the ranked entity.' },
      limit: { type: 'integer', description: 'Default 15, max 100.' },
    },
    required: ['role'],
    additionalProperties: false,
  },
  run(db, args) {
    const role = args.role === 'assignor' ? 'assignor' : 'assignee';
    const col = `${role}_canon`;
    const typeCol = `${role}_type`;
    const county = normalizeCounty(args.county);
    const cc = countyClause(county);
    const dc = dateClause('rec_date', isoDate(args.from), isoDate(args.to));
    const where: string[] = [];
    const params: any[] = [];
    if (args.txn_type) { where.push('AND txn_type = ?'); params.push(String(args.txn_type)); }
    else where.push("AND txn_type != 'SELF_ASSIGN'");
    if (args.entity_type) { where.push(`AND ${typeCol} = ?`); params.push(String(args.entity_type)); }
    const limit = clampLimit(args.limit, 15, 100);
    const rows = db.prepare(`
      SELECT ${col} AS entity, MAX(${typeCol}) AS entity_type, COUNT(*) AS transfers,
             COUNT(DISTINCT ${role === 'assignee' ? 'assignor_canon' : 'assignee_canon'}) AS distinct_counterparties,
             MIN(rec_date) AS first_date, MAX(rec_date) AS last_date
      FROM aom_events_clean
      WHERE ${col} IS NOT NULL ${cc.sql} ${dc.sql} ${where.join(' ')}
      GROUP BY ${col} ORDER BY transfers DESC LIMIT ?
    `).all(...cc.params, ...dc.params, ...params, limit);
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM aom_events_clean WHERE ${col} IS NOT NULL ${cc.sql} ${dc.sql} ${where.join(' ')}
    `).get(...cc.params, ...dc.params, ...params) as any;
    return { role, county: county ?? 'ALL', from: isoDate(args.from) ?? null, to: isoDate(args.to) ?? null, total_events_in_window: total.n, rows };
  },
};

// ── Tool: monthly volume ─────────────────────────────────────────────────────

const getMonthlyVolume: ToolSpec = {
  name: 'get_monthly_volume',
  description:
    'Monthly counts of clean loan-transfer events, split by transaction type, with distinct assignor/assignee counts. Use for trend questions ("is volume up or down", "busiest month", "compare 2024 vs 2025"). Optionally restrict to one entity.',
  parameters: {
    type: 'object',
    properties: {
      county: { type: 'string', description: "'MIAMI-DADE' (default), 'BROWARD' or 'ALL'." },
      from: { type: 'string', description: 'Start YYYY-MM or YYYY-MM-DD.' },
      to: { type: 'string', description: 'End YYYY-MM or YYYY-MM-DD.' },
      entity: { type: 'string', description: 'Optional exact canonical entity; counts events where it is assignor or assignee.' },
      granularity: { type: 'string', enum: ['month', 'quarter', 'year'], description: 'Default month.' },
    },
    additionalProperties: false,
  },
  run(db, args) {
    const county = normalizeCounty(args.county);
    const cc = countyClause(county);
    const dc = dateClause('rec_date', isoDate(args.from), isoDate(args.to));
    const entity = String(args.entity ?? '').trim();
    const ec = entity ? { sql: 'AND (assignor_canon = ? OR assignee_canon = ?)', params: [entity, entity] } : { sql: '', params: [] };
    const g = args.granularity === 'year' ? "substr(rec_date,1,4)"
      : args.granularity === 'quarter' ? "substr(rec_date,1,4) || '-Q' || ((CAST(substr(rec_date,6,2) AS INTEGER) + 2) / 3)"
      : "substr(rec_date,1,7)";
    const rows = db.prepare(`
      SELECT ${g} AS period, COUNT(*) AS total,
             SUM(CASE WHEN txn_type='MARKET_TRANSFER'   THEN 1 ELSE 0 END) AS market_transfers,
             SUM(CASE WHEN txn_type='ORIGINATION'       THEN 1 ELSE 0 END) AS originations,
             SUM(CASE WHEN txn_type='INSTITUTIONAL_OUT' THEN 1 ELSE 0 END) AS institutional_out,
             SUM(CASE WHEN txn_type='PRIVATE'           THEN 1 ELSE 0 END) AS private,
             SUM(CASE WHEN txn_type='SELF_ASSIGN'       THEN 1 ELSE 0 END) AS self_assign,
             COUNT(DISTINCT assignor_canon) AS unique_assignors,
             COUNT(DISTINCT assignee_canon) AS unique_assignees
      FROM aom_events_clean
      WHERE rec_date IS NOT NULL ${cc.sql} ${dc.sql} ${ec.sql}
      GROUP BY period ORDER BY period LIMIT ${MAX_ROWS}
    `).all(...cc.params, ...dc.params, ...ec.params);
    return { county: county ?? 'ALL', entity: entity || null, rows };
  },
};

// ── Tool: list filings ───────────────────────────────────────────────────────

const listFilings: ToolSpec = {
  name: 'list_filings',
  description:
    'Individual clean loan-transfer filings (one row per recorded document) with CFN, date, assignor, assignee, transaction type, property address and loan amount when a PDF was read. Filter by entity (as assignor, assignee or either), county, dates, transaction type, or counterparty pair. Use when the user wants specific deals, recent activity, examples, or a pair\'s history.',
  parameters: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Exact canonical entity name.' },
      role: { type: 'string', enum: ['assignee', 'assignor', 'either'], description: 'Which side the entity is on. Default either.' },
      counterparty: { type: 'string', description: 'Optional exact canonical name of the other party.' },
      county: { type: 'string', description: "'MIAMI-DADE' (default), 'BROWARD' or 'ALL'." },
      from: { type: 'string' }, to: { type: 'string' },
      txn_type: { type: 'string', enum: ['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT', 'PRIVATE', 'SELF_ASSIGN', 'MERS_RELEASE'] },
      exclude_self_assign: { type: 'boolean', description: 'Drop SELF_ASSIGN rows (matches the default of get_top_entities).' },
      cfn: { type: 'string', description: 'Look up one specific document by its CFN / instrument number.' },
      limit: { type: 'integer', description: 'Default 25, max 200.' },
      offset: { type: 'integer' },
    },
    additionalProperties: false,
  },
  run(db, args) {
    const county = normalizeCounty(args.county);
    const cc = countyClause(county, 'c.');
    const dc = dateClause('c.rec_date', isoDate(args.from), isoDate(args.to));
    const where: string[] = [];
    const params: any[] = [];
    const entity = String(args.entity ?? '').trim();
    const cp = String(args.counterparty ?? '').trim();
    const role = args.role === 'assignee' || args.role === 'assignor' ? args.role : 'either';
    if (entity) {
      if (role === 'assignee') { where.push('AND c.assignee_canon = ?'); params.push(entity); }
      else if (role === 'assignor') { where.push('AND c.assignor_canon = ?'); params.push(entity); }
      else { where.push('AND (c.assignee_canon = ? OR c.assignor_canon = ?)'); params.push(entity, entity); }
    }
    if (cp) { where.push('AND (c.assignee_canon = ? OR c.assignor_canon = ?)'); params.push(cp, cp); }
    if (args.txn_type) { where.push('AND c.txn_type = ?'); params.push(String(args.txn_type)); }
    else if (args.exclude_self_assign === true || args.exclude_self_assign === 'true' || args.exclude_self_assign === '1') where.push("AND c.txn_type != 'SELF_ASSIGN'");
    if (args.cfn) { where.push('AND c.cfn = ?'); params.push(String(args.cfn).trim()); }
    const limit = clampLimit(args.limit, 25);
    const offset = Math.max(0, Number(args.offset) || 0);
    const rows = db.prepare(`
      SELECT c.cfn, c.rec_date, c.county, c.doc_type, c.txn_type,
             c.assignor, c.assignor_canon, c.assignor_type,
             c.assignee, c.assignee_canon, c.assignee_type,
             COALESCE(c.property_address, a.address) AS property_address,
             c.loan_amount, c.consideration_amount, c.rec_book, c.rec_page
      FROM aom_events_clean c LEFT JOIN assignments a ON a.cfn = c.cfn
      WHERE 1=1 ${cc.sql} ${dc.sql} ${where.join(' ')}
      ORDER BY c.rec_date DESC, c.cfn DESC LIMIT ? OFFSET ?
    `).all(...cc.params, ...dc.params, ...params, limit, offset);
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM aom_events_clean c WHERE 1=1 ${cc.sql} ${dc.sql} ${where.join(' ')}
    `).get(...cc.params, ...dc.params, ...params) as any;
    return { total_matching: total.n, returned: rows.length, offset, rows, note: 'loan_amount/property_address are only present where the PDF was read; absence means unknown, not zero.' };
  },
};

// ── Tool: lending relationships (credit facilities) ─────────────────────────

const getLendingRelationships: ToolSpec = {
  name: 'get_lending_relationships',
  description:
    'Lender↔borrower credit facilities (warehouse lines, revolving credit, collateral assignment programs) detected by reading recorded documents, grouped one row per relationship with filing count, facility size and activity range. Use for "which banks provide warehouse lines", "who lends to X", "largest credit facilities". Facility amounts are credit limits quoted on each filing — never sum them across filings.',
  parameters: {
    type: 'object',
    properties: {
      lender: { type: 'string', description: 'Partial lender name, case-insensitive.' },
      borrower: { type: 'string', description: 'Partial borrower name, case-insensitive.' },
      facility_type: { type: 'string', enum: ['warehouse_or_revolving_credit_facility', 'consumer_or_business_line_of_credit'], description: 'Optional. Institutional facilities are warehouse_or_revolving_credit_facility; the other value is consumer HELOC-style lines.' },
      from: { type: 'string' }, to: { type: 'string' },
      county: { type: 'string', description: "Default ALL for this tool (facilities are few)." },
      sort: { type: 'string', enum: ['filings', 'amount', 'activity'], description: 'Default filings.' },
      limit: { type: 'integer', description: 'Default 25, max 100.' },
    },
    additionalProperties: false,
  },
  run(db, args) {
    const countyRaw = String(args.county ?? 'ALL');
    const county = normalizeCounty(countyRaw || 'ALL');
    const result = queryGroupedFacilities(db, {
      county,
      lender: args.lender ? String(args.lender) : undefined,
      borrower: args.borrower ? String(args.borrower) : undefined,
      facilityType: args.facility_type ? String(args.facility_type) : undefined,
      startDate: isoDate(args.from), endDate: isoDate(args.to),
      sort: args.sort ? String(args.sort) : undefined, dir: 'desc',
      limit: clampLimit(args.limit, 25, 100), offset: 0,
    });
    const types = db.prepare(`SELECT facility_type, COUNT(*) AS n FROM credit_facility_events GROUP BY 1 ORDER BY n DESC`).all();
    return { total_relationships: result.total, total_filings: result.totalFilings, rows: result.rows, facility_types_available: types };
  },
};

const listFacilityFilings: ToolSpec = {
  name: 'list_facility_filings',
  description:
    'The individual recorded filings behind a lending relationship, with the evidence quote the detector found, agreement name/date, agent, and the direction of the assignment. Use after get_lending_relationships to explain or verify a specific lender↔borrower pair.',
  parameters: {
    type: 'object',
    properties: {
      lender: { type: 'string', description: 'Partial lender name.' },
      borrower: { type: 'string', description: 'Partial borrower name.' },
      lender_key: { type: 'string', description: 'Exact lender_key as returned by get_lending_relationships (preferred over lender when you have it — it reproduces the grouped row exactly).' },
      borrower_group_key: { type: 'string', description: 'Exact group_key as returned by get_lending_relationships (the borrower, or its corporate family when grouped).' },
      cfn: { type: 'string' },
      limit: { type: 'integer', description: 'Default 25, max 100.' },
    },
    additionalProperties: false,
  },
  run(db, args) {
    const where: string[] = [];
    const params: any[] = [];
    if (args.lender)   { where.push('AND e.facility_lender_name LIKE ? COLLATE NOCASE'); params.push(`%${args.lender}%`); }
    if (args.borrower) { where.push('AND (e.facility_borrower_name LIKE ? COLLATE NOCASE OR e.borrower_recorded LIKE ? COLLATE NOCASE OR e.borrower_parent LIKE ? COLLATE NOCASE)'); params.push(`%${args.borrower}%`, `%${args.borrower}%`, `%${args.borrower}%`); }
    // Same grouping expressions as queryGroupedFacilities, so a key from a
    // grouped row selects exactly that row's filings.
    if (args.lender_key)         { where.push(`AND COALESCE(e.lender_key, UPPER(COALESCE(e.facility_lender_name, ''))) = ?`); params.push(String(args.lender_key)); }
    if (args.borrower_group_key) { where.push(`AND COALESCE(e.borrower_parent, COALESCE(e.borrower_key, UPPER(COALESCE(e.facility_borrower_name, '')))) = ?`); params.push(String(args.borrower_group_key)); }
    if (args.cfn)      { where.push('AND e.cfn = ?'); params.push(String(args.cfn).trim()); }
    if (!where.length) return { error: 'Provide lender, borrower, lender_key/borrower_group_key or cfn.' };
    // rec_book/rec_page come from the raw index so the browser can link the
    // recorded image (Miami-Dade only — see client/src/lib/doc-url.ts).
    const rows = db.prepare(`
      SELECT e.cfn, e.rec_date, e.county, e.doc_type, e.grantor, e.grantee, e.direction, e.grantor_role, e.grantee_role,
             e.facility_type, e.facility_lender_name, e.facility_borrower_name, e.borrower_parent, e.facility_agent_name,
             e.facility_agreement_name, e.facility_agreement_date, e.facility_amount, e.facility_amount_type,
             e.facility_confidence, e.facility_evidence_quote, a.rec_book, a.rec_page
      FROM credit_facility_events e LEFT JOIN assignments a ON a.cfn = e.cfn
      WHERE 1=1 ${where.join(' ')}
      ORDER BY e.rec_date DESC LIMIT ?
    `).all(...params, clampLimit(args.limit, 25, 100));
    const total = db.prepare(`SELECT COUNT(*) AS n FROM credit_facility_events e WHERE 1=1 ${where.join(' ')}`).get(...params) as any;
    return { total_matching: total.n, returned: rows.length, rows };
  },
};

// ── Tool: stored document text ───────────────────────────────────────────────
// collector/reread_documents.py keeps the OCR text of every Miami-Dade loan
// transfer, zlib-compressed, in document_text (production only — local dev DBs
// usually lack the table). This lets the assistant actually read a filing.

const MAX_DOC_CHARS = 12_000;

const getDocumentText: ToolSpec = {
  name: 'get_document_text',
  description:
    'The OCR text of one recorded document, when it has been stored (Miami-Dade loan transfers re-read since Sept 2026). Use to answer "what does this filing say", confirm parties/amounts/addresses, or read loan terms the extracted fields do not cover. Text is OCR output and may contain errors. Returns an explanation when no text is stored for the CFN.',
  parameters: {
    type: 'object',
    properties: {
      cfn: { type: 'string', description: 'Clerk file / instrument number, e.g. 2025R123456.' },
      max_chars: { type: 'integer', description: `Characters to return (default ${MAX_DOC_CHARS}); the start of the document is returned first.` },
      offset: { type: 'integer', description: 'Character offset to continue reading a long document.' },
    },
    required: ['cfn'],
    additionalProperties: false,
  },
  run(db, args) {
    const cfn = String(args.cfn ?? '').trim();
    if (!cfn) return { error: 'cfn is required' };
    const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_text'`).get();
    if (!hasTable) return { error: 'No document text is stored in this database (document_text table absent).' };
    const row = db.prepare(`SELECT status, chars, detail, ocr_at, county, text_z FROM document_text WHERE cfn = ?`).get(cfn) as any;
    if (!row) return { cfn, stored: false, note: 'No stored text for this CFN — only Miami-Dade loan-transfer filings have been re-read so far.' };
    if (row.status !== 'OK' || !row.text_z) return { cfn, stored: false, status: row.status, detail: row.detail, note: 'The document was attempted but could not be read.' };
    const text = zlib.inflateSync(row.text_z as Buffer).toString('utf8');
    const offset = Math.max(0, Number(args.offset) || 0);
    const max = clampLimit(args.max_chars, MAX_DOC_CHARS, 40_000);
    const slice = text.slice(offset, offset + max);
    return { cfn, stored: true, county: row.county, total_chars: text.length, offset, returned_chars: slice.length, truncated: offset + slice.length < text.length, ocr_at: row.ocr_at, text: slice };
  },
};

// ── Tool: guarded read-only SQL ──────────────────────────────────────────────

const DB_PATH = process.env.AMO_DB_PATH || path.resolve(process.cwd(), 'miami_dade_amo.db');
let _ro: Database.Database | null = null;
function roDb(): Database.Database {
  if (!_ro) {
    _ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    _ro.pragma('query_only = 1');
  }
  return _ro;
}

const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|REINDEX|TRUNCATE|LOAD_EXTENSION|RANDOMBLOB|ZEROBLOB)\b/i;

export function validateReadOnlySql(sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  let s = sql.trim();
  if (s.endsWith(';')) s = s.slice(0, -1).trim();
  if (!s) return { ok: false, error: 'Empty SQL.' };
  if (s.includes(';')) return { ok: false, error: 'Only a single statement is allowed.' };
  if (!/^(SELECT|WITH)\b/i.test(s)) return { ok: false, error: 'Only SELECT (or WITH ... SELECT) statements are allowed.' };
  const m = FORBIDDEN.exec(s);
  if (m) return { ok: false, error: `Statement contains a forbidden keyword: ${m[1]}.` };
  return { ok: true, sql: s };
}

const runSql: ToolSpec = {
  name: 'run_sql',
  description:
    'Run ONE read-only SQLite SELECT against the database when no curated tool answers the question (unusual groupings, UCC financing statements, cross-table joins, property/address searches, PDF extraction fields). Use the schema in your instructions. Results are capped at 200 rows; aggregate in SQL rather than pulling raw rows. Prefer curated tools when they fit — they already handle county scoping and name grouping correctly.',
  parameters: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single SELECT or WITH...SELECT statement. No writes, no PRAGMA, no ATTACH.' },
      purpose: { type: 'string', description: 'One sentence on what this query answers (shown to the user as a step).' },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  run(_db, args) {
    const v = validateReadOnlySql(String(args.sql ?? ''));
    if (!v.ok) return { error: v.error };
    const t0 = Date.now();
    try {
      const stmt = roDb().prepare(`SELECT * FROM (${v.sql}) LIMIT ${MAX_ROWS + 1}`);
      if (!stmt.reader) return { error: 'Statement does not return rows.' };
      const rows = stmt.all() as any[];
      const truncated = rows.length > MAX_ROWS;
      return { columns: stmt.columns().map(c => c.name), row_count: Math.min(rows.length, MAX_ROWS), truncated, ms: Date.now() - t0, rows: truncated ? rows.slice(0, MAX_ROWS) : rows };
    } catch (e: any) {
      return { error: `SQLite error: ${e?.message ?? String(e)}`, sql: v.sql };
    }
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const TOOLS: ToolSpec[] = [
  getDatasetOverview,
  searchEntities,
  getEntityProfile,
  getTopEntities,
  getMonthlyVolume,
  listFilings,
  getLendingRelationships,
  listFacilityFilings,
  getDocumentText,
  runSql,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** OpenAI Responses API `tools` payload (flat shape — not nested under `function` as in Chat Completions). */
export function toolDefinitions() {
  return TOOLS.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

/**
 * Execute a tool call. Errors are returned as data, not thrown, so the model
 * can read them and recover (retry with a better name, fall back to SQL, or
 * tell the user). Output is size-capped before it goes back into the prompt.
 */
export function executeTool(db: Database.Database, name: string, rawArgs: string): { result: unknown; ms: number } {
  const t0 = Date.now();
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { result: { error: `Unknown tool ${name}` }, ms: 0 };
  let args: Record<string, any> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; }
  catch { return { result: { error: 'Tool arguments were not valid JSON.' }, ms: 0 }; }
  try {
    return { result: tool.run(db, args), ms: Date.now() - t0 };
  } catch (e: any) {
    return { result: { error: `Tool failed: ${e?.message ?? String(e)}` }, ms: Date.now() - t0 };
  }
}

/**
 * The part of a tool result the browser gets, so a row in the model's table
 * can be matched back to the lookup that produced it and expanded in place
 * (client/src/lib/chat-drill.ts). Document text and the dataset overview have
 * nothing a table row could drill into, so they are not sent. Capped so a
 * 200-row SQL result does not bloat the stream.
 */
const DRILLABLE_TOOLS = new Set([
  'search_entities', 'get_entity_profile', 'get_top_entities', 'get_monthly_volume',
  'list_filings', 'get_lending_relationships', 'list_facility_filings', 'run_sql',
]);
const MAX_DRILL_PAYLOAD_CHARS = 60_000;

export function drillableResult(name: string, result: unknown): unknown {
  if (!DRILLABLE_TOOLS.has(name) || !result || typeof result !== 'object') return undefined;
  if ((result as any).error) return undefined;
  const s = JSON.stringify(result);
  if (s.length <= MAX_DRILL_PAYLOAD_CHARS) return result;
  if (Array.isArray((result as any).rows)) {
    const r = { ...(result as any) };
    let rows = r.rows as any[];
    while (rows.length > 1 && JSON.stringify({ ...r, rows }).length > MAX_DRILL_PAYLOAD_CHARS) rows = rows.slice(0, Math.floor(rows.length / 2));
    return { ...r, rows };
  }
  return undefined;
}

const MAX_TOOL_OUTPUT_CHARS = 60_000;

export function serializeToolResult(result: unknown): string {
  const s = JSON.stringify(result);
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  // Trim the rows array if present rather than cutting mid-JSON.
  if (result && typeof result === 'object' && Array.isArray((result as any).rows)) {
    const r = { ...(result as any) };
    let rows = r.rows as any[];
    while (rows.length > 1 && JSON.stringify({ ...r, rows }).length > MAX_TOOL_OUTPUT_CHARS) rows = rows.slice(0, Math.floor(rows.length / 2));
    return JSON.stringify({ ...r, rows, truncated_for_size: true, original_row_count: (result as any).rows.length });
  }
  return s.slice(0, MAX_TOOL_OUTPUT_CHARS) + '…"truncated":true}';
}
