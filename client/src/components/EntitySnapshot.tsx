// One-screen snapshot of a firm, shown at the top of the entity card's Overview.
// Built for the Reporting feed (docs/REPORTING_FEED_PLAN.md step 2): everything
// we hold about the firm in one place. Each block renders only when it has data.
// FDIC data for banks is EntityFdicSection; SEC (filers) and news are later steps.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { apiRequest } from '@/lib/queryClient';
import DocLink from './DocLink';
import EntityFdicSection from './EntityFdicSection';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Crosshair, Building2, FileText, Landmark, Gavel, Info, MapPin } from 'lucide-react';

const usd = (v: number | null | undefined) =>
  v && v > 0
    ? v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M` : `$${Math.round(v).toLocaleString('en-US')}`
    : null;

const COUNTY_NAME: Record<string, string> = {
  'MIAMI-DADE': 'Miami-Dade', BROWARD: 'Broward', HILLSBOROUGH: 'Hillsborough',
};

function Section({ icon: Icon, title, note, children }: {
  icon: any; title: string; note?: string; children: React.ReactNode;
}) {
  return (
    <div className="border border-border/60 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold flex items-center gap-1.5"><Icon size={12} className="text-primary" />{title}</p>
        {note && <span className="text-[10px] text-muted-foreground" title={note}><Info size={10} className="inline -mt-0.5 mr-0.5" />name match</span>}
      </div>
      {children}
    </div>
  );
}

export default function EntitySnapshot({ entityName, entityType, onNavigate }: {
  entityName: string;
  entityType?: string;
  onNavigate?: (name: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/entity/snapshot', entityName],
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}/snapshot`).then(r => r.json()),
    enabled: !!entityName,
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return null;

  const d = data.dollars || {};
  const monthly: any[] = data.monthly || [];
  const recent: any[] = data.recent || [];
  const ucc = data.ucc || {};
  const fac = data.facilities || {};
  const comp = data.complaints;
  const nameNote = 'Matched on the start of the firm\'s name, not a verified link. A firm with a common name can pick up another firm\'s filings.';
  const NameBtn = ({ n }: { n: string }) => onNavigate
    ? <button onClick={() => onNavigate(n)} className="hover:text-primary hover:underline text-left">{n}</button>
    : <span>{n}</span>;

  return (
    <div className="space-y-3">
      {/* Who it is */}
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        {data.target && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-amber-100 text-amber-700 font-medium"
            title={data.target.notes || `On your targets since ${String(data.target.added_at || '').slice(0, 10)}`}>
            <Crosshair size={10} />On your targets
          </span>
        )}
        {(data.parents || []).map((p: any) => (
          <span key={p.parent} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border border-border text-muted-foreground"
            title={`Named next to this firm on ${p.n} of its filings: usually a servicer, owner or predecessor, not necessarily its parent company`}>
            <Building2 size={10} />Named with: <NameBtn n={p.parent} />
          </span>
        ))}
        {(data.counties || []).map((c: any) => (
          <span key={c.county} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border border-border text-muted-foreground">
            <MapPin size={10} />{COUNTY_NAME[c.county] || c.county} · {c.n.toLocaleString()}
          </span>
        ))}
      </div>

      <EntityFdicSection entityName={entityName} entityType={entityType} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        {/* Money + trend */}
        <Section icon={Landmark} title="Assignment activity, last 24 months">
          {(usd(d.in_amount) || usd(d.out_amount)) && (
            <div className="flex gap-4 mb-2 text-xs">
              {usd(d.in_amount) && <div><p className="text-orange-500 font-semibold text-base">{usd(d.in_amount)}</p>
                <p className="text-[10px] text-muted-foreground">acquired ({d.in_with_amount.toLocaleString()} with an amount)</p></div>}
              {usd(d.out_amount) && <div><p className="text-blue-500 font-semibold text-base">{usd(d.out_amount)}</p>
                <p className="text-[10px] text-muted-foreground">sold or assigned out ({d.out_with_amount.toLocaleString()} with an amount)</p></div>}
            </div>
          )}
          {monthly.length > 0 ? (
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="inbound" name="Acquired" stackId="a" fill="#f97316" />
                  <Bar dataKey="outbound" name="Assigned out" stackId="a" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-[11px] text-muted-foreground">No filings in the last 24 months.</p>}
        </Section>

        {/* Latest filings */}
        {recent.length > 0 && (
          <Section icon={FileText} title="Latest filings">
            <ul className="text-[11px] divide-y divide-border/50">
              {recent.map((r: any) => (
                <li key={r.cfn} className="py-1 flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">{r.rec_date}</span>
                  <span className={`shrink-0 ${r.direction === 'in' ? 'text-orange-500' : 'text-blue-500'}`}>{r.direction === 'in' ? 'from' : 'to'}</span>
                  <span className="truncate flex-1" title={r.counterparty}><NameBtn n={r.counterparty} /></span>
                  {usd(r.amount) && <span className="font-mono text-emerald-600 shrink-0">{usd(r.amount)}</span>}
                  <DocLink row={r} className="font-mono text-primary/70 hover:underline shrink-0">{r.cfn}</DocLink>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* UCC */}
        {(ucc.as_lender > 0 || ucc.as_borrower > 0) && (
          <Section icon={FileText} title="UCC filings" note={nameNote}>
            <p className="text-xs mb-1.5">
              <span className="font-semibold">{ucc.as_lender.toLocaleString()}</span> <span className="text-muted-foreground">as lender</span>
              {' · '}<span className="font-semibold">{ucc.as_borrower.toLocaleString()}</span> <span className="text-muted-foreground">as borrower</span>
              {ucc.last && <span className="text-muted-foreground"> · last {ucc.last}</span>}
            </p>
            <ul className="text-[11px] divide-y divide-border/50">
              {(ucc.recent || []).map((u: any) => (
                <li key={u.cfn} className="py-1 flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">{u.rec_date}</span>
                  <span className="truncate flex-1" title={`${u.lender} → ${u.borrower}`}>{u.lender} → {u.borrower}</span>
                  <DocLink row={u} className="font-mono text-primary/70 hover:underline shrink-0">{u.cfn}</DocLink>
                </li>
              ))}
            </ul>
            <Link href="/ucc" className="text-[11px] text-primary hover:underline">Open UCC Filings →</Link>
          </Section>
        )}

        {/* Credit facilities */}
        {fac.count > 0 && (
          <Section icon={Landmark} title={`Credit facilities (${fac.count})`} note={nameNote}>
            <ul className="text-[11px] divide-y divide-border/50">
              {(fac.recent || []).map((f: any) => (
                <li key={f.cfn} className="py-1 flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">{f.rec_date}</span>
                  <span className="truncate flex-1" title={`${f.lender} → ${f.borrower}`}>{f.lender} → {f.borrower}</span>
                  {usd(f.facility_amount) && <span className="font-mono text-emerald-600 shrink-0">{usd(f.facility_amount)}</span>}
                </li>
              ))}
            </ul>
            <Link href="/credit-facilities" className="text-[11px] text-primary hover:underline">Open Lending Relationships →</Link>
          </Section>
        )}

        {/* Foreclosure complaints */}
        {comp && comp.count > 0 && (
          <Section icon={Gavel} title={`Foreclosure complaints as plaintiff (${comp.count}${comp.count === 20 ? '+' : ''})`} note={nameNote}>
            <ul className="text-[11px] divide-y divide-border/50">
              {comp.recent.map((c: any) => (
                <li key={c.case_number} className="py-1 flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">{c.filing_date}</span>
                  <span className="font-mono shrink-0">{c.case_number}</span>
                  <span className="truncate flex-1 text-muted-foreground" title={c.plaintiff}>{c.plaintiff}</span>
                </li>
              ))}
            </ul>
            <Link href="/complaints" className="text-[11px] text-primary hover:underline">Open Complaints →</Link>
          </Section>
        )}
      </div>
    </div>
  );
}
