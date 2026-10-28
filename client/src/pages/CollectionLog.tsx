import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { DefTerm } from '@/components/DefTerm';
import { documentUrl } from '@/lib/doc-url';
import {
  CheckCircle, AlertTriangle, XCircle, MinusCircle, ClipboardList, ShieldCheck, ShieldAlert,
  ExternalLink,
} from 'lucide-react';

function StatusIcon({ status }: { status: string }) {
  if (status === 'OK') return <CheckCircle size={13} className="text-green-400 shrink-0" />;
  if (status === 'CAPPED') return <AlertTriangle size={13} className="text-amber-400 shrink-0" />;
  // EMPTY is the portal answering "nothing recorded in this window" — a normal
  // result, not a failure. Painting it red would recreate the alarm-that-always-
  // fires problem the Broward banner already taught us: AIT reports EMPTY on
  // every run, and a log full of red X's trains the reader to ignore real errors.
  if (status === 'EMPTY') return <MinusCircle size={13} className="text-muted-foreground shrink-0" />;
  return <XCircle size={13} className="text-red-400 shrink-0" />;
}

// ─── Scrape completeness — the proof, by county ──────────────────────────────
//
// collector/reconcile_counties.py asks each county for the instrument numbers
// it lists per recording day and compares them to what we hold under ANY type
// or date. It runs after every Miami-Dade pull, daily for all counties at
// 16:30 UTC, and over 14 days every Friday; a day it finds short is
// re-collected on the spot and asked again. What it could not fix is listed
// below with the exact instruments, so "is everything in?" has an answer a
// reader can check against the county themselves.

type CountyRow = {
  county: string; checks: number; ok: number; ahead: number; short: number; unknown: number;
  last_checked: string | null; verified_through: string | null; hours_since_check: number | null;
};
type AllTimeRow = {
  county: string; checks: number; ok: number; ahead: number; short: number; unknown: number;
  first_day: string | null; last_day: string | null;
};
type Exception = {
  county: string; rec_date: string; doc_type: string; source_count: number | null;
  our_count: number | null; status: string; note: string | null; missing_cfns: string[];
  checked_at: string;
};
type Coverage = {
  active: boolean;
  generated_at?: string;
  counties?: CountyRow[];
  all_time?: AllTimeRow[];
  exceptions?: Exception[];
  collection?: { county: string; last_collected: string | null }[];
  any_short?: boolean;
  stale?: boolean;
};

const LABEL: Record<string, string> = { 'MIAMI-DADE': 'Miami-Dade', BROWARD: 'Broward', HILLSBOROUGH: 'Hillsborough' };
const SOURCE: Record<string, string> = {
  'MIAMI-DADE': 'the clerk’s portal search, one query per document type per day',
  BROWARD: 'the county’s own daily index file (and the yearly export for past years)',
  HILLSBOROUGH: 'the clerk’s public search API, one query per document type per day',
};
const ORDER = ['MIAMI-DADE', 'BROWARD', 'HILLSBOROUGH'];
// Gaps the check cannot see because the county offers no free source for the
// period at all — stated on the card so "complete" is never read as "everything
// since 2023". Broward: the yearly export stops at CY2025 and the daily feed keeps
// ~10 days, so 1 Jan – 21 Jul 2026 is in neither; the owner deferred the county's
// paid bulk order on 21 Oct 2026. The index self-heals when CY2026 publishes
// (~Feb 2027); the images for that window never will.
const KNOWN_GAP: Record<string, string> = {
  BROWARD: 'Known gap, not checkable: 1 Jan – 21 Jul 2026 is not in the county’s free feed. Fills itself when the county publishes its 2026 export (~Feb 2027); the paid bulk order is deferred.',
};

