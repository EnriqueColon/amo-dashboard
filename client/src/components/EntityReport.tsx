import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useCounty, countyLabel } from '@/lib/county';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  X, Plus, LineChart as LineChartIcon, Users, ArrowLeftRight,
  TrendingUp, TrendingDown, Activity, DollarSign,
  LayoutGrid, ArrowLeft, ZoomIn,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell,
} from 'recharts';

const COLORS = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];

const TYPE_COLOR: Record<string, string> = {
  BANK:           'text-blue-600',
  SERVICER:       'text-purple-600',
  PRIVATE_CREDIT: 'text-orange-600',
  GSE:            'text-emerald-600',
  TRUST:          'text-slate-500',
  MERS:           'text-yellow-600',
  OTHER:          'text-muted-foreground',
};

function fmtMoney(v: number | null | undefined): string {
  if (!v || v <= 0) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function useDebounced(value: string, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// ── Bulk paste-a-list resolver panel ─────────────────────────────────────────
// For requests like "run a report on these 29 banks": paste one name per line,
// the server suggests canonical-entity matches per line (confident whole-word
// matches pre-checked, loose substring hits unchecked), confirm, and they all
// become picker chips at once.
type ResolveMatch = { entity: string; entity_type: string | null; total_vol: number; strong: boolean };
type ResolveResult = { input: string; matches: ResolveMatch[] };

function BulkEntityPanel({ selected, onAdd, onClose }: {
  selected: string[];
  onAdd: (entities: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [resolving, setResolving] = useState(false);
  const [results, setResults] = useState<ResolveResult[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const resolve = async () => {
    const names = text.split('\n').map(s => s.replace(/^[\s*\-•·]+/, '').trim()).filter(Boolean);
    if (!names.length) return;
    setResolving(true);
    try {
      const r = await apiRequest('POST', '/api/reporting/resolve-entities', { names }).then(r => r.json());
      const res: ResolveResult[] = r.results || [];
      setResults(res);
      const pre = new Set<string>();
      for (const line of res) for (const m of line.matches) if (m.strong) pre.add(m.entity);
      setChosen(pre);
    } finally {
      setResolving(false);
    }
  };

  const toggle = (entity: string) => setChosen(prev => {
    const next = new Set(prev);
    next.has(entity) ? next.delete(entity) : next.add(entity);
    return next;
  });

  const addable = Array.from(chosen).filter(e => !selected.includes(e));
  const unmatched = (results || []).filter(r => r.matches.length === 0);

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-2">
      {!results ? (
        <>
          <p className="text-[11px] text-muted-foreground">
            Paste a list of names — one per line. Each line is matched against the entities on record; you confirm the matches before anything is added.
          </p>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={'BankUnited\nAmerant Bank\nOcean Bank\n…'}
            rows={6}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid="bulk-entity-textarea"
          />
          <div className="flex items-center gap-1.5">
            <button onClick={resolve} disabled={resolving || !text.trim()}
              className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50">
              {resolving ? 'Matching…' : 'Find matches'}
            </button>
            <button onClick={onClose} className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
            {results.map(line => (
              <div key={line.input} className="text-[11px]">
                <span className="font-medium">{line.input}</span>
                {line.matches.length === 0 && <span className="ml-2 text-amber-600">no match on record</span>}
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {line.matches.map(m => {
                    const on = chosen.has(m.entity);
                    return (
                      <button key={m.entity} onClick={() => toggle(m.entity)}
                        title={`${m.total_vol.toLocaleString()} transactions${m.strong ? '' : ' — loose match, double-check'}`}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${on
                          ? 'bg-primary/10 border-primary/40 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground'}`}>
                        <span className={`w-2.5 h-2.5 rounded-sm border inline-flex items-center justify-center ${on ? 'bg-primary border-primary' : 'border-muted-foreground/40'}`}>
                          {on && <span className="text-primary-foreground text-[8px] leading-none">✓</span>}
                        </span>
                        {m.entity}
                        <span className="text-muted-foreground font-normal">{m.total_vol.toLocaleString()}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {unmatched.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              {unmatched.length} name{unmatched.length === 1 ? ' has' : 's have'} no recorded activity — they can't appear in a report.
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <button onClick={() => { onAdd(addable); onClose(); }} disabled={addable.length === 0}
              className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
              data-testid="bulk-entity-add">
              Add {addable.length} selected
            </button>
            <button onClick={() => { setResults(null); setChosen(new Set()); }}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground">Edit list</button>
            <button onClick={onClose} className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Entity multi-select picker ────────────────────────────────────────────────
const MAX_SELECTED = 120;

export function EntityPicker({ selected, onChange }: {
  selected: string[];
  onChange: (entities: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const query = useDebounced(q.trim());

  const { data } = useQuery({
    queryKey: ['/api/entity-nodes', 'report-picker', query],
    queryFn: () => apiRequest('GET', `/api/entity-nodes?q=${encodeURIComponent(query)}&limit=12`).then(r => r.json()),
    enabled: query.length >= 2,
  });

  const results: any[] = (query.length >= 2 ? (data || []) : []).filter((r: any) => !selected.includes(r.entity));

  const add = (entity: string) => {
    if (!selected.includes(entity) && selected.length < MAX_SELECTED) onChange([...selected, entity]);
    setQ('');
    setOpen(false);
  };

  const addMany = (entities: string[]) => {
    const merged = [...selected];
    for (const e of entities) {
      if (!merged.includes(e) && merged.length < MAX_SELECTED) merged.push(e);
    }
    onChange(merged);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((e, i) => (
          <span key={e}
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 pl-2 pr-1 py-0.5 text-[10px] font-medium"
            style={{ borderColor: `${COLORS[i % COLORS.length]}55`, color: COLORS[i % COLORS.length] }}>
            {e}
            <button onClick={() => onChange(selected.filter(x => x !== e))}
              className="rounded-full hover:bg-muted p-0.5" title={`Remove ${e}`}>
              <X size={9} />
            </button>
          </span>
        ))}
        <div className="relative min-w-[220px] flex-1 max-w-xs">
          <Input placeholder={selected.length ? 'Add another entity…' : 'Report on specific entities…'}
            value={q}
            onChange={e => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            className="h-7 text-xs" />
          {open && query.length >= 2 && (
            <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
              {results.map((r: any) => (
                <button key={r.entity}
                  onMouseDown={e => { e.preventDefault(); add(r.entity); }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50">
                  <Plus size={10} className="shrink-0 text-muted-foreground" />
                  <span className="text-[11px] font-medium truncate flex-1">{r.entity}</span>
                  <span className={`text-[9px] font-semibold shrink-0 ${TYPE_COLOR[r.entity_type] || 'text-muted-foreground'}`}>
                    {r.entity_type}
                  </span>
                  <span className="text-[9px] text-muted-foreground shrink-0">{(r.total_vol ?? 0).toLocaleString()} txns</span>
                </button>
              ))}
              {results.length === 0 && (
                <button onMouseDown={e => { e.preventDefault(); add(query.toUpperCase()); }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50">
                  <Plus size={10} className="shrink-0 text-muted-foreground" />
                  <span className="text-[11px]">Use "<span className="font-medium">{query.toUpperCase()}</span>" as typed</span>
                </button>
              )}
            </div>
          )}
        </div>
        <button onClick={() => setBulkOpen(v => !v)}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
          data-testid="bulk-entity-toggle">
          paste a list
        </button>
        {selected.length > 0 && (
          <button onClick={() => onChange([])}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2">
            clear all
          </button>
        )}
      </div>
      {bulkOpen && (
        <BulkEntityPanel selected={selected} onAdd={addMany} onClose={() => setBulkOpen(false)} />
      )}
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function Kpi({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 flex items-center gap-2.5">
      <div className="rounded-md bg-primary/10 p-1.5 text-primary shrink-0"><Icon size={13} /></div>
      <div className="min-w-0">
        <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider truncate">{label}</p>
        <p className="text-sm font-bold leading-tight">{value}</p>
        {sub && <p className="text-[9px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

// ── Single-entity drill-down ──────────────────────────────────────────────────
function EntityDrilldown({ entity, color, entityType, startDate, endDate, onBack }: {
  entity: string;
  color: string;
  entityType?: string | null;
  startDate: string;
  endDate: string;
  onBack: () => void;
}) {
  const { county } = useCounty();
  const qs = [
    `entities=${encodeURIComponent(entity)}`,
    startDate && `start_date=${startDate}`,
    endDate && `end_date=${endDate}`,
  ].filter(Boolean).join('&');

  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/entity-report', qs],
    queryFn: () => apiRequest('GET', `/api/reporting/entity-report?${qs}`).then(r => r.json()),
  });

  // In/out per month for the two-series timeline
  const timelineData = useMemo(() => {
    if (!data?.timeline) return [];
    const byMonth = new Map<string, any>();
    for (const r of data.timeline) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, { month: r.month, in_count: 0, out_count: 0 });
      const row = byMonth.get(r.month);
      row.in_count += r.in_count;
      row.out_count += r.out_count;
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [data]);

  const k = data?.kpis;
  const net = k ? (k.inbound ?? 0) - (k.outbound ?? 0) : 0;
  const summaryType = entityType ?? data?.summary?.[0]?.entity_type;

  return (
    <div className="space-y-3">
      {/* Print-only header for the focused entity */}
      <div className="hidden print:block border-b border-border pb-2">
        <h1 className="text-base font-bold">AMO Activity Report — {countyLabel(county)}</h1>
        <p className="text-xs">Entity: {entity}</p>
        <p className="text-xs">
          Period: {startDate || 'beginning'} to {endDate || 'present'} · Generated {new Date().toLocaleDateString()}
        </p>
      </div>

      {/* Header + back affordance */}
      <div className="flex items-center gap-2 flex-wrap print:hidden">
        <button onClick={onBack}
          className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft size={10} />All entities
        </button>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
          {entity}
        </span>
        {summaryType && (
          <span className={`text-[9px] font-semibold ${TYPE_COLOR[summaryType] || 'text-muted-foreground'}`}>
            {summaryType}
          </span>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {isLoading || !k ? (
          Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
        ) : (
          <>
            <Kpi icon={Activity} label="Total Transfers" value={(k.total ?? 0).toLocaleString()} />
            <Kpi icon={TrendingDown} label="Acquired (In)" value={(k.inbound ?? 0).toLocaleString()} />
            <Kpi icon={TrendingUp} label="Sold (Out)" value={(k.outbound ?? 0).toLocaleString()} />
            <Kpi icon={ArrowLeftRight} label="Net Direction"
              value={net > 0 ? `+${net.toLocaleString()} net buyer` : net < 0 ? `${net.toLocaleString()} net seller` : 'Balanced'} />
            <Kpi icon={DollarSign} label="$ Volume (where known)" value={fmtMoney(k.dollar_volume)}
              sub={k.dollar_known_count > 0 ? `${k.dollar_known_count.toLocaleString()} filings with $ data` : 'no $ data extracted'} />
          </>
        )}
      </div>

      {/* Timeline — acquisitions vs sales */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <LineChartIcon size={12} className="text-primary" />Activity Timeline
        </h2>
        {isLoading ? <Skeleton className="h-64 w-full" /> : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={timelineData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
              <Tooltip formatter={(v: any) => v.toLocaleString()} />
              <Legend iconSize={9} wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="in_count" name="Acquired (in)" stroke="#3b82f6"
                strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="out_count" name="Sold (out)" stroke="#f97316"
                strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top counterparties */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Users size={12} className="text-primary" />Top Counterparties
        </h2>
        {isLoading ? <Skeleton className="h-48 w-full" /> : (data?.counterparties?.length || 0) === 0 ? (
          <p className="text-xs text-muted-foreground">No counterparties in this period.</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(200, (data?.counterparties?.length || 0) * 24 + 60)}>
            <BarChart data={data?.counterparties || []} layout="vertical" margin={{ top: 0, right: 40, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="counterparty" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={170} />
              <Tooltip formatter={(v: any) => v.toLocaleString()} />
              <Legend iconSize={9} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="sold_to" name="They sold to" stackId="a" fill="#f97316" radius={[0, 0, 0, 0]} maxBarSize={16} />
              <Bar dataKey="bought_from" name="They bought from" stackId="a" fill="#3b82f6" radius={[0, 3, 3, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Report section ────────────────────────────────────────────────────────────
const REPORT_CHARTS = [
  { id: 'timeline',       label: 'Activity Timeline', icon: LineChartIcon },
  { id: 'counterparties', label: 'Counterparties',    icon: Users },
  { id: 'inout',          label: 'Bought vs Sold',    icon: ArrowLeftRight },
];

export function EntityReport({ entities, startDate, endDate }: {
  entities: string[];
  startDate: string;
  endDate: string;
}) {
  const { county } = useCounty();
  const [chart, setChart] = useState('timeline');
  const [timelineMode, setTimelineMode] = useState<'combined' | 'per-entity'>('combined');
  const [focused, setFocused] = useState<string | null>(null);

  // Drop the drill-down if the focused entity is removed from the selection
  useEffect(() => {
    if (focused && !entities.includes(focused)) setFocused(null);
  }, [entities, focused]);

  const qs = [
    ...entities.map(e => `entities=${encodeURIComponent(e)}`),
    startDate && `start_date=${startDate}`,
    endDate && `end_date=${endDate}`,
  ].filter(Boolean).join('&');

  const { data, isLoading } = useQuery({
    queryKey: ['/api/reporting/entity-report', qs],
    queryFn: () => apiRequest('GET', `/api/reporting/entity-report?${qs}`).then(r => r.json()),
    enabled: entities.length > 0,
  });

  // Pivot timeline rows into { month, [entity]: count } for per-entity lines
  const timelineData = useMemo(() => {
    if (!data?.timeline) return [];
    const byMonth = new Map<string, any>();
    for (const r of data.timeline) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, { month: r.month });
      const row = byMonth.get(r.month);
      row[r.entity] = (row[r.entity] || 0) + r.in_count + r.out_count;
      row.__total = (row.__total || 0) + r.in_count + r.out_count;
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [data]);

  // Per-entity series for the small-multiples grid: entity -> [{ month, count }]
  const perEntitySeries = useMemo(() => {
    if (!data?.timeline) return new Map<string, any[]>();
    const byEntity = new Map<string, Map<string, number>>();
    for (const r of data.timeline) {
      if (!byEntity.has(r.entity)) byEntity.set(r.entity, new Map());
      const months = byEntity.get(r.entity)!;
      months.set(r.month, (months.get(r.month) || 0) + r.in_count + r.out_count);
    }
    const out = new Map<string, any[]>();
    byEntity.forEach((months, entity) => {
      out.set(entity, Array.from(months, ([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month)));
    });
    return out;
  }, [data]);

  const perEntityLines = entities.length <= 6;
  const entityColor = (e: string) => COLORS[Math.max(0, entities.indexOf(e)) % COLORS.length];

  if (entities.length === 0) return null;

  if (focused) {
    return (
      <EntityDrilldown
        entity={focused}
        color={entityColor(focused)}
        entityType={data?.summary?.find((s: any) => s.entity === focused)?.entity_type}
        startDate={startDate}
        endDate={endDate}
        onBack={() => setFocused(null)}
      />
    );
  }

  const k = data?.kpis;
  const net = k ? (k.inbound ?? 0) - (k.outbound ?? 0) : 0;
  const showTimelineToggle = entities.length >= 2;
  const perEntityTimeline = showTimelineToggle && timelineMode === 'per-entity';

  return (
    <div className="space-y-3">
      {/* Print-only report header */}
      <div className="hidden print:block border-b border-border pb-2">
        <h1 className="text-base font-bold">AMO Activity Report — {countyLabel(county)}</h1>
        <p className="text-xs">Entities: {entities.join(', ')}</p>
        <p className="text-xs">
          Period: {startDate || 'beginning'} to {endDate || 'present'} · Generated {new Date().toLocaleDateString()}
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {isLoading || !k ? (
          Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
        ) : (
          <>
            <Kpi icon={Activity} label="Total Transfers" value={(k.total ?? 0).toLocaleString()} />
            <Kpi icon={TrendingDown} label="Acquired (In)" value={(k.inbound ?? 0).toLocaleString()} />
            <Kpi icon={TrendingUp} label="Sold (Out)" value={(k.outbound ?? 0).toLocaleString()} />
            <Kpi icon={ArrowLeftRight} label="Net Direction"
              value={net > 0 ? `+${net.toLocaleString()} net buyer` : net < 0 ? `${net.toLocaleString()} net seller` : 'Balanced'} />
            <Kpi icon={DollarSign} label="$ Volume (where known)" value={fmtMoney(k.dollar_volume)}
              sub={k.dollar_known_count > 0 ? `${k.dollar_known_count.toLocaleString()} filings with $ data` : 'no $ data extracted'} />
          </>
        )}
      </div>

      {/* Chart card */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-semibold">Entity Report</h2>
          <div className="flex flex-wrap gap-1 print:hidden">
            {REPORT_CHARTS.map(opt => {
              const Icon = opt.icon;
              const active = chart === opt.id;
              return (
                <button key={opt.id} onClick={() => setChart(opt.id)}
                  className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                  <Icon size={10} />{opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {isLoading ? <Skeleton className="h-64 w-full" /> : chart === 'timeline' ? (
          <div className="space-y-3">
            {showTimelineToggle && (
              <div className="flex justify-end print:hidden">
                <div className="inline-flex rounded border border-border overflow-hidden">
                  {([['combined', 'Combined', LineChartIcon], ['per-entity', 'Per entity', LayoutGrid]] as const).map(([mode, label, Icon]) => (
                    <button key={mode} onClick={() => setTimelineMode(mode)}
                      className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 transition-colors ${timelineMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                      <Icon size={9} />{label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {perEntityTimeline ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {entities.map(e => {
                  const series = perEntitySeries.get(e) || [];
                  const color = entityColor(e);
                  return (
                    <div key={e} className="border border-border/60 rounded-lg p-2 space-y-1">
                      <button onClick={() => setFocused(e)} title={`Drill into ${e}`}
                        className="group flex w-full items-center gap-1.5 text-left">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                        <span className="text-[10px] font-semibold truncate flex-1 group-hover:text-primary group-hover:underline underline-offset-2">
                          {e}
                        </span>
                        <ZoomIn size={9} className="shrink-0 text-muted-foreground/40 group-hover:text-primary print:hidden" />
                      </button>
                      {series.length === 0 ? (
                        <p className="h-[110px] flex items-center justify-center text-[10px] text-muted-foreground/50">
                          No activity in period
                        </p>
                      ) : (
                        <ResponsiveContainer width="100%" height={110}>
                          <LineChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                            <XAxis dataKey="month" tick={{ fontSize: 8 }} tickLine={false} axisLine={false}
                              interval="preserveStartEnd" minTickGap={30} />
                            <YAxis tick={{ fontSize: 8 }} tickLine={false} axisLine={false} width={24} allowDecimals={false} />
                            <Tooltip formatter={(v: any) => v.toLocaleString()}
                              contentStyle={{ fontSize: 10 }} labelStyle={{ fontSize: 10 }} />
                            <Line type="monotone" dataKey="count" name="Transfers" stroke={color}
                              strokeWidth={1.5} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={timelineData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                  <Tooltip formatter={(v: any) => v.toLocaleString()} />
                  {perEntityLines ? (
                    <>
                      <Legend iconSize={9} wrapperStyle={{ fontSize: 10 }} />
                      {entities.map((e, i) => (
                        <Line key={e} type="monotone" dataKey={e} stroke={COLORS[i % COLORS.length]}
                          strokeWidth={2} dot={{ r: 2 }} connectNulls />
                      ))}
                    </>
                  ) : (
                    <Line type="monotone" dataKey="__total" name="All selected entities" stroke="#f97316"
                      strokeWidth={2} dot={{ r: 2 }} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        ) : chart === 'counterparties' ? (
          <ResponsiveContainer width="100%" height={Math.max(220, (data?.counterparties?.length || 0) * 24 + 60)}>
            <BarChart data={data?.counterparties || []} layout="vertical" margin={{ top: 0, right: 40, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="counterparty" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={170} />
              <Tooltip formatter={(v: any) => v.toLocaleString()} />
              <Legend iconSize={9} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="sold_to" name="They sold to" stackId="a" fill="#f97316" radius={[0, 0, 0, 0]} maxBarSize={16} />
              <Bar dataKey="bought_from" name="They bought from" stackId="a" fill="#3b82f6" radius={[0, 3, 3, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(220, entities.length * 34 + 60)}>
            <BarChart data={data?.summary || []} layout="vertical" margin={{ top: 0, right: 40, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="entity" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={170} />
              <Tooltip formatter={(v: any) => v.toLocaleString()} />
              <Legend iconSize={9} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="inbound" name="Bought (in)" fill="#3b82f6" radius={[0, 3, 3, 0]} maxBarSize={13} />
              <Bar dataKey="outbound" name="Sold (out)" fill="#f97316" radius={[0, 3, 3, 0]} maxBarSize={13} />
            </BarChart>
          </ResponsiveContainer>
        )}

        {/* Per-entity summary table */}
        {!isLoading && data?.summary && (
          <div className="overflow-x-auto border-t border-border/40 pt-3">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="px-2 py-1.5 text-left font-semibold">Entity</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Type</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Bought</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Sold</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Net</th>
                  <th className="px-2 py-1.5 text-right font-semibold">$ Vol (known)</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Top Counterparty</th>
                  <th className="px-2 py-1.5 text-left font-semibold">First</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Last</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((s: any) => (
                  <tr key={s.entity} className="border-b border-border/20">
                    <td className="px-2 py-1.5 font-medium max-w-[180px]">
                      <button onClick={() => setFocused(s.entity)} title={`Drill into ${s.entity}`}
                        className="group inline-flex items-center gap-1.5 max-w-full text-left">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: entityColor(s.entity) }} />
                        <span className="truncate group-hover:text-primary group-hover:underline underline-offset-2">{s.entity}</span>
                        <ZoomIn size={9} className="shrink-0 text-muted-foreground/40 group-hover:text-primary print:hidden" />
                      </button>
                    </td>
                    <td className={`px-2 py-1.5 text-[9px] font-semibold whitespace-nowrap ${TYPE_COLOR[s.entity_type] || 'text-muted-foreground'}`}>
                      {s.entity_type || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{s.inbound.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{s.outbound.toLocaleString()}</td>
                    <td className={`px-2 py-1.5 text-right font-mono font-semibold ${s.net > 0 ? 'text-blue-500' : s.net < 0 ? 'text-orange-500' : 'text-muted-foreground'}`}>
                      {s.net > 0 ? `+${s.net}` : s.net}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(s.dollar_volume)}</td>
                    <td className="px-2 py-1.5 max-w-[160px]">
                      {s.top_counterparty
                        ? <span className="truncate block" title={s.top_counterparty}>{s.top_counterparty} <span className="text-muted-foreground">({s.top_counterparty_count})</span></span>
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{s.first_activity || '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{s.last_activity || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
