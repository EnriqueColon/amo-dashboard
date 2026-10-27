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
  const stateName = titleCase(latest.STNAME) ?? latest.STALP ?? ''
  return {
    cert,
    trend: { cert, name: latest.NAME, city: titleCase(latest.CITY) ?? '', state: stateName, points, verdict: verdictFor(score, defs), leverageOnly },
    history: { cert, acquisitions: history.acquisitions, error: history.error },
    behavior: buildBehavior(db, meta, Number(cert), latest.NAME, stateName, defs),
  }
}

// ── balance-sheet behaviour (stage 3) ───────────────────────────────────────
//
// collector/bank_stress/behavior.py computes the measures, the seven signals,
// the per-category roll-forward and the balances per bank-quarter. This side
// only reshapes them into the objects the page and the drawer already render
// (the Market Intelligence contract) and writes the plain-language reading —
// a port of that tool's buildReading, quoting only numbers on the panel.

const SIGNAL_KEYS = ['hfsTransfer', 'realizedSale', 'chargeOffSpike', 'unexplainedExit', 'foreclosureRoute', 'modificationBuild', 'creRunoff'] as const
type SignalKey = typeof SIGNAL_KEYS[number]

type BehaviorRow = Row & { measures: Record<string, number | null> | null; fired: SignalKey[]; unjudged: SignalKey[]; rollforward: Record<string, Row> | null; percentiles: Record<string, number | null> }

function behaviorRows(db: Database.Database, cert: number, limit: number): BehaviorRow[] {
  const rows = db.prepare('SELECT * FROM bank_behavior WHERE cert = ? ORDER BY repdte DESC LIMIT ?').all(cert, limit) as Row[]
  return rows.reverse().map((r) => ({
    ...r,
    measures: parse<Record<string, number | null> | null>(r.measures_json, null),
    fired: parse<SignalKey[]>(r.fired_json, []),
    unjudged: parse<SignalKey[]>(r.unjudged_json, []),
    rollforward: parse<Record<string, Row> | null>(r.rollforward_json, null),
    percentiles: parse<Record<string, number | null>>(r.percentiles_json, {}),
  }))
}

function behaviorSummary(r: BehaviorRow, extra: { name: string; state: string | null; asOf: string }) {
  return {
    cert: String(r.cert), name: extra.name, state: extra.state, quarter: r.repdte, current: r.repdte === extra.asOf,
    quartersAvailable: r.quarters_available, totalAssets: r.assets_k, grossLoans: r.gross_loans, creLoans: r.cre_loans, band: r.band,
    measures: r.measures ?? {}, percentiles: r.percentiles, fired: r.fired, unjudged: r.unjudged,
    actionCount: r.action_count, pressureCount: r.pressure_count,
  }
}

