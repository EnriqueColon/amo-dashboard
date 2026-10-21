import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';

type CountyRow = {
  county: string; checks: number; ok: number; ahead: number; short: number; unknown: number;
  last_checked: string | null; verified_through: string | null; hours_since_check: number | null;
};
type Coverage = {
  active: boolean;
  counties?: CountyRow[];
  any_short?: boolean;
  stale?: boolean;
};

const LABEL: Record<string, string> = { 'MIAMI-DADE': 'Miami-Dade', BROWARD: 'Broward', HILLSBOROUGH: 'Hillsborough' };

/**
 * Overview card: is everything the county clerks list actually in the tool?
 *
 * Reads the completeness ledger that collector/reconcile_counties.py writes
 * after every pull (instrument-by-instrument, every county). Quiet when all is
 * well — a compact green line — and red the moment a county lists a document
 * we do not hold, or the check itself has not run in two days.
 */
export default function ScrapeCompleteness() {
  const { data } = useQuery<Coverage>({
    queryKey: ['/api/qc/coverage'],
    queryFn: () => apiRequest('GET', '/api/qc/coverage').then(r => r.json()),
    refetchInterval: 300_000,
    staleTime: 0,
  });
  if (!data?.active || !data.counties?.length) return null;

  const warn = !!(data.any_short || data.stale);
  const fmt = (d?: string | null) => (d ? d.slice(0, 10) : '—');

  return (
    <Link href="/collection-log">
      <div
        data-testid="scrape-completeness"
        className={`cursor-pointer rounded-lg border px-4 py-2.5 text-xs text-foreground transition-colors ${
          warn ? 'border-red-500/40 bg-red-500/10 hover:bg-red-500/15'
               : 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10'}`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-2 font-medium">
            {warn ? <ShieldAlert size={14} className="text-red-500" /> : <ShieldCheck size={14} className="text-emerald-600" />}
            Scrape completeness
            <span className="font-normal text-muted-foreground">— checked against each county clerk, instrument by instrument</span>
          </span>
          {data.counties.map(c => (
            <span key={c.county} className="tabular-nums">
              <span className="text-muted-foreground">{LABEL[c.county] ?? c.county}:</span>{' '}
              {c.short > 0
                ? <span className="font-semibold text-red-600">{c.short} day{c.short === 1 ? '' : 's'} short</span>
                : <span className="text-emerald-700">complete</span>}
              {' '}<span className="text-muted-foreground">through {fmt(c.verified_through)}</span>
              {c.hours_since_check != null && c.hours_since_check > 48 && (
                <span className="text-red-600"> · last checked {c.hours_since_check}h ago</span>
              )}
            </span>
          ))}
          <span className="ml-auto text-muted-foreground">Proof by county in the Collection Log →</span>
        </div>
      </div>
    </Link>
  );
}
