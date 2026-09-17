// Entities hidden from reporting at the owner's request (9 Sep 2026).
// These are pass-through registry/agency counterparties rather than market
// participants, and they crowd out the transactions the report exists to show
// — 6,317 of 48,636 rows, about 13%, on the snapshot this was measured against.
//
// Shared by the Reporting tab (server/routes.ts) and the weekly email
// (server/email/report.ts). It lived inside routes.ts until 17 Sep 2026, when
// the owner asked for the email to match: the preview for 2–17 Sep carried 137
// of its 651 rows through these four names, all of them rows the dashboard he
// had just been looking at did not show. One list, two readers, so the email
// and the dashboard cannot disagree about who is in scope.
//
// DISPLAY ONLY. Nothing is deleted and normalize.py is untouched: the rows stay
// in aom_events_clean, and the Overview, Entities and Lending Relationships
// surfaces still count them. Emptying this list restores the previous
// behaviour exactly.
//
// Matched on CANONICAL names, which is what makes this reliable — normalize.py
// folds "FEDERAL NATIONAL MORTGAGE ASSOCIATION", "FNMA" and the rest into one
// form before it ever reaches the table. Matching entity_type instead would NOT
// work: Fannie/Freddie are GSE and MERS is MERS, but Wilmington Savings is a
// BANK, so a type filter would either miss Wilmington or hide every bank.
export const REPORTING_EXCLUDED_ENTITIES = [
  'WILMINGTON SAVINGS',
  'MERS',
  'FANNIE MAE',
  'FREDDIE MAC',
];

const SQL_LIST = REPORTING_EXCLUDED_ENTITIES
  .map(e => `'${e.replace(/'/g, "''")}'`).join(', ');

// Excludes a transaction if the entity appears on EITHER side. The IS NULL
// guards are load-bearing: `col NOT IN (...)` evaluates to NULL — not true —
// when col is NULL, which would silently drop every such row. No NULLs exist in
// these columns today; the guard is here so that stays true if one ever appears.
export const REPORTING_EXCLUDE =
  `(assignor_canon IS NULL OR assignor_canon NOT IN (${SQL_LIST}))
   AND (assignee_canon IS NULL OR assignee_canon NOT IN (${SQL_LIST}))`;
