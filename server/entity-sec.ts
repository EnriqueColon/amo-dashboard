/**
 * SEC section of the entity profile card (docs/REPORTING_FEED_PLAN.md step 4).
 *
 * Two independent SEC identities per firm, each matched by name and shown as a
 * suggestion until a person confirms, picks another, or says there is none:
 *
 *  - EDGAR filer (CIK): company details, latest filings, and for listed
 *    companies four headline figures from XBRL (latest 10-K).
 *    Suggestion order: (1) the SEC ticker list (listed companies) on the firm's
 *    own name, (2) for banks, the ticker list on the FDIC holding company's name
 *    (Citibank -> Citigroup, US Bank -> US Bancorp), (3) an EDGAR filer whose
 *    cleaned name equals the firm's. EDGAR's own name search ranks poorly
 *    ("wells fargo" does not list Wells Fargo & Company), so it only feeds the
 *    "pick another" list.
 *  - Investment adviser (Form ADV, IAPD CRD): registration, latest ADV filing,
 *    office, brochure. Suggested when exactly the firm's name, or the name plus
 *    a management word ("RIALTO CAPITAL" -> "RIALTO CAPITAL MANAGEMENT").
 *    IAPD's API carries no assets under management; that needs SEC's bulk ADV
 *    data and is not here.
 *
 * Decisions live in entity_sec_links (main DB) and always win. Upstream calls
 * are spaced (EDGAR 125 ms, IAPD 300 ms, as server/intel/peer-intel-service.ts)
 * and cached in memory for a day.
 */
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { fdicHoldingCompany } from './entity-fdic'
import { edgarHeaders, REQUEST_SPACING_MS, buildSubmissionsUrl, buildCompanyConceptUrl } from '@shared/peer-intel/edgar-contract'
import { iapdSearchUrl, IAPD_SPACING_MS } from '@shared/peer-intel/iapd'

const contact = () => process.env.SEC_EDGAR_CONTACT?.trim() || 'market-intelligence@safeharborcp.com'
const DAY = 24 * 3600_000

// ── Fetching: spaced, cached, never throws to the caller ─────────────────────
const nextSlot: Record<string, number> = {}
const cache = new Map<string, { at: number; val: any }>()

async function getJson(url: string, lane: 'edgar' | 'iapd'): Promise<any | null> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < DAY) return hit.val
  const spacing = lane === 'edgar' ? REQUEST_SPACING_MS : IAPD_SPACING_MS
  const now = Date.now()
  const slot = Math.max(now, nextSlot[lane] ?? 0)
  nextSlot[lane] = slot + spacing
  if (slot > now) await new Promise(r => setTimeout(r, slot - now))
  try {
    const res = await fetch(url, { headers: edgarHeaders(contact()), signal: AbortSignal.timeout(10_000) })
    const val = res.ok ? await res.json() : null
    // 404 is a real answer (no such concept); other failures are not cached.
    if (res.ok || res.status === 404) cache.set(url, { at: Date.now(), val })
    return val
  } catch {
    return null
  }
}

// ── Names ─────────────────────────────────────────────────────────────────────
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '))
const ABBR: Record<string, string> = { BCORP: 'BANCORP', FINL: 'FINANCIAL', SVCS: 'SERVICES', GRP: 'GROUP', HLDGS: 'HOLDINGS', BANCSHS: 'BANCSHARES', BCSHS: 'BANCSHARES', NATL: 'NATIONAL', MTG: 'MORTGAGE' }
const TAIL = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'AND', 'GROUP', 'HOLDINGS', 'HOLDING', 'LLC', 'LP', 'LTD', 'PLC', 'NA', 'THE', 'INCORPORATED', 'LIMITED'])

