import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Gavel, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';

// Quality control for the Complaints (open testing) tab, shown on the Collection Log tab.
// Two questions: did we collect everything (runs, coverage, errors, spend), and is what we read correct
// (automatic consistency checks, plus a monthly sample a person checks against the complaint).

type Qc = any;

const HEALTH: Record<string, { text: string; cls: string }> = {
  ok: { text: 'Collector is running on schedule', cls: 'text-green-600' },
  stale: { text: 'No successful run for more than 36 hours', cls: 'text-amber-600' },
  last_run_failed: { text: 'The last run failed', cls: 'text-red-600' },
  never_run: { text: 'The collector has not run yet', cls: 'text-muted-foreground' },
};
const when = (iso?: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const val = (v: any) => (v == null ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

function AuditRow({ s, onDone }: { s: any; onDone: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [wrongFields, setWrongFields] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (verdict: 'correct' | 'wrong') =>
      apiRequest('POST', '/api/complaints/qc/audit', { case_id: s.case_id, verdict, fields: wrongFields, note }).then(r => r.json()),
    onSuccess: () => { toast({ title: 'Recorded', description: `${s.case_number} audit saved.` }); onDone(); },
    onError: (e: any) => toast({ title: 'Could not save', description: String(e?.message || e), variant: 'destructive' }),
  });
  return (
    <div className="border border-border/50 rounded-md p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <b>{s.case_number}</b><span className="text-muted-foreground">{s.plaintiff}</span>
        <span className={s.qualifies ? 'text-green-600' : 'text-muted-foreground'}>{s.qualifies ? 'Qualifies' : s.is_foreclosure ? 'Does not qualify' : 'Not a mortgage foreclosure'}</span>
        {s.audit && <span className={`ml-auto font-medium ${s.audit.verdict === 'correct' ? 'text-green-600' : 'text-red-600'}`}>Checked: {s.audit.verdict}</span>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
        {s.fields.map((f: any) => (
          <label key={f.label} className="flex items-center gap-2">
            {!s.audit && <input type="checkbox" checked={wrongFields.includes(f.label)}
              onChange={e => setWrongFields(w => e.target.checked ? [...w, f.label] : w.filter(x => x !== f.label))} title="Tick if this value is wrong" />}
            <span className="text-muted-foreground w-52 shrink-0">{f.label}</span><span>{val(f.value)}</span>
            {f.page && <a className="text-primary underline" target="_blank" rel="noreferrer" href={`/api/complaints/${s.case_id}/page/${f.page}`}>p.{f.page}</a>}
          </label>
        ))}
      </div>
      {!s.audit && (
        <div className="flex gap-2 items-center flex-wrap">
          <span className="text-muted-foreground">Open each page, compare, tick any value that is wrong.</span>
          <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="h-7 text-xs w-56" />
          <Button size="sm" className="h-7 text-xs" disabled={save.isPending || wrongFields.length > 0} onClick={() => save.mutate('correct')}>All correct</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={save.isPending || wrongFields.length === 0} onClick={() => save.mutate('wrong')}>Something is wrong</Button>
        </div>
      )}
    </div>
  );
}

export default function ComplaintsQc() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Qc>({
    queryKey: ['/api/complaints/qc'],
    queryFn: () => apiRequest('GET', '/api/complaints/qc').then(r => r.json()),
  });
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data?.active) return null; // the complaints pipeline has not run on this server

  const h = HEALTH[data.health] ?? HEALTH.ok;
  const failing = (data.checks as any[]).filter(c => c.cases.length > 0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['/api/complaints/qc'] });

  return (
    <section className="rounded-lg border border-border/60 p-4 space-y-5" data-testid="complaints-qc">
      <div className="flex items-center gap-2 flex-wrap">
        <Gavel size={15} className="text-primary" />
        <h2 className="text-base font-semibold">Complaints (open testing): collection and accuracy</h2>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">Open testing</span>
        <span className={`ml-auto text-xs font-medium flex items-center gap-1 ${h.cls}`}>
          {data.health === 'ok' ? <CheckCircle size={13} /> : data.health === 'never_run' ? null : <AlertTriangle size={13} />}
          {h.text}{data.hours_since_last_ok_run != null ? ` (last good run ${data.hours_since_last_ok_run} h ago)` : ''}
        </span>
      </div>

      {/* 1. Did we collect everything */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">1. Did we collect everything?</h3>
        <p className="text-xs text-muted-foreground">
          Every case the Clerk lists for RPMF-Commercial and RPMF-Non-Homestead is stored, whether or not its complaint is public. Each run searches
          the last 10 days, so a late-listed case is picked up; a complaint that is not public is retried weekly for 8 weeks.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground border-b border-border/50">
              <th className="py-1">Filed (week of)</th><th className="text-right">Cases found</th><th className="text-right">Read</th>
              <th className="text-right">Not public</th><th className="text-right">Waiting</th><th className="text-right">Errors</th></tr></thead>
            <tbody>
              {data.coverage.map((w: any) => (
                <tr key={w.week} className="border-b border-border/30">
                  <td className="py-1">{w.week}</td><td className="text-right">{w.found}</td><td className="text-right">{w.extracted}</td>
                  <td className="text-right">{w.not_public}</td>
                  <td className={`text-right ${w.waiting ? 'text-amber-600' : ''}`}>{w.waiting}</td>
                  <td className={`text-right ${w.errors ? 'text-red-600' : ''}`}>{w.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.problems.length > 0 && (
          <div className="text-xs text-red-600">Cases whose last attempt failed: {data.problems.map((p: any) => `${p.case_number} (${p.note})`).join(' · ')}</div>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Last {data.runs.length} runs and daily spend</summary>
          <table className="w-full mt-2">
            <thead><tr className="text-left text-muted-foreground border-b border-border/50">
              <th className="py-1">Started</th><th>Result</th><th className="text-right">Found</th><th className="text-right">New</th>
              <th className="text-right">Downloaded</th><th className="text-right">Read</th><th className="text-right">Still waiting</th><th>Note</th></tr></thead>
            <tbody>
              {data.runs.map((r: any) => (
                <tr key={r.id} className="border-b border-border/30">
                  <td className="py-1 whitespace-nowrap">{when(r.started_at)}</td>
                  <td>{r.status === 'ok' ? <span className="text-green-600">OK</span> : <span className="text-red-600 flex items-center gap-1"><XCircle size={11} />Failed</span>}</td>
                  <td className="text-right">{val(r.cases_found)}</td><td className="text-right">{val(r.new_cases)}</td>
                  <td className="text-right">{val(r.downloaded)}</td><td className="text-right">{val(r.extracted)}</td>
                  <td className="text-right">{val(r.extract_waiting)}</td>
                  <td>{r.error ?? (r.stopped_for_budget ? 'stopped at the daily spending cap' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="mt-3">
            <thead><tr className="text-left text-muted-foreground border-b border-border/50"><th className="py-1 pr-6">Day</th><th className="pr-6 text-right">Complaints read</th><th className="text-right">Estimated spend</th></tr></thead>
            <tbody>
              {data.spend.map((s: any) => (
                <tr key={s.day} className="border-b border-border/30"><td className="py-1 pr-6">{s.day}</td><td className="pr-6 text-right">{s.complaints}</td>
                  <td className="text-right">${s.usd.toFixed(2)}{s.usd >= data.daily_cap_usd ? ' (cap reached)' : ''}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground mt-1">Daily cap ${data.daily_cap_usd}. Spend is estimated from the tokens each read used at the listed {data.model} price, not from the OpenAI invoice; compare it with the invoice.</p>
        </details>
      </div>

      {/* 2. Is what we read correct */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">2. Is what we read correct?</h3>
        <p className="text-xs text-muted-foreground">Automatic checks run on every complaint read. A listed case is not necessarily wrong; it is where to look first.</p>
        {failing.length === 0 ? (
          <div className="text-xs text-green-600 flex items-center gap-1"><CheckCircle size={13} />All {data.checks.length} automatic checks pass on every complaint read so far.</div>
        ) : failing.map((c: any) => (
          <details key={c.key} className="text-xs">
            <summary className="cursor-pointer"><span className="text-amber-600 font-medium">{c.cases.length}</span> {c.title}</summary>
            <div className="text-muted-foreground ml-4 mt-1">{c.what}</div>
            <ul className="ml-4 mt-1 list-disc">{c.cases.slice(0, 10).map((x: any, i: number) => <li key={i}><b>{x.case_number}</b> — {x.detail}</li>)}</ul>
          </details>
        ))}

        <div className="pt-2 space-y-2">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <span className="font-medium">Monthly human check, {data.audit.month}:</span>
            <span>{data.audit.sample_done} of {data.audit.sample_size} done</span>
            <span className="text-muted-foreground">
              Measured accuracy so far: {data.audit.accuracy_pct == null ? 'not enough checks yet' : `${data.audit.accuracy_pct}% of ${data.audit.total_audited} complaints checked had every key value right`}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Ten complaints are picked for you each month (six that qualify, four that do not). Open the cited page for each value and compare. This is the only
            check that catches a confident wrong answer.
          </p>
          <div className="space-y-2">{data.audit.sample.map((s: any) => <AuditRow key={s.case_id} s={s} onDone={refresh} />)}</div>
        </div>
      </div>
    </section>
  );
}
