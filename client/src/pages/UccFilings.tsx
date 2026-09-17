import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import DocLink from '@/components/DocLink';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Landmark, Search, X, ChevronLeft, ChevronRight, Download,
  MapPin, TrendingUp, Users, BadgeCheck, AlertTriangle, Sun,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { FilterHint } from '@/components/FilterHint';
import { UCC_CATEGORY_DEFS, UCC_HAS_PROPERTY_DEF, UCC_CONSUMER_DEF, UCC_ROLES_DEF, UCC_TAB_DEFS } from '@/lib/filterDefinitions';

// UCC financing statements — secured lending, deliberately a separate page from
// Reporting. The columns here are Borrower and Lender, which is what the filing
// actually records: a borrower pledging collateral to a lender. On an assignment
// the first party is the institution selling a loan, the opposite direction, so
// the two datasets cannot share a table without one of them reading as nonsense.

function fmtAmt(v: number | null | undefined): string | null {
  if (!v || !isFinite(v) || v <= 0) return null;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const CATEGORY_OPTIONS: [string, string][] = [
  ['',           'All'],
  ['collateral', 'Collateral'],
  ['other',      'Other'],
  ['rents',      'Rents & leases'],
];

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-tight mt-0.5">{value}</div>
      {note && <div className="text-[11px] text-muted-foreground mt-0.5">{note}</div>}
    </div>
  );
}

