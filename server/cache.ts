/**
 * Simple in-memory TTL cache for API responses.
 *
 * Data is refreshed weekly (normalize.py run), so a 7-day TTL is appropriate.
 * Call clearCache() after running normalize.py to serve fresh data immediately.
 *
 * Cache key = full request path + sorted query string, so every unique
 * filter / pagination combination gets its own cache entry.
 */

interface CacheEntry {
  data: unknown;
  expiresAt: number;
  cachedAt: number;
}

const store = new Map<string, CacheEntry>();

// 7 days — aligns with weekly data refresh cadence
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Short TTL for stats / summary endpoints (refresh every 6 hours even without a bust)
export const STATS_TTL_MS = 6 * 60 * 60 * 1000;

export function getCached(key: string): unknown | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

export function setCached(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { data, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() });
}

export function clearCache() {
  const count = store.size;
  store.clear();
  return count;
}

export function getCacheStats() {
  const now = Date.now();
  let live = 0;
  let expired = 0;
  store.forEach(entry => {
    if (now > entry.expiresAt) expired++; else live++;
  });
  return { total: store.size, live, expired };
}

/**
 * Build a normalized cache key from a request path and query object.
 * Sorting params ensures ?page=1&limit=50 and ?limit=50&page=1 hit the same entry.
 */
export function makeCacheKey(path: string, query: Record<string, unknown>): string {
  const sorted = Object.keys(query)
    .sort()
    .map(k => `${k}=${JSON.stringify(query[k])}`)
    .join('&');
  return sorted ? `${path}?${sorted}` : path;
}