function money(thousands: number): string {
  const dollars = thousands * 1000
  const abs = Math.abs(dollars)
  const sign = dollars < 0 ? '−' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toFixed(0)}`
}
const pctText = (v: number, dp = 2) => `${v.toFixed(dp)}%`

function buildReading(latest: BehaviorRow | null, steps: Row[], byQuarter: Array<{ label: string; fired: SignalKey[] }>, signalLabel: (k: SignalKey) => string, thresholds: Row): { text: string; signals: SignalKey[] } {
  if (!latest || !latest.measures) {
    return { text: 'Only one quarter of behaviour fields is on file for this institution, so nothing can be judged: every signal compares a quarter with the one before it.', signals: [] }
  }
  const m = latest.measures
  const label = quarterLabel(latest.repdte)
  const fired = new Set(latest.fired)
  const s: string[] = []
  if (fired.has('hfsTransfer') && m.hfsBalance != null && m.hfsPct != null) {
    s.push(`In ${label} it moved loans to held-for-sale: the balance is ${money(m.hfsBalance)}, ${pctText(m.hfsPct)} of gross loans${m.hfsTrailingMax != null ? `, against a high of ${money(m.hfsTrailingMax)} over the previous four quarters` : ''}.`)
  }
  if (fired.has('realizedSale') && m.loanSaleGainQ != null) {
    const loss = m.loanSaleGainQ < 0
    s.push(`It booked a ${loss ? 'loss' : 'gain'} of ${money(Math.abs(m.loanSaleGainQ))} on loan sales in the quarter${loss ? ', which points to a discount trade' : ''}${m.priorQuartersWithSales != null && m.priorQuartersWithSales <= 1 ? '; it had sold in at most one of the previous four quarters, so this is not a routine pipeline' : ''}.`)
  }
  if (fired.has('chargeOffSpike') && m.creNcoRateQ != null) {
    s.push(`CRE net charge-offs ran ${pctText(m.creNcoRateQ, 3)} of CRE loans for the quarter${m.creNcoRateTrailingMean != null ? `, against its own average of ${pctText(m.creNcoRateTrailingMean, 3)}` : ''}.`)
  }
  if (fired.has('foreclosureRoute') && m.oreoCreChangePct != null && m.oreoCrePct != null) {
    s.push(`It took collateral: CRE OREO rose by ${pctText(m.oreoCreChangePct, 3)} of CRE loans to ${pctText(m.oreoCrePct, 2)} while CRE nonaccrual fell, so REO rather than a note sale is the route.`)
  }
  if (fired.has('unexplainedExit') && m.unexplainedExit != null && m.unexplainedExitPctOfCre != null) {
    s.push(`${money(m.unexplainedExit)} of CRE nonaccrual (${pctText(m.unexplainedExitPctOfCre)} of CRE loans) left the books without a charge-off or a transfer to OREO to account for it — consistent with a note sale, though cures and payoffs land in the same residual.`)
  }
  if (fired.has('modificationBuild') && m.modificationsCrePct != null && m.modificationsCreChangePct != null) {
    s.push(`Modifications to CRE borrowers in difficulty rose by ${pctText(m.modificationsCreChangePct)} of CRE loans to ${pctText(m.modificationsCrePct)} while past-dues were flat or falling: extending rather than resolving.`)
  }
  if (fired.has('creRunoff') && m.creRunoffPct != null && m.creRunoff4qPct != null) {
    s.push(`The CRE book shrank ${pctText(Math.abs(m.creRunoffPct), 1)} in the quarter and ${pctText(Math.abs(m.creRunoff4qPct), 1)} over four, beyond what charge-offs explain.`)
  }
  if (s.length === 0) {
    const judgedCount = SIGNAL_KEYS.length - latest.unjudged.length
    const earlier = byQuarter.slice(0, -1).filter((q) => q.fired.length > 0)
    s.push(judgedCount === 0
      ? `None of the seven behaviour signals could be judged for ${label}; the inputs they need are not reported for this institution.`
      : `No behaviour signal fired in ${label}${judgedCount < SIGNAL_KEYS.length ? ` (${judgedCount} of ${SIGNAL_KEYS.length} could be judged)` : ''}: held-for-sale${m.hfsPct != null ? ` is ${pctText(m.hfsPct)} of loans` : ' is not reported'}, and charge-offs, OREO and modifications moved within the bank's own range.`)
    if (earlier.length) {
      const last = earlier[earlier.length - 1]
      s.push(`The last quarter with a signal was ${last.label} (${last.fired.map((k) => signalLabel(k).replace(/^([A-Z])(?![A-Z])/, (c) => c.toLowerCase())).join(', ')}).`)
    }
  }
  const roll: string[] = []
  const step = steps[steps.length - 1]
  if (step && step.priorNonaccrual != null && step.currentNonaccrual != null) {
    const dir = step.currentNonaccrual > step.priorNonaccrual ? 'rose' : step.currentNonaccrual < step.priorNonaccrual ? 'fell' : 'was unchanged'
    roll.push(`CRE nonaccrual ${dir}${dir === 'was unchanged' ? '' : ` from ${money(step.priorNonaccrual)} to ${money(step.currentNonaccrual)}`} in ${label}.`)
    if (step.unexplainedExit != null) {
      const parts: string[] = []
      if (step.chargeOffs) parts.push(`${money(step.chargeOffs)} charged off`)
      if (step.oreoTransferProxy) parts.push(`${money(step.oreoTransferProxy)} of OREO added`)
      if (step.newNonaccrualProxy) parts.push(`${money(step.newNonaccrualProxy)} of 90-day past-dues that were due to migrate in`)
      const share = step.unexplainedExitShareOfPrior as number | null
      const exitShare = Number(thresholds.exitShareOfPriorNonaccrual ?? 0.25) * 100
      const verdict = step.unexplainedExit > 0
        ? `${money(step.unexplainedExit)} is unexplained by charge-offs or foreclosure${fired.has('unexplainedExit') ? '' : share != null ? ` — ${pctText(share * 100, 0)} of the prior balance, under the ${exitShare}% at which the exit signal fires` : ''}`
        : step.unexplainedExit < 0 ? `nonaccruals grew by ${money(-step.unexplainedExit)} more than the prior past-dues predicted` : 'the movement is fully explained'
      roll.push(parts.length ? `Allowing for ${parts.join(', ')}, ${verdict}.` : `${verdict[0].toUpperCase()}${verdict.slice(1)}.`)
    } else {
      roll.push('The roll-forward cannot be completed for this quarter because one of its inputs is not reported.')
    }
  }
  return { text: [s.join(' '), roll.join(' ')].filter((p) => p.length > 0).join('\n\n'), signals: latest.fired }
}

