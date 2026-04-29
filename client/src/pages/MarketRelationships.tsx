import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, ZoomIn, ZoomOut, RotateCcw, Info, X } from 'lucide-react';
import * as d3 from 'd3';

// ── Fuzzy search helpers ────────────────────────────────────────────────────
function fuzzyScore(query: string, target: string): number {
  if (!query || !target) return -1;
  const q = query.toUpperCase();
  const t = target.toUpperCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 + (100 - t.length);
  if (t.includes(q)) return 800 + (100 - t.length);
  // Check if all query chars appear in order inside target
  let qi = 0, consecutiveBonus = 0, lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      consecutiveBonus += lastMatch === ti - 1 ? 10 : 0;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return -1; // no match
  return 200 + consecutiveBonus - t.length;
}

function fuzzyFilter(query: string, candidates: string[], limit = 8): string[] {
  if (!query.trim()) return [];
  const scored = candidates
    .map(c => ({ c, s: fuzzyScore(query, c) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(x => x.c);
}

// ── Types ──────────────────────────────────────────────────────────────────
interface NodeDatum extends d3.SimulationNodeDatum {
  id: string;
  entity: string;
  entity_type: string;
  inbound_vol: number;
  outbound_vol: number;
  total_vol: number;
  degree: number;
  first_seen: string;
  last_seen: string;
}

interface EdgeDatum {
  source: string | NodeDatum;
  target: string | NodeDatum;
  transaction_count: number;
  first_seen_date: string;
  last_seen_date: string;
}

// ── Constants ──────────────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  BANK:           '#60a5fa',
  PRIVATE_CREDIT: '#c084fc',
  TRUST:          '#2dd4bf',
  GSE:            '#4ade80',
  SERVICER:       '#fbbf24',
  MERS:           '#fb923c',
  OTHER:          '#94a3b8',
};
const typeColor = (t: string) => TYPE_COLORS[t] ?? TYPE_COLORS.OTHER;

const MIN_TXNS = [
  { label: '≥5', value: 5 },
  { label: '≥20', value: 20 },
  { label: '≥50', value: 50 },
  { label: '≥100', value: 100 },
];
const PERIODS = [
  { label: 'All time', value: 0 },
  { label: '90 days', value: 90 },
  { label: '30 days', value: 30 },
];

// ── Component ──────────────────────────────────────────────────────────────
export default function MarketRelationships() {
  const svgRef       = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef      = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simRef       = useRef<d3.Simulation<NodeDatum, EdgeDatum> | null>(null);

  const [minTxns, setMinTxns]           = useState(20);
  const [days, setDays]                 = useState(0);
  const [entityInput, setEntityInput]   = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionIdx, setSuggestionIdx]     = useState(-1);
  const [institutionalOnly, setInstitutionalOnly] = useState(false);
  const [hovered, setHovered]           = useState<NodeDatum | null>(null);
  const [tooltipPos, setTooltipPos]     = useState({ x: 0, y: 0 });
  const [selected, setSelected]         = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const INST_TYPES = new Set(['BANK', 'SERVICER', 'PRIVATE_CREDIT', 'GSE', 'MERS', 'TRUST']);

  const qs = `?min_txns=${minTxns}&days=${days}&entity=${encodeURIComponent(entityFilter)}`;
  const { data, isLoading } = useQuery({
    queryKey: ['/api/network-graph', qs],
    queryFn: () => apiRequest('GET', `/api/network-graph${qs}`).then(r => r.json()),
  });

  // Fetch full entity list for autocomplete (min 1 txn to get everything)
  const { data: allEntitiesData } = useQuery({
    queryKey: ['/api/entities', 'autocomplete'],
    queryFn: () => apiRequest('GET', '/api/entities').then(r => r.json()),
    staleTime: Infinity,
  });
  const allEntityNames = useMemo<string[]>(() =>
    (allEntitiesData ?? []).map((e: any) => (e.entity ?? e.name) as string).filter(Boolean),
    [allEntitiesData]
  );

  const suggestions = useMemo(
    () => fuzzyFilter(entityInput, allEntityNames),
    [entityInput, allEntityNames]
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const commitSearch = (value: string) => {
    setEntityInput(value);
    setEntityFilter(value);
    setShowSuggestions(false);
    setSuggestionIdx(-1);
  };

  // ── Draw graph ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    // Optionally filter to institutional entities only (removes individual/OTHER noise)
    const allNodes = (data.nodes ?? []) as NodeDatum[];
    const allEdges = (data.edges ?? []) as EdgeDatum[];
    const instNodeIds = institutionalOnly
      ? new Set(allNodes.filter(n => INST_TYPES.has(n.entity_type)).map(n => n.id))
      : null;
    const rawNodes = instNodeIds ? allNodes.filter(n => instNodeIds.has(n.id)) : allNodes;
    const rawEdges = instNodeIds
      ? allEdges.filter(e => {
          const s = typeof e.source === 'string' ? e.source : (e.source as NodeDatum).id;
          const t = typeof e.target === 'string' ? e.target : (e.target as NodeDatum).id;
          return instNodeIds.has(s) && instNodeIds.has(t);
        })
      : allEdges;
    if (!rawNodes.length) return;

    const W = containerRef.current.clientWidth  || 900;
    const H = containerRef.current.clientHeight || 600;

    // ── Setup SVG ──────────────────────────────────────────────────────
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', W).attr('height', H);

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 10])
      .on('zoom', ev => g.attr('transform', ev.transform));
    svg.call(zoom);
    zoomRef.current = zoom;

    // ── Scales ─────────────────────────────────────────────────────────
    const maxVol  = d3.max(rawNodes, d => d.total_vol) || 1;
    const maxEdge = d3.max(rawEdges, d => d.transaction_count) || 1;
    const rScale  = d3.scalePow().exponent(0.5).domain([0, maxVol]).range([5, 32]).clamp(true);
    const wScale  = d3.scalePow().exponent(0.6).domain([1, maxEdge]).range([0.8, 10]).clamp(true);
    const oScale  = d3.scaleLinear().domain([1, maxEdge]).range([0.15, 0.85]).clamp(true);

    // ── Arrow markers ─────────────────────────────────────────────────
    const defs = svg.append('defs');
    Object.entries(TYPE_COLORS).forEach(([type, color]) => {
      defs.append('marker')
        .attr('id', `arr-${type}`)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 22).attr('refY', 0)
        .attr('markerWidth', 4).attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L8,0L0,4')
        .attr('fill', color).attr('opacity', 0.6);
    });

    // ── Clone data for simulation ──────────────────────────────────────
    const nodes: NodeDatum[] = rawNodes.map(n => ({ ...n }));
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const edges: EdgeDatum[] = rawEdges.map(e => ({
      ...e,
      source: nodeById.get(e.source as string) ?? (e.source as string),
      target: nodeById.get(e.target as string) ?? (e.target as string),
    }));

    // ── Edges ──────────────────────────────────────────────────────────
    const linkG = g.append('g').attr('class', 'links');
    const link = linkG.selectAll<SVGLineElement, EdgeDatum>('line')
      .data(edges).join('line')
      .attr('stroke', d => {
        const s = d.source as NodeDatum;
        return typeColor(s?.entity_type ?? 'OTHER');
      })
      .attr('stroke-width', d => wScale(d.transaction_count))
      .attr('stroke-opacity', d => oScale(d.transaction_count))
      .attr('marker-end', d => {
        const s = d.source as NodeDatum;
        return `url(#arr-${s?.entity_type ?? 'OTHER'})`;
      });

    // ── Node groups ────────────────────────────────────────────────────
    const nodeG = g.append('g').attr('class', 'nodes');
    const node = nodeG.selectAll<SVGGElement, NodeDatum>('g')
      .data(nodes).join('g')
      .style('cursor', 'pointer');

    // Glow ring for hubs (degree >= 30)
    node.filter(d => d.degree >= 30)
      .append('circle')
      .attr('r', d => rScale(d.total_vol) + 5)
      .attr('fill', 'none')
      .attr('stroke', d => typeColor(d.entity_type))
      .attr('stroke-width', 1)
      .attr('stroke-opacity', 0.25);

    // Main circle
    node.append('circle')
      .attr('class', 'main-circle')
      .attr('r', d => rScale(d.total_vol))
      .attr('fill', d => typeColor(d.entity_type))
      .attr('fill-opacity', 0.82)
      .attr('stroke', d => typeColor(d.entity_type))
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.5);

    // Labels — only for top 25% by volume, safe string slicing
    const labelMin = d3.quantile(
      [...nodes].sort((a, b) => a.total_vol - b.total_vol).map(n => n.total_vol),
      0.75
    ) ?? 0;

    node.filter(d => d.total_vol >= labelMin)
      .append('text')
      .attr('dy', d => rScale(d.total_vol) + 11)
      .attr('text-anchor', 'middle')
      .attr('font-size', '9px')
      .attr('fill', '#94a3b8')
      .attr('pointer-events', 'none')
      .text(d => {
        const name = d.id ?? d.entity ?? '';
        return name.length > 18 ? name.slice(0, 18) + '…' : name;
      });

    // ── Interactions ───────────────────────────────────────────────────
    node
      .on('mousemove', (event, d) => {
        const rect = containerRef.current!.getBoundingClientRect();
        setTooltipPos({ x: event.clientX - rect.left + 14, y: event.clientY - rect.top - 14 });
        setHovered(d);
      })
      .on('mouseleave', () => setHovered(null))
      .on('click', (_ev, d) => {
        setSelected(prev => {
          const next = prev === d.id ? null : d.id;
          // Dim/highlight edges
          link.attr('stroke-opacity', e => {
            if (!next) return oScale(e.transaction_count);
            const s = (e.source as NodeDatum).id;
            const t = (e.target as NodeDatum).id;
            return (s === next || t === next) ? 0.95 : 0.04;
          });
          // Dim/highlight nodes
          node.select('circle.main-circle')
            .attr('fill-opacity', n => {
              if (!next) return 0.82;
              if (n.id === next) return 1;
              const connected = edges.some(e => {
                const s = (e.source as NodeDatum).id;
                const t = (e.target as NodeDatum).id;
                return (s === next && t === n.id) || (t === next && s === n.id);
              });
              return connected ? 0.9 : 0.12;
            });
          return next;
        });
      });

    // ── Drag ───────────────────────────────────────────────────────────
    const drag = d3.drag<SVGGElement, NodeDatum>()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
    node.call(drag as any);

    // ── Simulation ─────────────────────────────────────────────────────
    const sim = d3.forceSimulation<NodeDatum>(nodes)
      .force('link', d3.forceLink<NodeDatum, EdgeDatum>(edges)
        .id(d => d.id)
        .distance(d => 60 + 300 / ((d as any).transaction_count + 1))
        .strength(0.35))
      .force('charge', d3.forceManyBody<NodeDatum>()
        .strength(d => -80 - rScale(d.total_vol) * 12))
      .force('center', d3.forceCenter(W / 2, H / 2).strength(0.04))
      .force('collide', d3.forceCollide<NodeDatum>().radius(d => rScale(d.total_vol) + 6).strength(0.7))
      .alphaDecay(0.025)
      .on('tick', () => {
        link
          .attr('x1', d => (d.source as NodeDatum).x ?? 0)
          .attr('y1', d => (d.source as NodeDatum).y ?? 0)
          .attr('x2', d => (d.target as NodeDatum).x ?? 0)
          .attr('y2', d => (d.target as NodeDatum).y ?? 0);
        node.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    simRef.current = sim as any;

    // Auto-fit after simulation settles
    setTimeout(() => {
      if (!svgRef.current || !containerRef.current) return;
      const bounds = (g.node() as SVGGElement).getBBox();
      const cW = containerRef.current.clientWidth;
      const cH = containerRef.current.clientHeight;
      const scale = Math.min(0.9, 0.9 / Math.max(bounds.width / cW, bounds.height / cH));
      const tx = cW / 2 - scale * (bounds.x + bounds.width / 2);
      const ty = cH / 2 - scale * (bounds.y + bounds.height / 2);
      d3.select(svgRef.current)
        .transition().duration(600)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }, 2500);

    return () => { sim.stop(); };
  }, [data, institutionalOnly]);

  const doZoom = useCallback((dir: 'in' | 'out' | 'reset') => {
    if (!svgRef.current || !zoomRef.current) return;
    const s = d3.select(svgRef.current);
    if (dir === 'reset') {
      s.transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
    } else {
      s.transition().duration(300).call(zoomRef.current.scaleBy, dir === 'in' ? 1.5 : 0.67);
    }
  }, []);

  const nodeCount = data?.nodes?.length ?? 0;
  const edgeCount = data?.edges?.length ?? 0;

  return (
    <div className="flex flex-col" style={{ height: '100%' }}>

      {/* ── Top controls bar ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-card flex-shrink-0 flex-wrap gap-y-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground leading-none">Market Relationships</h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {isLoading ? 'Building graph…' : `${nodeCount} entities · ${edgeCount} relationships`}
          </p>
        </div>

        <div className="w-px h-5 bg-border hidden sm:block" />

        {/* Min edge weight */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-0.5">Min txns:</span>
          {MIN_TXNS.map(o => (
            <button key={o.value} onClick={() => setMinTxns(o.value)}
              className={`px-2 py-0.5 rounded text-[10px] border transition-colors
                ${minTxns === o.value ? 'bg-primary/20 text-primary border-primary/40' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {o.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-border hidden sm:block" />

        {/* Time period */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-0.5">Period:</span>
          {PERIODS.map(o => (
            <button key={o.value} onClick={() => setDays(o.value)}
              className={`px-2 py-0.5 rounded text-[10px] border transition-colors
                ${days === o.value ? 'bg-primary/20 text-primary border-primary/40' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {o.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-border hidden sm:block" />

        {/* Entity focus search — fuzzy autocomplete */}
        <div ref={searchRef} className="relative flex items-center gap-1">
          <div className="relative">
            <Input
              placeholder="Focus on entity…"
              value={entityInput}
              onChange={e => {
                setEntityInput(e.target.value);
                setShowSuggestions(true);
                setSuggestionIdx(-1);
              }}
              onFocus={() => entityInput && setShowSuggestions(true)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSuggestionIdx(i => Math.min(i + 1, suggestions.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSuggestionIdx(i => Math.max(i - 1, -1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (suggestionIdx >= 0 && suggestions[suggestionIdx]) {
                    commitSearch(suggestions[suggestionIdx]);
                  } else {
                    commitSearch(entityInput);
                  }
                } else if (e.key === 'Escape') {
                  setShowSuggestions(false);
                  setSuggestionIdx(-1);
                }
              }}
              className="h-7 text-[11px] w-48"
            />
            {/* Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-card border border-border rounded-md shadow-xl z-50 overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={s}
                    onMouseDown={e => { e.preventDefault(); commitSearch(s); }}
                    onMouseEnter={() => setSuggestionIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-[11px] truncate transition-colors
                      ${i === suggestionIdx ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/40'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button size="sm" onClick={() => commitSearch(entityInput)} className="h-7 px-2">
            <Search size={11} />
          </Button>
          {entityFilter && (
            <Button size="sm" variant="ghost"
              onClick={() => { setEntityFilter(''); setEntityInput(''); setShowSuggestions(false); }}
              className="h-7 px-2 text-[10px]">
              <X size={11} />
            </Button>
          )}
        </div>

        <div className="w-px h-5 bg-border hidden sm:block" />

        {/* Institutional-only toggle */}
        <button
          onClick={() => setInstitutionalOnly(v => !v)}
          title="Hide OTHER (individual/private party) nodes — show only institutional participants"
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded border text-[10px] font-medium transition-colors ${institutionalOnly ? 'bg-primary/20 text-primary border-primary/40' : 'border-border text-muted-foreground hover:text-foreground'}`}
        >
          <span>{institutionalOnly ? '⬡ Inst. only' : '⬡ All nodes'}</span>
        </button>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-auto">
          <Button size="sm" variant="ghost" onClick={() => doZoom('in')}  className="h-7 w-7 p-0"><ZoomIn  size={13}/></Button>
          <Button size="sm" variant="ghost" onClick={() => doZoom('out')} className="h-7 w-7 p-0"><ZoomOut size={13}/></Button>
          <Button size="sm" variant="ghost" onClick={() => doZoom('reset')} className="h-7 w-7 p-0"><RotateCcw size={12}/></Button>
        </div>
      </div>

      {/* ── Legend ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-5 py-1.5 border-b border-border bg-card/60 flex-shrink-0 flex-wrap">
        {Object.entries(TYPE_COLORS).map(([t, c]) => (
          <div key={t} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: c }} />
            <span className="text-[9px] text-muted-foreground">{t.replace('_', ' ')}</span>
          </div>
        ))}
        <div className="flex items-center gap-1 ml-3 text-[9px] text-muted-foreground/60">
          <Info size={9} />
          <span>Node size = volume · Edge width = transaction count · Drag · Click to highlight · Self-assignments excluded</span>
        </div>
      </div>

      {/* ── Canvas ───────────────────────────────────────────────────── */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden bg-background" style={{ minHeight: 0 }}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center space-y-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-sm text-muted-foreground">Building network graph…</p>
            </div>
          </div>
        )}
        {!isLoading && nodeCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            No relationships match these filters. Try lowering the minimum transactions.
          </div>
        )}
        <svg ref={svgRef} className="w-full h-full" style={{ display: isLoading || !nodeCount ? 'none' : 'block' }} />

        {/* ── Hover tooltip ─────────────────────────────────────────── */}
        {hovered && (
          <div className="absolute z-20 bg-card border border-border rounded-lg shadow-2xl p-3 text-xs pointer-events-none w-52"
            style={{ left: tooltipPos.x, top: tooltipPos.y, maxWidth: 220 }}>
            <div className="font-semibold text-foreground mb-2 leading-tight text-[11px]">{hovered.id}</div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium" style={{ color: typeColor(hovered.entity_type) }}>
                  {hovered.entity_type.replace('_',' ')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Acquiring (inbound)</span>
                <span className="text-green-400 font-mono">{hovered.inbound_vol.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Selling (outbound)</span>
                <span className="text-red-400 font-mono">{hovered.outbound_vol.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connections</span>
                <span className="text-primary font-mono">{hovered.degree}</span>
              </div>
              <div className="border-t border-border/50 pt-1 mt-1 text-[10px] text-muted-foreground">
                {hovered.first_seen} → {hovered.last_seen}
              </div>
            </div>
          </div>
        )}

        {/* ── Selected node banner ──────────────────────────────────── */}
        {selected && (
          <div className="absolute bottom-4 left-4 bg-card border border-primary/40 rounded-lg px-4 py-2.5 text-xs shadow-xl flex items-center gap-3">
            <div>
              <span className="text-[10px] text-muted-foreground block">Focused on</span>
              <span className="font-semibold text-primary">{selected}</span>
            </div>
            <button onClick={() => {
              setSelected(null);
              // Reset opacity
              if (svgRef.current) {
                d3.select(svgRef.current).selectAll('circle.main-circle').attr('fill-opacity', 0.82);
                d3.select(svgRef.current).selectAll('line').attr('stroke-opacity', null);
              }
            }} className="text-muted-foreground hover:text-foreground ml-1">
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
