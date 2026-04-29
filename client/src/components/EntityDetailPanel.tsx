import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import CategoryBadge from './CategoryBadge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  X, ArrowRight, TrendingUp, TrendingDown, Network,
  Calendar, ChevronDown, ChevronUp, Layers, Info,
} from 'lucide-react';

// ── Stat pill ─────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-muted/20 border border-border/50 rounded-lg px-4 py-3 min-w-[110px]">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${color ?? 'text-foreground'}`}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ── Counterparty bar ──────────────────────────────────────────────────────────
function CounterpartyBar({ items, max, direction }: { items: any[]; max: number; direction: 'in' | 'out' }) {
  const color = direction === 'in' ? 'bg-orange-500/60' : 'bg-blue-500/60';
  return (
    <div className="space-y-1.5">
      {items.map((cp: any) => (
        <div key={cp.entity} className="flex items-center gap-2 text-xs">
          <div className="w-[130px] shrink-0 truncate font-medium text-foreground" title={cp.entity}>{cp.entity}</div>
          <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
            <div className={`h-full ${color} rounded-full`} style={{ width: `${(cp.txn_count / max) * 100}%` }} />
          </div>
          <div className="w-8 text-right text-muted-foreground font-mono text-[11px]">{cp.txn_count}</div>
          <div className="w-[70px] shrink-0"><CategoryBadge category={cp.entity_type} size="xs" /></div>
        </div>
      ))}
    </div>
  );
}

