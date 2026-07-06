import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  LayoutList, Search, X, ChevronLeft, ChevronRight,
  CheckCircle, Clock, ExternalLink, Download,
  BarChart2, TrendingUp, TrendingDown, Users, PieChart,
  ArrowUpRight, ChevronDown, ChevronUp, Crosshair,
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

function docUrl(book: string, page: string) {
  return `https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${book}&sBookType=O+&sPage=${page}`;
}

const GARBAGE_RE = /[¢£€§©®™°±×÷\u0080-\uFFFF]/;
const ADDRESS_RE = /^\d+\s.*(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|HWY|CIR|TER|STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|HIGHWAY|CIRCLE|TERRACE)\b/i;

function cleanField(v: string | null | undefined, isAddress = false): string | null {
  if (!v || v.trim().length < 3) return null;
  const ratio = (v.match(GARBAGE_RE) || []).length / v.length;
  if (ratio > 0.06) return null;
  if (!isAddress && ADDRESS_RE.test(v.trim())) return null;
  return v.trim();
}

function deriveClassification(row: any): string {
  if (row.classification) return row.classification;
  if (row.txn_type === 'MERS_RELEASE') return 'WarehouseRelease';
  if (['MARKET_TRANSFER', 'ORIGINATION', 'INSTITUTIONAL_OUT'].includes(row.txn_type)) return 'LoanSale';
  return 'NeedsReview';
}

const CLASS_STYLE: Record<string, string> = {
  LoanSale:         'bg-emerald-100 text-emerald-700 border-emerald-200',
  WarehouseRelease: 'bg-blue-100 text-blue-700 border-blue-200',
  NeedsReview:      'bg-amber-100 text-amber-700 border-amber-200',
};

const TYPE_COLOR: Record<string, string> = {
  BANK:           'text-blue-600',
  SERVICER:       'text-purple-600',
  PRIVATE_CREDIT: 'text-orange-600',
  GSE:            'text-emerald-600',
  TRUST:          'text-slate-500',
  MERS:           'text-yellow-600',
  OTHER:          'text-muted-foreground',
};

const CHART_OPTIONS = [
  { id: 'monthly',     label: 'Monthly Volume', icon: BarChart2 },
  { id: 'top_buyers',  label: 'Top Buyers',     icon: TrendingDown },
  { id: 'top_sellers', label: 'Top Sellers',    icon: TrendingUp },
  { id: 'txn_type',    label: 'Txn Types',      icon: PieChart },
  { id: 'entity_type', label: 'Entity Types',   icon: Users },
];

const COLORS = ['#f97316','#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#ec4899'];

