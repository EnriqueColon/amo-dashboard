import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import CategoryBadge from '@/components/CategoryBadge';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import {
  TrendingDown, TrendingUp, AlertTriangle, Target, Users,
  ArrowRight, ChevronLeft, ChevronRight, ExternalLink,
  Flame, Shield, Eye, Info,
} from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────
const MONTH_LABELS: Record<string, string> = {
  '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun',
  '07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec',
};
function fmtMonth(m: string) {
  const [y, mo] = m.split('-');
  return `${MONTH_LABELS[mo]} ${y?.slice(2)}`;
}

// Net-seller pressure bar: green = net buyer, red = net seller
function PressureBar({ inbound, outbound }: { inbound: number; outbound: number }) {
  const total = Math.max(inbound + outbound, 1);
  const outPct = Math.round((outbound / total) * 100);
  const inPct  = 100 - outPct;
  const isNetSeller = outbound > inbound;
  return (
    <div className="flex items-center gap-1.5 w-full">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden flex">
        <div className="h-full bg-emerald-500/70 rounded-l-full" style={{ width: `${inPct}%` }} />
        <div className="h-full bg-red-500/70 rounded-r-full" style={{ width: `${outPct}%` }} />
      </div>
      <span className={`text-[10px] font-mono shrink-0 ${isNetSeller ? 'text-red-400' : 'text-emerald-400'}`}>
        {isNetSeller ? `−${(outbound - inbound).toLocaleString()}` : `+${(inbound - outbound).toLocaleString()}`}
      </span>
    </div>
  );
}