const fmtDay = (d?: string | null) => (d ? d.slice(0, 10) : '—');
const fmtWhen = (iso?: string | null) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function CountyProof({ row, all, lastCollected }: {
  row?: CountyRow; all?: AllTimeRow; lastCollected?: string | null;
}) {
  const county = row?.county ?? all?.county ?? '';
  const short = row?.short ?? 0;
  const stale = row?.hours_since_check != null && row.hours_since_check > 48;
  const warn = short > 0 || stale;
  const checked30 = row?.checks ?? 0;
  const verified30 = (row?.ok ?? 0) + (row?.ahead ?? 0);
  const allVerified = (all?.ok ?? 0) + (all?.ahead ?? 0);

  return (
    <div
      data-testid={`proof-${county}`}
      className={`rounded-lg border px-4 py-3 text-xs space-y-2 ${
        warn ? 'border-red-500/40 bg-red-500/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {warn ? <ShieldAlert size={15} className="text-red-500" /> : <ShieldCheck size={15} className="text-emerald-600" />}
          {LABEL[county] ?? county}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
          short > 0 ? 'bg-red-500/15 text-red-600'
          : stale ? 'bg-amber-500/15 text-amber-600'
          : 'bg-emerald-500/15 text-emerald-700'}`}>
          {short > 0 ? `${short} day${short === 1 ? '' : 's'} missing documents`
           : stale ? `check stale — ${row?.hours_since_check}h`
           : 'complete'}
        </span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground"><DefTerm term="collection-log:Verified through">Verified through</DefTerm></dt>
        <dd className="font-mono">{fmtDay(row?.verified_through ?? all?.last_day)}</dd>
        <dt className="text-muted-foreground"><DefTerm term="collection-log:Last checked">Last checked</DefTerm></dt>
        <dd>{fmtWhen(row?.last_checked)}{row?.hours_since_check != null && <span className="text-muted-foreground"> ({row.hours_since_check}h ago)</span>}</dd>
        <dt className="text-muted-foreground"><DefTerm term="collection-log:Last collected">Last collected</DefTerm></dt>
        <dd>{fmtWhen(lastCollected)}</dd>
        <dt className="text-muted-foreground"><DefTerm term="collection-log:Last 30 days">Last 30 days</DefTerm></dt>
        <dd className="tabular-nums">
          {verified30} of {checked30} day-checks verified
          {(row?.short ?? 0) > 0 && <span className="text-red-600"> · {row!.short} short</span>}
          {(row?.unknown ?? 0) > 0 && <span className="text-amber-600"> · {row!.unknown} unverifiable</span>}
        </dd>
        <dt className="text-muted-foreground"><DefTerm term="collection-log:Since">Since {fmtDay(all?.first_day)}</DefTerm></dt>
        <dd className="tabular-nums">
          {allVerified.toLocaleString()} of {(all?.checks ?? 0).toLocaleString()} day-checks verified
          {(all?.short ?? 0) > 0 && <span className="text-red-600"> · {all!.short} short</span>}
          {(all?.unknown ?? 0) > 0 && <span className="text-amber-600"> · {all!.unknown} unverifiable</span>}
        </dd>
      </dl>
      <p className="text-[11px] text-muted-foreground">Checked against {SOURCE[county] ?? 'the county'}.</p>
      {KNOWN_GAP[county] && (
        <p data-testid={`known-gap-${county}`} className="text-[11px] text-amber-700 dark:text-amber-500">{KNOWN_GAP[county]}</p>
      )}
    </div>
  );
}

function MissingLink({ county, cfn }: { county: string; cfn: string }) {
  const url = documentUrl({ county, cfn });
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-primary hover:underline">{cfn}<ExternalLink size={9} /></a>
    : <span className="font-mono" title="Search this instrument on the county clerk’s site">{cfn}</span>;
}

