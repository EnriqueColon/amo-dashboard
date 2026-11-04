/**
 * FDIC section of the entity profile card (docs/REPORTING_FEED_PLAN.md step 3).
 *
 * Links one of our canonical firm names (e.g. "WELLS FARGO") to an FDIC
 * certificate number, then reads that bank's latest Bank Stress score and key
 * FDIC figures from bank_stress.db.
 *
 * WHY NOT fdic_institution_cache: normalize.py stores the FDIC list keyed by our
 * canonical name with INSERT OR IGNORE, so when several FDIC charters clean up
 * to the same name it keeps an arbitrary one. Checked on production 4 Nov 2026:
 * US BANK -> Focus Bank, WELLS FARGO -> Wells Fargo National Bank West,
 * JPMORGAN CHASE -> a Dearborn charter, BANK OF AMERICA -> First National Bank
 * of America. Fine for "is this a bank" (its only use there), wrong for "which
 * bank". bank_entity_link in bank_stress.db is seeded from the same cache.
 *
 * Matching here: every active FDIC institution whose cleaned name equals the
 * firm's cleaned name, or starts with it followed by a word ("WELLS FARGO" ->
 * "WELLS FARGO BANK"). Exact matches rank first, then by total assets. The top
 * candidate is only a SUGGESTION; a person confirms it, picks another, or marks
 * the firm as not an FDIC bank. Those decisions live in entity_fdic_links in
 * the main database and always win.
 */
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { openBankStressDb } from './bank-stress'

const SUFFIX = / (NATIONAL ASSOCIATION|NATIONAL ASSN|NATL ASSN|N A|NA|FSB|F S B|SSB|INC|CO|COMPANY|CORP|CORPORATION|LLC)$/

export function normBankName(s: string): string {
  let x = (s || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,'’]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  x = x.replace(/^THE /, '').replace(/\bU S\b/g, 'US')
  while (SUFFIX.test(x)) x = x.replace(SUFFIX, '').trim()
  return x
}

type Inst = { cert: number; name: string; city: string | null; state: string | null; assets_k: number | null; hc_name: string | null; norm: string }
let instCache: { at: number; rows: Inst[] } | null = null

function institutions(bs: Database.Database): Inst[] {
  if (instCache && Date.now() - instCache.at < 6 * 3600_000) return instCache.rows
  const rows = (bs.prepare(`SELECT CERT AS cert, NAME AS name, CITY AS city, STALP AS state, ASSET AS assets_k, NAMEHCR AS hc_name
                             FROM fdic_institutions WHERE ACTIVE = 1`).all() as Omit<Inst, 'norm'>[])
    .map(r => ({ ...r, norm: normBankName(r.name) }))
  instCache = { at: Date.now(), rows }
  return rows
}

export function fdicCandidates(bs: Database.Database, entity: string) {
  const n = normBankName(entity)
  if (n.length < 3) return []
  return institutions(bs)
    .filter(i => i.norm === n || i.norm.startsWith(n + ' '))
    .map(i => ({ ...i, exact: i.norm === n }))
    .sort((a, b) => (Number(b.exact) - Number(a.exact)) || ((b.assets_k ?? 0) - (a.assets_k ?? 0)))
}

function ensureTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS entity_fdic_links (
    entity    TEXT PRIMARY KEY,
    cert      INTEGER,            -- NULL when status = 'not_bank'
    status    TEXT NOT NULL,      -- 'confirmed' | 'not_bank'
    linked_at TEXT NOT NULL
  )`)
}

function bankSummary(bs: Database.Database, cert: number) {
  const inst = institutions(bs).find(i => i.cert === cert)
  const score = bs.prepare(`
    SELECT s.repdte, s.composite, s.tier, s.rank, s.cohort_size, s.peer_band, s.flag_count, s.excluded_reason,
           s.assets_k, m.tier1_leverage, m.cre_concentration, m.noncurrent_ratio, m.roa, m.loan_to_deposit,
           m.uninsured_share, m.hc_name
    FROM bank_scores s LEFT JOIN bank_metrics m ON m.cert = s.cert AND m.repdte = s.repdte
    WHERE s.cert = ? ORDER BY s.repdte DESC LIMIT 1`).get(cert) as Record<string, unknown> | undefined
  if (!inst && !score) return null
  return {
    cert,
    name: inst?.name ?? null,
    city: inst?.city ?? null,
    state: inst?.state ?? null,
    hc_name: (score?.hc_name as string) || inst?.hc_name || null,
    assets_k: (score?.assets_k as number) ?? inst?.assets_k ?? null,
    score: score ?? null,
  }
}

export function registerEntityFdicRoutes(app: Express) {
  const db = getDb()
  ensureTable(db)

  app.get('/api/entity/:name/fdic', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    if (!entity) return res.status(400).json({ error: 'name required' })
    const bs = openBankStressDb()
    if (!bs) return res.json({ status: 'unavailable' })

    const link = db.prepare(`SELECT cert, status, linked_at FROM entity_fdic_links WHERE entity = ?`).get(entity) as
      { cert: number | null; status: string; linked_at: string } | undefined
    const cands = fdicCandidates(bs, entity)
    const candidates = cands.slice(0, 8).map(({ norm, ...c }) => c)

    if (link?.status === 'not_bank') return res.json({ status: 'not_bank', linked_at: link.linked_at, candidates })
    if (link?.status === 'confirmed' && link.cert != null) {
      return res.json({ status: 'confirmed', cert: link.cert, linked_at: link.linked_at, candidates, bank: bankSummary(bs, link.cert) })
    }
    if (!cands.length) return res.json({ status: 'no_match', candidates: [] })
    const top = cands[0]
    const basis = top.exact
      ? (cands.filter(c => c.exact).length === 1 ? 'exact name' : `largest of ${cands.filter(c => c.exact).length} banks with this exact name`)
      : cands.length === 1 ? 'the only bank whose name starts with this one'
      : `largest of ${cands.length} banks whose name starts with this one`
    res.json({ status: 'suggested', cert: top.cert, basis, candidates, bank: bankSummary(bs, top.cert) })
  })

  // Body: { cert: number } to confirm a bank, or { not_bank: true }.
  app.put('/api/entity/:name/fdic', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    const body = (req.body ?? {}) as { cert?: unknown; not_bank?: unknown }
    const now = new Date().toISOString()
    if (body.not_bank === true) {
      db.prepare(`INSERT INTO entity_fdic_links (entity, cert, status, linked_at) VALUES (?, NULL, 'not_bank', ?)
                  ON CONFLICT(entity) DO UPDATE SET cert = NULL, status = 'not_bank', linked_at = excluded.linked_at`).run(entity, now)
      return res.json({ ok: true })
    }
    const cert = Number(body.cert)
    if (!entity || !Number.isInteger(cert) || cert <= 0) return res.status(400).json({ error: 'cert (positive integer) or not_bank required' })
    const bs = openBankStressDb()
    if (bs && !institutions(bs).some(i => i.cert === cert)) return res.status(400).json({ error: `cert ${cert} is not an active FDIC institution` })
    db.prepare(`INSERT INTO entity_fdic_links (entity, cert, status, linked_at) VALUES (?, ?, 'confirmed', ?)
                ON CONFLICT(entity) DO UPDATE SET cert = excluded.cert, status = 'confirmed', linked_at = excluded.linked_at`).run(entity, cert, now)
    res.json({ ok: true })
  })

  // Back to the automatic suggestion.
  app.delete('/api/entity/:name/fdic', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    db.prepare(`DELETE FROM entity_fdic_links WHERE entity = ?`).run(entity)
    res.json({ ok: true })
  })
}
