// Weekend progress page — /weekend (HTML) and /api/weekend-status (JSON).
//
// Built for the 18–21 Sep 2026 re-read and rebuild so the owner can follow the
// run from a phone without SSH. READ-ONLY: it reads the status files that
// collector/weekend/run_weekend.sh writes and counts rows in document_text. It
// never starts, stops or changes anything, so it is safe to leave deployed.
// Behind the normal login (checkAuth runs before it).
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';

const DB_PATH = process.env.AMO_DB_PATH || path.resolve(process.cwd(), 'miami_dade_amo.db');
const DIR = process.env.WEEKEND_DIR || path.join(path.dirname(DB_PATH), 'collector', 'weekend');

function read(name: string): string {
  try { return fs.readFileSync(path.join(DIR, name), 'utf8'); } catch { return ''; }
}
function exists(name: string): boolean {
  return fs.existsSync(path.join(DIR, name));
}
// The job's own step codes (P0..P5) mean nothing to a reader of this page.
const plain = (t: string) => t.replace(/^P\d\s+/, '');
function tail(text: string, n: number): string[] {
  return text.split('\n').filter(Boolean).slice(-n);
}
function et(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

// check_email.sh ALSO writes "Sent via" to email.log (its test send to the
// owner), so only a "Sent via" after monday_email.sh's own marker counts.
function mondaySend(log: string) {
  const i = log.lastIndexOf('[monday-send]');
  if (i < 0) return { done: false };
  const after = log.slice(i);
  return { done: /^Sent via/m.test(after), failed: /\[monday-send\] NOT SENT/.test(after) };
}

export function weekendStatus() {
  const statusLine = read('STATUS').trim();
  const [statusAt, ...rest] = statusLine.split(' ');
  const history = tail(read('STATUS.log'), 400)
    // the gates re-announce themselves every 15–30 min; keep the first of each run
    .filter((l, i, all) => i === 0 || l.slice(21) !== all[i - 1].slice(21))
    .slice(-15)
    .map(l => ({ at: et(l.slice(0, 20)), text: plain(l.slice(21)) }));

  // Re-read progress: stored rows, plus the job's own rate/ETA line.
  let stored: Record<string, number> = {};
  try {
    for (const r of getDb().prepare(
      'SELECT status, COUNT(*) AS n FROM document_text GROUP BY status').all() as any[]) {
      stored[r.status] = r.n;
    }
  } catch { stored = {}; }
  const log = read('reread.log');
  const start = /to read: (\d+)\s+already stored: \{'OK': (\d+)\}/.exec(log);
  const target = start ? Number(start[1]) + Number(start[2]) : null;
  const prog = Array.from(log.matchAll(/\[(\d+)\/(\d+)\].*?(\d+)\/hr\s+eta ([\d.]+)h\s+(\d\d:\d\d)Z/g)).pop();
  const ok = stored.OK || 0;
  const failed = Object.entries(stored).filter(([k]) => k !== 'OK').reduce((s, [, n]) => s + n, 0);
  const rereadDone = /P2 first pass finished/.test(read('STATUS.log'));
  let etaText: string | null = null;
  if (prog && !rereadDone) {
    const hours = Number(prog[4]);
    const [hh, mm] = prog[5].split(':').map(Number);
    const at = new Date();
    at.setUTCHours(hh, mm, 0, 0);
    if (at.getTime() > Date.now() + 60_000) at.setUTCDate(at.getUTCDate() - 1);
    etaText = et(new Date(at.getTime() + hours * 3600_000));
  }

  const log2 = read('STATUS.log');
  const steps = [
    { name: 'Owner confirmed the fix list', done: exists('APPROVED_FIXES') },
    { name: "Friday's weekly collection", done: /P1 weekly collection completed|P1 WARNING/.test(log2) },
    { name: 'Re-read every Miami-Dade loan document', done: /P2 retry pass finished/.test(log2),
      running: /P2 re-reading/.test(log2) && !/P2 retry pass finished/.test(log2) },
    { name: 'Fixes built and tested', done: exists('READY_FIXES') },
    { name: 'Fixes applied in one rebuild', done: exists('APPLIED_OK'),
      failed: /P4 APPLY FAILED/.test(log2), running: /P4 applying/.test(log2) && !exists('APPLIED_OK') },
    { name: 'Email checked end to end (test send to owner)', done: exists('EMAIL_CHECK_OK'),
      failed: /P5 EMAIL CHECK FAILED/.test(log2) },
    { name: 'Monday 9:00 AM ET send to recipients', ...mondaySend(read('email.log')) },
  ];

  return {
    now: et(new Date()),
    current: { at: statusAt ? et(statusAt) : null, text: plain(rest.join(' ')) || 'not started' },
    steps,
    reread: {
      stored_ok: ok, failed, target,
      percent: target ? Math.min(100, Math.round((ok / target) * 1000) / 10) : null,
      rate_per_hour: prog ? Number(prog[3]) : null,
      eta: etaText,
      finished: rereadDone,
    },
    history,
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);

function page(s: ReturnType<typeof weekendStatus>): string {
  const r = s.reread;
  const icon = (st: any) => st.failed ? '✗' : st.done ? '✓' : st.running ? '…' : '○';
  const cls = (st: any) => st.failed ? 'bad' : st.done ? 'ok' : st.running ? 'run' : 'todo';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Weekend progress</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mute:#5f6b78;--ok:#1a7f37;--bad:#cf222e;--run:#9a6700;--bar:#2f6fde;--line:#e3e6ea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--ink:#e6e9ed;--mute:#9aa4af;--ok:#3fb950;--bad:#f85149;--run:#d29922;--bar:#4c8dff;--line:#2a3038}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:0 0 4px}
.mute{color:var(--mute);font-size:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0}
.now{font-weight:600}.bar{height:12px;background:var(--line);border-radius:6px;overflow:hidden;margin:10px 0 6px}
.bar div{height:100%;background:var(--bar)}ul{list-style:none;padding:0;margin:0}li{padding:6px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}.ok{color:var(--ok)}.bad{color:var(--bad)}.run{color:var(--run)}.todo{color:var(--mute)}
.i{display:inline-block;width:1.4em;font-weight:700}.h li{font-size:14px}.h b{font-weight:500;color:var(--mute);margin-right:8px}
</style></head><body><main>
<h1>Weekend run — progress</h1>
<div class="mute">As of ${esc(s.now)} · refreshes every minute</div>
<div class="card"><div class="mute">Right now</div>
<div class="now">${esc(s.current.text)}</div><div class="mute">${esc(s.current.at ?? '')}</div></div>
<div class="card"><div class="mute">Document re-read</div>
<div class="now">${r.stored_ok.toLocaleString()}${r.target ? ` of ${r.target.toLocaleString()}` : ''} documents stored${r.percent != null ? ` (${r.percent}%)` : ''}</div>
${r.percent != null ? `<div class="bar"><div style="width:${r.percent}%"></div></div>` : ''}
<div class="mute">${r.finished ? 'Finished.' : [
    r.rate_per_hour ? `${r.rate_per_hour.toLocaleString()} per hour` : '',
    r.eta ? `expected to finish ${esc(r.eta)}` : '',
    r.failed ? `${r.failed.toLocaleString()} could not be read (retried at the end)` : '',
  ].filter(Boolean).join(' · ')}</div></div>
<div class="card"><div class="mute">Steps</div><ul>
${s.steps.map(st => `<li class="${cls(st)}"><span class="i">${icon(st)}</span>${esc(st.name)}</li>`).join('')}
</ul></div>
<div class="card h"><div class="mute">Recent history</div><ul>
${s.history.slice().reverse().map(h => `<li><b>${esc(h.at)}</b>${esc(h.text)}</li>`).join('')}
</ul></div>
</main></body></html>`;
}

export function registerWeekendStatus(app: Express) {
  app.get('/api/weekend-status', (_req, res) => res.json(weekendStatus()));
  app.get('/weekend', (_req, res) => res.type('html').send(page(weekendStatus())));
}
