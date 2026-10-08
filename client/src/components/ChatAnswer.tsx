import { Children, cloneElement, createContext, isValidElement, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronRight, ExternalLink, Loader2, AlertTriangle, MessageSquare, Database } from 'lucide-react';
import { documentUrl, noDocumentUrlReason } from '@/lib/doc-url';
import { formatMoney } from '@/lib/metrics';
import { resolveDrill, defaultsFromSteps, describeRow, type Drill } from '@/lib/chat-drill';
import { streamChat, type ToolStep, type ChatHistoryMessage } from '@/lib/chat-stream';

/**
 * Renders one Ask the Data answer. Markdown as before, except that every
 * body row of every table can be clicked to expand the records behind it
 * (see lib/chat-drill.ts for how a row is matched to a lookup). The expansion
 * is a plain /api/chat/drill query — no model — unless the row cannot be
 * resolved, in which case it offers "Ask about this row", a scoped follow-up
 * streamed into the same expansion.
 */

interface DrillCtx {
  steps: ToolStep[];
  county: string;
  /** Conversation up to and including this answer — context for "Ask about this row". Read lazily so the context stays stable while streaming. */
  getHistory: () => ChatHistoryMessage[];
  /** False while the answer is still streaming (lookups may not have landed). */
  ready: boolean;
}
const DrillContext = createContext<DrillCtx | null>(null);
const HeadersContext = createContext<string[]>([]);

const PROSE = 'prose prose-sm max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-pre:text-xs prose-code:text-[12px] prose-code:before:content-none prose-code:after:content-none prose-a:text-primary';

export function ChatAnswer(props: { content: string; steps: ToolStep[]; county: string; history: ChatHistoryMessage[]; ready: boolean }) {
  const historyRef = useRef(props.history);
  historyRef.current = props.history;
  const ctx = useMemo<DrillCtx>(() => ({ steps: props.steps, county: props.county, ready: props.ready, getHistory: () => historyRef.current }), [props.steps, props.county, props.ready]);
  return (
    <DrillContext.Provider value={ctx}>
      <div className={PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{props.content}</ReactMarkdown>
      </div>
    </DrillContext.Provider>
  );
}

// ── hast helpers ─────────────────────────────────────────────────────────────

function hastText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  if (Array.isArray(node.children)) return node.children.map(hastText).join('');
  return '';
}
function rowCells(tr: any): string[] {
  return (tr?.children ?? []).filter((c: any) => c.type === 'element').map((c: any) => hastText(c).trim());
}
function tableHeaders(table: any): string[] {
  for (const section of table?.children ?? []) {
    if (section.type !== 'element') continue;
    const rows = section.tagName === 'tr' ? [section] : (section.children ?? []).filter((c: any) => c.type === 'element' && c.tagName === 'tr');
    for (const tr of rows) if ((tr.children ?? []).some((c: any) => c.type === 'element' && c.tagName === 'th')) return rowCells(tr);
  }
  return [];
}

// ── Markdown component overrides ─────────────────────────────────────────────

function MdTable({ node, children, ...props }: any) {
  const headers = useMemo(() => tableHeaders(node), [node]);
  return (
    <HeadersContext.Provider value={headers}>
      <table {...props}>{children}</table>
    </HeadersContext.Provider>
  );
}

