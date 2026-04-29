import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { TrendingUp, TrendingDown, Network, FileText, Database, RefreshCw, Star, ChevronRight, Info } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import CategoryBadge from '@/components/CategoryBadge';
import EntityDetailPanel from '@/components/EntityDetailPanel';

// ── Helpers ────────────────────────────────────────────────────────────────
const MONTH_LABELS: Record<string, string> = {
  '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun',
  '07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec',
};
function fmtMonth(m: string) {
  const [y, mo] = m.split('-');
  return `${MONTH_LABELS[mo]} ${y.slice(2)}`;
}

const TYPE_COLORS: Record<string, string> = {
  BANK: '#60a5fa', PRIVATE_CREDIT: '#a78bfa', GSE: '#4ade80',
  SERVICER: '#fbbf24', MERS: '#fb923c', OTHER: '#94a3b8',
};

function StatCard({ label, value, sub, icon: Icon, color = 'text-primary', tooltip }: any) {
  const [show, setShow] = useState(false);
  return (
    <div className="bg-card border border-border rounded-lg p-4 relative">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 pr-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">{label}</p>
          <p className={`text-2xl font-bold mt-1 ${color}`}>{value ?? '—'}</p>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {Icon && <Icon size={16} className="text-muted-foreground/30" />}
          {tooltip && (
            <button
              className="text-muted-foreground/30 hover:text-muted-foreground transition-colors"
              onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
            >
              <Info size={12} />
            </button>
          )}
        </div>
      </div>
      {show && tooltip && (
        <div className="absolute top-2 right-10 z-30 w-64 bg-popover border border-border rounded-lg p-3 text-[11px] text-muted-foreground shadow-xl pointer-events-none leading-relaxed">
          {tooltip}
        </div>
      )}
    </div>
  );
}

