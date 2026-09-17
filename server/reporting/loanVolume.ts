/**
 * Dollar volume, with each loan counted once.
 *
 * A large loan is filed once per step, and every filing states the full amount.
 * A portfolio loan secured by several buildings is recorded against each
 * building; a securitised loan passes through a chain of assignments
 * (originator -> depositor -> trustee), each its own filing. Summing
 * loan_amount across those rows counts one loan many times.
 *
 * Measured on production, 17 Sep 2026: one $2.95B loan appears on 10 filings
 * across 6 party pairs, 8 properties and 2 dates a week apart, so it summed to
 * $29.5B. Goldman Sachs's "$ Volume" read $66.7B; 84 rows (0.15% of the data)
 * carried 66% of all dollar volume.
 *
 * The rule: within one set of rows, a filing whose EXACT amount already
 * appeared no more than 31 days earlier is a repeat of that loan and adds
 * nothing. Only at $1M and up. Below that, exact repeats are routinely
 * different loans — round residential amounts like $100,000 recur between the
 * same lender and buyer weeks apart — and merging them would understate small
 * lenders to fix a problem that lives almost entirely in the large ones.
 *
 * The result is an ESTIMATE and the UI labels it so. Spot-checked at $1M-$10M,
 * roughly 10 of 14 collapsed repeats were visibly one loan (same property, or
 * one loan passing through); the rest named different properties, which is
 * also exactly what a portfolio loan looks like. The window deliberately does
 * NOT require the same property, because the case that motivated it spans eight.
 *
 * Asserted against production by script/check-loan-volume.ts.
 */

export const LOAN_REPEAT_MIN_AMOUNT = 1_000_000;
export const LOAN_REPEAT_WINDOW_DAYS = 31;

/**
 * Wrap a filtered row source so each row carries the date of the previous
 * filing with the same amount in the same partition.
 *
 * `where` is applied INSIDE, before the window, so repeats are judged only
 * among the rows actually being reported — a filing outside the selected date
 * range or entity cannot suppress one inside it. Placeholders in `where` keep
 * their position in the final statement, so callers pass params unchanged.
 *
 * `partitionBy` scopes what counts as "the same loan": '' for the whole
 * selection, or an entity column so each firm's own total is judged on its
 * own filings. Omitting it for a per-firm total would be wrong — the second
 * firm in a chain would inherit the first's filing as its "earlier" copy and
 * be credited nothing.
 */
export function loanRows(table: string, where: string, partitionBy = ''): string {
  const partition = [partitionBy, 'loan_amount'].filter(Boolean).join(', ');
  const whereSql = where.trim() ? `WHERE ${where}` : '';
  return `(
    SELECT *,
           LAG(rec_date) OVER (PARTITION BY ${partition} ORDER BY rec_date, cfn) AS prev_same_amount_date
    FROM ${table}
    ${whereSql}
  )`;
}

/** The amount this row contributes. Select only from a loanRows() source. */
export const COUNTED_LOAN_AMOUNT = `CASE
    WHEN loan_amount IS NULL OR loan_amount <= 0 THEN 0
    WHEN loan_amount < ${LOAN_REPEAT_MIN_AMOUNT} THEN loan_amount
    WHEN prev_same_amount_date IS NULL THEN loan_amount
    WHEN julianday(rec_date) - julianday(prev_same_amount_date) > ${LOAN_REPEAT_WINDOW_DAYS} THEN loan_amount
    ELSE 0
  END`;
