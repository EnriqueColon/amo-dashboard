import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import {
  ChevronLeft, ChevronRight, Search, X, CheckCircle,
  ArrowRight, Info, TrendingUp, TrendingDown, Users,
} from 'lucide-react';

interface Filters { assignor: string; assignee: string; start_date: string; end_date: string; }
const EMPTY: Filters = { assignor: '', assignee: '', start_date: '', end_date: '' };

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

  const qs = `?assignor=${encodeURIComponent(applied.assignor)}&assignee=${encodeURIComponent(applied.assignee)}&start_date=${applied.start_date}&end_date=${applied.end_date}&page=${page}&limit=50`;

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
            Entity names are normalized (typos corrected, suffixes removed). Multi-party filings collapsed to dominant direction.
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
                      {Array(7).fill(0).map((_, j) => <td key={j} className="px-3 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any, i: number) => (
                    <tr key={`${r.cfn}-${i}`} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                      {/* CFN */}
                      <td className="px-3 py-2 font-mono text-primary text-[11px] whitespace-nowrap">
                        <a
                          href={`https://www2.miamidadeclerk.gov/ocs/Search.aspx?QS=RN${r.cfn}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                          title="View on Miami-Dade Clerk portal"
                        >
                          {r.cfn}
                        </a>
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
                      {/* Parties */}
                      <td className="px-3 py-2 text-center">
                        {r.total_parties > 2
                          ? <span className="text-amber-400 font-mono" title={`${r.total_parties} parties on original filing`}>{r.total_parties}</span>
                          : <span className="text-muted-foreground">{r.total_parties}</span>}
                      </td>
                      {/* Book/Page */}
                      <td className="px-3 py-2 font-mono text-muted-foreground text-[11px] whitespace-nowrap">{r.rec_book}/{r.rec_page}</td>
                    </tr>
                  ))
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={7} className="px-3 py-12 text-center text-muted-foreground">No records found.</td></tr>
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
