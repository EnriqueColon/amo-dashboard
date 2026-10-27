/**
 * FDIC Data Analytics — served from our own FDIC tables (stage 2, 27 Oct 2026).
 *
 * Until this module the page read the Market Intelligence tool's API through
 * /api/mi/*. It now reads bank_stress.db — the raw Call Report rows, metrics
 * and scores that collector/bank_stress pulls straight from the FDIC every
 * week — and answers under /api/fdic/* with the SAME envelope and payload
 * shapes the page already renders, so the client only changed its paths, its
 * score columns and its labels. The Market Intelligence proxy stays in place
 * until this is verified in production; nothing here calls it.
 *
 * Units follow the old contract exactly (client/src/lib/market-intelligence.ts):
 *   nplRatio, noncurrent_to_*_ratio, pastDue*, loanLossReserve  fractions
 *   creConcentration, cet1Ratio, leverageRatio, roa, nim        percents
 *   dollar fields on rows                                       dollars (Call Report $K × 1000)
 *   scores                                                      percentile ranks 0–100, higher = more stress
 *
 * Definitions that differ from the Market Intelligence version, on purpose:
 *   CRE loans = construction + multifamily + NON-owner-occupied nonfarm
 *   nonresidential (the interagency definition, the owner's 27 Oct decision);
 *   the three Market Intelligence scores are replaced by the Bank Stress
 *   Ranking's composite and sub-scores; National is every ranked bank
 *   (≈4,300), not Market Intelligence's ~1,100-bank screen.
 *
 * Acquisition history is the one thing not in our tables: it is fetched live
 * from the FDIC /history endpoint (public, no key) and cached for 7 days.
 */

import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getCached, setCached, makeCacheKey, DEFAULT_TTL_MS } from './cache'
import { openBankStressDb, BANK_STRESS_MISSING_MESSAGE } from './bank-stress'

const CONTRACT_VERSION = 'amo-fdic-2026-10-27'
const SOURCE = 'FDIC BankFind API, pulled weekly by collector/bank_stress'
const NATIONAL = 'National'
const FDIC_HISTORY_URL = 'https://api.fdic.gov/banks/history'
const HISTORY_TIMEOUT_MS = 20_000

type Row = Record<string, any>

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ ok: false, error })
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function dollars(k: unknown): number | undefined {
  const n = num(k)
  return n == null ? undefined : n * 1000
}

function frac(numer: unknown, denom: unknown): number | undefined {
  const a = num(numer), b = num(denom)
  return a == null || b == null || b <= 0 ? undefined : a / b
}

function pct(numer: unknown, denom: unknown): number | undefined {
  const f = frac(numer, denom)
  return f == null ? undefined : f * 100
}

