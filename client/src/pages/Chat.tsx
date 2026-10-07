import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquare, Send, Square, RotateCcw, ChevronDown, ChevronRight, Database, AlertTriangle, Loader2 } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useCounty, countyLabel } from '@/lib/county';

/**
 * Ask the Data — a chat interface over the AMO database.
 *
 * The browser keeps only the visible conversation (user + assistant text).
 * Each send POSTs the whole thing to /api/chat and reads the Server-Sent
 * Events stream back: tool steps appear as they run, then the answer streams
 * token by token. Tool results themselves never reach the browser — only a
 * one-line summary — so the page stays light even when the model pulls 200 rows.
 */

interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  purpose?: string;
  ms?: number;
  rows?: number;
  error?: string;
  done: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: ToolStep[];
  error?: string;
  streaming?: boolean;
  meta?: { model: string; rounds: number; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null };
}

const SUGGESTIONS = [
  'Who were the top 10 acquirers of mortgages in 2025, and how does that compare to 2024?',
  'Which banks provide warehouse lines in Miami-Dade, and to whom?',
  'Show me Mr. Cooper\'s activity this year: who are they buying from and selling to?',
  'How has monthly loan-transfer volume trended over the last 18 months?',
  'Which private credit funds are most active, and what are they buying?',
  'What data do you have, and what are its gaps?',
];

const TOOL_LABELS: Record<string, string> = {
  get_dataset_overview: 'Checking dataset coverage',
  search_entities: 'Looking up entity',
  get_entity_profile: 'Loading entity profile',
  get_top_entities: 'Ranking entities',
  get_monthly_volume: 'Pulling monthly volume',
  list_filings: 'Listing filings',
  get_lending_relationships: 'Loading lending relationships',
  list_facility_filings: 'Loading facility filings',
  get_document_text: 'Reading document',
  run_sql: 'Running query',
};

function describeStep(s: ToolStep): string {
  const base = TOOL_LABELS[s.name] ?? s.name;
  if (s.name === 'run_sql' && s.purpose) return s.purpose;
  const a = s.args ?? {};
  const bits: string[] = [];
  if (typeof a.query === 'string') bits.push(`"${a.query}"`);
  if (typeof a.entity === 'string') bits.push(a.entity);
  if (typeof a.cfn === 'string') bits.push(`CFN ${a.cfn}`);
  if (typeof a.lender === 'string') bits.push(`lender ~ ${a.lender}`);
  if (typeof a.borrower === 'string') bits.push(`borrower ~ ${a.borrower}`);
  if (typeof a.role === 'string') bits.push(a.role === 'assignee' ? 'acquirers' : a.role === 'assignor' ? 'sellers' : a.role);
  if (typeof a.county === 'string') bits.push(a.county);
  if (a.from || a.to) bits.push(`${a.from ?? '…'} → ${a.to ?? '…'}`);
  return bits.length ? `${base}: ${bits.join(' · ')}` : base;
}

let idCounter = 0;
const nextId = () => `m${Date.now()}_${idCounter++}`;

