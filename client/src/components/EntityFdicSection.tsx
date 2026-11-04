// FDIC block of the entity profile card (docs/REPORTING_FEED_PLAN.md step 3).
// The server suggests the FDIC charter whose name matches (largest by assets);
// a person confirms it, picks another, or marks the firm as not an FDIC bank.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { formatThousands, formatPct, loadBsMeta } from '@/lib/bank-stress';
import { BankStressDrawer } from './BankStressDrawer';
import { Landmark, Check, X, RotateCcw, ExternalLink } from 'lucide-react';

const TIER_STYLE: Record<string, string> = {
  pressure:  'bg-red-100 text-red-700',
  watchlist: 'bg-amber-100 text-amber-700',
  normal:    'bg-emerald-100 text-emerald-700',
};

function quarterLabel(repdte: unknown): string {
  const s = String(repdte ?? '');
  if (!/^\d{8}$/.test(s)) return s;
  return `Q${Math.ceil(Number(s.slice(4, 6)) / 3)} ${s.slice(0, 4)}`;
}

function Fig({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5" title={hint}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function EntityFdicSection({ entityName, entityType }: { entityName: string; entityType?: string }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [openCert, setOpenCert] = useState<number | null>(null);
  const key = ['/api/entity/fdic', entityName];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}/fdic`).then(r => r.json()),
    enabled: !!entityName,
  });
  const { data: meta } = useQuery({ queryKey: ['bs-meta'], queryFn: loadBsMeta, enabled: openCert != null, staleTime: 3600_000 });
  const url = `/api/entity/${encodeURIComponent(entityName)}/fdic`;
  const done = () => { setPicking(false); qc.invalidateQueries({ queryKey: key }); };
  const setLink = useMutation({ mutationFn: (body: object) => apiRequest('PUT', url, body).then(r => r.json()), onSuccess: done });
  const reset = useMutation({ mutationFn: () => apiRequest('DELETE', url).then(r => r.json()), onSuccess: done });

  if (!data || data.status === 'unavailable') return null;
  const isBank = entityType === 'BANK';
  // Only banks get the block, plus anything a person has linked by hand.
  if (!isBank && data.status !== 'confirmed') return null;

  const b = data.bank;
  const s = b?.score;
  const candidates: any[] = data.candidates || [];
  const busy = setLink.isPending || reset.isPending;

  return (
    <div className="border border-border/60 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <p className="text-xs font-semibold flex items-center gap-1.5"><Landmark size={12} className="text-primary" />FDIC bank data</p>
        {data.status === 'confirmed' && (
          <span className="text-[10px] inline-flex items-center gap-1 text-emerald-700">
            <Check size={10} />Confirmed link
            <button onClick={() => reset.mutate()} disabled={busy} className="ml-1 text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5" title="Go back to the automatic suggestion">
              <RotateCcw size={9} />reset
            </button>
          </span>
        )}
        {data.status === 'suggested' && (
          <span className="text-[10px] rounded px-1.5 py-0.5 bg-amber-100 text-amber-700" title="Matched on the bank's name, not yet confirmed by a person">
            Suggested match: {data.basis}
          </span>
        )}
      </div>

      {data.status === 'not_bank' && (
        <p className="text-[11px] text-muted-foreground">
          Marked as not an FDIC-insured bank.{' '}
          <button onClick={() => reset.mutate()} disabled={busy} className="text-primary hover:underline">Undo</button>
        </p>
      )}

      {data.status === 'no_match' && (
        <p className="text-[11px] text-muted-foreground">
          No active FDIC-insured bank matches this name. It may be a non-bank lender, a credit union (insured by
          the NCUA, not the FDIC), or a bank that has closed or merged.
        </p>
      )}

      {b && (data.status === 'suggested' || data.status === 'confirmed') && (
        <>
          <p className="text-sm font-medium">{b.name}</p>
          <p className="text-[11px] text-muted-foreground mb-2">
            Cert {b.cert}{b.city ? ` · ${b.city}, ${b.state}` : ''}{b.hc_name ? ` · Holding company: ${b.hc_name}` : ''} · {formatThousands(b.assets_k)} assets
          </p>
          {s ? (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-2 text-[11px]">
                <span className={`rounded-full px-2 py-0.5 font-medium capitalize ${TIER_STYLE[String(s.tier)] || 'bg-muted text-muted-foreground'}`}
                  title="Bank Stress tier: normal, watchlist or pressure">{String(s.tier || 'not scored')}</span>
                {s.composite != null && <span title="Bank Stress composite score, 0 to 100; higher means more stress">Stress score <b>{Number(s.composite).toFixed(1)}</b></span>}
                {s.rank != null && <span className="text-muted-foreground" title="Rank among all scored banks; 1 is the most stressed">· rank {Number(s.rank).toLocaleString()} of {Number(s.cohort_size).toLocaleString()}</span>}
                <span className="text-muted-foreground">· {quarterLabel(s.repdte)}</span>
                {Number(s.flag_count) > 0 && <span className="text-red-600">· {s.flag_count} stress flag{Number(s.flag_count) === 1 ? '' : 's'}</span>}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                <Fig label="Tier 1 leverage" value={formatPct(s.tier1_leverage as number)} hint="Tier 1 capital as a share of average assets. Lower means a thinner capital cushion." />
                <Fig label="CRE concentration" value={formatPct(s.cre_concentration as number, 0)} hint="Commercial real estate loans as a share of capital." />
                <Fig label="Noncurrent loans" value={formatPct(s.noncurrent_ratio as number, 2)} hint="Loans 90+ days past due or not accruing interest, as a share of loans." />
                <Fig label="ROA" value={formatPct(s.roa as number, 2)} hint="Return on assets: net income as a share of average assets, annualised." />
                <Fig label="Loans / deposits" value={formatPct(s.loan_to_deposit as number, 0)} hint="Loans as a share of deposits." />
                <Fig label="Uninsured deposits" value={formatPct(s.uninsured_share as number, 0)} hint="Share of deposits above the FDIC insurance limit." />
              </div>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">This bank has no Bank Stress score yet.</p>
          )}
        </>
      )}

      {/* Controls */}
      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-3 flex-wrap text-[11px]">
        {b && s && (
          <button onClick={() => setOpenCert(b.cert)} className="inline-flex items-center gap-1 text-primary hover:underline">
            <ExternalLink size={10} />Open full bank card
          </button>
        )}
        {data.status === 'suggested' && (
          <button onClick={() => setLink.mutate({ cert: data.cert })} disabled={busy} className="inline-flex items-center gap-1 hover:text-primary">
            <Check size={10} />Confirm this bank
          </button>
        )}
        {candidates.length > 1 && data.status !== 'not_bank' && (
          <button onClick={() => setPicking(p => !p)} className="hover:text-primary">{picking ? 'Cancel' : 'Pick a different bank'}</button>
        )}
        {data.status !== 'not_bank' && (
          <button onClick={() => setLink.mutate({ not_bank: true })} disabled={busy} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <X size={10} />Not an FDIC bank
          </button>
        )}
      </div>

      {picking && (
        <ul className="mt-2 text-[11px] divide-y divide-border/50 border border-border/60 rounded-md">
          {candidates.map(c => (
            <li key={c.cert} className="px-2 py-1 flex items-center gap-2">
              <span className="flex-1 truncate">{c.name} <span className="text-muted-foreground">· {c.city}, {c.state} · cert {c.cert}</span></span>
              <span className="text-muted-foreground tabular-nums">{formatThousands(c.assets_k)}</span>
              <button onClick={() => setLink.mutate({ cert: c.cert })} disabled={busy || c.cert === data.cert}
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">
                {c.cert === data.cert ? 'Current' : 'Use this'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {openCert != null && (
        <BankStressDrawer cert={openCert} name={b?.name} onClose={() => setOpenCert(null)} definitions={meta?.definitions ?? null} />
      )}
    </div>
  );
}
