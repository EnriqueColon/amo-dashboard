import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AddressHoverCard } from '@/components/AddressHoverCard';
import { Gavel, ChevronDown, ChevronRight, AlertTriangle, Download, FileText } from 'lucide-react';

// Complaints (beta): foreclosure complaints by county (Miami-Dade, Duval, Monroe, Leon, Citrus): Commercial and Non-Homestead Residential case types.
// "Qualifies" = principal of at least $500,000 (inclusive) AND no reinstatement clause in the mortgage,
// worked out by the server from the stored extraction each time; it is not a stored label.
// Two ways to read the same data: a readable summary (one clear row per complaint, click for the full
// record) and a spreadsheet view with every column of the old collector's sheet, in the sheet's order.
// The Needs review tab holds only leads that qualify (or might) with something a person must settle.

type Field = { key: string; label: string; value: string | null; group: string; wide?: boolean };
type Row = {
  case_id: string; case_number: string; county_label: string; collected_on: string | null; case_type: string; case_style: string | null; filing_date: string | null;
  status: string; plaintiff: string | null; is_foreclosure: boolean | null;
  verdict: 'qualifies' | 'no' | 'unclear' | 'pending'; principal: number | null;
  default_date: string | null; right_to_reinstate_clause: boolean | null;
  address: string | null; address_source: string | null; properties: number; notes: number;
  flags: string[]; needs_review: boolean; review_reasons: string[];
  review: { decision: string; address: string | null; note: string | null } | null;
  result_reason?: string;
  sheet: Field[];
};
type Summary = {
  active: boolean; cases?: number; qualifies?: number; not_public?: number; not_foreclosures?: number; review_open?: number;
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

const GROUP_ORDER = ['Case', 'Parties', 'Property', 'Loan', 'Default', 'Amounts', 'Criteria', 'Source'];

const money = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const get = (r: Row, key: string) => r.sheet?.find(f => f.key === key)?.value ?? null;

const TABS = [
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'review', label: 'Needs review' },
  { key: 'not_public', label: 'Complaint not public' },
  { key: 'all', label: 'All cases' },
] as const;

const clamp = (lines: number): React.CSSProperties => ({
  display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden',
});

