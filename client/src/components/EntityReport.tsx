import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  X, Plus, LineChart as LineChartIcon, Users, ArrowLeftRight,
  TrendingUp, TrendingDown, Activity, DollarSign,
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

// ── Entity multi-select picker ────────────────────────────────────────────────
export function EntityPicker({ selected, onChange }: {
  selected: string[];
  onChange: (entities: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const query = useDebounced(q.trim());

  const { data } = useQuery({
    queryKey: ['/api/entity-nodes', 'report-picker', query],
    queryFn: () => apiRequest('GET', `/api/entity-nodes?q=${encodeURIComponent(query)}&limit=12`).then(r => r.json()),
    enabled: query.length >= 2,
  });

  const results: any[] = (query.length >= 2 ? (data || []) : []).filter((r: any) => !selected.includes(r.entity));

  const add = (entity: string) => {
    if (!selected.includes(entity) && selected.length < 50) onChange([...selected, entity]);
    setQ('');
    setOpen(false);
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
        {selected.length > 0 && (
          <button onClick={() => onChange([])}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2">
            clear all
          </button>
        )}
      </div>
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
  const [chart, setChart] = useState('timeline');

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

  const perEntityLines = entities.length <= 6;

  if (entities.length === 0) return null;

  const k = data?.kpis;
  const net = k ? (k.inbound ?? 0) - (k.outbound ?? 0) : 0;

  return (
    <div className="space-y-3">
      {/* Print-only report header */}
      <div className="hidden print:block border-b border-border pb-2">
        <h1 className="text-base font-bold">AMO Activity Report — Miami-Dade County</h1>
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
                {data.summary.map((s: any, i: number) => (
                  <tr key={s.entity} className="border-b border-border/20">
                    <td className="px-2 py-1.5 font-medium max-w-[180px]">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="truncate" title={s.entity}>{s.entity}</span>
                      </span>
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
