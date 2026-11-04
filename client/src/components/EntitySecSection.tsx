// SEC block of the entity profile card (docs/REPORTING_FEED_PLAN.md step 4).
// Two identities, each a name-based suggestion until a person confirms it,
// picks another, or says there is none: an EDGAR filer (listed company or
// other filer) and a registered investment adviser (Form ADV).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, Briefcase, Check, X, RotateCcw, ExternalLink } from 'lucide-react';

// EDGAR appends state tags to some names ("US BANCORP \\DE\\", "WELLS FARGO & COMPANY/MN").
const cleanName = (n: string) => (n || '').replace(/\s*[\\/][A-Z]{2}[\\/]?\s*$/, '').trim();

const money = (v: number | null | undefined) => {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  return `${s}$${Math.round(a).toLocaleString('en-US')}`;
};

function StatusChip({ part, onReset, busy }: { part: any; onReset: () => void; busy: boolean }) {
  if (part.status === 'confirmed') return (
    <span className="text-[10px] inline-flex items-center gap-1 text-emerald-700">
      <Check size={10} />Confirmed link
      <button onClick={onReset} disabled={busy} className="ml-1 text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5" title="Go back to the automatic suggestion">
        <RotateCcw size={9} />reset
      </button>
    </span>
  );
  if (part.status === 'suggested') return (
    <span className="text-[10px] rounded px-1.5 py-0.5 bg-amber-100 text-amber-700" title="Matched on the name, not yet confirmed by a person">Suggested match: {part.basis}</span>
  );
  return null;
}

