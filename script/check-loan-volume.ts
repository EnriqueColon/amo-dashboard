/**
 * Guardrail: dollar volume must count each loan once, not once per filing.
 *
 * The bug this exists to prevent: one $2.95B portfolio loan is filed against
 * every building it covers and down a chain of assignments — 10 filings, summed
 * to $29.5B. Measured as the entity report computes it (self-assignments
 * excluded), market-wide volume read $150.9B and falls to $86.7B once each loan
 * counts once: Wells Fargo $16.7B -> $9.7B, Goldman Sachs $15.0B -> $10.7B,
 * Barclays $5.5B -> $1.9B. Bank of America is unchanged at $4.9B — it has no
 * repeat filings, and a rule that moved it would be wrong.
 *
 * (An earlier ad-hoc audit put Goldman at $66.7B. That query counted
 * self-assignments and both sides of each filing, which the screen never does,
 * so the first draft of this check asserted against a number no one saw. The
 * thresholds below are set from the screen's own arithmetic.)
 *
 * Unlike the other checks this needs the real database, because the failure is
 * a property of the data (how loans repeat), not of the arithmetic. It opens it
 * READ-ONLY and runs the exact SQL fragments the routes use, so it cannot drift
 * from what ships. Skips cleanly when no database is present.
 *
 *   AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db npx tsx script/check-loan-volume.ts
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import {
  loanRows, COUNTED_LOAN_AMOUNT, LOAN_REPEAT_MIN_AMOUNT,
} from '../server/reporting/loanVolume';

const path = process.env.AMO_DB_PATH || './miami_dade_amo.db';
if (!existsSync(path)) {
  console.log(`  · no database at ${path} — skipped (needs real data)`);
  process.exit(0);
}
const db = new Database(path, { readonly: true, fileMustExist: true });
let failures = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const B = (n: number) => `$${(n / 1e9).toFixed(1)}B`;

function entityVolume(entity: string): { naive: number; counted: number } {
  const where = `(assignor_canon = ? OR assignee_canon = ?) AND txn_type != 'SELF_ASSIGN'`;
  const naive = (db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN loan_amount > 0 THEN loan_amount ELSE 0 END), 0) v
    FROM aom_events_clean WHERE ${where}`).get(entity, entity) as any).v;
  const counted = (db.prepare(`
    SELECT COALESCE(SUM(${COUNTED_LOAN_AMOUNT}), 0) v
    FROM ${loanRows('aom_events_clean', where)}`).get(entity, entity) as any).v;
  return { naive, counted };
}

// ── 1. the case that started it ────────────────────────────────────────────
const gs = entityVolume('GOLDMAN SACHS');
ok('Goldman Sachs volume falls below the naive sum', gs.counted < gs.naive * 0.85,
   `${B(gs.naive)} -> ${B(gs.counted)}`);
ok('...but does not collapse to nothing', gs.counted > gs.naive * 0.4);

const wf = entityVolume('WELLS FARGO');
ok('Wells Fargo volume falls below the naive sum', wf.counted < wf.naive * 0.85,
   `${B(wf.naive)} -> ${B(wf.counted)}`);

// NEGATIVE CONTROL: a firm with no repeat filings must not move at all.
const boa = entityVolume('BANK OF AMERICA');
ok('Bank of America, which has no repeat filings, is unchanged', boa.counted === boa.naive,
   `${B(boa.naive)} -> ${B(boa.counted)}`);

// Market-wide: the headline effect, with a floor so a future change that
// merges genuinely distinct loans shows up as a failure, not a better number.
const mkt = db.prepare(`
  SELECT (SELECT SUM(CASE WHEN loan_amount>0 THEN loan_amount ELSE 0 END) FROM aom_events_clean
          WHERE txn_type != 'SELF_ASSIGN') naive,
         (SELECT SUM(${COUNTED_LOAN_AMOUNT}) FROM ${loanRows('aom_events_clean', `txn_type != 'SELF_ASSIGN'`)}) counted
`).get() as any;
ok('market-wide volume falls by a quarter or more', mkt.counted < mkt.naive * 0.75,
   `${B(mkt.naive)} -> ${B(mkt.counted)}`);
ok('...and keeps at least 40% of it', mkt.counted > mkt.naive * 0.4);

// ── 2. the $2.95B loan counts once, wherever it is filed ───────────────────
const one = (db.prepare(`
  SELECT COALESCE(SUM(${COUNTED_LOAN_AMOUNT}), 0) v
  FROM ${loanRows('aom_events_clean', `loan_amount = 2950000000`)}`).get() as any).v;
ok('a loan filed 10 times contributes its amount exactly once', one === 2_950_000_000,
   `counted ${B(one)}`);

// ── 3. NEGATIVE CONTROL: small loans are never merged ──────────────────────
// Round residential amounts recur between the same parties weeks apart as
// genuinely different loans. The rule must leave every one of them counted.
const small = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN loan_amount > 0 THEN loan_amount ELSE 0 END), 0) naive,
         COALESCE(SUM(${COUNTED_LOAN_AMOUNT}), 0) counted
  FROM ${loanRows('aom_events_clean', `loan_amount > 0 AND loan_amount < ${LOAN_REPEAT_MIN_AMOUNT}`)}
`).get() as any;
ok('loans under $1M are all still counted', small.naive === small.counted,
   `${B(small.naive)} vs ${B(small.counted)}`);

// ── 4. NEGATIVE CONTROL: the same amount far apart in time is two loans ─────
const farApart = db.prepare(`
  SELECT COUNT(*) n FROM ${loanRows('aom_events_clean', `loan_amount >= ${LOAN_REPEAT_MIN_AMOUNT}`)}
  WHERE prev_same_amount_date IS NOT NULL
    AND julianday(rec_date) - julianday(prev_same_amount_date) > 31
    AND (${COUNTED_LOAN_AMOUNT}) = 0`).get() as any;
ok('a repeat more than 31 days later is never suppressed', farApart.n === 0,
   `${farApart.n} wrongly suppressed`);

// ── 5. per-firm partitioning: the second firm in a chain keeps its credit ───
// Without partitioning by firm, Wells Fargo's filing of the $2.95B loan would
// be treated as a repeat of Goldman's and Wells would be credited nothing.
const perFirm = db.prepare(`
  SELECT assignor_canon e, SUM(${COUNTED_LOAN_AMOUNT}) v
  FROM ${loanRows('aom_events_clean', `loan_amount = 2950000000`, 'assignor_canon')}
  GROUP BY assignor_canon`).all() as any[];
const wells = perFirm.find(r => r.e === 'WELLS FARGO');
ok('partitioned by firm, each seller in the chain is credited the loan once',
   !!wells && wells.v === 2_950_000_000 && perFirm.every(r => r.v === 2_950_000_000),
   perFirm.map(r => `${r.e}=${B(r.v)}`).join(', '));

// ── 6. no row is ever counted for more than its own amount ─────────────────
const over = db.prepare(`
  SELECT COUNT(*) n FROM ${loanRows('aom_events_clean', '1=1')}
  WHERE (${COUNTED_LOAN_AMOUNT}) > COALESCE(loan_amount, 0)`).get() as any;
ok('the rule only ever removes, never adds', over.n === 0);

db.close();
console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✅ dollar volume counts each loan once');
process.exit(failures ? 1 : 0);
