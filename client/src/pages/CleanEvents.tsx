import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import {
  ChevronLeft, ChevronRight, Search, X, CheckCircle,
  ArrowRight, Info, TrendingUp, TrendingDown, Users, Filter, ChevronDown, ChevronUp,
  Landmark, Repeat2, BookOpen, AlertCircle, ArrowUpRight, Users2,
} from 'lucide-react';

interface Filters { assignor: string; assignee: string; start_date: string; end_date: string; txn_type: string; }
const EMPTY: Filters = { assignor: '', assignee: '', start_date: '', end_date: '', txn_type: '' };

// ── Transaction type metadata ─────────────────────────────────────────────────
const TXN_TYPES: Record<string, { label: string; color: string; desc: string }> = {
  MARKET_TRANSFER:   { label: 'Market Transfer',  color: 'bg-emerald-100 text-emerald-700 border-emerald-300',  desc: 'Institution → Institution (true secondary market)' },
  ORIGINATION:       { label: 'Origination',      color: 'bg-blue-100 text-blue-700 border-blue-300',          desc: 'Individual / private → Institution (new supply entering)' },
  MERS_RELEASE:      { label: 'MERS Release',     color: 'bg-purple-100 text-purple-700 border-purple-300',    desc: 'MERS nominee discharging nominal interest (registry housekeeping)' },
  SELF_ASSIGN:       { label: 'Self-Assign',      color: 'bg-zinc-100 text-zinc-600 border-zinc-300',          desc: 'Same canonical entity on both sides (administrative noise)' },
  INSTITUTIONAL_OUT: { label: 'Inst. Out',        color: 'bg-amber-100 text-amber-700 border-amber-300',       desc: 'Institution → Individual (payoff, REO, or distressed)' },
  PRIVATE:           { label: 'Private',          color: 'bg-slate-100 text-slate-600 border-slate-300',       desc: 'Individual → Individual (non-institutional)' },
};

function TxnTypeBadge({ type }: { type: string }) {
  const meta = TXN_TYPES[type] || { label: type, color: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30', desc: '' };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${meta.color}`} title={meta.desc}>
      {meta.label}
    </span>
  );
}

// ── Per-transaction narrative engine ─────────────────────────────────────────
interface Narrative {
  headline: string;
  what: string;         // plain-language description of what happened
  why: string;          // market significance / why this matters
  icon: React.ElementType;
  accentClass: string;  // tailwind text color for the accent
}

