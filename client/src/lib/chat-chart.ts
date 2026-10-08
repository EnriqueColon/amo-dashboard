/**
 * Chart specs for "Ask the Data" answers.
 *
 * The model emits a fenced ```chart block containing a small JSON object
 * (see CHART_SPEC_GUIDE in server/chat/prompt.ts). This module validates and
 * normalises that JSON into something the ChatChart component can render,
 * tolerating the loose values a model produces ("1,210", "$1.2M", "41.2%").
 * Pure — no React, no DOM — so it is unit-testable with tsx.
 */

export type ChartType = 'bar' | 'hbar' | 'line' | 'area' | 'pie';
export type ValueFormat = 'number' | 'money' | 'percent';

export interface ChartSeries { key: string; label: string; color?: string }
export interface ChartPoint { x: string; [key: string]: string | number | null }

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  xLabel?: string;
  format: ValueFormat;
  stacked: boolean;
  series: ChartSeries[];
  data: ChartPoint[];
}

export type ParsedChart =
  | { ok: true; spec: ChartSpec }
  | { ok: false; partial: boolean; error: string };

export const MAX_POINTS = 60;
export const MAX_SERIES = 6;
export const MAX_PIE_SLICES = 8;

const TYPES = new Set<ChartType>(['bar', 'hbar', 'line', 'area', 'pie']);
const FORMATS = new Set<ValueFormat>(['number', 'money', 'percent']);

/** "1,210" → 1210, "$1.2M" → 1200000, "41.2%" → 41.2, "—" → null. */
export function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[,$\s]/g, '').replace(/%$/, '');
  if (!s || s === '—' || s === '-') return null;
  const m = /^(-?\d+(?:\.\d+)?)([kmb])?$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'] : 1;
  return n * mult;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Is this a JSON document that simply has not finished arriving yet? */
function looksPartial(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  if (!t.startsWith('{')) return false;
  let depth = 0, inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth > 0 || inStr;
}

export function parseChartSpec(raw: string): ParsedChart {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, partial: looksPartial(raw), error: 'Chart spec is not valid JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, partial: false, error: 'Chart spec must be an object' };

  const type: ChartType = TYPES.has(obj.type) ? obj.type : 'bar';
  const format: ValueFormat = FORMATS.has(obj.format) ? obj.format : 'number';

  // Series: accept [{key,label}], ["key", ...], or infer from the data.
  let series: ChartSeries[] = [];
  if (Array.isArray(obj.series)) {
    for (const s of obj.series) {
      if (typeof s === 'string' && s.trim()) series.push({ key: s.trim(), label: s.trim() });
      else if (s && typeof s === 'object' && str(s.key)) series.push({ key: s.key.trim(), label: str(s.label) ?? s.key.trim(), color: str(s.color) });
    }
  }

  if (!Array.isArray(obj.data)) return { ok: false, partial: false, error: 'Chart spec has no data array' };
  const xKey = str(obj.x) ?? 'x';
  const rows: any[] = obj.data.filter((r: any) => r && typeof r === 'object');
  if (!rows.length) return { ok: false, partial: false, error: 'Chart has no data points' };

  if (!series.length) {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (k !== xKey && k !== 'x' && k !== 'label' && k !== 'name') keys.add(k);
    series = Array.from(keys).filter(k => rows.some(r => coerceNumber(r[k]) !== null)).map(k => ({ key: k, label: k }));
  }
  series = series.slice(0, MAX_SERIES);
  if (!series.length) return { ok: false, partial: false, error: 'Chart has no numeric series' };

  const data: ChartPoint[] = [];
  for (const r of rows) {
    const x = str(r[xKey]) ?? str(r.x) ?? str(r.label) ?? str(r.name) ?? (r[xKey] != null ? String(r[xKey]) : undefined);
    if (x === undefined) continue;
    const p: ChartPoint = { x };
    let any = false;
    for (const s of series) { const n = coerceNumber(r[s.key]); p[s.key] = n; if (n !== null) any = true; }
    if (any) data.push(p);
  }
  if (!data.length) return { ok: false, partial: false, error: 'Chart data points have no numeric values' };

  const limit = type === 'pie' ? MAX_PIE_SLICES : MAX_POINTS;
  const spec: ChartSpec = {
    type,
    title: str(obj.title),
    subtitle: str(obj.subtitle),
    xLabel: str(obj.xLabel) ?? str(obj.x_label),
    format,
    stacked: obj.stacked === true || obj.stacked === 'true',
    series: type === 'pie' ? series.slice(0, 1) : series,
    data: data.slice(0, limit),
  };
  return { ok: true, spec };
}

/** Axis / tooltip formatting shared by every chart type. */
export function formatValue(v: number | null | undefined, format: ValueFormat, compact = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${v.toFixed(compact && Number.isInteger(v) ? 0 : 1)}%`;
  if (format === 'money') {
    const a = Math.abs(v);
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `$${(v / 1e3).toFixed(compact ? 0 : 1)}K`;
    return `$${Math.round(v).toLocaleString()}`;
  }
  if (compact) {
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  }
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Shorten long category labels (entity names) for axis ticks. */
export function shortLabel(s: string, max = 22): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