function titleCase(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function quarterLabel(repdte: string): string {
  const q = Math.floor((Number(repdte.slice(4, 6)) - 1) / 3) + 1
  return `Q${q} ${repdte.slice(0, 4)}`
}

function parse<T>(json: unknown, fallback: T): T {
  if (typeof json !== 'string' || !json) return fallback
  try { return JSON.parse(json) as T } catch { return fallback }
}

// ── capital classification (PCA thresholds) ─────────────────────────────────

type CapitalCategory = { category: string; label: string; binding: string; basis: string }

function classifyCapital(r: Row): CapitalCategory | undefined {
  const lev = num(r.RBC1AAJ)
  if (lev == null) return undefined
  const cblr = r.CBLRIND === 1
  if (cblr) {
    if (lev >= 9) return { category: 'well', label: 'Well capitalized (CBLR)', binding: `Leverage ${lev.toFixed(1)}% ≥ 9%`, basis: 'leverage' }
    if (lev >= 8) return { category: 'adequate', label: 'CBLR grace period', binding: `Leverage ${lev.toFixed(1)}% < 9%`, basis: 'leverage' }
    return { category: 'under', label: 'Below CBLR minimum', binding: `Leverage ${lev.toFixed(1)}% < 8%`, basis: 'leverage' }
  }
  const cet1 = num(r.RBCT1CER), t1 = num(r.RBC1RWAJ), total = num(r.RBCRWAJ)
  if (cet1 == null || t1 == null || total == null) {
    return { category: lev >= 5 ? 'well' : lev >= 4 ? 'adequate' : 'under', label: lev >= 5 ? 'Well capitalized (leverage)' : lev >= 4 ? 'Adequately capitalized (leverage)' : 'Undercapitalized (leverage)', binding: `Leverage ${lev.toFixed(1)}%`, basis: 'leverage' }
  }
  const well = { lev: 5, cet1: 6.5, t1: 8, total: 10 }
  const adequate = { lev: 4, cet1: 4.5, t1: 6, total: 8 }
  const headroom = [
    { name: 'Leverage', v: lev, min: well.lev },
    { name: 'CET1', v: cet1, min: well.cet1 },
    { name: 'Tier 1 RBC', v: t1, min: well.t1 },
    { name: 'Total RBC', v: total, min: well.total },
  ].sort((a, b) => (a.v - a.min) - (b.v - b.min))[0]
  const binding = `${headroom.name} ${headroom.v.toFixed(1)}% vs ${headroom.min}% well-capitalized floor`
  if (lev >= well.lev && cet1 >= well.cet1 && t1 >= well.t1 && total >= well.total) return { category: 'well', label: 'Well capitalized', binding, basis: 'cet1' }
  if (lev >= adequate.lev && cet1 >= adequate.cet1 && t1 >= adequate.t1 && total >= adequate.total) return { category: 'adequate', label: 'Adequately capitalized', binding, basis: 'cet1' }
  if (lev < 3 || cet1 < 3 || t1 < 4 || total < 6) return { category: 'significant', label: 'Significantly undercapitalized', binding, basis: 'cet1' }
  return { category: 'under', label: 'Undercapitalized', binding, basis: 'cet1' }
}

// ── data access ─────────────────────────────────────────────────────────────

type Meta = { computed_at: string; latest_quarter: string; quarters_json: string; config_json: string; definitions_json: string }

function latestMeta(db: Database.Database): Meta | null {
  try { return (db.prepare('SELECT * FROM bank_stress_meta ORDER BY id DESC LIMIT 1').get() as Meta | undefined) ?? null } catch { return null }
}

function stamp(meta: Meta, quarter: string, scope: string) {
  return { quarter, scope, contractVersion: CONTRACT_VERSION, servedAt: new Date().toISOString(), computedAt: meta.computed_at }
}

/** The states present in the latest quarter: code → title-cased name. */
function stateScopes(db: Database.Database, quarter: string): Record<string, string> {
  const rows = db.prepare('SELECT DISTINCT STALP, STNAME FROM fdic_financials_raw WHERE REPDTE = ? AND STALP IS NOT NULL ORDER BY STALP').all(quarter) as Array<{ STALP: string; STNAME: string | null }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.STALP] = titleCase(r.STNAME) ?? r.STALP
  return out
}

/** "Florida" | "FL" | "National" → { stalp | null, display } or null when unknown. */
function resolveScope(states: Record<string, string>, scope: string): { stalp: string | null; display: string } | null {
  const s = scope.trim()
  if (!s || s.toLowerCase() === NATIONAL.toLowerCase() || s === 'United States') return { stalp: null, display: NATIONAL }
  const upper = s.toUpperCase()
  if (states[upper]) return { stalp: upper, display: states[upper] }
  for (const [code, name] of Object.entries(states)) if (name.toUpperCase() === upper) return { stalp: code, display: name }
  return null
}

const RAW_COLS = `r.CERT, r.NAME, r.CITY, r.STNAME, r.STALP, r.REPDTE, r.ASSET, r.LNLSNET, r.LNLSGR, r.DEP, r.EQ, r.LNATRES, r.NCLNLS,
  r.NALNLS, r.P3ASSET, r.P9ASSET, r.LNRECONS, r.LNREMULT, r.LNRENRES, r.LNRENROW, r.LNRENROT, r.RBC1AAJ, r.RBCT1CER, r.RBC1RWAJ,
  r.RBCRWAJ, r.RBCT1J, r.RBCT2, r.CBLRIND, r.UCLN, r.UCCOMRE, r.NIMR, r.ROA`

function creK(r: Row): number | null {
  const a = num(r.LNRECONS), b = num(r.LNREMULT), c = num(r.LNRENROT)
  return a == null || b == null || c == null ? null : a + b + c
}

