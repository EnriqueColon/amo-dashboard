/**
 * `unstable_cache` from next/cache, on intel.db.
 *
 * The ported Market Intelligence code wraps every expensive read —
 * feeds, OpenAI memos, briefs — in Next's `unstable_cache(fn, keyParts,
 * { revalidate })`. Rather than rewrite forty call sites, this module has the
 * same signature and the same two rules: a value is served until `revalidate`
 * seconds have passed, and a function that throws stores nothing (so a bad
 * fetch or a degraded brief is retried next time instead of pinned for a day).
 * The value survives restarts because it is a row, not process memory.
 *
 * Differences from Next, deliberate: there is no stale-while-revalidate (an
 * expired entry is rebuilt on the request that finds it expired — the daily
 * warm-up exists so that request is never a user's), and concurrent builds of
 * the same key are coalesced in-process so a burst does not fan out.
 */
import { getIntelDb } from "./db"

type Options = { revalidate?: number | false; tags?: string[] }

const inFlight = new Map<string, Promise<unknown>>()

function keyOf(parts: readonly string[], args: unknown[]): string {
  return JSON.stringify([parts, args])
}

export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: readonly string[] = [],
  options: Options = {}
): (...args: A) => Promise<R> {
  const ttlMs = typeof options.revalidate === "number" ? options.revalidate * 1000 : 24 * 60 * 60 * 1000
  return async (...args: A): Promise<R> => {
    const key = keyOf(keyParts, args)
    const db = getIntelDb()
    const now = Date.now()
    const row = db.prepare("SELECT value FROM intel_cache WHERE key = ? AND expires_at > ?").get(key, now) as
      | { value: string }
      | undefined
    if (row) return JSON.parse(row.value) as R

    let pending = inFlight.get(key) as Promise<R> | undefined
    if (!pending) {
      pending = fn(...args)
        .then((value) => {
          db.prepare(
            "INSERT OR REPLACE INTO intel_cache (key, value, created_at, expires_at) VALUES (?, ?, ?, ?)"
          ).run(key, JSON.stringify(value ?? null), Date.now(), Date.now() + ttlMs)
          return value
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }
}

/** Drop rows whose day has passed; called by the daily warm-up. */
export function sweepExpired(): number {
  const r = getIntelDb().prepare("DELETE FROM intel_cache WHERE expires_at <= ?").run(Date.now())
  return r.changes
}

/** Forget one key prefix (as JSON-encoded key parts start), e.g. to force a regeneration. */
export function forgetKeysStartingWith(firstPart: string): number {
  const r = getIntelDb().prepare("DELETE FROM intel_cache WHERE key LIKE ?").run(`[["${firstPart}%`)
  return r.changes
}
