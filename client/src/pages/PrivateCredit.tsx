import { useState } from 'react';
import { CountyCell } from '@/components/CountyCell';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import DocLink from '@/components/DocLink';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Shield, ChevronLeft, ChevronRight, ArrowRight, ExternalLink } from 'lucide-react';
import CategoryBadge from '@/components/CategoryBadge';
import { DefTerm } from '@/components/DefTerm';

// Transaction type badge — compact version for this table
const TXN_META: Record<string, { label: string; color: string }> = {
  MARKET_TRANSFER:   { label: 'Market Transfer',  color: 'text-emerald-700 bg-emerald-100 border-emerald-300' },
  ORIGINATION:       { label: 'Origination',       color: 'text-blue-700 bg-blue-100 border-blue-300' },
  MERS_RELEASE:      { label: 'MERS Release',      color: 'text-purple-700 bg-purple-100 border-purple-300' },
  INSTITUTIONAL_OUT: { label: 'Inst. Out',          color: 'text-amber-700 bg-amber-100 border-amber-300' },
  PRIVATE:           { label: 'Private',            color: 'text-slate-600 bg-slate-100 border-slate-300' },
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
  // CFN lookup: `draft` is what is typed, `cfn` is what has been applied (Enter
  // or the Apply button). The server matches any part of the clerk file number,
  // case-insensitively.
  const [draft, setDraft] = useState('');
  const [cfn, setCfn] = useState('');
  const applyCfn = () => { setCfn(draft.trim()); setPage(1); };
  const clearCfn = () => { setDraft(''); setCfn(''); setPage(1); };

  const qs = `?page=${page}&limit=50` + (cfn ? `&cfn=${encodeURIComponent(cfn)}` : '');
  const { data: _data, isLoading } = useQuery({
    queryKey: ['/api/private-credit', page, cfn],
    queryFn: () => apiRequest('GET', `/api/private-credit${qs}`).then(r => r.json()),
    keepPreviousData: true,
  } as any);
  const data = _data as any;

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
          <h2 className="text-sm font-semibold mb-1 text-foreground"><DefTerm term="private-credit:Top Private Credit Acquirers">Top Private Credit Acquirers</DefTerm></h2>
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

      {/* CFN lookup — a real <form> so Enter applies, like every search box */}
      <div className="bg-card border border-border rounded-lg p-4">
        <form onSubmit={e => { e.preventDefault(); applyCfn(); }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">CFN</label>
            <Input placeholder="e.g. 2026R521735" value={draft}
              onChange={e => setDraft(e.target.value)} className="h-8 text-xs mt-1 font-mono"
              title="Clerk file number — matches any part of the number" />
          </div>
          <div className="flex items-end gap-2">
            <Button size="sm" type="submit" className="h-8 text-xs">Apply</Button>
            {cfn && <Button size="sm" type="button" variant="ghost" onClick={clearCfn} className="h-8 text-xs">Clear</Button>}
          </div>
        </form>
      </div>

      {/* Transactions table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {cfn && (
          <div className="px-4 py-2 border-b border-border bg-muted/10 text-[11px] text-muted-foreground">
            {data ? `${data.total.toLocaleString()} transaction${data.total === 1 ? '' : 's'} matching CFN "${cfn}"` : ''}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:CFN">CFN</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:Date">Date</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:County">County</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:Grantor (Seller)">Grantor (Seller)</DefTerm></th>
                <th className="px-2 py-2.5 w-5"></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:Grantee (Buyer)">Grantee (Buyer)</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:Type">Type</DefTerm></th>
                <th className="px-3 py-2.5 text-left font-medium"><DefTerm term="private-credit:PE Role">PE Role</DefTerm></th>
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
                      ? 'text-purple-700'
                      : pcRole === 'PE ↔ PE'
                        ? 'text-purple-500'
                        : 'text-muted-foreground';
                    return (
                      <tr key={r.cfn + r.rec_date} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2 font-mono text-primary/80 text-[11px] whitespace-nowrap">{r.cfn}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><CountyCell county={r.county} /></td>
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
                          <DocLink
                            row={r}
                            className="text-muted-foreground/30 hover:text-primary transition-colors"
                          >
                            <ExternalLink size={11} />
                          </DocLink>
                        </td>
                      </tr>
                    );
                  })
              }
              {!isLoading && !data?.rows?.length && (
                <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">{cfn ? `No private credit transactions match CFN "${cfn}".` : 'No records found.'}</td></tr>
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
