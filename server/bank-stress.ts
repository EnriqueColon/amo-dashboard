/**
 * Bank Stress Ranking — read-only API over bank_stress.db.
 *
 * The data is produced by collector/bank_stress (FDIC pull → metrics →
 * scoring, weekly cron). This module only reads: it opens the file read-only,
 * never touches miami_dade_amo.db, and keys its cache on the compute
 * timestamp so a new weekly run is visible without a restart or a cache bust.
 *
 * Path rule (same as collector/bank_stress/db.py):
 *   AMO_BANK_STRESS_DB_PATH, else bank_stress.db next to AMO_DB_PATH, else
 *   ./bank_stress.db. A missing file answers 503 with a plain message — the
 *   page renders "not computed yet" and no figures.
 *
 * Endpoints (all behind checkAuth, registered from routes.ts):
 *   GET /api/bank-stress/meta
 *   GET /api/bank-stress/ranking?quarter&band&states=FL,GA&min_score&tier&cre_only=1&include_excluded=1&search
 *   GET /api/bank-stress/bank/:cert
 */

import type { Express, Request, Response } from 'express'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getCached, setCached, makeCacheKey, DEFAULT_TTL_MS } from './cache'

export function bankStressDbPath(): string {
  const explicit = (process.env.AMO_BANK_STRESS_DB_PATH ?? '').trim()
  if (explicit) return explicit
  const amo = (process.env.AMO_DB_PATH ?? '').trim()
  if (amo) return path.join(path.dirname(path.resolve(amo)), 'bank_stress.db')
  return path.resolve(process.cwd(), 'bank_stress.db')
}

let _db: Database.Database | null = null

function openDb(): Database.Database | null {
  if (_db) return _db
  const p = bankStressDbPath()
  if (!fs.existsSync(p)) return null
  _db = new Database(p, { readonly: true, fileMustExist: true })
  return _db
}

/** Shared with server/fdic-analytics.ts, which reads the same file. */
export function openBankStressDb(): Database.Database | null {
  return openDb()
}

export const BANK_STRESS_MISSING_MESSAGE =
  'Bank stress ranking has not been computed yet — run collector/run_bank_stress.sh (it writes bank_stress.db).'

export function warnIfBankStressMissing(log: (msg: string, source?: string) => void) {
  if (!fs.existsSync(bankStressDbPath())) {
    log(`WARNING: ${bankStressDbPath()} not found — the Bank Stress Ranking page will return 503 until the weekly job has run`, 'bank-stress')
  }
}

type MetaRow = {
  computed_at: string; quarters_json: string; latest_quarter: string; config_json: string;
  definitions_json: string; banks_scored: number; detail: string
}

function latestMeta(db: Database.Database): MetaRow | null {
  try {
    return (db.prepare('SELECT * FROM bank_stress_meta ORDER BY id DESC LIMIT 1').get() as MetaRow | undefined) ?? null
  } catch {
    return null
  }
}

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try { return JSON.parse(json) as T } catch { return fallback }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  const s = str(v)
  if (s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ ok: false, error })
}

/** The columns of bank_metrics shown per bank-quarter (everything except bookkeeping). */
const METRIC_COLUMNS_SQL = `
  m.merger_quarter, m.avg_assets, m.avg_assets_source, m.flow_source, m.twin_mismatches,
  m.q_NETINC, m.q_ELNATR, m.q_NTLNLS, m.q_NETGNSLN, m.q_NETGNSRE, m.q_EQCDIV,
  m.q_NTRECONS, m.q_NTREMULT, m.q_NTRENROT, m.dividends_ttm_k, m.netinc_ttm_k,
  m.roa, m.pretax_roa, m.core_roa, m.nii_ratio, m.funding_cost_ratio, m.wholesale_funding_share,
  m.efficiency_ratio, m.fee_dependence, m.provision_ratio, m.provision_coverage, m.provision_burden,
  m.cre_nco_ratio, m.cre_chargeoff_share, m.dividend_payout, m.retained_earnings_drag,
  m.noncurrent_ratio, m.reserve_coverage, m.tier1_leverage, m.loan_to_deposit, m.cre_concentration,
  m.construction_concentration, m.unrealized_sec_to_equity, m.loan_sale_gains_ratio, m.brokered_share,
  m.uninsured_share, m.cre_loans_k,
  m.roa__yoy, m.core_roa__yoy, m.nii_ratio__yoy, m.nii_ratio__slope, m.funding_cost_ratio__yoy,
  m.funding_cost_ratio__slope, m.provision_ratio__yoy, m.provision_ratio__slope, m.cre_nco_ratio__yoy,
  m.cre_nco_ratio__slope, m.noncurrent_ratio__yoy, m.noncurrent_ratio__slope, m.cre_concentration__yoy,
  m.efficiency_ratio__yoy, m.tier1_leverage__yoy, m.loan_to_deposit__yoy`