/** Upper-case, & -> AND, FDIC abbreviations expanded, state tags and corporate tails dropped. */
export function secNorm(s: string): string {
  let t = (s || '').toUpperCase()
    .replace(/\/[A-Z]{2}\/?/g, ' ')           // "/MN", "/DE/"
    .replace(/&/g, ' AND ')
    .replace(/[.,'’()]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\bU S\b/g, 'US')
    .split(/\s+/).filter(Boolean)
    .map(w => ABBR[w] ?? w)
  if (t[0] === 'THE') t = t.slice(1)
  for (;;) {
    const last = t[t.length - 1]
    if (t.length > 1 && (TAIL.has(last) || (STATES.has(last) && t.length > 2))) { t = t.slice(0, -1); continue }
    if (t.length > 2 && t[t.length - 2] === 'N' && last === 'A') { t = t.slice(0, -2); continue }
    break
  }
  return t.join(' ')
}

type Ticker = { cik: number; ticker: string; title: string; norm: string }
async function tickers(): Promise<Ticker[]> {
  const raw = await getJson('https://www.sec.gov/files/company_tickers.json', 'edgar')
  if (!raw) return []
  const seen = new Map<number, Ticker>()
  for (const v of Object.values(raw) as any[]) {
    if (!seen.has(v.cik_str)) seen.set(v.cik_str, { cik: v.cik_str, ticker: v.ticker, title: v.title, norm: secNorm(v.title) })
  }
  return [...seen.values()]
}

async function edgarSearch(q: string): Promise<{ cik: number; name: string }[]> {
  const raw = await getJson(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`, 'edgar')
  return ((raw?.hits?.hits ?? []) as any[])
    .map(h => ({ cik: Number(h._id), name: String(h._source?.entity ?? '') }))
    .filter(h => h.cik > 0 && h.name)
}

// Not "INVESTMENTS": WELLS FARGO -> "WELLS FARGO INVESTMENTS, LLC" is a broker
// arm, not the firm's adviser.
const MGMT = /^(GROUP |CREDIT |CAPITAL |ASSET |INVESTMENT |FUND |REAL ESTATE |MORTGAGE )?(MANAGEMENT|ADVISORS|ADVISERS|MANAGER|PARTNERS)$/

// Firms whose SEC name shares no words with ours. CIKs checked against
// data.sec.gov on 4 Nov 2026.
const EDGAR_ALIASES: Record<string, { cik: number; name: string }> = {
  'FANNIE MAE': { cik: 310522, name: 'FEDERAL NATIONAL MORTGAGE ASSOCIATION FANNIE MAE' },
  'FREDDIE MAC': { cik: 1026214, name: 'FEDERAL HOME LOAN MORTGAGE CORP' },
}

async function iapdSearch(q: string) {
  const raw = await getJson(iapdSearchUrl(q), 'iapd')
  return ((raw?.hits?.hits ?? []) as any[]).map(h => {
    const s = h._source ?? {}
    let city: string | null = null, state: string | null = null
    try { const a = JSON.parse(s.firm_ia_address_details ?? '{}').officeAddress ?? {}; city = a.city ?? null; state = a.state ?? null } catch { /* absent */ }
    return { crd: String(s.firm_source_id ?? ''), name: String(s.firm_name ?? ''), scope: s.firm_ia_scope ?? null, sec_number: s.firm_ia_full_sec_number ?? null, city, state }
  }).filter(h => h.crd && h.name)
}

// ── Detail for a chosen id ───────────────────────────────────────────────────
const KEY_FORMS = new Set(['10-K', '10-K/A', '10-Q', '8-K', '20-F', '6-K', '40-F', '10-D', 'ABS-15G', 'D', 'D/A', 'N-CSR', 'ADV', '13F-HR', 'DEF 14A', 'S-1', 'S-3', '424B5'])
const CONCEPTS: [string, string][] = [
  ['Assets', 'Total assets'],
  ['StockholdersEquity', 'Shareholders\' equity'],
  ['NetIncomeLoss', 'Net income'],
  ['Revenues', 'Revenue'],
]

async function edgarCompany(cik: number) {
  const sub = await getJson(buildSubmissionsUrl(cik), 'edgar')
  if (!sub) return null
  const r = sub.filings?.recent ?? {}
  const all = (r.form ?? []).map((form: string, i: number) => ({
    form, date: r.filingDate?.[i], accession: r.accessionNumber?.[i], doc: r.primaryDocument?.[i], description: r.primaryDocDescription?.[i] || null,
  }))
  const picked = (all.filter((f: any) => KEY_FORMS.has(f.form)).length ? all.filter((f: any) => KEY_FORMS.has(f.form)) : all).slice(0, 8)
  const filings = picked.map((f: any) => {
    const bare = String(f.accession ?? '').replace(/-/g, '')
    return { form: f.form, date: f.date, description: f.description,
      url: f.doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/${f.doc}` : `https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/${f.accession}-index.html` }
  })
  const listed = (sub.tickers ?? []).length > 0
  const figures: any[] = []
  if (listed) {
    for (const [concept, label] of CONCEPTS) {
      const c = await getJson(buildCompanyConceptUrl(cik, 'us-gaap', concept), 'edgar')
      const rows = ((c?.units?.USD ?? []) as any[]).filter(u => u.form === '10-K' && u.fp === 'FY' &&
        (!u.start || (Date.parse(u.end) - Date.parse(u.start)) > 300 * 86400_000))
      rows.sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.filed).localeCompare(String(a.filed)))
      if (rows[0]) figures.push({ concept, label, value: rows[0].val, period_end: rows[0].end, fy: rows[0].fy })
    }
  }
  // A company can stop tagging a concept (Wells Fargo's "Revenues" ends in
  // FY2019); never show a stale figure beside current ones.
  const latestFy = Math.max(0, ...figures.map(x => Number(x.fy) || 0))
  for (let i = figures.length - 1; i >= 0; i--) if ((Number(figures[i].fy) || 0) < latestFy) figures.splice(i, 1)
  const biz = sub.addresses?.business ?? {}
  return {
    cik, name: sub.name, tickers: sub.tickers ?? [], exchanges: sub.exchanges ?? [], listed,
    sic: sub.sicDescription || null, entity_type: sub.entityType || null,
    state_of_incorporation: sub.stateOfIncorporationDescription || sub.stateOfIncorporation || null,
    city: biz.city ?? null, state: biz.stateOrCountry ?? null,
    edgar_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
    filings, figures,
  }
}

