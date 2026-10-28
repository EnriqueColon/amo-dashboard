import assert from "node:assert/strict"
import { test } from "node:test"

import {
  describeMovement,
  diffStatus,
  type StoredBillStatus,
} from "./legal-updates-movement.ts"

const stored = (over: Partial<StoredBillStatus> = {}): StoredBillStatus => ({
  status: "Reported by committee",
  statusDate: "2026-06-10",
  previousStatus: null,
  previousStatusDate: null,
  ...over,
})

test("a bill seen for the first time is recorded and reported as no movement", () => {
  // Deliberately not flagged as new. The table starts empty, so the first run after deployment
  // would otherwise flag every bill, including ones introduced months ago.
  const diff = diffStatus(undefined, { status: "Passed Senate", statusDate: "2026-09-28" })
  assert.equal(diff.movement, null)
  assert.deepEqual(diff.next, {
    status: "Passed Senate",
    statusDate: "2026-09-28",
    previousStatus: null,
    previousStatusDate: null,
  })
})

test("a changed status is reported as a transition and pushes the old one back", () => {
  const diff = diffStatus(stored(), { status: "Passed Senate", statusDate: "2026-09-28" })
  assert.deepEqual(diff.movement, {
    from: "Reported by committee",
    fromDate: "2026-06-10",
    to: "Passed Senate",
    on: "2026-09-28",
  })
  assert.deepEqual(diff.next, {
    status: "Passed Senate",
    statusDate: "2026-09-28",
    previousStatus: "Reported by committee",
    previousStatusDate: "2026-06-10",
  })
})

test("running twice in a day does not consume the movement", () => {
  // The feed regenerates on a cron and can regenerate again on demand. If the second pass reported
  // no movement, whether a reader saw it would depend on which request they happened to make.
  const first = diffStatus(stored(), { status: "Passed Senate", statusDate: "2026-09-28" })
  const second = diffStatus(first.next, { status: "Passed Senate", statusDate: "2026-09-28" })
  assert.deepEqual(second.movement, first.movement)
  assert.deepEqual(second.next, first.next, "and it does not rewrite what the first pass stored")
})

test("a movement keeps showing until the bill moves again", () => {
  // Someone checking weekly should not have to have been watching on the day it moved.
  let state = diffStatus(stored(), { status: "Passed Senate", statusDate: "2026-09-28" })
  for (let day = 0; day < 10; day++) {
    state = diffStatus(state.next, { status: "Passed Senate", statusDate: "2026-09-28" })
  }
  assert.deepEqual(state.movement, {
    from: "Reported by committee",
    fromDate: "2026-06-10",
    to: "Passed Senate",
    on: "2026-09-28",
  })
})

test("a second transition replaces the first rather than accumulating", () => {
  const first = diffStatus(stored(), { status: "Passed Senate", statusDate: "2026-09-28" })
  const second = diffStatus(first.next, { status: "Enacted", statusDate: "2026-10-05" })
  assert.deepEqual(second.movement, {
    from: "Passed Senate",
    fromDate: "2026-09-28",
    to: "Enacted",
    on: "2026-10-05",
  })
  assert.equal(second.next.previousStatus, "Passed Senate")
})

test("a bill that has never moved since first sighting reports nothing", () => {
  const diff = diffStatus(stored(), { status: "Reported by committee", statusDate: "2026-06-10" })
  assert.equal(diff.movement, null)
})

test("a status date correction without a status change is not a transition", () => {
  // The record occasionally restates the date of the same action. That is not the bill moving,
  // and reporting it as "Reported by committee → Reported by committee" would be noise.
  const diff = diffStatus(stored(), { status: "Reported by committee", statusDate: "2026-06-11" })
  assert.equal(diff.movement, null)
})

test("the description reads as a sentence about the bill", () => {
  assert.equal(
    describeMovement({ from: "In committee", fromDate: "2026-02-26", to: "Passed Senate", on: "2026-09-28" }),
    "In committee → Passed Senate on 2026-09-28"
  )
})
