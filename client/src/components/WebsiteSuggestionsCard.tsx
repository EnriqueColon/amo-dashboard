// Targets page: AI-suggested websites waiting for a person (server/entity-website-suggest.ts).
// Accepting one sets the firm's website, and its logo then shows across the tool.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Globe, Check, X, Pencil, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { LOGOS_KEY } from './EntityAvatar';

const KEY = ['/api/website-suggestions'];

const CONF_STYLE: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-red-100 text-red-700',
};

function MatchPill({ m }: { m: number | null }) {
  if (m == null) return <span className="text-[10px] text-muted-foreground" title="The firm's name has only generic words (Capital, Lending…), so it can't be checked against the site.">name not checkable</span>;
  const ok = m >= 0.99;
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ok ? 'bg-emerald-50 text-emerald-700' : m > 0 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}
      title="Whether the firm's distinctive name words appear in the site's address or home page title. A missing name is a reason to look closely.">
      {ok ? 'name on site' : m > 0 ? 'name partly on site' : 'name not on site'}
    </span>
  );
}

function Row({ r, onDone }: { r: any; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(r.domain);
  const [error, setError] = useState<string | null>(null);
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onSuccess: () => { setError(null); onDone(); },
    onError: (e: Error) => setError(e.message),
  });
  const base = `/api/website-suggestions/${encodeURIComponent(r.entity)}`;
  return (
    <li className="flex items-start gap-3 px-4 py-2 hover:bg-muted/20">
      <span className="w-7 h-7 rounded-full border border-border bg-white shrink-0 flex items-center justify-center overflow-hidden mt-0.5">
        {r.logo ? <img src={r.logo} alt="" className="w-[78%] h-[78%] object-contain" /> : <Globe size={12} className="text-muted-foreground" />}
      </span>
      <div className="flex-1 min-w-0 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{r.entity}</span>
          <span className="text-muted-foreground">→</span>
          {editing ? (
            <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); act.mutate({ path: `${base}/accept`, body: { domain: value } }); }}>
              <input autoFocus onFocus={e => e.target.select()} value={value} onChange={e => setValue(e.target.value)}
                className="h-6 w-56 px-2 rounded border border-border bg-background text-xs" />
              <button type="submit" className="text-[10px] text-primary hover:underline">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="text-[10px] text-muted-foreground">Cancel</button>
            </form>
          ) : (
            <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
              {r.domain}<ExternalLink size={10} />
            </a>
          )}
          {r.confidence && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${CONF_STYLE[r.confidence] || ''}`} title="How sure the AI search said it was.">{r.confidence}</span>}
          <MatchPill m={r.name_match} />
        </div>
        <p className="text-[11px] text-muted-foreground truncate" title={`${r.reason || ''}${r.page_title ? `\nSite title: ${r.page_title}` : ''}`}>
          {[r.company_name, r.location].filter(Boolean).join(' · ')}{r.reason ? ` — ${r.reason}` : ''}
        </p>
        {error && <p className="text-[10px] text-red-600">{error}</p>}
      </div>
      {!editing && (
        <div className="flex items-center gap-2 shrink-0 text-[11px]">
          <button onClick={() => act.mutate({ path: `${base}/accept` })} disabled={act.isPending}
            className="inline-flex items-center gap-0.5 text-emerald-700 hover:underline" title="This is the firm's website: use its logo"><Check size={12} />Accept</button>
          <button onClick={() => { setValue(r.domain); setEditing(true); }} className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground" title="Type the correct website instead"><Pencil size={11} />Edit</button>
          <button onClick={() => act.mutate({ path: `${base}/reject` })} disabled={act.isPending}
            className="inline-flex items-center gap-0.5 text-red-600 hover:underline" title="Not this firm: keep its initials"><X size={12} />Reject</button>
        </div>
      )}
    </li>
  );
}

export default function WebsiteSuggestionsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => apiRequest('GET', '/api/website-suggestions').then(r => r.json()) });
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(25);
  if (!data) return null;
  const rows: any[] = data.rows || [];
  const c = data.counts || {};
  if (!rows.length && !c.accepted && !c.rejected && !c.none) return null;
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: LOGOS_KEY }); };
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full px-4 py-3 border-b border-border flex items-center gap-2 text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <h2 className="text-sm font-semibold">Suggested websites</h2>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} to review · {c.accepted || 0} accepted · {c.rejected || 0} rejected · {c.none || 0} not found
        </span>
      </button>
      {open && (
        <>
          <p className="px-4 pt-2 text-[11px] text-muted-foreground">
            An AI web search suggested a website for targets that had none. Check each one (open the link), then Accept to use its logo, Edit to type the right site, or Reject.
            Rows where the firm's name appears on the site come first.
          </p>
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">Nothing left to review.</p>
          ) : (
            <ul className="divide-y divide-border/40 mt-1">
              {rows.slice(0, shown).map(r => <Row key={r.entity} r={r} onDone={refresh} />)}
            </ul>
          )}
          {rows.length > shown && (
            <button onClick={() => setShown(s => s + 25)} className="w-full px-4 py-2 text-[11px] text-primary hover:underline border-t border-border">
              Show 25 more ({rows.length - shown} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
