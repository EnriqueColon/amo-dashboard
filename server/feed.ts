/**
 * Foreclosure complaints in the Reporting feed (docs/REPORTING_FEED_PLAN.md).
 *
 * GET /api/reporting/feed-complaints
 *   ?from=YYYY-MM-DD&to_before=YYYY-MM-DD  date window of the feed page, to_before exclusive
 *                                    (either omitted = open-ended)
 *   &search=…&entities=…&entities=…  the feed's own filters, applied to plaintiff / case / address
 *   &cfns=A,B,C                       the assignments on the page, to flag foreclosures on them
 *   &county=…                         same scope rule as the rest of the API
 *
 * Returns the complaints filed in the window (each with the earlier assignments
 * of the same property) and, for each assignment on the page, the complaints
 * filed on the same property.
 *
 * "Same property" = same county, same street address, and the same unit (or no
 * unit on either side). The unit matters: condo towers carry dozens of
 * mortgages under one street number (19201 Collins Ave matched 10 assignments
 * on street alone). Complaints carry no folio, so the address is all there is.
 * A match where the foreclosing plaintiff is also the firm that received the
 * assignment is marked `same_firm`, the strongest signal.
 */
import type { Express, Request, Response } from 'express'
import { getDb } from './db'
import { complaintFeedRows } from './complaints'

const DEFAULT_COUNTY = 'MIAMI-DADE'
const scope = (q: any): string | null => {
  const raw = String(q.county ?? '').trim().toUpperCase()
  if (!raw) return DEFAULT_COUNTY
  return raw === 'ALL' ? null : raw
}

const WORD: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', DRIVE: 'DR', PLACE: 'PL', COURT: 'CT', LANE: 'LN',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', TERRACE: 'TER', TERR: 'TER', ROAD: 'RD', CIRCLE: 'CIR', PARKWAY: 'PKWY',
  HIGHWAY: 'HWY', TRAIL: 'TRL', WAY: 'WAY',
}
const SUFFIXES = new Set(['AVE', 'ST', 'DR', 'PL', 'CT', 'LN', 'BLVD', 'TER', 'RD', 'CIR', 'PKWY', 'HWY', 'TRL', 'WAY'])
const UNIT_WORDS = new Set(['UNIT', 'APT', 'APARTMENT', 'STE', 'SUITE', '#', 'NO', 'PH', 'APSRIMENT'])

/** One key per address in the string ("a; b; c" lists several), as "street|unit". */
export function addressKeys(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(';')) {
    const toks = part.toUpperCase().replace(/#/g, ' # ').replace(/[^A-Z0-9# -]/g, ' ').replace(/-/g, '').split(/\s+/).filter(Boolean)
    if (!toks.length || !/^\d+$/.test(toks[0])) continue
    const street: string[] = [toks[0]]
    let unit = ''
    let i = 1
    for (; i < toks.length && street.length < 6; i++) {
      const t = WORD[toks[i]] ?? toks[i].replace(/^(\d+)(ST|ND|RD|TH)$/, '$1')
      if (UNIT_WORDS.has(toks[i])) break
      street.push(t)
      if (SUFFIXES.has(t)) { i++; break }
    }
    // Unit: the token after a unit word, possibly split ("16 C", "#30A").
    for (; i < toks.length; i++) {
      if (UNIT_WORDS.has(toks[i])) {
        let u = toks[i + 1] ?? ''
        if (u === '#') u = toks[i + 2] ?? ''
        const nxt = toks[i + (toks[i + 1] === '#' ? 3 : 2)]
        if (/^\d+$/.test(u) && nxt && /^[A-Z]$/.test(nxt)) u += nxt
        unit = u
        break
      }
    }
    if (street.length >= 2) out.push(`${street.join(' ')}|${unit}`)
  }
  return out
}

type Aom = { cfn: string; rec_date: string; county: string; assignor_canon: string; assignee_canon: string }
let aomIndex: { at: number; byKey: Map<string, Aom[]>; byCfn: Map<string, string[]> } | null = null

function getAomIndex() {
  if (aomIndex && Date.now() - aomIndex.at < 3600_000) return aomIndex
  const byKey = new Map<string, Aom[]>()
  const byCfn = new Map<string, string[]>()
  const rows = getDb().prepare(`
    SELECT cfn, rec_date, COALESCE(county, '${DEFAULT_COUNTY}') AS county, assignor_canon, assignee_canon, property_address
    FROM aom_events_clean WHERE property_address IS NOT NULL AND TRIM(property_address) != ''`).all() as (Aom & { property_address: string })[]
  for (const r of rows) {
    const keys = addressKeys(r.property_address).map(k => `${r.county}|${k}`)
    if (!keys.length) continue
    byCfn.set(r.cfn, keys)
    const { property_address, ...a } = r
    for (const k of keys) { const l = byKey.get(k); if (l) l.push(a); else byKey.set(k, [a]) }
  }
  aomIndex = { at: Date.now(), byKey, byCfn }
  return aomIndex
}

