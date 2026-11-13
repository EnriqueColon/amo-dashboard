// Collector health — GET /api/qc/collectors, for the Collection Log page.
//
// One row per scheduled job on the droplet: when it last ran, whether that run
// worked, when it last worked, its recent runs, and the reason when it failed.
//
// Why (12 Nov 2026): the Miami-Dade Official Records pull failed at sign-in on
// every run for two days (the IPRoyal proxy added for Leon refused .gov
// sites), and the weekly run had crashed in enrich_entities.py on 6 Nov.
// Neither showed anywhere in the dashboard. The completeness check could see
// the missing documents but nothing reported that the jobs themselves had
// stopped working.
//
// READ-ONLY. It reads the cron wrappers' own log files (each one already
// writes a "starting" and a "done … exit N" line) and never starts, stops or
// changes a job. Only the tail of each log is read, so a big log costs little.
// When a job is added to the crontab, add it to JOBS below.
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.AMO_DB_PATH || path.resolve(process.cwd(), 'miami_dade_amo.db');
const LOG_DIR = process.env.COLLECTOR_LOG_DIR || path.join(path.dirname(DB_PATH), 'collector');

type Format = 'marker' | 'weekly' | 'email' | 'activity';
type Job = {
  id: string;
  label: string;
  group: 'County records' | 'Foreclosure complaints' | 'Checks and processing' | 'Email and backups';
  log: string;              // relative to LOG_DIR
  format: Format;
  cron: { utc: string[]; days?: string }; // as installed in the crontab (UTC)
  expectH: number;          // overdue when the last start is older than this
  maxRunH: number;          // a run with no finish line older than this is a crash
};

const D = 24;
const JOBS: Job[] = [
  { id: 'miamidade_daily', label: 'Miami-Dade records pull', group: 'County records', log: 'miamidade_daily.log', format: 'marker', cron: { utc: ['12:30', '17:30', '22:30'] }, expectH: 16, maxRunH: 4 },
  { id: 'broward_daily', label: 'Broward records + images', group: 'County records', log: 'broward_daily.log', format: 'marker', cron: { utc: ['15:30', '19:30', '23:30'] }, expectH: 18, maxRunH: 4 },
  { id: 'hillsborough_daily', label: 'Hillsborough records pull', group: 'County records', log: 'hillsborough_daily.log', format: 'marker', cron: { utc: ['13:45'] }, expectH: D + 3, maxRunH: 6 },
  { id: 'weekly', label: 'Weekly run (collect, read, rebuild, classify firms)', group: 'County records', log: 'cron.log', format: 'weekly', cron: { utc: ['06:00'], days: 'Fri' }, expectH: 7 * D + 12, maxRunH: 10 },

  { id: 'complaints_daily', label: 'Miami-Dade complaints', group: 'Foreclosure complaints', log: 'complaints_daily.log', format: 'marker', cron: { utc: ['11:30'] }, expectH: D + 3, maxRunH: 4 },
  { id: 'duval_complaints', label: 'Duval complaints', group: 'Foreclosure complaints', log: 'duval_complaints_daily.log', format: 'marker', cron: { utc: ['11:50'] }, expectH: D + 3, maxRunH: 4 },
  { id: 'monroe_complaints', label: 'Monroe complaints', group: 'Foreclosure complaints', log: 'monroe_complaints_daily.log', format: 'marker', cron: { utc: ['12:10'] }, expectH: D + 3, maxRunH: 4 },
  { id: 'leon_complaints', label: 'Leon complaints', group: 'Foreclosure complaints', log: 'leon_complaints_daily.log', format: 'marker', cron: { utc: ['12:30'] }, expectH: D + 3, maxRunH: 4 },
  { id: 'citrus_complaints', label: 'Citrus complaints', group: 'Foreclosure complaints', log: 'citrus_complaints_daily.log', format: 'marker', cron: { utc: ['12:50'] }, expectH: D + 3, maxRunH: 4 },

  { id: 'daily_reconcile', label: 'Daily completeness check (all counties)', group: 'Checks and processing', log: 'daily_reconcile.log', format: 'marker', cron: { utc: ['16:30'] }, expectH: D + 3, maxRunH: 3 },
  { id: 'weekly_review', label: 'Friday 14-day completeness review', group: 'Checks and processing', log: 'weekly_review.log', format: 'marker', cron: { utc: ['17:00'], days: 'Fri' }, expectH: 7 * D + 6, maxRunH: 3 },
  { id: 'normalize_nightly', label: 'Nightly rebuild of the analysis tables', group: 'Checks and processing', log: 'batch/normalize_nightly.log', format: 'marker', cron: { utc: ['08:30'] }, expectH: D + 3, maxRunH: 5 },
  { id: 'facility_tick', label: 'Document reading queue (every 20 min)', group: 'Checks and processing', log: 'batch/tick.log', format: 'activity', cron: { utc: [], days: 'every 20 minutes' }, expectH: 1.5, maxRunH: 1 },
  { id: 'retry_failed_reads', label: 'Weekly retry of failed document reads', group: 'Checks and processing', log: 'retry_failed_reads.log', format: 'marker', cron: { utc: ['05:00'], days: 'Sat' }, expectH: 7 * D + 6, maxRunH: 6 },
  { id: 'bank_stress', label: 'Bank Stress / FDIC refresh', group: 'Checks and processing', log: 'bank_stress.log', format: 'marker', cron: { utc: ['03:00'], days: 'Sun' }, expectH: 7 * D + 6, maxRunH: 3 },

  { id: 'weekly_email', label: 'Monday email report', group: 'Email and backups', log: 'email.log', format: 'email', cron: { utc: ['12:00'], days: 'Mon' }, expectH: 7 * D + 6, maxRunH: 4 },
  { id: 'backup', label: 'Database backup', group: 'Email and backups', log: 'backup.log', format: 'marker', cron: { utc: ['03:15'] }, expectH: D + 3, maxRunH: 3 },
  { id: 'mi_backup', label: 'Intelligence platform backup', group: 'Email and backups', log: 'mi_backup.log', format: 'marker', cron: { utc: ['03:45'] }, expectH: D + 3, maxRunH: 3 },
];

