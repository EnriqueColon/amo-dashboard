/**
 * Guardrail: every risk metric must point the way it claims to.
 *
 *     npx tsx script/check-metric-directions.ts
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A percentile or a ratio is a bare number; whether "high" means good or bad is
 * a per-metric decision made in the colour table. Two metrics in this codebase
 * point in OPPOSITE directions while looking almost identical at a call site:
 *
 *     CET1 ratio          higher = SAFER   (more capital against risk assets)
 *     CRE / capital       higher = RISKIER (more concentration per dollar)
 *
 * Colour logic copy-pasted from one onto the other inverts silently: the safest
 * banks render as the most stressed and a "most exposed" ranking returns the
 * least exposed. Nothing throws, no test fails, and the numbers on screen are
 * all individually correct — only their colours and ordering lie. The same trap
 * exists between the stress metrics (CRE / Assets, NPL) and the strength metrics
 * (Net Income, NIM) in peer positioning.
 *
 * So the direction of each metric is asserted here as a property, rather than
 * left to be re-derived correctly at every display site.
 */

import {
  PEER_META,
  PEER_METRICS,
  buildPeerCohort,
  getPeerInterpretation,
  peerPercentile,
  percentileRank,
  type PeerMetricMeta,
  type PeerRow,
} from '../client/src/lib/peer-metrics'
import { getCreCapitalColor } from '../client/src/lib/score-colors'

const failures: string[] = []