// Plaintiff as written ("CITIBANK, N.A., NOT IN ITS INDIVIDUAL CAPACITY…") ->
// our canonical firm name ("CITIBANK"): the longest canonical name the
// plaintiff starts with, so the feed can open that firm's profile.
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\bU S\b/g, 'US')
let nameIndex: { at: number; byFirst: Map<string, string[]> } | null = null
function canonicalFor(plaintiff: string | null): string | null {
  if (!plaintiff) return null
  if (!nameIndex || Date.now() - nameIndex.at > 3600_000) {
    const byFirst = new Map<string, string[]>()
    for (const { entity } of getDb().prepare(`SELECT entity FROM entity_nodes`).all() as { entity: string }[]) {
      const w = norm(entity).split(' ')[0]
      const l = byFirst.get(w); if (l) l.push(entity); else byFirst.set(w, [entity])
    }
    nameIndex = { at: Date.now(), byFirst }
  }
  const p = norm(plaintiff)
  let best: string | null = null
  for (const e of nameIndex.byFirst.get(p.split(' ')[0]) ?? []) {
    const n = norm(e)
    if ((p === n || p.startsWith(n + ' ')) && (!best || n.length > norm(best).length)) best = e
  }
  return best
}

const brief = (c: any) => ({
  case_id: c.case_id, case_number: c.case_number, filing_date: c.filing_date, plaintiff: c.plaintiff,
  plaintiff_entity: c.plaintiff_entity, verdict: c.verdict, principal: c.principal, result_reason: c.result_reason,
})

export function registerFeedRoutes(app: Express) {
  app.get('/api/reporting/feed-complaints', (req: Request, res: Response) => {
    const all = complaintFeedRows()
    if (!all) return res.json({ active: false, complaints: [], cfn_matches: {} })
    const county = scope(req.query)
    const idx = getAomIndex()

    const rows = all
      .filter(c => !county || (c.county ?? DEFAULT_COUNTY) === county)
      .map(c => {
        const keys = addressKeys(c.address).map(k => `${c.county ?? DEFAULT_COUNTY}|${k}`)
        const plaintiff_entity = canonicalFor(c.plaintiff)
        const seen = new Set<string>()
        const aom_matches: any[] = []
        for (const k of keys) for (const a of idx.byKey.get(k) ?? []) {
          if (seen.has(a.cfn)) continue
          seen.add(a.cfn)
          // Compare cleaned names: "M&T BANK" and "M & T BANK" are one firm under
          // two canonical spellings.
          const pn = norm(c.plaintiff ?? '')
          const an = norm(a.assignee_canon ?? '')
          aom_matches.push({ ...a, same_firm: !!an && (pn === an || pn.startsWith(an + ' ')) })
        }
        aom_matches.sort((x, y) => (y.rec_date || '').localeCompare(x.rec_date || ''))
        return { ...c, keys, plaintiff_entity, aom_matches }
      })

    // Assignments on this page -> complaints on the same property.
    const cfns = String(req.query.cfns ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200)
    const byKey = new Map<string, any[]>()
    for (const c of rows) for (const k of c.keys) { const l = byKey.get(k); if (l) l.push(c); else byKey.set(k, [c]) }
    const cfn_matches: Record<string, any[]> = {}
    for (const cfn of cfns) {
      const hits = new Map<string, any>()
      for (const k of idx.byCfn.get(cfn) ?? []) for (const c of byKey.get(k) ?? []) hits.set(c.case_id, c)
      if (hits.size) cfn_matches[cfn] = [...hits.values()].map(brief)
    }

    // Complaints filed in the page's date window, under the feed's filters.
    const from = String(req.query.from ?? '')
    const toBefore = String(req.query.to_before ?? '')
    const search = String(req.query.search ?? '').trim().toUpperCase()
    const ents = ([] as string[]).concat((req.query.entities as any) ?? []).map(String).filter(Boolean)
    const complaints = rows.filter(c => {
      const d = String(c.filing_date ?? '')
      if (from && d < from) return false
      if (toBefore && d >= toBefore) return false
      if (search && ![c.plaintiff, c.case_style, c.case_number, c.address].some(v => String(v ?? '').toUpperCase().includes(search))) return false
      if (ents.length && !ents.some(e => c.plaintiff_entity === e || norm(String(c.plaintiff ?? '')).startsWith(norm(e) + ' '))) return false
      return true
    }).map(({ keys, ...c }) => ({ ...c, aom_matches: c.aom_matches.slice(0, 5), aom_match_count: c.aom_matches.length }))

    res.json({ active: true, complaints, cfn_matches })
  })
}