// ── Dynamic chart ─────────────────────────────────────────────────────────────
function DynamicChart({ startDate, endDate, targetsOnly }: { startDate: string; endDate: string; targetsOnly: boolean }) {
  const [chartType, setChartType] = useState('monthly');
  const dateQ = [startDate && `start_date=${startDate}`, endDate && `end_date=${endDate}`, targetsOnly && 'targets=1'].filter(Boolean).join('&');
  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/chart', chartType, dateQ],
    queryFn: () => apiRequest('GET', `/api/reporting/chart?type=${chartType}${dateQ ? '&' + dateQ : ''}`).then(r => r.json()),
  });

  const isPie = ['txn_type', 'entity_type'].includes(chartType);
  const isHoriz = ['top_buyers', 'top_sellers'].includes(chartType);

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold">Analytics</h2>
        <div className="flex flex-wrap gap-1">
          {CHART_OPTIONS.map(opt => {
            const Icon = opt.icon;
            const active = chartType === opt.id;
            return (
              <button key={opt.id} onClick={() => setChartType(opt.id)}
                className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                <Icon size={10} />{opt.label}
              </button>
            );
          })}
        </div>
      </div>
      {isLoading ? <Skeleton className="h-56 w-full" /> : isPie ? (
        <ResponsiveContainer width="100%" height={230}>
          <RechartsPie>
            <Pie data={data || []} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={80}
              label={({ label, percent }) => `${label} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
              {(data || []).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
            <Tooltip formatter={(v: any) => v.toLocaleString()} />
          </RechartsPie>
        </ResponsiveContainer>
      ) : isHoriz ? (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={(data || []).slice(0, 15)} layout="vertical" margin={{ top: 0, right: 40, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
            <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={150} />
            <Tooltip formatter={(v: any) => v.toLocaleString()} />
            <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={18}>
              {(data || []).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
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

// ── Participant stats ─────────────────────────────────────────────────────────
function ParticipantStats({ startDate, endDate, targetsOnly }: { startDate: string; endDate: string; targetsOnly: boolean }) {
  const [tab, setTab] = useState<'sellers' | 'buyers' | 'active'>('active');
  const dateQ = [startDate && `start_date=${startDate}`, endDate && `end_date=${endDate}`, targetsOnly && 'targets=1'].filter(Boolean).join('&');
  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/participants', dateQ],
    queryFn: () => apiRequest('GET', `/api/reporting/participants${dateQ ? '?' + dateQ : ''}`).then(r => r.json()),
  });

  const rows: any[] = tab === 'sellers' ? (data?.topSellers || [])
    : tab === 'buyers' ? (data?.topBuyers || [])
    : (data?.mostActive || []);

  const maxVal = Math.max(...rows.map((r: any) => tab === 'sellers' ? r.transfers_out : tab === 'buyers' ? r.transfers_in : r.total), 1);

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold">Participant Activity</h2>
        <div className="flex gap-1">
          {([['active', 'Most Active'], ['sellers', 'Top Senders'], ['buyers', 'Top Receivers']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`text-[11px] font-medium px-2 py-1 rounded border transition-colors ${tab === key ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? <Skeleton className="h-48 w-full" /> : (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {rows.map((r: any, i: number) => {
            const val = tab === 'sellers' ? r.transfers_out : tab === 'buyers' ? r.transfers_in : r.total;
            const pct = Math.round((val / maxVal) * 100);
            const color = TYPE_COLOR[r.entity_type] || 'text-muted-foreground';
            return (
              <div key={r.entity} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px] font-medium truncate" title={r.entity}>{r.entity}</span>
                    {r.entity_type && <span className={`text-[9px] font-semibold shrink-0 ${color}`}>{r.entity_type}</span>}
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 text-[10px]">
                  <span className="font-mono font-semibold text-foreground">{val.toLocaleString()}</span>
                  {tab === 'active' && (
                    <div className="text-muted-foreground/60">
                      ↑{r.transfers_in?.toLocaleString()} ↓{r.transfers_out?.toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <p className="text-xs text-muted-foreground">No data.</p>}
        </div>
      )}
    </div>
  );
}

// ── Expanded row detail ───────────────────────────────────────────────────────
function RowDetail({ row, onClose }: { row: any; onClose: () => void }) {
  return (
    <tr className="bg-muted/10 border-b border-border/30">
      <td colSpan={12} className="px-4 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-3 text-xs">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Document</p>
            {cleanField(row.doc_title) && <p className="font-medium uppercase">"{cleanField(row.doc_title)}"</p>}
            <p><span className="text-muted-foreground">Type:</span> {row.doc_type || '—'}</p>
            <p><span className="text-muted-foreground">Category:</span> {row.doc_category || '—'}</p>
            <p><span className="text-muted-foreground">County:</span> Miami-Dade</p>
            <p><span className="text-muted-foreground">Book/Page:</span> <span className="font-mono">{row.rec_book}/{row.rec_page}</span></p>
            <a href={docUrl(row.rec_book, row.rec_page)} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline mt-1">
              <ArrowUpRight size={10} />View on Clerk portal
            </a>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Parties (as written in PDF)</p>
            {cleanField(row.pdf_assignor) && <p><span className="text-muted-foreground">Assignor:</span> {cleanField(row.pdf_assignor)}</p>}
            {cleanField(row.assignor_parent) && <p><span className="text-muted-foreground">Assignor parent:</span> <span className="text-amber-500">{cleanField(row.assignor_parent)}</span></p>}
            {cleanField(row.pdf_assignee) && <p><span className="text-muted-foreground">Assignee:</span> {cleanField(row.pdf_assignee)}</p>}
            {cleanField(row.assignee_parent) && <p><span className="text-muted-foreground">Beneficial owner:</span> <span className="text-amber-500">{cleanField(row.assignee_parent)}</span></p>}
            {cleanField(row.signatory_officer) && <p><span className="text-muted-foreground">Signed by:</span> {cleanField(row.signatory_officer)}</p>}
            {!cleanField(row.pdf_assignor) && !cleanField(row.pdf_assignee) && (
              <p className="text-muted-foreground/40 italic text-[10px]">PDF text too noisy to extract reliably</p>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Financials & Property</p>
            {fmtAmt(row.loan_amount) && <p><span className="text-muted-foreground">Loan amount:</span> <span className="text-emerald-500 font-mono">{fmtAmt(row.loan_amount)}</span></p>}
            {fmtAmt(row.consideration_amount) && <p><span className="text-muted-foreground">Consideration:</span> <span className="text-emerald-400/80 font-mono">{fmtAmt(row.consideration_amount)}</span></p>}
            {cleanField(row.property_address, true) && <p><span className="text-muted-foreground">Property:</span> {cleanField(row.property_address, true)}</p>}
            {cleanField(row.folio_parcel) && <p><span className="text-muted-foreground">Folio/Parcel:</span> <span className="font-mono">{cleanField(row.folio_parcel)}</span></p>}
            {cleanField(row.sponsor_address, true) && <p><span className="text-muted-foreground">Sponsor address:</span> {cleanField(row.sponsor_address, true)}</p>}
          </div>
        </div>
        {row.reviewed_at && (
          <p className="mt-3 text-[10px] text-muted-foreground border-t border-border/30 pt-2">
            Reviewed by <span className="text-foreground">{row.reviewed_by}</span> · {new Date(row.reviewed_at).toLocaleString()}
          </p>
        )}
        <button onClick={onClose} className="mt-2 text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronUp size={10} />Collapse
        </button>
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
// Query params arrive in window.location.search (the hash router moves them
// there on navigate), e.g. Targets tab links to /reporting?targets=1.
function initialParams() {
  return new URLSearchParams(window.location.search);
}

export default function Reporting() {
  const qc = useQueryClient();
  const [params] = useState(initialParams);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState(() => params.get('search') || '');
  const [applied, setApplied]     = useState(() => params.get('search') || '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [reviewed, setReviewed]   = useState('');
  const [targetsOnly, setTargetsOnly] = useState(() => params.get('targets') === '1');
  const [expanded, setExpanded]   = useState<string | null>(null);

  const { data: targets } = useQuery({
    queryKey: ['/api/targets'],
    queryFn: () => apiRequest('GET', '/api/targets').then(r => r.json()),
  });
  const targetCount = (targets || []).length;

  const targetsQ = targetsOnly ? '&targets=1' : '';
  const qs = `?page=${page}&limit=50&search=${encodeURIComponent(applied)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}${targetsQ}`;
  const exportQs = `?search=${encodeURIComponent(applied)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}${targetsQ}`;

  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting', qs],
    queryFn: () => apiRequest('GET', `/api/reporting${qs}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });

  const reviewMutation = useMutation({
    mutationFn: (cfn: string) => apiRequest('PATCH', `/api/reporting/${cfn}/review`, { reviewed_by: 'user' }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });
  const unreviewMutation = useMutation({
    mutationFn: (cfn: string) => apiRequest('DELETE', `/api/reporting/${cfn}/review`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });

  const applySearch = () => { setApplied(search); setPage(1); };
  const clearAll    = () => { setSearch(''); setApplied(''); setStartDate(''); setEndDate(''); setReviewed(''); setTargetsOnly(false); setPage(1); };
  const hasFilters  = applied || startDate || endDate || reviewed || targetsOnly;

  const handleExport = () => {
    window.location.href = `/api/reporting/export${exportQs}`;
  };

  return (
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <LayoutList size={15} className="text-primary" />
            <h1 className="text-lg font-semibold">Reporting</h1>
            {data && <span className="text-xs text-muted-foreground ml-1">{data.total.toLocaleString()} records · Miami-Dade County</span>}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={handleExport} className="h-8 gap-1.5 text-xs">
          <Download size={12} />Export CSV
        </Button>
      </div>

      {/* Charts + Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DynamicChart startDate={startDate} endDate={endDate} targetsOnly={targetsOnly} />
        <ParticipantStats startDate={startDate} endDate={endDate} targetsOnly={targetsOnly} />
      </div>

      {/* Filters */}
      <div className="bg-card border border-border rounded-lg p-3 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="lg:col-span-2">
            <Input placeholder="Search CFN, assignor, or assignee…" value={search}
              onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && applySearch()}
              className="h-7 text-xs" />
          </div>
          <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-7 text-xs" />
          <Input type="date" value={endDate}   onChange={e => setEndDate(e.target.value)}   className="h-7 text-xs" />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">Review:</span>
          {[['', 'All'], ['no', 'Pending'], ['yes', 'Reviewed']].map(([val, label]) => (
            <button key={val} onClick={() => { setReviewed(val); setPage(1); }}
              className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors ${reviewed === val ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground ml-2">Scope:</span>
          <button onClick={() => { setTargetsOnly(v => !v); setPage(1); }}
            title={targetCount === 0 ? 'No targets yet — add participants in the Targets tab' : `Filter to your ${targetCount} targeted participant${targetCount === 1 ? '' : 's'}`}
            className={`h-6 px-2 rounded-full border text-[10px] font-medium transition-colors inline-flex items-center gap-1 ${targetsOnly ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
            <Crosshair size={9} />Targets only{targetCount > 0 && ` (${targetCount})`}
          </button>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" onClick={applySearch} className="h-7 text-xs gap-1"><Search size={11} />Search</Button>
            {hasFilters && <Button size="sm" variant="ghost" onClick={clearAll} className="h-7 text-xs gap-1 text-muted-foreground"><X size={11} />Clear</Button>}
          </div>
        </div>
      </div>

      {/* Spreadsheet table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">CFN</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Date</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Assignor</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Type</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Assignee</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Type</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Property</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Folio</th>
                <th className="px-2 py-2 text-right font-semibold border-r border-border/40 whitespace-nowrap">Loan Amt</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Signatory</th>
                <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap">Class.</th>
                <th className="px-2 py-2 text-center font-semibold whitespace-nowrap">✓</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(20).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/30">
                      {Array(12).fill(0).map((_, j) => <td key={j} className="px-2 py-1.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).flatMap((r: any, i: number) => {
                    const isExp = expanded === r.cfn;
                    const cls = deriveClassification(r);
                    const loanAmt = fmtAmt(r.loan_amount) || fmtAmt(r.consideration_amount);
                    const signatory = cleanField(r.signatory_officer);
                    const folio = cleanField(r.folio_parcel);
                    const property = cleanField(r.property_address, true);
                    return [
                      <tr key={`${r.cfn}-${i}`}
                        onClick={() => setExpanded(isExp ? null : r.cfn)}
                        className={`border-b border-border/30 cursor-pointer hover:bg-muted/30 transition-colors ${isExp ? 'bg-primary/5' : i % 2 === 0 ? 'bg-background' : 'bg-muted/10'}`}>
                        {/* CFN */}
                        <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {isExp ? <ChevronUp size={9} className="text-primary shrink-0" /> : <ChevronDown size={9} className="text-muted-foreground/40 shrink-0" />}
                            <a href={docUrl(r.rec_book, r.rec_page)} target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="font-mono text-primary/80 hover:underline flex items-center gap-0.5">
                              {r.cfn}<ExternalLink size={8} className="opacity-40" />
                            </a>
                          </div>
                        </td>
                        {/* Date */}
                        <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        {/* Assignor */}
                        <td className="px-2 py-1.5 border-r border-border/20 max-w-[150px]">
                          <div className="font-medium truncate" title={r.assignor_canon}>{r.assignor_canon}</div>
                          {cleanField(r.assignor_parent) && <div className="text-[9px] text-amber-500 truncate">↳ {cleanField(r.assignor_parent)}</div>}
                        </td>
                        {/* Assignor type */}
                        <td className={`px-2 py-1.5 border-r border-border/20 whitespace-nowrap text-[9px] font-semibold ${TYPE_COLOR[r.assignor_type] || 'text-muted-foreground'}`}>
                          {r.assignor_type || '—'}
                        </td>
                        {/* Assignee */}
                        <td className="px-2 py-1.5 border-r border-border/20 max-w-[150px]">
                          <div className="font-medium truncate" title={r.assignee_canon}>{r.assignee_canon}</div>
                          {cleanField(r.assignee_parent) && <div className="text-[9px] text-amber-500 truncate">↳ {cleanField(r.assignee_parent)}</div>}
                        </td>
                        {/* Assignee type */}
                        <td className={`px-2 py-1.5 border-r border-border/20 whitespace-nowrap text-[9px] font-semibold ${TYPE_COLOR[r.assignee_type] || 'text-muted-foreground'}`}>
                          {r.assignee_type || '—'}
                        </td>
                        {/* Property */}
                        <td className="px-2 py-1.5 border-r border-border/20 max-w-[140px]">
                          {property ? <span className="truncate block text-muted-foreground" title={property}>{property}</span> : <span className="text-muted-foreground/25">—</span>}
                        </td>
                        {/* Folio */}
                        <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap font-mono text-muted-foreground">
                          {folio || <span className="text-muted-foreground/25">—</span>}
                        </td>
                        {/* Loan amount */}
                        <td className="px-2 py-1.5 border-r border-border/20 text-right whitespace-nowrap font-mono">
                          {loanAmt ? <span className="text-emerald-500">{loanAmt}</span> : <span className="text-muted-foreground/25">—</span>}
                        </td>
                        {/* Signatory */}
                        <td className="px-2 py-1.5 border-r border-border/20 max-w-[130px]">
                          {signatory ? <span className="truncate block text-muted-foreground" title={signatory}>{signatory}</span> : <span className="text-muted-foreground/25">—</span>}
                        </td>
                        {/* Classification */}
                        <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap">
                          <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold ${CLASS_STYLE[cls] || 'bg-muted border-border text-muted-foreground'}`}>{cls}</span>
                        </td>
                        {/* Review */}
                        <td className="px-2 py-1.5 text-center whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          {r.reviewed_at ? (
                            <button onClick={() => unreviewMutation.mutate(r.cfn)} title="Mark unreviewed"
                              className="text-emerald-500 hover:text-red-400 transition-colors"><CheckCircle size={12} /></button>
                          ) : (
                            <button onClick={() => reviewMutation.mutate(r.cfn)} title="Mark reviewed"
                              className="text-muted-foreground/30 hover:text-primary transition-colors"><Clock size={12} /></button>
                          )}
                        </td>
                      </tr>,
                      isExp && <RowDetail key={`detail-${r.cfn}`} row={r} onClose={() => setExpanded(null)} />,
                    ].filter(Boolean);
                  })
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-muted-foreground text-xs">No records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/10">
            <span className="text-xs text-muted-foreground">
              {((page - 1) * 50) + 1}–{Math.min(page * 50, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(1)} className="h-6 px-1.5 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-6 w-6 p-0"><ChevronLeft size={12} /></Button>
              <span className="text-xs text-muted-foreground px-1.5">{page}/{data.pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="h-6 w-6 p-0"><ChevronRight size={12} /></Button>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(data.pages)} className="h-6 px-1.5 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