function previousQuarter(repdte: string): string {
  const y = Number(repdte.slice(0, 4)), m = Number(repdte.slice(4, 6))
  const q = Math.floor((m - 1) / 3) + 1
  const ends: Record<number, string> = { 1: '0331', 2: '0630', 3: '0930', 4: '1231' }
  return q === 1 ? `${y - 1}1231` : `${y}${ends[q - 1]}`
}

function quartersBack(latest: string, n: number): string[] {
  const out = [latest]
  while (out.length < n) out.push(previousQuarter(out[out.length - 1]))
  return out
}

type HfsPoint = { quarter: string; hfs_k: number | null; hfs_pct: number | null; troubled_k: number | null }

/**
 * Loans held for sale (Call Report RC 4.a, FDIC LNLSSALE) for the newest four
 * quarters, straight from the raw rows: the balance, its share of gross loans,
 * and the troubled part (90+ days past due + nonaccrual within it). The FDIC
 * publishes no breakdown of held-for-sale by loan type, so this is the whole
 * balance; the delinquency lines are the closest proxy for problem loans
 * being readied for sale. Keyed by cert, newest quarter first.
 */
function hfsHistoryByCert(db: Database.Database, latest: string, certs: Set<number>): Map<number, HfsPoint[]> {
  const quarters = quartersBack(latest, 4)
  const rows = db.prepare(`SELECT CERT, REPDTE, LNLSSALE, NALNSALE, P9LNSALE, LNLSGR FROM fdic_financials_raw WHERE REPDTE IN (${quarters.map(() => '?').join(',')})`).all(...quarters) as Array<Record<string, unknown>>
  const byCert = new Map<number, Map<string, Record<string, unknown>>>()
  for (const r of rows) {
    const cert = Number(r.CERT)
    if (!certs.has(cert)) continue
    if (!byCert.has(cert)) byCert.set(cert, new Map())
    byCert.get(cert)!.set(String(r.REPDTE), r)
  }
  const out = new Map<number, HfsPoint[]>()
  for (const cert of Array.from(certs)) {
    const q = byCert.get(cert)
    out.set(cert, quarters.map((repdte) => {
      const r = q?.get(repdte)
      const hfs = typeof r?.LNLSSALE === 'number' ? (r.LNLSSALE as number) : null
      const gross = typeof r?.LNLSGR === 'number' ? (r.LNLSGR as number) : null
      const na = typeof r?.NALNSALE === 'number' ? (r.NALNSALE as number) : null
      const p9 = typeof r?.P9LNSALE === 'number' ? (r.P9LNSALE as number) : null
      return {
        quarter: repdte,
        hfs_k: hfs,
        hfs_pct: hfs != null && gross != null && gross > 0 ? (hfs / gross) * 100 : null,
        troubled_k: na != null && p9 != null ? na + p9 : (na ?? p9),
      }
    }))
  }
  return out
}

function rowToScore(r: Record<string, unknown>) {
  const { flags_json, watch_flags_json, top_drivers_json, components_json, ...rest } = r
  return {
    ...rest,
    flags: parse<string[]>(flags_json as string, []),
    watch_flags: parse<string[]>(watch_flags_json as string, []),
    top_drivers: parse<unknown[]>(top_drivers_json as string, []),
    components: components_json === undefined ? undefined : parse<Record<string, number | null>>(components_json as string, {}),
  }
}