export type Run = {
  started: string | null;
  finished: string | null;
  ok: boolean | null;       // null while running
  result: string;           // 'exit 0', 'status=ok', 'did not finish', …
  reason?: string;
};
export type JobHealth = {
  id: string; label: string; group: Job['group']; schedule: string;
  status: 'ok' | 'running' | 'failed' | 'overdue' | 'warn' | 'no_log';
  last_run: Run | null;
  last_good: string | null;
  failures_in_a_row: number;
  hours_since_start: number | null;
  recent: Run[];            // newest first, up to 14
};

// ─── helpers ────────────────────────────────────────────────────────────────

function readTail(file: string, bytes = 768 * 1024): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop a partial first line
      return text;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Never let a credential that a library put in an error message reach the page.
const scrub = (s: string) =>
  s.replace(/\/\/[^/\s:@]+:[^@\s]+@/g, '//***:***@')
   .replace(/(pass(word)?|token|key|secret)=\S+/gi, '$1=***')
   .slice(0, 240);

const EXC = /^[\w.]*(Error|Exception)\b[^:]*: .+/;           // python exception message
const FAILISH = /(FAILED|FATAL|❌|Traceback|NOT SENT|GAP)/;

function reasonFrom(lines: string[]): string | undefined {
  const exc = lines.find(l => EXC.test(l.trim()));
  if (exc) return scrub(exc.trim());
  const f = [...lines].reverse().find(l => FAILISH.test(l) && !/^Traceback/.test(l.trim()));
  return f ? scrub(f.trim()) : undefined;
}

const MON: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
// "Fri Nov  6 06:00:01 UTC 2026" → ISO
function parseUnixDate(s: string): string | null {
  const m = s.match(/\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d:\d\d:\d\d)\s+UTC\s+(\d{4})/);
  if (!m || !MON[m[1]]) return null;
  return `${m[4]}-${MON[m[1]]}-${m[2].padStart(2, '0')}T${m[3]}Z`;
}

const TS = '(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ)';
const START_RE = new RegExp(`^=== .+? starting: ${TS}`);
const DONE_A = new RegExp(`^=== .+? done: ${TS}(?: — (?:exit (\\d+)|status=(\\S+)))? ===`);
const DONE_B = new RegExp(`^=== .+? done — exit (\\d+): ${TS} ===`);
// run_nightly_normalize.sh when another rebuild (the Friday weekly run) is
// already going: it waits, restarts the app to publish that rebuild, and skips
// its own. That is a good run, not a missing one — before 13 Nov 2026 these two
// lines matched nothing and every Friday showed the job as overdue.
const WAIT_RE = new RegExp(`^=== .+?: another rebuild is running \\(${TS}\\)`);
const SKIP_RE = new RegExp(`^=== other rebuild finished \\(${TS}\\)`);