function screeningRow(r: Row, m: Row | undefined, s: Row | undefined, trend: Array<{ reportDate: string; creConcentration?: number; nplRatio?: number }>, priorNimr: number | null, priorTtm: number | null) {
  const cre = creK(r)
  const t1t2 = num(r.RBCT1J) != null ? (num(r.RBCT1J) as number) + (num(r.RBCT2) ?? 0) : null
  const ttm = num(m?.netinc_ttm_k)
  const cet1 = num(r.RBCT1CER)
  const nimr = num(r.NIMR)
  return {
    id: String(r.CERT),
    name: r.NAME,
    city: titleCase(r.CITY),
    state: titleCase(r.STNAME) ?? r.STALP,
    stateCode: r.STALP,
    reportDate: r.REPDTE,
    totalAssets: dollars(r.ASSET) ?? 0,
    totalLoans: dollars(r.LNLSNET),
    creLoans: dollars(cre),
    creConcentration: pct(cre, r.LNLSNET),
    nonaccrualLoans: dollars(r.NALNLS),
    nplRatio: frac(r.NALNLS, r.LNLSGR),
    noncurrent_to_loans_ratio: frac(r.NCLNLS, r.LNLSGR),
    noncurrent_to_assets_ratio: frac(r.NCLNLS, r.ASSET),
    pastDue3090: frac(r.P3ASSET, r.ASSET),
    pastDue90Plus: frac(r.P9ASSET, r.ASSET),
    loanLossReserve: frac(r.LNATRES, r.LNLSGR),
    loansToDeposits: pct(r.LNLSNET, r.DEP),
    cet1Ratio: r.CBLRIND === 1 || cet1 == null || cet1 === 0 ? undefined : cet1,
    leverageRatio: num(r.RBC1AAJ) ?? undefined,
    capitalCategory: classifyCapital(r),
    totalUnusedCommitments: dollars(r.UCLN),
    creUnusedCommitments: dollars(r.UCCOMRE),
    constructionLoans: dollars(r.LNRECONS),
    multifamilyLoans: dollars(r.LNREMULT),
    nonResidentialLoans: dollars(r.LNRENROT),
    ownerOccupiedLoans: dollars(r.LNRENROW),
    nonOwnerOccupiedLoans: dollars(r.LNRENROT),
    roaLatest: num(m?.roa),
    roaDelta4Q: num(m?.roa__yoy),
    netIncomeTTM: ttm == null ? null : ttm * 1000,
    netIncomeYoYPct: ttm != null && priorTtm != null && priorTtm !== 0 ? ((ttm - priorTtm) / Math.abs(priorTtm)) * 100 : null,
    nimLatest: nimr,
    nimDelta4Q: nimr != null && priorNimr != null ? nimr - priorNimr : null,
    earningsBufferPct: ttm != null && cre != null && cre > 0 ? (ttm / cre) * 100 : null,
    capitalRatios: {
      creToTier1Tier2: t1t2 && t1t2 > 0 && cre != null ? cre / t1t2 : null,
      creToEquity: frac(cre, r.EQ) ?? null,
      constructionToTier1Tier2: t1t2 && t1t2 > 0 ? (num(r.LNRECONS) ?? 0) / t1t2 : null,
      multifamilyToTier1Tier2: t1t2 && t1t2 > 0 ? (num(r.LNREMULT) ?? 0) / t1t2 : null,
      coverage: { hasTier1Tier2: t1t2 != null && t1t2 > 0 },
    },
    trend,
    // Bank Stress Ranking scores (percentile ranks within the asset band, higher = more stress)
    stressComposite: num(s?.composite),
    conditionScore: num(s?.condition),
    deteriorationScore: num(s?.deterioration),
    creExposureScore: num(s?.cre_exposure),
    stressRank: num(s?.rank),
    peerBand: s?.peer_band ?? null,
    flagCount: num(s?.flag_count) ?? 0,
    flags: parse<string[]>(s?.flags_json, []),
    tier: s?.tier ?? null,
    creSellerSignal: s?.cre_seller_signal === 1,
    excludedReason: s?.excluded_reason ?? null,
  }
}

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

// ── screening payload ───────────────────────────────────────────────────────