export function registerBankStressRoutes(app: Express) {
  app.get('/api/bank-stress/meta', (_req: Request, res: Response) => {
    const db = openDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const key = makeCacheKey('bank-stress:meta', { v: meta.computed_at })
    const hit = getCached(key)
    if (hit) { res.setHeader('X-BS-Cache', 'HIT'); return res.json(hit) }
    const latest = meta.latest_quarter
    const states = (db.prepare('SELECT DISTINCT state FROM bank_scores WHERE repdte = ? AND state IS NOT NULL ORDER BY state').all(latest) as Array<{ state: string }>).map((r) => r.state)
    const tiers = db.prepare('SELECT tier, COUNT(*) AS n FROM bank_scores WHERE repdte = ? AND rank IS NOT NULL GROUP BY tier').all(latest) as Array<{ tier: string; n: number }>
    const sellers = (db.prepare('SELECT COUNT(*) AS n FROM bank_scores WHERE repdte = ? AND rank IS NOT NULL AND cre_seller_signal = 1').get(latest) as { n: number }).n
    const bands = db.prepare('SELECT peer_band, COUNT(*) AS n FROM bank_scores WHERE repdte = ? AND rank IS NOT NULL GROUP BY peer_band').all(latest) as Array<{ peer_band: string; n: number }>
    const pulls = db.prepare("SELECT MAX(fetched_at) AS fetched_at FROM fdic_financials_raw WHERE REPDTE = ?").get(latest) as { fetched_at: string | null }
    const cfg = parse<Record<string, unknown>>(meta.config_json, {})
    const quarters = parse<string[]>(meta.quarters_json, [])
    const body = {
      ok: true,
      computed_at: meta.computed_at,
      fetched_at: pulls?.fetched_at ?? null,
      latest_quarter: latest,
      quarters: quarters.slice(0, Number(cfg.history_quarters ?? 8)),
      scored_quarters: quarters,
      banks_scored: meta.banks_scored,
      detail: meta.detail,
      states,
      tiers: Object.fromEntries(tiers.map((t) => [t.tier, t.n])),
      band_counts: Object.fromEntries(bands.map((b) => [b.peer_band, b.n])),
      cre_seller_signal_count: sellers,
      definitions: parse(meta.definitions_json, {}),
    }
    setCached(key, body, DEFAULT_TTL_MS)
    res.setHeader('X-BS-Cache', 'MISS')
    res.json(body)
  })

  app.get('/api/bank-stress/ranking', (req: Request, res: Response) => {
    const db = openDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const cfg = parse<{ deal_view?: { cre_concentration_min_pct?: number; cre_loans_min_k?: number } }>(meta.config_json, {})
    const quarter = str(req.query.quarter) ?? meta.latest_quarter
    if (!/^\d{8}$/.test(quarter)) return fail(res, 400, 'quarter must be YYYYMMDD')
    const band = str(req.query.band)
    const states = (str(req.query.states) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s))
    const minScore = num(req.query.min_score)
    const tier = str(req.query.tier)
    const creOnly = str(req.query.cre_only) === '1'
    const includeExcluded = str(req.query.include_excluded) === '1'
    const search = (str(req.query.search) ?? '').trim().toUpperCase().slice(0, 60)
    const sellerOnly = str(req.query.seller_only) === '1'

    const query = { quarter, band, states: states.join(','), min_score: minScore, tier, cre_only: creOnly ? '1' : '', include_excluded: includeExcluded ? '1' : '', search, seller_only: sellerOnly ? '1' : '', v: meta.computed_at }
    const key = makeCacheKey('bank-stress:ranking', query)
    const hit = getCached(key)
    if (hit) { res.setHeader('X-BS-Cache', 'HIT'); return res.json(hit) }

    const where: string[] = ['s.repdte = @quarter']
    const params: Record<string, unknown> = { quarter }
    if (!includeExcluded) where.push('s.rank IS NOT NULL')
    if (band) { where.push('s.peer_band = @band'); params.band = band }
    if (states.length) { where.push(`s.state IN (${states.map((_s, i) => `@st${i}`).join(',')})`); states.forEach((s, i) => { params[`st${i}`] = s }) }
    if (minScore !== undefined) { where.push('s.composite >= @minScore'); params.minScore = minScore }
    if (tier) { where.push('s.tier = @tier'); params.tier = tier }
    if (sellerOnly) where.push('s.cre_seller_signal = 1')
    if (creOnly) {
      where.push('(m.cre_concentration >= @creMin OR m.cre_loans_k >= @creLoansMin)')
      params.creMin = cfg.deal_view?.cre_concentration_min_pct ?? 200
      params.creLoansMin = cfg.deal_view?.cre_loans_min_k ?? 250000
    }
    if (search) {
      where.push('(UPPER(s.name) LIKE @search OR CAST(s.cert AS TEXT) = @searchExact)')
      params.search = `%${search}%`
      params.searchExact = search
    }
    const rows = db.prepare(`
      SELECT s.rank, s.rank_in_band, s.cert, s.name, s.state, s.peer_band, s.assets_k, s.hc_owned, s.excluded_reason,
             s.condition, s.deterioration, s.cre_exposure, s.composite, s.completeness,
             s.flag_count, s.flags_json, s.watch_flags_json, s.tier, s.cre_seller_signal, s.top_drivers_json,
             s.cohort_size, s.band_size,
             m.cre_concentration, m.construction_concentration, m.cre_loans_k, m.noncurrent_ratio, m.tier1_leverage,
             m.roa, m.efficiency_ratio, m.loan_to_deposit, m.reserve_coverage, m.merger_quarter
      FROM bank_scores s
      LEFT JOIN bank_metrics m ON m.cert = s.cert AND m.repdte = s.repdte
      WHERE ${where.join(' AND ')}
      ORDER BY (s.rank IS NULL), s.rank, s.composite DESC
    `).all(params) as Array<Record<string, unknown>>
    const hfs = hfsHistoryByCert(db, quarter, new Set(rows.map((r) => Number(r.cert))))
    const body = { ok: true, quarter, computed_at: meta.computed_at, total: rows.length, rows: rows.map((r) => ({ ...rowToScore(r), hfs_history: hfs.get(Number(r.cert)) ?? [] })) }
    setCached(key, body, DEFAULT_TTL_MS)
    res.setHeader('X-BS-Cache', 'MISS')
    res.json(body)
  })

  app.get('/api/bank-stress/bank/:cert', (req: Request, res: Response) => {
    const db = openDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const cert = String(req.params.cert ?? '').trim()
    if (!/^\d{1,7}$/.test(cert)) return fail(res, 400, 'cert must be a numeric FDIC certificate number')
    const key = makeCacheKey('bank-stress:bank', { cert, v: meta.computed_at })
    const hit = getCached(key)
    if (hit) { res.setHeader('X-BS-Cache', 'HIT'); return res.json(hit) }
    const cfg = parse<{ history_quarters?: number }>(meta.config_json, {})
    const limit = Number(cfg.history_quarters ?? 8)
    const history = db.prepare(`
      SELECT s.repdte, s.peer_band, s.excluded_reason, s.condition, s.deterioration, s.cre_exposure, s.composite,
             s.completeness, s.rank, s.rank_in_band, s.cohort_size, s.band_size, s.flag_count, s.flags_json,
             s.watch_flags_json, s.tier, s.cre_seller_signal, s.top_drivers_json, s.components_json, s.assets_k,
             ${METRIC_COLUMNS_SQL}
      FROM bank_scores s
      LEFT JOIN bank_metrics m ON m.cert = s.cert AND m.repdte = s.repdte
      WHERE s.cert = ?
      ORDER BY s.repdte DESC
      LIMIT ?
    `).all(Number(cert), limit) as Array<Record<string, unknown>>
    if (!history.length) return fail(res, 404, `no scored quarters for cert ${cert}`)
    const latest = db.prepare('SELECT cert, name, state, hc_name, hc_owned, estymd, cblr, assets_k, rssdhcr FROM bank_metrics WHERE cert = ? ORDER BY repdte DESC LIMIT 1').get(Number(cert)) as Record<string, unknown>
    const inst = db.prepare('SELECT CITY AS city, BKCLASS AS bkclass, ACTIVE AS active FROM fdic_institutions WHERE CERT = ?').get(Number(cert)) as Record<string, unknown> | undefined
    const failure = db.prepare('SELECT FAILDATE AS faildate, RESTYPE AS restype FROM fdic_failures WHERE CERT = ? ORDER BY FAILDATE DESC LIMIT 1').get(Number(cert)) as Record<string, unknown> | undefined
    const links = (db.prepare('SELECT canonical_name FROM bank_entity_link WHERE cert = ?').all(Number(cert)) as Array<{ canonical_name: string }>).map((r) => r.canonical_name)
    // Loans held for sale per quarter (balance, % of gross loans, troubled part) from the raw rows.
    const hfsRaw = new Map<string, Record<string, unknown>>()
    for (const r of db.prepare('SELECT REPDTE, LNLSSALE, NALNSALE, P9LNSALE, LNLSGR FROM fdic_financials_raw WHERE CERT = ?').all(Number(cert)) as Array<Record<string, unknown>>) hfsRaw.set(String(r.REPDTE), r)
    const withHfs = (h: Record<string, unknown>) => {
      const r = hfsRaw.get(String(h.repdte))
      const hfs = typeof r?.LNLSSALE === 'number' ? (r.LNLSSALE as number) : null
      const gross = typeof r?.LNLSGR === 'number' ? (r.LNLSGR as number) : null
      const na = typeof r?.NALNSALE === 'number' ? (r.NALNSALE as number) : null
      const p9 = typeof r?.P9LNSALE === 'number' ? (r.P9LNSALE as number) : null
      return { ...h, hfs_k: hfs, hfs_pct: hfs != null && gross != null && gross > 0 ? (hfs / gross) * 100 : null, hfs_troubled_k: na != null && p9 != null ? na + p9 : (na ?? p9) }
    }
    const body = {
      ok: true,
      computed_at: meta.computed_at,
      bank: { ...latest, ...(inst ?? {}) },
      failure: failure ?? null,
      aom_canonical_names: links,
      history: history.map(rowToScore).map(withHfs).reverse(), // oldest → newest for charts
    }
    setCached(key, body, DEFAULT_TTL_MS)
    res.setHeader('X-BS-Cache', 'MISS')
    res.json(body)
  })
}
