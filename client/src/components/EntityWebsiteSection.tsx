// Website line on the firm card: where the firm's logo comes from (server/entity-logos.ts).
// Banks get FDIC's website automatically; anyone can type or correct a website here.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Globe, Pencil, RotateCcw, Check, X, Sparkles } from 'lucide-react';
import { LOGOS_KEY } from './EntityAvatar';

export default function EntityWebsiteSection({ entityName }: { entityName: string }) {
  const qc = useQueryClient();
  const key = ['/api/entity/website', entityName];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}/website`).then(r => r.json()),
    enabled: !!entityName,
    refetchInterval: (q: any) => (q.state.data?.logo_status === 'pending' ? 4000 : false),
  });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: LOGOS_KEY });
  };
  const save = useMutation({
    mutationFn: async (website: string | null) => {
      const r = await fetch(`/api/entity/${encodeURIComponent(entityName)}/website`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ website }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Could not save (${r.status})`);
      return j;
    },
    onSuccess: () => { setEditing(false); setError(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });
  // Phase 2: an AI web search can suggest a website; a person accepts or rejects it.
  const sKey = ['/api/entity/website/suggestion', entityName];
  const { data: suggestion } = useQuery({
    queryKey: sKey,
    queryFn: () => apiRequest('GET', `/api/entity/${encodeURIComponent(entityName)}/website/suggestion`).then(r => r.json()),
    enabled: !!entityName,
  });
  const post = async (path: string) => {
    const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Failed (${r.status})`);
    return j;
  };
  const suggest = useMutation({
    mutationFn: () => post(`/api/entity/${encodeURIComponent(entityName)}/website/suggest`),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: sKey }); qc.invalidateQueries({ queryKey: ['/api/website-suggestions'] }); },
    onError: (e: Error) => setError(e.message),
  });
  const decide = useMutation({
    mutationFn: (verb: 'accept' | 'reject') => post(`/api/website-suggestions/${encodeURIComponent(entityName)}/${verb}`),
    onSuccess: () => { setError(null); refresh(); qc.invalidateQueries({ queryKey: sKey }); qc.invalidateQueries({ queryKey: ['/api/website-suggestions'] }); },
    onError: (e: Error) => setError(e.message),
  });

  const reset = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/entity/${encodeURIComponent(entityName)}/website`).then(r => r.json()),
    onSuccess: refresh,
  });

  if (!data) return null;
  const sourceLabel = data.source === 'fdic' ? 'from FDIC' : data.source === 'manual' ? 'entered by hand' : data.source === 'reviewed' ? 'suggested, confirmed by hand' : null;
  const logoNote =
    !data.domain ? 'No website, so the card shows initials.'
    : data.logo_status === 'pending' ? 'Fetching the logo…'
    : data.logo_status === 'none' ? 'No usable icon found on this site; initials are shown.'
    : null;

  return (
    <div className="border border-border/60 rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <Globe size={12} className="text-primary shrink-0" />
        <span className="font-semibold" title="The firm's website. Its icon is used as the firm's logo across the tool.">Website</span>
        {data.logo && <img src={data.logo} alt="" className="w-5 h-5 object-contain rounded" />}
        {!editing && (
          <>
            {data.domain
              ? <a href={`https://${data.domain}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{data.domain}</a>
              : <span className="text-muted-foreground">{data.source === 'manual' ? 'none (set by hand)' : 'not known'}</span>}
            {sourceLabel && <span className="text-[10px] text-muted-foreground">{sourceLabel}</span>}
            <button onClick={() => { setValue(data.domain || ''); setError(null); setEditing(true); }}
              className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary" title="Type or correct the firm's website">
              <Pencil size={10} />{data.domain ? 'Change' : 'Add website'}
            </button>
            {!data.domain && data.source !== 'manual' && suggestion?.status !== 'pending' && (
              <button onClick={() => suggest.mutate()} disabled={suggest.isPending}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                title="Ask an AI web search for this firm's website (about 3 cents). You confirm it before it is used.">
                <Sparkles size={10} />{suggest.isPending ? 'Searching…' : suggestion?.status === 'none' ? 'Search again' : 'Suggest'}
              </button>
            )}
            {(data.source === 'manual' || data.source === 'reviewed') && (
              <button onClick={() => reset.mutate()} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                title="Forget the typed website and go back to the automatic one (FDIC for banks)">
                <RotateCcw size={10} />Automatic
              </button>
            )}
          </>
        )}
        {editing && (
          <form className="flex items-center gap-1.5 flex-1 min-w-[220px]" onSubmit={e => { e.preventDefault(); save.mutate(value.trim() || null); }}>
            <input autoFocus onFocus={e => e.target.select()} value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. amerantbank.com"
              className="flex-1 h-6 px-2 rounded border border-border bg-background text-xs" />
            <button type="submit" disabled={save.isPending} className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"><Check size={11} />Save</button>
            <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className="text-[10px] text-muted-foreground hover:text-foreground"
              title="This firm has no website; show its initials">No website</button>
            <button type="button" onClick={() => { setEditing(false); setError(null); }} className="text-muted-foreground hover:text-foreground" aria-label="Cancel"><X size={12} /></button>
          </form>
        )}
      </div>
      {!data.domain && suggestion?.status === 'pending' && suggestion.domain && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-muted-foreground">Suggested:</span>
          <a href={`https://${suggestion.domain}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{suggestion.domain}</a>
          {suggestion.company_name && <span className="text-muted-foreground">({suggestion.company_name}{suggestion.location ? `, ${suggestion.location}` : ''})</span>}
          <span className="text-[10px] text-muted-foreground" title={suggestion.reason || ''}>
            {suggestion.confidence || '?'} confidence · {suggestion.name_match == null ? 'name not checkable' : suggestion.name_match >= 0.99 ? 'name on site' : suggestion.name_match > 0 ? 'name partly on site' : 'name not on site'}
          </span>
          <button onClick={() => decide.mutate('accept')} disabled={decide.isPending} className="inline-flex items-center gap-0.5 text-emerald-700 hover:underline"><Check size={11} />Use it</button>
          <button onClick={() => decide.mutate('reject')} disabled={decide.isPending} className="inline-flex items-center gap-0.5 text-red-600 hover:underline"><X size={11} />Not it</button>
        </div>
      )}
      {!data.domain && suggestion?.status === 'none' && (
        <p className="mt-1 text-[10px] text-muted-foreground">The AI search found no website it could stand behind{suggestion.reason ? `: ${suggestion.reason}` : '.'}</p>
      )}
      {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}
      {!error && logoNote && <p className="mt-1 text-[10px] text-muted-foreground">{logoNote}</p>}
    </div>
  );
}