function ResultChip({ r }: { r: Row }) {
  const base = 'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap cursor-help';
  let cls = 'bg-muted text-muted-foreground', text = 'Waiting to be read';
  if (r.status === 'complaint_not_public') text = 'No public complaint';
  else if (r.is_foreclosure === false) text = 'Not a mortgage foreclosure';
  else if (r.verdict === 'qualifies') { cls = 'bg-green-500/15 text-green-600'; text = 'Qualifies'; }
  else if (r.verdict === 'unclear') { cls = 'bg-amber-500/15 text-amber-600'; text = 'Cannot tell'; }
  else if (r.verdict === 'no') { cls = 'bg-muted text-foreground/70'; text = 'Does not qualify'; }
  const chip = <span className={`${base} ${cls}`}>{text}</span>;
  if (!r.result_reason) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm text-left font-normal text-sm leading-snug" sideOffset={6}>{r.result_reason}</TooltipContent>
    </Tooltip>
  );
}

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
    <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 space-y-3 text-sm">
      <div className="font-medium">Needs a person: {row.review_reasons.map(r => FLAG_TEXT[r] ?? r).join(' · ')}</div>
      <div className="text-muted-foreground">Type only what is printed in the complaint's own pages, never an address from another source.</div>
      {detail?.result?.properties?.map((p: any, i: number) => (
        <div key={i} className="space-y-1">
          <div className="font-medium">Property {i + 1}</div>
          {p.address_votes && Object.keys(p.address_votes).length > 0 && (
            <div>Readings: {Object.entries(p.address_votes).map(([k, v]: any) => `${k} (${v.join(', ')})`).join(' | ')}</div>
          )}
          {p.address_missing_reason && <div>Why none: {p.address_missing_reason}</div>}
          {p.legal_description && <div className="text-muted-foreground">Legal description: {String(p.legal_description).slice(0, 260)}</div>}
        </div>
      ))}
      {uniquePages.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {uniquePages.map(n => (
            <a key={n} href={`/api/complaints/${row.case_id}/page/${n}`} target="_blank" rel="noreferrer" className="text-primary underline">
              Open page {n}
            </a>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-center flex-wrap">
        <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Property address as printed in the complaint" className="h-9 text-sm w-[26rem]" />
        <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="h-9 text-sm w-60" />
        <Button size="sm" disabled={!address.trim() || save.isPending}
          onClick={() => save.mutate({ decision: 'address_entered', address, note })}>Save address</Button>
        <Button size="sm" variant="outline" disabled={save.isPending}
          onClick={() => save.mutate({ decision: 'no_address_in_complaint', note })}>No address in the complaint</Button>
        <Button size="sm" variant="ghost" disabled={save.isPending}
          onClick={() => save.mutate({ decision: 'dismissed', note })}>Dismiss</Button>
      </div>
    </div>
  );
}

// Everything the pipeline read from one complaint, grouped, with long texts given the full width.
function FullRecord({ r, onDone }: { r: Row; onDone: () => void }) {
  const groups = GROUP_ORDER.map(g => ({ g, fields: (r.sheet ?? []).filter(f => f.group === g) })).filter(x => x.fields.length);
  return (
    <div className="py-4 space-y-5">
      <div className="flex gap-4 flex-wrap items-center text-sm">
        {get(r, 'pdf') && (
          <a href={get(r, 'pdf')!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary underline">
            <FileText size={14} />Open the complaint (PDF)
          </a>
        )}
        {r.flags.length > 0 && <span className="text-muted-foreground">Notes: {r.flags.map(f => FLAG_TEXT[f] ?? f).join(' · ')}</span>}
      </div>
      {r.sheet?.length ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-5">
          {groups.map(({ g, fields }) => (
            <section key={g} className="min-w-0">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60 pb-1 mb-2">{g}</h4>
              <dl className="space-y-2">
                {fields.map(f => (
                  <div key={f.key} className={f.wide ? 'space-y-0.5' : 'grid grid-cols-[13rem_1fr] gap-3'}>
                    <dt className="text-sm text-muted-foreground">{f.label}</dt>
                    <dd className="text-sm leading-relaxed break-words min-w-0">
                      {f.value == null ? <span className="text-muted-foreground">—</span>
                        : f.key === 'pdf' ? <a className="text-primary underline" href={f.value} target="_blank" rel="noreferrer">Open</a>
                        : f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : <div className="text-sm text-muted-foreground">This complaint has not been read yet.</div>}
      {r.needs_review && <ReviewBox row={r} onDone={onDone} />}
    </div>
  );
}

// The old collector's spreadsheet, column for column. Scrolls sideways; the case and plaintiff stay in view.
function SheetView({ rows, onOpen }: { rows: Row[]; onOpen: (id: string) => void }) {
  const cols = (rows.find(r => r.sheet?.length)?.sheet ?? []).filter(c => c.key !== 'pdf');
  return (
    <div className="overflow-auto border border-border/60 rounded-lg max-h-[70vh]">
      <table className="text-sm border-separate border-spacing-0">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={c.key}
                className={`sticky top-0 z-10 bg-card text-left font-semibold text-muted-foreground whitespace-nowrap px-3 py-2.5 border-b border-border
                  ${i === 0 ? 'left-0 z-20 border-r' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.case_id} className={ri % 2 ? 'bg-muted/20' : ''}>
              {(r.sheet?.length ? r.sheet.filter(c => c.key !== 'pdf') : cols.map(c => ({ ...c, value: null }))).map((f, i) => (
                <td key={f.key}
                  className={`px-3 py-2 align-top border-b border-border/40 ${f.wide ? 'min-w-[22rem]' : 'min-w-[9rem]'}
                    ${i === 0 ? `sticky left-0 z-[5] border-r bg-card font-medium whitespace-nowrap` : ''}`}>
                  {i === 0
                    ? <button className="text-primary hover:underline" onClick={() => onOpen(r.case_id)}>{f.value ?? r.case_number}</button>
                    : f.value == null ? <span className="text-muted-foreground">—</span>
                    : <div style={clamp(f.wide ? 4 : 2)} title={f.value}>{f.value}</div>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Complaints() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('qualifying');
  const [mode, setMode] = useState<'summary' | 'sheet'>('summary');
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
    <div className="rounded-lg border border-border/60 px-4 py-3 min-w-[9.5rem]" title={hint}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );

  return (
    <div className="p-6 space-y-5 max-w-screen-2xl mx-auto">
      <div className="flex items-center gap-2.5 flex-wrap">
        <Gavel size={18} className="text-primary" />
        <h1 className="text-xl font-semibold">Complaints</h1>
        <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary font-medium">Open testing</span>
        <span className="text-sm text-muted-foreground ml-1">
          Foreclosure complaints by county (Miami-Dade, Duval, Monroe, Leon and Citrus; Commercial and Non-Homestead Residential), read from each Clerk's records
        </span>
      </div>

      {sum && sum.active === false ? (
        <div className="rounded-lg border border-border/60 p-5 text-sm text-muted-foreground">
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

          <div className="flex items-end justify-between gap-3 flex-wrap border-b border-border/60">
            <div className="flex gap-1">
              {TABS.map(t => (
                <button key={t.key} onClick={() => { setTab(t.key); setOpen(null); }}
                  className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t.key ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                  {t.label}{t.key === 'review' && sum?.review_open ? ` (${sum.review_open})` : ''}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 pb-1.5">
              <div className="inline-flex rounded-md border border-border/60 overflow-hidden text-sm">
                {(['summary', 'sheet'] as const).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`px-3 py-1.5 ${mode === m ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'}`}>
                    {m === 'summary' ? 'Summary' : 'Spreadsheet view'}
                  </button>
                ))}
              </div>
              <a href={`/api/complaints/export.csv?view=${tab}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                <Download size={14} />Download CSV
              </a>
            </div>
          </div>

          {isLoading ? <Skeleton className="h-48 w-full" /> : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground p-6">Nothing in this list.</div>
          ) : mode === 'sheet' ? (
            <>
              <SheetView rows={rows} onOpen={id => { setMode('summary'); setOpen(id); }} />
              <p className="text-xs text-muted-foreground">Same columns as the old collector's Complaints sheet, in its order, followed by the extra fields this pipeline reads. Click a case number for its full record.</p>
            </>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2.5 w-6"></th>
                    <th className="py-2.5 pr-4 font-medium">Case</th>
                    <th className="pr-4 font-medium">County</th>
                    <th className="pr-4 font-medium">Collected</th>
                    <th className="pr-4 font-medium">Plaintiff</th>
                    <th className="pr-4 font-medium">Property address</th>
                    <th className="pr-4 font-medium text-right">Unpaid principal</th>
                    <th className="pr-4 font-medium">Default date</th>
                    <th className="pr-4 font-medium">Reinstatement clause</th>
                    <th className="font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <Fragment key={r.case_id}>
                      <tr className="border-b border-border/50 hover:bg-muted/30 cursor-pointer align-top"
                        onClick={() => setOpen(open === r.case_id ? null : r.case_id)}>
                        <td className="py-3">{open === r.case_id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          <div className="font-medium">{r.case_number}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{r.case_type} · filed {r.filing_date ?? '—'}</div>
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">{r.county_label}</td>
                        <td className="py-3 pr-4 whitespace-nowrap tabular-nums">{r.collected_on ?? '—'}</td>
                        <td className="py-3 pr-4 max-w-[22rem]">
                          <div style={clamp(2)} title={r.plaintiff ?? r.case_style ?? ''}>{r.plaintiff ?? r.case_style ?? '—'}</div>
                        </td>
                        <td className="py-3 pr-4 max-w-[20rem]">
                          {(r.review?.decision === 'address_entered' ? r.review.address : r.address)
                            ? <AddressHoverCard address={(r.review?.decision === 'address_entered' ? r.review.address : r.address)!}>
                                <div style={clamp(2)}>{r.review?.decision === 'address_entered' ? r.review.address : r.address}</div>
                              </AddressHoverCard>
                            : <span className="text-muted-foreground">No address</span>}
                          {r.address_source && <div className="text-xs text-muted-foreground mt-0.5">{r.address_source}</div>}
                        </td>
                        <td className="py-3 pr-4 text-right whitespace-nowrap tabular-nums font-medium">{money(r.principal)}</td>
                        <td className="py-3 pr-4 whitespace-nowrap tabular-nums">{r.default_date ?? '—'}</td>
                        <td className="py-3 pr-4">{r.right_to_reinstate_clause == null ? '—' : r.right_to_reinstate_clause ? 'Yes' : 'No'}</td>
                        <td className="py-3 whitespace-nowrap">
                          <ResultChip r={r} />
                          {r.needs_review && <div className="mt-1 inline-flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={12} />Needs review</div>}
                          {r.review && <div className="text-xs text-muted-foreground mt-1">Reviewed</div>}
                        </td>
                      </tr>
                      {open === r.case_id && (
                        <tr className="border-b border-border/50 bg-muted/20">
                          <td></td>
                          <td colSpan={9} className="pr-4"><FullRecord r={r} onDone={refresh} /></td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Qualifies = unpaid principal of $500,000 or more and no reinstatement clause in the mortgage, worked out from the complaint each time it is read.
            Unresolved items on cases that do not qualify are left alone. Dates are the Clerk's filing dates.
          </p>
        </>
      )}
    </div>
  );
}
