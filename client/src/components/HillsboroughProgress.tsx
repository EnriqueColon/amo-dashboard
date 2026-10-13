import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';

type Group = { total: number; read: number; ok: number; unread: number };
type Progress = {
  active: boolean;
  assignments?: Group | null;
  ucc?: Group | null;
  per_hour?: number;
  errors_last_hour?: number;
  last_read?: string | null;
  minutes_since_read?: number | null;
  backlog?: boolean;
  hours_remaining?: number | null;
  stalled?: boolean;
  daily_last_run?: string | null;
  daily_stale?: boolean;
};

/**
 * Hillsborough reading progress and pipeline warnings, for the Overview page.
 *
 * Shown under every county scope: like the backup banner, it reports on a job,
 * not on the selected county's records. While the document backlog is being
 * read it shows a progress card; once caught up it renders nothing unless
 * something is wrong.
 */
export default function HillsboroughProgress() {
  const { data } = useQuery<Progress>({
    queryKey: ['/api/hillsborough/progress'],
    queryFn: () => apiRequest('GET', '/api/hillsborough/progress').then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 0,
  });
  if (!data?.active) return null;

  const perHour = data.per_hour ?? 0;
  const errorHeavy = perHour >= 20 && (data.errors_last_hour ?? 0) / perHour > 0.25;
  const warn = data.stalled || data.daily_stale || errorHeavy;
  if (!data.backlog && !warn) return null;

  const pct = (g?: Group | null) => (g && g.total ? Math.floor((g.read / g.total) * 100) : 0);
  const fmt = (n?: number) => (n ?? 0).toLocaleString('en-US');
  const remaining = data.hours_remaining;
  const eta = remaining == null ? null
    : remaining < 1 ? 'under an hour'
    : remaining < 48 ? `about ${remaining} hours`
    : `about ${Math.round(remaining / 24)} days`;

  return (
    <div
      data-testid="hillsborough-progress"
      className={`rounded-lg border px-4 py-3 text-xs text-foreground ${
        warn ? 'border-red-500/40 bg-red-500/10' : 'border-emerald-500/30 bg-emerald-500/5'
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {warn
          ? <AlertCircle size={14} className="shrink-0 text-red-500" />
          : <Loader2 size={14} className="shrink-0 animate-spin text-emerald-600" />}
        <span>Hillsborough — reading the document backlog</span>
      </div>

      {data.stalled && (
        <p className="mt-1.5 text-red-600 dark:text-red-400">
          No document has been read in {data.minutes_since_read ?? '?'} minutes while{' '}
          {fmt((data.assignments?.unread ?? 0) + (data.ucc?.unread ?? 0))} are waiting. The reading
          job has probably stopped (a server restart stops it) and needs restarting.
        </p>
      )}
      {errorHeavy && (
        <p className="mt-1.5 text-red-600 dark:text-red-400">
          {fmt(data.errors_last_hour)} of the {fmt(perHour)} documents tried in the last hour failed —
          the clerk's site may be refusing downloads.
        </p>
      )}
      {data.daily_stale && (
        <p className="mt-1.5 text-red-600 dark:text-red-400">
          The Hillsborough daily job has not run since {data.daily_last_run} UTC.
        </p>
      )}

      {data.backlog && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([['Assignments', data.assignments], ['UCC filings', data.ucc]] as const).map(([label, g]) => g && (
            <div key={label}>
              <div className="flex justify-between text-muted-foreground">
                <span>{label}</span>
                <span className="tabular-nums">{fmt(g.read)} / {fmt(g.total)} ({pct(g)}%)</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-muted">
                <div className="h-1.5 rounded bg-emerald-500" style={{ width: `${pct(g)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-muted-foreground">
        {fmt(perHour)} read in the last hour
        {data.last_read && <> · last at {data.last_read.slice(11, 16)} UTC</>}
        {eta && <> · {eta} to go at this pace</>}
        {' '}· assignments first, then UCC filings. Deals appear on the dashboard after each nightly rebuild.
      </p>
    </div>
  );
}
