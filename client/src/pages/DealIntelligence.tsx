import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import CategoryBadge from '@/components/CategoryBadge';
import ColHeader from '@/components/ColHeader';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, Cell, ReferenceArea,
} from 'recharts';
import {
  TrendingDown, TrendingUp, AlertTriangle, Target, Users,
  ArrowRight, ChevronLeft, ChevronRight, ExternalLink,
  Shield, Eye, Info, ChevronDown, ChevronUp,
  Building2, MapPin, FileText, Activity, Link2, Hash, BookOpen,
  HelpCircle, Calendar,
} from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────
const MONTH_LABELS: Record<string, string> = {
  '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun',
  '07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec',
};
function fmtMonth(m: string) {
  const [y, mo] = m.split('-');
  return `${MONTH_LABELS[mo]} ${y?.slice(2)}`;
}
function fmtDate(d: string) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${MONTH_LABELS[m] ?? m} ${parseInt(day, 10)}, ${y}`;
}

type DatePreset = '30d' | '90d' | '6m' | '12m' | 'ytd' | 'all' | 'custom';
interface DateRange { start: string; end: string; preset: DatePreset; }

function toISO(d: Date) { return d.toISOString().slice(0, 10); }
function getPresetDates(preset: DatePreset): { start: string; end: string } {
  const today = new Date();
  const end = toISO(today);
  if (preset === '30d')  { const s = new Date(today); s.setDate(s.getDate() - 30);  return { start: toISO(s), end }; }
  if (preset === '90d')  { const s = new Date(today); s.setDate(s.getDate() - 90);  return { start: toISO(s), end }; }
  if (preset === '6m')   { const s = new Date(today); s.setMonth(s.getMonth() - 6); return { start: toISO(s), end }; }
  if (preset === '12m')  { const s = new Date(today); s.setFullYear(s.getFullYear() - 1); return { start: toISO(s), end }; }
  if (preset === 'ytd')  { return { start: `${today.getFullYear()}-01-01`, end }; }
  return { start: '', end: '' };
}

const DATE_PRESETS: { label: string; value: DatePreset }[] = [
  { label: '30 Days', value: '30d' },
  { label: '90 Days', value: '90d' },
  { label: '6 Months', value: '6m' },
  { label: '12 Months', value: '12m' },
  { label: 'YTD', value: 'ytd' },
  { label: 'All Time', value: 'all' },
  { label: 'Custom', value: 'custom' },
];

// ── Date Range Picker ─────────────────────────────────────────────────────────
function DateRangePicker({ range, onChange }: {
  range: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const handlePreset = (preset: DatePreset) => {
    if (preset === 'all') { onChange({ start: '', end: '', preset }); return; }
    if (preset === 'custom') { onChange({ ...range, preset }); return; }
    const { start, end } = getPresetDates(preset);
    onChange({ start, end, preset });
  };
  const priorLabel = useMemo(() => {
    if (!range.start || !range.end) return null;
    const shiftYear = (iso: string) => {
      const d = new Date(iso); d.setFullYear(d.getFullYear() - 1); return toISO(d);
    };
    const priorStart = shiftYear(range.start);
    const priorEnd   = shiftYear(range.end);
    return `vs. ${fmtDate(priorStart)} – ${fmtDate(priorEnd)} (prior year)`;
  }, [range.start, range.end]);

  return (
    <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-xl px-4 py-3">
      <Calendar size={13} className="text-muted-foreground/60 shrink-0" />
      <span className="text-[11px] font-medium text-muted-foreground mr-1">Date range:</span>
      <div className="flex gap-1 flex-wrap">
        {DATE_PRESETS.map(p => (
          <button
            key={p.value}
            onClick={() => handlePreset(p.value)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
              range.preset === p.value
                ? 'bg-orange-500 text-white border-orange-500'
                : 'bg-background text-muted-foreground border-border hover:border-orange-300 hover:text-orange-600'
            }`}
          >{p.label}</button>
        ))}
      </div>
      {range.preset === 'custom' && (
        <div className="flex items-center gap-1.5 ml-1">
          <input type="date" value={range.start}
            onChange={e => onChange({ ...range, start: e.target.value })}
            className="text-[11px] border border-border rounded-md px-2 py-1 bg-background text-foreground"
          />
          <span className="text-[10px] text-muted-foreground">to</span>
          <input type="date" value={range.end}
            onChange={e => onChange({ ...range, end: e.target.value })}
            className="text-[11px] border border-border rounded-md px-2 py-1 bg-background text-foreground"
          />
        </div>
      )}
      {range.start && range.end && range.preset !== 'all' && (
        <div className="ml-auto flex flex-col items-end">
          <span className="text-[10px] font-medium text-orange-600">
            {fmtDate(range.start)} – {fmtDate(range.end)}
          </span>
          {priorLabel && (
            <span className="text-[9px] text-muted-foreground/60">{priorLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Methodology explainer blocks ──────────────────────────────────────────────
function MethodologyBox({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/60 text-[11px]">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-blue-700 font-medium"
        onClick={() => setOpen(v => !v)}
      >
        <HelpCircle size={12} className="shrink-0 text-blue-400" />
        <span>{title}</span>
        <span className="ml-auto text-blue-400">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 space-y-1.5 text-blue-800/80 leading-relaxed border-t border-blue-100">
          {children}
        </div>
      )}
    </div>
  );
}

// Inline callout used inside the deal detail panel
function ClassificationRationale({ tx }: { tx: any }) {
  const [open, setOpen] = useState(false);

  const sellerType  = tx.assignor_type ?? 'UNKNOWN';
  const buyerType   = tx.assignee_type ?? 'UNKNOWN';
  const txnType     = tx.txn_type ?? 'UNKNOWN';

  // Human-readable label for transaction type
  const TXN_LABELS: Record<string, { label: string; color: string }> = {
    MARKET_TRANSFER:   { label: 'Market Transfer',          color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
    ORIGINATION:       { label: 'Origination / Intake',     color: 'text-blue-600 bg-blue-50 border-blue-200' },
    INSTITUTIONAL_OUT: { label: 'Distressed Disposition',   color: 'text-rose-600 bg-rose-50 border-rose-200' },
    MERS_RELEASE:      { label: 'MERS Release',             color: 'text-orange-600 bg-orange-50 border-orange-200' },
    SELF_ASSIGN:       { label: 'Self-Assignment',          color: 'text-slate-500 bg-slate-50 border-slate-200' },
    PRIVATE:           { label: 'Private Transfer',         color: 'text-slate-500 bg-slate-50 border-slate-200' },
  };

  const TYPE_LABELS: Record<string, string> = {
    BANK: 'Commercial Bank', SERVICER: 'Mortgage Servicer',
    PRIVATE_CREDIT: 'Private Credit / PE Fund', GSE: 'Government Agency (GSE)',
    MERS: 'MERS Registry', TRUST: 'Securitization Trust', OTHER: 'Private / Non-institutional',
  };

  const txnMeta = TXN_LABELS[txnType] ?? { label: txnType, color: 'text-slate-500 bg-slate-50 border-slate-200' };

  const reasonLines: string[] = [];
  if (txnType === 'MARKET_TRANSFER' && sellerType === 'BANK' && buyerType === 'PRIVATE_CREDIT') {
    reasonLines.push(
      `This is a Bank → PE deal because: the seller (${tx.assignor_canon}) is classified as a commercial bank, and the buyer (${tx.assignee_canon}) is classified as a private credit / PE fund.`,
      `Transaction type MARKET_TRANSFER means both parties are institutional (bank, fund, servicer, GSE, or trust) — confirming this is a true secondary-market sale of debt, not an origination or REO disposal.`,
      `Why does this appear here? Banks rarely sell mortgage notes to PE funds unless the loan is stressed, non-performing, or the bank needs to reduce its CRE concentration and regulatory capital burden. PE funds acquire these at a discount and seek to work out or foreclose the underlying collateral.`,
    );
  } else if (txnType === 'INSTITUTIONAL_OUT') {
    reasonLines.push(
      `This is a Distressed Disposition because: ${tx.assignor_canon} is an institutional entity (${TYPE_LABELS[sellerType] ?? sellerType}), but the buyer (${tx.assignee_canon}) is a private / non-institutional party (${TYPE_LABELS[buyerType] ?? buyerType}).`,
      `Institutions (banks, servicers, funds) almost never voluntarily sell performing mortgage notes directly to private individuals or small LLCs at face value. These transfers typically represent: (1) REO (Real Estate Owned) — the bank foreclosed and is disposing of the property, (2) an NPL sale at a steep discount, or (3) a short-sale / deed-in-lieu settlement.`,
      `This signals the end of the distress cycle: the troubled asset has exited the formal financial system and entered the hands of a private buyer.`,
    );
  } else if (txnType === 'MARKET_TRANSFER') {
    reasonLines.push(
      `Transaction type MARKET_TRANSFER means both the seller (${TYPE_LABELS[sellerType] ?? sellerType}) and the buyer (${TYPE_LABELS[buyerType] ?? buyerType}) are institutional entities.`,
      `This is a true secondary-market sale where one institution transfers a mortgage note to another. Neither party is the original borrower.`,
    );
  } else if (txnType === 'ORIGINATION') {
    reasonLines.push(
      `Transaction type ORIGINATION means the seller (${TYPE_LABELS[sellerType] ?? sellerType}) is a private / non-institutional party, and the buyer (${TYPE_LABELS[buyerType] ?? buyerType}) is institutional.`,
      `This typically represents a new loan being originated — the borrower (a private party) assigns the mortgage to the lender, or a mortgage broker transfers a new loan to the final lender.`,
    );
  } else if (txnType === 'MERS_RELEASE') {
    reasonLines.push(
      `MERS (Mortgage Electronic Registration Systems) is a national registry used to avoid re-recording fees each time a mortgage is sold. This filing means MERS is stepping out of the chain and formally placing ${tx.assignee_canon} as the visible holder of record.`,
      `This is not a true ownership transfer — the underlying beneficial owner was already ${tx.assignee_canon}. This is registry housekeeping, often done before a foreclosure or loan modification.`,
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white/70 text-[11px]">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-slate-600 font-medium"
        onClick={() => setOpen(v => !v)}
      >
        <BookOpen size={11} className="shrink-0 text-slate-400" />
        <span>Why is this transaction classified this way?</span>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${txnMeta.color}`}>{txnMeta.label}</span>
          <span className="text-slate-400">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-slate-100 space-y-2">
          {/* Classification data grid */}
          <div className="grid grid-cols-3 gap-2 my-2">
            {[
              { label: 'Seller Entity Type', value: TYPE_LABELS[sellerType] ?? sellerType, mono: false },
              { label: 'Transaction Type',   value: txnMeta.label,                         mono: false },
              { label: 'Buyer Entity Type',  value: TYPE_LABELS[buyerType]  ?? buyerType,  mono: false },
            ].map(({ label, value }) => (
              <div key={label} className="bg-slate-50 rounded-md px-2.5 py-2">
                <p className="text-[9px] text-slate-400 uppercase tracking-wider mb-0.5">{label}</p>
                <p className="text-slate-700 font-semibold text-[11px]">{value}</p>
              </div>
            ))}
          </div>
          {/* Reasoning */}
          <div className="space-y-1.5 text-slate-600 leading-relaxed">
            {reasonLines.map((line, i) => (
              <p key={i} className={i === 0 ? 'font-medium text-slate-700' : 'text-slate-500'}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Net-seller pressure bar: green = net buyer, red = net seller
function PressureBar({ inbound, outbound }: { inbound: number; outbound: number }) {
  const total = Math.max(inbound + outbound, 1);
  const outPct = Math.round((outbound / total) * 100);
  const inPct  = 100 - outPct;
  const isNetSeller = outbound > inbound;
  return (
    <div className="flex items-center gap-1.5 w-full">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden flex">
        <div className="h-full bg-emerald-500/70 rounded-l-full" style={{ width: `${inPct}%` }} />
        <div className="h-full bg-red-500/70 rounded-r-full" style={{ width: `${outPct}%` }} />
      </div>
      <span className={`text-[10px] font-mono shrink-0 ${isNetSeller ? 'text-red-400' : 'text-emerald-400'}`}>
        {isNetSeller ? `−${(outbound - inbound).toLocaleString()}` : `+${(inbound - outbound).toLocaleString()}`}
      </span>
    </div>
  );
}

function DeltaPill({ current, prior }: { current: number; prior: number }) {
  const delta = current - prior;
  const pct   = prior > 0 ? Math.round((delta / prior) * 100) : null;
  if (delta === 0) return <span className="text-[9px] text-muted-foreground/50 font-mono">no change</span>;
  const pos = delta > 0;
  const color = pos ? 'text-emerald-600' : 'text-red-500';
  const DirIcon = pos ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[9px] font-semibold ${color}`}>
      <DirIcon size={9} />
      {pos ? '+' : ''}{delta.toLocaleString()}
      {pct !== null && <span className="opacity-70">({pos ? '+' : ''}{pct}%)</span>}
    </span>
  );
}

function KpiCard({ label, value, sub, icon: Icon, accent, tooltip, priorValue }: {
  label: string; value: any; sub?: string;
  icon: React.ElementType; accent: string; tooltip?: string;
  priorValue?: number;
}) {
  const [show, setShow] = useState(false);
  const numVal = typeof value === 'string' ? parseInt(value.replace(/,/g, ''), 10) : value;
  return (
    <div className="bg-card border border-border rounded-xl p-5 relative">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${accent}/10`}>
          <Icon size={16} className={accent} />
        </div>
        {tooltip && (
          <button
            className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
          >
            <Info size={12} />
          </button>
        )}
        {show && tooltip && (
          <div className="absolute top-2 right-8 z-30 w-56 bg-popover border border-border rounded-lg p-2.5 text-[11px] text-muted-foreground shadow-xl pointer-events-none">
            {tooltip}
          </div>
        )}
      </div>
      <p className={`text-2xl font-bold ${accent}`}>{value ?? '—'}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground/60 mt-1">{sub}</p>}
      {priorValue !== undefined && numVal !== undefined && (
        <div className="mt-1.5 flex items-center gap-1">
          <DeltaPill current={numVal} prior={priorValue} />
          <span className="text-[9px] text-muted-foreground/40">vs prior period</span>
        </div>
      )}
    </div>
  );
}

// ── Deal Detail Panel ─────────────────────────────────────────────────────────
function RelationshipBadge({ totalDeals, dealNumber }: { totalDeals: number; dealNumber: number | null }) {
  if (totalDeals === 1) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
      First deal between this pair
    </span>
  );
  if (dealNumber === 1) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
      Most recent of {totalDeals} deals
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
      Deal #{totalDeals - (dealNumber ?? 0) + 1} of {totalDeals} in this relationship
    </span>
  );
}

function DealDetailPanel({ cfn, onClose }: { cfn: string; onClose: () => void }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/deal-detail', cfn],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/deal-detail/${cfn}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return (
    <tr>
      <td colSpan={7} className="px-4 py-4 bg-orange-50/50 border-b border-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="w-3 h-3 rounded-full border-2 border-orange-400 border-t-transparent animate-spin" />
          Loading deal intelligence…
        </div>
      </td>
    </tr>
  );

  if (!detail || detail.error) return null;

  const { transaction: tx, relationship: rel, seller_profile: sp, buyer_profile: bp,
          seller_other_buyers: sob, buyer_other_sellers: bos } = detail;

  const sellerIsNetSeller = sp && sp.outbound_vol > sp.inbound_vol;
  const buyerIsNetBuyer   = bp && bp.inbound_vol >= bp.outbound_vol;

  // Derive a plain-language narrative
  const narrative = (() => {
    const parts: string[] = [];
    if (rel.total_deals === 1) {
      parts.push(`This is the first recorded direct transfer from ${tx.assignor_canon} to ${tx.assignee_canon} in Miami-Dade County.`);
    } else if (rel.deal_number === 1) {
      parts.push(`This is the most recent of ${rel.total_deals} recorded transfers between ${tx.assignor_canon} and ${tx.assignee_canon}, spanning ${rel.first_deal} to ${rel.last_deal}.`);
    } else {
      const ordinal = rel.total_deals - (rel.deal_number ?? 0) + 1;
      parts.push(`This is deal #${ordinal} in a ${rel.total_deals}-transaction relationship between ${tx.assignor_canon} and ${tx.assignee_canon} (${rel.first_deal} → ${rel.last_deal}).`);
    }
    if (sp && sellerIsNetSeller) {
      parts.push(`${tx.assignor_canon} is a net seller (${sp.outbound_vol.toLocaleString()} outbound vs ${sp.inbound_vol.toLocaleString()} inbound) — consistent disposition pressure.`);
    }
    if (bp && buyerIsNetBuyer) {
      parts.push(`${tx.assignee_canon} is an active net acquirer with ${bp.inbound_vol.toLocaleString()} total inbound assignments in this market.`);
    }
    if (sob && sob.length > 1) {
      const others = sob.filter((b: any) => b.buyer !== tx.assignee_canon).slice(0, 2).map((b: any) => b.buyer);
      if (others.length > 0) parts.push(`${tx.assignor_canon} also sells to: ${others.join(', ')}.`);
    }
    return parts.join(' ');
  })();

  return (
    <tr>
      <td colSpan={7} className="border-b border-border p-0">
        <div className="bg-orange-50/40 border-l-2 border-orange-400 px-5 py-4 space-y-4">

          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-foreground">Deal Intelligence: {cfn}</span>
                <RelationshipBadge totalDeals={rel.total_deals} dealNumber={rel.deal_number} />
              </div>
              {narrative && (
                <p className="text-[11px] text-muted-foreground max-w-3xl leading-relaxed">{narrative}</p>
              )}
            </div>
            <button onClick={onClose} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0 mt-0.5">
              <ChevronUp size={14} />
            </button>
          </div>

          {/* Classification Rationale */}
          <ClassificationRationale tx={tx} />

          {/* Three-column layout */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            {/* Col 1: Filing Details */}
            <div className="space-y-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <FileText size={9} />Filing Details
              </p>
              <div className="space-y-1.5 text-[11px]">
                {tx.address && (
                  <div className="flex items-start gap-1.5">
                    <MapPin size={10} className="text-muted-foreground/60 mt-0.5 shrink-0" />
                    <span className="text-foreground">{tx.address}</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Hash size={10} className="shrink-0" />
                  <span className="font-mono">{tx.cfn}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{tx.rec_date}</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <FileText size={10} className="shrink-0" />
                  <span>Book {tx.rec_book} / Page {tx.rec_page}</span>
                </div>
                {tx.legal_desc && (
                  <div className="text-muted-foreground/60 text-[10px] italic line-clamp-2" title={tx.legal_desc}>
                    {tx.legal_desc}
                  </div>
                )}
                <div className="pt-1">
                  <a
                    href={`https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${tx.rec_book}&sBookType=O+&sPage=${tx.rec_page}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                  >
                    <ExternalLink size={9} />View county filing
                  </a>
                </div>
              </div>
            </div>

            {/* Col 2: Relationship History */}
            <div className="space-y-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Link2 size={9} />Relationship History
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="text-2xl font-bold text-foreground">{rel.total_deals}</span>
                  <span>total deals<br />between this pair</span>
                </div>
                {rel.first_deal && (
                  <div className="text-[10px] text-muted-foreground">
                    {rel.first_deal} → {rel.last_deal}
                  </div>
                )}
                {/* Recent deal timeline */}
                {rel.recent_deals && rel.recent_deals.length > 1 && (
                  <div className="pt-1 space-y-0.5">
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">Recent filings</p>
                    {rel.recent_deals.slice(0, 6).map((d: any, i: number) => (
                      <div key={d.cfn} className={`flex items-center gap-2 text-[10px] ${d.cfn === cfn ? 'text-orange-600 font-medium' : 'text-muted-foreground'}`}>
                        <span className="font-mono w-24 shrink-0">{d.cfn}</span>
                        <span>{d.rec_date}</span>
                        {d.cfn === cfn && <span className="text-[9px] bg-orange-100 text-orange-600 px-1 rounded">this filing</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Col 3: Entity Profiles */}
            <div className="space-y-3">
              {/* Seller */}
              {sp && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1.5">
                    <Building2 size={9} className="text-blue-400" />Seller Profile
                  </p>
                  <div className="text-[11px] space-y-1">
                    <div className="font-semibold text-blue-700 text-xs">{tx.assignor_canon}</div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{sp.total_vol.toLocaleString()} total assignments</span>
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${sellerIsNetSeller ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                        {sellerIsNetSeller ? 'Net Seller' : 'Net Buyer'}
                      </span>
                    </div>
                    <div className="flex gap-3 text-muted-foreground/70 text-[10px]">
                      <span>↑ {sp.inbound_vol.toLocaleString()} in</span>
                      <span>↓ {sp.outbound_vol.toLocaleString()} out</span>
                    </div>
                    {sob && sob.length > 0 && (
                      <div className="pt-1">
                        <p className="text-[9px] text-muted-foreground/50 mb-0.5">Also sells to:</p>
                        {sob.filter((b: any) => b.buyer !== tx.assignee_canon).slice(0, 3).map((b: any) => (
                          <div key={b.buyer} className="text-[10px] text-muted-foreground truncate">
                            {b.buyer} <span className="text-muted-foreground/40">({b.n})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Buyer */}
              {bp && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1.5">
                    <Building2 size={9} className="text-purple-400" />Buyer Profile
                  </p>
                  <div className="text-[11px] space-y-1">
                    <div className="font-semibold text-purple-700 text-xs">{tx.assignee_canon}</div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{bp.total_vol.toLocaleString()} total assignments</span>
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${buyerIsNetBuyer ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                        {buyerIsNetBuyer ? 'Net Buyer' : 'Net Seller'}
                      </span>
                    </div>
                    <div className="flex gap-3 text-muted-foreground/70 text-[10px]">
                      <span>↑ {bp.inbound_vol.toLocaleString()} in</span>
                      <span>↓ {bp.outbound_vol.toLocaleString()} out</span>
                    </div>
                    {bos && bos.length > 0 && (
                      <div className="pt-1">
                        <p className="text-[9px] text-muted-foreground/50 mb-0.5">Also buys from:</p>
                        {bos.filter((s: any) => s.seller !== tx.assignor_canon).slice(0, 3).map((s: any) => (
                          <div key={s.seller} className="text-[10px] text-muted-foreground truncate">
                            {s.seller} <span className="text-muted-foreground/40">({s.n})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── Period vs Prior comparison chart ─────────────────────────────────────────
function PeriodComparisonChart({ summary, currentStart, currentEnd, priorStart, priorEnd }: {
  summary: any; currentStart: string; currentEnd: string; priorStart: string; priorEnd: string;
}) {
  const prior = summary?.prior;
  if (!prior) return null;

  const metrics = [
    { key: 'bank_to_pe_total',   short: 'Bank→PE',        label: 'Bank → PE Transfers' },
    { key: 'net_sellers_count',  short: 'Net Sellers',    label: 'Net Institutional Sellers' },
    { key: 'special_svc_vol',    short: 'Spec. Svc.',     label: 'Special Svc. Acquisitions' },
    { key: 'active_pe_buyers',   short: 'Active PE',      label: 'Active PE Buyers' },
  ];

  const data = metrics.map(m => ({
    name:    m.short,
    label:   m.label,
    current: summary[m.key] ?? 0,
    prior:   prior[m.key]   ?? 0,
  }));

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const row = data.find(d => d.name === label);
    const curr = payload.find((p: any) => p.dataKey === 'current')?.value ?? 0;
    const prev = payload.find((p: any) => p.dataKey === 'prior')?.value ?? 0;
    const delta = curr - prev;
    const pct   = prev > 0 ? Math.round((delta / prev) * 100) : null;
    return (
      <div className="bg-white border border-border rounded-lg p-3 text-[11px] shadow-xl min-w-[180px]">
        <p className="font-semibold text-foreground mb-2">{row?.label}</p>
        <div className="space-y-1">
          <div className="flex justify-between gap-4">
            <span className="text-orange-500 font-medium">Current</span>
            <span className="font-mono font-semibold">{curr.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-slate-400">Prior period</span>
            <span className="font-mono">{prev.toLocaleString()}</span>
          </div>
          <div className="border-t border-border pt-1 mt-1 flex justify-between gap-4">
            <span className="text-muted-foreground">Change</span>
            <span className={`font-semibold font-mono ${delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
              {delta > 0 ? '+' : ''}{delta.toLocaleString()}{pct !== null ? ` (${delta > 0 ? '+' : ''}${pct}%)` : ''}
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Period Comparison</h2>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Current window vs identical prior window — all five distress signals side by side
          </p>
        </div>
        <div className="flex items-center gap-4 text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-orange-400 inline-block" />
            <span className="font-medium text-orange-600">{currentStart && currentEnd ? `${fmtDate(currentStart)} – ${fmtDate(currentEnd)}` : 'Current'}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-slate-300 inline-block" />
            <span className="text-muted-foreground">{priorStart && priorEnd ? `${fmtDate(priorStart)} – ${fmtDate(priorEnd)}` : 'Prior'}</span>
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barGap={4} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={32}
            tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f8fafc' }} />
          <Bar dataKey="prior"   name="Prior period" fill="#cbd5e1" radius={[3,3,0,0]} maxBarSize={40} />
          <Bar dataKey="current" name="Current"       fill="#fb923c" radius={[3,3,0,0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
      {/* Delta summary row */}
      <div className="grid grid-cols-5 gap-2 mt-3 pt-3 border-t border-border">
        {data.map(d => {
          const delta = d.current - d.prior;
          const pct   = d.prior > 0 ? Math.round((delta / d.prior) * 100) : null;
          const pos   = delta > 0;
          return (
            <div key={d.name} className="text-center">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5">{d.name}</p>
              <p className={`text-[11px] font-bold ${pos ? 'text-emerald-600' : delta < 0 ? 'text-red-500' : 'text-slate-400'}`}>
                {delta === 0 ? '—' : `${pos ? '+' : ''}${delta.toLocaleString()}`}
              </p>
              {pct !== null && delta !== 0 && (
                <p className={`text-[9px] ${pos ? 'text-emerald-500' : 'text-red-400'}`}>{pos ? '+' : ''}{pct}%</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DealIntelligence() {
  const [dealPage, setDealPage] = useState(1);
  const [selectedCfn, setSelectedCfn] = useState<string | null>(null);

  // Date range state — default to last 90 days
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const { start, end } = getPresetDates('90d');
    return { start, end, preset: '90d' };
  });

  const dateParams = dateRange.preset !== 'all' && dateRange.start && dateRange.end
    ? `start_date=${dateRange.start}&end_date=${dateRange.end}`
    : '';

  const handleDateChange = (r: DateRange) => {
    setDateRange(r);
    setDealPage(1);
  };

  const { data: summary, isLoading: sumLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/summary', dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/summary${dateParams ? '?' + dateParams : ''}`).then(r => r.json()),
  });
  const { data: sellers, isLoading: sellLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/seller-pressure', dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/seller-pressure${dateParams ? '?' + dateParams : ''}`).then(r => r.json()),
  });
  const { data: peList, isLoading: peLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/pe-competitive', dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/pe-competitive${dateParams ? '?' + dateParams : ''}`).then(r => r.json()),
  });
  const { data: specialSvc, isLoading: svcLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/special-servicers', dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/special-servicers${dateParams ? '?' + dateParams : ''}`).then(r => r.json()),
  });
  const { data: monthly, isLoading: mLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/monthly'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/monthly').then(r => r.json()),
  });
  const { data: dealLog, isLoading: dealLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/bank-to-pe', dealPage, dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/bank-to-pe?page=${dealPage}&limit=25${dateParams ? '&' + dateParams : ''}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });
  const { data: recentPairs } = useQuery({
    queryKey: ['/api/deal-intelligence/recent-bank-to-pe', dateParams],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/recent-bank-to-pe${dateParams ? '?' + dateParams : ''}`).then(r => r.json()),
  });

  const prior = (summary as any)?.prior;

  // Derived prior period dates = same window one year earlier (year-over-year)
  const { priorStart, priorEnd } = useMemo(() => {
    if (!dateRange.start || !dateRange.end || dateRange.preset === 'all')
      return { priorStart: '', priorEnd: '' };
    const shiftYear = (iso: string) => {
      const d = new Date(iso); d.setFullYear(d.getFullYear() - 1); return toISO(d);
    };
    return { priorStart: shiftYear(dateRange.start), priorEnd: shiftYear(dateRange.end) };
  }, [dateRange]);

  // Max values for bar chart scaling
  const maxPeVol = Math.max(...((peList || []).map((r: any) => r.inbound_vol)), 1);

  return (
    <div className="p-6 space-y-7 max-w-screen-xl mx-auto">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-orange-500/10 rounded-lg">
              <Target size={16} className="text-orange-400" />
            </div>
            <h1 className="text-xl font-semibold">Deal Intelligence</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Distressed debt sourcing signals derived from Miami-Dade County public mortgage assignment filings.
            Every metric on this page is computed from recorded assignments of mortgage — the legal documents
            that transfer ownership of a mortgage note from one party to another.
          </p>
        </div>

        <MethodologyBox title="What is an assignment of mortgage — and why does it reveal distress? (click to expand)">
          <p><strong>An assignment of mortgage</strong> is a public county record filed every time a mortgage (debt instrument) changes hands. It does <em>not</em> mean the property was sold — the borrower stays the same. What changes is <em>who holds the debt</em> and who has the right to collect payments or foreclose.</p>
          <p><strong>Why this reveals distress:</strong> Banks and servicers routinely sell mortgages to each other as part of normal capital markets. But when a bank sells to a private credit / PE fund, or when an institution sells to a private non-institutional party, it almost always signals stress — the bank wants the loan off its books, often at a discount.</p>
          <p className="font-medium text-blue-700">How transactions are classified on this page:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-1">
            {[
              ['Bank → PE Transfer',      'Institutional seller (bank) → institutional buyer (PE fund). True secondary market; bank offloading debt to alternative capital.'],
              ['Market Transfer',         'Institution → institution (any type). Normal secondary market activity between regulated/professional participants.'],
              ['MERS Release',            'MERS (a registry) steps out of the chain. Not a real sale — just making the actual owner visible in the public record.'],
              ['Origination / Intake',    'Private party → institution. A new loan entering the system, or a broker transferring a freshly originated loan to the final lender.'],
            ].map(([label, desc]) => (
              <div key={label} className="flex gap-2">
                <span className="font-semibold text-blue-700 shrink-0 w-44">{label}:</span>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </MethodologyBox>
      </div>

      {/* ── Date Range Picker ────────────────────────────────────────────── */}
      <DateRangePicker range={dateRange} onChange={handleDateChange} />

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {sumLoading ? Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-28 rounded-xl" />) : (<>
          <KpiCard
            label="Bank → PE Transfers"
            value={summary?.bank_to_pe_total?.toLocaleString()}
            sub="Direct bank-to-fund deal pipeline"
            icon={ArrowRight}
            accent="text-orange-400"
            priorValue={prior?.bank_to_pe_total}
            tooltip="Counted when: seller entity type = BANK, buyer entity type = PRIVATE_CREDIT, and transaction type = MARKET_TRANSFER (both parties institutional). These are the most actionable deal signals — a regulated bank is voluntarily shedding mortgage debt to an alternative buyer, usually because the loan is stressed or the bank needs to reduce its CRE concentration."
          />
          <KpiCard
            label="Net Institutional Sellers"
            value={summary?.net_sellers_count?.toLocaleString()}
            sub="Outbound > 1.5× inbound, min 3 txns"
            icon={TrendingDown}
            accent="text-red-400"
            priorValue={prior?.net_sellers_count}
            tooltip="Calculated as: count of institutions (banks, servicers, trusts) where total outbound assignments ÷ total inbound assignments > 1.5. The 1.5× threshold filters out normal portfolio churn and isolates entities in a sustained net-selling posture — consistent disposition pressure that signals capital stress or balance-sheet reduction."
          />
          <KpiCard
            label="Special Svc. Acquisitions"
            value={summary?.special_svc_vol?.toLocaleString()}
            sub="Total loans transferred to workout servicers"
            icon={AlertTriangle}
            accent="text-amber-400"
            priorValue={prior?.special_svc_vol}
            tooltip="Total inbound assignment volume for known special servicers (Mortgage Assets Mgmt, Select Portfolio Servicing, Carrington, Rushmore, etc.). Special servicers are hired specifically to manage non-performing and distressed loans. When their intake grows, it means upstream lenders are escalating problem loans — a leading indicator of distressed portfolio sale opportunities."
          />
          <KpiCard
            label="Active PE Buyers"
            value={summary?.active_pe_buyers?.toLocaleString()}
            sub="Distinct funds acquiring from institutions"
            icon={Users}
            accent="text-purple-400"
            priorValue={prior?.active_pe_buyers}
            tooltip="Count of distinct private credit / PE fund entities that have received at least one assignment from an institutional seller (bank, servicer, or GSE). A higher number means more competition for distressed deals in this market. Track this figure over time — a rising count suggests the Miami-Dade distressed market is drawing new entrants."
          />
        </>)}
      </div>

      {/* ── Period Comparison (only when a date range is selected) ──────── */}
      {prior && (
        <PeriodComparisonChart
          summary={summary}
          currentStart={dateRange.start}
          currentEnd={dateRange.end}
          priorStart={priorStart}
          priorEnd={priorEnd}
        />
      )}

      {/* ── Distressed Signal Trend ──────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Distressed Activity Trend</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Full monthly history — shaded bands highlight the selected window and its comparison period
            </p>
          </div>
          <div className="flex flex-col gap-1 items-end text-[10px] text-muted-foreground">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-orange-400 inline-block" />Bank → PE</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-rose-400 inline-block" />Inst. Out</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-emerald-500/50 inline-block" />All Mkt Transfers</span>
              {dateRange.preset !== 'all' && dateRange.start && (
                <>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-orange-200/70 inline-block border border-orange-300" />Current window</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-200/70 inline-block border border-slate-300" />Prior window</span>
                </>
              )}
            </div>
          </div>
        </div>
        {mLoading ? <Skeleton className="h-52" /> : (
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={monthly || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradMT" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradBPE" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#fb923c" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#fb923c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tickFormatter={fmtMonth}
                tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={36}
                tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11 }}
                labelFormatter={fmtMonth}
                formatter={(v: any, name: string) => [
                  v.toLocaleString(),
                  name === 'market_transfers' ? 'All Market Transfers'
                    : name === 'bank_to_pe' ? 'Bank → PE'
                    : 'Inst. Out (Distressed)',
                ]}
              />
              {/* Prior period band */}
              {priorStart && priorEnd && (
                <ReferenceArea
                  x1={priorStart.slice(0,7)} x2={priorEnd.slice(0,7)}
                  fill="#94a3b8" fillOpacity={0.1}
                  stroke="#94a3b8" strokeOpacity={0.3} strokeWidth={1}
                  label={{ value: 'Prior', position: 'insideTopLeft', fontSize: 9, fill: '#94a3b8' }}
                />
              )}
              {/* Current period band */}
              {dateRange.start && dateRange.end && dateRange.preset !== 'all' && (
                <ReferenceArea
                  x1={dateRange.start.slice(0,7)} x2={dateRange.end.slice(0,7)}
                  fill="#fb923c" fillOpacity={0.1}
                  stroke="#fb923c" strokeOpacity={0.4} strokeWidth={1}
                  label={{ value: 'Current', position: 'insideTopLeft', fontSize: 9, fill: '#fb923c' }}
                />
              )}
              <Area dataKey="market_transfers" stroke="#10b981" strokeWidth={1.5} fill="url(#gradMT)" dot={false} />
              <Area dataKey="inst_out"         stroke="#fb7185" strokeWidth={1.5} fill="none" dot={false} strokeDasharray="4 2" />
              <Area dataKey="bank_to_pe"       stroke="#fb923c" strokeWidth={2}   fill="url(#gradBPE)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Two-column: Seller Pressure + Special Servicers ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Seller Pressure Monitor */}
        <div className="bg-card border border-border rounded-xl p-5 flex flex-col">
          <div className="flex items-start gap-2 mb-1">
            <TrendingDown size={14} className="text-red-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Seller Pressure Monitor</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Banks and servicers ranked by net outbound volume. Heavy net sellers are likely sources for portfolio acquisitions.
              </p>
            </div>
          </div>
          <div className="mt-2 mb-2">
            <MethodologyBox title="How net seller pressure is calculated">
              <p><strong>Inbound</strong> = total times this institution appeared as the buyer (grantee) on a recorded assignment. <strong>Outbound</strong> = total times it appeared as the seller (grantor).</p>
              <p><strong>Net flow</strong> = Inbound − Outbound. A negative net (shown in red) means the institution is disposing of more loans than it is acquiring — a sustained selling posture. The bar chart splits the entity's total volume into its inbound and outbound share visually.</p>
              <p>Institutions ranked highest here have the most motivation to sell portfolios — approach them proactively for deal sourcing.</p>
            </MethodologyBox>
          </div>
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground mt-1 mb-3 px-1">
            <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-full bg-emerald-500/70 inline-block" />Inbound (buying)</span>
            <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-full bg-red-500/70 inline-block" />Outbound (selling)</span>
            <span className="ml-auto">Net flow shown as ±</span>
          </div>
          {sellLoading ? <Skeleton className="h-72" /> : (
            <div className="space-y-1 overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
              {(sellers || []).map((row: any, i: number) => (
                <div key={row.entity} className="flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-muted/20 transition-colors group">
                  <span className="text-[10px] text-muted-foreground w-4 shrink-0 text-right">{i+1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 mb-1">
                      <span className="text-xs font-medium text-foreground truncate" title={row.entity}>{row.entity}</span>
                      <CategoryBadge category={row.entity_type} size="xs" />
                    </div>
                    <PressureBar inbound={row.inbound_vol} outbound={row.outbound_vol} />
                  </div>
                  <div className="text-right shrink-0 text-[10px] text-muted-foreground">
                    <div className="font-mono">{row.total_vol.toLocaleString()}</div>
                    <div className="text-[9px]">total</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Special Servicer Watch */}
        <div className="bg-card border border-border rounded-xl p-5 flex flex-col">
          <div className="flex items-start gap-2 mb-1">
            <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Special Servicer Watch</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Entities that manage distressed and non-performing loans. Rising inbound = growing distressed pipeline.
              </p>
            </div>
          </div>

          <div className="mt-2 mb-2 space-y-1.5">
            <MethodologyBox title="What is a special servicer and why does their intake matter?">
              <p><strong>Special servicers</strong> are mortgage companies hired specifically to manage non-performing or distressed loans — ones where the borrower has stopped paying, is in default, or is in foreclosure. They are different from regular servicers who collect payments on healthy loans.</p>
              <p>When a bank can no longer manage a distressed loan internally, it transfers it to a special servicer. <strong>Rising inbound volume at special servicers</strong> means more banks are escalating problem loans — this is a leading indicator that a portfolio sale or bulk NPL auction is likely coming.</p>
              <p>The inbound bar shows what percentage of each entity's total activity is acquisitions (as opposed to resales). A high acquisition share confirms they are actively taking on new distressed inventory.</p>
            </MethodologyBox>
            <div className="flex items-center gap-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <Eye size={10} className="shrink-0" />
              <span>When these entities acquire at increasing rates, distressed supply is building upstream — monitor for portfolio sale opportunities.</span>
            </div>
          </div>

          {svcLoading ? <Skeleton className="h-64" /> : (
            <div className="space-y-1 flex-1">
              {(specialSvc || []).length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 pt-2">No special servicer activity found in dataset.</p>
              ) : (specialSvc || []).map((row: any) => {
                const inPct = Math.round((row.inbound_vol / Math.max(row.total_vol, 1)) * 100);
                return (
                  <div key={row.entity} className="px-2 py-2.5 rounded-lg hover:bg-muted/20 transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="text-xs font-medium text-foreground">{row.entity}</span>
                      <span className="text-[10px] font-mono text-amber-400 shrink-0">{row.inbound_vol.toLocaleString()} acquired</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500 rounded-full" style={{ width: `${inPct}%` }} />
                      </div>
                      <span className="text-[9px] text-muted-foreground shrink-0">
                        {row.outbound_vol.toLocaleString()} resold · {inPct}% net acquiring
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-1">{row.first_seen} → {row.last_seen}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── PE Competitive Map ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-start gap-2">
            <Shield size={14} className="text-purple-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Private Credit Competitive Map</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Active PE / private credit funds in Miami-Dade ranked by total acquisition volume. These are your competitors and potential co-investors.
              </p>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground text-right">
            <div>Total inbound volume</div>
            <div className="text-purple-400 font-mono">{peLoading ? '—' : (peList || []).reduce((s: number, r: any) => s + r.inbound_vol, 0).toLocaleString()}</div>
          </div>
        </div>

        {peLoading ? <Skeleton className="h-64" /> : (
          <div className="space-y-2">
            {(peList || []).map((row: any, i: number) => {
              const barPct = Math.round((row.inbound_vol / maxPeVol) * 100);
              const isNetBuyer = row.inbound_vol >= row.outbound_vol;
              return (
                <div key={row.entity} className="flex items-center gap-3 group">
                  <span className="text-[10px] text-muted-foreground w-4 shrink-0 text-right">{i+1}</span>
                  <div className="w-36 shrink-0">
                    <span className="text-xs font-medium text-foreground truncate block" title={row.entity}>{row.entity}</span>
                    <span className="text-[9px] text-muted-foreground">{row.first_seen} → {row.last_seen}</span>
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isNetBuyer ? 'bg-purple-500' : 'bg-purple-300'}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-purple-400 w-14 text-right shrink-0">
                      {row.inbound_vol.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-right shrink-0 text-[9px] text-muted-foreground w-24">
                    <div>{row.outbound_vol.toLocaleString()} sold</div>
                    <div className={isNetBuyer ? 'text-emerald-400' : 'text-red-400'}>
                      {isNetBuyer ? `net +${(row.inbound_vol - row.outbound_vol).toLocaleString()}` : `net −${(row.outbound_vol - row.inbound_vol).toLocaleString()}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Recent Bank→PE pairs (last 180d) */}
        {recentPairs && (recentPairs as any[]).length > 0 && (
          <div className="mt-5 pt-4 border-t border-border">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Most active bank→PE relationships · last 180 days
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(recentPairs as any[]).map((pair: any) => (
                <div key={`${pair.seller}-${pair.buyer}`}
                  className="flex items-center gap-2 bg-muted/20 rounded-lg px-3 py-2 text-xs">
                  <span className="text-blue-400 font-medium truncate max-w-[90px]" title={pair.seller}>{pair.seller}</span>
                  <ArrowRight size={10} className="text-muted-foreground/40 shrink-0" />
                  <span className="text-purple-400 font-medium truncate max-w-[90px]" title={pair.buyer}>{pair.buyer}</span>
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground shrink-0">{pair.n}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Bank → PE Deal Log ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border space-y-3">
          <div className="flex items-start gap-2">
            <TrendingUp size={14} className="text-orange-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Bank → PE Deal Log</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Every recorded assignment of mortgage where a commercial bank transferred a mortgage note to a private credit or PE fund.
                {dealLog && <span className="text-orange-400 ml-1">{dealLog.total.toLocaleString()} total transfers recorded.</span>}
              </p>
            </div>
          </div>
          <MethodologyBox title="How does a transaction qualify for this log?">
            <p>A filing appears in this table when all three conditions are met:</p>
            <div className="space-y-1 mt-1">
              {[
                ['Seller entity type = BANK', 'The grantor (assignor) is identified as a commercial bank, investment bank, savings bank, or credit union — a regulated deposit-taking institution.'],
                ['Buyer entity type = PRIVATE_CREDIT', 'The grantee (assignee) is identified as a private credit fund, PE firm, hedge fund, or alternative asset manager — an unregulated, non-bank capital pool.'],
                ['Transaction type = MARKET_TRANSFER', 'Both parties are institutional, confirming this is a secondary-market sale, not an origination or REO disposal. Self-assignments are excluded.'],
              ].map(([cond, desc]) => (
                <div key={cond} className="flex gap-2">
                  <span className="font-semibold text-blue-700 shrink-0">✓ {cond}:</span>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 font-medium text-blue-700">What does this transfer actually represent?</p>
            <p>The bank is selling the <em>mortgage note</em> (the debt obligation), not the property. The borrower's property and monthly payment obligation remain unchanged — they just start paying a different entity. The PE fund now owns the debt and can: collect payments, negotiate a loan modification, sell the note again, or foreclose if the loan is non-performing. Click any row below and expand "Why is this classified this way?" for the full rationale on that specific filing.</p>
          </MethodologyBox>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">
                  <ColHeader label="CFN" tooltip="County Filing Number — the unique ID assigned by the Miami-Dade Clerk when the document was officially recorded. Click the CFN to view the original document." />
                </th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <ColHeader label="Date" tooltip="Recording date — when the assignment was stamped by the Miami-Dade County Clerk. Slightly later than the execution date on the document itself." />
                </th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                    <ColHeader label="Bank (Seller)" tooltip="The bank or depository institution transferring the mortgage. Banks sell loans to manage balance-sheet exposure, meet capital requirements, or offload non-performing assets. Frequent selling by a bank signals portfolio stress or strategic exit." />
                  </span>
                </th>
                <th className="px-2 py-2.5 text-center font-medium w-5"></th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                    <ColHeader label="PE Fund (Buyer)" tooltip="The private equity or private credit fund acquiring the mortgage. These deals signal active deployment of private capital into the distressed or performing mortgage market — often at a discount to face value." />
                  </span>
                </th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <ColHeader label="Book / Page" tooltip="Miami-Dade Official Records locator — the book and page number of the recorded instrument. Used as an alternate document reference by the Clerk's office." />
                </th>
                <th className="px-4 py-2.5 text-center font-medium w-16">
                  <ColHeader label="Details" tooltip="Click to open the full transaction detail panel, including classification rationale, counterparty history, and deal context." />
                </th>
              </tr>
            </thead>
            <tbody>
              {dealLoading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(7).fill(0).map((_, j) => <td key={j} className="px-4 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (dealLog?.rows || []).flatMap((r: any, i: number) => {
                    const isExpanded = selectedCfn === r.cfn;
                    return [
                      <tr
                        key={`${r.cfn}-${i}`}
                        onClick={() => setSelectedCfn(isExpanded ? null : r.cfn)}
                        className={`border-b border-border/50 cursor-pointer transition-colors ${isExpanded ? 'bg-orange-50/60' : 'hover:bg-muted/20'}`}
                      >
                        <td className="px-4 py-2.5 font-mono text-primary/80 text-[11px] whitespace-nowrap">{r.cfn}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        <td className="px-4 py-2.5 max-w-[180px]">
                          <div className="font-semibold text-blue-700 truncate" title={r.seller}>{r.seller}</div>
                          {r.assignor !== r.seller && (
                            <div className="text-muted-foreground truncate text-[10px]" title={r.assignor}>{r.assignor}</div>
                          )}
                        </td>
                        <td className="px-1 py-2.5 text-center">
                          <ArrowRight size={11} className="text-orange-400/60 mx-auto" />
                        </td>
                        <td className="px-4 py-2.5 max-w-[180px]">
                          <div className="font-semibold text-purple-700 truncate" title={r.buyer}>{r.buyer}</div>
                          {r.assignee !== r.buyer && (
                            <div className="text-muted-foreground truncate text-[10px]" title={r.assignee}>{r.assignee}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-muted-foreground text-[11px] whitespace-nowrap">{r.rec_book}/{r.rec_page}</td>
                        <td className="px-4 py-2.5 text-center">
                          <button
                            className={`inline-flex items-center gap-1 text-[10px] font-medium transition-colors ${isExpanded ? 'text-orange-500' : 'text-muted-foreground/50 hover:text-orange-400'}`}
                            title={isExpanded ? 'Collapse' : 'View deal intelligence'}
                          >
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {isExpanded ? 'Close' : 'Intel'}
                          </button>
                        </td>
                      </tr>,
                      isExpanded && <DealDetailPanel key={`detail-${r.cfn}`} cfn={r.cfn} onClose={() => setSelectedCfn(null)} />,
                    ].filter(Boolean);
                  })
              }
              {!dealLoading && !dealLog?.rows?.length && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {dealLog && dealLog.pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Showing {((dealPage-1)*25)+1}–{Math.min(dealPage*25, dealLog.total)} of {dealLog.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={dealPage<=1} onClick={() => { setDealPage(1); setSelectedCfn(null); }} className="h-7 px-2 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={dealPage<=1} onClick={() => { setDealPage(p=>p-1); setSelectedCfn(null); }} className="h-7 w-7 p-0"><ChevronLeft size={13}/></Button>
              <span className="text-xs text-muted-foreground px-2">{dealPage} / {dealLog.pages}</span>
              <Button size="sm" variant="ghost" disabled={dealPage>=dealLog.pages} onClick={() => { setDealPage(p=>p+1); setSelectedCfn(null); }} className="h-7 w-7 p-0"><ChevronRight size={13}/></Button>
              <Button size="sm" variant="ghost" disabled={dealPage>=dealLog.pages} onClick={() => { setDealPage(dealLog.pages); setSelectedCfn(null); }} className="h-7 px-2 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