// Wrappers that write "=== <job> starting: TS" … "=== <job> done: TS — exit N ===".
function parseMarker(text: string): Run[] {
  const lines = text.split('\n');
  const runs: Run[] = [];
  let cur: { started: string; from: number } | null = null;
  lines.forEach((line, i) => {
    let m = line.match(START_RE) ?? line.match(WAIT_RE);
    if (m) {
      if (cur) runs.push({ started: cur.started, finished: null, ok: false, result: 'did not finish', reason: reasonFrom(lines.slice(cur.from, i)) });
      cur = { started: m[1], from: i };
      return;
    }
    let finished: string | null = null, exit: string | undefined, status: string | undefined;
    if ((m = line.match(SKIP_RE))) {
      runs.push({ started: cur?.started ?? null, finished: m[1], ok: true, result: 'skipped (weekly run rebuilt)' });
      cur = null;
      return;
    }
    if ((m = line.match(DONE_A))) { finished = m[1]; exit = m[2]; status = m[3]; }
    else if ((m = line.match(DONE_B))) { finished = m[2]; exit = m[1]; }
    if (!finished) return;
    const body = lines.slice(cur?.from ?? i, i);
    const ok = exit != null ? exit === '0' : status != null ? status === 'ok' : !body.some(l => FAILISH.test(l));
    const result = exit != null ? `exit ${exit}` : status != null ? `status=${status}` : ok ? 'finished' : 'finished with errors';
    runs.push({ started: cur?.started ?? null, finished, ok, result, reason: ok ? undefined : reasonFrom(body) });
    cur = null;
  });
  if (cur) runs.push({ started: (cur as any).started, finished: null, ok: null, result: 'running', reason: undefined });
  return runs;
}

// run_weekly.sh: "Started: <date>" … "Completed: <date>"; set -e, so a crash
// leaves a Traceback and no Completed line before the next Started.
function parseWeekly(text: string): Run[] {
  const lines = text.split('\n');
  const runs: Run[] = [];
  let cur: { started: string; from: number } | null = null;
  // atEnd: the newest run, which may still be going. An older run with neither a
  // Completed line nor a crash predates the Completed line (Aug 2026): unknown.
  const close = (i: number, atEnd = false) => {
    if (!cur) return;
    const body = lines.slice(cur.from, i);
    const crashed = body.some(l => /^(Traceback|FATAL)/.test(l.trim()));
    runs.push({
      started: cur.started, finished: null, ok: crashed ? false : null,
      result: crashed ? 'crashed' : atEnd ? 'running' : 'unknown',
      reason: crashed ? reasonFrom(body) : undefined,
    });
    cur = null;
  };
  lines.forEach((line, i) => {
    if (line.startsWith('Started: ')) { close(i); cur = { started: parseUnixDate(line.slice(9)) ?? line.slice(9), from: i }; }
    else if (line.startsWith('Completed: ') && cur) {
      runs.push({ started: cur.started, finished: parseUnixDate(line.slice(11)), ok: true, result: 'completed' });
      cur = null;
    } else if (/^FATAL/.test(line.trim()) && !cur) {
      runs.push({ started: null, finished: null, ok: false, result: 'aborted', reason: scrub(line.trim()) });
    }
  });
  close(lines.length, true);
  return runs;
}

