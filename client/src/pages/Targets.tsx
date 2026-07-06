import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Crosshair, Search, Plus, Trash2, LayoutList, ArrowUpRight,
} from 'lucide-react';

const TYPE_COLOR: Record<string, string> = {
  BANK:           'text-blue-600',
  SERVICER:       'text-purple-600',
  PRIVATE_CREDIT: 'text-orange-600',
  GSE:            'text-emerald-600',
  TRUST:          'text-slate-500',
  MERS:           'text-yellow-600',
  OTHER:          'text-muted-foreground',
};

function useDebounced(value: string, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// ── Entity search + add ───────────────────────────────────────────────────────
function EntitySearch({ targeted, onAdd }: { targeted: Set<string>; onAdd: (entity: string) => void }) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim());

  const { data, isFetching } = useQuery({
    queryKey: ['/api/entity-nodes', 'target-search', query],
    queryFn: () => apiRequest('GET', `/api/entity-nodes?q=${encodeURIComponent(query)}&limit=20`).then(r => r.json()),
    enabled: query.length >= 2,
  });

  const results: any[] = query.length >= 2 ? (data || []) : [];

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold flex items-center gap-1.5">
        <Search size={13} className="text-primary" />Add a participant
      </h2>
      <Input
        placeholder="Search entities by name (e.g. JPMORGAN, MERS, KENNEDY FUNDING)…"
        value={q} onChange={e => setQ(e.target.value)} className="h-8 text-xs"
      />
      {query.length >= 2 && (
        <div className="max-h-72 overflow-y-auto divide-y divide-border/40 border border-border/40 rounded-md">
          {isFetching && !data ? (
            <div className="p-3 space-y-2">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
          ) : results.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">No entities match "{query}".</p>
          ) : results.map((r: any) => {
            const already = targeted.has(r.entity);
            return (
              <div key={r.entity} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate" title={r.entity}>{r.entity}</span>
                    {r.entity_type && (
                      <span className={`text-[9px] font-semibold shrink-0 ${TYPE_COLOR[r.entity_type] || 'text-muted-foreground'}`}>
                        {r.entity_type}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {(r.total_vol ?? 0).toLocaleString()} txns · in {(r.inbound_vol ?? 0).toLocaleString()} / out {(r.outbound_vol ?? 0).toLocaleString()}
                    {r.last_seen && <> · last seen {r.last_seen}</>}
                  </div>
                </div>
                <Button size="sm" variant={already ? 'ghost' : 'outline'} disabled={already}
                  onClick={() => onAdd(r.entity)} className="h-6 px-2 text-[10px] gap-1 shrink-0">
                  <Plus size={10} />{already ? 'Added' : 'Add'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {query.length < 2 && (
        <p className="text-[11px] text-muted-foreground">
          Type at least 2 characters to search the entity list. Added participants appear in the watchlist and drive the Reporting tab's "Targets only" view.
        </p>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Targets() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const { data: targets, isLoading } = useQuery({
    queryKey: ['/api/targets'],
    queryFn: () => apiRequest('GET', '/api/targets').then(r => r.json()),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['/api/targets'] });
    qc.invalidateQueries({ queryKey: ['/api/reporting'] });
    qc.invalidateQueries({ queryKey: ['/api/reporting/participants'] });
    qc.invalidateQueries({ queryKey: ['/api/reporting/chart'] });
  };

  const addMutation = useMutation({
    mutationFn: (entity: string) => apiRequest('POST', '/api/targets', { entity }).then(r => r.json()),
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (entity: string) => apiRequest('DELETE', `/api/targets/${encodeURIComponent(entity)}`).then(r => r.json()),
    onSuccess: invalidate,
  });

  const rows: any[] = targets || [];
  const targetedSet = new Set(rows.map((r: any) => r.entity));

  return (
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Crosshair size={15} className="text-primary" />
          <h1 className="text-lg font-semibold">Targets</h1>
          <span className="text-xs text-muted-foreground ml-1">
            {rows.length} participant{rows.length === 1 ? '' : 's'} monitored
          </span>
        </div>
        <Button size="sm" className="h-8 gap-1.5 text-xs" disabled={rows.length === 0}
          onClick={() => navigate('/reporting?targets=1')}>
          <LayoutList size={12} />Generate activity report
        </Button>
      </div>

      <EntitySearch targeted={targetedSet} onAdd={entity => addMutation.mutate(entity)} />

      {/* Watchlist */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Watchlist</h2>
          <p className="text-[11px] text-muted-foreground">
            Activity for these participants is pulled from the clean transactions data. Use "Generate activity report" to see their filings in the Reporting tab.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Entity</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Type</th>
                <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Total Txns</th>
                <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">In / Out</th>
                <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Last 90 Days</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Last Activity</th>
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Added</th>
                <th className="px-3 py-2 text-center font-semibold whitespace-nowrap"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array(4).fill(0).map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array(8).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground text-xs">
                    No targets yet. Search above to add market participants you want to monitor.
                  </td>
                </tr>
              ) : rows.map((r: any, i: number) => (
                <tr key={r.entity} className={`border-b border-border/30 ${i % 2 === 0 ? 'bg-background' : 'bg-muted/10'}`}>
                  <td className="px-3 py-2 max-w-[240px]">
                    <span className="font-medium truncate block" title={r.entity}>{r.entity}</span>
                  </td>
                  <td className={`px-3 py-2 whitespace-nowrap text-[9px] font-semibold ${TYPE_COLOR[r.entity_type] || 'text-muted-foreground'}`}>
                    {r.entity_type || '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {(r.total_vol ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-muted-foreground">
                    ↑{(r.inbound_vol ?? 0).toLocaleString()} ↓{(r.outbound_vol ?? 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {r.txns_90d > 0
                      ? <span className="text-emerald-500 font-semibold">{r.txns_90d.toLocaleString()}</span>
                      : <span className="text-muted-foreground/40">0</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.last_activity || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {r.added_at ? new Date(r.added_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <div className="flex items-center justify-center gap-2">
                      <button onClick={() => navigate(`/reporting?search=${encodeURIComponent(r.entity)}`)}
                        title="View filings in Reporting"
                        className="text-muted-foreground/50 hover:text-primary transition-colors">
                        <ArrowUpRight size={12} />
                      </button>
                      <button onClick={() => removeMutation.mutate(r.entity)} title="Remove from targets"
                        className="text-muted-foreground/40 hover:text-red-400 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
