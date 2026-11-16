// Hillsborough complaints, HAND-PULL TEST (owner, 16 Nov 2026: three-day trial before deciding to integrate).
// The Clerk's site (HOVER) blocks programs, so a person downloads each complaint and drops it here;
// the server reads it straight away with the same reader and $500,000 test as every other county
// (server/hillsborough-handpull.ts). Not linked from the menu; reached from the Complaints tab.
import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Upload, Copy, ExternalLink, Check, Loader2, AlertTriangle, FileText, RotateCcw, X } from 'lucide-react';

const KEY = ['/api/hillsborough-test'];
const HOVER = 'https://hover.hillsclerk.com/';

const usd0 = (v: number | null) => (v == null ? null : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const et = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '');

function Verdict({ r }: { r: any }) {
  if (r.read_error) return <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle size={12} />Read failed</span>;
  if (r.reading) return <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 size={12} className="animate-spin" />Reading… (a few minutes)</span>;
  if (!r.read) return <span className="text-muted-foreground">Not read yet</span>;
  const style = r.verdict === 'qualifies' ? 'bg-emerald-100 text-emerald-800' : r.verdict === 'no' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800';
  const label = r.verdict === 'qualifies' ? 'Qualifies' : r.verdict === 'no' ? 'Does not qualify' : 'Unclear';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>;
}

