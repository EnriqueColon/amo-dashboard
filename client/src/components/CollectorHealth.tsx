// Scheduled jobs — every collector and check on the server, did its last run work?
// Reads GET /api/qc/collectors (server/collector-health.ts), which parses each
// cron job's own log. Added 12 Nov 2026 after the Miami-Dade pull failed for two
// days and the weekly run crashed without the dashboard showing either.
import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { DefTerm } from '@/components/DefTerm';
import { Activity, CheckCircle, XCircle, Clock, AlertTriangle, Loader2, HelpCircle } from 'lucide-react';

type Run = { started: string | null; finished: string | null; ok: boolean | null; result: string; reason?: string };
type Job = {
  id: string; label: string; group: string; schedule: string;
  status: 'ok' | 'running' | 'failed' | 'overdue' | 'warn' | 'no_log';
  last_run: Run | null; last_good: string | null; failures_in_a_row: number;
  hours_since_start: number | null; recent: Run[];
};
type Health = { active: boolean; generated_at: string; failing: number; jobs: Job[] };

const GROUPS = ['County records', 'Foreclosure complaints', 'Checks and processing', 'Email and backups'];

const when = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const ago = (h: number | null) =>
  h == null ? '' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;

const BADGE: Record<Job['status'], { text: string; cls: string; Icon: any }> = {
  ok: { text: 'OK', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400', Icon: CheckCircle },
  running: { text: 'Running', cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-400', Icon: Loader2 },
  failed: { text: 'Failed', cls: 'bg-red-500/15 text-red-600', Icon: XCircle },
  overdue: { text: 'Overdue', cls: 'bg-red-500/15 text-red-600', Icon: Clock },
  warn: { text: 'Warning', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-500', Icon: AlertTriangle },
  no_log: { text: 'No log', cls: 'bg-muted text-muted-foreground', Icon: HelpCircle },
};

function Dot({ r }: { r: Run }) {
  const cls = r.ok === true ? 'bg-emerald-500' : r.ok === false ? 'bg-red-500' : 'bg-muted-foreground/40';
  const title = `${when(r.started)} — ${r.result}${r.reason ? `\n${r.reason}` : ''}`;
  return <span title={title} className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />;
}

export default function CollectorHealth() {
  const { data, isLoading } = useQuery<Health>({
    queryKey: ['/api/qc/collectors'],
    queryFn: () => apiRequest('GET', '/api/qc/collectors').then(r => r.json()),
    refetchInterval: 120_000,
    staleTime: 0,
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data?.active) return null;

  const failing = data.jobs.filter(j => j.status === 'failed' || j.status === 'overdue');

  return (
    <div className="space-y-3" data-testid="collector-health">
      <div className="flex items-center gap-2 flex-wrap">
        <Activity size={16} className={failing.length ? 'text-red-500' : 'text-emerald-600'} />
        <h2 className="text-sm font-semibold">Scheduled jobs — did each one run and work?</h2>
        <span className="text-xs text-muted-foreground">
          Every collector, check, email and backup on the server, read from its own log. Updated {when(data.generated_at)}.
        </span>
      </div>

      {failing.length > 0 && (
        <div data-testid="collector-health-alert" className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600">
          <span className="font-semibold">{failing.length} job{failing.length === 1 ? '' : 's'} need{failing.length === 1 ? 's' : ''} attention:</span>{' '}
          {failing.map(j => `${j.label} (${j.status === 'overdue' ? 'overdue' : j.failures_in_a_row > 1 ? `failed ${j.failures_in_a_row} runs in a row` : 'last run failed'})`).join(' · ')}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden [contain:inline-size]">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Job">Job</DefTerm></th>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Schedule">Schedule</DefTerm></th>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Result">Result</DefTerm></th>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Last run">Last run</DefTerm></th>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Last worked">Last worked</DefTerm></th>
                <th className="px-3 py-2 text-left font-medium"><DefTerm term="collection-log:Recent runs">Recent runs</DefTerm></th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(g => {
                const rows = data.jobs.filter(j => j.group === g);
                if (!rows.length) return null;
                return (
                  <Fragment key={g}>
                    <tr className="bg-muted/10"><td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</td></tr>
                    {rows.map(j => {
                      const b = BADGE[j.status];
                      const bad = j.status === 'failed' || j.status === 'overdue';
                      return (
                        <tr key={j.id} data-testid={`job-${j.id}`} className={`border-t border-border/50 align-top ${bad ? 'bg-red-500/5' : ''}`}>
                          <td className="px-3 py-2 font-medium">
                            {j.label}
                            {bad && j.last_run?.reason && (
                              <div className="mt-1 max-w-[40ch] break-words font-mono text-[11px] font-normal text-red-600">{j.last_run.reason}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 min-w-[9rem] text-muted-foreground">{j.schedule}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.cls}`}>
                              <b.Icon size={11} className={j.status === 'running' ? 'animate-spin' : ''} />{b.text}
                            </span>
                            {j.last_run && j.status !== 'running' && <div className="mt-0.5 text-[11px] text-muted-foreground">{j.last_run.result}</div>}
                          </td>
                          <td className="px-3 py-2 min-w-[6.5rem]">
                            {when(j.last_run?.started)}
                            {j.hours_since_start != null && <div className="text-[11px] text-muted-foreground">{ago(j.hours_since_start)}</div>}
                          </td>
                          <td className={`px-3 py-2 min-w-[6.5rem] ${bad ? 'text-red-600' : ''}`}>{when(j.last_good)}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-1 min-w-[5rem]">{j.recent.map((r, i) => <Dot key={i} r={r} />)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