function CompletenessProof() {
  // Client-side filter over the "not in the tool" table: an analyst checking one
  // instrument against the county should not have to scan every row for it.
  const [cfnFilter, setCfnFilter] = useState('');
  const { data, isLoading } = useQuery<Coverage>({
    queryKey: ['/api/qc/coverage'],
    queryFn: () => apiRequest('GET', '/api/qc/coverage').then(r => r.json()),
    refetchInterval: 300_000,
    staleTime: 0,
  });

  if (isLoading) {
    return <div className="grid gap-3 sm:grid-cols-3">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}</div>;
  }
  if (!data?.active) return null;

  const byCounty = new Map((data.counties ?? []).map(c => [c.county, c]));
  const allBy = new Map((data.all_time ?? []).map(c => [c.county, c]));
  const collectedBy = new Map((data.collection ?? []).map(c => [c.county, c.last_collected]));
  const counties = ORDER.filter(c => byCounty.has(c) || allBy.has(c));
  const exceptions = data.exceptions ?? [];
  const shortRows = exceptions.filter(e => e.status === 'SHORT');
  const otherRows = exceptions.filter(e => e.status !== 'SHORT');
  const cfnQuery = cfnFilter.trim().toUpperCase();
  const matchesCfn = (cfn: string) => cfn.toUpperCase().includes(cfnQuery);
  // When a filter is typed, keep only the rows holding a matching instrument and
  // show just the matching instruments in them (the row normally caps at 12).
  const shortShown = cfnQuery
    ? shortRows
        .filter(e => e.missing_cfns.some(matchesCfn))
        .map(e => ({ ...e, missing_cfns: e.missing_cfns.filter(matchesCfn) }))
    : shortRows;

  return (
    <div className="space-y-3" data-testid="completeness-proof">
      <div className="flex items-center gap-2">
        {data.any_short || data.stale
          ? <ShieldAlert size={16} className="text-red-500" />
          : <ShieldCheck size={16} className="text-emerald-600" />}
        <h2 className="text-sm font-semibold">Scrape completeness — proof by county</h2>
        <span className="text-xs text-muted-foreground">
          Every recording day is checked against the county clerk, instrument by instrument. Updated {fmtWhen(data.generated_at)}.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {counties.map(c => (
          <CountyProof key={c} row={byCounty.get(c)} all={allBy.get(c)} lastCollected={collectedBy.get(c)} />
        ))}
      </div>

      {shortRows.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 overflow-hidden">
          <div className="flex items-center justify-between gap-3 flex-wrap px-3 py-2">
            <div className="text-xs font-semibold text-red-600">
              Documents the county lists that are not in the tool — {shortRows.length} day{shortRows.length === 1 ? '' : 's'}
              {cfnQuery && <span className="font-normal text-muted-foreground"> · {shortShown.length} matching</span>}
            </div>
            <input
              type="text"
              value={cfnFilter}
              onChange={e => setCfnFilter(e.target.value)}
              placeholder="Filter by instrument / CFN…"
              aria-label="Filter missing instruments by instrument or CFN"
              data-testid="missing-cfn-filter"
              className="h-7 w-56 rounded border border-border bg-background px-2 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <table className="w-full text-xs">
            <thead className="border-y border-border bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:County">County</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Recording day">Recording day</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Type">Type</DefTerm></th>
                <th className="px-3 py-1.5 text-right font-medium"><DefTerm term="collection-log:County listed">County</DefTerm></th>
                <th className="px-3 py-1.5 text-right font-medium"><DefTerm term="collection-log:Ours">Ours</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Missing instruments">Missing instruments</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Checked">Checked</DefTerm></th>
              </tr>
            </thead>
            <tbody>
              {cfnQuery && shortShown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">No missing instrument contains “{cfnFilter.trim()}”</td>
                </tr>
              )}
              {shortShown.map(e => (
                <tr key={`${e.county}|${e.rec_date}|${e.doc_type}`} className="border-b border-border/50">
                  <td className="px-3 py-1.5">{LABEL[e.county] ?? e.county}</td>
                  <td className="px-3 py-1.5 font-mono">{e.rec_date}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.doc_type}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{e.source_count ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{e.our_count ?? '—'}</td>
                  <td className="px-3 py-1.5 space-x-2">
                    {e.missing_cfns.slice(0, 12).map(c => <MissingLink key={c} county={e.county} cfn={c} />)}
                    {e.missing_cfns.length > 12 && <span className="text-muted-foreground">+{e.missing_cfns.length - 12} more</span>}
                    {e.missing_cfns.length === 0 && e.note && <span className="text-muted-foreground">{e.note}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{fmtWhen(e.checked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {otherRows.length > 0 && (
        <details className="rounded-lg border border-border/70 bg-card">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {otherRows.length} day-check{otherRows.length === 1 ? '' : 's'} in the last 30 days that could not be verified or where we hold more than the county lists
          </summary>
          <table className="w-full text-xs">
            <thead className="border-t border-border bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:County">County</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Recording day">Recording day</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Type">Type</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:County / Ours">County / Ours</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Check status">Status</DefTerm></th>
                <th className="px-3 py-1.5 text-left font-medium"><DefTerm term="collection-log:Note">Note</DefTerm></th>
              </tr>
            </thead>
            <tbody>
              {otherRows.map(e => (
                <tr key={`${e.county}|${e.rec_date}|${e.doc_type}`} className="border-t border-border/50">
                  <td className="px-3 py-1.5">{LABEL[e.county] ?? e.county}</td>
                  <td className="px-3 py-1.5 font-mono">{e.rec_date}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.doc_type}</td>
                  <td className="px-3 py-1.5 font-mono">{e.source_count ?? '?'} / {e.our_count ?? '?'}</td>
                  <td className="px-3 py-1.5"><span className={e.status === 'AHEAD' ? 'text-emerald-700' : 'text-amber-600'}>{e.status}</span></td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CollectionLog() {
  const { data: log, isLoading } = useQuery({
    queryKey: ['/api/collection-log'],
    queryFn: () => apiRequest('GET', '/api/collection-log').then(r => r.json()),
  });

  const stats = (() => {
    if (!log) return null;
    const ok = log.filter((r: any) => r.status === 'OK').length;
    const capped = log.filter((r: any) => r.status === 'CAPPED').length;
    const err = log.filter((r: any) => r.status === 'ERROR').length;
    const total_records = log.reduce((s: number, r: any) => s + (r.records_found || 0), 0);
    return { ok, capped, err, total: log.length, total_records };
  })();

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-3">
        <ClipboardList size={20} className="text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">Collection Log</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Is everything the county clerks list in the tool? Proof by county, then the history of every collection run</p>
        </div>
      </div>

      <CompletenessProof />

      {/* Summary pills */}
      {stats && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-3 py-1">
            <CheckCircle size={12} className="text-green-600" />
            <span className="text-xs text-green-700 font-medium">{stats.ok} OK</span>
          </div>
          <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
            <AlertTriangle size={12} className="text-amber-600" />
            <span className="text-xs text-amber-700 font-medium">{stats.capped} Capped</span>
          </div>
          <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-full px-3 py-1">
            <XCircle size={12} className="text-red-600" />
            <span className="text-xs text-red-700 font-medium">{stats.err} Errors</span>
          </div>
          <div className="text-xs text-muted-foreground ml-2">
            {stats.total_records.toLocaleString()} total records across {stats.total} collection windows
          </div>
        </div>
      )}

      {/* Log table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="collection-log:Status">Status</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="collection-log:Date From">Date From</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="collection-log:Date To">Date To</DefTerm></th>
                <th className="px-3 py-2.5 text-right font-medium"><DefTerm term="collection-log:Records Found">Records Found</DefTerm></th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(15).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(4).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (log || []).map((r: any, i: number) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={r.status} />
                        <span className={`status-${r.status}`}>{r.status}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{r.date_from}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{r.date_to}</td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {r.records_found > 0 ? r.records_found.toLocaleString() : <span className="text-muted-foreground">0</span>}
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
