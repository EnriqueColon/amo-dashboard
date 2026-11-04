import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import DocLink from '@/components/DocLink';
import { DefTerm } from '@/components/DefTerm';
import { useCounty, countyLabel, type CountyScope } from '@/lib/county';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  LayoutList, Search, X, ChevronLeft, ChevronRight,
  CheckCircle, Clock, ExternalLink, Download,
  BarChart2, TrendingUp, TrendingDown, Users, PieChart,
  ArrowUpRight, ChevronDown, ChevronUp, Crosshair, Printer, Table2, Gavel, Star, Plus,
} from 'lucide-react';
import EntityDetailPanel from '@/components/EntityDetailPanel';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, PieChart as RechartsPie, Pie, Legend,
} from 'recharts';
import { EntityPicker, EntityReport } from '@/components/EntityReport';
import CrossCountyNote from '@/components/CrossCountyNote';
import { CountyCell } from '@/components/CountyCell';
import { FilterHint } from '@/components/FilterHint';
import {
  CATEGORY_DEFS, DOC_TYPE_DEFS, REVIEW_DEFS, DIRECTION_DEFS,
  CHART_VIEW_DEFS, PARTICIPANT_VIEW_DEFS,
} from '@/lib/filterDefinitions';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(v: number | null | undefined): string | null {
  if (!v || !isFinite(v) || v <= 0) return null;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Document links are per-county — see client/src/lib/doc-url.ts. Use <DocLink>.

const GARBAGE_RE = /[¢£€§©®™°±×÷\u0080-\uFFFF]/;
const ADDRESS_RE = /^\d+\s.*(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|HWY|CIR|TER|STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|HIGHWAY|CIRCLE|TERRACE)\b/i;

function cleanField(v: string | null | undefined, isAddress = false): string | null {
  if (!v || v.trim().length < 3) return null;
  const ratio = (v.match(GARBAGE_RE) || []).length / v.length;
  if (ratio > 0.06) return null;
  if (!isAddress && ADDRESS_RE.test(v.trim())) return null;
  return v.trim();
}

// What KIND of transaction this is. Only meaningful for loan transfers, and
// until 2026-09-14 that was a safe assumption because the table held nothing
// else — every row was a loan transfer by construction.
//
// Adding the Shows filter broke it. A collateral assignment has a txn_type like
// NON_INSTITUTIONAL or INTO_INSTITUTION, which this function happily rendered as "LoanSale":
// CFN 2026R626049 is an ASSIGNMENT OF RENTS, categorised COLLATERAL, and the
// column read LoanSale. 13,721 collateral rows carry txn_type NON_INSTITUTIONAL and 3,399
// INTO_INSTITUTION, so the label was wrong on every one of them.
//
// A row that is not a loan transfer now says what it actually is. txn_type is
// still computed for these rows and still visible in its own column — this only
// stops a loan-sale verdict being asserted about a document that never was one.
const NON_LOAN_LABEL: Record<string, string> = {
  COLLATERAL:   'Collateral',
  RENTS_LEASES: 'Rents & leases',
  OTHER:        'Other',
};

function deriveClassification(row: any): string {
  // A human's manual review always wins, whatever the document is.
  if (row.classification) return row.classification;
  const nonLoan = NON_LOAN_LABEL[row.doc_category];
  if (nonLoan) return nonLoan;
  if (row.txn_type === 'MERS_RELEASE') return 'WarehouseRelease';
  if (['MARKET_TRANSFER', 'INTO_INSTITUTION', 'OUT_OF_INSTITUTION'].includes(row.txn_type)) return 'LoanSale';
  return 'NeedsReview';
}

const CLASS_STYLE: Record<string, string> = {
  LoanSale:         'bg-emerald-100 text-emerald-700 border-emerald-200',
  WarehouseRelease: 'bg-blue-100 text-blue-700 border-blue-200',
  NeedsReview:      'bg-amber-100 text-amber-700 border-amber-200',
  // Neutral on purpose. These are statements of fact about the document, not
  // review verdicts, and colouring them like verdicts would imply a judgement
  // nobody made.
  'Collateral':     'bg-slate-100 text-slate-600 border-slate-200',
  'Rents & leases': 'bg-slate-100 text-slate-600 border-slate-200',
  'Other':          'bg-slate-100 text-slate-600 border-slate-200',
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

// Keys are the server's (DOC_TYPE_FILTERS in server/routes.ts), which owns the
// counties' exact strings. Labels carry the county's own code in parentheses,
// because that is what a reader sees on the filing itself and in the table's
// own Type column.
const DOC_TYPE_OPTIONS: [string, string][] = [
  ['',    'All'],
  ['amo', 'Mortgage (AMO)'],
  ['asg', 'Generic (ASG)'],
  ['ast', 'Broward (AST)'],
  ['hc_asg', 'Hillsborough (ASG)'],
];

// What the document turned out to BE once its PDF was read — as opposed to the
// type above, which is what the county filed it under. Default is loan
// transfers, which is what this tab has always shown; the rest are opt-in.
// Keys match CATEGORY_FILTERS on the server.
const CATEGORY_OPTIONS: [string, string][] = [
  ['',           'Loan transfers'],
  ['collateral', 'Collateral'],
  ['rents',      'Rents & leases'],
  ['other',      'Other'],
  ['all',        'All documents'],
];

// ── Dynamic chart ─────────────────────────────────────────────────────────────
function DynamicChart({ startDate, endDate, targetsOnly, docType, category }: { startDate: string; endDate: string; targetsOnly: boolean; docType: string; category: string }) {
  const [chartType, setChartType] = useState('monthly');
  const dateQ = [startDate && `start_date=${startDate}`, endDate && `end_date=${endDate}`, targetsOnly && 'targets=1', docType && `doc_type=${docType}`, category && `category=${category}`].filter(Boolean).join('&');
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
              <FilterHint key={opt.id} def={CHART_VIEW_DEFS[opt.id]}>
                <button onClick={() => setChartType(opt.id)}
                  className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                  <Icon size={10} />{opt.label}
                </button>
              </FilterHint>
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
function ParticipantStats({ startDate, endDate, targetsOnly, docType, category }: { startDate: string; endDate: string; targetsOnly: boolean; docType: string; category: string }) {
  const [tab, setTab] = useState<'sellers' | 'buyers' | 'active'>('active');
  const dateQ = [startDate && `start_date=${startDate}`, endDate && `end_date=${endDate}`, targetsOnly && 'targets=1', docType && `doc_type=${docType}`, category && `category=${category}`].filter(Boolean).join('&');
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
            <CrossCountyNote className="ml-2" />
        <div className="flex gap-1">
          {([['active', 'Most Active'], ['sellers', 'Top Senders'], ['buyers', 'Top Receivers']] as const).map(([key, label]) => (
            <FilterHint key={key} def={PARTICIPANT_VIEW_DEFS[key]}>
              <button onClick={() => setTab(key)}
                className={`text-[11px] font-medium px-2 py-1 rounded border transition-colors ${tab === key ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            </FilterHint>
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
      <td colSpan={13} className="px-4 py-4">
        <RowDetailBody row={row} />
        <button onClick={onClose} className="mt-2 text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronUp size={10} />Collapse
        </button>
      </td>
    </tr>
  );
}

// The expanded detail, shared by the table row and the feed card.
function RowDetailBody({ row }: { row: any }) {
  return (
    <>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-3 text-xs">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Document</p>
            {cleanField(row.doc_title) && <p className="font-medium uppercase">"{cleanField(row.doc_title)}"</p>}
            <p><span className="text-muted-foreground">Type:</span> {row.doc_type || '—'}</p>
            <p><span className="text-muted-foreground">Category:</span> {row.doc_category || '—'}</p>
            <p><span className="text-muted-foreground">County:</span> {countyLabel((row.county || 'MIAMI-DADE') as CountyScope)}</p>
            <p><span className="text-muted-foreground">Book/Page:</span> <span className="font-mono">{row.rec_book}/{row.rec_page}</span></p>
            <DocLink row={row} className="inline-flex items-center gap-1 text-primary hover:underline mt-1">
              <ArrowUpRight size={10} />View on Clerk portal
            </DocLink>
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
    </>
  );
}

// ── Activity feed (open testing, 4 Nov 2026) ─────────────────────────────────
// The same page of rows as the table, drawn as social-media-style cards. Plan:
// docs/REPORTING_FEED_PLAN.md. Filings on one page with the same assignor,
// assignee and recording date fold into one card so bulk servicing batches
// don't flood the feed.
const TYPE_LABEL: Record<string, string> = {
  BANK: 'Bank', SERVICER: 'Servicer', PRIVATE_CREDIT: 'Private credit',
  GSE: 'GSE', TRUST: 'Trust', MERS: 'MERS', OTHER: 'Other',
};
const AVATAR_STYLE: Record<string, string> = {
  BANK:           'bg-blue-100 text-blue-700',
  SERVICER:       'bg-purple-100 text-purple-700',
  PRIVATE_CREDIT: 'bg-orange-100 text-orange-700',
  GSE:            'bg-emerald-100 text-emerald-700',
  TRUST:          'bg-slate-100 text-slate-600',
  MERS:           'bg-yellow-100 text-yellow-700',
};
const NOUN_BY_CLASS: Record<string, [string, string]> = {
  'Collateral':     ['a collateral assignment', 'collateral assignments'],
  'Rents & leases': ['an assignment of rents', 'assignments of rents'],
  'Other':          ['a document', 'documents'],
};

function initials(name: string): string {
  const words = (name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}

function fmtFeedDate(d: string | null | undefined): string {
  if (!d) return '';
  const dt = new Date(`${d.slice(0, 10)}T12:00:00`);
  if (isNaN(dt.getTime())) return d;
  const days = Math.round((Date.now() - dt.getTime()) / 86_400_000);
  const nice = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days <= 0) return `${nice} · today`;
  if (days === 1) return `${nice} · yesterday`;
  if (days < 30) return `${nice} · ${days} days ago`;
  return nice;
}

function groupRows(rows: any[]): any[][] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.assignor_canon}|${r.assignee_canon}|${r.rec_date}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return Array.from(groups.values());
}

function EntityName({ name, onOpen }: { name: string; onOpen: (n: string) => void }) {
  if (!name) return <span className="text-muted-foreground">Unknown party</span>;
  return (
    <button onClick={() => onOpen(name)} title={`Open ${name}'s profile`}
      className="font-semibold text-foreground hover:text-primary hover:underline underline-offset-2 text-left">
      {name}
    </button>
  );
}

function ReviewButton({ row, onReview, onUnreview }: { row: any; onReview: (c: string) => void; onUnreview: (c: string) => void }) {
  return row.reviewed_at ? (
    <button onClick={() => onUnreview(row.cfn)} title="Mark unreviewed"
      className="inline-flex items-center gap-1 text-emerald-600 hover:text-red-500 transition-colors">
      <CheckCircle size={12} />Reviewed
    </button>
  ) : (
    <button onClick={() => onReview(row.cfn)} title="Mark reviewed"
      className="inline-flex items-center gap-1 hover:text-primary transition-colors">
      <Clock size={12} />Mark reviewed
    </button>
  );
}

function FeedCard({ group, foreclosures, onOpenEntity, onReview, onUnreview }: {
  group: any[];
  foreclosures?: any[];
  onOpenEntity: (n: string) => void;
  onReview: (c: string) => void;
  onUnreview: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const r = group[0];
  const many = group.length > 1;
  const cls = deriveClassification(r);
  const [one, plural] = NOUN_BY_CLASS[cls] || ['a mortgage', 'mortgages'];
  const amountOf = (x: any) => (x.loan_amount > 0 ? x.loan_amount : x.consideration_amount > 0 ? x.consideration_amount : 0);
  const total = group.reduce((s, x) => s + (amountOf(x) || 0), 0);
  const unreviewed = group.filter(x => !x.reviewed_at);
  const property = cleanField(r.property_address, true);
  const folio = cleanField(r.folio_parcel);
  const signatory = cleanField(r.signatory_officer);
  const assignorParent = cleanField(r.assignor_parent);
  const assigneeParent = cleanField(r.assignee_parent);

  return (
    <article className="bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/30 transition-colors">
      <div className="flex gap-3">
        <button onClick={() => onOpenEntity(r.assignor_canon)} title={`Open ${r.assignor_canon}'s profile`}
          className={`w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold ${AVATAR_STYLE[r.assignor_type] || 'bg-muted text-muted-foreground'}`}>
          {initials(r.assignor_canon)}
        </button>
        <div className="flex-1 min-w-0">
          {/* Headline: who did what to whom */}
          <p className="text-sm leading-snug">
            <EntityName name={r.assignor_canon} onOpen={onOpenEntity} />
            <span className="text-muted-foreground"> assigned {many ? `${group.length} ${plural}` : one} to </span>
            <EntityName name={r.assignee_canon} onOpen={onOpenEntity} />
          </p>
          {(assignorParent || assigneeParent) && (
            <p className="text-[11px] text-amber-600 mt-0.5 truncate">
              {assignorParent && <>↳ <button className="hover:underline" onClick={() => onOpenEntity(assignorParent)}>{assignorParent}</button></>}
              {assignorParent && assigneeParent && <span className="text-muted-foreground"> · </span>}
              {assigneeParent && <>owner: <button className="hover:underline" onClick={() => onOpenEntity(assigneeParent)}>{assigneeParent}</button></>}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 flex-wrap">
            <span className={TYPE_COLOR[r.assignor_type]}>{TYPE_LABEL[r.assignor_type] || r.assignor_type || '—'}</span>
            <span>→</span>
            <span className={TYPE_COLOR[r.assignee_type]}>{TYPE_LABEL[r.assignee_type] || r.assignee_type || '—'}</span>
            <span>·</span><CountyCell county={r.county} />
            <span>·</span><span>{fmtFeedDate(r.rec_date)}</span>
            {!many && <><span>·</span>
              <DocLink row={r} className="font-mono text-primary/80 hover:underline inline-flex items-center gap-0.5">
                {r.cfn}<ExternalLink size={8} className="opacity-50" />
              </DocLink></>}
          </p>

          {/* Property / amount panel */}
          {(!many && (property || folio || signatory || total > 0)) || (many && total > 0) ? (
            <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2 flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs">
                {many ? (
                  <p className="text-muted-foreground">Combined amount of {group.length} filings</p>
                ) : (
                  <>
                    {property ? <p className="font-medium truncate" title={property}>{property}</p>
                      : <p className="text-muted-foreground italic">Property address not read</p>}
                    <p className="text-[11px] text-muted-foreground truncate">
                      {folio && <>Folio <span className="font-mono">{folio}</span></>}
                      {folio && signatory && ' · '}
                      {signatory && <>Signed by {signatory}</>}
                    </p>
                  </>
                )}
              </div>
              {total > 0 && <p className="text-lg font-semibold text-emerald-600 tabular-nums shrink-0">{fmtAmt(total)}</p>}
            </div>
          ) : null}

          {foreclosures && foreclosures.length > 0 && <ForeclosureFlag hits={foreclosures} assignee={r.assignee_canon} onOpenEntity={onOpenEntity} />}

          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${CLASS_STYLE[cls] || 'bg-muted border-border text-muted-foreground'}`}>{cls}</span>
            {r.doc_type && <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{r.doc_type}</span>}
          </div>

          {/* Action bar */}
          <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-4 text-[11px] text-muted-foreground">
            {many ? (
              unreviewed.length > 0 ? (
                <button onClick={() => unreviewed.forEach(x => onReview(x.cfn))}
                  className="inline-flex items-center gap-1 hover:text-primary transition-colors">
                  <Clock size={12} />Mark all reviewed ({unreviewed.length})
                </button>
              ) : <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle size={12} />All reviewed</span>
            ) : (
              <ReviewButton row={r} onReview={onReview} onUnreview={onUnreview} />
            )}
            {!many && (
              <DocLink row={r} className="inline-flex items-center gap-1 hover:text-primary transition-colors">
                <ArrowUpRight size={12} />Document
              </DocLink>
            )}
            <button onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 hover:text-primary transition-colors">
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {many ? (open ? 'Hide filings' : `Show ${group.length} filings`) : (open ? 'Hide details' : 'Details')}
            </button>
          </div>

          {open && (
            <div className="mt-2 pt-2 border-t border-border/60">
              {many ? (
                <ul className="divide-y divide-border/50 text-xs">
                  {group.map(x => {
                    const p = cleanField(x.property_address, true);
                    const amt = fmtAmt(amountOf(x));
                    return (
                      <li key={x.cfn} className="py-1.5 flex items-center gap-3">
                        <DocLink row={x} className="font-mono text-primary/80 hover:underline inline-flex items-center gap-0.5 shrink-0">
                          {x.cfn}<ExternalLink size={8} className="opacity-50" />
                        </DocLink>
                        <span className="truncate flex-1 text-muted-foreground" title={p || ''}>{p || '—'}</span>
                        {amt && <span className="font-mono text-emerald-600 shrink-0">{amt}</span>}
                        <span className="text-[11px] text-muted-foreground shrink-0">
                          <ReviewButton row={x} onReview={onReview} onUnreview={onUnreview} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <RowDetailBody row={r} />
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

// ── Foreclosure complaints in the feed ───────────────────────────────────────
// Labels match the Complaints tab's result chip (pages/Complaints.tsx).
function complaintResult(c: any): [string, string] {
  if (c.status === 'complaint_not_public') return ['No public complaint', 'bg-muted text-muted-foreground'];
  if (c.is_foreclosure === false) return ['Not a mortgage foreclosure', 'bg-muted text-muted-foreground'];
  if (c.verdict === 'qualifies') return ['Qualifies', 'bg-green-500/15 text-green-700'];
  if (c.verdict === 'unclear') return ['Cannot tell', 'bg-amber-500/15 text-amber-700'];
  if (c.verdict === 'no') return ['Does not qualify', 'bg-muted text-foreground/70'];
  return ['Waiting to be read', 'bg-muted text-muted-foreground'];
}

function ForeclosureFlag({ hits, assignee, onOpenEntity }: { hits: any[]; assignee?: string; onOpenEntity: (n: string) => void }) {
  const n = (x: string) => (x || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\bU S\b/g, 'US');
  const sameFirm = (h: any) => !!assignee && !!h.plaintiff && (n(h.plaintiff) === n(assignee) || n(h.plaintiff).startsWith(n(assignee) + ' '));
  return (
    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      {hits.map(h => (
        <p key={h.case_id} className="flex items-center gap-1.5 flex-wrap">
          <Gavel size={12} className="shrink-0" />
          <span className="font-semibold">Foreclosure filed</span>
          <span>on this property {h.filing_date}</span>
          {h.plaintiff && <>by {h.plaintiff_entity
            ? <button onClick={() => onOpenEntity(h.plaintiff_entity)} className="font-medium hover:underline">{h.plaintiff_entity}</button>
            : <span className="font-medium">{h.plaintiff}</span>}</>}
          <span className="font-mono">· {h.case_number}</span>
          {h.principal > 0 && <span>· {fmtAmt(h.principal)} unpaid</span>}
          {sameFirm(h) && <span className="font-medium">· the firm that received this assignment is foreclosing</span>}
          <a href="#/complaints" className="underline">Open in Complaints</a>
        </p>
      ))}
      <p className="text-[10px] text-red-700/80 mt-0.5">Matched on the property address (same street address and unit), not a verified link to this loan.</p>
    </div>
  );
}

function ComplaintCard({ c, onOpenEntity }: { c: any; onOpenEntity: (n: string) => void }) {
  const [open, setOpen] = useState(false);
  const [label, cls] = complaintResult(c);
  const defendants: string[] = (c.defendants || []).map((d: any) => (typeof d === 'string' ? d : d?.name)).filter(Boolean);
  const matches: any[] = c.aom_matches || [];
  return (
    <article className="bg-card border border-red-200/70 rounded-xl px-4 py-3 hover:border-red-300 transition-colors">
      <div className="flex gap-3">
        <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center bg-red-100 text-red-700" title="Foreclosure complaint">
          <Gavel size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug">
            {c.plaintiff_entity
              ? <EntityName name={c.plaintiff_entity} onOpen={onOpenEntity} />
              : <span className="font-semibold">{c.plaintiff || 'Plaintiff not read yet'}</span>}
            <span className="text-muted-foreground"> filed a foreclosure complaint</span>
            {defendants.length > 0 && <>
              <span className="text-muted-foreground"> against </span>
              <span className="font-medium">{defendants[0]}</span>
              {defendants.length > 1 && <span className="text-muted-foreground"> and {defendants.length - 1} more</span>}
            </>}
          </p>
          {c.plaintiff_entity && c.plaintiff && (
            <p className="text-[11px] text-muted-foreground truncate" title={c.plaintiff}>As filed: {c.plaintiff}</p>
          )}
          <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 flex-wrap">
            <span className="text-red-700">Foreclosure complaint</span>
            {c.case_type && <><span>·</span><span>{String(c.case_type).replace(/^RPMF-/, '')}</span></>}
            <span>·</span><CountyCell county={c.county} />
            <span>·</span><span>{fmtFeedDate(c.filing_date)}</span>
            <span>·</span><span className="font-mono">{c.case_number}</span>
          </p>

          <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2 flex items-center justify-between gap-3">
            <div className="min-w-0 text-xs">
              {c.address ? <p className="font-medium truncate" title={c.address}>{c.address}</p>
                : <p className="text-muted-foreground italic">Property address not read</p>}
              {c.default_date && <p className="text-[11px] text-muted-foreground">In default since {c.default_date}</p>}
            </div>
            {c.principal > 0 && (
              <div className="text-right shrink-0">
                <p className="text-lg font-semibold text-red-700 tabular-nums">{fmtAmt(c.principal)}</p>
                <p className="text-[10px] text-muted-foreground">unpaid principal</p>
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold cursor-help ${cls}`} title={c.result_reason || ''}>{label}</span>
            {c.aom_match_count > 0 && (
              <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {c.aom_match_count} earlier assignment{c.aom_match_count === 1 ? '' : 's'} of this property
              </span>
            )}
          </div>

          <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-4 text-[11px] text-muted-foreground">
            {c.pdf_url && (
              <a href={c.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary transition-colors">
                <ArrowUpRight size={12} />Complaint PDF
              </a>
            )}
            <a href="#/complaints" className="inline-flex items-center gap-1 hover:text-primary transition-colors">
              <Gavel size={12} />Open in Complaints
            </a>
            <button onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 hover:text-primary transition-colors">
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{open ? 'Hide details' : 'Details'}
            </button>
          </div>

          {open && (
            <div className="mt-2 pt-2 border-t border-border/60 text-xs space-y-2">
              {c.result_reason && <p className="text-muted-foreground">{c.result_reason}</p>}
              {defendants.length > 1 && <p><span className="text-muted-foreground">Defendants:</span> {defendants.join('; ')}</p>}
              {matches.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Earlier assignments of this property (address match)</p>
                  <ul className="divide-y divide-border/50">
                    {matches.map(m => (
                      <li key={m.cfn} className="py-1 flex items-center gap-2">
                        <span className="text-muted-foreground shrink-0 w-[70px]">{m.rec_date}</span>
                        <span className="truncate flex-1">
                          <button className="hover:underline" onClick={() => onOpenEntity(m.assignor_canon)}>{m.assignor_canon}</button>
                          <span className="text-muted-foreground"> → </span>
                          <button className="hover:underline font-medium" onClick={() => onOpenEntity(m.assignee_canon)}>{m.assignee_canon}</button>
                          {m.same_firm && <span className="ml-1 text-red-700" title="The firm that received this assignment is the one foreclosing">· same firm is foreclosing</span>}
                        </span>
                        <DocLink row={m} className="font-mono text-primary/70 hover:underline shrink-0">{m.cfn}</DocLink>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function dedupeCases(hits: any[]): any[] {
  const m = new Map<string, any>();
  for (const h of hits) m.set(h.case_id, h);
  return [...m.values()];
}

const COMPLAINTS_KEY = 'reporting:feed-complaints';

// ── Pagination shared by the table and feed cards ──────────────────────────
function Pager({ page, setPage, data }: { page: number; setPage: (f: (p: number) => number) => void; data: any }) {
  if (!data || data.pages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/10 print:hidden">
      <span className="text-xs text-muted-foreground">
        {((page - 1) * 50) + 1}–{Math.min(page * 50, data.total)} of {data.total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(() => 1)} className="h-6 px-1.5 text-xs">First</Button>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-6 w-6 p-0"><ChevronLeft size={12} /></Button>
        <span className="text-xs text-muted-foreground px-1.5">{page}/{data.pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="h-6 w-6 p-0"><ChevronRight size={12} /></Button>
        <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(() => data.pages)} className="h-6 px-1.5 text-xs">Last</Button>
      </div>
    </div>
  );
}

function useReviewMutations() {
  const qc = useQueryClient();
  const review = useMutation({
    mutationFn: (cfn: string) => apiRequest('PATCH', `/api/reporting/${cfn}/review`, { reviewed_by: 'user' }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });
  const unreview = useMutation({
    mutationFn: (cfn: string) => apiRequest('DELETE', `/api/reporting/${cfn}/review`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/reporting'] }),
  });
  return { reviewMutation: review, unreviewMutation: unreview };
}

// ── Feed streams (open testing) ──────────────────────────────────────────────
// Social layout (owner, 4 Nov 2026): the feed is the middle column, loaded 50
// at a time as you scroll. Each loaded page n also asks for the complaints
// filed in [oldest date on page n, oldest date on page n-1), so every complaint
// appears exactly once, next to the assignments of its dates.
const minRecDate = (rs: any[]) => rs.reduce((m: string, r: any) => (!m || (r.rec_date && r.rec_date < m) ? r.rec_date : m), '');

function useEndless(onReach: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) onReach(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onReach, enabled]);
  return ref;
}

function FeedStream({ filterQs, includeComplaints, onOpenEntity }: {
  filterQs: string;
  includeComplaints: boolean;
  onOpenEntity: (n: string) => void;
}) {
  const { reviewMutation, unreviewMutation } = useReviewMutations();
  const q = useInfiniteQuery({
    queryKey: ['/api/reporting', 'stream', filterQs],
    queryFn: ({ pageParam }) => apiRequest('GET', `/api/reporting?page=${pageParam}&limit=50${filterQs}`).then(r => r.json()),
    initialPageParam: 1,
    getNextPageParam: (last: any) => (last.page < last.pages ? last.page + 1 : undefined),
  });
  const pages: any[] = q.data?.pages || [];
  const fp = new URLSearchParams(filterQs);

  const complaintQueries = useQueries({
    queries: pages.map((pg, i) => {
      const cq = new URLSearchParams();
      const from = pg.page < pg.pages ? minRecDate(pg.rows) : '';
      const toBefore = i > 0 ? minRecDate(pages[i - 1].rows) : '';
      if (from) cq.set('from', from);
      if (toBefore) cq.set('to_before', toBefore);
      for (const k of ['search', 'start_date', 'end_date', 'targets']) if (fp.get(k)) cq.set(k, fp.get(k)!);
      if (fp.get('min_amount')) cq.set('min_principal', fp.get('min_amount')!);
      fp.getAll('entities').forEach(e => cq.append('entities', e));
      cq.set('cfns', (pg.rows || []).map((r: any) => r.cfn).join(','));
      return {
        queryKey: ['/api/reporting/feed-complaints', cq.toString()],
        queryFn: () => apiRequest('GET', `/api/reporting/feed-complaints?${cq.toString()}`).then(r => r.json()),
        staleTime: 60_000,
      };
    }),
  });

  const cfnMatches: Record<string, any[]> = {};
  const seenCase = new Set<string>();
  const complaints: any[] = [];
  for (const cqr of complaintQueries) {
    Object.assign(cfnMatches, cqr.data?.cfn_matches || {});
    if (includeComplaints) for (const c of cqr.data?.complaints || []) {
      if (!seenCase.has(c.case_id)) { seenCase.add(c.case_id); complaints.push(c); }
    }
  }
  const rows = pages.flatMap(p => p.rows || []);
  const items = [
    ...groupRows(rows).map(g => ({ kind: 'aom' as const, date: String(g[0].rec_date || ''), key: g[0].cfn, g })),
    ...complaints.map(c => ({ kind: 'complaint' as const, date: String(c.filing_date || ''), key: `c-${c.case_id}`, c })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const more = useCallback(() => { if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage(); }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);
  const sentinel = useEndless(more, !!q.hasNextPage);

  if (q.isLoading) return <div className="space-y-2.5">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>;
  if (!items.length) return <p className="px-4 py-10 text-center text-muted-foreground text-xs bg-card border border-border rounded-xl">Nothing here under the current filters.</p>;
  const total = pages[0]?.total ?? 0;
  return (
    <div className="space-y-2.5">
      {items.map(it => it.kind === 'complaint'
        ? <ComplaintCard key={it.key} c={it.c} onOpenEntity={onOpenEntity} />
        : <FeedCard key={it.key} group={it.g}
            foreclosures={dedupeCases(it.g.flatMap((r: any) => cfnMatches[r.cfn] || []))}
            onOpenEntity={onOpenEntity}
            onReview={c => reviewMutation.mutate(c)}
            onUnreview={c => unreviewMutation.mutate(c)} />)}
      <div ref={sentinel} />
      <p className="text-center text-[11px] text-muted-foreground py-2">
        {q.isFetchingNextPage ? 'Loading more…'
          : q.hasNextPage ? <button onClick={more} className="text-primary hover:underline">Load more</button>
          : `That's all ${total.toLocaleString()} filing${total === 1 ? '' : 's'}.`}
        {' '}<span className="opacity-70">Showing {rows.length.toLocaleString()} of {total.toLocaleString()}.</span>
      </p>
    </div>
  );
}

// Foreclosures tab: complaints only, newest first, 30 more each time you
// reach the bottom (the full list is small and comes in one request).
function ComplaintsStream({ qs, onOpenEntity }: { qs: string; onOpenEntity: (n: string) => void }) {
  const [shown, setShown] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/feed-complaints', 'all', qs],
    queryFn: () => apiRequest('GET', `/api/reporting/feed-complaints?${qs}`).then(r => r.json()),
  });
  const list: any[] = [...(data?.complaints || [])].sort((a, b) => String(b.filing_date || '').localeCompare(String(a.filing_date || '')));
  const more = useCallback(() => setShown(n => n + 30), []);
  const sentinel = useEndless(more, shown < list.length);
  if (isLoading) return <div className="space-y-2.5">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>;
  if (data && !data.active) return <p className="px-4 py-10 text-center text-muted-foreground text-xs bg-card border border-border rounded-xl">Foreclosure complaints are not collected in this database.</p>;
  if (!list.length) return <p className="px-4 py-10 text-center text-muted-foreground text-xs bg-card border border-border rounded-xl">No foreclosure complaints under the current filters.</p>;
  return (
    <div className="space-y-2.5">
      {list.slice(0, shown).map(c => <ComplaintCard key={c.case_id} c={c} onOpenEntity={onOpenEntity} />)}
      <div ref={sentinel} />
      <p className="text-center text-[11px] text-muted-foreground py-2">
        {shown < list.length ? <button onClick={more} className="text-primary hover:underline">Load more</button> : `That's all ${list.length} complaint${list.length === 1 ? '' : 's'}.`}
      </p>
    </div>
  );
}

// ── Side-column cards ─────────────────────────────────────────────────────────
function SideCard({ title, icon: Icon, children, action }: { title: string; icon: any; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold flex items-center gap-1.5"><Icon size={12} className="text-primary" />{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function FollowingCard({ targets, onOpenEntity, onShowForYou }: { targets: any[]; onOpenEntity: (n: string) => void; onShowForYou: () => void }) {
  // Busiest in the last 90 days first, then most recently active.
  const top = [...targets].sort((a, b) =>
    ((b.txns_90d ?? 0) - (a.txns_90d ?? 0)) || String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? ''))).slice(0, 8);
  return (
    <SideCard title="Following" icon={Crosshair}
      action={<a href="#/targets" className="text-[10px] text-muted-foreground hover:text-foreground">Manage</a>}>
      {top.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">You aren't following any firms yet. Use + Follow on a firm under "Firms to watch".</p>
      ) : (
        <ul className="space-y-1">
          {top.map(t => (
            <li key={t.entity} className="flex items-center justify-between gap-2 text-[11px]">
              <button onClick={() => onOpenEntity(t.entity)} className="truncate text-left hover:text-primary hover:underline" title={t.entity}>{t.entity}</button>
              <span className="text-muted-foreground shrink-0 tabular-nums" title={t.txns_90d ? 'Filings in the last 90 days' : 'Most recent filing'}>
                {t.txns_90d ? `${t.txns_90d} · 90d` : t.last_activity ? `last ${t.last_activity}` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {targets.length > 0 && (
        <button onClick={onShowForYou} className="mt-2 text-[11px] text-primary hover:underline">
          See activity from your {targets.length.toLocaleString()} target{targets.length === 1 ? '' : 's'}
        </button>
      )}
    </SideCard>
  );
}

function TrendingCard({ dateQ, onOpenEntity }: { dateQ: string; onOpenEntity: (n: string) => void }) {
  const [mode, setMode] = useState<'active' | 'buyers' | 'sellers'>('active');
  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/participants', dateQ],
    queryFn: () => apiRequest('GET', `/api/reporting/participants${dateQ ? '?' + dateQ : ''}`).then(r => r.json()),
  });
  const rows: any[] = (mode === 'sellers' ? data?.topSellers : mode === 'buyers' ? data?.topBuyers : data?.mostActive) || [];
  const val = (r: any) => (mode === 'sellers' ? r.transfers_out : mode === 'buyers' ? r.transfers_in : r.total);
  return (
    <SideCard title="Trending firms" icon={TrendingUp}>
      <div className="flex gap-1 mb-2">
        {([['active', 'Most active'], ['buyers', 'Buyers'], ['sellers', 'Sellers']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${mode === k ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>{l}</button>
        ))}
      </div>
      {isLoading ? <Skeleton className="h-28 w-full" /> : (
        <ol className="space-y-1">
          {rows.slice(0, 6).map((r, i) => (
            <li key={r.entity} className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground w-3 text-right shrink-0">{i + 1}</span>
              <button onClick={() => onOpenEntity(r.entity)} className="truncate flex-1 text-left hover:text-primary hover:underline" title={r.entity}>{r.entity}</button>
              <span className="tabular-nums font-medium shrink-0">{(val(r) ?? 0).toLocaleString()}</span>
            </li>
          ))}
          {rows.length === 0 && <li className="text-[11px] text-muted-foreground">No activity in this period.</li>}
        </ol>
      )}
    </SideCard>
  );
}

function VolumeCard({ chartQ, open, onToggle }: { chartQ: string; open: boolean; onToggle: () => void }) {
  const { data } = useQuery({
    queryKey: ['/api/reporting/chart', 'monthly', chartQ],
    queryFn: () => apiRequest('GET', `/api/reporting/chart?type=monthly${chartQ ? '&' + chartQ : ''}`).then(r => r.json()),
  });
  const rows: any[] = Array.isArray(data) ? data.slice(-12) : [];
  const max = Math.max(1, ...rows.map(r => r.count || 0));
  return (
    <SideCard title="Monthly volume" icon={BarChart2}
      action={<button onClick={onToggle} className="text-[10px] text-primary hover:underline">{open ? 'Hide charts' : 'Full charts'}</button>}>
      {rows.length ? (
        <>
          <div className="flex items-end gap-0.5 h-16">
            {rows.map(r => (
              <div key={r.period} className="flex-1 bg-primary/60 hover:bg-primary rounded-sm" style={{ height: `${Math.max(4, (r.count / max) * 100)}%` }}
                title={`${r.period}: ${Number(r.count).toLocaleString()} filings`} />
            ))}
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground mt-1"><span>{rows[0].period}</span><span>{rows[rows.length - 1].period}</span></div>
        </>
      ) : <p className="text-[11px] text-muted-foreground">No filings in this period.</p>}
    </SideCard>
  );
}

function PeriodStatsCard({ filingsQs, complaintsQs }: { filingsQs: string; complaintsQs: string }) {
  const { data: all } = useQuery({
    queryKey: ['/api/reporting', 'stats-all', filingsQs],
    queryFn: () => apiRequest('GET', `/api/reporting?page=1&limit=1${filingsQs}`).then(r => r.json()),
  });
  const pendingQs = filingsQs.replace(/&reviewed=[^&]*/, '') + '&reviewed=no';
  const { data: pending } = useQuery({
    queryKey: ['/api/reporting', 'stats-pending', pendingQs],
    queryFn: () => apiRequest('GET', `/api/reporting?page=1&limit=1${pendingQs}`).then(r => r.json()),
  });
  const { data: fc } = useQuery({
    queryKey: ['/api/reporting/feed-complaints', 'all', complaintsQs],
    queryFn: () => apiRequest('GET', `/api/reporting/feed-complaints?${complaintsQs}`).then(r => r.json()),
  });
  const big = (fc?.complaints || []).filter((c: any) => c.verdict === 'qualifies').length;
  const Row = ({ label, value, hint }: { label: string; value: any; hint: string }) => (
    <div className="flex items-center justify-between text-[11px] py-0.5" title={hint}>
      <span className="text-muted-foreground">{label}</span><span className="font-semibold tabular-nums">{value ?? '—'}</span>
    </div>
  );
  return (
    <SideCard title="This period" icon={Clock}>
      <Row label="Filings" value={all?.total?.toLocaleString()} hint="Assignments under the current filters" />
      <Row label="Not reviewed yet" value={pending?.total?.toLocaleString()} hint="Of those, filings nobody has marked reviewed" />
      {fc?.active && <Row label="Foreclosure complaints" value={fc.complaints.length.toLocaleString()} hint="Complaints filed in the period" />}
      {fc?.active && <Row label="…that qualify" value={big.toLocaleString()} hint="Unpaid principal at least $500,000 and no right-to-reinstate clause (Complaints tab rule)" />}
    </SideCard>
  );
}

function FirmsToWatchCard({ dateQ, targets, onOpenEntity }: { dateQ: string; targets: any[]; onOpenEntity: (n: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['/api/reporting/participants', dateQ],
    queryFn: () => apiRequest('GET', `/api/reporting/participants${dateQ ? '?' + dateQ : ''}`).then(r => r.json()),
  });
  const following = new Set(targets.map(t => String(t.entity).toUpperCase()));
  const picks = ((data?.mostActive || []) as any[]).filter(r => !following.has(String(r.entity).toUpperCase())).slice(0, 4);
  const follow = useMutation({
    mutationFn: (entity: string) => apiRequest('POST', '/api/targets', { entity }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/targets'] }),
  });
  if (!picks.length) return null;
  return (
    <SideCard title="Firms to watch" icon={Star}>
      <p className="text-[10px] text-muted-foreground mb-1.5">Busy this period and not on your targets yet.</p>
      <ul className="space-y-1">
        {picks.map(r => (
          <li key={r.entity} className="flex items-center justify-between gap-2 text-[11px]">
            <button onClick={() => onOpenEntity(r.entity)} className="truncate text-left hover:text-primary hover:underline" title={r.entity}>{r.entity}</button>
            <button onClick={() => follow.mutate(r.entity)} disabled={follow.isPending}
              className="shrink-0 inline-flex items-center gap-0.5 text-primary hover:underline" title="Add to your Targets">
              <Plus size={10} />Follow
            </button>
          </li>
        ))}
      </ul>
    </SideCard>
  );
}

const FEED_TABS = [
  ['foryou', 'For you'],
  ['all', 'All activity'],
  ['foreclosures', 'Foreclosures'],
  ['big', 'Big tickets'],
  ['table', 'Table'],
] as const;
type FeedTab = typeof FEED_TABS[number][0];
const TAB_KEY = 'reporting:tab';
const BIG_TICKET = 5_000_000;

// ── Filing table (one instance per selected entity when 2+ are chosen) ───────
// filterQs carries all active filters (search, dates, review, targets, entity)
// as pre-encoded query fragments. Page + expanded-row state live here so each
// table paginates independently; parents remount via `key` to reset on filter
// changes.
function TransactionsTable({ title, filterQs, exportQs }: {
  title?: string;
  filterQs: string;
  exportQs?: string;
}) {
  const [page, setPageState]    = useState(1);
  const setPage = (f: (p: number) => number) => setPageState(f);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { reviewMutation, unreviewMutation } = useReviewMutations();

  const qs = `?page=${page}&limit=50${filterQs}`;
  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting', qs],
    queryFn: () => apiRequest('GET', `/api/reporting${qs}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden break-inside-avoid">
      <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 border-b border-border bg-muted/20">
        <h3 className="text-xs font-semibold flex items-center gap-1.5">
          {title ? <><Crosshair size={11} className="text-primary" />{title}</> : <><Table2 size={11} className="text-primary" />Assignments activity</>}
          {data && <span className="font-normal text-muted-foreground ml-1">{data.total.toLocaleString()} transaction{data.total === 1 ? '' : 's'}</span>}
        </h3>
        {exportQs && (
          <button
            onClick={() => { window.location.href = `/api/reporting/export${exportQs}`; }}
            className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors print:hidden">
            <Download size={10} />CSV
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-muted/40 border-b border-border text-muted-foreground">
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:CFN">CFN</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Date">Date</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:County">County</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Assignor">Assignor</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Type">Type</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Assignee">Assignee</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Type">Type</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Property">Property</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Folio">Folio</DefTerm></th>
              <th className="px-2 py-2 text-right font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Loan Amt">Loan Amt</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Signatory">Signatory</DefTerm></th>
              <th className="px-2 py-2 text-left font-semibold border-r border-border/40 whitespace-nowrap"><DefTerm term="reporting:Class.">Class.</DefTerm></th>
              <th className="px-2 py-2 text-center font-semibold whitespace-nowrap"><DefTerm term="reporting:✓">✓</DefTerm></th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? Array(10).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array(13).fill(0).map((_, j) => <td key={j} className="px-2 py-1.5"><Skeleton className="h-3 w-full" /></td>)}
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
                          <DocLink row={r}
                            onClick={e => e.stopPropagation()}
                            className="font-mono text-primary/80 hover:underline flex items-center gap-0.5">
                            {r.cfn}<ExternalLink size={8} className="opacity-40" />
                          </DocLink>
                        </div>
                      </td>
                      {/* Date */}
                      <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>

                      {/* County */}
                      <td className="px-2 py-1.5 border-r border-border/20 whitespace-nowrap"><CountyCell county={r.county} /></td>
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
              <tr><td colSpan={13} className="px-4 py-10 text-center text-muted-foreground text-xs">No records found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager page={page} setPage={setPage} data={data} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
// Query params arrive in window.location.search (the hash router moves them
// there on navigate), e.g. Targets tab links to /reporting?targets=1.
function initialParams() {
  return new URLSearchParams(window.location.search);
}

const DATE_PRESETS: Array<[string, number | 'ytd' | null]> = [
  ['30d', 30], ['90d', 90], ['YTD', 'ytd'], ['12m', 365], ['All', null],
];

function presetRange(preset: number | 'ytd' | null): { start: string; end: string } {
  if (preset === null) return { start: '', end: '' };
  const today = new Date().toISOString().slice(0, 10);
  if (preset === 'ytd') return { start: `${today.slice(0, 4)}-01-01`, end: today };
  const d = new Date();
  d.setDate(d.getDate() - preset);
  return { start: d.toISOString().slice(0, 10), end: today };
}

export default function Reporting() {
  const { county } = useCounty();
  const [params] = useState(initialParams);
  const [search, setSearch]       = useState(() => params.get('search') || '');
  const [applied, setApplied]     = useState(() => params.get('search') || '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate]     = useState('');
  const [reviewed, setReviewed]   = useState('');
  // Feed tab. "For you" = firms on the Targets list, so the old "Targets only"
  // scope is now the tab; /reporting?targets=1 (Targets page links) opens it.
  const [tab, setTabState] = useState<FeedTab>(() => {
    if (params.get('targets') === '1') return 'foryou';
    try { const t = localStorage.getItem(TAB_KEY); if (t && FEED_TABS.some(([k]) => k === t)) return t as FeedTab; } catch { /* private window */ }
    return 'all';
  });
  const setTab = (t: FeedTab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* private window */ } };
  const targetsOnly = tab === 'foryou';
  const [profile, setProfile] = useState<string | null>(null);
  const [showCharts, setShowCharts] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showComplaints, setShowComplaintsState] = useState<boolean>(() => {
    try { return localStorage.getItem(COMPLAINTS_KEY) !== '0'; } catch { return true; }
  });
  const setShowComplaints = (v: boolean) => {
    setShowComplaintsState(v);
    try { localStorage.setItem(COMPLAINTS_KEY, v ? '1' : '0'); } catch { /* private window */ }
  };
  const [entities, setEntities]   = useState<string[]>([]);
  // '' = both sides; 'assignor' = filings the selection sold/assigned out;
  // 'assignee' = filings it acquired. Applies to the filing tables + CSV export.
  const [entityRole, setEntityRole] = useState('');
  // '' = every assignment type. Keys match DOC_TYPE_FILTERS on the server, which
  // owns the county's exact strings — Miami-Dade files "ASSIGNMENT OF MORTGAGE -
  // AMO" where Broward files a bare "AST", and neither belongs in the UI.
  const [docType, setDocType] = useState('');
  // '' = loan transfers, the tab's long-standing contents. Everything else
  // reads the sibling table built by normalize.py.
  const [category, setCategory] = useState('');

  const { data: targets } = useQuery({
    queryKey: ['/api/targets'],
    queryFn: () => apiRequest('GET', '/api/targets').then(r => r.json()),
  });
  const targetCount = (targets || []).length;

  const setEntitySelection = (next: string[]) => setEntities(next);

  const useMyTargets = () => {
    // Watchlist entities with recorded activity, most active first (chart stays readable)
    const active = (targets || [])
      .filter((t: any) => t.last_activity)
      .sort((a: any, b: any) => (b.total_vol ?? 0) - (a.total_vol ?? 0))
      .slice(0, 50)
      .map((t: any) => t.entity);
    setEntitySelection(active);
  };

  const targetsQ = targetsOnly ? '&targets=1' : '';
  const entitiesQ = entities.map(e => `&entities=${encodeURIComponent(e)}`).join('');
  const roleQ = entities.length > 0 && entityRole ? `&entity_role=${entityRole}` : '';
  // Shared filter fragment (no page/limit/entities) — TransactionsTable adds its own
  const docTypeQ = docType ? `&doc_type=${docType}` : '';
  const categoryQ = category ? `&category=${category}` : '';
  const filterQs = `&search=${encodeURIComponent(applied)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}${targetsQ}${docTypeQ}${categoryQ}`;
  const exportQs = `?search=${encodeURIComponent(applied)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}${targetsQ}${docTypeQ}${categoryQ}${entitiesQ}${roleQ}`;

  // Per-type counts for the pills. The server computes them BEFORE applying the
  // doc-type clause, so each pill shows what selecting it would return under the
  // other active filters instead of every unselected pill reading zero. limit=1
  // because only the counts are wanted here; the table fetches its own page.
  const { data: countsData } = useQuery({
    queryKey: ['/api/reporting/doc-type-counts', filterQs, entitiesQ, roleQ],
    queryFn: () => apiRequest('GET', `/api/reporting?page=1&limit=1${filterQs}${entitiesQ}${roleQ}`).then(r => r.json()),
  });
  const docTypeCounts = countsData?.docTypeCounts as Record<string, number> | undefined;

  const applySearch = () => setApplied(search);
  const clearAll    = () => { setSearch(''); setApplied(''); setStartDate(''); setEndDate(''); setReviewed(''); setEntities([]); setEntityRole(''); setDocType(''); setCategory(''); };
  const hasFilters  = applied || startDate || endDate || reviewed || entities.length > 0 || docType || category;

  const handleExport = () => {
    window.location.href = `/api/reporting/export-report${exportQs}`;
  };

  const handlePrint = () => window.print();

  // Complaints describe no assignment, so assignment-only filters hide them.
  const complaintsBlocked = !!(reviewed || docType || category);
  const pill = (on: boolean, dim = false) =>
    `h-6 px-2 rounded-full border text-[10px] font-medium transition-colors ${on ? 'bg-primary text-primary-foreground border-primary' : dim ? 'border-border text-muted-foreground/40 hover:text-muted-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`;
  const sideDateQ = [startDate && `start_date=${startDate}`, endDate && `end_date=${endDate}`, targetsOnly && 'targets=1', docType && `doc_type=${docType}`, category && `category=${category}`].filter(Boolean).join('&');
  const complaintsQ = new URLSearchParams();
  if (applied) complaintsQ.set('search', applied);
  if (startDate) complaintsQ.set('start_date', startDate);
  if (endDate) complaintsQ.set('end_date', endDate);
  if (targetsOnly) complaintsQ.set('targets', '1');
  entities.forEach(e => complaintsQ.append('entities', e));
  const streamQs = filterQs + entitiesQ + roleQ + (tab === 'big' ? `&min_amount=${BIG_TICKET}` : '');

  return (
    // w-full: inside the flex-column <main>, mx-auto alone sizes this to its
    // content, and a long single-line name in the feed then widens the page.
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto w-full">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2 print:hidden">
        <div className="flex items-center gap-2 flex-wrap">
          <LayoutList size={15} className="text-primary" />
          <h1 className="text-lg font-semibold">Target Reporting</h1>
          <span className="text-xs text-muted-foreground ml-1">{countyLabel(county)}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium" title="New layout we're testing. Tell us what you'd change.">Open testing</span>
        </div>
        <div className="flex gap-1.5">
          {entities.length > 0 && (
            <Button size="sm" variant="outline" onClick={handlePrint} className="h-8 gap-1.5 text-xs">
              <Printer size={12} />Print report
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleExport} className="h-8 gap-1.5 text-xs"
            title="Excel workbook: a Summary sheet for the selected entities plus the full Transaction Detail sheet">
            <Download size={12} />Download report
          </Button>
        </div>
      </div>

      {/* Social layout (owner, 4 Nov 2026): filters and followed firms on the
          left, the feed in the middle, trending firms and totals on the right.
          Below xl the right column folds into the middle; below lg everything
          stacks, filters first. */}
      <div className="grid grid-cols-1 lg:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)_270px] gap-4 items-start">

        {/* ── Left: search, filters, following ── */}
        <aside className="space-y-3 print:hidden lg:sticky lg:top-0 lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto">
          <SideCard title="Search" icon={Search}>
            <Input placeholder="Firm, CFN, case number…" value={search}
              onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && applySearch()}
              className="h-7 text-xs" />
            <div className="flex gap-1.5 mt-2">
              <Button size="sm" onClick={applySearch} className="h-6 text-[11px] gap-1 flex-1"><Search size={10} />Search</Button>
              {hasFilters && <Button size="sm" variant="ghost" onClick={clearAll} className="h-6 text-[11px] gap-1 text-muted-foreground"><X size={10} />Clear all</Button>}
            </div>
          </SideCard>

          {/* Below lg the filters and Following fold away so the feed is not
              pushed a full screen down. */}
          <button onClick={() => setFiltersOpen(o => !o)}
            className="lg:hidden w-full flex items-center justify-between bg-card border border-border rounded-xl px-3 py-2 text-xs font-semibold">
            <span className="flex items-center gap-1.5"><LayoutList size={12} className="text-primary" />Filters and following{hasFilters ? ' (on)' : ''}</span>
            {filtersOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <div className={`${filtersOpen ? 'block' : 'hidden'} lg:block space-y-3`}>
          <SideCard title="Filters" icon={LayoutList}>
            <p className="text-[10px] text-muted-foreground mb-1">Time</p>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {DATE_PRESETS.map(([label, preset]) => {
                const r = presetRange(preset);
                return (
                  <button key={label} onClick={() => { setStartDate(r.start); setEndDate(r.end); }}
                    className={pill(startDate === r.start && endDate === r.end)}>{label}</button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-1 mb-2.5">
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-6 text-[10px] px-1" aria-label="From date" />
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-6 text-[10px] px-1" aria-label="To date" />
            </div>

            <p className="text-[10px] text-muted-foreground mb-1">Show</p>
            <div className="flex flex-wrap gap-1 mb-1">
              {CATEGORY_OPTIONS.map(([val, label]) => (
                <FilterHint key={val || 'loan'} def={CATEGORY_DEFS[val]}>
                  <button onClick={() => setCategory(val)} className={pill(category === val)}>{label}</button>
                </FilterHint>
              ))}
              <button onClick={() => setShowComplaints(!showComplaints)} className={`${pill(showComplaints)} inline-flex items-center gap-1`}
                title="Mix foreclosure complaints into the feed">
                <Gavel size={9} />Complaints
              </button>
            </div>
            {showComplaints && complaintsBlocked && (
              <p className="text-[10px] text-muted-foreground mb-1">Complaints are hidden while Review, Document or a non-default Show filter is set; those only apply to assignments.</p>
            )}

            <p className="text-[10px] text-muted-foreground mb-1 mt-2">Document</p>
            <div className="flex flex-wrap gap-1 mb-2">
              {DOC_TYPE_OPTIONS.map(([val, label]) => {
                const n = docTypeCounts?.[val];
                return (
                  <FilterHint key={val} def={DOC_TYPE_DEFS[val]}
                    extra={n === undefined ? undefined : `${n.toLocaleString()} filing${n === 1 ? '' : 's'} under the current filters`}>
                    <button onClick={() => setDocType(val)} className={pill(docType === val, n === 0)}>
                      {label}{n !== undefined && <span className="ml-1 opacity-60 tabular-nums">{n.toLocaleString()}</span>}
                    </button>
                  </FilterHint>
                );
              })}
            </div>

            <p className="text-[10px] text-muted-foreground mb-1">Review</p>
            <div className="flex flex-wrap gap-1">
              {[['', 'All'], ['no', 'Pending'], ['yes', 'Reviewed']].map(([val, label]) => (
                <FilterHint key={val} def={REVIEW_DEFS[val]}>
                  <button onClick={() => setReviewed(val)} className={pill(reviewed === val)}>{label}</button>
                </FilterHint>
              ))}
            </div>
          </SideCard>

          <FollowingCard targets={targets || []} onOpenEntity={setProfile} onShowForYou={() => setTab('foryou')} />
          </div>
        </aside>

        {/* ── Middle: report builder, tabs, feed ── */}
        <section className="space-y-3 min-w-0">
          <div className="bg-card border border-border rounded-xl p-3 space-y-2 print:hidden">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <Crosshair size={12} className="text-primary" />Build a report
              </h2>
              {targetCount > 0 && (
                <button onClick={useMyTargets} className={pill(false)}>Use my Targets</button>
              )}
            </div>
            <EntityPicker selected={entities} onChange={setEntitySelection} />
            {entities.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Pick one or more firms for a focused report: KPIs, activity timeline, counterparties and a summary table. The feed, table and Excel download follow the same selection.
              </p>
            )}
            {entities.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-muted-foreground">Direction:</span>
                {([['', 'All activity'], ['assignor', 'Sold / assigned out'], ['assignee', 'Acquired']] as const).map(([val, label]) => (
                  <FilterHint key={val} def={DIRECTION_DEFS[val]}>
                    <button onClick={() => setEntityRole(val)} className={pill(entityRole === val)}>{label}</button>
                  </FilterHint>
                ))}
              </div>
            )}
          </div>

          <EntityReport entities={entities} startDate={startDate} endDate={endDate} />

          {showCharts && entities.length === 0 && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
              <DynamicChart startDate={startDate} endDate={endDate} targetsOnly={targetsOnly} docType={docType} category={category} />
              <ParticipantStats startDate={startDate} endDate={endDate} targetsOnly={targetsOnly} docType={docType} category={category} />
            </div>
          )}

          {/* Right-column cards, folded in below xl */}
          <div className="hidden sm:grid xl:hidden grid-cols-2 gap-3 print:hidden">
            <TrendingCard dateQ={sideDateQ} onOpenEntity={setProfile} />
            <PeriodStatsCard filingsQs={filterQs + entitiesQ + roleQ} complaintsQs={complaintsQ.toString()} />
          </div>

          {/* Tabs */}
          {/* overflow-y-hidden: each tab's -mb-px overlap otherwise gives the
              strip a 1px vertical scrollbar */}
          <div className="flex border-b border-border overflow-x-auto overflow-y-hidden print:hidden">
            {FEED_TABS.map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                title={key === 'foryou' ? 'Only firms on your Targets list'
                  : key === 'big' ? 'Loan amount (or unpaid principal) of $5 million or more'
                  : key === 'foreclosures' ? 'Foreclosure complaints only'
                  : key === 'table' ? 'The classic table, 50 per page' : 'Everything under the current filters'}>
                {label}
                {key === 'foryou' && targetCount > 0 && <span className="ml-1 text-muted-foreground">({targetCount})</span>}
              </button>
            ))}
          </div>

          {tab === 'table' ? (
            entities.length >= 2 ? (
              <div className="space-y-4">
                {entities.map(e => (
                  <TransactionsTable
                    key={`${e}|${filterQs}${roleQ}`}
                    title={e}
                    filterQs={`${filterQs}&entities=${encodeURIComponent(e)}${roleQ}`}
                    exportQs={`?search=${encodeURIComponent(applied)}&start_date=${startDate}&end_date=${endDate}&reviewed=${reviewed}${targetsQ}&entities=${encodeURIComponent(e)}${roleQ}`}
                  />
                ))}
              </div>
            ) : (
              <TransactionsTable key={filterQs + entitiesQ + roleQ} filterQs={filterQs + entitiesQ + roleQ} />
            )
          ) : tab === 'foreclosures' ? (
            <ComplaintsStream key={complaintsQ.toString()} qs={complaintsQ.toString()} onOpenEntity={setProfile} />
          ) : tab === 'foryou' && targetCount === 0 ? (
            <p className="px-4 py-10 text-center text-muted-foreground text-xs bg-card border border-border rounded-xl">
              "For you" shows activity from firms you follow. Follow firms from "Firms to watch" or the Targets page.
            </p>
          ) : (
            <FeedStream key={streamQs} filterQs={streamQs}
              includeComplaints={showComplaints && !complaintsBlocked}
              onOpenEntity={setProfile} />
          )}
        </section>

        {/* ── Right: trending, volume, totals, firms to watch ── */}
        <aside className="hidden xl:block space-y-3 print:hidden xl:sticky xl:top-0 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto">
          <TrendingCard dateQ={sideDateQ} onOpenEntity={setProfile} />
          <VolumeCard chartQ={sideDateQ} open={showCharts} onToggle={() => setShowCharts(v => !v)} />
          <PeriodStatsCard filingsQs={filterQs + entitiesQ + roleQ} complaintsQs={complaintsQ.toString()} />
          <FirmsToWatchCard dateQ={sideDateQ} targets={targets || []} onOpenEntity={setProfile} />
        </aside>
      </div>

      {profile && <EntityDetailPanel key={profile} entityName={profile} onClose={() => setProfile(null)} onNavigate={setProfile} />}
    </div>
  );
}
