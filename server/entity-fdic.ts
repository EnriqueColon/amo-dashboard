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
let instCache: { at: number; rows: Inst[]; byFirstWord: Map<string, Inst[]> } | null = null

function loadInstitutions(bs: Database.Database) {
  if (instCache && Date.now() - instCache.at < 6 * 3600_000) return instCache
  const rows = (bs.prepare(`SELECT CERT AS cert, NAME AS name, CITY AS city, STALP AS state, ASSET AS assets_k, NAMEHCR AS hc_name
                             FROM fdic_institutions WHERE ACTIVE = 1`).all() as Omit<Inst, 'norm'>[])
    .map(r => ({ ...r, norm: normBankName(r.name) }))
  // A candidate's name starts with the firm's name, so it shares its first word.
  const byFirstWord = new Map<string, Inst[]>()
  for (const r of rows) {
    const w = r.norm.split(' ')[0]
    const list = byFirstWord.get(w)
    if (list) list.push(r); else byFirstWord.set(w, [r])
  }
  instCache = { at: Date.now(), rows, byFirstWord }
  return instCache
}

function institutions(bs: Database.Database): Inst[] {
  return loadInstitutions(bs).rows
}

export function fdicCandidates(bs: Database.Database, entity: string) {
  const n = normBankName(entity)
  if (n.length < 3) return []
  return (loadInstitutions(bs).byFirstWord.get(n.split(' ')[0]) ?? [])
    .filter(i => i.norm === n || i.norm.startsWith(n + ' '))
    .map(i => ({ ...i, exact: i.norm === n }))
    .sort((a, b) => (Number(b.exact) - Number(a.exact)) || ((b.assets_k ?? 0) - (a.assets_k ?? 0)))
}

/**
 * The charter a firm points at (saved decision, else top suggestion) and its
 * holding company as FDIC writes it. Used by server/entity-sec.ts to find a
 * bank's listed parent (Citibank -> Citigroup). null when none.
 */
export function fdicHoldingCompany(entity: string): { cert: number; hc_name: string | null } | null {
  const bs = openBankStressDb()
  if (!bs) return null
  const db = getDb()
  ensureTable(db)
  const s = db.prepare(`SELECT cert, status FROM entity_fdic_links WHERE entity = ?`).get(entity) as { cert: number | null; status: string } | undefined
  const cert = s ? (s.status === 'confirmed' ? s.cert : null) : (fdicCandidates(bs, entity)[0]?.cert ?? null)
  if (cert == null) return null
  const inst = institutions(bs).find(i => i.cert === cert)
  return { cert, hc_name: inst?.hc_name ?? null }
}

// Reverse lookup for the Bank Stress card's "In the county filings as" note:
// which of our firm names point at this charter. Same rules as the profile card
// (a saved decision wins, otherwise the top suggestion), over every firm typed
// BANK plus every firm linked by hand. Built once and cached; any link change
// clears it. Replaces bank_entity_link, which inherits fdic_institution_cache's
// arbitrary picks (US BANK -> Focus Bank).
let reverseCache: { at: number; byCert: Map<number, string[]> } | null = null

export function countyNamesForCert(bs: Database.Database, cert: number): string[] {
  if (!reverseCache || Date.now() - reverseCache.at > 6 * 3600_000) {
    const db = getDb()
    ensureTable(db)
    const saved = new Map<string, { cert: number | null; status: string }>()
    for (const r of db.prepare(`SELECT entity, cert, status FROM entity_fdic_links`).all() as any[]) saved.set(r.entity, r)
    const names = new Set<string>(saved.keys())
    for (const r of db.prepare(`SELECT entity FROM entity_nodes WHERE entity_type = 'BANK'`).all() as { entity: string }[]) names.add(r.entity)
    const byCert = new Map<number, string[]>()
    for (const name of names) {
      const s = saved.get(name)
      const c = s ? (s.status === 'confirmed' ? s.cert : null) : (fdicCandidates(bs, name)[0]?.cert ?? null)
      if (c == null) continue
      const list = byCert.get(c)
      if (list) list.push(name); else byCert.set(c, [name])
    }
    reverseCache = { at: Date.now(), byCert }
  }
  return reverseCache.byCert.get(cert) ?? []
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
      reverseCache = null
      db.prepare(`INSERT INTO entity_fdic_links (entity, cert, status, linked_at) VALUES (?, NULL, 'not_bank', ?)
                  ON CONFLICT(entity) DO UPDATE SET cert = NULL, status = 'not_bank', linked_at = excluded.linked_at`).run(entity, now)
      return res.json({ ok: true })
    }
    const cert = Number(body.cert)
    if (!entity || !Number.isInteger(cert) || cert <= 0) return res.status(400).json({ error: 'cert (positive integer) or not_bank required' })
    const bs = openBankStressDb()
    if (bs && !institutions(bs).some(i => i.cert === cert)) return res.status(400).json({ error: `cert ${cert} is not an active FDIC institution` })
    reverseCache = null
    db.prepare(`INSERT INTO entity_fdic_links (entity, cert, status, linked_at) VALUES (?, ?, 'confirmed', ?)
                ON CONFLICT(entity) DO UPDATE SET cert = excluded.cert, status = 'confirmed', linked_at = excluded.linked_at`).run(entity, cert, now)
    res.json({ ok: true })
  })

  // Back to the automatic suggestion.
  app.delete('/api/entity/:name/fdic', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    reverseCache = null
    db.prepare(`DELETE FROM entity_fdic_links WHERE entity = ?`).run(entity)
    res.json({ ok: true })
  })
}