function MdRow({ node, children, ...props }: any) {
  const ctx = useContext(DrillContext);
  const headers = useContext(HeadersContext);
  const [open, setOpen] = useState(false);
  const isHeader = (node?.children ?? []).some((c: any) => c.type === 'element' && c.tagName === 'th');
  const cells = useMemo(() => rowCells(node), [node]);
  const steps = ctx?.steps;
  const county = ctx?.county ?? 'MIAMI-DADE';
  const drill = useMemo(
    () => (!steps || isHeader ? null : resolveDrill(headers, cells, steps, defaultsFromSteps(steps, county))),
    [steps, county, headers, cells, isHeader],
  );

  if (!ctx || isHeader) return <tr {...props}>{children}</tr>;

  // Put the chevron inside the first cell so the column count is unchanged.
  const kids = Children.toArray(children);
  const first = kids[0];
  const decorated = isValidElement(first)
    ? [cloneElement(first as any, { key: 'first' }, (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground/70 shrink-0" aria-hidden>{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
          {(first as any).props.children}
        </span>
      )), ...kids.slice(1)]
    : kids;

  const title = !ctx.ready ? 'Waiting for the answer to finish…'
    : drill ? (drill.exact ? `Show the records behind this row — ${drill.label}` : `Show records matching this row (best guess: ${drill.label})`)
    : 'Ask about this row';

  return (
    <>
      <tr
        {...props}
        onClick={() => { if (ctx.ready) setOpen(o => !o); }}
        title={title}
        data-testid="chat-table-row"
        data-drill={drill ? drill.kind : 'ask'}
        className={`${props.className ?? ''} ${ctx.ready ? 'cursor-pointer hover:bg-primary/5' : ''} ${open ? 'bg-primary/5' : ''}`.trim()}
      >
        {decorated}
      </tr>
      {open && (
        <tr className="!border-0" data-testid="chat-table-row-detail">
          <td colSpan={Math.max(cells.length, 1)} className="!p-0 !border-0">
            <RowDetail drill={drill} headers={headers} cells={cells} onClose={() => setOpen(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

const COMPONENTS: Components = {
  a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: MdTable,
  tr: MdRow,
};

// ── row detail ───────────────────────────────────────────────────────────────

const PAGE = 25;

function RowDetail({ drill, headers, cells, onClose }: { drill: Drill | null; headers: string[]; cells: string[]; onClose: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    // w-0 + min-w-full: the panel fits the table's width instead of widening it
    // (a table cell otherwise grows to its content's natural width).
    <div className="not-prose my-1 w-0 min-w-full border border-primary/20 bg-background rounded-md text-xs shadow-sm" onClick={e => e.stopPropagation()}>
      {drill && drill.kind === 'record' && <RecordDetail drill={drill} />}
      {drill && drill.kind !== 'record' && !asking && <QueryDetail drill={drill} onAsk={() => setAsking(true)} />}
      {(!drill || asking) && <AskAboutRow headers={headers} cells={cells} drill={drill} />}
      <div className="flex justify-end px-2 pb-1.5">
        <button onClick={onClose} className="text-[10px] text-muted-foreground hover:text-foreground">collapse</button>
      </div>
    </div>
  );
}

function DetailHeader({ title, subtitle, approx, right }: { title: ReactNode; subtitle?: ReactNode; approx?: boolean; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 pt-2 pb-1.5 border-b border-border/60">
      <div className="min-w-0">
        <div className="font-medium text-foreground flex items-center gap-1.5 flex-wrap">
          <Database size={11} className="text-primary shrink-0" /> {title}
          {approx && <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-800 bg-amber-50 border border-amber-200 rounded px-1 py-px" title="This row was matched from the table's column headers, not from a lookup the assistant ran — the filter is a best guess.">best guess</span>}
        </div>
        {subtitle && <div className="text-muted-foreground mt-0.5 break-words">{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

function QueryDetail({ drill, onAsk }: { drill: Extract<Drill, { kind: 'filings' | 'facility_filings' }>; onAsk: () => void }) {
  const [limit, setLimit] = useState(PAGE);
  const maxRows = drill.kind === 'filings' ? 200 : 100;   // the underlying tools' caps
  const qs = new URLSearchParams({ kind: drill.kind, ...drill.params, limit: String(limit) }).toString();
  // Plain fetch: apiRequest() appends the dashboard's county to every GET,
  // which would fight the county this drill carries explicitly.
  const q = useQuery({
    queryKey: ['/api/chat/drill', qs],
    queryFn: async () => {
      const r = await fetch(`/api/chat/drill?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `${r.status} ${r.statusText}`);
      return j;
    },
    staleTime: 60_000,
  });

  if (q.isLoading) return <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground"><Loader2 size={12} className="animate-spin" /> Loading records…</div>;
  if (q.isError || q.data?.error) {
    return (
      <div className="px-3 py-2 text-red-700 flex items-start gap-2"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {q.data?.error ?? (q.error as any)?.message ?? 'Lookup failed'}</div>
    );
  }
  const data = q.data ?? {};
  const rows: any[] = data.rows ?? [];
  const total: number = typeof data.total_matching === 'number' ? data.total_matching : rows.length;

  if (!rows.length) {
    return (
      <>
        <DetailHeader title="No records matched" subtitle={drill.label} approx={!drill.exact} />
        <div className="px-3 py-2 text-muted-foreground">
          The database has nothing for that filter{drill.exact ? '' : ' — the match from the column headers may be wrong'}.{' '}
          <button onClick={onAsk} className="text-primary hover:underline inline-flex items-center gap-1"><MessageSquare size={11} /> Ask about this row instead</button>
        </div>
      </>
    );
  }

  const noun = drill.kind === 'filings' ? 'assignment' : 'facility filing';
  return (
    <>
      <DetailHeader
        title={<>{total.toLocaleString()} {noun}{total === 1 ? '' : 's'}</>}
        subtitle={drill.label}
        approx={!drill.exact}
        right={<button onClick={onAsk} title="Ask the assistant about this row instead" className="shrink-0 text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-1"><MessageSquare size={11} /> Ask</button>}
      />
      <div className="overflow-x-auto">
        {drill.kind === 'filings' ? <FilingsTable rows={rows} /> : <FacilityFilingsTable rows={rows} />}
      </div>
      {rows.length < total && (
        <div className="px-3 py-1.5 border-t border-border/60 flex items-center justify-between text-muted-foreground">
          <span>Showing {rows.length.toLocaleString()} of {total.toLocaleString()}</span>
          <button onClick={() => setLimit(l => Math.min(l + PAGE * 2, maxRows))} disabled={limit >= maxRows || q.isFetching} className="text-primary hover:underline disabled:opacity-50 disabled:no-underline">
            {q.isFetching ? 'Loading…' : limit >= maxRows ? `Showing the first ${maxRows} — narrow the question for the rest` : `Show ${Math.min(PAGE * 2, total - rows.length)} more`}
          </button>
        </div>
      )}
    </>
  );
}

function CfnCell({ row }: { row: any }) {
  const url = documentUrl(row);
  const cfn = row.cfn ?? '—';
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap" title="Open the recorded document image">{cfn} <ExternalLink size={10} /></a>
    : <span className="font-mono whitespace-nowrap" title={noDocumentUrlReason(row)}>{cfn}</span>;
}

const TD = 'px-2 py-1 align-top border-t border-border/40';
const TH = 'px-2 py-1 text-left font-medium text-muted-foreground whitespace-nowrap';

function FilingsTable({ rows }: { rows: any[] }) {
  return (
    <table className="w-full text-[11px] leading-snug">
      <thead><tr className="bg-muted/40">
        <th className={TH}>Recorded</th><th className={TH}>CFN</th><th className={TH}>Assignor → Assignee</th><th className={TH}>Type</th><th className={TH}>Property</th><th className={`${TH} text-right`}>Amount</th>
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.cfn}-${i}`} className="hover:bg-muted/30">
            <td className={`${TD} whitespace-nowrap font-mono`}>{r.rec_date ?? '—'}</td>
            <td className={TD}><CfnCell row={r} /></td>
            <td className={TD}>
              <span title={r.assignor}>{r.assignor_canon ?? r.assignor ?? '—'}</span>
              <span className="text-muted-foreground"> → </span>
              <span title={r.assignee}>{r.assignee_canon ?? r.assignee ?? '—'}</span>
            </td>
            <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{(r.txn_type ?? '').toLowerCase().replace(/_/g, ' ') || '—'}</td>
            <td className={`${TD} max-w-[18rem] truncate`} title={r.property_address ?? ''}>{r.property_address ?? <span className="text-muted-foreground/60">not read</span>}</td>
            <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>{r.loan_amount != null ? formatMoney(Number(r.loan_amount)) : <span className="text-muted-foreground/60">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FacilityFilingsTable({ rows }: { rows: any[] }) {
  return (
    <table className="w-full text-[11px] leading-snug">
      <thead><tr className="bg-muted/40">
        <th className={TH}>Recorded</th><th className={TH}>CFN</th><th className={TH}>Lender</th><th className={TH}>Borrower</th><th className={TH}>Facility</th><th className={`${TH} text-right`}>Size</th><th className={TH}>Evidence</th>
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.cfn}-${i}`} className="hover:bg-muted/30">
            <td className={`${TD} whitespace-nowrap font-mono`}>{r.rec_date ?? '—'}</td>
            <td className={TD}><CfnCell row={r} /></td>
            <td className={`${TD} max-w-[11rem] truncate`} title={r.facility_lender_name ?? ''}>{r.facility_lender_name ?? '—'}</td>
            <td className={`${TD} max-w-[11rem] truncate`} title={[r.facility_borrower_name, r.borrower_parent ? `family: ${r.borrower_parent}` : ''].filter(Boolean).join(' · ')}>{r.facility_borrower_name ?? '—'}</td>
            <td className={`${TD} max-w-[14rem] text-muted-foreground`}>
              <div className="truncate" title={r.facility_agreement_name ?? ''}>{r.facility_agreement_name || (r.facility_type ?? '').replace(/_/g, ' ') || '—'}</div>
              {r.facility_agreement_date && <div className="text-[10px] text-muted-foreground/70 whitespace-nowrap">dated {r.facility_agreement_date}</div>}
            </td>
            <td className={`${TD} text-right whitespace-nowrap tabular-nums`} title={r.facility_amount_type ? `${r.facility_amount_type.replace(/_/g, ' ')} — quoted on every filing for this facility; never sum` : undefined}>{r.facility_amount != null ? formatMoney(Number(r.facility_amount)) : '—'}</td>
            <td className={`${TD} max-w-[16rem] truncate italic text-muted-foreground`} title={r.facility_evidence_quote ?? ''}>{r.facility_evidence_quote ? `“${r.facility_evidence_quote}”` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const RECORD_LABELS: Record<string, string> = {
  cfn: 'CFN', rec_date: 'Recorded', county: 'County', doc_type: 'Document type', txn_type: 'Transaction type',
  assignor: 'Assignor (recorded)', assignor_canon: 'Assignor (resolved)', assignor_type: 'Assignor type',
  assignee: 'Assignee (recorded)', assignee_canon: 'Assignee (resolved)', assignee_type: 'Assignee type',
  property_address: 'Property', loan_amount: 'Loan amount', consideration_amount: 'Consideration', rec_book: 'Book', rec_page: 'Page',
  grantor: 'Grantor', grantee: 'Grantee', direction: 'Direction', grantor_role: 'Grantor role', grantee_role: 'Grantee role',
  facility_type: 'Facility type', facility_lender_name: 'Lender', facility_borrower_name: 'Borrower', borrower_parent: 'Borrower family',
  facility_agent_name: 'Agent', facility_agreement_name: 'Agreement', facility_agreement_date: 'Agreement date',
  facility_amount: 'Facility size', facility_amount_type: 'Size is', facility_confidence: 'Detector confidence', facility_evidence_quote: 'Evidence',
};
const RECORD_ORDER = Object.keys(RECORD_LABELS);

function RecordDetail({ drill }: { drill: Extract<Drill, { kind: 'record' }> }) {
  const r = drill.record as any;
  const url = documentUrl(r);
  const entries = RECORD_ORDER.filter(k => r[k] !== null && r[k] !== undefined && r[k] !== '');
  return (
    <>
      <DetailHeader
        title={drill.recordType === 'filing' ? 'Recorded assignment' : 'Credit-facility filing'}
        subtitle={<>CFN <span className="font-mono">{r.cfn}</span>{r.rec_date ? ` · recorded ${r.rec_date}` : ''}</>}
        right={url ? <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[10px] text-primary hover:underline inline-flex items-center gap-1">Document image <ExternalLink size={10} /></a> : <span className="shrink-0 text-[10px] text-muted-foreground" title={noDocumentUrlReason(r)}>no image link</span>}
      />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 py-2">
        {entries.map(k => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground whitespace-nowrap">{RECORD_LABELS[k]}</dt>
            <dd className={`break-words ${k === 'facility_evidence_quote' ? 'italic' : ''}`}>
              {k === 'loan_amount' || k === 'consideration_amount' || k === 'facility_amount' ? formatMoney(Number(r[k])) : String(r[k]).replace(/_/g, k.endsWith('_type') || k === 'direction' ? ' ' : '_')}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

// ── tier 3: ask the model about the row ──────────────────────────────────────

function AskAboutRow({ headers, cells, drill }: { headers: string[]; cells: string[]; drill: Drill | null }) {
  const ctx = useContext(DrillContext)!;
  const [state, setState] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; text: string; steps: ToolStep[]; error?: string }>({ status: 'idle', text: '', steps: [] });
  const abortRef = useRef<AbortController | null>(null);

  const question = `Show me the individual records behind this row of the table you just gave me: ${describeRow(headers, cells)}. List the specific filings (CFN, recorded date, assignor → assignee, property address and amount where known), using the same county and date window as the table${drill ? ` (your lookups suggest: ${drill.label})` : ''}. If the row is not something that has individual filings, say so briefly and show the closest thing that does.`;

  async function run() {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'running', text: '', steps: [] });
    try {
      await streamChat(
        { county: ctx.county, messages: [...ctx.getHistory(), { role: 'user', content: question }] },
        controller.signal,
        {
          onDelta: t => setState(s => ({ ...s, text: s.text + t })),
          onTool: step => setState(s => ({ ...s, steps: [...s.steps, step] })),
          onToolDone: (id, patch) => setState(s => ({ ...s, steps: s.steps.map(x => (x.id === id ? { ...x, ...patch } : x)) })),
          onDone: () => setState(s => ({ ...s, status: 'done' })),
          onError: message => setState(s => ({ ...s, status: 'error', error: message })),
        },
      );
      setState(s => (s.status === 'running' ? { ...s, status: 'done' } : s));
    } catch (err: any) {
      setState(s => ({ ...s, status: err?.name === 'AbortError' ? 'done' : 'error', error: err?.name === 'AbortError' ? undefined : (err?.message ?? 'Request failed') }));
    }
  }

  if (state.status === 'idle') {
    return (
      <div className="px-3 py-2">
        {!drill && <div className="text-muted-foreground mb-1.5">This row could not be matched to a lookup automatically.</div>}
        <button onClick={() => void run()} className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground rounded px-2.5 py-1 hover:bg-primary/90">
          <MessageSquare size={11} /> Ask about this row
        </button>
        <span className="text-[10px] text-muted-foreground ml-2">one more model turn, answered here</span>
      </div>
    );
  }

  const subHistory: ChatHistoryMessage[] = [...ctx.getHistory(), { role: 'user', content: question }, { role: 'assistant', content: state.text }];
  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        {state.status === 'running' ? <Loader2 size={11} className="animate-spin" /> : <MessageSquare size={11} />}
        <span className="truncate">Asked: records behind “{cells.filter(Boolean).slice(0, 3).join(' · ')}”</span>
        {state.steps.length > 0 && <span className="text-muted-foreground/70">· {state.steps.length} lookup{state.steps.length === 1 ? '' : 's'}</span>}
        {state.status === 'running' && <button onClick={() => abortRef.current?.abort()} className="ml-auto text-[10px] hover:text-foreground">stop</button>}
      </div>
      {state.text && (
        <ChatAnswer content={state.text} steps={state.steps} county={ctx.county} history={subHistory} ready={state.status !== 'running'} />
      )}
      {state.status === 'running' && !state.text && <div className="text-muted-foreground">Thinking…</div>}
      {state.error && <div className="text-red-700 flex items-start gap-1.5"><AlertTriangle size={11} className="mt-0.5 shrink-0" /> {state.error}</div>}
    </div>
  );
}