function TodoRow({ r, onDone }: { r: any; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Please choose the PDF file');
      const res = await fetch(`/api/hillsborough-test/${encodeURIComponent(r.case_id)}/upload`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/pdf' }, body: file,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
    },
    onSuccess: () => { setError(null); onDone(); },
    onError: (e: Error) => setError(e.message),
  });
  const skip = useMutation({
    mutationFn: (reason: string) => apiRequest('POST', `/api/hillsborough-test/${encodeURIComponent(r.case_id)}/skip`, { reason }),
    onSuccess: onDone,
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.case_number); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const drop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) upload.mutate(f);
  };
  return (
    <li
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
      className={`px-4 py-3 flex items-start gap-3 ${over ? 'bg-primary/10 ring-2 ring-primary ring-inset' : 'hover:bg-muted/20'}`}
    >
      <div className="flex-1 min-w-0 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm">{r.case_number}</span>
          <button onClick={copy} className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline" title="Copy the case number, then paste it into HOVER's case search">
            {copied ? <><Check size={11} />Copied</> : <><Copy size={11} />Copy</>}
          </button>
          <span className="text-muted-foreground">Filed {r.filing_date}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{r.case_type}</span>
        </div>
        <p className="mt-0.5 truncate" title={r.case_style || ''}>{r.case_style}</p>
        {error && <p className="mt-0.5 text-[11px] text-red-600">{error}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
        <button onClick={() => input.current?.click()} disabled={upload.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50">
          {upload.isPending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          {upload.isPending ? 'Uploading…' : 'Upload PDF'}
        </button>
        <select defaultValue="" disabled={skip.isPending}
          onChange={e => { if (e.target.value) skip.mutate(e.target.value); }}
          className="h-7 rounded-md border border-border bg-background text-[11px] text-muted-foreground px-1" title="Use when the complaint can't be downloaded">
          <option value="" disabled>Skip…</option>
          <option value="Complaint not on HOVER yet">Not on HOVER yet</option>
          <option value="Complaint not public (confidential)">Not public</option>
          <option value="Not a foreclosure / wrong case">Wrong case</option>
          <option value="Skipped (other)">Other</option>
        </select>
      </div>
    </li>
  );
}

function DoneRow({ r, onDone }: { r: any; onDone: () => void }) {
  const reread = useMutation({
    mutationFn: () => apiRequest('POST', `/api/hillsborough-test/${encodeURIComponent(r.case_id)}/reread`),
    onSuccess: onDone,
  });
  return (
    <li className="px-4 py-2.5 flex items-start gap-3 text-xs">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold">{r.case_number}</span>
          <Verdict r={r} />
          {r.principal != null && <span>Principal <b>{usd0(r.principal)}</b></span>}
          <a href={`/api/complaints/${encodeURIComponent(r.case_id)}/pdf`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"><FileText size={11} />PDF</a>
          <span className="text-muted-foreground">uploaded {et(r.uploaded_at)}</span>
        </div>
        <p className="mt-0.5 truncate text-muted-foreground" title={r.case_style || ''}>{r.case_style}</p>
        {r.read && r.reason && <p className="mt-0.5 text-[11px]">{r.reason}</p>}
        {r.read && r.address && <p className="text-[11px] text-muted-foreground">{r.address}</p>}
        {r.read_error && (
          <p className="mt-0.5 text-[11px] text-red-600">
            {r.read_error}{' '}
            <button onClick={() => reread.mutate()} className="inline-flex items-center gap-0.5 text-primary hover:underline"><RotateCcw size={10} />Try again</button>
          </p>
        )}
        {!r.read && !r.reading && !r.read_error && r.has_pdf && (
          <button onClick={() => reread.mutate()} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"><RotateCcw size={10} />Read now</button>
        )}
      </div>
    </li>
  );
}

export default function HillsboroughTest() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: () => apiRequest('GET', '/api/hillsborough-test').then(r => r.json()),
    refetchInterval: (q: any) => (q.state.data?.done?.some((r: any) => r.reading) ? 5000 : 60_000),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const unskip = useMutation({
    mutationFn: (id: string) => apiRequest('POST', `/api/hillsborough-test/${encodeURIComponent(id)}/unskip`),
    onSuccess: refresh,
  });

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Hillsborough complaints: hand-download test</h1>
        <p className="text-xs text-muted-foreground mt-1">
          A three-day trial. Each morning the system lists new Hillsborough foreclosures that could qualify ($250,000-or-more band).
          For each one: <b>Copy</b> the case number, open <a href={HOVER} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">HOVER<ExternalLink size={10} /></a>,
          search it, download the <b>Complaint</b>, then click <b>Upload PDF</b> (or drag the file onto the row). It is read automatically in a few minutes (scanned complaints take longer).
          These cases are not on the Complaints tab until the test is agreed.
        </p>
      </div>

      {error ? <p className="text-xs text-red-600">Could not load the list: {(error as Error).message}</p> : isLoading || !data ? <p className="text-xs text-muted-foreground">Loading…</p> : (
        <>
          <div className="flex gap-3 flex-wrap text-xs">
            <div className="border border-border rounded-lg px-3 py-2"><div className="text-muted-foreground">To download</div><div className="text-lg font-semibold">{data.todo.length}</div></div>
            <div className="border border-border rounded-lg px-3 py-2"><div className="text-muted-foreground">Uploaded</div><div className="text-lg font-semibold">{data.done.length}</div></div>
            <div className="border border-border rounded-lg px-3 py-2"><div className="text-muted-foreground">Qualify</div><div className="text-lg font-semibold">{data.done.filter((r: any) => r.verdict === 'qualifies').length}</div></div>
            <div className="border border-border rounded-lg px-3 py-2"><div className="text-muted-foreground">Skipped</div><div className="text-lg font-semibold">{data.skipped.length}</div></div>
            <div className="border border-border rounded-lg px-3 py-2 text-muted-foreground" title="Cases in the lower claim bands can't hold $500,000 of principal, so they are not downloaded">
              <div>Below $250k band (no download)</div><div className="text-lg font-semibold">{data.below_band}</div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <h2 className="text-sm font-semibold">To download</h2>
              <span className="text-[11px] text-muted-foreground">filed in the last {data.window_days} days · list updated {et(data.last_case_seen)}</span>
            </div>
            {data.todo.length === 0
              ? <p className="px-4 py-3 text-xs text-muted-foreground">Nothing to download right now.</p>
              : <ul className="divide-y divide-border/40">{data.todo.map((r: any) => <TodoRow key={r.case_id} r={r} onDone={refresh} />)}</ul>}
          </div>

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border"><h2 className="text-sm font-semibold">Uploaded and read</h2></div>
            {data.done.length === 0
              ? <p className="px-4 py-3 text-xs text-muted-foreground">None yet.</p>
              : <ul className="divide-y divide-border/40">{data.done.map((r: any) => <DoneRow key={r.case_id} r={r} onDone={refresh} />)}</ul>}
          </div>

          {data.skipped.length > 0 && (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border"><h2 className="text-sm font-semibold">Skipped</h2></div>
              <ul className="divide-y divide-border/40">
                {data.skipped.map((r: any) => (
                  <li key={r.case_id} className="px-4 py-2 text-xs flex items-center gap-2">
                    <span className="font-mono font-semibold">{r.case_number}</span>
                    <span className="text-muted-foreground">{r.note}</span>
                    <button onClick={() => unskip.mutate(r.case_id)} className="ml-auto inline-flex items-center gap-0.5 text-primary hover:underline"><X size={11} />Undo</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.days.length > 0 && (
            <div className="text-xs">
              <h2 className="text-sm font-semibold mb-1">By day</h2>
              <table className="text-xs"><thead><tr className="text-muted-foreground"><th className="text-left pr-6">Day (ET)</th><th className="text-right pr-6">Uploaded</th><th className="text-right">Qualify</th></tr></thead>
                <tbody>{data.days.map((d: any) => <tr key={d.day}><td className="pr-6">{d.day}</td><td className="text-right pr-6">{d.uploaded}</td><td className="text-right">{d.qualifies}</td></tr>)}</tbody></table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
