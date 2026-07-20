import { useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Landmark, ChevronLeft, ChevronRight, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const FACILITY_TYPE_META: Record<string, { label: string; color: string }> = {
  warehouse_or_revolving_credit_facility: { label: 'Warehouse / Revolving', color: 'text-blue-700 bg-blue-100 border-blue-300' },
  syndicated_credit_agreement:            { label: 'Syndicated Credit',     color: 'text-purple-700 bg-purple-100 border-purple-300' },
  consumer_or_business_line_of_credit:    { label: 'Consumer / Business LOC', color: 'text-slate-600 bg-slate-100 border-slate-300' },
};

function FacilityTypeBadge({ type }: { type: string | null }) {
  const m = type ? FACILITY_TYPE_META[type] : null;
  if (!m) return <span className="text-[10px] text-muted-foreground">—</span>;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap ${m.color}`}>
      {m.label}
    </span>
  );
}

function fmtMoney(v: number | null) {
  if (v == null) return '—';
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const MONTH_LABELS: Record<string, string> = {
  '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun',
  '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec',
};
function fmtMonth(m: string) {
  const [y, mo] = (m || '').split('-');
  return mo ? `${MONTH_LABELS[mo] || mo} ${y.slice(2)}` : m;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">{label}</p>
      <p className="text-2xl font-bold mt-1 text-primary">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

interface Filters {
  lender: string;
  borrower: string;
  facility_type: string;
  start_date: string;
  end_date: string;
}
const EMPTY: Filters = { lender: '', borrower: '', facility_type: '', start_date: '', end_date: '' };

export default function CreditFacilities() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [expandedCfn, setExpandedCfn] = useState<string | null>(null);

  const apply = () => { setApplied(draft); setPage(1); };
  const clear = () => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); };
  const hasFilters = Object.values(applied).some(Boolean);

  const qs = `?lender=${encodeURIComponent(applied.lender)}&borrower=${encodeURIComponent(applied.borrower)}` +
    `&facility_type=${encodeURIComponent(applied.facility_type)}&start_date=${applied.start_date}&end_date=${applied.end_date}` +
    `&page=${page}&limit=50`;

  const { data: _data, isLoading } = useQuery({
    queryKey: ['/api/credit-facility-events', qs],
    queryFn: () => apiRequest('GET', `/api/credit-facility-events${qs}`).then(r => r.json()),
    keepPreviousData: true,
  } as any);
  const data = _data as any;

  const { data: monthly, isLoading: mLoading } = useQuery({
    queryKey: ['/api/credit-facility-events/chart', 'monthly'],
    queryFn: () => apiRequest('GET', '/api/credit-facility-events/chart?type=monthly').then(r => r.json()),
  });

  const { data: topLenders } = useQuery({
    queryKey: ['/api/credit-facility-events/chart', 'top_lenders'],
    queryFn: () => apiRequest('GET', '/api/credit-facility-events/chart?type=top_lenders').then(r => r.json()),
  });

  const { data: byType } = useQuery({
    queryKey: ['/api/credit-facility-events/chart', 'by_facility_type'],
    queryFn: () => apiRequest('GET', '/api/credit-facility-events/chart?type=by_facility_type').then(r => r.json()),
  });

  const { data: volume } = useQuery({
    queryKey: ['/api/credit-facility-events/chart', 'total_volume'],
    queryFn: () => apiRequest('GET', '/api/credit-facility-events/chart?type=total_volume').then(r => r.json()),
  });

  const distinctLenders = (topLenders as any[] | undefined)?.length ?? 0;

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-3">
        <Landmark size={20} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-semibold">Credit Facilities</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Recorded documents that describe an institutional warehouse/revolving credit facility or line of credit,
            identified from document text by the extraction pipeline.
          </p>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Filings Found" value={data ? data.total.toLocaleString() : '—'} />
        <StatCard label="Distinct Lenders" value={distinctLenders ? String(distinctLenders) : '—'} />
        <StatCard
          label="Total Facility Volume"
          value={volume?.total != null ? fmtMoney(volume.total) : '—'}
          sub={volume?.distinct_facilities != null ? `${volume.distinct_facilities} distinct facilities — repeat filings not double-counted` : undefined}
        />
        <StatCard
          label="Institutional vs. Consumer"
          value={
            byType
              ? `${(byType as any[]).filter(t => t.label !== 'consumer_or_business_line_of_credit').reduce((s, t) => s + t.count, 0)} / ${(byType as any[]).find(t => t.label === 'consumer_or_business_line_of_credit')?.count ?? 0}`
              : '—'
          }
          sub="institutional filings / consumer HELOCs"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Filing Activity Over Time</h2>
          {mLoading ? <Skeleton className="h-48" /> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthly || []} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="period" tickFormatter={fmtMonth} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={30} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 11 }}
                  labelFormatter={fmtMonth}
                  formatter={(v: any) => [v, 'Filings']}
                />
                <Bar dataKey="count" fill="#60a5fa" radius={[2, 2, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-foreground mb-1">Top Lenders</h2>
          <p className="text-[10px] text-muted-foreground mb-3">Ranked by number of filings</p>
          <div className="space-y-2">
            {(topLenders as any[] || []).slice(0, 8).map((row, i) => (
              <div key={row.label} className="flex items-center justify-between gap-2 bg-muted/30 rounded px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}</span>
                  <span className="text-xs font-medium truncate" title={row.label}>{row.label}</span>
                </div>
                <span className="text-xs font-mono text-blue-500 shrink-0">{row.count}</span>
              </div>
            ))}
            {!topLenders && <Skeleton className="h-32" />}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Lender</label>
            <Input placeholder="e.g. City National Bank" value={draft.lender}
              onChange={e => setDraft(d => ({ ...d, lender: e.target.value }))} className="h-8 text-xs mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Borrower</label>
            <Input placeholder="e.g. Vaster Loans" value={draft.borrower}
              onChange={e => setDraft(d => ({ ...d, borrower: e.target.value }))} className="h-8 text-xs mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">From</label>
            <Input type="date" value={draft.start_date}
              onChange={e => setDraft(d => ({ ...d, start_date: e.target.value }))} className="h-8 text-xs mt-1" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">To</label>
            <Input type="date" value={draft.end_date}
              onChange={e => setDraft(d => ({ ...d, end_date: e.target.value }))} className="h-8 text-xs mt-1" />
          </div>
          <div className="flex items-end gap-2">
            <Button size="sm" onClick={apply} className="h-8 text-xs flex-1">Apply</Button>
            {hasFilters && <Button size="sm" variant="ghost" onClick={clear} className="h-8 text-xs">Clear</Button>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => { setDraft(d => ({ ...d, facility_type: '' })); setApplied(a => ({ ...a, facility_type: '' })); setPage(1); }}
            className={`h-7 px-2.5 rounded-full border text-[11px] font-medium transition-colors ${!applied.facility_type ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'}`}
          >All Types</button>
          {Object.entries(FACILITY_TYPE_META).map(([key, meta]) => (
            <button
              key={key}
              onClick={() => { setDraft(d => ({ ...d, facility_type: key })); setApplied(a => ({ ...a, facility_type: key })); setPage(1); }}
              className={`h-7 px-2.5 rounded-full border text-[11px] font-medium transition-colors ${applied.facility_type === key ? meta.color + ' border-current' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'}`}
            >{meta.label}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                <th className="px-3 py-2.5 text-left font-medium">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">Lender</th>
                <th className="px-3 py-2.5 text-left font-medium">Borrower</th>
                <th className="px-3 py-2.5 text-left font-medium">Type</th>
                <th className="px-3 py-2.5 text-left font-medium">Agreement Date</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 text-left font-medium">Confidence</th>
                <th className="px-2 py-2.5 w-8"></th>
                <th className="px-3 py-2.5 text-center font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(10).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any) => (
                    <Fragment key={r.cfn}>
                      <tr className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2 font-mono text-primary/80 text-[11px] whitespace-nowrap">{r.cfn}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        <td className="px-3 py-2 max-w-[160px] truncate font-medium text-foreground" title={r.facility_lender_name}>{r.facility_lender_name || '—'}</td>
                        <td className="px-3 py-2 max-w-[160px] truncate font-medium text-foreground" title={r.facility_borrower_name}>{r.facility_borrower_name || '—'}</td>
                        <td className="px-3 py-2"><FacilityTypeBadge type={r.facility_type} /></td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.facility_agreement_date || '—'}</td>
                        <td className="px-3 py-2 text-right font-mono">{fmtMoney(r.facility_amount)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.facility_confidence || '—'}</td>
                        <td className="px-2 py-2 text-center">
                          <button onClick={() => setExpandedCfn(c => c === r.cfn ? null : r.cfn)} className="text-muted-foreground/50 hover:text-foreground">
                            {expandedCfn === r.cfn ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <a
                            href={`https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${r.rec_book}&sBookType=O+&sPage=${r.rec_page}`}
                            target="_blank" rel="noopener noreferrer"
                            className="text-muted-foreground/30 hover:text-primary transition-colors"
                            title="View on county portal"
                          >
                            <ExternalLink size={11} />
                          </a>
                        </td>
                      </tr>
                      {expandedCfn === r.cfn && (
                        <tr className="border-b border-border/50 bg-muted/10">
                          <td colSpan={10} className="px-3 py-3">
                            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1">Evidence quote</div>
                            <p className="text-xs text-foreground/90 italic max-w-3xl">"{r.facility_evidence_quote || 'No quote captured.'}"</p>
                            {r.facility_agreement_name && (
                              <p className="text-[11px] text-muted-foreground mt-2">Agreement: {r.facility_agreement_name}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">No matching filings found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">Page {page} of {data.pages} · {data.total.toLocaleString()} total</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(1)} className="h-7 px-2 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-7 w-7 p-0"><ChevronLeft size={14} /></Button>
              <span className="text-xs text-muted-foreground px-2">{page} / {data.pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="h-7 w-7 p-0"><ChevronRight size={14} /></Button>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(data.pages)} className="h-7 px-2 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
