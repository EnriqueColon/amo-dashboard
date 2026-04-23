import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

const CATEGORIES = [
  { value: 'PRIVATE_CREDIT', label: 'Private Credit' },
  { value: 'BANK',           label: 'Bank' },
  { value: 'GSE',            label: 'GSE' },
  { value: 'SERVICER',       label: 'Servicer' },
  { value: 'MERS',           label: 'MERS' },
  { value: 'OTHER',          label: 'Other' },
];

interface Filters {
  grantor: string;
  grantee: string;
  start_date: string;
  end_date: string;
  categories: string[]; // multi-select
}

const EMPTY_FILTERS: Filters = { grantor: '', grantee: '', start_date: '', end_date: '', categories: [] };

function buildQS(filters: Filters, page: number, limit = 50) {
  const q = new URLSearchParams();
  if (filters.grantor)    q.set('grantor', filters.grantor);
  if (filters.grantee)    q.set('grantee', filters.grantee);
  if (filters.start_date) q.set('start_date', filters.start_date);
  if (filters.end_date)   q.set('end_date', filters.end_date);
  // Send each selected category — backend will handle OR logic
  filters.categories.forEach(c => q.append('category', c));
  q.set('page', String(page));
  q.set('limit', String(limit));
  return `?${q}`;
}

export default function Assignments() {
  // Draft state (what user is typing)
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  // Applied state (what the query actually uses)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const qs = buildQS(applied, page);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['/api/assignments', qs],
    queryFn: () => apiRequest('GET', `/api/assignments${qs}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });

  const applyFilters = useCallback(() => {
    setApplied(draft);
    setPage(1);
  }, [draft]);

  const clearFilters = useCallback(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  }, []);

  function toggleCategory(cat: string) {
    setDraft(prev => ({
      ...prev,
      categories: prev.categories.includes(cat)
        ? prev.categories.filter(c => c !== cat)
        : [...prev.categories, cat],
    }));
  }

  const hasApplied = applied.grantor || applied.grantee || applied.start_date || applied.end_date || applied.categories.length > 0;

  return (
    <div className="p-6 space-y-4 max-w-screen-xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Raw Assignments</h1>
          <span className="text-[10px] font-semibold bg-amber-900/30 text-amber-400 border border-amber-800/40 rounded-full px-2 py-0.5">INCLUDES MIRROR ENTRIES</span>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {data
            ? `${data.total.toLocaleString()} records${hasApplied ? ' (filtered)' : ''} · page ${page} of ${data.pages.toLocaleString()}`
            : 'Loading...'}
          {isFetching && !isLoading && <span className="ml-2 text-primary animate-pulse">Updating…</span>}
        </p>
      </div>

      {/* Filter panel */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        {/* Text + date inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Grantor (Assignor)</label>
            <Input
              data-testid="filter-grantor"
              placeholder="e.g. WELLS FARGO"
              value={draft.grantor}
              onChange={e => setDraft(p => ({ ...p, grantor: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && applyFilters()}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Grantee (Assignee)</label>
            <Input
              data-testid="filter-grantee"
              placeholder="e.g. NEWREZ LLC"
              value={draft.grantee}
              onChange={e => setDraft(p => ({ ...p, grantee: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && applyFilters()}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date From</label>
            <Input
              data-testid="filter-start"
              type="date"
              value={draft.start_date}
              onChange={e => setDraft(p => ({ ...p, start_date: e.target.value }))}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Date To</label>
            <Input
              data-testid="filter-end"
              type="date"
              value={draft.end_date}
              onChange={e => setDraft(p => ({ ...p, end_date: e.target.value }))}
              className="h-8 text-sm"
            />
          </div>
        </div>

        {/* Category multi-select toggles */}
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground font-medium">Entity Category (select one or more)</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(({ value, label }) => {
              const active = draft.categories.includes(value);
              return (
                <button
                  key={value}
                  data-testid={`cat-toggle-${value}`}
                  onClick={() => toggleCategory(value)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer
                    ${active
                      ? `cat-${value} border-current ring-1 ring-current ring-offset-1 ring-offset-card`
                      : 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground'
                    }`}
                >
                  {active && <span className="mr-1">✓</span>}{label}
                </button>
              );
            })}
            {draft.categories.length > 0 && (
              <button
                onClick={() => setDraft(p => ({ ...p, categories: [] }))}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-full transition-colors"
              >
                Clear categories
              </button>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            data-testid="btn-apply"
            size="sm"
            onClick={applyFilters}
            className="h-8"
          >
            <Search size={13} className="mr-1.5" />
            Search
          </Button>
          {hasApplied && (
            <Button
              data-testid="btn-clear"
              size="sm"
              variant="ghost"
              onClick={clearFilters}
              className="h-8 text-muted-foreground"
            >
              <X size={13} className="mr-1.5" />
              Clear all filters
            </Button>
          )}
        </div>
      </div>

      {/* Results table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                <th className="px-3 py-2.5 text-left font-medium">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">Grantor (Assignor)</th>
                <th className="px-3 py-2.5 text-left font-medium">Grantee (Assignee)</th>
                <th className="px-3 py-2.5 text-left font-medium">Address</th>
                <th className="px-3 py-2.5 text-left font-medium">Book / Page</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(15).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(6).fill(0).map((_, j) => (
                        <td key={j} className="px-3 py-2.5">
                          <Skeleton className="h-3 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any, idx: number) => (
                    <tr
                      key={`${r.cfn}-${idx}`}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-3 py-2 font-mono text-primary whitespace-nowrap text-[11px]">{r.cfn}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="truncate font-medium" title={r.grantor}>{r.grantor}</div>
                        <CategoryBadge category={r.grantor_category} size="xs" />
                      </td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="truncate font-medium" title={r.grantee}>{r.grantee}</div>
                        <CategoryBadge category={r.grantee_category} size="xs" />
                      </td>
                      <td className="px-3 py-2 max-w-[220px] truncate text-muted-foreground" title={r.address}>
                        {r.address || '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground font-mono text-[11px]">
                        {r.rec_book}/{r.rec_page}
                      </td>
                    </tr>
                  ))
              }
              {!isLoading && data?.rows?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center text-muted-foreground">
                    No records found. Try adjusting your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Showing {((page - 1) * 50) + 1}–{Math.min(page * 50, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm" variant="ghost"
                disabled={page <= 1}
                onClick={() => { setPage(1); }}
                className="h-7 px-2 text-xs"
              >
                First
              </Button>
              <Button
                size="sm" variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="h-7 w-7 p-0"
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-xs text-muted-foreground px-2">
                {page} / {data.pages.toLocaleString()}
              </span>
              <Button
                size="sm" variant="ghost"
                disabled={page >= data.pages}
                onClick={() => setPage(p => p + 1)}
                className="h-7 w-7 p-0"
              >
                <ChevronRight size={14} />
              </Button>
              <Button
                size="sm" variant="ghost"
                disabled={page >= data.pages}
                onClick={() => setPage(data.pages)}
                className="h-7 px-2 text-xs"
              >
                Last
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
