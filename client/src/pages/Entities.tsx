import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import EntityDetailPanel from '@/components/EntityDetailPanel';
import { Search, ChevronRight, Info, Network } from 'lucide-react';

const TYPE_FILTERS = ['', 'BANK', 'PRIVATE_CREDIT', 'TRUST', 'GSE', 'SERVICER', 'MERS', 'OTHER'];

export default function Entities() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  // Canonical network entities — the only ones with transaction data
  const { data: nodes, isLoading } = useQuery({
    queryKey: ['/api/entity-nodes'],
    queryFn: () => apiRequest('GET', '/api/entity-nodes?limit=5000').then(r => r.json()),
  });

  const filtered = (nodes || []).filter((e: any) => {
    const matchesSearch = !search || e.entity.toLowerCase().includes(search.toLowerCase());
    const matchesType  = !typeFilter || e.entity_type === typeFilter;
    return matchesSearch && matchesType;
  });

  return (
    <>
      <div className="p-6 space-y-4 max-w-screen-xl mx-auto">

        {/* Header */}
        <div>
          <div className="flex items-center gap-2">
            <Network size={16} className="text-purple-400" />
            <h1 className="text-xl font-semibold">Entities</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? 'Loading…' : `${filtered.length.toLocaleString()} of ${(nodes || []).length.toLocaleString()} canonical entities`}
            {' · '}
            <span className="text-primary">click any row</span> to view their mortgage transactions
          </p>
        </div>

        {/* Info tip */}
        <div className="flex items-start gap-2 bg-muted/20 border border-border/50 rounded-lg px-4 py-2.5 text-xs text-muted-foreground">
          <Info size={12} className="shrink-0 text-primary mt-0.5" />
          <span>
            These are <strong className="text-foreground">canonical entities</strong> — normalized names derived from deduplicated transaction data.
            Each entity maps directly to clean AOM records. Click any row to see their full transaction history: what was assigned to them, what they assigned out, and to whom.
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search entity name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 text-sm pl-8"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {TYPE_FILTERS.map(t => (
              <button
                key={t || 'all'}
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors
                  ${typeFilter === t
                    ? 'bg-primary/20 text-primary border-primary/40'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80'
                  }`}
              >
                {t ? t.replace('_', ' ') : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-border bg-muted/20">
                <tr className="text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">Entity (Canonical)</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    <span className="text-orange-600">Received</span>
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    <span className="text-blue-600">Assigned</span>
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    <span className="text-purple-600">Counterparties</span>
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium pl-4">Active Period</th>
                  <th className="px-3 py-2.5 text-right font-medium pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array(15).fill(0).map((_, i) => (
                      <tr key={i} className="border-b border-border/50">
                        {Array(7).fill(0).map((_, j) => (
                          <td key={j} className="px-3 py-2.5">
                            <Skeleton className="h-3 w-full" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : filtered.map((e: any) => (
                      <tr
                        key={e.entity}
                        onClick={() => setSelected(e.entity)}
                        className="border-b border-border/50 hover:bg-muted/20 cursor-pointer group transition-colors"
                      >
                        <td className="px-3 py-2.5 font-medium max-w-[260px]">
                          <span
                            className="group-hover:text-primary transition-colors truncate block"
                            title={e.entity}
                          >
                            {e.entity}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <CategoryBadge category={e.entity_type} size="xs" />
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-orange-600">
                          {e.inbound_vol.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-blue-600">
                          {e.outbound_vol.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-purple-600">
                          {e.degree.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 pl-4 text-muted-foreground whitespace-nowrap">
                          {e.first_seen} → {e.last_seen}
                        </td>
                        <td className="px-3 py-2.5 text-right pr-4">
                          <ChevronRight
                            size={13}
                            className="ml-auto text-muted-foreground/40 group-hover:text-primary transition-colors"
                          />
                        </td>
                      </tr>
                    ))
                }
                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                      No entities found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer summary */}
          {!isLoading && filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/10 text-xs text-muted-foreground">
              <span>
                Showing {filtered.length.toLocaleString()} entities
                {typeFilter && ` · filtered by ${typeFilter.replace('_', ' ')}`}
                {search && ` · matching "${search}"`}
              </span>
              <span>
                Total received: <span className="text-orange-600 font-mono">
                  {filtered.reduce((s: number, e: any) => s + e.inbound_vol, 0).toLocaleString()}
                </span>
                {' · '}
                Total assigned: <span className="text-blue-600 font-mono">
                  {filtered.reduce((s: number, e: any) => s + e.outbound_vol, 0).toLocaleString()}
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Entity Detail Slide-in Panel */}
      {selected && (
        <EntityDetailPanel
          entityName={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
