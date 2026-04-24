import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Shield, ChevronLeft, ChevronRight, ArrowRight, ExternalLink } from 'lucide-react';
import CategoryBadge from '@/components/CategoryBadge';

// Transaction type badge — compact version for this table
const TXN_META: Record<string, { label: string; color: string }> = {
  MARKET_TRANSFER:   { label: 'Market Transfer',  color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  ORIGINATION:       { label: 'Origination',       color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' },
  MERS_RELEASE:      { label: 'MERS Release',      color: 'text-purple-400 bg-purple-500/10 border-purple-500/25' },
  INSTITUTIONAL_OUT: { label: 'Inst. Out',          color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  PRIVATE:           { label: 'Private',            color: 'text-slate-400 bg-slate-500/10 border-slate-500/25' },
};

function TxnBadge({ type }: { type: string }) {
  const m = TXN_META[type];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${m.color}`}>
      {m.label}
    </span>
  );
}

export default function PrivateCredit() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/private-credit', page],
    queryFn: () => apiRequest('GET', `/api/private-credit?page=${page}&limit=50`).then(r => r.json()),
    keepPreviousData: true,
  } as any);

  const { data: assignees } = useQuery({
    queryKey: ['/api/private-credit/top-grantees'],
    queryFn: () => apiRequest('GET', '/api/private-credit/top-grantees').then(r => r.json()),
  });

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-3">
        <Shield size={20} className="text-purple-400" />
        <div>
          <h1 className="text-xl font-semibold">Private Credit</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data ? `${data.total.toLocaleString()} transactions` : 'Loading…'} involving private credit / PE entities · self-assignments excluded
          </p>
        </div>
      </div>

      {/* Top PE acquirers */}
      {assignees && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-1 text-foreground">Top Private Credit Acquirers</h2>
          <p className="text-[10px] text-muted-foreground mb-3">Ranked by inbound assignment count — self-assigns excluded</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(assignees as any[]).map((row, i) => (
              <div key={row.name} className="flex items-center justify-between gap-2 bg-muted/30 rounded px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}</span>
                  <span className="text-xs font-medium truncate" title={row.name}>{row.name}</span>
                </div>
                <span className="text-xs font-mono text-purple-400 shrink-0">{row.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transactions table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">CFN</th>
                <th className="px-3 py-2.5 text-left font-medium">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">Grantor (Seller)</th>
                <th className="px-2 py-2.5 w-5"></th>
                <th className="px-3 py-2.5 text-left font-medium">Grantee (Buyer)</th>
                <th className="px-3 py-2.5 text-left font-medium">Type</th>
                <th className="px-3 py-2.5 text-left font-medium">PE Role</th>
                <th className="px-3 py-2.5 text-center font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(8).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any) => {
                    const bothPc = r.grantor_category === 'PRIVATE_CREDIT' && r.grantee_category === 'PRIVATE_CREDIT';
                    const pcRole = bothPc
                      ? 'PE ↔ PE'
                      : r.grantee_category === 'PRIVATE_CREDIT'
                        ? 'Acquiring'
                        : 'Selling';
                    const roleColor = pcRole === 'Acquiring'
                      ? 'text-purple-400'
                      : pcRole === 'PE ↔ PE'
                        ? 'text-purple-300'
                        : 'text-muted-foreground';
                    return (
                      <tr key={r.cfn + r.rec_date} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2 font-mono text-primary/80 text-[11px] whitespace-nowrap">{r.cfn}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        <td className="px-3 py-2 max-w-[180px]">
                          <div className="truncate font-medium text-foreground" title={r.assignor_canon}>{r.assignor_canon}</div>
                          {r.grantor !== r.assignor_canon && (
                            <div className="truncate text-[10px] text-muted-foreground" title={r.grantor}>{r.grantor}</div>
                          )}
                          <CategoryBadge category={r.grantor_category} size="xs" />
                        </td>
                        <td className="px-1 py-2 text-center">
                          <ArrowRight size={11} className="text-muted-foreground/30 mx-auto" />
                        </td>
                        <td className="px-3 py-2 max-w-[180px]">
                          <div className="truncate font-medium text-foreground" title={r.assignee_canon}>{r.assignee_canon}</div>
                          {r.grantee !== r.assignee_canon && (
                            <div className="truncate text-[10px] text-muted-foreground" title={r.grantee}>{r.grantee}</div>
                          )}
                          <CategoryBadge category={r.grantee_category} size="xs" />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <TxnBadge type={r.txn_type} />
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium ${roleColor}`}>{pcRole}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <a
                            href={`https://www2.miamidadeclerk.gov/ocs/Search.aspx?QS=RN${r.cfn}`}
                            target="_blank" rel="noopener noreferrer"
                            className="text-muted-foreground/30 hover:text-primary transition-colors"
                            title="View on county portal"
                          >
                            <ExternalLink size={11} />
                          </a>
                        </td>
                      </tr>
                    );
                  })
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">Page {page} of {data.pages} · {data.total.toLocaleString()} total</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(1)} className="h-7 px-2 text-xs">First</Button>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-7 w-7 p-0"><ChevronLeft size={14} /></Button>
              <span className="text-xs text-muted-foreground px-2">{page} / {data.pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="h-7 w-7 p-0"><ChevronRight size={14} /></Button>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(data.pages)} className="h-7 px-2 text-xs">Last</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
