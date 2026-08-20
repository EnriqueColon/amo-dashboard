import type Database from 'better-sqlite3';

const DEFAULT_COUNTY = 'MIAMI-DADE';

export interface FacilityGroupFilters {
  county?: string | null;
  lender?: string;
  borrower?: string;
  facilityType?: string;
  startDate?: string;
  endDate?: string;
  sort?: string;
  dir?: string;
  limit: number;
  offset: number;
}

export interface FacilityGroupResult {
  total: number;
  totalFilings: number;
  rows: any[];
}

const SORT_COLS: Record<string, string> = {
  lender: 'lender COLLATE NOCASE', borrower: 'borrower COLLATE NOCASE',
  type: 'facility_type COLLATE NOCASE',
  amount: 'facility_amount', filings: 'filings', activity: 'last_date',
};

// Relationship-grouped view shared by GET /api/credit-facility-events/facilities
// (server/routes.ts) and the weekly emailed report (server/email/report.ts) —
// one row per lender↔borrower pair (or confirmed corporate family), grouped
// case-insensitively since extraction casing varies across filings. See the
// route's own comments (routes.ts, same query, kept in sync here) for why
// family rows never sum facility_amount and why is_family exists.
export function queryGroupedFacilities(db: Database.Database, filters: FacilityGroupFilters): FacilityGroupResult {
  const { county, lender, borrower, facilityType, startDate, endDate, sort, dir, limit, offset } = filters;

  const where: string[] = [];
  const params: any[] = [];
  if (county)       { where.push(`COALESCE(county, '${DEFAULT_COUNTY}') = ?`); params.push(county); }
  if (lender)       { where.push("UPPER(facility_lender_name) LIKE UPPER(?)"); params.push(`%${lender}%`); }
  if (borrower)     { where.push("UPPER(facility_borrower_name) LIKE UPPER(?)"); params.push(`%${borrower}%`); }
  if (facilityType) { where.push("facility_type = ?"); params.push(facilityType); }
  if (startDate)    { where.push("rec_date >= ?"); params.push(startDate); }
  if (endDate)      { where.push("rec_date <= ?"); params.push(endDate); }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    SELECT COALESCE(lender_key,   UPPER(COALESCE(facility_lender_name, '')))   AS lk,
           COALESCE(borrower_key, UPPER(COALESCE(facility_borrower_name, ''))) AS bk,
           borrower_parent, facility_lender_name, borrower_recorded,
           facility_borrower_name, facility_type, facility_amount,
           facility_amount_type, facility_agent_name, facility_agreement_name,
           facility_agreement_date, rec_date
    FROM credit_facility_events ${wc}
  `;
  const grouped = `
    SELECT lk                                  AS lender_key,
           COALESCE(borrower_parent, bk)        AS group_key,
           MAX(borrower_parent)                 AS borrower_parent,
           (MAX(borrower_parent) IS NOT NULL AND COUNT(DISTINCT bk) > 1) AS is_family,
           COUNT(DISTINCT bk)                   AS entity_count,
           MAX(facility_lender_name)            AS lender,
           CASE WHEN MAX(borrower_parent) IS NOT NULL AND COUNT(DISTINCT bk) > 1
                THEN MAX(borrower_parent)
                ELSE MAX(COALESCE(borrower_recorded, facility_borrower_name))
           END                                  AS borrower,
           MAX(bk)                              AS borrower_key,
           CASE WHEN COUNT(DISTINCT facility_type) = 1
                THEN MAX(facility_type) ELSE NULL END AS facility_type,
           CASE WHEN MAX(borrower_parent) IS NOT NULL AND COUNT(DISTINCT bk) > 1
                THEN NULL ELSE MAX(facility_amount) END AS facility_amount,
           MAX(facility_amount_type)            AS facility_amount_type,
           MAX(facility_agent_name)             AS agent_name,
           MAX(facility_agreement_name)         AS agreement_name,
           MAX(facility_agreement_date)         AS agreement_date,
           COUNT(*)                             AS filings,
           MIN(rec_date)                        AS first_date,
           MAX(rec_date)                        AS last_date
    FROM (${base})
    GROUP BY lk, COALESCE(borrower_parent, bk)
  `;

  const sortCol = sort ? SORT_COLS[sort] : undefined;
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortCol
    ? `${sortCol} ${sortDir}, filings DESC, last_date DESC`
    : 'filings DESC, facility_amount DESC, last_date DESC';

  const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(filings), 0) AS f FROM (${grouped})`).get(...params) as any;
  const rows = db.prepare(`${grouped} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  return { total: totals.n, totalFilings: totals.f, rows };
}
