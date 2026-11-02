import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Gavel, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

// Complaints (beta): Miami-Dade foreclosure complaints, case types RPMF-Commercial and RPMF-Non-Homestead.
// "Qualifies" = principal of at least $500,000 (inclusive) AND no reinstatement clause in the mortgage,
// worked out by the server from the stored extraction each time; it is not a stored label.
// The Needs review tab holds only leads that qualify (or might) with something a person must settle.

type Row = {
  case_id: string; case_number: string; case_type: string; case_style: string | null; filing_date: string | null;
  status: string; plaintiff: string | null; is_foreclosure: boolean | null;
  verdict: 'qualifies' | 'no' | 'unclear' | 'pending'; principal: number | null;
  default_date: string | null; right_to_reinstate_clause: boolean | null;
  address: string | null; address_source: string | null; properties: number; notes: number;
  flags: string[]; needs_review: boolean; review_reasons: string[];
  review: { decision: string; address: string | null; note: string | null } | null;
};
type Summary = {
  active: boolean; cases?: number; commercial?: number; non_homestead?: number; extracted?: number;
  not_public?: number; waiting?: number; qualifies?: number; unclear?: number; not_foreclosures?: number;
  review_open?: number; last_case_seen?: string | null;
};

const FLAG_TEXT: Record<string, string> = {
  address_unresolved: 'Address readings disagree',
  address_missing: 'No property address in the complaint',
  principal_missing: 'Unpaid principal not found',
  reinstatement_unreadable: 'Mortgage pages unreadable (reinstatement clause)',
  no_note_extracted: 'No note found',
  address_body_conflict: 'Body and exhibits give different street addresses',
  address_note_vs_mortgage_differ: 'Note and mortgage give different street addresses',
  multiple_notes: 'More than one note',
  multiple_properties: 'More than one property',
};

const money = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));

const TABS = [
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'review', label: 'Needs review' },
  { key: 'not_public', label: 'Complaint not public' },
  { key: 'all', label: 'All cases' },
] as const;