// ── Transaction row ───────────────────────────────────────────────────────────
function TxnRow({ r, direction }: { r: any; direction: 'in' | 'out' }) {
  return (
    <tr className="border-b border-border/40 hover:bg-muted/20 transition-colors">
      <td className="px-3 py-2 font-mono text-primary text-[11px] whitespace-nowrap">
        <a
          href={`https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${r.rec_book}&sBookType=O+&sPage=${r.rec_page}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >{r.cfn}</a>
      </td>
      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.rec_date}</td>
      <td className="px-3 py-2 max-w-[180px]">
        <div className="font-medium text-foreground truncate" title={r.counterparty}>{r.counterparty}</div>
        {r.counterparty_raw && r.counterparty_raw !== r.counterparty && (
          <div className="text-[10px] text-muted-foreground truncate" title={r.counterparty_raw}>{r.counterparty_raw}</div>
        )}
        <CategoryBadge category={r.counterparty_type} size="xs" />
      </td>
      <td className="px-3 py-2 text-center">
        {direction === 'in'
          ? <span className="text-orange-400 text-[10px] font-medium">→ You</span>
          : <span className="text-blue-400 text-[10px] font-medium">You →</span>
        }
      </td>
      <td className="px-3 py-2 font-mono text-muted-foreground text-[11px] whitespace-nowrap">{r.rec_book}/{r.rec_page}</td>
    </tr>
  );
}

// ── Sub-entity row (expandable) ───────────────────────────────────────────────
function SubEntityRow({ sub, direction }: { sub: any; direction: 'buyer' | 'seller' }) {
  const [open, setOpen] = useState(false);
  const dirColor  = direction === 'buyer' ? 'text-orange-500' : 'text-blue-500';
  const dirLabel  = direction === 'buyer' ? 'bought from' : 'sold to';

  return (
    <>
      <tr
        onClick={() => setOpen(v => !v)}
        className="border-b border-border/40 hover:bg-muted/20 cursor-pointer transition-colors group"
      >
        <td className="px-3 py-2.5 max-w-[240px]">
          <div className="flex items-center gap-1.5">
            {open
              ? <ChevronUp size={11} className="text-muted-foreground/60 shrink-0" />
              : <ChevronDown size={11} className="text-muted-foreground/60 shrink-0" />}
            <span className="font-mono text-[11px] text-foreground truncate group-hover:text-primary transition-colors" title={sub.raw_name}>
              {sub.raw_name}
            </span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <span className={`font-mono text-xs font-semibold ${dirColor}`}>{sub.txn_count}</span>
        </td>
        <td className="px-3 py-2.5 text-muted-foreground text-[11px] whitespace-nowrap">
          {sub.first_seen} → {sub.last_seen}
        </td>
        <td className="px-3 py-2.5">
          {sub.counterparties.slice(0, 3).map((cp: any) => (
            <div key={cp.entity} className="flex items-center gap-1 text-[10px]">
              <span className="text-muted-foreground/60">{dirLabel}</span>
              <span className="font-medium text-foreground truncate max-w-[130px]" title={cp.entity}>{cp.entity}</span>
              <span className="text-muted-foreground/50 font-mono">({cp.n})</span>
            </div>
          ))}
          {sub.counterparties.length === 0 && (
            <span className="text-[10px] text-muted-foreground/40 italic">no data</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/30 bg-muted/10">
          <td colSpan={4} className="px-5 py-3">
            <p className="text-[10px] text-muted-foreground mb-2 font-medium uppercase tracking-wide">
              {direction === 'buyer' ? 'All sellers into this vehicle' : 'All buyers from this vehicle'}
            </p>
            <div className="space-y-1.5">
              {sub.counterparties.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic">No counterparty data available.</p>
              )}
              {sub.counterparties.map((cp: any) => (
                <div key={cp.entity} className="flex items-center gap-2 text-[11px]">
                  <div className="w-[180px] shrink-0 font-medium text-foreground truncate" title={cp.entity}>{cp.entity}</div>
                  <div className="flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden max-w-[120px]">
                    <div
                      className={`h-full rounded-full ${direction === 'buyer' ? 'bg-orange-400/60' : 'bg-blue-400/60'}`}
                      style={{ width: `${Math.min(100, (cp.n / sub.counterparties[0]?.n) * 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-muted-foreground w-6 text-right">{cp.n}</span>
                  <CategoryBadge category={cp.type} size="xs" />
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
interface Props {
  entityName: string;
  onClose: () => void;
  onNavigate?: (name: string) => void;
}

export default function EntityDetailPanel({ entityName, onClose, onNavigate }: Props) {
  const [tab, setTab] = useState<'overview' | 'inbound' | 'outbound' | 'sub-entities'>('overview');
  const [inboundExpanded, setInboundExpanded] = useState(true);
  const [outboundExpanded, setOutboundExpanded] = useState(true);
  const [subDirection, setSubDirection] = useState<'buyer' | 'seller'>('buyer');

  const { data, isLoading } = useQuery({
    queryKey: ['/api/entity', entityName],
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}`).then(r => r.json()),
    enabled: !!entityName,
  });

  const { data: subData, isLoading: subLoading } = useQuery({
    queryKey: ['/api/entity-sub', entityName],
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}/sub-entities`).then(r => r.json()),
    enabled: !!entityName && tab === 'sub-entities',
    staleTime: 10 * 60 * 1000,
  });

  const node = data?.node;
  const classification = data?.classification;
  const inbound: any[] = data?.as_grantee ?? [];
  const outbound: any[] = data?.as_grantor ?? [];
  const topSenders: any[] = data?.top_senders ?? [];
  const topReceivers: any[] = data?.top_receivers ?? [];
  const maxSender = topSenders[0]?.txn_count ?? 1;
  const maxReceiver = topReceivers[0]?.txn_count ?? 1;

  const buyerSubs: any[]  = subData?.buyer_subs  ?? [];
  const sellerSubs: any[] = subData?.seller_subs ?? [];
  const activeSubs = subDirection === 'buyer' ? buyerSubs : sellerSubs;
  // Unique raw name count (a name may appear in both buyer and seller subs)
  const uniqueRawNames = new Set([...buyerSubs.map((s: any) => s.raw_name), ...sellerSubs.map((s: any) => s.raw_name)]);
  const subCount = tab === 'sub-entities' && !subLoading ? uniqueRawNames.size : null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-3xl bg-background border-l border-border flex flex-col h-full overflow-hidden shadow-2xl">

        {/* ── Panel header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <Skeleton className="h-6 w-48 mb-1" />
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold text-foreground truncate">{entityName}</h2>
                  {node && <CategoryBadge category={node.entity_type} size="sm" />}
                  {classification && (
                    <span className="text-[10px] px-2 py-0.5 bg-muted/30 rounded border border-border/50 text-muted-foreground">
                      {classification.sub_category}
                    </span>
                  )}
                </div>
                {node && (
                  <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                    <Calendar size={10} />
                    <span>Active {node.first_seen} → {node.last_seen}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <button onClick={onClose} className="ml-3 p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* ── Stats bar ────────────────────────────────────────────────── */}
        {!isLoading && node && (
          <div className="px-5 py-3 border-b border-border shrink-0">
            <div className="flex flex-wrap gap-2">
              <Stat label="Received (inbound)" value={node.inbound_vol} sub="mortgages acquired" color="text-orange-400" />
              <Stat label="Assigned (outbound)" value={node.outbound_vol} sub="mortgages transferred" color="text-blue-400" />
              <Stat label="Total volume" value={node.total_vol} sub="clean transactions" />
              <Stat label="Counterparties" value={node.degree} sub="unique relationships" color="text-purple-400" />
            </div>
          </div>
        )}
        {isLoading && (
          <div className="px-5 py-3 border-b border-border shrink-0 flex gap-2">
            {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-16 w-28" />)}
          </div>
        )}

        {/* ── Tabs ─────────────────────────────────────────────────────── */}
        <div className="flex border-b border-border shrink-0 px-5 overflow-x-auto">
          {([
            { id: 'overview',      label: 'Overview',  icon: Network },
            { id: 'sub-entities',  label: `Legal Vehicles${subCount !== null ? ` (${subCount})` : ''}`, icon: Layers },
            { id: 'inbound',       label: `Inbound (${inbound.length}${inbound.length===500?'+':''})`,   icon: TrendingDown },
            { id: 'outbound',      label: `Outbound (${outbound.length}${outbound.length===500?'+':''})`, icon: TrendingUp },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors -mb-px
                ${tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <t.icon size={11} />
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* OVERVIEW TAB */}
          {tab === 'overview' && (
            <div className="p-5 space-y-5">

              {/* What this entity does */}
              {!isLoading && (
                <div className="bg-muted/10 border border-border/50 rounded-lg p-4 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground text-sm">Activity summary</p>
                  {node ? (
                    <p className="leading-relaxed">
                      <span className="text-foreground font-medium">{entityName}</span> has{' '}
                      <span className="text-orange-400 font-medium">received {node.inbound_vol.toLocaleString()} mortgage{node.inbound_vol !== 1 ? 's' : ''}</span> (acting as buyer/assignee) and{' '}
                      <span className="text-blue-400 font-medium">transferred {node.outbound_vol.toLocaleString()} mortgage{node.outbound_vol !== 1 ? 's' : ''}</span> (acting as seller/assignor) across{' '}
                      <span className="text-purple-400 font-medium">{node.degree.toLocaleString()} unique counterparties</span>{' '}
                      in Miami-Dade County between {node.first_seen} and {node.last_seen}.
                    </p>
                  ) : (
                    <p>No network data found for this entity.</p>
                  )}
                </div>
              )}

              {/* Top senders → this entity */}
              {topSenders.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center justify-between mb-3"
                    onClick={() => setInboundExpanded(e => !e)}
                  >
                    <div className="flex items-center gap-2">
                      <TrendingDown size={13} className="text-orange-400" />
                      <span className="text-sm font-semibold">Top sources — who assigns TO {entityName}</span>
                    </div>
                    {inboundExpanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                  </button>
                  {inboundExpanded && (
                    <>
                      <CounterpartyBar items={topSenders} max={maxSender} direction="in" />
                      {topSenders.length === 10 && (
                        <button onClick={() => setTab('inbound')} className="mt-2 text-[11px] text-primary hover:underline">
                          View all {inbound.length} inbound transactions →
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* This entity → top receivers */}
              {topReceivers.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center justify-between mb-3"
                    onClick={() => setOutboundExpanded(e => !e)}
                  >
                    <div className="flex items-center gap-2">
                      <TrendingUp size={13} className="text-blue-400" />
                      <span className="text-sm font-semibold">Top destinations — who {entityName} assigns TO</span>
                    </div>
                    {outboundExpanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                  </button>
                  {outboundExpanded && (
                    <>
                      <CounterpartyBar items={topReceivers} max={maxReceiver} direction="out" />
                      {topReceivers.length === 10 && (
                        <button onClick={() => setTab('outbound')} className="mt-2 text-[11px] text-primary hover:underline">
                          View all {outbound.length} outbound transactions →
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {!isLoading && topSenders.length === 0 && topReceivers.length === 0 && (
                <div className="py-12 text-center text-muted-foreground text-sm">
                  No clean transaction data found for this entity.
                  <p className="text-xs mt-1">This entity may only appear in raw assignments under a different name variant.</p>
                </div>
              )}
            </div>
          )}

          {/* INBOUND TAB */}
          {tab === 'inbound' && (
            <div className="overflow-x-auto">
              <div className="px-5 py-3 border-b border-border/50 bg-muted/10 text-xs text-muted-foreground flex items-center gap-2">
                <TrendingDown size={11} className="text-orange-400" />
                Mortgages <strong className="text-foreground">assigned TO</strong> {entityName} — {entityName} is the receiving/buying party
              </div>
              <table className="w-full text-xs">
                <thead className="border-b border-border bg-muted/20">
                  <tr className="text-muted-foreground">
                    <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Assigned From (Seller)</th>
                    <th className="px-3 py-2.5 text-center font-medium">Direction</th>
                    <th className="px-3 py-2.5 text-left font-medium">Book / Page</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading
                    ? Array(10).fill(0).map((_, i) => (
                        <tr key={i} className="border-b border-border/50">
                          {Array(5).fill(0).map((_, j) => <td key={j} className="px-3 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                        </tr>
                      ))
                    : inbound.length === 0
                      ? <tr><td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">No inbound transactions found.</td></tr>
                      : inbound.map((r: any, i: number) => <TxnRow key={`in-${r.cfn}-${i}`} r={r} direction="in" />)
                  }
                </tbody>
              </table>
              {inbound.length === 500 && (
                <div className="px-5 py-3 text-xs text-muted-foreground border-t border-border">Showing first 500 records.</div>
              )}
            </div>
          )}

          {/* SUB-ENTITIES TAB */}
          {tab === 'sub-entities' && (
            <div className="flex flex-col h-full">
              {/* Explainer */}
              <div className="px-5 py-3 bg-muted/10 border-b border-border/50 flex items-start gap-2">
                <Info size={12} className="text-primary mt-0.5 shrink-0" />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  <strong className="text-foreground">Legal Vehicles</strong> are the distinct legal entities that appear
                  in county records under the <span className="text-primary font-medium">{entityName}</span> canonical umbrella.
                  For trusts like TOWD POINT, each numbered series is a separate legal issuer but the same economic actor.
                  Understanding <em>which vehicle</em> buys from whom — and when — reveals how the program deploys capital across vintages.
                </p>
              </div>

              {/* Buyer / Seller toggle */}
              <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border/50 shrink-0">
                <span className="text-[10px] text-muted-foreground mr-1">Role:</span>
                {(['buyer', 'seller'] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => setSubDirection(d)}
                    className={`px-3 py-1 rounded text-[11px] font-medium border transition-colors ${
                      subDirection === d
                        ? d === 'buyer' ? 'bg-orange-500/10 text-orange-600 border-orange-300' : 'bg-blue-500/10 text-blue-600 border-blue-300'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {d === 'buyer' ? `▼ As Buyer (${buyerSubs.length})` : `▲ As Seller (${sellerSubs.length})`}
                  </button>
                ))}
                {!subLoading && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {activeSubs.length} vehicle{activeSubs.length !== 1 ? 's' : ''} · {activeSubs.reduce((s: number, r: any) => s + r.txn_count, 0).toLocaleString()} transactions
                  </span>
                )}
              </div>

              {/* Table */}
              {subLoading ? (
                <div className="p-5 space-y-2">
                  {Array(8).fill(0).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : activeSubs.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-10 text-center">
                  <div>
                    <Layers size={32} className="mx-auto mb-2 text-muted-foreground/30" />
                    <p>No sub-entity data found for this role.</p>
                    <p className="text-xs mt-1 text-muted-foreground/60">Try switching to the other role above.</p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="border-b border-border bg-muted/20 sticky top-0 z-10">
                      <tr className="text-muted-foreground">
                        <th className="px-3 py-2.5 text-left font-medium">Legal Vehicle (Raw Name)</th>
                        <th className="px-3 py-2.5 text-right font-medium">
                          {subDirection === 'buyer'
                            ? <span className="text-orange-500">Acquisitions</span>
                            : <span className="text-blue-500">Dispositions</span>}
                        </th>
                        <th className="px-3 py-2.5 text-left font-medium">Active Period</th>
                        <th className="px-3 py-2.5 text-left font-medium">
                          {subDirection === 'buyer' ? 'Bought from (top sources)' : 'Sold to (top destinations)'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeSubs.map((sub: any) => (
                        <SubEntityRow key={sub.raw_name} sub={sub} direction={subDirection} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* OUTBOUND TAB */}
          {tab === 'outbound' && (
            <div className="overflow-x-auto">
              <div className="px-5 py-3 border-b border-border/50 bg-muted/10 text-xs text-muted-foreground flex items-center gap-2">
                <TrendingUp size={11} className="text-blue-400" />
                Mortgages <strong className="text-foreground">assigned FROM</strong> {entityName} — {entityName} is the selling/transferring party
              </div>
              <table className="w-full text-xs">
                <thead className="border-b border-border bg-muted/20">
                  <tr className="text-muted-foreground">
                    <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                    <th className="px-3 py-2.5 text-left font-medium">Date</th>
                    <th className="px-3 py-2.5 text-left font-medium">Assigned To (Buyer)</th>
                    <th className="px-3 py-2.5 text-center font-medium">Direction</th>
                    <th className="px-3 py-2.5 text-left font-medium">Book / Page</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading
                    ? Array(10).fill(0).map((_, i) => (
                        <tr key={i} className="border-b border-border/50">
                          {Array(5).fill(0).map((_, j) => <td key={j} className="px-3 py-2.5"><Skeleton className="h-3 w-full" /></td>)}
                        </tr>
                      ))
                    : outbound.length === 0
                      ? <tr><td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">No outbound transactions found.</td></tr>
                      : outbound.map((r: any, i: number) => <TxnRow key={`out-${r.cfn}-${i}`} r={r} direction="out" />)
                  }
                </tbody>
              </table>
              {outbound.length === 500 && (
                <div className="px-5 py-3 text-xs text-muted-foreground border-t border-border">Showing first 500 records.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