function buildBehavior(db: Database.Database, meta: Meta, cert: number, name: string, state: string | null, defs: any) {
  const cfg = parse<any>(meta.config_json, {})
  const limit = Number(cfg.behavior?.quarters ?? 9)
  const rows = behaviorRows(db, cert, limit)
  if (!rows.length) return null
  const sigDefs: Array<{ key: SignalKey; label: string }> = defs?.behavior_signals ?? []
  const signalLabel = (k: SignalKey) => sigDefs.find((d) => d.key === k)?.label ?? k
  const labels: Record<string, string> = defs?.cre_category_labels ?? {}
  const points = rows.map((r) => ({
    quarter: r.repdte, label: quarterLabel(r.repdte), grossLoans: r.gross_loans, creLoans: r.cre_loans,
    heldForSale: r.hfs, heldForSalePctOfLoans: r.hfs_pct, oreoCre: r.oreo_cre, oreoTotal: r.oreo_total,
    nonaccrualCre: r.na_cre, modificationsCre: r.mods_cre, chargeOffsCreQ: r.co_cre_q, netChargeOffsCreQ: r.nco_cre_q, loanSaleGainQ: r.loan_sale_q,
  }))
  const judged = rows.filter((r) => r.judged === 1 && r.rollforward)
  const steps = judged.map((r) => r.rollforward!.cre)
  const byQuarter = judged.map((r) => ({ quarter: r.repdte, label: quarterLabel(r.repdte), fired: r.fired, unjudged: r.unjudged }))
  const last = rows[rows.length - 1]
  const latestJudged = last.judged === 1 ? last : null
  const latestByCategory = (['construction', 'multifamily', 'nonfarmNonres'] as const).map((category) => ({
    category, label: labels[category] ?? category, step: latestJudged?.rollforward?.[category] ?? null,
  }))
  return {
    cert: String(cert), name, state, asOfQuarter: meta.latest_quarter,
    points, rollForward: steps, latestByCategory, signalsByQuarter: byQuarter,
    latest: latestJudged ? behaviorSummary(latestJudged, { name, state, asOf: meta.latest_quarter }) : null,
    reading: buildReading(latestJudged, steps, byQuarter, signalLabel, defs?.behavior_thresholds ?? {}),
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerFdicAnalyticsRoutes(app: Express) {
  app.get('/api/fdic/behavior-signals', (req: Request, res: Response) => {
    const db = openBankStressDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : NATIONAL
    const band = typeof req.query.band === 'string' && req.query.band ? req.query.band : null
    const resolved = resolveScope(stateScopes(db, meta.latest_quarter), scope)
    if (!resolved) return fail(res, 400, `Unknown scope "${scope}"`)
    const key = makeCacheKey('fdic:behavior', { scope: resolved.stalp ?? NATIONAL, band: band ?? '', v: meta.computed_at })
    const hit = getCached(key)
    if (hit) { res.setHeader('X-FDIC-Cache', 'HIT'); return res.json(hit) }
    const latest = meta.latest_quarter
    const where = ['b.repdte = @q']
    const params: Row = { q: latest }
    if (resolved.stalp) { where.push('r.STALP = @st'); params.st = resolved.stalp }
    // counts are scope-wide in every band response (the client reads them once, from the first part)
    const counts = db.prepare(`SELECT SUM(b.judged = 1) AS judged, SUM(b.judged = 0) AS unjudged FROM bank_behavior b JOIN fdic_financials_raw r ON r.CERT = b.cert AND r.REPDTE = b.repdte WHERE ${where.join(' AND ')}`).get(params) as { judged: number; unjudged: number }
    if (band) { where.push('b.band = @band'); params.band = band }
    const rows = db.prepare(`SELECT b.*, r.NAME, r.STNAME FROM bank_behavior b JOIN fdic_financials_raw r ON r.CERT = b.cert AND r.REPDTE = b.repdte WHERE ${where.join(' AND ')} AND b.judged = 1 ORDER BY b.cert`).all(params) as Row[]
    const summaries = rows.map((r) => behaviorSummary({
      ...r, measures: parse(r.measures_json, {}), fired: parse(r.fired_json, []), unjudged: parse(r.unjudged_json, []), rollforward: null, percentiles: parse(r.percentiles_json, {}),
    } as BehaviorRow, { name: r.NAME, state: titleCase(r.STNAME) ?? null, asOf: latest }))
    const body = {
      ok: true, meta: stamp(meta, latest, resolved.display),
      cohort: { scope: resolved.display, asOfQuarter: latest, institutionCount: counts.judged ?? 0, currentCount: counts.judged ?? 0, unjudgedCount: counts.unjudged ?? 0, summaries },
    }
    setCached(key, body, DEFAULT_TTL_MS)
    res.setHeader('X-FDIC-Cache', 'MISS')
    res.json(body)
  })

  app.get('/api/fdic/meta', (_req: Request, res: Response) => {
    const db = openBankStressDb()
    const meta = db && latestMeta(db)
    if (!db || !meta) return fail(res, 503, BANK_STRESS_MISSING_MESSAGE)
    const key = makeCacheKey('fdic:meta', { v: meta.computed_at })
    const hit = getCached(key)
    if (hit) return res.json(hit)
    const cfg = parse<any>(meta.config_json, {})
    const defs = parse<any>(meta.definitions_json, {})
    const body = {
      ok: true,
      meta: { ...stamp(meta, meta.latest_quarter, NATIONAL), apiVersion: '1', source: SOURCE },
      scopes: { national: NATIONAL, states: stateScopes(db, meta.latest_quarter) },
      assetBands: (cfg.peer_bands ?? []).map((b: any) => ({ key: b.key, label: b.label, maxAssets: b.max_assets_k == null ? null : b.max_assets_k * 1000 })),
      signals: defs.behavior_signals ?? [],
      signalThresholds: defs.behavior_thresholds ?? {},
      creCategoryLabels: defs.cre_category_labels ?? {},
      endpoints: { screening: '/api/fdic/screening', institution: '/api/fdic/institution/:cert', behaviorSignals: '/api/fdic/behavior-signals' },
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