function EntityRow({ rank, entity, volume, degree, type, label, onClick }: any) {
  return (
    <div onClick={onClick} className="flex items-center gap-2 py-1.5 border-b border-border/30 last:border-0 hover:bg-muted/20 -mx-2 px-2 rounded cursor-pointer group transition-colors">
      <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {degree >= 50 && <Star size={9} className="text-primary shrink-0" />}
          <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors truncate" title={entity}>{entity}</span>
        </div>
        <CategoryBadge category={type} size="xs" />
      </div>
      <div className="text-right shrink-0 flex items-center gap-1">
        <div>
          <span className="text-xs font-mono text-primary">{volume.toLocaleString()}</span>
          {label && <p className="text-[9px] text-muted-foreground">{label}</p>}
        </div>
        <ChevronRight size={11} className="text-muted-foreground/30 group-hover:text-primary transition-colors" />
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const { data: raw, isLoading: rawLoading } = useQuery({
    queryKey: ['/api/stats'],
    queryFn: () => apiRequest('GET', '/api/stats').then(r => r.json()),
  });
  const { data: net, isLoading: netLoading } = useQuery({
    queryKey: ['/api/network-stats'],
    queryFn: () => apiRequest('GET', '/api/network-stats').then(r => r.json()),
  });
  const { data: monthly, isLoading: mLoading } = useQuery({
    queryKey: ['/api/monthly-volume'],
    queryFn: () => apiRequest('GET', '/api/monthly-volume').then(r => r.json()),
  });

  const isLoading = rawLoading || netLoading;

  return (
    <div className="p-6 space-y-6 max-w-screen-xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Miami-Dade County · Assignment of Mortgages — public county records tracking every transfer of mortgage debt
            {raw && <span> · {raw.min_date} → {raw.max_date}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw size={11} />
          <span>Last collected: {raw?.last_collected ?? '—'}</span>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {isLoading ? Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-24 rounded-lg" />) : (<>
          <StatCard
            label="Total Filings"
            value={raw?.total?.toLocaleString()}
            icon={Database}
            sub={`${raw?.min_date} → ${raw?.max_date}`}
            tooltip={`Every recorded assignment of mortgage in Miami-Dade County for this period. An assignment filing is the public document created each time a mortgage note (the debt instrument) changes hands — not when the property sells. This count includes all transaction types: market transfers between institutions, new loan originations, MERS registry moves, and private transfers. It is the raw pulse of debt-market activity in this county.`}
          />
          <StatCard
            label="Unique Entities"
            value={raw?.unique_entities?.toLocaleString()}
            icon={FileText}
            sub={`${raw?.unique_grantors ?? 0} grantors · ${raw?.unique_grantees ?? 0} grantees (raw), merged by canonicalization`}
            color="text-green-500"
            tooltip={`Raw county filings contain hundreds of name variants for the same institution — "BANK OF AMERICA N.A.", "BANK OF AMERICA NATIONAL ASSOC", "BK OF AMERICA" all refer to the same entity. Canonicalization merges these into one name. This figure is the count of distinct market participants after that deduplication. A higher number indicates a more fragmented market with more potential counterparties; a lower number signals market concentration among a few dominant players.`}
          />
          <StatCard
            label="Market Transfers"
            value={raw?.market_transfers?.toLocaleString()}
            icon={TrendingUp}
            sub={`${raw?.total ? Math.round((raw.market_transfers / raw.total) * 100) : 0}% of all filings — institution-to-institution only`}
            color="text-emerald-500"
            tooltip={`A Market Transfer is an assignment where BOTH the seller and buyer are recognized institutional entities — banks, servicers, GSEs (Fannie/Freddie/HUD), private credit funds, or securitization trusts. This filters out originations (borrower → lender) and MERS registry moves (which are not real sales). Market Transfers represent genuine secondary-market activity: one professional participant selling a debt position to another. Rising Market Transfer volume signals an active trading environment; a shift in which entity types are buying vs. selling reveals capital flows and distress.`}
          />
          <StatCard
            label="Private Credit Txns"
            value={raw?.private_credit_txns?.toLocaleString()}
            icon={TrendingUp}
            sub={`${raw?.self_assigns?.toLocaleString() ?? '—'} self-assigns excluded from count`}
            color="text-purple-500"
            tooltip={`Any transaction where the buyer OR seller is classified as a private credit / PE fund. This includes: PE acquiring from a bank (the most actionable deal signal), PE acquiring from a servicer or GSE, PE selling to another institution, and PE disposing to a private party. Self-assignments — where an entity transfers a loan to its own subsidiary or affiliated LLC (e.g., "FUND LLC" → "FUND MASTER LLC") — are excluded because they carry no economic meaning; no debt actually changed hands.`}
          />
        </>)}
      </div>

      {/* Monthly Volume Chart */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Monthly Assignment Volume</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Each bar = total recorded filings that month, broken down by transaction type.
              Market Transfers are institution-to-institution trades; Originations are new loans entering the system.
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground shrink-0 ml-4">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />Market Transfers</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400 inline-block" />Originations</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-slate-400 inline-block" />Other (MERS, self-assigns, private)</span>
          </div>
        </div>
        {mLoading ? <Skeleton className="h-52" /> : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={(monthly || []).map((m: any) => ({
              ...m,
              other: m.total - (m.market_transfers || 0) - (m.originations || 0),
            }))} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tickFormatter={fmtMonth}
                tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={42}
                tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 11 }}
                labelFormatter={fmtMonth}
                formatter={(v: any, name: string) => [v.toLocaleString(), name === 'market_transfers' ? 'Market Transfers' : name === 'originations' ? 'Originations' : 'Other']}
              />
              <Bar dataKey="market_transfers" stackId="a" fill="#10b981" radius={[0,0,0,0]} maxBarSize={36} />
              <Bar dataKey="originations"     stackId="a" fill="#60a5fa" radius={[0,0,0,0]} maxBarSize={36} />
              <Bar dataKey="other"            stackId="a" fill="#94a3b8" radius={[2,2,0,0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Three-column denoised rankings */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Top Acquirers */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-green-400" />
            <h2 className="text-sm font-semibold text-foreground">Top Acquirers</h2>
          </div>
          <p className="text-[10px] text-muted-foreground mb-3">
            Entities with the most inbound assignments — i.e., they are the buyer on the most mortgage transfers.
            High inbound volume from institutional sellers signals active loan accumulation.
          </p>
          {netLoading ? <Skeleton className="h-48" /> : (
            <div>
              {(net?.top_acquirers || []).map((r: any, i: number) => (
                <EntityRow key={r.entity} rank={i+1} entity={r.entity} volume={r.inbound_vol} degree={r.degree} type={r.entity_type} label="inbound" onClick={() => setSelectedEntity(r.entity)} />
              ))}
            </div>
          )}
        </div>

        {/* Top Sellers */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown size={14} className="text-red-400" />
            <h2 className="text-sm font-semibold text-foreground">Top Sellers</h2>
          </div>
          <p className="text-[10px] text-muted-foreground mb-3">
            Entities assigning the most mortgages outward — i.e., the seller on the most transfers.
            Heavy net sellers (especially banks and servicers) are the primary deal sourcing targets.
          </p>
          {netLoading ? <Skeleton className="h-48" /> : (
            <div>
              {(net?.top_sellers || []).map((r: any, i: number) => (
                <EntityRow key={r.entity} rank={i+1} entity={r.entity} volume={r.outbound_vol} degree={r.degree} type={r.entity_type} label="outbound" onClick={() => setSelectedEntity(r.entity)} />
              ))}
            </div>
          )}
        </div>

        {/* Most Connected */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <Network size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold text-foreground">Most Connected</h2>
          </div>
          <p className="text-[10px] text-muted-foreground mb-3">
            Hub entities ranked by unique counterparty relationships. An entity with high degree has transacted with many distinct buyers/sellers — a sign of market breadth. <Star size={9} className="inline text-primary" /> marks hub entities (degree ≥ 50).
          </p>
          {netLoading ? <Skeleton className="h-48" /> : (
            <div>
              {(net?.most_connected || []).map((r: any, i: number) => (
                <EntityRow key={r.entity} rank={i+1} entity={r.entity} volume={r.degree} degree={r.degree} type={r.entity_type} label="connections" onClick={() => setSelectedEntity(r.entity)} />
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Entity Detail Panel */}
      {selectedEntity && (
        <EntityDetailPanel
          entityName={selectedEntity}
          onClose={() => setSelectedEntity(null)}
        />
      )}
    </div>
  );
}
