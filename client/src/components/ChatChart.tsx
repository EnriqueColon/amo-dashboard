import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid, LabelList,
} from 'recharts';
import { BarChart3, Loader2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { parseChartSpec, formatValue, shortLabel, type ChartSpec } from '@/lib/chat-chart';

/** Palette: dashboard primary (blue) first, then clearly distinct hues. */
const PALETTE = ['hsl(var(--primary))', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];
const AXIS_TICK = { fontSize: 10, fill: '#64748b' } as const;
const GRID = '#f1f5f9';
const TOOLTIP_STYLE = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 11, boxShadow: '0 4px 12px rgba(15,23,42,.08)' } as const;

/**
 * Renders a ```chart block from an answer. `source` is the raw block text;
 * `ready` is false while the answer is still streaming (a partial spec then
 * shows a placeholder rather than an error).
 */
export function ChatChart({ source, ready }: { source: string; ready: boolean }) {
  const parsed = useMemo(() => parseChartSpec(source), [source]);

  if (!parsed.ok) {
    if (parsed.partial || !ready) {
      return (
        <div className="not-prose my-3 flex h-[120px] items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 text-xs text-muted-foreground" data-testid="chat-chart-pending">
          <Loader2 size={13} className="animate-spin" /> Building chart…
        </div>
      );
    }
    return <BrokenChart error={parsed.error} source={source} />;
  }
  return <ChartCard spec={parsed.spec} />;
}

function BrokenChart({ error, source }: { error: string; source: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="not-prose my-3 rounded-md border border-amber-200 bg-amber-50/60 text-xs text-amber-900" data-testid="chat-chart-error">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left">
        <AlertTriangle size={12} className="shrink-0" />
        <span className="flex-1">{error} — the figures are still in the text above.</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <pre className="max-h-48 overflow-auto border-t border-amber-200 px-3 py-2 text-[11px] text-amber-950/80">{source}</pre>}
    </div>
  );
}

function ChartCard({ spec }: { spec: ChartSpec }) {
  const colorOf = (i: number, s?: { color?: string }) => s?.color ?? PALETTE[i % PALETTE.length];
  const multi = spec.series.length > 1;
  const height = spec.type === 'hbar' ? Math.min(420, Math.max(160, 28 * spec.data.length + 40)) : spec.type === 'pie' ? 240 : 240;

  return (
    <figure className="not-prose my-3 rounded-lg border border-border bg-card shadow-sm" data-testid="chat-chart" data-chart-type={spec.type}>
      {(spec.title || spec.subtitle) && (
        <figcaption className="flex items-start gap-2 border-b border-border px-4 py-2.5">
          <BarChart3 size={14} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0">
            {spec.title && <div className="text-sm font-semibold leading-tight text-foreground">{spec.title}</div>}
            {spec.subtitle && <div className="mt-0.5 text-[11px] text-muted-foreground">{spec.subtitle}</div>}
          </div>
        </figcaption>
      )}
      <div className="px-2 pb-2 pt-3">
        <ResponsiveContainer width="100%" height={height}>
          {renderChart(spec, colorOf, multi)}
        </ResponsiveContainer>
      </div>
      {spec.xLabel && <div className="px-4 pb-2 text-center text-[10px] text-muted-foreground">{spec.xLabel}</div>}
    </figure>
  );
}