function getTransactionNarrative(row: {
  txn_type: string;
  assignor_type: string;
  assignee_type: string;
  assignor_canon: string;
  assignee_canon: string;
}): Narrative {
  const { txn_type, assignor_type, assignee_type, assignor_canon, assignee_canon } = row;
  const at = assignor_type ?? 'OTHER';
  const bt = assignee_type ?? 'OTHER';
  const fmt = (t: string) => t.replace('_', ' ');

  if (txn_type === 'MARKET_TRANSFER') {
    if (at === 'BANK' && bt === 'SERVICER') return {
      headline: 'Bank offloading servicing rights',
      what: `${assignor_canon} (bank) sold or transferred the servicing rights on this loan to ${assignee_canon} (servicer). Servicers collect monthly payments and manage the loan day-to-day; banks often prefer to sell these rights rather than manage them in-house.`,
      why: 'MSR sales are a core funding mechanism for banks — they free up capital and transfer operational complexity to specialist servicers. High volume between these two entities often signals a bulk portfolio trade.',
      icon: Landmark,
      accentClass: 'text-emerald-400',
    };
    if (at === 'SERVICER' && bt === 'BANK') return {
      headline: 'Servicer pooling into bank / trust',
      what: `${assignor_canon} (servicer) assigned this mortgage to ${assignee_canon} (bank/trustee). The bank here is almost certainly acting as trustee for a securitization trust (MBS pool) rather than holding the loan on its own balance sheet.`,
      why: 'This is the securitization pipeline in action. The mortgage is being pooled with others to back a bond. US Bank, Wilmington Savings, and Goldman Sachs appear here repeatedly as trust custodians for private-label MBS.',
      icon: Landmark,
      accentClass: 'text-emerald-400',
    };
    if (at === 'BANK' && bt === 'BANK') return {
      headline: 'Bank-to-bank loan transfer',
      what: `${assignor_canon} transferred ownership of this mortgage to ${assignee_canon}. Both are banks — this indicates a whole-loan sale, portfolio acquisition, or trust restructuring between two institutional balance sheets.`,
      why: 'Less common than bank→servicer flows. Often signals distressed loan sales, bank M&A-related transfers, or movement into a structured vehicle managed by the receiving bank.',
      icon: Landmark,
      accentClass: 'text-emerald-400',
    };
    if (at === 'SERVICER' && bt === 'SERVICER') return {
      headline: 'Servicer-to-servicer MSR trade',
      what: `${assignor_canon} transferred servicing rights to ${assignee_canon}. Both are mortgage servicers, making this a pure MSR portfolio trade — no underlying loan ownership changed, only who manages and collects on the loan.`,
      why: 'Servicers constantly buy and sell MSR portfolios based on capacity, cost of capital, and servicing efficiency. This is the most common transaction type between servicers and reflects active secondary market trading.',
      icon: Repeat2,
      accentClass: 'text-emerald-400',
    };
    if (at === 'PRIVATE_CREDIT' || bt === 'PRIVATE_CREDIT') {
      const pcName = at === 'PRIVATE_CREDIT' ? assignor_canon : assignee_canon;
      const pcDir  = at === 'PRIVATE_CREDIT' ? 'selling' : 'acquiring';
      return {
        headline: `Private credit fund ${pcDir}`,
        what: `${pcName} is a private credit or alternative investment entity. They are ${pcDir} this mortgage position. Private credit funds often target non-QM loans, bridge loans, or distressed debt that doesn't fit agency guidelines.`,
        why: 'Private credit involvement signals non-traditional mortgage activity — hard money lending, fix-and-flip, DSCR investor loans, or distressed asset acquisition. Watch these flows for signals about the local non-agency market.',
        icon: TrendingUp,
        accentClass: 'text-emerald-400',
      };
    }
    if (at === 'GSE' || bt === 'GSE') {
      const gseName = at === 'GSE' ? assignor_canon : assignee_canon;
      return {
        headline: 'Government / agency involvement',
        what: `This transfer involves ${gseName}, a government-sponsored enterprise or federal agency. GSEs like Fannie Mae and Freddie Mac guarantee conforming loans; HUD/FHA programs appear when government-insured loans transfer.`,
        why: 'Agency transfers are the bedrock of the US mortgage market. When a GSE is the buyer, the loan is typically being pooled into an agency MBS. When a GSE is the seller, it may be disposing of a REO property or adjusting its portfolio.',
        icon: BookOpen,
        accentClass: 'text-emerald-400',
      };
    }
    return {
      headline: `${fmt(at)} → ${fmt(bt)} institutional transfer`,
      what: `${assignor_canon} (${fmt(at)}) transferred this mortgage to ${assignee_canon} (${fmt(bt)}). Both parties are institutional, making this a true secondary market transaction.`,
      why: 'Institutional-to-institutional transfers represent the core of mortgage secondary market activity. These flows reveal how capital moves between different types of financial intermediaries.',
      icon: ArrowUpRight,
      accentClass: 'text-emerald-400',
    };
  }

  if (txn_type === 'ORIGINATION') return {
    headline: 'Mortgage entering the institutional system',
    what: `${assignor_canon} — an individual borrower, seller, or non-institutional intermediary — assigned this mortgage to ${assignee_canon} (${fmt(bt)}). The loan is being transferred into the formal financial system for the first time.`,
    why: 'Origination flows represent new supply. They show which institutions are capturing new loans in this market. The receiving entity is either the originating lender taking formal title, or a servicer receiving a freshly-originated loan for servicing.',
    icon: ArrowUpRight,
    accentClass: 'text-blue-400',
  };

  if (txn_type === 'MERS_RELEASE') return {
    headline: 'MERS releasing its nominee interest',
    what: `MERS (Mortgage Electronic Registration Systems) is stepping out of the chain to formally recognize ${assignee_canon} as the holder of record. MERS is named as the nominal mortgagee on millions of US loans to avoid re-recording fees each time a loan is sold — but the actual owner always sits behind it.`,
    why: 'Not a true ownership transfer. This is registry housekeeping — MERS is simply making the real beneficial owner (${assignee_canon}) visible in the public record. These filings often accompany loan modifications, foreclosure initiations, or securitization unwinds that require a clean title chain.',
    icon: BookOpen,
    accentClass: 'text-purple-400',
  };

  if (txn_type === 'SELF_ASSIGN') return {
    headline: 'Administrative self-assignment — no economic transfer',
    what: `${assignor_canon} assigned this mortgage to itself. The assignor and assignee are the same canonical entity. This nearly always reflects a corporate event: a legal name change, entity merger, subsidiary consolidation, or a recorder\'s correction filing.`,
    why: 'No money changed hands and no loan ownership changed. Common examples: Quicken Loans → Rocket Mortgage rebrand, bank subsidiaries merging under a parent name, or a servicer correcting a title defect. Filter these out when analyzing real market activity.',
    icon: Repeat2,
    accentClass: 'text-zinc-400',
  };

  if (txn_type === 'INSTITUTIONAL_OUT') return {
    headline: 'Institution releasing to a private party',
    what: `${assignor_canon} (${fmt(at)}) assigned this mortgage to ${assignee_canon}, a non-institutional party. Institutions rarely assign mortgages outward to individuals — this typically indicates a loan payoff/satisfaction being recorded, an REO property transfer, or a distressed sale to a local investor.`,
    why: 'Worth investigating individually. Could signal a foreclosure-related deed transfer, a short sale, or a hard-money lender releasing collateral after repayment. The receiving party\'s name often tells the story.',
    icon: AlertCircle,
    accentClass: 'text-amber-400',
  };

  if (txn_type === 'PRIVATE') return {
    headline: 'Private-party transfer',
    what: `${assignor_canon} and ${assignee_canon} are both non-institutional parties — individuals, small LLCs, or unclassified entities. This is person-to-person or small-investor activity outside the formal lending system.`,
    why: 'Non-institutional flows: seller financing, estate transfers, small real estate investors, or HOA-related liens. Lower market intelligence value but can reveal informal lending patterns in specific neighborhoods.',
    icon: Users2,
    accentClass: 'text-slate-400',
  };

  return {
    headline: 'Mortgage assignment',
    what: `${assignor_canon} transferred an interest in this mortgage to ${assignee_canon}.`,
    why: '',
    icon: ArrowRight,
    accentClass: 'text-muted-foreground',
  };
}