// send_weekly_email.sh: "TS [weekly-email] start" then done / FAILED / NOT SENT /
// SKIPPED, or "not the send hour … exiting" (the other of the two firings —
// not a run at all, so it is dropped).
function parseEmail(text: string): Run[] {
  const runs: Run[] = [];
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^${TS} \\[weekly-email\\] (.*)$`));
    if (!m) continue;
    const [, ts, msg] = m;
    if (msg.startsWith('start')) { cur = ts; continue; }
    if (msg.startsWith('not the send hour')) { cur = null; continue; }
    if (msg === 'done') runs.push({ started: cur, finished: ts, ok: true, result: 'sent' });
    else if (/^(FAILED|NOT SENT)/.test(msg)) runs.push({ started: cur, finished: ts, ok: false, result: 'not sent', reason: scrub(msg) });
    else if (msg.startsWith('SKIPPED')) runs.push({ started: cur, finished: ts, ok: true, result: 'skipped (email off)', reason: scrub(msg) });
    else continue;
    cur = null;
  }
  return runs;
}

const hoursSince = (iso: string | null, now: number) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : Math.round(((now - t) / 3_600_000) * 10) / 10;
};

// Cron runs on UTC; the owner reads Eastern. Converted with today's offset, so
// the label follows daylight saving the way the real run time does.
function schedule(job: Job): string {
  if (!job.cron.utc.length) return job.cron.days ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const times = job.cron.utc.map(t =>
    new Date(`${today}T${t}:00Z`).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }));
  const days: Record<string, string> = { Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays', Mon: 'Mondays' };
  let day = job.cron.days;
  // The weekday is a UTC weekday too: Sunday 03:00 UTC is Saturday 10 PM
  // Eastern, so a time that falls on the previous Eastern day moves the day back.
  if (day) {
    const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const t = new Date(`${today}T${job.cron.utc[0]}:00Z`);
    const etDate = t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (etDate < today && order.includes(day)) day = order[(order.indexOf(day) + 6) % 7];
  }
  const names: Record<string, string> = { ...days, Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays' };
  return `${day ? names[day] ?? day : 'Daily'} ${times.join(', ')} ET`;
}

export function jobHealth(job: Job, now = Date.now()): JobHealth {
  const base = { id: job.id, label: job.label, group: job.group, schedule: schedule(job) };
  const file = path.join(LOG_DIR, job.log);

  if (job.format === 'activity') {
    let mtime: number | null = null;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* no log */ }
    if (mtime == null) return { ...base, status: 'no_log', last_run: null, last_good: null, failures_in_a_row: 0, hours_since_start: null, recent: [] };
    const iso = new Date(mtime).toISOString();
    const h = hoursSince(iso, now);
    const run: Run = { started: iso, finished: iso, ok: true, result: 'last activity' };
    return { ...base, status: h != null && h > job.expectH ? 'overdue' : 'ok', last_run: run, last_good: iso, failures_in_a_row: 0, hours_since_start: h, recent: [] };
  }

  const text = readTail(file);
  if (text == null) return { ...base, status: 'no_log', last_run: null, last_good: null, failures_in_a_row: 0, hours_since_start: null, recent: [] };
  const runs = job.format === 'weekly' ? parseWeekly(text) : job.format === 'email' ? parseEmail(text) : parseMarker(text);

  // A run still open past its longest plausible runtime has died (killed, OOM, reboot).
  const last = runs[runs.length - 1];
  if (last && last.ok === null && last.result === 'running' && (hoursSince(last.started, now) ?? 0) > job.maxRunH) {
    last.ok = false; last.result = 'did not finish';
  }
  const finishedRuns = runs.filter(r => r.ok !== null);
  let failuresInARow = 0;
  for (let i = finishedRuns.length - 1; i >= 0 && finishedRuns[i].ok === false; i--) failuresInARow++;
  const lastGood = [...finishedRuns].reverse().find(r => r.ok)?.finished ?? null;
  const lastStart = [...runs].reverse().find(r => r.started)?.started ?? null;
  const h = hoursSince(lastStart, now);
  const lastFinished = finishedRuns[finishedRuns.length - 1];

  let status: JobHealth['status'] = 'ok';
  if (!last) status = 'overdue';
  else if (last.ok === null) status = 'running';
  else if (lastFinished && lastFinished.ok === false) status = 'failed';
  else if (lastFinished && /status=(?!ok)/.test(lastFinished.result)) status = 'warn';
  if (status !== 'failed' && status !== 'running' && (h == null || h > job.expectH)) status = 'overdue';
  // Backups report status=local_only / degraded with exit 0 — a warning, not a failure.
  if (last && last.ok === false && /status=(local_only|degraded)/.test(last.result)) status = 'warn';

  return {
    ...base, status,
    last_run: last ?? null,
    last_good: lastGood,
    failures_in_a_row: failuresInARow,
    hours_since_start: h,
    recent: runs.filter(r => r.result !== 'unknown').slice(-14).reverse(),
  };
}

export function registerCollectorHealthRoutes(app: Express) {
  // Uncached on purpose: the point is to see a failure the same hour.
  app.get('/api/qc/collectors', (_req, res) => {
    const now = Date.now();
    const jobs = JOBS.map(j => jobHealth(j, now));
    const anyLog = jobs.some(j => j.status !== 'no_log');
    res.json({
      active: anyLog,
      generated_at: new Date(now).toISOString(),
      failing: jobs.filter(j => j.status === 'failed' || j.status === 'overdue').length,
      jobs,
    });
  });
}
