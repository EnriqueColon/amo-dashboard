/**
 * Guardrail: the email-only exclusions must actually exclude, and must not leak
 * into the dashboard.
 *
 * On 2 Oct 2026 the owner asked for five large firms — Wells Fargo, JPMorgan
 * Chase, Freedom Mortgage, Bank of America, Rocket Mortgage — to be hidden from
 * the weekly email while staying visible in the tool. That makes two failure
 * modes, and both are silent:
 *
 *  1. **A name variant escapes.** The transfer filter is an exact match on
 *     canonical names, which works only because normalize.py folds every
 *     spelling into one. If a new variant ever appears — "WELLS FARGO BANK NA"
 *     as its own canonical entity — it slips straight back into the email and
 *     nothing complains. The email just quietly shows a firm the owner removed.
 *  2. **The list leaks into reporting.** The whole point is that the dashboard
 *     keeps these firms. Someone consolidating the two lists "for consistency"
 *     would rewrite the Reporting tab without meaning to.
 *
 * The pure-logic checks run offline. The two that need production data are
 * skipped, loudly, when no database is reachable — the same way the collector
 * checks behave. Run: npm run check
 */

import fs from 'fs'
import {
  EMAIL_ONLY_EXCLUDED_ENTITIES,
  EMAIL_ONLY_EXCLUDED_LABELS,
  EMAIL_EXCLUDE,
  isEmailExcludedParty,
} from '../server/email/exclusions'
import { REPORTING_EXCLUDED_ENTITIES } from '../server/reporting/exclusions'

let failures = 0
let skipped = 0

function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nEmail-only exclusions\n')

// ── The two lists must stay separate ────────────────────────────────────────
const leaked = EMAIL_ONLY_EXCLUDED_ENTITIES.filter(e => REPORTING_EXCLUDED_ENTITIES.includes(e))
ok(
  'none of the email-only firms is in the reporting list',
  leaked.length === 0,
  leaked.length ? `${leaked.join(', ')} would be hidden from the DASHBOARD too` : '',
)
ok(
  'the email filter still applies the reporting exclusions as well',
  REPORTING_EXCLUDED_ENTITIES.every(e => EMAIL_EXCLUDE.includes(`'${e}'`)),
  'EMAIL_EXCLUDE must be a superset of REPORTING_EXCLUDE, not a replacement',
)
ok(
  'every email-only firm appears in the email filter SQL',
  EMAIL_ONLY_EXCLUDED_ENTITIES.every(e => EMAIL_EXCLUDE.includes(`'${e}'`)),
)
ok(
  'the NULL guards are present on both sides',
  (EMAIL_EXCLUDE.match(/assignor_canon IS NULL/g) || []).length >= 2 &&
    (EMAIL_EXCLUDE.match(/assignee_canon IS NULL/g) || []).length >= 2,
  'without them `col NOT IN (...)` is NULL for a NULL col and drops the row',
)
ok(
  'the footer has a readable label for every excluded firm',
  EMAIL_ONLY_EXCLUDED_LABELS.length === EMAIL_ONLY_EXCLUDED_ENTITIES.length,
)

// ── The facility-side matcher ───────────────────────────────────────────────
// Real forms from production, plus the JP/JPMorgan spelling split. An invented
// spelling would only test the regex against itself.
for (const name of [
  'JPMORGAN CHASE BANK, N.A.',
  'JPMorgan Chase Bank, National Association',
  'JP MORGAN CHASE BANK NA',
  'WELLS FARGO BANK, N.A., AS TRUSTEE',
  'BANK OF AMERICA, N.A.',
  'ROCKET MORTGAGE, LLC',
  'FREEDOM MORTGAGE CORPORATION',
]) {
  ok(`matches "${name}"`, isEmailExcludedParty(name))
}

// Names that must survive. "CHASE HOME LENDING" is the trap: it is a real
// counterparty in this data, it shares a word with JPMorgan Chase, and the
// owner did not ask for it to go.
for (const name of [
  'CHASE HOME LENDING',
  'CITY NATIONAL BANK OF FLORIDA',
  'NATIONSTAR / MR. COOPER',
  'AMERICA FIRST CREDIT UNION',
  'ROCKET COMPANIES',
  'FREEDOM FINANCIAL',
  'WELLS REAL ESTATE',
] as const) {
  ok(`does NOT match "${name}"`, !isEmailExcludedParty(name))
}
ok('empty and null names do not match', !isEmailExcludedParty(null, undefined, '', '   '))
ok('matches when the firm is on either side', isEmailExcludedParty('SOME LLC', 'WELLS FARGO BANK NA'))

// ── Against production, if a database is reachable ──────────────────────────
const DB_PATH = process.env.AMO_DB_PATH || './miami_dade_amo.db'
let db: any = null
try {
  if (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0) {
    const Database = (await import('better-sqlite3')).default
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    db.prepare('SELECT 1 FROM aom_events_clean LIMIT 1').get()
  }
} catch {
  db = null
}

if (!db) {
  skipped += 2
  console.log(`  SKIP  canonical spellings (no usable database at ${DB_PATH})`)
  console.log('  SKIP  no escaping variants (same)')
} else {
  // 1. Each name must exist EXACTLY as written, or the exact-match filter is
  //    filtering nothing at all.
  const missing = EMAIL_ONLY_EXCLUDED_ENTITIES.filter(e => {
    const row = db.prepare(
      `SELECT 1 FROM aom_events_clean WHERE assignor_canon = ? OR assignee_canon = ? LIMIT 1`,
    ).get(e, e)
    return !row
  })
  ok(
    'every excluded name exists verbatim as a canonical name',
    missing.length === 0,
    missing.length ? `${missing.join(', ')} match no row — renamed upstream?` : '',
  )

  // 2. No OTHER canonical name may contain one of these brands, or that variant
  //    walks past the exact match and back into the email.
  const escapes: string[] = []
  for (const e of EMAIL_ONLY_EXCLUDED_ENTITIES) {
    const rows = db.prepare(`
      WITH names AS (
        SELECT DISTINCT assignor_canon AS n FROM aom_events_clean
        UNION SELECT DISTINCT assignee_canon FROM aom_events_clean
      )
      SELECT n FROM names WHERE n LIKE '%' || ? || '%' AND n <> ?
    `).all(e, e) as Array<{ n: string }>
    for (const r of rows) escapes.push(`${r.n} (contains ${e})`)
  }
  ok(
    'no other canonical name contains an excluded brand',
    escapes.length === 0,
    escapes.length ? escapes.join('; ') : '',
  )
}

console.log('')
if (failures) {
  console.error(`check-email-exclusions: ${failures} FAILED${skipped ? `, ${skipped} skipped` : ''}\n`)
  process.exit(1)
}
console.log(`check-email-exclusions: all passed${skipped ? `, ${skipped} skipped` : ''}\n`)