export default function Chat() {
  const { county } = useCounty();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: config } = useQuery({
    queryKey: ['/api/chat/config'],
    queryFn: () => apiRequest('GET', '/api/chat/config').then(r => r.json()),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const update = (id: string, fn: (m: Message) => Message) =>
    setMessages(prev => prev.map(m => (m.id === id ? fn(m) : m)));

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const userMsg: Message = { id: nextId(), role: 'user', content };
    const assistantId = nextId();
    const history = [...messages, userMsg];
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', steps: [], streaming: true }]);
    setInput('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          county,
          messages: history.filter(m => !m.error || m.content).map(m => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          if (event === 'delta') {
            update(assistantId, m => ({ ...m, content: m.content + payload.text }));
          } else if (event === 'tool') {
            update(assistantId, m => ({ ...m, steps: [...(m.steps ?? []), { id: payload.id, name: payload.name, args: payload.args ?? {}, purpose: payload.purpose, done: false }] }));
          } else if (event === 'tool_done') {
            update(assistantId, m => ({ ...m, steps: (m.steps ?? []).map(s => s.id === payload.id ? { ...s, done: true, ms: payload.ms, rows: payload.rows, error: payload.error } : s) }));
          } else if (event === 'done') {
            update(assistantId, m => ({ ...m, streaming: false, meta: { model: payload.model, rounds: payload.rounds, usage: payload.usage } }));
          } else if (event === 'error') {
            update(assistantId, m => ({ ...m, streaming: false, error: payload.message }));
          }
        }
      }
      update(assistantId, m => ({ ...m, streaming: false }));
    } catch (err: any) {
      const cancelled = err?.name === 'AbortError';
      update(assistantId, m => ({ ...m, streaming: false, error: cancelled ? (m.content ? undefined : 'Stopped.') : (err?.message ?? 'Request failed') }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() { abortRef.current?.abort(); }

  function reset() { stop(); setMessages([]); setInput(''); textareaRef.current?.focus(); }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
  }

  const unconfigured = config && !config.configured;

  return (
    <div className="flex flex-col h-full max-w-4xl w-full mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-3">
        <div className="flex items-center gap-3">
          <MessageSquare size={20} className="text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2 flex-wrap">
              Ask the Data
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-300 rounded px-1.5 py-0.5" title="Trial in production — answers are being reviewed; the page may change or go away">
                TESTING / NOT DEPLOYED
              </span>
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Plain-English questions over the assignment records · scope: <span className="font-medium text-foreground">{countyLabel(county)}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {config?.model && (
            <span className="hidden sm:inline text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5" title="Model answering your questions">
              {config.model}
            </span>
          )}
          {messages.length > 0 && (
            <button onClick={reset} data-testid="chat-reset" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 hover:bg-muted transition-colors">
              <RotateCcw size={12} /> New chat
            </button>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-6 py-2 space-y-5">
        {unconfigured && (
          <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>{config.message ?? 'The assistant is not configured on this server.'}</div>
          </div>
        )}

        {messages.length === 0 && !unconfigured && (
          <div className="pt-6">
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center gap-2 text-sm font-medium mb-1"><Database size={14} className="text-primary" /> What you can ask</div>
              <p className="text-xs text-muted-foreground mb-4">
                The assistant answers only from this dashboard's database — recorded assignments, resolved entities, lending relationships and UCC filings — and shows every lookup it ran. It will tell you when the data cannot answer.
              </p>
              <div className="grid sm:grid-cols-2 gap-2">
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => void send(s)} data-testid="chat-suggestion"
                    className="text-left text-xs leading-snug border border-border rounded-md px-3 py-2.5 hover:bg-muted hover:border-primary/40 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map(m => <MessageView key={m.id} m={m} />)}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="px-6 pb-6 pt-2">
        <div className="bg-card border border-border rounded-xl shadow-sm focus-within:ring-2 focus-within:ring-ring/40 transition-shadow">
          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={!!unconfigured}
            rows={1}
            placeholder={unconfigured ? 'Assistant unavailable' : 'Ask about lenders, deals, trends, or lending relationships…'}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm focus:outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <span className="text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <button onClick={stop} data-testid="chat-stop" className="flex items-center gap-1.5 text-xs bg-muted text-foreground rounded-md px-3 py-1.5 hover:bg-muted/70 transition-colors">
                <Square size={11} /> Stop
              </button>
            ) : (
              <button onClick={() => void send(input)} disabled={!input.trim() || !!unconfigured} data-testid="chat-send"
                className="flex items-center gap-1.5 text-xs bg-primary text-primary-foreground rounded-md px-3 py-1.5 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <Send size={11} /> Send
              </button>
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 px-1">
          Answers are generated by a language model from database lookups and can be wrong — check the steps and the underlying pages before relying on a figure.
        </p>
      </div>
    </div>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="chat-user-message">
        <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed">
          {m.content}
        </div>
      </div>
    );
  }
  const waiting = m.streaming && !m.content;
  return (
    <div className="flex gap-3" data-testid="chat-assistant-message">
      <div className="shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center mt-0.5">
        <Database size={13} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {m.steps && m.steps.length > 0 && <Steps steps={m.steps} live={!!m.streaming} />}
        {waiting && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 size={12} className="animate-spin" /> {m.steps?.length ? 'Reading results…' : 'Thinking…'}
          </div>
        )}
        {m.content && (
          <div className="prose prose-sm max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-pre:text-xs prose-code:text-[12px] prose-code:before:content-none prose-code:after:content-none prose-a:text-primary">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
            }}>
              {m.content}
            </ReactMarkdown>
          </div>
        )}
        {m.error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{m.error}</span>
          </div>
        )}
        {m.meta && !m.streaming && (
          <div className="text-[10px] text-muted-foreground/70 font-mono">
            {m.meta.model} · {m.meta.rounds} round{m.meta.rounds === 1 ? '' : 's'}
            {m.meta.usage ? ` · ${m.meta.usage.total_tokens.toLocaleString()} tokens` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ steps, live }: { steps: ToolStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = steps.filter(s => !s.done).length;
  const errors = steps.filter(s => s.error).length;
  return (
    <div className="border border-border rounded-md bg-muted/30 text-xs" data-testid="chat-steps">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {live && running > 0 ? <Loader2 size={11} className="animate-spin" /> : <Database size={11} />}
        <span>
          {steps.length} lookup{steps.length === 1 ? '' : 's'}
          {errors ? ` · ${errors} returned an error` : ''}
        </span>
        {!open && (
          <span className="truncate text-muted-foreground/70 ml-1">— {describeStep(steps[steps.length - 1])}</span>
        )}
      </button>
      {open && (
        <ul className="border-t border-border divide-y divide-border/60">
          {steps.map(s => (
            <li key={s.id} className="px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className={s.error ? 'text-red-700' : 'text-foreground'}>{describeStep(s)}</span>
                <span className="font-mono text-muted-foreground shrink-0">
                  {!s.done ? '…' : s.error ? 'error' : `${s.rows !== undefined ? `${s.rows} rows · ` : ''}${s.ms}ms`}
                </span>
              </div>
              {s.name === 'run_sql' && typeof s.args.sql === 'string' && (
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground bg-background border border-border rounded px-2 py-1.5">{s.args.sql}</pre>
              )}
              {s.error && <div className="mt-1 text-red-700/80">{s.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
