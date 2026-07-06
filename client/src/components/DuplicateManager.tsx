import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import { useToast } from '@/hooks/use-toast';
import {
  GitMerge, X, Check, Search, ChevronDown, ChevronUp, Undo2, Sparkles, Layers,
} from 'lucide-react';

type SuggestionEntity = { entity: string; entity_type: string; total_vol: number };
type Suggestion = {
  key: string;
  reason: 'variant' | 'truncation';
  entities: SuggestionEntity[];
  suggested_canonical: string;
  combined_vol: number;
};
type AliasRow = {
  variant: string; canonical: string; created_at: string | null;
  canonical_vol: number | null; canonical_type: string | null;
};

const ENTITY_QUERIES = ['/api/entity-nodes', '/api/aliases', '/api/aliases/suggestions', '/api/targets', '/api/stats'];

export default function DuplicateManager() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'suggestions' | 'merged' | 'manual'>('suggestions');
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: suggData, isLoading: suggLoading } = useQuery({
    queryKey: ['/api/aliases/suggestions'],
    queryFn: () => apiRequest('GET', '/api/aliases/suggestions').then(r => r.json()),
  });
  const { data: aliases } = useQuery({
    queryKey: ['/api/aliases'],
    queryFn: () => apiRequest('GET', '/api/aliases').then(r => r.json()),
  });

  const suggestions: Suggestion[] = suggData?.suggestions || [];
  const variantCount = suggData?.counts?.variant ?? 0;
  const mergedCount = (aliases || []).length;

  const invalidateAll = () => {
    ENTITY_QUERIES.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
    qc.invalidateQueries({ queryKey: ['/api/reporting'] });
  };

  const mergeMutation = useMutation({
    mutationFn: (body: { canonical: string; variants: string[] }) =>
      apiRequest('POST', '/api/aliases/merge', body).then(r => {
        if (!r.ok) throw new Error('Merge failed');
        return r.json();
      }),
    onSuccess: (data) => {
      invalidateAll();
      toast({ title: 'Entities merged', description: `${data.merged.length} variant${data.merged.length > 1 ? 's' : ''} merged into ${data.canonical}` });
    },
    onError: () => toast({ title: 'Merge failed', description: 'Could not merge entities — check the server logs.', variant: 'destructive' }),
  });

  const dismissMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest('POST', '/api/aliases/suggestions/dismiss', { key }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/aliases/suggestions'] }),
  });

  const unmergeMutation = useMutation({
    mutationFn: (variant: string) =>
      apiRequest('DELETE', `/api/aliases/${encodeURIComponent(variant)}`).then(r => r.json()),
    onSuccess: () => {
      invalidateAll();
      toast({ title: 'Merge rule removed', description: 'Historical rows revert on the next data rebuild.' });
    },
  });

  const bulkAcceptVariants = async () => {
    const safe = suggestions.filter(s => s.reason === 'variant');
    if (safe.length === 0) return;
    for (const s of safe) {
      await mergeMutation.mutateAsync({
        canonical: s.suggested_canonical,
        variants: s.entities.map(e => e.entity).filter(e => e !== s.suggested_canonical),
      });
    }
    toast({ title: 'Bulk merge complete', description: `${safe.length} exact-variant clusters merged.` });
  };

  const busy = mergeMutation.isPending || dismissMutation.isPending || unmergeMutation.isPending;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <GitMerge size={14} className="text-primary" />
          Duplicate Manager
          {!suggLoading && suggestions.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 text-[10px] font-semibold">
              {suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''}
            </span>
          )}
          {mergedCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold">
              {mergedCount} merged
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {open ? 'Hide' : 'Review'}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* View pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              ['suggestions', `Suggestions (${suggestions.length})`],
              ['merged', `Merged (${mergedCount})`],
              ['manual', 'Manual merge'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors
                  ${view === id
                    ? 'bg-primary/20 text-primary border-primary/40'
                    : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
            {view === 'suggestions' && variantCount > 0 && (
              <button
                onClick={bulkAcceptVariants}
                disabled={busy}
                className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-emerald-600/15 text-emerald-600 border border-emerald-600/30 hover:bg-emerald-600/25 transition-colors disabled:opacity-50"
              >
                <Sparkles size={11} />
                Merge all {variantCount} exact variants
              </button>
            )}
          </div>

          {view === 'suggestions' && (
            <SuggestionList
              suggestions={suggestions}
              loading={suggLoading}
              busy={busy}
              onMerge={(canonical, variants) => mergeMutation.mutate({ canonical, variants })}
              onDismiss={key => dismissMutation.mutate(key)}
            />
          )}
          {view === 'merged' && (
            <MergedList aliases={aliases || []} busy={busy} onUnmerge={v => unmergeMutation.mutate(v)} />
          )}
          {view === 'manual' && (
            <ManualMerge busy={busy} onMerge={(canonical, variants) => mergeMutation.mutate({ canonical, variants })} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Suggestions queue ────────────────────────────────────────────────────────

function SuggestionList({ suggestions, loading, busy, onMerge, onDismiss }: {
  suggestions: Suggestion[];
  loading: boolean;
  busy: boolean;
  onMerge: (canonical: string, variants: string[]) => void;
  onDismiss: (key: string) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});

  if (loading) {
    return <div className="space-y-2">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  }
  if (suggestions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        No duplicate candidates found — the entity list is clean.
      </p>
    );
  }

  return (
    <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
      {suggestions.map(s => {
        const canonical = picks[s.key] || s.suggested_canonical;
        const variants = s.entities.map(e => e.entity).filter(e => e !== canonical);
        return (
          <div key={s.key} className="border border-border/70 rounded-md px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
                ${s.reason === 'variant' ? 'bg-emerald-600/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'}`}>
                {s.reason === 'variant' ? 'Exact variant' : 'Possible truncation'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onMerge(canonical, variants)}
                  disabled={busy}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors disabled:opacity-50"
                >
                  <Check size={10} /> Merge
                </button>
                <button
                  onClick={() => onDismiss(s.key)}
                  disabled={busy}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <X size={10} /> Not a duplicate
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {s.entities.map(e => (
                <label key={e.entity} className="flex items-center gap-2 text-xs cursor-pointer group">
                  <input
                    type="radio"
                    name={`canon-${s.key}`}
                    checked={canonical === e.entity}
                    onChange={() => setPicks(p => ({ ...p, [s.key]: e.entity }))}
                    className="accent-[hsl(var(--primary))]"
                  />
                  <span className={`font-medium ${canonical === e.entity ? 'text-primary' : 'group-hover:text-foreground'}`}>
                    {e.entity}
                  </span>
                  <CategoryBadge category={e.entity_type} size="xs" />
                  <span className="font-mono text-muted-foreground">{e.total_vol.toLocaleString()} txns</span>
                  {canonical === e.entity && <span className="text-[10px] text-primary">← keep this name</span>}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Existing merges ──────────────────────────────────────────────────────────

function MergedList({ aliases, busy, onUnmerge }: {
  aliases: AliasRow[];
  busy: boolean;
  onUnmerge: (variant: string) => void;
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, AliasRow[]>();
    for (const a of aliases) {
      if (!m.has(a.canonical)) m.set(a.canonical, []);
      m.get(a.canonical)!.push(a);
    }
    return Array.from(m.entries());
  }, [aliases]);

  if (aliases.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No merges recorded yet.</p>;
  }

  return (
    <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
      {grouped.map(([canonical, rows]) => (
        <div key={canonical} className="border border-border/70 rounded-md px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold mb-1.5">
            <Layers size={11} className="text-primary" />
            {canonical}
            {rows[0].canonical_type && <CategoryBadge category={rows[0].canonical_type} size="xs" />}
            {rows[0].canonical_vol != null && (
              <span className="font-mono font-normal text-muted-foreground">{rows[0].canonical_vol.toLocaleString()} txns</span>
            )}
          </div>
          <div className="space-y-1">
            {rows.map(r => (
              <div key={r.variant} className="flex items-center justify-between text-xs pl-4">
                <span className="text-muted-foreground">{r.variant}</span>
                <button
                  onClick={() => onUnmerge(r.variant)}
                  disabled={busy}
                  title="Remove this merge rule (data reverts on next rebuild)"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-50"
                >
                  <Undo2 size={9} /> Unmerge
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Manual merge tool ────────────────────────────────────────────────────────

function ManualMerge({ busy, onMerge }: {
  busy: boolean;
  onMerge: (canonical: string, variants: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [canonical, setCanonical] = useState('');

  const { data: nodes } = useQuery({
    queryKey: ['/api/entity-nodes'],
    queryFn: () => apiRequest('GET', '/api/entity-nodes?limit=5000').then(r => r.json()),
  });

  const results = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toUpperCase();
    return (nodes || [])
      .filter((n: any) => n.entity.includes(q) && !selected.includes(n.entity))
      .slice(0, 8);
  }, [search, nodes, selected]);

  const add = (entity: string) => {
    setSelected(s => [...s, entity]);
    if (!canonical) setCanonical(entity);
    setSearch('');
  };
  const remove = (entity: string) => {
    setSelected(s => s.filter(e => e !== entity));
    if (canonical === entity) setCanonical('');
  };
  const submit = () => {
    const variants = selected.filter(e => e !== canonical);
    if (canonical && variants.length > 0) {
      onMerge(canonical, variants);
      setSelected([]);
      setCanonical('');
    }
  };

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] text-muted-foreground">
        Search and select two or more entities, choose which name to keep, then merge.
        All history, watchlist entries and reports are updated immediately.
      </p>
      <div className="relative max-w-sm">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search entity to add…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-8 text-sm pl-8"
        />
        {results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-popover border border-border rounded-md shadow-lg overflow-hidden">
            {results.map((n: any) => (
              <button
                key={n.entity}
                onClick={() => add(n.entity)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/40 transition-colors"
              >
                <span className="font-medium truncate">{n.entity}</span>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">{n.total_vol.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="space-y-1">
          {selected.map(e => (
            <label key={e} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="radio"
                name="manual-canon"
                checked={canonical === e}
                onChange={() => setCanonical(e)}
                className="accent-[hsl(var(--primary))]"
              />
              <span className={canonical === e ? 'text-primary font-medium' : ''}>{e}</span>
              {canonical === e && <span className="text-[10px] text-primary">← keep this name</span>}
              <button onClick={() => remove(e)} className="text-muted-foreground hover:text-destructive">
                <X size={11} />
              </button>
            </label>
          ))}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy || !canonical || selected.length < 2}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40"
      >
        <GitMerge size={11} />
        Merge {selected.length >= 2 ? `${selected.length - 1} into ${canonical || '…'}` : 'entities'}
      </button>
    </div>
  );
}