function KpiCard({ label, value, sub, icon: Icon, accent, tooltip }: {
  label: string; value: any; sub?: string;
  icon: React.ElementType; accent: string; tooltip?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl p-5 relative">
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${accent}/10`}>
          <Icon size={16} className={accent} />
        </div>
        {tooltip && (
          <button
            className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
          >
            <Info size={12} />
          </button>
        )}
        {show && tooltip && (
          <div className="absolute top-2 right-8 z-30 w-56 bg-popover border border-border rounded-lg p-2.5 text-[11px] text-muted-foreground shadow-xl pointer-events-none">
            {tooltip}
          </div>
        )}
      </div>
      <p className={`text-2xl font-bold ${accent}`}>{value ?? '—'}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DealIntelligence() {
  const [dealPage, setDealPage] = useState(1);

  const { data: summary, isLoading: sumLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/summary'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/summary').then(r => r.json()),
  });
  const { data: sellers, isLoading: sellLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/seller-pressure'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/seller-pressure').then(r => r.json()),
  });
  const { data: peList, isLoading: peLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/pe-competitive'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/pe-competitive').then(r => r.json()),
  });
  const { data: specialSvc, isLoading: svcLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/special-servicers'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/special-servicers').then(r => r.json()),
  });
  const { data: monthly, isLoading: mLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/monthly'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/monthly').then(r => r.json()),
  });
  const { data: dealLog, isLoading: dealLoading } = useQuery({
    queryKey: ['/api/deal-intelligence/bank-to-pe', dealPage],
    queryFn: () => apiRequest('GET', `/api/deal-intelligence/bank-to-pe?page=${dealPage}&limit=25`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  });
  const { data: recentPairs } = useQuery({
    queryKey: ['/api/deal-intelligence/recent-bank-to-pe'],
    queryFn: () => apiRequest('GET', '/api/deal-intelligence/recent-bank-to-pe').then(r => r.json()),
  });

  // Max values for bar chart scaling
  const maxPeVol = Math.max(...((peList || []).map((r: any) => r.inbound_vol)), 1);

  return (
    <div className="p-6 space-y-7 max-w-screen-xl mx-auto">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-orange-500/10 rounded-lg">
            <Target size={16} className="text-orange-400" />
          </div>
          <h1 className="text-xl font-semibold">Deal Intelligence</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Distressed debt sourcing signals for Miami-Dade County. Tracks institutional sellers under pressure,
          private credit deal flow, special servicer acquisitions, and the bank→PE deal pipeline.
        </p>
      </div>

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {sumLoading ? Array(5).fill(0).map((_,i) => <Skeleton key={i} className="h-28 rounded-xl" />) : (<>
          <KpiCard
            label="Bank → PE Transfers"
            value={summary?.bank_to_pe_total?.toLocaleString()}
            sub="Direct bank-to-fund deal pipeline"
            icon={ArrowRight}
            accent="text-orange-400"
            tooltip="Total transactions where a bank sold directly to a private credit / PE fund. These are the most actionable deal signals — regulated sellers offloading to alternative buyers."
          />
          <KpiCard
            label="Net Institutional Sellers"
            value={summary?.net_sellers_count?.toLocaleString()}
            sub="Outbound > 1.5× inbound"
            icon={TrendingDown}
            accent="text-red-400"
            tooltip="Institutions where outbound volume exceeds inbound by 1.5× or more. These entities are consistently shedding loans and are likely sources for portfolio acquisition opportunities."
          />
          <KpiCard
            label="Special Svc. Acquisitions"
            value={summary?.special_svc_vol?.toLocaleString()}
            sub="Total inbound to workout servicers"
            icon={AlertTriangle}
            accent="text-amber-400"
            tooltip="Total loan volume acquired by known special servicers (Mortgage Assets Mgmt, Select Portfolio, Carrington, etc.). Rising numbers signal a growing distressed pipeline."
          />
          <KpiCard
            label="Active PE Buyers"
            value={summary?.active_pe_buyers?.toLocaleString()}
            sub="Distinct funds buying from institutions"
            icon={Users}
            accent="text-purple-400"
            tooltip="Number of distinct private credit / PE funds that have acquired loans from institutional sellers. Indicates depth of alternative buyer competition in this market."
          />
          <KpiCard
            label="Distressed Dispositions"
            value={summary?.inst_out_total?.toLocaleString()}
            sub="Institution → private party outflows"
            icon={Flame}
            accent="text-rose-400"
            tooltip="Institutional → non-institutional transfers (REO, distressed sales, short sales). These represent the end of the distress cycle — assets leaving the formal system."
          />
        </>)}
      </div>

      {/* ── Distressed Signal Trend ──────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Distressed Activity Trend</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Monthly bank→PE transfers, distressed dispositions, and total market transfers
            </p>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-orange-400 inline-block" />Bank → PE</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-rose-400 inline-block" />Inst. Out</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 rounded-full bg-emerald-500/50 inline-block" />All Market Transfers</span>
          </div>
        </div>
        {mLoading ? <Skeleton className="h-52" /> : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={monthly || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradMT" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradBPE" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#fb923c" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#fb923c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 12% 22%)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={fmtMonth}
                tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={36}
                tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
              <Tooltip
                contentStyle={{ background: 'hsl(220 18% 13%)', border: '1px solid hsl(220 12% 22%)', borderRadius: 8, fontSize: 11 }}
                labelFormatter={fmtMonth}
                formatter={(v: any, name: string) => [
                  v.toLocaleString(),
                  name === 'market_transfers' ? 'All Market Transfers'
                    : name === 'bank_to_pe' ? 'Bank → PE'
                    : 'Inst. Out (Distressed)',
                ]}
              />
              <Area dataKey="market_transfers" stroke="#10b981" strokeWidth={1.5} fill="url(#gradMT)" dot={false} />
              <Area dataKey="inst_out"         stroke="#fb7185" strokeWidth={1.5} fill="none" dot={false} strokeDasharray="4 2" />
              <Area dataKey="bank_to_pe"       stroke="#fb923c" strokeWidth={2}   fill="url(#gradBPE)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Two-column: Seller Pressure + Special Servicers ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Seller Pressure Monitor */}
        <div className="bg-card border border-border rounded-xl p-5 flex flex-col">
          <div className="flex items-start gap-2 mb-1">
            <TrendingDown size={14} className="text-red-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Seller Pressure Monitor</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Banks and servicers ranked by net outbound volume. Heavy net sellers are likely sources for portfolio acquisitions.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground mt-2 mb-3 px-1">
            <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-full bg-emerald-500/70 inline-block" />Inbound</span>
            <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-full bg-red-500/70 inline-block" />Outbound</span>
            <span className="ml-auto">Net flow shown as ±</span>
          </div>
          {sellLoading ? <Skeleton className="h-72" /> : (
            <div className="space-y-1 overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
              {(sellers || []).map((row: any, i: number) => (
                <div key={row.entity} className="flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-muted/20 transition-colors group">
                  <span className="text-[10px] text-muted-foreground w-4 shrink-0 text-right">{i+1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 mb-1">
                      <span className="text-xs font-medium text-foreground truncate" title={row.entity}>{row.entity}</span>
                      <CategoryBadge category={row.entity_type} size="xs" />
                    </div>
                    <PressureBar inbound={row.inbound_vol} outbound={row.outbound_vol} />
                  </div>
                  <div className="text-right shrink-0 text-[10px] text-muted-foreground">
                    <div className="font-mono">{row.total_vol.toLocaleString()}</div>
                    <div className="text-[9px]">total</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Special Servicer Watch */}
        <div className="bg-card border border-border rounded-xl p-5 flex flex-col">
          <div className="flex items-start gap-2 mb-1">
            <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Special Servicer Watch</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Entities that manage distressed and non-performing loans. Rising inbound = growing distressed pipeline.
              </p>
            </div>
          </div>

          <div className="mt-3 mb-2 px-2">
            <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2">
              <Eye size={10} className="shrink-0" />
              <span>When these entities acquire at increasing rates, distressed supply is building upstream — monitor for portfolio sale opportunities.</span>
            </div>
          </div>

          {svcLoading ? <Skeleton className="h-64" /> : (
            <div className="space-y-1 flex-1">
              {(specialSvc || []).length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 pt-2">No special servicer activity found in dataset.</p>
              ) : (specialSvc || []).map((row: any) => {
                const inPct = Math.round((row.inbound_vol / Math.max(row.total_vol, 1)) * 100);
                return (
                  <div key={row.entity} className="px-2 py-2.5 rounded-lg hover:bg-muted/20 transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <span className="text-xs font-medium text-foreground">{row.entity}</span>
                      <span className="text-[10px] font-mono text-amber-400 shrink-0">{row.inbound_vol.toLocaleString()} acquired</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-amber-400/60 rounded-full" style={{ width: `${inPct}%` }} />
                      </div>
                      <span className="text-[9px] text-muted-foreground shrink-0">
                        {row.outbound_vol.toLocaleString()} resold · {inPct}% net acquiring
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-1">{row.first_seen} → {row.last_seen}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── PE Competitive Map ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-start gap-2">
            <Shield size={14} className="text-purple-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Private Credit Competitive Map</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Active PE / private credit funds in Miami-Dade ranked by total acquisition volume. These are your competitors and potential co-investors.
              </p>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground text-right">
            <div>Total inbound volume</div>
            <div className="text-purple-400 font-mono">{peLoading ? '—' : (peList || []).reduce((s: number, r: any) => s + r.inbound_vol, 0).toLocaleString()}</div>
          </div>
        </div>

        {peLoading ? <Skeleton className="h-64" /> : (
          <div className="space-y-2">
            {(peList || []).map((row: any, i: number) => {
              const barPct = Math.round((row.inbound_vol / maxPeVol) * 100);
              const isNetBuyer = row.inbound_vol >= row.outbound_vol;
              return (
                <div key={row.entity} className="flex items-center gap-3 group">
                  <span className="text-[10px] text-muted-foreground w-4 shrink-0 text-right">{i+1}</span>
                  <div className="w-36 shrink-0">
                    <span className="text-xs font-medium text-foreground truncate block" title={row.entity}>{row.entity}</span>
                    <span className="text-[9px] text-muted-foreground">{row.first_seen} → {row.last_seen}</span>
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isNetBuyer ? 'bg-purple-500/70' : 'bg-purple-500/30'}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-purple-400 w-14 text-right shrink-0">
                      {row.inbound_vol.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-right shrink-0 text-[9px] text-muted-foreground w-24">
                    <div>{row.outbound_vol.toLocaleString()} sold</div>
                    <div className={isNetBuyer ? 'text-emerald-400' : 'text-red-400'}>
                      {isNetBuyer ? `net +${(row.inbound_vol - row.outbound_vol).toLocaleString()}` : `net −${(row.outbound_vol - row.inbound_vol).toLocaleString()}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Recent Bank→PE pairs (last 180d) */}
        {recentPairs && (recentPairs as any[]).length > 0 && (
          <div className="mt-5 pt-4 border-t border-border">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Most active bank→PE relationships · last 180 days
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(recentPairs as any[]).map((pair: any) => (
                <div key={`${pair.seller}-${pair.buyer}`}
                  className="flex items-center gap-2 bg-muted/20 rounded-lg px-3 py-2 text-xs">
                  <span className="text-blue-400 font-medium truncate max-w-[90px]" title={pair.seller}>{pair.seller}</span>
                  <ArrowRight size={10} className="text-muted-foreground/40 shrink-0" />
                  <span className="text-purple-400 font-medium truncate max-w-[90px]" title={pair.buyer}>{pair.buyer}</span>
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground shrink-0">{pair.n}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Bank → PE Deal Log ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-start gap-2">
            <TrendingUp size={14} className="text-orange-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Bank → PE Deal Log</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Every transaction where a bank sold directly to a private credit / PE fund.
                {dealLog && <span className="text-orange-400 ml-1">{dealLog.total.toLocaleString()} total transfers recorded.</span>}
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">CFN</th>
                <th className="px-4 py-2.5 text-left font-medium">Date</th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />Bank (Seller)</span>
                </th>
                <th className="px-2 py-2.5 text-center font-medium w-5"></th>
                <th className="px-4 py-2.5 text-left font-medium">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-400 inline-block" />PE Fund (Buyer)</span>
                </th>
                <th className="px-4 py-2.5 text-left font-medium">Book / Page</th>
                <th className="px-4 py-2.5 text-center font-medium">Ref</th>
              </tr>
            </thead>
            <tbody>
              {dealLoading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(7).fill(0).map((_, j) => <td key={j} className="px-4 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (dealLog?.rows || []).map((r: any, i: number) => (
                    <tr key={`${r.cfn}-${i}`} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-primary/80 text-[11px] whitespace-nowrap">{r.cfn}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <div className="font-semibold text-blue-300 truncate" title={r.seller}>{r.seller}</div>
                        {r.assignor !== r.seller && (
                          <div className="text-muted-foreground truncate text-[10px]" title={r.assignor}>{r.assignor}</div>
                        )}
                      </td>
                      <td className="px-1 py-2.5 text-center">
                        <ArrowRight size={11} className="text-orange-400/60 mx-auto" />
                      </td>
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <div className="font-semibold text-purple-300 truncate" title={r.buyer}>{r.buyer}</div>
                        {r.assignee !== r.buyer && (
                          <div className="text-muted-foreground truncate text-[10px]" title={r.assignee}>{r.assignee}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-muted-foreground text-[11px] whitespace-nowrap">{r.rec_book}/{r.rec_page}</td>
                      <td className="px-4 py-2.5 text-center">
                        <a
                          href={`https://www2.miamidadeclerk.gov/ocs/Search.aspx?QS=RN${r.cfn}`}
                          target="_blank" rel="noopener noreferrer"
                          className="text-muted-foreground/40 hover:text-primary transition-colors"
                          title="View on county portal"
                        >
                          <ExternalLink size={11} />
                        </a>
                      </td>
                    </tr>
                  ))
              }
              {!dealLoading && !dealLog?.rows?.length && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {dealLog && dealLog.pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Showing {((dealPage-1)*25)+1}–{Math.min(dealPage*25, dealLog.total)} of {dealLog.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={dealPage<=1} onClick={() => setDealPage(1)} className="h-7 px-2 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={dealPage<=1} onClick={() => setDealPage(p=>p-1)} className="h-7 w-7 p-0"><ChevronLeft size={13}/></Button>
              <span className="text-xs text-muted-foreground px-2">{dealPage} / {dealLog.pages}</span>
              <Button size="sm" variant="ghost" disabled={dealPage>=dealLog.pages} onClick={() => setDealPage(p=>p+1)} className="h-7 w-7 p-0"><ChevronRight size={13}/></Button>
              <Button size="sm" variant="ghost" disabled={dealPage>=dealLog.pages} onClick={() => setDealPage(dealLog.pages)} className="h-7 px-2 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
