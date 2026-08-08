/**
 * County scope state, with no imports.
 *
 * Deliberately separate from county.tsx: the React provider needs `queryClient`
 * (to clear the cache on a scope change) while `queryClient` needs `withCounty`
 * to build request URLs. Putting the shared state here breaks what would
 * otherwise be an import cycle between those two modules.
 */

export type CountyScope = 'MIAMI-DADE' | 'BROWARD' | 'ALL';

export const COUNTY_OPTIONS: Array<{ value: CountyScope; label: string; short: string }> = [
  { value: 'MIAMI-DADE', label: 'Miami-Dade County', short: 'Miami-Dade' },
  { value: 'BROWARD',    label: 'Broward County',    short: 'Broward' },
  { value: 'ALL',        label: 'All Counties',      short: 'All Counties' },
];

export const DEFAULT_COUNTY: CountyScope = 'MIAMI-DADE';

const STORAGE_KEY = 'amo.county';

export function isScope(v: unknown): v is CountyScope {
  return v === 'MIAMI-DADE' || v === 'BROWARD' || v === 'ALL';
}

export function readStoredCounty(): CountyScope {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isScope(v) ? v : DEFAULT_COUNTY;
  } catch {
    return DEFAULT_COUNTY; // private mode / storage disabled
  }
}

export function persistCounty(c: CountyScope): void {
  try { localStorage.setItem(STORAGE_KEY, c); } catch { /* storage disabled */ }
}

// Module-level mirror of the React state. apiRequest() and getQueryFn() are
// plain functions, not components, so they cannot read context — they read this.
// The provider is the only writer, which keeps the two in step.
let currentCounty: CountyScope = readStoredCounty();

export function getCurrentCounty(): CountyScope {
  return currentCounty;
}

export function setCurrentCounty(c: CountyScope): void {
  currentCounty = c;
}

/** Append the active county to an API URL. Anything else is returned unchanged. */
export function withCounty(url: string): string {
  if (!url.startsWith('/api/')) return url;
  // FDIC figures are institution-level call-report data, not county records.
  if (url.startsWith('/api/fdic/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}county=${encodeURIComponent(currentCounty)}`;
}

/** Human label for the active scope, for headings and report titles. */
export function countyLabel(c: CountyScope): string {
  return COUNTY_OPTIONS.find(o => o.value === c)?.label ?? c;
}