async function adviserFirm(crd: string) {
  const raw = await getJson(`https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(crd)}`, 'iapd')
  const content = raw?.hits?.hits?.[0]?._source?.iacontent
  if (!content) return null
  let j: any
  try { j = JSON.parse(content) } catch { return null }
  const b = j.basicInformation ?? {}
  const a = j.iaFirmAddressDetails?.officeAddress ?? {}
  const reg = (j.registrationStatus ?? [])[0] ?? {}
  const br = (j.brochures?.brochuredetails ?? [])[0] ?? null
  return {
    crd, name: b.firmName, other_names: (b.otherNames ?? []).length, scope: b.iaScope ?? null,
    sec_number: b.iaSECNumber ? `${b.iaSECNumberType ?? ''}-${b.iaSECNumber}` : null,
    adv_filing_date: b.advFilingDate ?? null,
    registration: reg.status ? `${reg.status} (${reg.secJurisdiction ?? ''}, since ${reg.effectiveDate ?? '?'})` : null,
    office: [a.street1, a.city, a.state].filter(Boolean).join(', ') || null,
    brochure: br ? { name: br.brochureName, date: br.dateSubmitted } : null,
    iapd_url: `https://adviserinfo.sec.gov/firm/summary/${crd}`,
    adv_pdf_url: b.hasPdf === 'Y' ? `https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf` : null,
  }
}