// ── Expandable transaction detail row ────────────────────────────────────────
function TransactionDetail({ row }: { row: any }) {
  const n = getTransactionNarrative(row);
  const Icon = n.icon;
  return (
    <tr className="bg-muted/10 border-b border-border/30">
      <td colSpan={8} className="px-4 py-4">
        <div className="flex gap-4">
          {/* Icon column */}
          <div className={`shrink-0 mt-0.5 ${n.accentClass}`}>
            <Icon size={16} />
          </div>
          {/* Content */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Headline */}
            <p className={`text-xs font-semibold ${n.accentClass}`}>{n.headline}</p>
            {/* Two-column explanation */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">What happened</p>
                <p className="text-xs text-foreground/80 leading-relaxed">{n.what}</p>
              </div>
              {n.why && (
                <div className="space-y-1">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Market significance</p>
                  <p className="text-xs text-foreground/80 leading-relaxed">{n.why}</p>
                </div>
              )}
            </div>
            {/* Recording reference */}
            <div className="flex items-center gap-4 pt-1 border-t border-border/30 text-[10px] text-muted-foreground">
              <span>CFN <span className="font-mono text-foreground">{row.cfn}</span></span>
              <span>Recorded <span className="text-foreground">{row.rec_date}</span></span>
              <span>Book / Page <span className="font-mono text-foreground">{row.rec_book}/{row.rec_page}</span></span>
              {row.total_parties > 2 && (
                <span className="text-amber-400">{row.total_parties} parties on original filing</span>
              )}
              <a
                href={`https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${row.rec_book}&sBookType=O+&sPage=${row.rec_page}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 hover:text-foreground transition-colors"
              >
                View on county portal <ArrowUpRight size={9} />
              </a>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── Glossary tooltip ─────────────────────────────────────────────────────────
function GlossaryTip({ term, def }: { term: string; def: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-0.5 group">
      <span
        className="border-b border-dashed border-muted-foreground/50 cursor-help text-foreground"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {term}
      </span>
      {open && (
        <span className="absolute z-50 bottom-full left-0 mb-2 w-64 bg-popover border border-border rounded-lg px-3 py-2 text-[11px] text-muted-foreground shadow-lg pointer-events-none">
          {def}
        </span>
      )}
    </span>
  );
}

export default function CleanEvents() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [showGlossary, setShowGlossary] = useState(false);
  const [expandedCfn, setExpandedCfn] = useState<string | null>(null);

  const qs = `?assignor=${encodeURIComponent(applied.assignor)}&assignee=${encodeURIComponent(applied.assignee)}&start_date=${applied.start_date}&end_date=${applied.end_date}&txn_type=${applied.txn_type}&page=${page}&limit=50`;

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['/api/clean-events', qs],
    queryFn: () => apiRequest('GET', `/api/clean-events${qs}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });

  const apply = () => { setApplied(draft); setPage(1); };
  const clear  = () => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); };
  const hasFilters = Object.values(applied).some(Boolean);

  return (
    <div className="p-6 space-y-4 max-w-screen-xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle size={16} className="text-green-400" />
            <h1 className="text-xl font-semibold">Clean Transactions</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data
              ? `${data.total.toLocaleString()} deduplicated mortgage assignment events · Jan 2025 – present`
              : 'Loading…'}
            {isFetching && !isLoading && <span className="ml-2 text-primary animate-pulse">Updating…</span>}
          </p>
        </div>
        <button
          onClick={() => setShowGlossary(g => !g)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors"
        >
          <Info size={12} />
          How to read this
        </button>
      </div>

      {/* ── "How to read this" explainer ────────────────────────────────── */}
      {showGlossary && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-4 text-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground">Understanding this table</h2>
            <button onClick={() => setShowGlossary(false)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
          </div>

          {/* What is an AOM */}
          <div className="space-y-1">
            <p className="font-medium text-foreground">What is an Assignment of Mortgage (AOM)?</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              When a lender sells or transfers ownership of a mortgage, they record an Assignment of Mortgage with the
              county clerk. This table shows every such transfer in Miami-Dade County. Each row represents one real
              estate loan changing hands between two entities.
            </p>
          </div>

          {/* Direction */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-muted/20 rounded-lg p-3 space-y-1.5">
              <div className="flex items-center gap-2 font-medium text-orange-400">
                <TrendingUp size={13} />
                Assignor (Seller / Transferor)
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The entity <strong className="text-foreground">giving up</strong> the mortgage — typically the current
                servicer or note holder. They are transferring their interest in the loan.
              </p>
              <p className="text-xs text-muted-foreground">
                Example: <span className="text-foreground font-mono">WELLS FARGO</span> offloading servicing rights.
              </p>
            </div>
            <div className="bg-muted/20 rounded-lg p-3 space-y-1.5">
              <div className="flex items-center gap-2 font-medium text-blue-400">
                <TrendingDown size={13} />
                Assignee (Buyer / Transferee)
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The entity <strong className="text-foreground">receiving</strong> the mortgage — the new note holder or
                servicer. Private credit funds often appear here as acquirers of distressed or non-performing loans.
              </p>
              <p className="text-xs text-muted-foreground">
                Example: <span className="text-foreground font-mono">US BANK</span> acting as trustee for an MBS pool.
              </p>
            </div>
          </div>

          {/* Columns */}
          <div className="space-y-2">
            <p className="font-medium text-foreground">Column guide</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-muted-foreground">
              <div><span className="text-foreground font-medium">CFN</span> — Clerk's File Number, the unique record ID. Click to look up on Miami-Dade clerk portal.</div>
              <div><span className="text-foreground font-medium">Date</span> — Date the assignment was recorded with the county.</div>
              <div><span className="text-foreground font-medium">Canonical name</span> — Normalized version (suffixes stripped, brand aliases unified). The smaller grey text below is the original raw name from the filing.</div>
              <div><span className="text-foreground font-medium">Category badge</span> — Entity type: BANK, SERVICER, PRIVATE CREDIT, GSE, MERS, or OTHER.</div>
              <div><span className="text-foreground font-medium">Type</span> — Transaction classification: <em>Market Transfer</em> (institution→institution), <em>Origination</em> (individual→institution), <em>MERS Release</em>, <em>Self-Assign</em> (administrative noise), <em>Inst. Out</em> (institution→individual), or <em>Private</em> (individual→individual).</div>
              <div><span className="text-foreground font-medium">Parties</span> — Total parties on the original filing. Multi-party filings (e.g. 3–4) indicate complex structures; this table collapses them to their dominant direction.</div>
              <div><span className="text-foreground font-medium">Book / Page</span> — Official recording reference in Miami-Dade's instrument index.</div>
            </div>
          </div>

          {/* Dedup note */}
          <div className="flex items-start gap-2 bg-green-900/10 border border-green-800/30 rounded-lg px-3 py-2 text-xs text-green-400">
            <CheckCircle size={12} className="mt-0.5 shrink-0" />
            <span>
              This view is <strong>deduplicated</strong> — one row per CFN. Raw filings often contain mirror entries
              (both sides of a transfer recorded separately). See <strong>Raw Assignments</strong> for unmodified records.
            </span>
          </div>
        </div>
      )}

      {/* ── Compact notice when glossary is hidden ───────────────────────── */}
      {!showGlossary && (
        <div className="flex items-start gap-2 bg-muted/20 border border-border/50 rounded-lg px-4 py-2.5 text-xs text-muted-foreground">
          <CheckCircle size={12} className="mt-0.5 shrink-0 text-green-400" />
          <span>
            One row = one real mortgage transfer event. Assignor → <ArrowRight size={10} className="inline mx-0.5" /> Assignee.
            Entity names are normalized (typos corrected, suffixes removed). Multi-party filings collapsed to dominant direction.{' '}
            <span className="text-primary/80">Click any row to see a plain-language explanation of the transaction.</span>
            <button onClick={() => setShowGlossary(true)} className="ml-1.5 underline hover:text-foreground transition-colors">Learn more</button>
          </span>
        </div>
      )}

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <TrendingUp size={10} className="text-orange-400" />
              Assignor (Seller)
            </label>
            <Input placeholder="e.g. WELLS FARGO" value={draft.assignor}
              onChange={e => setDraft(p => ({ ...p, assignor: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && apply()}
              className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium flex items-center gap-1">
              <TrendingDown size={10} className="text-blue-400" />
              Assignee (Buyer)
            </label>
            <Input placeholder="e.g. US BANK" value={draft.assignee}
              onChange={e => setDraft(p => ({ ...p, assignee: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && apply()}
              className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date From</label>
            <Input type="date" value={draft.start_date}
              onChange={e => setDraft(p => ({ ...p, start_date: e.target.value }))}
              className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date To</label>
            <Input type="date" value={draft.end_date}
              onChange={e => setDraft(p => ({ ...p, end_date: e.target.value }))}
              className="h-8 text-sm" />
          </div>
        </div>
        {/* Transaction type quick-filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground flex items-center gap-1 mr-1">
            <Filter size={10} />
            Transaction type:
          </span>
          <button
            onClick={() => setDraft(p => ({ ...p, txn_type: '' }))}
            className={`h-7 px-2.5 rounded-full border text-[11px] font-medium transition-colors ${!draft.txn_type ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'}`}
          >All</button>
          {Object.entries(TXN_TYPES).map(([key, meta]) => (
            <button
              key={key}
              onClick={() => setDraft(p => ({ ...p, txn_type: p.txn_type === key ? '' : key }))}
              className={`h-7 px-2.5 rounded-full border text-[11px] font-medium transition-colors ${draft.txn_type === key ? meta.color + ' border-current' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'}`}
              title={meta.desc}
            >{meta.label}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={apply} className="h-8"><Search size={13} className="mr-1.5" />Search</Button>
          {hasFilters && <Button size="sm" variant="ghost" onClick={clear} className="h-8 text-muted-foreground"><X size={13} className="mr-1.5" />Clear</Button>}
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                <th className="px-3 py-2.5 text-left font-medium">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1">
                    <TrendingUp size={10} className="text-orange-400" />
                    Assignor <span className="text-muted-foreground/60 font-normal">(Seller)</span>
                  </span>
                </th>
                <th className="px-3 py-2.5 text-center font-medium w-6"></th>
                <th className="px-3 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1">
                    <TrendingDown size={10} className="text-blue-400" />
                    Assignee <span className="text-muted-foreground/60 font-normal">(Buyer)</span>
                  </span>
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Type</th>
                <th className="px-3 py-2.5 text-center font-medium">
                  <span className="flex items-center justify-center gap-1" title="Total parties on the filing">
                    <Users size={10} />
                    Parties
                  </span>
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Book / Page</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(15).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(8).fill(0).map((_, j) => <td key={j} className="px-3 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).flatMap((r: any, i: number) => {
                    const isExpanded = expandedCfn === r.cfn;
                    return [
                      <tr
                        key={`${r.cfn}-${i}`}
                        className={`border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer group ${isExpanded ? 'bg-muted/20' : ''}`}
                        onClick={() => setExpandedCfn(isExpanded ? null : r.cfn)}
                        title="Click to see transaction explanation"
                      >
                        {/* Expand toggle */}
                        <td className="px-3 py-2 font-mono text-primary text-[11px] whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground/30 group-hover:text-muted-foreground/70 transition-colors">
                              {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </span>
                            <span className="hover:underline" onClick={e => e.stopPropagation()}>
                              <a
                                href={`https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${r.rec_book}&sBookType=O+&sPage=${r.rec_page}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="View on Miami-Dade Clerk portal"
                              >
                                {r.cfn}
                              </a>
                            </span>
                          </div>
                        </td>
                        {/* Date */}
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        {/* Assignor */}
                        <td className="px-3 py-2 max-w-[200px]">
                          <div className="font-semibold text-foreground truncate" title={r.assignor_canon}>{r.assignor_canon}</div>
                          {r.assignor !== r.assignor_canon && (
                            <div className="text-muted-foreground truncate text-[10px]" title={r.assignor}>{r.assignor}</div>
                          )}
                          <CategoryBadge category={r.assignor_type} size="xs" />
                        </td>
                        {/* Arrow */}
                        <td className="px-1 py-2 text-center">
                          <ArrowRight size={12} className="text-muted-foreground/40 mx-auto" />
                        </td>
                        {/* Assignee */}
                        <td className="px-3 py-2 max-w-[200px]">
                          <div className="font-semibold text-foreground truncate" title={r.assignee_canon}>{r.assignee_canon}</div>
                          {r.assignee !== r.assignee_canon && (
                            <div className="text-muted-foreground truncate text-[10px]" title={r.assignee}>{r.assignee}</div>
                          )}
                          <CategoryBadge category={r.assignee_type} size="xs" />
                        </td>
                        {/* Txn type */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.txn_type ? <TxnTypeBadge type={r.txn_type} /> : null}
                        </td>
                        {/* Parties */}
                        <td className="px-3 py-2 text-center">
                          {r.total_parties > 2
                            ? <span className="text-amber-400 font-mono" title={`${r.total_parties} parties on original filing`}>{r.total_parties}</span>
                            : <span className="text-muted-foreground">{r.total_parties}</span>}
                        </td>
                        {/* Book/Page */}
                        <td className="px-3 py-2 font-mono text-muted-foreground text-[11px] whitespace-nowrap">{r.rec_book}/{r.rec_page}</td>
                      </tr>,
                      ...(isExpanded ? [<TransactionDetail key={`${r.cfn}-detail`} row={r} />] : []),
                    ];
                  })
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
              Showing {((page-1)*50)+1}–{Math.min(page*50, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={page<=1} onClick={() => setPage(1)} className="h-7 px-2 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={page<=1} onClick={() => setPage(p=>p-1)} className="h-7 w-7 p-0"><ChevronLeft size={14}/></Button>
              <span className="text-xs text-muted-foreground px-2">{page} / {data.pages.toLocaleString()}</span>
              <Button size="sm" variant="ghost" disabled={page>=data.pages} onClick={() => setPage(p=>p+1)} className="h-7 w-7 p-0"><ChevronRight size={14}/></Button>
              <Button size="sm" variant="ghost" disabled={page>=data.pages} onClick={() => setPage(data.pages)} className="h-7 px-2 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