function ReviewBox({ row, onDone }: { row: Row; onDone: () => void }) {
  const { toast } = useToast();
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const { data: detail } = useQuery<any>({
    queryKey: ['/api/complaints', row.case_id],
    queryFn: () => apiRequest('GET', `/api/complaints/${row.case_id}`).then(r => r.json()),
  });
  const pages: number[] = [];
  for (const p of detail?.result?.properties ?? []) {
    for (const k of ['address_mortgage_page', 'address_note_page']) if (Number.isInteger(p[k])) pages.push(p[k]);
  }
  const uniquePages = Array.from(new Set(pages)).slice(0, 3);
  const save = useMutation({
    mutationFn: (body: any) => apiRequest('POST', `/api/complaints/${row.case_id}/review`, body).then(r => r.json()),
    onSuccess: () => { toast({ title: 'Saved', description: `${row.case_number}: your answer is recorded.` }); onDone(); },
    onError: (e: any) => toast({ title: 'Could not save', description: String(e?.message || e), variant: 'destructive' }),
  });
  return (
    <div className="mt-2 space-y-3 text-xs">
      <div className="text-muted-foreground">
        {row.review_reasons.map(r => FLAG_TEXT[r] ?? r).join(' · ')}. Type only what is printed in the complaint's own pages —
        never an address from another source.
      </div>
      {detail?.result?.properties?.map((p: any, i: number) => (
        <div key={i} className="rounded border border-border/50 p-2 space-y-1">
          <div className="font-medium">Property {i + 1}</div>
          {p.address_votes && Object.keys(p.address_votes).length > 0 && (
            <div>Readings: {Object.entries(p.address_votes).map(([k, v]: any) => `${k} (${v.join(', ')})`).join(' | ')}</div>
          )}
          {p.address_missing_reason && <div>Why none: {p.address_missing_reason}</div>}
          {p.legal_description && <div className="text-muted-foreground">Legal description: {String(p.legal_description).slice(0, 220)}</div>}
        </div>
      ))}
      {uniquePages.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {uniquePages.map(n => (
            <a key={n} href={`/api/complaints/${row.case_id}/page/${n}`} target="_blank" rel="noreferrer" className="text-primary underline">
              Open page {n}
            </a>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-center flex-wrap">
        <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Property address as printed in the complaint" className="h-8 text-xs w-96" />
        <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="h-8 text-xs w-56" />
        <Button size="sm" className="h-8 text-xs" disabled={!address.trim() || save.isPending}
          onClick={() => save.mutate({ decision: 'address_entered', address, note })}>Save address</Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={save.isPending}
          onClick={() => save.mutate({ decision: 'no_address_in_complaint', note })}>No address in the complaint</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={save.isPending}
          onClick={() => save.mutate({ decision: 'dismissed', note })}>Dismiss</Button>
      </div>
    </div>
  );
}

export default function Complaints() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('qualifying');
  const [open, setOpen] = useState<string | null>(null);

  const { data: sum } = useQuery<Summary>({
    queryKey: ['/api/complaints/summary'],
    queryFn: () => apiRequest('GET', '/api/complaints/summary').then(r => r.json()),
  });
  const { data, isLoading } = useQuery<{ active: boolean; rows: Row[] }>({
    queryKey: ['/api/complaints', 'list', tab],
    queryFn: () => apiRequest('GET', `/api/complaints?view=${tab}`).then(r => r.json()),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['/api/complaints'] }); qc.invalidateQueries({ queryKey: ['/api/complaints/summary'] }); setOpen(null); };
  const rows = data?.rows ?? [];

  const Tile = ({ label, value, hint }: { label: string; value: number | string; hint?: string }) => (
    <div className="rounded-lg border border-border/50 p-3 min-w-[130px]" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );

  return (
    <div className="p-4 space-y-4 max-w-screen-2xl mx-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <Gavel size={15} className="text-primary" />
        <h1 className="text-lg font-semibold">Complaints</h1>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">Beta</span>
        <span className="text-xs text-muted-foreground ml-1">
          Miami-Dade foreclosure complaints: RPMF-Commercial and RPMF-Non-Homestead, from the Clerk's records
        </span>
      </div>

      {sum && sum.active === false ? (
        <div className="rounded-lg border border-border/50 p-4 text-sm text-muted-foreground">
          The complaints pipeline has not run on this server yet, so there is nothing to show.
        </div>
      ) : (
        <>
          <div className="flex gap-3 flex-wrap">
            <Tile label="Cases found" value={sum?.cases ?? '…'} hint="Every case the Clerk lists for the two case types, whether or not its complaint is public" />
            <Tile label="Qualifies" value={sum?.qualifies ?? '…'} hint="Principal of $500,000 or more (inclusive) and no reinstatement clause in the mortgage" />
            <Tile label="Needs review" value={sum?.review_open ?? '…'} hint="Qualifying (or possibly qualifying) leads with something a person must settle" />
            <Tile label="Complaint not public" value={sum?.not_public ?? '…'} hint="The Clerk lists the case but has no viewable complaint; retried weekly for 8 weeks" />
            <Tile label="Not mortgage foreclosures" value={sum?.not_foreclosures ?? '…'} hint="Lien suits (construction, association, timeshare)" />
          </div>

          <div className="flex gap-1 border-b border-border/50">
            {TABS.map(t => (
              <button key={t.key} onClick={() => { setTab(t.key); setOpen(null); }}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${tab === t.key ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground'}`}>
                {t.label}{t.key === 'review' && sum?.review_open ? ` (${sum.review_open})` : ''}
              </button>
            ))}
          </div>

          {isLoading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4">Nothing in this list.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="py-1.5 w-5"></th><th>Case</th><th>Filed</th><th>Plaintiff</th>
                    <th className="text-right">Principal</th><th>Reinstate clause</th><th>Default</th><th>Property address</th><th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <>
                      <tr key={r.case_id} className="border-b border-border/30 hover:bg-muted/30 cursor-pointer align-top"
                        onClick={() => setOpen(open === r.case_id ? null : r.case_id)}>
                        <td className="py-1.5">{open === r.case_id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                        <td className="whitespace-nowrap">{r.case_number}<div className="text-[10px] text-muted-foreground">{r.case_type}</div></td>
                        <td className="whitespace-nowrap">{r.filing_date ?? '—'}</td>
                        <td className="max-w-[260px]">{r.plaintiff ?? r.case_style ?? '—'}</td>
                        <td className="text-right whitespace-nowrap">{money(r.principal)}</td>
                        <td>{r.right_to_reinstate_clause == null ? '—' : r.right_to_reinstate_clause ? 'Yes' : 'No'}</td>
                        <td className="whitespace-nowrap">{r.default_date ?? '—'}</td>
                        <td className="max-w-[280px]">{r.review?.decision === 'address_entered' ? r.review.address : r.address ?? <span className="text-muted-foreground">none</span>}
                          {r.address_source && <div className="text-[10px] text-muted-foreground">{r.address_source}</div>}</td>
                        <td className="whitespace-nowrap">
                          {r.status === 'complaint_not_public' ? 'No public complaint'
                            : r.is_foreclosure === false ? 'Not a mortgage foreclosure'
                            : r.verdict === 'qualifies' ? <b className="text-green-500">Qualifies</b>
                            : r.verdict === 'unclear' ? <span className="text-amber-500">Cannot tell</span>
                            : r.verdict === 'no' ? 'Does not qualify' : 'Waiting'}
                          {r.needs_review && <span className="ml-1 inline-flex items-center gap-0.5 text-amber-500"><AlertTriangle size={11} />review</span>}
                          {r.review && <div className="text-[10px] text-muted-foreground">reviewed</div>}
                        </td>
                      </tr>
                      {open === r.case_id && (
                        <tr key={r.case_id + '-d'} className="border-b border-border/30 bg-muted/20">
                          <td></td>
                          <td colSpan={8} className="pb-3">
                            {r.flags.length > 0 && (
                              <div className="text-[11px] text-muted-foreground">
                                Notes: {r.flags.map(f => FLAG_TEXT[f] ?? f).join(' · ')}
                              </div>
                            )}
                            {r.notes > 1 && <div className="text-[11px] text-muted-foreground">{r.notes} notes; the figure shown is the largest principal demanded.</div>}
                            {r.needs_review ? <ReviewBox row={r} onDone={refresh} /> : (
                              r.flags.length === 0 && <div className="text-[11px] text-muted-foreground">Nothing to settle on this case.</div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground">
            Qualifies = principal of $500,000 or more and no reinstatement clause in the mortgage, worked out from the complaint each time it is read.
            Unresolved items on cases that do not qualify are left alone. Dates are the Clerk's filing dates.
          </div>
        </>
      )}
    </div>
  );
}
