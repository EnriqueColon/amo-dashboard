import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Shield, ChevronLeft, ChevronRight } from 'lucide-react';
import CategoryBadge from '@/components/CategoryBadge';

export default function PrivateCredit() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/private-credit', page],
    queryFn: () => apiRequest('GET', `/api/private-credit?page=${page}&limit=50`).then(r => r.json()),
    keepPreviousData: true,
  } as any);

  // Top private credit purchasers (grantees by inbound volume)
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
            {data ? `${data.total.toLocaleString()} transactions` : 'Loading...'} involving private credit entities
          </p>
        </div>
      </div>

      {/* Top PC grantees */}
      {assignees && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3 text-foreground">Top Private Credit Purchasers (Grantees)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(assignees as any[]).map((row, i) => (
              <div key={row.name} className="flex items-center justify-between gap-2 bg-muted/30 rounded px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-muted-foreground w-4 shrink-0">{i+1}</span>
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
                <th className="px-3 py-2.5 text-left font-medium">Grantor</th>
                <th className="px-3 py-2.5 text-left font-medium">Grantee</th>
                <th className="px-3 py-2.5 text-left font-medium">Role</th>
                <th className="px-3 py-2.5 text-left font-medium">Address</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(6).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (data?.rows || []).map((r: any) => {
                    const pcRole = r.grantee_category === 'PRIVATE_CREDIT' ? 'Purchaser' : 'Seller';
                    return (
                      <tr key={r.cfn + r.rec_date} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-primary whitespace-nowrap">{r.cfn}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.rec_date}</td>
                        <td className="px-3 py-2 max-w-[180px]">
                          <div className="truncate font-medium" title={r.grantor}>{r.grantor}</div>
                          <CategoryBadge category={r.grantor_category} size="xs" />
                        </td>
                        <td className="px-3 py-2 max-w-[180px]">
                          <div className="truncate font-medium" title={r.grantee}>{r.grantee}</div>
                          <CategoryBadge category={r.grantee_category} size="xs" />
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium ${pcRole === 'Purchaser' ? 'text-purple-400' : 'text-muted-foreground'}`}>{pcRole}</span>
                        </td>
                        <td className="px-3 py-2 max-w-[200px] truncate text-muted-foreground" title={r.address}>{r.address}</td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
        </div>
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">Page {page} of {data.pages} · {data.total.toLocaleString()} total</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-7 w-7 p-0"><ChevronLeft size={14} /></Button>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="h-7 w-7 p-0"><ChevronRight size={14} /></Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
