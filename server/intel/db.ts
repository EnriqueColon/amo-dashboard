/**
 * intel.db — the Intelligence section's own SQLite file (News caches and,
 * as they are ported, Legal bill history and Research reports). Kept apart
 * from miami_dade_amo.db the way bank_stress.db is: it is derived or
 * user-entered data with its own lifecycle, and it must never be touched by
 * the county pipeline's rebuilds. Lives beside the AMO database unless
 * AMO_INTEL_DB_PATH says otherwise. Created on first use.
 */
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"

export function intelDbPath(): string {
  const explicit = (process.env.AMO_INTEL_DB_PATH ?? "").trim()
  if (explicit) return explicit
  const amo = (process.env.AMO_DB_PATH ?? "").trim()
  if (amo) return path.join(path.dirname(path.resolve(amo)), "intel.db")
  return path.resolve(process.cwd(), "intel.db")
}

let _db: Database.Database | null = null

export function getIntelDb(): Database.Database {
  if (_db) return _db
  const p = intelDbPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  _db = new Database(p)
  _db.pragma("journal_mode = WAL")
  _db.pragma("busy_timeout = 5000")
  _db.exec(`
    -- Daily snapshots of fetched feeds, generated memos and briefs: the
    -- tool's Next.js Data Cache, as rows. key carries the ET calendar day
    -- where the tool put it, so a new day is a new row and the old one is
    -- swept, not overwritten.
    CREATE TABLE IF NOT EXISTS intel_cache (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS intel_cache_expires ON intel_cache(expires_at);
  `)
  return _db
}