function Controls({ part, kind, idKey, labelNone, onSet, onReset, busy }: {
  part: any; kind: 'edgar' | 'adviser'; idKey: 'cik' | 'crd'; labelNone: string;
  onSet: (body: object) => void; onReset: () => void; busy: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const cands: any[] = part.candidates || [];
  return (
    <>
      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-3 flex-wrap text-[11px]">
        {part.status === 'suggested' && (
          <button onClick={() => onSet({ kind, ref: String(part[idKey]) })} disabled={busy} className="inline-flex items-center gap-1 hover:text-primary">
            <Check size={10} />Confirm this match
          </button>
        )}
        {cands.length > 0 && part.status !== 'none' && (
          <button onClick={() => setPicking(p => !p)} className="hover:text-primary">
            {picking ? 'Cancel' : part.status === 'suggested' || part.status === 'confirmed' ? 'Pick a different one' : 'Pick from SEC search'}
          </button>
        )}
        {part.status !== 'none' && (part.status === 'suggested' || part.status === 'confirmed') && (
          <button onClick={() => onSet({ kind, none: true })} disabled={busy} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <X size={10} />{labelNone}
          </button>
        )}
        {part.status === 'none' && (
          <span className="text-muted-foreground">Marked: {labelNone.toLowerCase()}. <button onClick={onReset} className="text-primary hover:underline">Undo</button></span>
        )}
      </div>
      {picking && (
        <ul className="mt-2 text-[11px] divide-y divide-border/50 border border-border/60 rounded-md">
          {cands.map(c => {
            const id = String(c[idKey]);
            return (
              <li key={id} className="px-2 py-1 flex items-center gap-2">
                <span className="flex-1 truncate" title={c.name}>
                  {cleanName(c.name)}
                  <span className="text-muted-foreground"> · {idKey === 'cik' ? `CIK ${id}` : `CRD ${id}`}{c.ticker ? ` · ${c.ticker}` : ''}{c.city ? ` · ${c.city}, ${c.state}` : ''}{c.scope && c.scope !== 'ACTIVE' ? ` · ${String(c.scope).toLowerCase()}` : ''}</span>
                </span>
                <button onClick={() => { onSet({ kind, ref: id }); setPicking(false); }} disabled={busy || id === String(part[idKey] ?? '')}
                  className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">
                  {id === String(part[idKey] ?? '') ? 'Current' : 'Use this'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export default function EntitySecSection({ entityName, entityType }: { entityName: string; entityType?: string }) {
  const qc = useQueryClient();
  const key = ['/api/entity/sec', entityName];
  const url = `/api/entity/${encodeURIComponent(entityName)}/sec`;
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => apiRequest('GET', url).then(r => r.json()),
    enabled: !!entityName,
    staleTime: 10 * 60 * 1000,
  });
  const done = () => qc.invalidateQueries({ queryKey: key });
  const setLink = useMutation({ mutationFn: (body: object) => apiRequest('PUT', url, body).then(r => r.json()), onSuccess: done });
  const reset = useMutation({ mutationFn: (kind: string) => apiRequest('DELETE', `${url}?kind=${kind}`).then(r => r.json()), onSuccess: done });
  const busy = setLink.isPending || reset.isPending;

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!data?.edgar || !data?.adviser) return null;
  const { edgar, adviser } = data;
  const matched = (p: any) => p.status === 'suggested' || p.status === 'confirmed';
  const anyCands = (edgar.candidates?.length || 0) + (adviser.candidates?.length || 0) > 0;
  // People and small LLCs mostly have no SEC presence; show the block only
  // when there is a match, a decision, or (for non-individual types) something to pick from.
  if (!matched(edgar) && !matched(adviser) && edgar.status !== 'none' && adviser.status !== 'none') {
    if (!anyCands || entityType === 'OTHER') return null;
  }
  const c = edgar.company;
  const f = adviser.firm;

  return (
    <div className="border border-border/60 rounded-lg p-3 space-y-3">
      {/* EDGAR */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
          <p className="text-xs font-semibold flex items-center gap-1.5"><FileText size={12} className="text-primary" />SEC filings (EDGAR)</p>
          <StatusChip part={edgar} onReset={() => reset.mutate('edgar')} busy={busy} />
        </div>
        {matched(edgar) && c ? (
          <>
            <p className="text-sm font-medium">
              {cleanName(c.name)}
              {c.tickers?.length > 0 && <span className="ml-2 text-[10px] rounded px-1.5 py-0.5 bg-muted text-muted-foreground align-middle">{c.tickers[0]}{c.exchanges?.[0] ? ` · ${c.exchanges[0]}` : ''}</span>}
            </p>
            <p className="text-[11px] text-muted-foreground mb-2">
              CIK {c.cik}{c.sic ? ` · ${c.sic}` : ''}{c.city ? ` · ${c.city}, ${c.state}` : ''}{c.state_of_incorporation ? ` · incorporated in ${c.state_of_incorporation}` : ''}
            </p>
            {c.figures?.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
                {c.figures.map((x: any) => (
                  <div key={x.concept} className="rounded-md bg-muted/40 px-2.5 py-1.5" title={`From the annual report (10-K), fiscal year ${x.fy}, period ending ${x.period_end}. XBRL concept: ${x.concept}.`}>
                    <p className="text-[10px] text-muted-foreground">{x.label}</p>
                    <p className="text-sm font-semibold tabular-nums">{money(x.value)}</p>
                    <p className="text-[9px] text-muted-foreground">FY {x.fy}</p>
                  </div>
                ))}
              </div>
            )}
            {c.filings?.length > 0 && (
              <ul className="text-[11px] divide-y divide-border/50">
                {c.filings.map((x: any, i: number) => (
                  <li key={i} className="py-1 flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0 w-[70px]">{x.date}</span>
                    <span className="font-mono shrink-0 w-[60px]">{x.form}</span>
                    <span className="truncate flex-1 text-muted-foreground" title={x.description || ''}>{x.description && x.description !== x.form ? x.description : ''}</span>
                    <a href={x.url} target="_blank" rel="noreferrer" className="text-primary hover:underline shrink-0 inline-flex items-center gap-0.5">Open<ExternalLink size={9} /></a>
                  </li>
                ))}
              </ul>
            )}
            <a href={c.edgar_url} target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 mt-1">All filings on EDGAR<ExternalLink size={9} /></a>
          </>
        ) : edgar.status !== 'none' && (
          <p className="text-[11px] text-muted-foreground">No SEC filer matches this name automatically.</p>
        )}
        <Controls part={edgar} kind="edgar" idKey="cik" labelNone="Not an SEC filer"
          onSet={b => setLink.mutate(b)} onReset={() => reset.mutate('edgar')} busy={busy} />
      </div>

      {/* Form ADV */}
      {(matched(adviser) || adviser.status === 'none' || adviser.status === 'ambiguous' || (adviser.candidates?.length > 0 && entityType !== 'BANK')) && (
        <div className="pt-3 border-t border-border/60">
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <p className="text-xs font-semibold flex items-center gap-1.5"><Briefcase size={12} className="text-primary" />Registered investment adviser (Form ADV)</p>
            <StatusChip part={adviser} onReset={() => reset.mutate('adviser')} busy={busy} />
          </div>
          {matched(adviser) && f ? (
            <>
              <p className="text-sm font-medium">{f.name}</p>
              <p className="text-[11px] text-muted-foreground">
                CRD {f.crd}{f.sec_number ? ` · SEC ${f.sec_number}` : ''}{f.scope ? ` · ${String(f.scope).toLowerCase()}` : ''}{f.office ? ` · ${f.office}` : ''}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {f.registration ? `Registration: ${f.registration}` : ''}{f.adv_filing_date ? ` · latest Form ADV filed ${f.adv_filing_date}` : ''}{f.other_names ? ` · ${f.other_names} other names (funds, GPs)` : ''}
              </p>
              {f.brochure && <p className="text-[11px] text-muted-foreground">Brochure: {f.brochure.name} ({f.brochure.date})</p>}
              <div className="flex gap-3 mt-1 text-[11px]">
                <a href={f.iapd_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">Adviser page<ExternalLink size={9} /></a>
                {f.adv_pdf_url && <a href={f.adv_pdf_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">Form ADV (PDF)<ExternalLink size={9} /></a>}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Assets under management are not shown: the SEC's adviser search does not provide them.</p>
            </>
          ) : adviser.status === 'ambiguous' ? (
            <p className="text-[11px] text-muted-foreground">Several advisers carry this name. Pick the right one below.</p>
          ) : adviser.status !== 'none' && (
            <p className="text-[11px] text-muted-foreground">No registered adviser matches this name automatically.</p>
          )}
          <Controls part={adviser} kind="adviser" idKey="crd" labelNone="Not an investment adviser"
            onSet={b => setLink.mutate(b)} onReset={() => reset.mutate('adviser')} busy={busy} />
        </div>
      )}
    </div>
  );
}