function renderChart(spec: ChartSpec, colorOf: (i: number, s?: { color?: string }) => string, multi: boolean) {
  const fmt = (v: any) => formatValue(typeof v === 'number' ? v : Number(v), spec.format);
  const fmtAxis = (v: any) => formatValue(typeof v === 'number' ? v : Number(v), spec.format, true);
  // Value labels on bars: exact counts for plain numbers, compact for money.
  const fmtLabel = spec.format === 'number' ? fmt : fmtAxis;
  const tooltip = (
    <Tooltip
      contentStyle={TOOLTIP_STYLE}
      cursor={spec.type === 'line' || spec.type === 'area' ? { stroke: '#cbd5e1' } : { fill: 'rgba(15,23,42,.04)' }}
      formatter={(v: any, name: any) => [fmt(v), spec.series.find(s => s.key === name)?.label ?? name]}
    />
  );
  const legend = multi ? <Legend wrapperStyle={{ fontSize: 11 }} formatter={(key: string) => spec.series.find(s => s.key === key)?.label ?? key} /> : null;
  const margin = { top: 8, right: 28, left: 0, bottom: 0 };
  const dense = spec.data.length > 14;

  switch (spec.type) {
    case 'pie': {
      const s = spec.series[0];
      const total = spec.data.reduce((a, p) => a + (typeof p[s.key] === 'number' ? (p[s.key] as number) : 0), 0);
      return (
        <PieChart>
          <Pie data={spec.data} dataKey={s.key} nameKey="x" innerRadius="52%" outerRadius="80%" paddingAngle={1.5} stroke="#fff" strokeWidth={1}>
            {spec.data.map((_, i) => <Cell key={i} fill={colorOf(i)} />)}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v: any, _n: any, item: any) => {
              const share = total > 0 && spec.format !== 'percent' ? ` · ${((Number(v) / total) * 100).toFixed(1)}%` : '';
              return [`${fmt(v)}${share}`, item?.payload?.x ?? s.label];
            }}
          />
          <Legend layout="vertical" verticalAlign="middle" align="right" iconType="circle" iconSize={8}
            wrapperStyle={{ fontSize: 11, maxWidth: '48%', lineHeight: '18px' }}
            formatter={(_v: any, entry: any) => {
              const p = entry?.payload ?? {};
              const val = typeof p[s.key] === 'number' ? (p[s.key] as number) : null;
              const share = val !== null && total > 0 && spec.format !== 'percent' ? ` · ${((val / total) * 100).toFixed(1)}%` : val !== null ? ` · ${fmt(val)}` : '';
              return <span style={{ color: '#334155' }}>{shortLabel(String(p.x ?? ''), 26)}<span style={{ color: '#64748b' }}>{share}</span></span>;
            }} />
        </PieChart>
      );
    }
    case 'hbar': {
      const labelW = Math.min(180, Math.max(70, Math.max(...spec.data.map(p => shortLabel(p.x, 30).length)) * 6.2));
      return (
        <BarChart data={spec.data} layout="vertical" margin={{ top: 4, right: 48, left: 4, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={fmtAxis} />
          <YAxis type="category" dataKey="x" width={labelW} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v: string) => shortLabel(v, 30)} interval={0} />
          {tooltip}{legend}
          {spec.series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} stackId={spec.stacked ? 'a' : undefined} fill={colorOf(i, s)} radius={spec.stacked ? 0 : [0, 3, 3, 0]} maxBarSize={22}>
              {!multi && <LabelList dataKey={s.key} position="right" formatter={fmtLabel} style={{ fontSize: 10, fill: '#475569' }} />}
            </Bar>
          ))}
        </BarChart>
      );
    }
    case 'line':
      return (
        <LineChart data={spec.data} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={dense ? 'preserveStartEnd' : 0} minTickGap={16} tickFormatter={(v: string) => shortLabel(v, 12)} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={fmtAxis} />
          {tooltip}{legend}
          {spec.series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={colorOf(i, s)} strokeWidth={2} dot={dense ? false : { r: 3, strokeWidth: 0, fill: colorOf(i, s) }} activeDot={{ r: 4 }} connectNulls />
          ))}
        </LineChart>
      );
    case 'area':
      return (
        <AreaChart data={spec.data} margin={margin}>
          <defs>
            {spec.series.map((s, i) => (
              <linearGradient key={s.key} id={`cc-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorOf(i, s)} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colorOf(i, s)} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={dense ? 'preserveStartEnd' : 0} minTickGap={16} tickFormatter={(v: string) => shortLabel(v, 12)} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={fmtAxis} />
          {tooltip}{legend}
          {spec.series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stackId={spec.stacked ? 'a' : undefined} stroke={colorOf(i, s)} strokeWidth={2} fill={`url(#cc-grad-${i})`} connectNulls />
          ))}
        </AreaChart>
      );
    case 'bar':
    default:
      return (
        <BarChart data={spec.data} margin={margin} barCategoryGap={dense ? '15%' : '28%'}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={dense ? 'preserveStartEnd' : 0} minTickGap={12} tickFormatter={(v: string) => shortLabel(v, dense ? 8 : 14)} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={fmtAxis} />
          {tooltip}{legend}
          {spec.series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} stackId={spec.stacked ? 'a' : undefined} fill={colorOf(i, s)} maxBarSize={40}
              radius={spec.stacked && i < spec.series.length - 1 ? 0 : [3, 3, 0, 0]}>
              {!multi && !dense && <LabelList dataKey={s.key} position="top" formatter={fmtLabel} style={{ fontSize: 10, fill: '#475569' }} />}
            </Bar>
          ))}
        </BarChart>
      );
  }
}