function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    console.log(`  FAIL  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  } else {
    console.log(`  ok    ${label} = ${JSON.stringify(got)}`)
  }
}

function ok(label: string, condition: boolean, detail = '') {
  if (!condition) {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

const isRed = (c: string) => c.includes('red')
const isGreen = (c: string) => c.includes('green')

/**
 * The rule, as a pure predicate over one metric's config.
 *
 * Returns a list of problems, empty when the colours agree with the declared
 * direction. Written as data-in/list-out specifically so it can be pointed at a
 * deliberately-inverted config below — a check that only ever sees correct input
 * has not been shown to detect anything.
 */
function directionViolations(meta: PeerMetricMeta): string[] {
  const problems: string[] = []
  const sorted = [...meta.thresholds].sort((a, b) => b.min - a.min)
  if (JSON.stringify(sorted) !== JSON.stringify(meta.thresholds)) {
    problems.push('thresholds are not in descending order (first-match-wins needs that)')
  }
  const top = sorted[0]
  const bottom = sorted[sorted.length - 1]
  if (bottom.min !== 0) problems.push('bottom band does not start at 0')

  if (meta.direction === 'high-risk') {
    if (!isRed(top.colorClass)) problems.push(`high-risk but top band "${top.label}" is not red`)
    if (!isGreen(bottom.colorClass)) problems.push(`high-risk but bottom band "${bottom.label}" is not green`)
  } else {
    if (!isGreen(top.colorClass)) problems.push(`high-good but top band "${top.label}" is not green`)
    if (!isRed(bottom.colorClass)) problems.push(`high-good but bottom band "${bottom.label}" is not red`)
  }
  return problems
}

// ── 0. The check can detect an inversion ─────────────────────────────────────
// Negative control. An inverted config is built here in memory — nothing on disk
// is touched — by giving a 'high-risk' metric the colour ordering of a
// 'high-good' one, which is exactly the copy-paste that inverts a metric. If
// directionViolations stays silent on this, every "ok" it prints below is
// worthless.
console.log('\nThe guardrail itself detects an inversion')
const invertedNpl: PeerMetricMeta = {
  direction: 'high-risk',
  hint: 'deliberately inverted fixture',
  thresholds: [
    { min: 75, label: 'Elevated Stress', colorClass: 'bg-green-50 text-green-600 border-green-200' },
    { min: 50, label: 'Above Average',   colorClass: 'bg-slate-50 text-slate-500 border-slate-200' },
    { min: 25, label: 'Below Average',   colorClass: 'bg-amber-50 text-amber-600 border-amber-200' },
    { min: 0,  label: 'Clean Book',      colorClass: 'bg-red-50 text-red-600 border-red-200' },
  ],
}
const caught = directionViolations(invertedNpl)
ok('an inverted high-risk table is rejected', caught.length === 2, caught.join(' / '))
ok('the real config would not produce those complaints',
   directionViolations(PEER_META['NPL Ratio']).length === 0)

// ── 1. Peer thresholds must agree with their declared direction ──────────────
// This is the check that would have caught an inherited inversion. It does not
// trust the `direction` field OR the colours — it asserts they agree, so
// changing either one alone fails.
console.log('\nPeer metric thresholds match their declared direction')
for (const [metric, meta] of Object.entries(PEER_META)) {
  const problems = directionViolations(meta)
  ok(`${metric} (${meta.direction})`, problems.length === 0, problems.join(' / '))
}

// ── 2. The declared directions themselves ────────────────────────────────────
// Pinned deliberately. If a future edit flips one of these, that is a decision
// about what the product means and it should require changing this line.
console.log('\nDeclared directions are the intended ones')
check('CRE / Assets', PEER_META['CRE / Assets'].direction, 'high-risk')
check('NPL Ratio',    PEER_META['NPL Ratio'].direction,    'high-risk')
check('Net Income',   PEER_META['Net Income'].direction,   'high-good')
check('NIM',          PEER_META['NIM'].direction,          'high-good')

// ── 3. End to end: the stressed bank must read stressed ──────────────────────
// A cohort where one bank is unambiguously the worst on EVERY axis and one is
// unambiguously the best on every axis. Both extremes have to be consistent
// across all four metrics for this to test direction at all — the first draft of
// this fixture gave the "healthy" bank the lowest net income, which correctly
// scored it Below Average and told us nothing about inversion.
//
// The distressed bank is therefore highest on the two risk metrics AND lowest on
// the two strength metrics, so it must come out red on all four despite the
// underlying percentiles pointing opposite ways. That is the property an
// inherited inversion breaks.
console.log('\nA distressed bank ranks as distressed, a strong bank as strong')
const cohort: PeerRow[] = [
  //                CRE↓ risk        NPL↓ risk        NI↑ strength        NIM↑ strength
  { creConcentration: 10, nplRatio: 0.001, netIncomeTTM: 3_000_000, nimLatest: 4.5 }, // best on all four
  { creConcentration: 20, nplRatio: 0.002, netIncomeTTM: 2_000_000, nimLatest: 3.9 },
  { creConcentration: 30, nplRatio: 0.004, netIncomeTTM: 1_000_000, nimLatest: 3.2 },
  { creConcentration: 90, nplRatio: 0.090, netIncomeTTM:    10_000, nimLatest: 1.1 }, // worst on all four
]
const distressed = cohort[3]
const healthy = cohort[0]
const peers = buildPeerCohort(cohort)

for (const metric of peers) {
  const pct = peerPercentile(distressed, metric)
  const interp = pct != null ? getPeerInterpretation(metric.label, pct) : null
  const dir = PEER_META[metric.label].direction
  // The distressed bank is highest on both risk metrics and lowest on both
  // strength metrics, so in BOTH cases it must land on a red band.
  ok(`distressed bank is flagged red on ${metric.label} (${dir}, ${pct}th pct)`,
     !!interp && isRed(interp.colorClass), interp?.label ?? 'no interpretation')
}

for (const metric of peers) {
  const pct = peerPercentile(healthy, metric)
  const interp = pct != null ? getPeerInterpretation(metric.label, pct) : null
  ok(`healthy bank is flagged green on ${metric.label} (${pct}th pct)`,
     !!interp && isGreen(interp.colorClass), interp?.label ?? 'no interpretation')
}

// ── 4. CRE-to-capital colouring rises with the ratio ─────────────────────────
// The specific inversion to guard: this scale takes a CONCENTRATION ratio where
// bigger is worse. Feeding it a CET1 ratio (bigger is better) would invert the
// meaning, and both are plausibly named "capital" at a call site.
console.log('\nCRE / capital colouring gets stronger as concentration rises')
const rungs = [0.5, 1.5, 2.5, 3.5, 5.0].map(getCreCapitalColor)
ok('a ratio below 1.0x is not coloured at all', rungs[0] === 'bg-transparent', rungs[0])
ok('every rung above 1.0x is distinct', new Set(rungs.slice(1)).size === 4, rungs.join(' | '))
ok('the highest ratio is the strongest red',
   rungs[4].includes('red-200') && rungs[3].includes('red-100'),
   `3.5x=${rungs[3]} 5.0x=${rungs[4]}`)
ok('a mid ratio is amber/orange, not red',
   rungs[1].includes('amber') && rungs[2].includes('orange'),
   `1.5x=${rungs[1]} 2.5x=${rungs[2]}`)
// A CET1 ratio is a percentage like 12.5 and would land in the top red band if
// it were ever passed here — which is exactly what the inversion looked like.
ok('a CET1-shaped value (12.5) would land in the top band, so it must never be passed here',
   getCreCapitalColor(12.5).includes('red-200'))

// ── 5. percentileRank sanity ─────────────────────────────────────────────────
console.log('\npercentileRank')
check('lowest of four', percentileRank(1, [1, 2, 3, 4]), 0)
check('highest of four', percentileRank(4, [1, 2, 3, 4]), 75)
check('empty cohort', percentileRank(5, []), 0)
check('order does not matter', percentileRank(3, [4, 1, 3, 2]), percentileRank(3, [1, 2, 3, 4]))

// ── 6. Every ranked metric is defined and reachable ──────────────────────────
console.log('\nMetric set is complete and consistent')
check('four metrics are ranked', PEER_METRICS.length, 4)
for (const m of PEER_METRICS) {
  ok(`${m.label} has threshold metadata`, PEER_META[m.label] != null)
}
check('buildPeerCohort returns one entry per metric', peers.length, PEER_METRICS.length)
// Guards the drift that was actually found: the comparison table had been
// hand-listing metrics and had silently lost Net Income.
ok('Net Income is in the shared metric set',
   PEER_METRICS.some((m) => m.label === 'Net Income'))

console.log()
if (failures.length > 0) {
  console.log(`FAILED — ${failures.length} check(s):`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('✅ metric direction guardrail green')