function PartyPanel({ qs }: { qs: string }) {
  const [tab, setTab] = useState<'lenders' | 'borrowers'>('lenders');
  const { data, isLoading } = useQuery({
    queryKey: ['/api/ucc/parties', qs],
    queryFn: () => apiRequest('GET', `/api/ucc/parties${qs}`).then(r => r.json()),
  });
  const rows = (tab === 'lenders' ? data?.topLenders : data?.topBorrowers) || [];
  const max = Math.max(1, ...rows.map((r: any) => r.filings));

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Users size={13} className="text-muted-foreground" />Most active
        </h2>
        <div className="flex gap-1">
          {(['lenders', 'borrowers'] as const).map(t => (
            <FilterHint key={t} def={UCC_TAB_DEFS[t]}>
              <button onClick={() => setTab(t)}
                className={`text-[11px] font-medium px-2 py-1 rounded border transition-colors capitalize ${tab === t ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {t}
              </button>
            </FilterHint>
          ))}
        </div>
      </div>
      {isLoading ? <Skeleton className="h-56 w-full" /> : (
        <div className="space-y-1">
          {rows.map((r: any, i: number) => (
            <div key={r.name} className="flex items-center gap-2 text-xs">
              <span className="w-4 text-right text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate" title={r.name}>{r.name}</span>
              <span className="h-1.5 rounded-full bg-primary/70 shrink-0"
                style={{ width: `${Math.max(3, (r.filings / max) * 90)}px` }} />
              <span className="w-12 text-right tabular-nums text-muted-foreground">
                {r.filings.toLocaleString()}
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground py-8 text-center">
              No filings match these filters.
            </p>
          )}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/80 leading-snug">
        Names are exactly as filed. They are not merged into canonical entities —
        borrowers here are mostly property companies named after street numbers,
        and merging them would combine unrelated firms.
      </p>
    </div>
  );
}

function VolumeChart({ qs }: { qs: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/ucc/chart', qs],
    queryFn: () => apiRequest('GET', `/api/ucc/chart${qs}`).then(r => r.json()),
  });
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold flex items-center gap-1.5">
        <TrendingUp size={13} className="text-muted-foreground" />Filings per month
      </h2>
      {isLoading ? <Skeleton className="h-56 w-full" /> : (
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={data || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
            <XAxis dataKey="period" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={36}
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v} />
            <Tooltip formatter={(v: any) => v.toLocaleString()} />
            <Bar dataKey="count" fill="#f97316" radius={[3, 3, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

export default function UccFilings() {
  const [search, setSearch]       = useState('');
  const [applied, setApplied]     = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [category, setCategory]   = useState('');
  const [hasProperty, setHasProperty] = useState(false);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  // Consumer solar and home-improvement lending is 29% of the filings and
  // none of it is commercial real estate, so it starts hidden.
  const [includeConsumer, setIncludeConsumer] = useState(false);
  const [page, setPage]           = useState(1);

  const qs = '?' + [
    applied && `search=${encodeURIComponent(applied)}`,
    startDate && `start_date=${startDate}`,
    endDate && `end_date=${endDate}`,
    category && `category=${category}`,
    hasProperty && 'has_property=1',
    confirmedOnly && 'confirmed=1',
    includeConsumer && 'include_consumer=1',
  ].filter(Boolean).join('&');

  const { data, isLoading } = useQuery({
    queryKey: ['/api/ucc', qs, page],
    queryFn: () => apiRequest('GET', `/api/ucc${qs}${qs === '?' ? '' : '&'}page=${page}&limit=50`)
      .then(r => r.json()),
  });

  const rows = data?.rows || [];
  const s = data?.summary;
  const hasFilters = applied || startDate || endDate || category || hasProperty || confirmedOnly;
  const clearAll = () => {
    setSearch(''); setApplied(''); setStartDate(''); setEndDate('');
    setCategory(''); setHasProperty(false); setConfirmedOnly(false);
    setIncludeConsumer(false); setPage(1);
  };
  const applySearch = () => { setApplied(search); setPage(1); };
  const reset = (fn: () => void) => { fn(); setPage(1); };

  const pct = (n: number, d: number) => d > 0 ? `${Math.round((n / d) * 100)}%` : '—';

  return (
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto">

      <div className="flex items-start justify-between gap-3 flex-wrap print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <Landmark size={15} className="text-primary" />
            <h1 className="text-lg font-semibold">UCC Filings</h1>
            <span className="text-xs text-muted-foreground ml-1">Miami-Dade</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            Financing statements — a lender recording a security interest against a borrower.
            This is secured lending, not loans changing hands, so the parties read
            <strong className="text-foreground"> borrower → lender</strong>. Loan sales and
            transfers live on the Reporting tab.
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Consumer solar and home-improvement lenders, filing agents and utilities are
            <strong className="text-foreground"> hidden by default</strong> — 36% of filings, none of
            it commercial real estate. Toggle them back with the control below.
          </p>
          <p className="text-[11px] text-muted-foreground mt-1.5 max-w-3xl flex items-start gap-1.5">
            <AlertTriangle size={11} className="text-amber-500 shrink-0 mt-0.5" />
            <span>
              The county's index does not list the two parties in a consistent order — the
              lender comes first on roughly a third of filings. Where we have read the document
              the roles below come from the form itself; the rest are marked, and their direction
              may be reversed. Use <strong className="text-foreground">Roles from document</strong> to
              see only the confirmed ones.
            </span>
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
          onClick={() => { window.location.href = `/api/ucc/export${qs}`; }}
          title="Download the filtered filings as CSV">
          <Download size={12} />Export CSV
        </Button>
      </div>

      {/* Coverage — stated up front, because two of these fields are sparse and
          a reader should know that before drawing conclusions from blanks. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Filings" value={(s?.filings ?? 0).toLocaleString()}
              note={hasFilters ? 'matching filters' : '2023 → present'} />
        <Stat label="Distinct lenders" value={(s?.lenders ?? 0).toLocaleString()}
              note={s ? `${pct(s.roles_confirmed, s.filings)} with roles read off the document` : undefined} />
        <Stat label="With a property" value={(s?.with_property ?? 0).toLocaleString()}
              note={s ? `${pct(s.with_property, s.filings)} of filings` : undefined} />
        <Stat label="With an amount" value={(s?.with_amount ?? 0).toLocaleString()}
              note={s ? `${pct(s.with_amount, s.filings)} — a UCC form states collateral, not debt size` : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VolumeChart qs={qs} />
        <PartyPanel qs={qs} />
      </div>

      {/* Filters */}
      <div className="bg-card border border-border rounded-lg p-3 space-y-2 print:hidden">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="lg:col-span-2">
            <Input placeholder="Search borrower, lender, property or CFN…" value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applySearch()}
              className="h-7 text-xs" />
          </div>
          <Input type="date" value={startDate} className="h-7 text-xs"
            onChange={e => reset(() => setStartDate(e.target.value))} />
          <Input type="date" value={endDate} className="h-7 text-xs"
            onChange={e => reset(() => setEndDate(e.target.value))} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Collateral type:</span>
          {CATEGORY_OPTIONS.map(([val, label]) => (
            <FilterHint key={val || 'all'} def={UCC_CATEGORY_DEFS[val]}>
              <button onClick={() => reset(() => setCategory(val))}
                className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors ${category === val ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            </FilterHint>
          ))}
          <FilterHint def={UCC_HAS_PROPERTY_DEF}>
            <button onClick={() => reset(() => setHasProperty(v => !v))}
              className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors inline-flex items-center gap-1 ml-2 ${hasProperty ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              <MapPin size={9} />Has a property
            </button>
          </FilterHint>
          <FilterHint def={UCC_CONSUMER_DEF}
            extra={includeConsumer ? 'Currently shown.' : 'Currently hidden — about a third of all UCC filings.'}>
            <button onClick={() => reset(() => setIncludeConsumer(v => !v))}
              className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors inline-flex items-center gap-1 ${includeConsumer ? 'bg-amber-500 text-white border-amber-500' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              <Sun size={9} />{includeConsumer ? 'Consumer finance shown' : 'Consumer finance hidden'}
            </button>
          </FilterHint>
          <FilterHint def={UCC_ROLES_DEF}>
            <button onClick={() => reset(() => setConfirmedOnly(v => !v))}
              className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors inline-flex items-center gap-1 ${confirmedOnly ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              <BadgeCheck size={9} />Roles from document
            </button>
          </FilterHint>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" onClick={applySearch} className="h-7 text-xs gap-1">
              <Search size={11} />Search
            </Button>
            {hasFilters && (
              <Button size="sm" variant="ghost" onClick={clearAll}
                className="h-7 text-xs gap-1 text-muted-foreground"><X size={11} />Clear</Button>
            )}
          </div>
        </div>
      </div>

      {/* Filings */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 border-b border-border">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">CFN</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Borrower</th>
                <th className="px-3 py-2 font-medium">Lender</th>
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 font-medium">Collateral</th>
                <th className="px-3 py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td colSpan={7} className="px-3 py-2"><Skeleton className="h-4 w-full" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  No filings match these filters.
                </td></tr>
              ) : rows.map((r: any) => (
                <tr key={r.cfn} className="border-b border-border/60 hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <DocLink row={r} className="text-primary hover:underline"
                      title="View the recorded document on the county portal">
                      {r.cfn}
                    </DocLink>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums text-muted-foreground">
                    {r.rec_date}
                  </td>
                  <td className="px-3 py-2 max-w-[220px] truncate" title={r.borrower || ''}>
                    {r.borrower || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 max-w-[220px] truncate font-medium" title={r.lender || ''}>
                    <span className="inline-flex items-center gap-1">
                      {!r.roles_confirmed && (
                        <AlertTriangle size={10} className="text-amber-500 shrink-0"
                          aria-label="Direction taken from the county index"
                          />
                      )}
                      {r.lender || <span className="text-muted-foreground font-normal">—</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 max-w-[240px] truncate text-muted-foreground"
                      title={r.property_address || ''}>
                    {r.property_address || (
                      <span className="text-muted-foreground/50">
                        {r.is_read ? 'none stated' : 'not read yet'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {r.doc_category
                      ? r.doc_category.replace('_', ' ').toLowerCase()
                      : <span className="text-muted-foreground/50">—</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right tabular-nums">
                    {fmtAmt(r.loan_amount) || <span className="text-muted-foreground/50">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-border text-xs">
            <span className="text-muted-foreground tabular-nums">
              Page {data.page} of {data.pages.toLocaleString()} · {data.total.toLocaleString()} filings
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2"
                disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft size={12} />
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2"
                disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight size={12} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
