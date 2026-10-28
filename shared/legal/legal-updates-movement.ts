/**
 * What changed about a bill since this tool last looked at it.
 *
 * The Legislative Tracker did not track. It is a cache keyed to the calendar day with a 25-hour
 * life, regenerated every morning and never stored, so yesterday's state did not exist anywhere.
 * The section could say a bill was at "Passed Senate" and could not say it had been in committee
 * the day before — which is the only part a reader cannot get by reading the bill themselves.
 *
 * The comparison lives here, apart from the table that feeds it, so it can be tested without a
 * database. `app/actions/bill-status-tracking.ts` is the thin part that talks to Postgres.
 */

export type StoredBillStatus = {
  status: string
  statusDate: string
  previousStatus: string | null
  previousStatusDate: string | null
}

export type ObservedBillStatus = {
  status: string
  statusDate: string
}

/**
 * A transition this tool watched happen. Rendered next to the item.
 *
 * `from` is the status the tool last recorded, not the bill's first ever stage: a bill introduced,
 * reported and then passed while nobody was looking reads as one move, because that is honestly
 * all that was observed.
 */
export type BillMovement = {
  from: string
  fromDate: string | null
  to: string
  on: string
}

export type StatusDiff = {
  /** `null` on a first sighting, and whenever the bill has not moved since it was first seen. */
  movement: BillMovement | null
  /** What the table should hold after this observation. */
  next: StoredBillStatus
}

/**
 * Three cases, and the third is the one that makes this safe to run repeatedly.
 *
 * **Never seen.** Recorded, and reported as no movement. Not as "new": the table starts empty, so
 * on the first run after deployment every bill would be flagged, and a bill introduced eight
 * months ago is not news. "First seen by this tool" is a fact about the tool, not the legislation.
 *
 * **Status differs.** A real transition. The stored status becomes `previousStatus` and the
 * movement is reported.
 *
 * **Status matches.** No transition now, but the last one is still worth showing — someone who
 * checks weekly should not have to have been watching on the exact day it moved. So the stored
 * `previousStatus` is reported again, unchanged. This is also what makes the function idempotent:
 * regenerating the feed twice in a day cannot consume the movement, because the second pass takes
 * this branch and preserves what the first pass wrote.
 */
export function diffStatus(
  stored: StoredBillStatus | undefined,
  observed: ObservedBillStatus
): StatusDiff {
  if (!stored) {
    return {
      movement: null,
      next: {
        status: observed.status,
        statusDate: observed.statusDate,
        previousStatus: null,
        previousStatusDate: null,
      },
    }
  }

  if (stored.status !== observed.status) {
    return {
      movement: {
        from: stored.status,
        fromDate: stored.statusDate,
        to: observed.status,
        on: observed.statusDate,
      },
      next: {
        status: observed.status,
        statusDate: observed.statusDate,
        previousStatus: stored.status,
        previousStatusDate: stored.statusDate,
      },
    }
  }

  return {
    movement: stored.previousStatus
      ? {
          from: stored.previousStatus,
          fromDate: stored.previousStatusDate,
          to: stored.status,
          on: stored.statusDate,
        }
      : null,
    // Written back as-is so a no-op observation cannot rewrite history.
    next: stored,
  }
}

/** "In committee → Passed Senate on 2026-09-28". */
export function describeMovement(movement: BillMovement): string {
  return `${movement.from} → ${movement.to} on ${movement.on}`
}