// ── Links table ───────────────────────────────────────────────────────────────
function ensureTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS entity_sec_links (
    entity    TEXT NOT NULL,
    kind      TEXT NOT NULL,      -- 'edgar' (ref = CIK) | 'adviser' (ref = IAPD CRD)
    ref       TEXT,               -- NULL when status = 'none'
    status    TEXT NOT NULL,      -- 'confirmed' | 'none'
    linked_at TEXT NOT NULL,
    PRIMARY KEY (entity, kind)
  )`)
}

const answerCache = new Map<string, { at: number; val: any }>()

export function registerEntitySecRoutes(app: Express) {
  const db = getDb()
  ensureTable(db)

  app.get('/api/entity/:name/sec', async (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    if (!entity) return res.status(400).json({ error: 'name required' })
    const hit = answerCache.get(entity)
    if (hit && Date.now() - hit.at < 12 * 3600_000) return res.json(hit.val)

    const saved = new Map<string, { ref: string | null; status: string; linked_at: string }>()
    for (const r of db.prepare(`SELECT kind, ref, status, linked_at FROM entity_sec_links WHERE entity = ?`).all(entity) as any[]) saved.set(r.kind, r)
    const type = (db.prepare(`SELECT entity_type FROM entity_nodes WHERE entity = ?`).get(entity) as { entity_type: string } | undefined)?.entity_type ?? null
    const n = secNorm(entity)

    // EDGAR
    const tick = await tickers()
    const search = await edgarSearch(entity)
    const edgarCands: { cik: number; name: string; ticker?: string; basis: string }[] = []
    const addCand = (c: { cik: number; name: string; ticker?: string; basis: string }) => { if (!edgarCands.some(x => x.cik === c.cik)) edgarCands.push(c) }
    const alias = EDGAR_ALIASES[entity.toUpperCase()]
    if (alias) addCand({ ...alias, basis: 'known SEC name for this firm' })
    for (const t of tick) if (n.length >= 3 && t.norm === n) addCand({ cik: t.cik, name: t.title, ticker: t.ticker, basis: 'listed company with this name' })
    let hc: string | null = null
    if (type === 'BANK') {
      hc = fdicHoldingCompany(entity)?.hc_name ?? null
      const hn = hc ? secNorm(hc) : ''
      if (hn.length >= 3) for (const t of tick) if (t.norm === hn) addCand({ cik: t.cik, name: t.title, ticker: t.ticker, basis: `listed parent: FDIC names the holding company "${hc}"` })
    }
    for (const s of search) if (secNorm(s.name) === n) addCand({ cik: s.cik, name: s.name, basis: 'EDGAR filer with this exact name' })
    const suggestedEdgar = edgarCands[0] ?? null
    for (const s of search) addCand({ cik: s.cik, name: s.name, basis: 'EDGAR name search' })

    const se = saved.get('edgar')
    let edgar: any
    if (se?.status === 'none') edgar = { status: 'none', candidates: edgarCands.slice(0, 10) }
    else if (se?.status === 'confirmed' && se.ref) edgar = { status: 'confirmed', cik: Number(se.ref), candidates: edgarCands.slice(0, 10), company: await edgarCompany(Number(se.ref)) }
    else if (suggestedEdgar) edgar = { status: 'suggested', cik: suggestedEdgar.cik, basis: suggestedEdgar.basis, candidates: edgarCands.slice(0, 10), company: await edgarCompany(suggestedEdgar.cik) }
    else edgar = { status: 'no_match', candidates: edgarCands.slice(0, 10) }

    // Form ADV
    const advHits = await iapdSearch(entity)
    const scored = advHits.map(h => {
      const hn = secNorm(h.name)
      const exact = hn === n
      const ext = !exact && hn.startsWith(n + ' ') && MGMT.test(hn.slice(n.length + 1))
      return { ...h, basis: exact ? 'adviser with this exact name' : ext ? 'adviser named this firm plus a management word' : 'adviser name search', strong: exact || ext, active: h.scope === 'ACTIVE' }
    })
    const strong = scored.filter(h => h.strong).sort((a, b) => Number(b.active) - Number(a.active))
    const suggestedAdv = strong.length === 1 || (strong.length > 1 && strong.filter(h => h.active).length === 1) ? strong[0] : null
    const sa = saved.get('adviser')
    const advCands = scored.slice(0, 10)
    let adviser: any
    if (sa?.status === 'none') adviser = { status: 'none', candidates: advCands }
    else if (sa?.status === 'confirmed' && sa.ref) adviser = { status: 'confirmed', crd: sa.ref, candidates: advCands, firm: await adviserFirm(sa.ref) }
    else if (suggestedAdv) adviser = { status: 'suggested', crd: suggestedAdv.crd, basis: suggestedAdv.basis, candidates: advCands, firm: await adviserFirm(suggestedAdv.crd) }
    else adviser = { status: strong.length > 1 ? 'ambiguous' : 'no_match', candidates: advCands }

    const val = { entity, entity_type: type, edgar, adviser }
    answerCache.set(entity, { at: Date.now(), val })
    res.json(val)
  })

  // Body: { kind: 'edgar' | 'adviser', ref } to confirm, or { kind, none: true }.
  app.put('/api/entity/:name/sec', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    const body = (req.body ?? {}) as { kind?: unknown; ref?: unknown; none?: unknown }
    const kind = body.kind === 'edgar' || body.kind === 'adviser' ? body.kind : null
    if (!entity || !kind) return res.status(400).json({ error: "kind must be 'edgar' or 'adviser'" })
    const ref = body.none === true ? null : String(body.ref ?? '').trim()
    if (ref !== null && !/^\d{1,10}$/.test(ref)) return res.status(400).json({ error: 'ref must be a numeric CIK or CRD' })
    db.prepare(`INSERT INTO entity_sec_links (entity, kind, ref, status, linked_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(entity, kind) DO UPDATE SET ref = excluded.ref, status = excluded.status, linked_at = excluded.linked_at`)
      .run(entity, kind, ref, ref === null ? 'none' : 'confirmed', new Date().toISOString())
    answerCache.delete(entity)
    res.json({ ok: true })
  })

  // Back to the automatic suggestion for one kind.
  app.delete('/api/entity/:name/sec', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    const kind = String(req.query.kind ?? '')
    if (kind !== 'edgar' && kind !== 'adviser') return res.status(400).json({ error: "kind must be 'edgar' or 'adviser'" })
    db.prepare(`DELETE FROM entity_sec_links WHERE entity = ? AND kind = ?`).run(entity, kind)
    answerCache.delete(entity)
    res.json({ ok: true })
  })
}
