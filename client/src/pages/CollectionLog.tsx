import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle, AlertTriangle, XCircle, ClipboardList } from 'lucide-react';

function StatusIcon({ status }: { status: string }) {
  if (status === 'OK') return <CheckCircle size={13} className="text-green-400 shrink-0" />;
  if (status === 'CAPPED') return <AlertTriangle size={13} className="text-amber-400 shrink-0" />;
  return <XCircle size={13} className="text-red-400 shrink-0" />;
}

export default function CollectionLog() {
  const { data: log, isLoading } = useQuery({
    queryKey: ['/api/collection-log'],
    queryFn: () => apiRequest('GET', '/api/collection-log').then(r => r.json()),
  });

  const stats = (() => {
    if (!log) return null;
    const ok = log.filter((r: any) => r.status === 'OK').length;
    const capped = log.filter((r: any) => r.status === 'CAPPED').length;
    const err = log.filter((r: any) => r.status === 'ERROR').length;
    const total_records = log.reduce((s: number, r: any) => s + (r.records_found || 0), 0);
    return { ok, capped, err, total: log.length, total_records };
  })();

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-3">
        <ClipboardList size={20} className="text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">Collection Log</h1>
          <p className="text-sm text-muted-foreground mt-0.5">History of all data collection runs</p>
        </div>
      </div>

      {/* Summary pills */}
      {stats && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-3 py-1">
            <CheckCircle size={12} className="text-green-600" />
            <span className="text-xs text-green-700 font-medium">{stats.ok} OK</span>
          </div>
          <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
            <AlertTriangle size={12} className="text-amber-600" />
            <span className="text-xs text-amber-700 font-medium">{stats.capped} Capped</span>
          </div>
          <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-full px-3 py-1">
            <XCircle size={12} className="text-red-600" />
            <span className="text-xs text-red-700 font-medium">{stats.err} Errors</span>
          </div>
          <div className="text-xs text-muted-foreground ml-2">
            {stats.total_records.toLocaleString()} total records across {stats.total} collection windows
          </div>
        </div>
      )}

      {/* Log table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/20">
              <tr className="text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">Date From</th>
                <th className="px-3 py-2.5 text-left font-medium">Date To</th>
                <th className="px-3 py-2.5 text-right font-medium">Records Found</th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array(15).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(4).fill(0).map((_, j) => <td key={j} className="px-3 py-2"><Skeleton className="h-3 w-full" /></td>)}
                    </tr>
                  ))
                : (log || []).map((r: any, i: number) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={r.status} />
                        <span className={`status-${r.status}`}>{r.status}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{r.date_from}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{r.date_to}</td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {r.records_found > 0 ? r.records_found.toLocaleString() : <span className="text-muted-foreground">0</span>}
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
