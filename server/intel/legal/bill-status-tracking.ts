/**
 * The one piece of the Legal Landscape that outlives a day — on intel.db.
 *
 * The feed is a day-keyed cache, regenerated each morning, so yesterday's
 * state does not exist in it; that is why the Legislative Tracker could report
 * a bill's stage but never that it had moved. This table is the minimum that
 * answers "what changed": one row per bill with the status last seen and the
 * one before. The comparison lives in shared/legal/legal-updates-movement.ts
 * so it is testable without a database; this file is only the storage.
 *
 * The tool kept this in Vercel Postgres; here it is a table in the section's
 * SQLite file, created on first use.
 */
import { getIntelDb } from "../db"
import { diffStatus, type BillMovement, type StoredBillStatus } from "@shared/legal/legal-updates-movement"

export type TrackedBill = {
  /** From `billKeyFor`. Stable across rewordings of the same bill. */
  key: string
  title: string
  status: string
  /** `YYYY-MM-DD`. */
  statusDate: string
}

let tableReady = false

function ensureTable(): void {
  if (tableReady) return
  getIntelDb().exec(`
    CREATE TABLE IF NOT EXISTS bill_status_history (
      bill_key             TEXT PRIMARY KEY,
      title                TEXT,
      status               TEXT NOT NULL,
      status_date          TEXT NOT NULL,
      previous_status      TEXT,
      previous_status_date TEXT,
      changed_at           TEXT,
      first_seen           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `)
  tableReady = true
}

/**
 * Records what the record currently says and returns the transitions worth
 * showing. Dates stay `TEXT` (`YYYY-MM-DD`): every comparison in the feed is a
 * string comparison and none of this has a timezone.
 */
export async function trackBillStatuses(bills: TrackedBill[]): Promise<Map<string, BillMovement>> {
  const movements = new Map<string, BillMovement>()
  if (bills.length === 0) return movements
  try {
    ensureTable()
    const db = getIntelDb()
    const keys = bills.map((b) => b.key)
    const rows = db
      .prepare(
        `SELECT bill_key, status, status_date, previous_status, previous_status_date
           FROM bill_status_history WHERE bill_key IN (${keys.map(() => "?").join(",")})`
      )
      .all(...keys) as Array<{
      bill_key: string
      status: string
      status_date: string
      previous_status: string | null
      previous_status_date: string | null
    }>
    const stored = new Map<string, StoredBillStatus>(
      rows.map((r) => [
        r.bill_key,
        { status: r.status, statusDate: r.status_date, previousStatus: r.previous_status, previousStatusDate: r.previous_status_date },
      ])
    )
    const upsert = db.prepare(`
      INSERT INTO bill_status_history (bill_key, title, status, status_date, previous_status, previous_status_date, changed_at)
      VALUES (@key, @title, @status, @statusDate, @previousStatus, @previousStatusDate, @changedAt)
      ON CONFLICT(bill_key) DO UPDATE SET
        title                = excluded.title,
        status               = excluded.status,
        status_date          = excluded.status_date,
        previous_status      = excluded.previous_status,
        previous_status_date = excluded.previous_status_date,
        changed_at           = COALESCE(excluded.changed_at, bill_status_history.changed_at),
        last_seen            = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `)
    const write = db.transaction((items: TrackedBill[]) => {
      for (const bill of items) {
        const { movement, next } = diffStatus(stored.get(bill.key), { status: bill.status, statusDate: bill.statusDate })
        if (movement) movements.set(bill.key, movement)
        // changed_at only advances on a real transition: when the bill moved, not when the feed ran.
        upsert.run({
          key: bill.key,
          title: bill.title,
          status: next.status,
          statusDate: next.statusDate,
          previousStatus: next.previousStatus,
          previousStatusDate: next.previousStatusDate,
          changedAt: movement ? new Date().toISOString() : null,
        })
      }
    })
    write(bills)
  } catch (err) {
    // A tracking table being unreachable must not take the feed with it.
    console.warn("[intel] bill status tracking skipped:", err instanceof Error ? err.message : err)
    return movements
  }
  return movements
}
