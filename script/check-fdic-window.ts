/**
 * Guardrail: the FDIC trend window must be wide enough for the metrics computed
 * from it.
 *
 * The bug this exists to prevent shipped and survived unnoticed. The window was
 * 18 months, which returns five quarters. `netIncomeYoYPct` compares the newest
 * four quarters against the four behind them, so it needs eight. The condition
 * was unsatisfiable, the field was null for every institution in every region,
 * and the "NI YoY %" column rendered "—" everywhere. Nothing threw. A screen
 * full of em-dashes reads exactly like an upstream data gap, which is why it
 * lasted.
 *
 * Checked offline and deterministically, by simulating "today" across a full
 * year rather than trusting whatever today happens to be. Run: npm run check
 */

import {
  TTM_QUARTERS,
  TREND_QUARTERS,
  TREND_WINDOW_MONTHS,
  PUBLICATION_LAG_QUARTERS,
  publishedQuartersInWindow,
  newestPublishedQuarterEnd,
  fdicWindowStart,
} from '../shared/fdic-window'

let failures = 0

function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Dates that stress the boundaries: just after each quarter close, and just before. */
function probeDates(year = 2026): Date[] {
  const out: Date[] = []
  for (let month = 0; month < 12; month++) {
    out.push(new Date(Date.UTC(year, month, 1)))
    out.push(new Date(Date.UTC(year, month, 28)))
  }
  return out
}

console.log('\nThe YoY comparison is internally consistent')
ok(
  'the window covers both halves of the comparison',
  TREND_QUARTERS >= TTM_QUARTERS * 2,
  `TREND_QUARTERS=${TREND_QUARTERS} but the comparison needs ${TTM_QUARTERS * 2}`,
)

console.log('\nThe configured window delivers enough published quarters, all year round')
{
  const shortfalls: string[] = []
  for (const now of probeDates()) {
    const got = publishedQuartersInWindow(now)
    if (got < TREND_QUARTERS) {
      shortfalls.push(`${now.toISOString().slice(0, 10)} -> ${got}q`)
    }
  }
  ok(
    `${TREND_WINDOW_MONTHS}mo yields >= ${TREND_QUARTERS} quarters on all 24 probe dates`,
    shortfalls.length === 0,
    shortfalls.slice(0, 4).join(', '),
  )
}

console.log('\nNegative control: the widths that caused the bug are still rejected')
{
  // If these ever start passing, the check has stopped meaning anything.
  for (const [months, note] of [[18, 'the original, shipped for months'], [24, 'the naive 8 x 3']] as const) {
    const worst = Math.min(...probeDates().map((d) => publishedQuartersInWindow(d, months)))
    ok(
      `${months}mo is caught as too narrow (${note})`,
      worst < TREND_QUARTERS,
      `worst case yielded ${worst} quarters, which would have passed`,
    )
  }

  // And the check must not be vacuous — a generous window has to pass.
  const generous = Math.min(...probeDates().map((d) => publishedQuartersInWindow(d, 36)))
  ok('36mo is accepted, so the check is not rejecting everything', generous >= TREND_QUARTERS)
}

console.log('\nPublication lag is modelled, not assumed away')
{
  // As of 2026-08-24 the newest REPDTE on the live API was 2026-03-31, even
  // though Q2 had closed on 2026-06-30. The model must reproduce that.
  const observed = '2026-03-31'
  const modelled = newestPublishedQuarterEnd(new Date('2026-08-24T00:00:00Z')).toISOString().slice(0, 10)
  ok(
    `newest published quarter as of 2026-08-24 is ${observed}`,
    modelled === observed,
    `modelled ${modelled}`,
  )
  ok('the lag is non-zero', PUBLICATION_LAG_QUARTERS >= 1)
}

console.log('\nThe window start is a real date FDIC will accept')
{
  const start = fdicWindowStart(new Date('2026-08-24T00:00:00Z'))
  ok('formatted YYYY-MM-01', /^\d{4}-\d{2}-01$/.test(start), start)
  ok('27 months back from 2026-08 is 2024-05', start === '2024-05-01', start)
}

console.log(
  failures === 0
    ? `\nFDIC window OK — ${TREND_WINDOW_MONTHS}mo covers the ${TREND_QUARTERS} quarters the YoY metrics need.\n`
    : `\n${failures} FDIC window check(s) failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
