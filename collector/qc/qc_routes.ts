/**
 * QC: every dashboard GET endpoint, plus cross-screen consistency.
 *
 * Mounts the REAL routes (registerRoutes, without the login middleware) on a
 * private 127.0.0.1 port against a COPY of the database given in AMO_DB_PATH.
 * Production's server, port and database are never touched, and no password is
 * used. Writes qc_routes.json and qc_routes.md to the directory in argv[2].
 *
 *   AMO_DB_PATH=/tmp/qc_copy.db npx tsx collector/qc/qc_routes.ts OUT_DIR
 */
import express from 'express';
import { createServer } from 'http';
import { writeFileSync } from 'fs';
import { registerRoutes } from '../../server/routes';

const OUT = process.argv[2] || '/tmp/qc';
const PORT = 5098;
type Item = { section: string; check: string; severity: 'FAIL' | 'WARN' | 'OK' | 'INFO'; summary: string; detail?: string[] };
const report: Item[] = [];
const add = (i: Item) => { report.push(i); console.log(`[${i.severity.padEnd(4)}] ${i.section} :: ${i.check} — ${i.summary}`); };

async function get(path: string, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* CSV or HTML */ }
    return { status: r.status, ms: Date.now() - t0, text, json };
  } catch (e: any) {
    return { status: 0, ms: Date.now() - t0, text: String(e?.message || e), json: null };
  }
}
// Data rows in a CSV, honouring quoted fields. Counting '\n' overstated the
// Reporting export by 12 and UCC by 9 on the trial run: addresses carry line
// breaks inside quotes, so one record spanned several lines.
function csvRows(t: string): number {
  let inQuotes = false, records = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') {
      if (inQuotes && t[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === '\n' && !inQuotes) {
      records++;
    }
  }
  if (t.length && !t.endsWith('\n')) records++;
  return Math.max(0, records - 1);                       // minus the header
}
const enc = encodeURIComponent;

