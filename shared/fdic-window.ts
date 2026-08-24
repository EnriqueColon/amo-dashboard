/**
 * The FDIC trend window — one contract, two consumers.
 *
 * `server/fdic.ts` builds the REPDTE filter that decides which quarters come
 * back from the API. `client/src/pages/MarketAnalytics.tsx` slices the trailing
 * `TREND_QUARTERS` of those and computes year-over-year metrics by comparing the
 * newest four against the four behind them.
 *
 * Those two numbers have to agree, and for a long time they did not: the window
 * was 18 months, which returns five quarters, while the YoY comparison needs
 * eight. Nothing errored — `netIncomeYoYPct` was simply null for every
 * institution in every region, forever, and the column rendered "—". A window
 * too short for the metric computed from it is unfalsifiable by inspection,
 * so the relationship is written down here and asserted in
 * `script/check-fdic-window.ts`.
 */

/** Quarters in a trailing-twelve-month figure. */
export const TTM_QUARTERS = 4

/** Quarters the client needs: four for the current TTM, four for the prior TTM. */
export const TREND_QUARTERS = TTM_QUARTERS * 2

/**
 * FDIC publishes a quarter months after it closes, so the newest REPDTE on the
 * API is a full quarter behind the most recent one that has actually ended.
 * The window has to cover that lag on top of the quarters we want to read.
 */
export const PUBLICATION_LAG_QUARTERS = 1

/**
 * 27 months. Sized as (quarters needed + lag) * 3, which is the smallest window
 * that still yields eight published quarters when today falls immediately after
 * a quarter close — the worst case. At 24 months that case returns seven and
 * every YoY metric silently goes null again.
 */
export const TREND_WINDOW_MONTHS = (TREND_QUARTERS + PUBLICATION_LAG_QUARTERS) * 3

/**
 * Start of the REPDTE filter range, truncated to the first of the month.
 * `months` is a parameter only so the guardrail can evaluate rejected widths;
 * callers should take the default.
 */
export function fdicWindowStart(now: Date = new Date(), months: number = TREND_WINDOW_MONTHS): string {
  const d = new Date(now.getTime())
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 7) + '-01'
}

/** Quarter-end dates in `[start, end]`, oldest first, as YYYY-MM-DD. */
export function quarterEndsBetween(start: Date, end: Date): string[] {
  const out: string[] = []
  let year = start.getUTCFullYear()
  for (; year <= end.getUTCFullYear(); year++) {
    for (const [month, day] of [[3, 31], [6, 30], [9, 30], [12, 31]] as const) {
      const qe = new Date(Date.UTC(year, month - 1, day))
      if (qe >= start && qe <= end) {
        out.push(qe.toISOString().slice(0, 10))
      }
    }
  }
  return out
}

/**
 * The newest quarter-end we can expect FDIC to have published as of `now`:
 * the most recent quarter that has closed, walked back by the publication lag.
 */
export function newestPublishedQuarterEnd(now: Date = new Date()): Date {
  const ends = quarterEndsBetween(new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 1)), now)
  const idx = ends.length - 1 - PUBLICATION_LAG_QUARTERS
  return new Date(ends[Math.max(0, idx)] + 'T00:00:00Z')
}

/**
 * How many published quarters the window actually delivers as of `now`.
 * Deliberately conservative: it ignores that FDIC's range filter tends to
 * include one extra quarter at the boundary, so a passing check here means the
 * live API returns at least this many.
 */
export function publishedQuartersInWindow(
  now: Date = new Date(),
  months: number = TREND_WINDOW_MONTHS,
): number {
  const start = new Date(fdicWindowStart(now, months) + 'T00:00:00Z')
  return quarterEndsBetween(start, newestPublishedQuarterEnd(now)).length
}
