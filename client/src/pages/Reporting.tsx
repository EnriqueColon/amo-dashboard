import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  LayoutList, Search, X, ChevronLeft, ChevronRight,
  CheckCircle, Clock, ArrowUpRight, ExternalLink,
  BarChart2, TrendingUp, TrendingDown, Users, PieChart,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, PieChart as RechartsPie, Pie, Legend,
} from 'recharts';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(v: number | null | undefined): string | null {
  if (!v || !isFinite(v) || v <= 0) return null;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function docImageUrl(book: string, page: string) {
  return `https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${book}&sBookType=O+&sPage=${page}`;
}

// Auto-derive classification from txn_type when not manually set
function deriveClassification(row: any): string {
  if (row.classification) return row.classification;
  if (row.txn_type === 'MERS_RELEASE') return 'WarehouseRelease';
  if (['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT'].includes(row.txn_type)) return 'LoanSale';
  return 'NeedsReview';
}

const CLASS_STYLE: Record<string, string> = {
  LoanSale:        'bg-emerald-100 text-emerald-700 border-emerald-300',
  WarehouseRelease:'bg-blue-100 text-blue-700 border-blue-300',
  NeedsReview:     'bg-amber-100 text-amber-700 border-amber-300',
};

const CHART_OPTIONS = [
  { id: 'monthly',     label: 'Monthly Volume',     icon: BarChart2 },
  { id: 'top_buyers',  label: 'Top Buyers',         icon: TrendingDown },
  { id: 'top_sellers', label: 'Top Sellers',        icon: TrendingUp },
  { id: 'txn_type',    label: 'Transaction Types',  icon: PieChart },
  { id: 'entity_type', label: 'Buyer Entity Types', icon: Users },
];

const CHART_COLORS = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4'];

// ── Dynamic Chart ─────────────────────────────────────────────────────────────
function DynamicChart({ startDate, endDate }: { startDate: string; endDate: string }) {
  const [chartType, setChartType] = useState('monthly');

  const dateParams = startDate && endDate
    ? `start_date=${startDate}&end_date=${endDate}`
    : startDate ? `start_date=${startDate}` : endDate ? `end_date=${endDate}` : '';

  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/chart', chartType, dateParams],
    queryFn: () => apiRequest('GET', `/api/reporting/chart?type=${chartType}${dateParams ? '&' + dateParams : ''}`).then(r => r.json()),
  });

  const isHorizontal = ['top_buyers', 'top_sellers'].includes(chartType);
  const isPie = ['txn_type', 'entity_type'].includes(chartType);

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-4">
      {/* Chart type switcher */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-foreground">Analytics</h2>
        <div className="flex flex-wrap gap-1">
          {CHART_OPTIONS.map(opt => {
            const Icon = opt.icon;
            const active = chartType === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setChartType(opt.id)}
                className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md border transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
                }`}
              >
                <Icon size={11} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chart */}
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isPie ? (
        <ResponsiveContainer width="100%" height={260}>
          <RechartsPie>
            <Pie
              data={data || []}
              dataKey="count"
              nameKey="label"
              cx="50%"
              cy="50%"
              outerRadius={90}
              label={({ label, percent }) => `${label} ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {(data || []).map((_: any, i: number) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
            <Tooltip formatter={(v: any) => v.toLocaleString()} />
          </RechartsPie>
        </ResponsiveContainer>
      ) : isHorizontal ? (
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={(data || []).slice(0, 15)}
            layout="vertical"
            margin={{ top: 4, right: 40, left: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
            <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
              tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 10 }} tickLine={false}
              axisLine={false} width={140} />
            <Tooltip formatter={(v: any) => v.toLocaleString()} />
            <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={20}>
              {(data || []).map((_: any, i: number) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
            <XAxis dataKey="period" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={36}
              tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
            <Tooltip
              formatter={(v: any, name: string) => [v.toLocaleString(), name === 'count' ? 'Transfers' : name]}
            />
            <Bar dataKey="count" fill="#f97316" radius={[3, 3, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Record row ────────────────────────────────────────────────────────────────
function RecordRow({ row, onReview, onUnreview }: {
  row: any;
  onReview: (cfn: string) => void;
  onUnreview: (cfn: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cls = deriveClassification(row);
  const isReviewed = !!row.reviewed_at;
  const loanAmt = fmtAmt(row.loan_amount) || fmtAmt(row.consideration_amount);

  return (
    <>
      <tr
        className={`border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer ${expanded ? 'bg-muted/10' : ''}`}
        onClick={() => setExpanded(e => !e)}
      >
        {/* CFN */}
        <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap">
          <a
            href={docImageUrl(row.rec_book, row.rec_page)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline flex items-center gap-1"
            onClick={e => e.stopPropagation()}
          >
            {row.cfn}
            <ExternalLink size={9} className="opacity-50" />
          </a>
        </td>
        {/* Date */}
        <td className="px-3 py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">{row.rec_date}</td>
        {/* Assignor */}
        <td className="px-3 py-2.5 max-w-[160px]">
          <div className="text-xs font-semibold truncate" title={row.assignor_canon}>{row.assignor_canon}</div>
          {row.assignor_parent && (
            <div className="text-[10px] text-amber-400 truncate">↳ {row.assignor_parent}</div>
          )}
        </td>
        {/* Assignee */}
        <td className="px-3 py-2.5 max-w-[160px]">
          <div className="text-xs font-semibold truncate" title={row.assignee_canon}>{row.assignee_canon}</div>
          {row.assignee_parent && (
            <div className="text-[10px] text-amber-400 truncate">↳ {row.assignee_parent}</div>
          )}
        </td>
        {/* Property */}
        <td className="px-3 py-2.5 max-w-[160px] text-[11px] text-muted-foreground">
          {row.property_address
            ? <span className="truncate block" title={row.property_address}>{row.property_address}</span>
            : <span className="text-muted-foreground/30">—</span>}
        </td>
        {/* Loan amount */}
        <td className="px-3 py-2.5 text-right font-mono text-[11px] whitespace-nowrap">
          {loanAmt
            ? <span className="text-emerald-400">{loanAmt}</span>
            : <span className="text-muted-foreground/30">—</span>}
        </td>
        {/* Classification */}
        <td className="px-3 py-2.5 whitespace-nowrap">
          <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${CLASS_STYLE[cls] || 'bg-muted text-muted-foreground border-border'}`}>
            {cls}
          </span>
        </td>
        {/* Reviewed */}
        <td className="px-3 py-2.5 text-center whitespace-nowrap">
          {isReviewed ? (
            <button
              title={`Reviewed by ${row.reviewed_by} at ${row.reviewed_at}`}
              onClick={e => { e.stopPropagation(); onUnreview(row.cfn); }}
              className="inline-flex items-center gap-1 text-[10px] text-emerald-500 hover:text-red-400 transition-colors"
            >
              <CheckCircle size={11} />
              <span className="hidden sm:inline">Done</span>
            </button>
          ) : (
            <button
              onClick={e => { e.stopPropagation(); onReview(row.cfn); }}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-primary transition-colors"
            >
              <Clock size={11} />
              <span className="hidden sm:inline">Review</span>
            </button>
          )}
        </td>
      </tr>

      {/* Expanded detail */}
      {expanded && (
        <tr className="bg-muted/10 border-b border-border/30">
          <td colSpan={8} className="px-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3 text-xs">

              {/* Document info */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Document</p>
                {row.doc_title && <p className="font-medium uppercase text-foreground">"{row.doc_title}"</p>}
                <p><span className="text-muted-foreground">Type:</span> {row.doc_type || '—'}</p>
                <p><span className="text-muted-foreground">Category:</span> {row.doc_category || '—'}</p>
                <p><span className="text-muted-foreground">County:</span> Miami-Dade</p>
                <p><span className="text-muted-foreground">Book/Page:</span> <span className="font-mono">{row.rec_book}/{row.rec_page}</span></p>
              </div>

              {/* Parties */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Parties (as written in PDF)</p>
                {row.pdf_assignor && <p><span className="text-muted-foreground">Assignor:</span> {row.pdf_assignor}</p>}
                {row.assignor_parent && <p><span className="text-muted-foreground">Assignor sponsor:</span> <span className="text-amber-400">{row.assignor_parent}</span></p>}
                {row.pdf_assignee && <p><span className="text-muted-foreground">Assignee:</span> {row.pdf_assignee}</p>}
                {row.assignee_parent && <p><span className="text-muted-foreground">Beneficial owner/sponsor:</span> <span className="text-amber-400">{row.assignee_parent}</span></p>}
              </div>

              {/* Financials + links */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Financials & Links</p>
                {fmtAmt(row.loan_amount) && <p><span className="text-muted-foreground">Loan amount:</span> <span className="text-emerald-400 font-mono">{fmtAmt(row.loan_amount)}</span></p>}
                {fmtAmt(row.consideration_amount) && <p><span className="text-muted-foreground">Consideration:</span> <span className="text-emerald-400/80 font-mono">{fmtAmt(row.consideration_amount)}</span></p>}
                {row.property_address && <p><span className="text-muted-foreground">Property:</span> {row.property_address}</p>}
                <a
                  href={docImageUrl(row.rec_book, row.rec_page)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline mt-1"
                >
                  <ArrowUpRight size={11} />
                  View on Miami-Dade Clerk portal
                </a>
              </div>
            </div>

            {/* Review status */}
            {row.reviewed_at && (
              <p className="mt-3 text-[10px] text-muted-foreground border-t border-border/30 pt-2">
                Reviewed by <span className="text-foreground">{row.reviewed_by}</span> on {new Date(row.reviewed_at).toLocaleString()}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Reporting() {
  const qc = useQueryClient();
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [appliedSearch, setApplied] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [reviewed, setReviewed]   = useState('');

  const qs = `?page=${page}&limit=50&search=${encodeURIComponent(appliedSearch)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}`;

  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting', qs],
    queryFn: () => apiRequest('GET', `/api/reporting${qs}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });

  const reviewMutation = useMutation({
    mutationFn: (cfn: string) =>
      apiRequest('PATCH', `/api/reporting/${cfn}/review`, { reviewed_by: 'user' }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });

  const unreviewMutation = useMutation({
    mutationFn: (cfn: string) =>
      apiRequest('DELETE', `/api/reporting/${cfn}/review`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });

  const apply = () => { setApplied(search); setPage(1); };
  const clear  = () => { setSearch(''); setApplied(''); setStartDate(''); setEndDate(''); setReviewed(''); setPage(1); };
  const hasFilters = appliedSearch || startDate || endDate || reviewed;

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <LayoutList size={16} className="text-primary" />
            <h1 className="text-xl font-semibold">Reporting</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data
              ? `${data.total.toLocaleString()} loan transfer records · Miami-Dade County`
              : 'Loading…'}
          </p>
        </div>
      </div>

      {/* Dynamic chart */}
      <DynamicChart startDate={startDate} endDate={endDate} />

      {/* Filters */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="lg:col-span-2 flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Search (CFN, assignor, assignee)</label>
            <Input
              placeholder="e.g. WELLS FARGO or 2026R..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && apply()}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date From</label>
            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date To</label>
            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-8 text-sm" />
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-muted-foreground">Review status:</span>
          {[['', 'All'], ['no', 'Needs Review'], ['yes', 'Reviewed']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => { setReviewed(val); setPage(1); }}
              className={`h-7 px-2.5 rounded-full border text-[11px] font-medium transition-colors ${reviewed === val ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
            >{label}</button>
          ))}
          <div className="flex gap-2 ml-auto">
            <Button size="sm" onClick={apply} className="h-8"><Search size={13} className="mr-1.5" />Search</Button>
            {hasFilters && <Button size="sm" variant="ghost" onClick={clear} className="h-8 text-muted-foreground"><X size={13} className="mr-1.5" />Clear</Button>}
          </div>
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
                <th className="px-3 py-2.5 text-left font-medium">Assignor (Seller)</th>
                <th className="px-3 py-2.5 text-left font-medium">Assignee (Buyer)</th>
                <th className="px-3 py-2.5 text-left font-medium">Property</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 text-left font-medium">Classification</th>
                <th className="px-3 py-2.5 text-center font-medium">Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(15).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(8).fill(0).map((_, j) => <td key={j} className="px-3 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any, i: number) => (
                    <RecordRow
                      key={`${r.cfn}-${i}`}
                      row={r}
                      onReview={cfn => reviewMutation.mutate(cfn)}
                      onUnreview={cfn => unreviewMutation.mutate(cfn)}
                    />
                  ))
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={8} className="px-3 py-12 text-center text-muted-foreground">No records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Showing {((page - 1) * 50) + 1}–{Math.min(page * 50, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
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
