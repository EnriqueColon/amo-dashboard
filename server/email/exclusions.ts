// Firms hidden from the EMAIL ONLY, at the owner's request (2 Oct 2026):
// Wells Fargo, JPMorgan Chase, Freedom Mortgage, Bank of America and Rocket
// Mortgage. The recipients read the email as a view of the market they compete
// in, and these five are large enough to crowd that view out.
//
// THE DASHBOARD IS DELIBERATELY UNCHANGED. This is the reason the list lives
// here and not in server/reporting/exclusions.ts: that file is shared by the
// Reporting tab, and the owner was explicit that these firms stay in the tool.
// Adding them there would have silently rewritten the dashboard too.
//
// The consequence, which the email now states in its own footer: the email and
// the Reporting tab no longer agree on totals. That is intended, but it means
// "the email says 440 and the dashboard says 526" is not a bug. This is the
// opposite call from 17 Sep 2026, when the owner asked for one shared list so
// the two could not disagree — so expect the question, and answer it from here.
//
// DISPLAY ONLY. Nothing is deleted and normalize.py is untouched; emptying this
// list restores the previous behaviour exactly.
import { REPORTING_EXCLUDE } from '../reporting/exclusions';

export const EMAIL_ONLY_EXCLUDED_ENTITIES = [
  'WELLS FARGO',
  'JPMORGAN CHASE',
  'FREEDOM MORTGAGE',
  'BANK OF AMERICA',
  'ROCKET MORTGAGE',
];

/** The same five for the footer, cased the way a reader expects to see them. */
export const EMAIL_ONLY_EXCLUDED_LABELS = [
  'Wells Fargo',
  'JPMorgan Chase',
  'Freedom Mortgage',
  'Bank of America',
  'Rocket Mortgage',
];

// ── Loan transfers (aom_events_clean) ───────────────────────────────────────
// Exact match on the canonical columns, the same mechanism the reporting list
// uses. That is safe here because normalize.py has already folded every variant
// of these five into exactly one spelling each — verified against production on
// 2 Oct 2026: WELLS FARGO 4,357 appearances, JPMORGAN CHASE 3,818, FREEDOM
// MORTGAGE 2,196, BANK OF AMERICA 1,124, ROCKET MORTGAGE 785, and no other
// canonical name contains any of those strings. If that ever stops being true a
// firm would quietly reappear, which is what
// collector/tests/check_email_exclusions.py guards.
const SQL_LIST = EMAIL_ONLY_EXCLUDED_ENTITIES
  .map(e => `'${e.replace(/'/g, "''")}'`).join(', ');

// The IS NULL guards are load-bearing for the same reason as in the reporting
// list: `col NOT IN (...)` is NULL, not true, when col is NULL, which would drop
// every such row instead of keeping it.
const EMAIL_ONLY_EXCLUDE =
  `(assignor_canon IS NULL OR assignor_canon NOT IN (${SQL_LIST}))
   AND (assignee_canon IS NULL OR assignee_canon NOT IN (${SQL_LIST}))`;

/**
 * Every exclusion the email applies: the four the dashboard also hides, plus
 * the five above. Use this in the email wherever the dashboard would use
 * REPORTING_EXCLUDE.
 */
export const EMAIL_EXCLUDE = `${REPORTING_EXCLUDE}\n   AND ${EMAIL_ONLY_EXCLUDE}`;

// ── Credit facilities (credit_facility_events) ──────────────────────────────
// A different table needs a different rule. Its lender_key / borrower_key are
// NOT brand-collapsed the way assignor_canon is — production holds both
// "JPMORGAN CHASE BANK NA" and "JPMORGAN CHASE BANK NATIONAL ASSOCIATION" as
// distinct keys — so exact match would miss. Squashing to letters and digits and
// testing containment catches every form, and folds "JP MORGAN" into "JPMORGAN"
// for free. Checked against all 149 relationships on record: it matches the two
// JPMorgan rows and nothing else.
const squash = (s: string | null | undefined) =>
  (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SQUASHED = EMAIL_ONLY_EXCLUDED_ENTITIES.map(squash);

/** True if any name given belongs to one of the hidden firms. */
export function isEmailExcludedParty(...names: (string | null | undefined)[]): boolean {
  return names.some(n => {
    const s = squash(n);
    return s.length > 0 && SQUASHED.some(k => s.includes(k));
  });
}