(async () => {
  const app = express();
  app.use(express.json());
  const srv = createServer(app);
  await registerRoutes(srv, app);
  srv.listen(PORT, '127.0.0.1', async () => {
    const S = 'G. Dashboard';
    try {
      // ── every endpoint answers ────────────────────────────────────────────
      const fac = await get('/api/credit-facility-events/facilities?limit=1');
      const f0 = fac.json?.rows?.[0] || {};
      const endpoints: string[] = [
        '/api/cache/stats', '/api/stats', '/api/monthly-volume', '/api/top-assignors', '/api/top-assignees',
        '/api/assignments?limit=5', '/api/entities?limit=5', '/api/flow-matrix', '/api/search?q=WELLS',
        `/api/entity/${enc('WELLS FARGO')}`, `/api/entity/${enc('WELLS FARGO')}/sub-entities`,
        '/api/collection-log', '/api/private-credit?limit=5', '/api/private-credit/top-grantees',
        '/api/network-stats', '/api/network-graph', '/api/clean-events?limit=5',
        '/api/credit-facility-events?limit=5', '/api/credit-facility-events/facilities?limit=5',
        `/api/credit-facility-events/filings?lender=${enc(f0.lender_key || '')}&borrower=${enc(f0.borrower_key || '')}`,
        `/api/credit-facility-events/family?lender=${enc(f0.lender_key || '')}&parent=${enc(f0.borrower_parent || '')}`,
        '/api/credit-facility-events/chart?type=monthly', '/api/entity-nodes?limit=5', '/api/fdic/financials',
        '/api/targets', '/api/aliases', '/api/aliases/suggestions',
        `/api/reporting/entity-report?entities=${enc('WELLS FARGO')}`, '/api/reporting?limit=5',
        '/api/reporting/export', `/api/reporting/export-report?entities=${enc('WELLS FARGO')}`,
        '/api/reporting/participants', '/api/reporting/chart?type=monthly', '/api/ucc?limit=5',
        '/api/ucc/parties', '/api/ucc/chart', '/api/ucc/export',
      ];
      const failures: string[] = [];
      const slow: string[] = [];
      for (const ep of endpoints) {
        const r = await get(ep, ep.includes('fdic') ? 90000 : 60000);
        if (r.status !== 200) failures.push(`${ep} → HTTP ${r.status} ${r.text.slice(0, 120)}`);
        if (r.ms > 8000) slow.push(`${ep} ${(r.ms / 1000).toFixed(1)}s`);
      }
      add({ section: S, check: `all ${endpoints.length} endpoints respond`, severity: failures.length ? 'FAIL' : 'OK',
            summary: `${endpoints.length - failures.length} of ${endpoints.length} returned HTTP 200`, detail: failures });
      add({ section: S, check: 'slow endpoints (> 8 s, uncached)', severity: slow.length ? 'WARN' : 'OK',
            summary: `${slow.length} slow`, detail: slow });

      // ── every county scope ────────────────────────────────────────────────
      const scopeFail: string[] = [];
      for (const county of ['MIAMI-DADE', 'BROWARD', 'ALL']) {
        for (const ep of ['/api/stats', '/api/reporting?limit=5', '/api/clean-events?limit=5', '/api/reporting/chart?type=monthly']) {
          const r = await get(`${ep}${ep.includes('?') ? '&' : '?'}county=${county}`);
          if (r.status !== 200) scopeFail.push(`${ep} county=${county} → ${r.status}`);
        }
      }
      add({ section: S, check: 'county scopes (Miami-Dade / Broward / All)', severity: scopeFail.length ? 'FAIL' : 'OK',
            summary: scopeFail.length ? `${scopeFail.length} failures` : 'all scopes respond', detail: scopeFail });

      // ── the same number on different screens ──────────────────────────────
      for (const county of ['MIAMI-DADE', 'ALL']) {
        const table = await get(`/api/reporting?limit=1&county=${county}`);
        const chart = await get(`/api/reporting/chart?type=monthly&county=${county}`);
        const exp = await get(`/api/reporting/export?county=${county}`);
        const t = table.json?.total;
        const c = Array.isArray(chart.json) ? chart.json.reduce((a: number, r: any) => a + (r.count || 0), 0) : NaN;
        const e = csvRows(exp.text);
        const agree = t === c && t === e;
        add({ section: S, check: `Reporting table = chart = CSV export (${county})`, severity: agree ? 'OK' : 'FAIL',
              summary: `table ${t}, chart ${c}, export ${e}` });
      }
      const clean = await get('/api/clean-events?limit=1&county=ALL');
      const stats = await get('/api/stats?county=ALL');
      add({ section: S, check: 'Clean Transactions total = Overview clean total',
            severity: clean.json?.total === stats.json?.clean_total ? 'OK' : 'WARN',
            summary: `clean-events ${clean.json?.total}, overview clean_total ${stats.json?.clean_total}` });
      const ucc = await get('/api/ucc?limit=1');
      const uccExp = await get('/api/ucc/export');
      add({ section: S, check: 'UCC table = UCC CSV export', severity: ucc.json?.total === csvRows(uccExp.text) ? 'OK' : 'WARN',
            summary: `table ${ucc.json?.total}, export ${csvRows(uccExp.text)}` });
      const er = await get(`/api/reporting/entity-report?entities=${enc('WELLS FARGO')}`);
      const k = er.json?.kpis || {};
      add({ section: S, check: 'entity report adds up (Wells Fargo)',
            severity: k.total >= Math.max(k.inbound || 0, k.outbound || 0) && k.dollar_volume >= 0 ? 'OK' : 'FAIL',
            summary: `total ${k.total}, bought ${k.inbound}, sold ${k.outbound}, $ volume (est.) ${Math.round((k.dollar_volume || 0) / 1e6)}M` });
    } catch (e: any) {
      add({ section: S, check: 'route audit', severity: 'FAIL', summary: `crashed: ${e?.message || e}` });
    }
    srv.close();
    writeFileSync(`${OUT}/qc_routes.json`, JSON.stringify(report, null, 1));
    writeFileSync(`${OUT}/qc_routes.md`, `## G. Dashboard\n\n` + report.map(r =>
      `- **[${r.severity}] ${r.check}** — ${r.summary}\n` + (r.detail || []).map(d => `    - ${d}`).join('\n')).join('\n') + '\n');
    console.log(`wrote ${OUT}/qc_routes.md`);
    process.exit(0);
  });
})();