function buildScreening(db: Database.Database, meta: Meta, stalp: string | null) {
  const latest = meta.latest_quarter
  const quarters = quartersBack(latest, 8)
  const displayQuarters = quarters.slice(0, 4)
  const where = stalp ? 'r.REPDTE = ? AND r.STALP = ?' : 'r.REPDTE = ?'
  const params = stalp ? [latest, stalp] : [latest]
  const raws = db.prepare(`SELECT ${RAW_COLS} FROM fdic_financials_raw r JOIN bank_scores s ON s.cert = r.CERT AND s.repdte = r.REPDTE WHERE ${where} ORDER BY r.CERT`).all(...params) as Row[]
  const certs = raws.map((r) => r.CERT as number)
  const certSet = new Set(certs)

  const metricsLatest = new Map<number, Row>()
  for (const m of db.prepare('SELECT cert, roa, roa__yoy, netinc_ttm_k FROM bank_metrics WHERE repdte = ?').all(latest) as Row[]) if (certSet.has(m.cert)) metricsLatest.set(m.cert, m)
  const scores = new Map<number, Row>()
  for (const s of db.prepare('SELECT cert, composite, condition, deterioration, cre_exposure, rank, peer_band, flag_count, flags_json, tier, cre_seller_signal, excluded_reason FROM bank_scores WHERE repdte = ?').all(latest) as Row[]) if (certSet.has(s.cert)) scores.set(s.cert, s)

  // four-quarter trend of CRE / loans and NPL / loans, newest first
  const trendRows = db.prepare(`SELECT CERT, REPDTE, LNRECONS, LNREMULT, LNRENROT, LNLSNET, NALNLS, LNLSGR FROM fdic_financials_raw WHERE REPDTE IN (${displayQuarters.map(() => '?').join(',')})`).all(...displayQuarters) as Row[]
  const trendByCert = new Map<number, Map<string, Row>>()
  for (const t of trendRows) {
    if (!certSet.has(t.CERT)) continue
    if (!trendByCert.has(t.CERT)) trendByCert.set(t.CERT, new Map())
    trendByCert.get(t.CERT)!.set(t.REPDTE, t)
  }
  const yearAgo = quarters[4]
  const priorNimr = new Map<number, number | null>()
  for (const p of db.prepare('SELECT CERT, NIMR FROM fdic_financials_raw WHERE REPDTE = ?').all(yearAgo) as Row[]) if (certSet.has(p.CERT)) priorNimr.set(p.CERT, num(p.NIMR))
  const priorTtm = new Map<number, number | null>()
  for (const p of db.prepare('SELECT cert, netinc_ttm_k FROM bank_metrics WHERE repdte = ?').all(yearAgo) as Row[]) if (certSet.has(p.cert)) priorTtm.set(p.cert, num(p.netinc_ttm_k))

  const rows = raws.map((r) => {
    const tr = trendByCert.get(r.CERT)
    const trend = displayQuarters.map((q) => {
      const t = tr?.get(q)
      return t ? { reportDate: q, creConcentration: pct(creK(t), t.LNLSNET), nplRatio: frac(t.NALNLS, t.LNLSGR) } : { reportDate: q }
    })
    return screeningRow(r, metricsLatest.get(r.CERT), scores.get(r.CERT), trend, priorNimr.get(r.CERT) ?? null, priorTtm.get(r.CERT) ?? null)
  })
  // Default order: most stressed first; unranked (de novo) banks last.
  rows.sort((a, b) => ((b.stressComposite ?? -1) - (a.stressComposite ?? -1)) || ((b.creConcentration ?? 0) - (a.creConcentration ?? 0)))

  const mean = (xs: Array<number | undefined | null>) => { const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 }
  const sum = (xs: Array<number | undefined>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  const kpis = {
    institutionsScreened: rows.length,
    avgNplRatio: mean(rows.map((r) => r.nplRatio)),
    avgNoncurrentToLoans: mean(rows.map((r) => r.noncurrent_to_loans_ratio == null ? undefined : r.noncurrent_to_loans_ratio * 100)),
    avgReserveCoverage: mean(rows.map((r) => r.loanLossReserve)),
    avgCreConcentration: mean(rows.map((r) => r.creConcentration)),
  }
  const totalLoans = sum(rows.map((r) => r.totalLoans)), totalNpl = sum(rows.map((r) => r.nonaccrualLoans)), totalCre = sum(rows.map((r) => r.creLoans)), totalAssets = sum(rows.map((r) => r.totalAssets))
  const nplSummary = {
    totalLoans, totalNpl, totalCre, totalAssets,
    avgNpl: totalLoans > 0 ? (totalNpl / totalLoans) * 100 : 0,
    avgCreToAssets: totalAssets > 0 ? (totalCre / totalAssets) * 100 : 0,
    count: rows.length,
  }
  return { rows, kpis, nplSummary, quarters, quartersDisplay: displayQuarters, rawRowCount: rows.length }
}

// ── institution detail ──────────────────────────────────────────────────────

async function fetchAcquisitions(cert: string): Promise<{ acquisitions: Array<{ date: string; description: string; absorbedCert: string }>; error?: string }> {
  const key = makeCacheKey('fdic:history', { cert })
  const hit = getCached(key) as { acquisitions: Array<{ date: string; description: string; absorbedCert: string }> } | null
  if (hit) return hit
  const url = `${FDIC_HISTORY_URL}?${new URLSearchParams({
    filters: `ACQ_CERT:${cert} AND CHANGECODE:[200 TO 299]`,
    fields: 'CERT,OUT_CERT,OUT_INSTNAME,ACQ_CERT,CHANGECODE,CHANGECODE_DESC,EFFDATE',
    limit: '200', sort_by: 'EFFDATE', sort_order: 'DESC', format: 'json',
  }).toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'amo-dashboard/1.0' }, signal: controller.signal })
    if (!res.ok) return { acquisitions: [], error: `FDIC history HTTP ${res.status}` }
    const body = (await res.json()) as { data?: Array<{ data: Row }> }
    const seen = new Set<string>()
    const acquisitions: Array<{ date: string; description: string; absorbedCert: string }> = []
    for (const item of body.data ?? []) {
      const d = item.data
      const absorbed = String(d.OUT_CERT ?? '')
      if (!absorbed || absorbed === String(cert)) continue
      const dateKey = String(d.EFFDATE ?? '').slice(0, 10)
      const k = `${absorbed}-${dateKey}`
      if (seen.has(k)) continue
      seen.add(k)
      acquisitions.push({ date: dateKey, description: `${d.OUT_INSTNAME ?? 'Institution'} — ${d.CHANGECODE_DESC ?? 'merger'}`, absorbedCert: absorbed })
    }
    const out = { acquisitions }
    setCached(key, out, DEFAULT_TTL_MS)
    return out
  } catch (err) {
    return { acquisitions: [], error: err instanceof Error && err.name === 'AbortError' ? 'FDIC history timed out' : `FDIC history unreachable: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

function verdictFor(s: Row | undefined, defs: any): { tone: string; heading: string; text: string } {
  if (!s || s.composite == null) return { tone: 'stable', heading: 'Not ranked', text: s?.excluded_reason === 'de_novo' ? 'Established within the last three years, so it is shown but not ranked against peers.' : 'No stress score for the latest quarter.' }
  const composite = Number(s.composite)
  const tier = String(s.tier ?? 'normal')
  const tone = tier === 'pressure' || composite >= 75 ? 'deteriorating' : tier === 'watchlist' || composite >= 55 ? 'watch' : 'stable'
  const drivers = parse<Array<{ label: string; percentile: number }>>(s.top_drivers_json, [])
  const flagIds = parse<string[]>(s.flags_json, [])
  const flagLabels = flagIds.map((id) => defs?.flags?.find((f: any) => f.id === id)?.label ?? id)
  const parts = [
    `Stress composite ${composite.toFixed(1)} (rank ${s.rank ?? '—'} of ${s.cohort_size ?? '—'}, ${s.peer_band ?? ''} band), ${flagIds.length} flag${flagIds.length === 1 ? '' : 's'} — ${tier === 'pressure' ? 'likely pressure' : tier}.`,
    drivers.length ? `Driven by ${drivers.map((d) => `${d.label} (${Math.round(d.percentile)}th percentile)`.replace(/(1)th/, '$1st').replace(/(?<!1)(2)th/, '$2nd').replace(/(?<!1)(3)th/, '$3rd')).join(', ')}.` : '',
    flagLabels.length ? `Flags: ${flagLabels.join('; ')}.` : '',
    s.cre_seller_signal === 1 ? 'CRE seller signal: provisioning behind losses, CRE charge-offs rising and selling at a loss, together.' : '',
  ].filter(Boolean)
  return { tone, heading: tone === 'deteriorating' ? 'Deteriorating' : tone === 'watch' ? 'Watch' : 'Stable', text: parts.join(' ') }
}

async function buildInstitution(db: Database.Database, meta: Meta, cert: string) {
  const rows = db.prepare(`SELECT ${RAW_COLS}, m.roa, m.cre_concentration, m.construction_concentration FROM fdic_financials_raw r LEFT JOIN bank_metrics m ON m.cert = r.CERT AND m.repdte = r.REPDTE WHERE r.CERT = ? ORDER BY r.REPDTE DESC LIMIT 8`).all(Number(cert)) as Row[]
  if (!rows.length) return null
  const latest = rows[0]
  const leverageOnly = latest.CBLRIND === 1
  const points = [...rows].reverse().map((r) => ({
    quarter: r.REPDTE,
    label: quarterLabel(r.REPDTE),
    noncurrentPct: pct(r.NCLNLS, r.LNLSGR) ?? null,
    nplPct: pct(r.NALNLS, r.LNLSGR) ?? null,
    leveragePct: num(r.RBC1AAJ),
    cet1Pct: r.CBLRIND === 1 || !num(r.RBCT1CER) ? null : num(r.RBCT1CER),
    totalRbcPct: r.CBLRIND === 1 || !num(r.RBCRWAJ) ? null : num(r.RBCRWAJ),
    creToCapitalPct: num(r.cre_concentration),
    constructionToCapitalPct: num(r.construction_concentration),
    reservePct: pct(r.LNATRES, r.LNLSGR) ?? null,
    roaPct: num(r.roa),
    nimPct: num(r.NIMR),
    capital: (() => { const c = classifyCapital(r); return c ? { category: c.category, label: c.label } : { category: 'unknown', label: '—' } })(),
  }))
  const score = db.prepare('SELECT * FROM bank_scores WHERE cert = ? ORDER BY repdte DESC LIMIT 1').get(Number(cert)) as Row | undefined
  const defs = parse<any>(meta.definitions_json, {})
  const history = await fetchAcquisitions(cert)
  return {
    cert,
    trend: { cert, name: latest.NAME, city: titleCase(latest.CITY) ?? '', state: titleCase(latest.STNAME) ?? latest.STALP ?? '', points, verdict: verdictFor(score, defs), leverageOnly },
    history: { cert, acquisitions: history.acquisitions, error: history.error },
    behavior: null,
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerFdicAnalyticsRoutes(app: Express) {
  app.get('/api/fdic/meta', (_req: Request, res: Response) => {
    const db = openBankStressDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const key = makeCacheKey('fdic:meta', { v: meta.computed_at })
    const hit = getCached(key)
    if (hit) return res.json(hit)
    const cfg = parse<any>(meta.config_json, {})
    const body = {
      ok: true,
      meta: { ...stamp(meta, meta.latest_quarter, NATIONAL), apiVersion: '1', source: SOURCE },
      scopes: { national: NATIONAL, states: stateScopes(db, meta.latest_quarter) },
      assetBands: (cfg.peer_bands ?? []).map((b: any) => ({ key: b.key, label: b.label, maxAssets: b.max_assets_k == null ? null : b.max_assets_k * 1000 })),
      signals: [],
      signalThresholds: {},
      creCategoryLabels: {},
      endpoints: { screening: '/api/fdic/screening', institution: '/api/fdic/institution/:cert' },
      cache: { note: 'Recomputed by the weekly collector job; served from bank_stress.db, cache keyed on the compute time.' },
    }
    setCached(key, body, DEFAULT_TTL_MS)
    res.json(body)
  })

  app.get('/api/fdic/screening', (req: Request, res: Response) => {
    const db = openBankStressDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : NATIONAL
    const resolved = resolveScope(stateScopes(db, meta.latest_quarter), scope)
    if (!resolved) return fail(res, 400, `Unknown scope "${scope}" — use National, a state name or a two-letter state code`)
    const key = makeCacheKey('fdic:screening', { scope: resolved.stalp ?? NATIONAL, v: meta.computed_at })
    const hit = getCached(key)
    if (hit) { res.setHeader('X-FDIC-Cache', 'HIT'); return res.json(hit) }
    const payload = buildScreening(db, meta, resolved.stalp)
    const body = { ok: true, meta: stamp(meta, meta.latest_quarter, resolved.display), payload }
    setCached(key, body, DEFAULT_TTL_MS)
    res.setHeader('X-FDIC-Cache', 'MISS')
    res.json(body)
  })

  app.get('/api/fdic/institution/:cert', async (req: Request, res: Response) => {
    const db = openBankStressDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const cert = String(req.params.cert ?? '').trim()
    if (!/^\d{1,7}$/.test(cert)) return fail(res, 400, 'cert must be a numeric FDIC certificate number')
    const key = makeCacheKey('fdic:institution', { cert, v: meta.computed_at })
    const hit = getCached(key)
    if (hit) return res.json(hit)
    const detail = await buildInstitution(db, meta, cert)
    if (!detail) return fail(res, 404, `no Call Report rows for cert ${cert}`)
    const body = { ok: true, meta: stamp(meta, meta.latest_quarter, NATIONAL), ...detail }
    // Only cache when the acquisition fetch succeeded, so a transient FDIC outage is not pinned for a week.
    if (!detail.history.error) setCached(key, body, DEFAULT_TTL_MS)
    res.json(body)
  })
}
