/**
 * Firm logos, phase 2 (16 Nov 2026): suggested websites for targets that have none.
 *
 * Banks get their website from FDIC (entity-logos.ts). The other targets — mostly
 * private lenders, funds and brokers from the owner's "Lenders and Brokers Contacts"
 * list — have nothing we hold that names a website, so an OpenAI web search suggests
 * one. A suggestion NEVER becomes the firm's website by itself: a person accepts or
 * rejects it (review list on the Targets page, or the Website line on the firm card).
 * Accepting writes entity_websites with source 'reviewed'; the logo follows.
 *
 * Guard rails: the model is told to return null rather than guess between firms that
 * share a name; directory/social/regulator domains are refused; the suggested site
 * must resolve to public addresses; and the site's home page title and domain are
 * checked for the firm's distinctive name words ("name match"), shown to the reviewer.
 */
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getDb } from './db'
import { callOpenAiJson, getOpenAiApiKey } from './intel/openai'
import { enqueue, ensureTables as ensureLogoTables, hostIsPublic, safeGet, toDomain, websiteFor } from './entity-logos'

/** Rough cost of one web-search call on the default model, for the batch budget (an estimate, not a bill). */
export const EST_COST_PER_CALL_USD = 0.03

const NOT_A_COMPANY_SITE = /(^|\.)(linkedin|bloomberg|zoominfo|crunchbase|opencorporates|sunbiz|bizapedia|buzzfile|dnb|nmlsconsumeraccess|bbb|yelp|facebook|instagram|twitter|x|youtube|wikipedia|google|sec|finra|fdic|ffiec|manta|corporationwiki|pitchbook|cbinsights|glassdoor|indeed|mapquest|yellowpages|chamberofcommerce|dandb|signalhire|rocketreach|owler|unicourt|courtlistener|justia|prnewswire|businesswire|globenewswire|therealdeal|bisnow|commercialobserver|costar|loopnet|crexi)\.[a-z.]+$/

// Words that say what kind of firm it is, not which one.
const GENERIC = new Set([
  'the', 'and', 'of', 'llc', 'inc', 'corp', 'co', 'company', 'corporation', 'lp', 'llp', 'ltd', 'na', 'fsb', 'usa', 'us', 'group', 'holdings', 'holding',
  'capital', 'lending', 'lender', 'lenders', 'loan', 'loans', 'financial', 'finance', 'funding', 'fund', 'funds', 'mortgage', 'mortgages', 'partners', 'partner',
  'investment', 'investments', 'investors', 'asset', 'assets', 'management', 'advisors', 'advisers', 'credit', 'equity', 'real', 'estate', 'realty', 'properties',
  'property', 'bank', 'banking', 'trust', 'savings', 'national', 'association', 'services', 'solutions', 'commercial', 'residential', 'private', 'ventures', 'global',
])

/** Distinctive words of a firm name: "STORMFIELD CAPITAL" -> ["stormfield"]. */
export function distinctiveWords(name: string): string[] {
  return name.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !GENERIC.has(w))
}

/** Share of the firm's distinctive words found in the site's domain or home page title (0..1); null when the name has none. */
export function nameMatch(name: string, domain: string, title: string): number | null {
  const words = distinctiveWords(name)
  if (!words.length) return null
  const host = domain.toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('.').replace(/[^a-z0-9]/g, '')
  const t = title.toLowerCase()
  const hit = words.filter(w => host.includes(w) || new RegExp(`\\b${w}\\b`).test(t)).length
  return hit / words.length
}

function ensureTable(db: Database.Database) {
  ensureLogoTables(db)
  db.exec(`CREATE TABLE IF NOT EXISTS entity_website_suggestions (
    entity       TEXT PRIMARY KEY,
    domain       TEXT,            -- NULL = the search found no website it could stand behind
    company_name TEXT,
    location     TEXT,
    confidence   TEXT,            -- 'high' | 'medium' | 'low' (the model's own)
    reason       TEXT,
    name_match   REAL,            -- share of distinctive name words on the site; NULL = not checkable
    page_title   TEXT,
    status       TEXT NOT NULL,   -- 'pending' | 'accepted' | 'rejected' | 'none'
    model        TEXT,
    suggested_at TEXT NOT NULL,
    reviewed_at  TEXT
  )`)
}

/** What we know about a firm, to tell the search which company is meant. */
function context(db: Database.Database, entity: string): string[] {
  const lines: string[] = []
  const t = db.prepare(`SELECT notes FROM target_entities WHERE entity = ?`).get(entity) as { notes: string | null } | undefined
  const kind = t?.notes?.split('·')[1]?.trim()
  if (kind) lines.push(`Type in our contacts list: ${kind}.`)
  try {
    const a = db.prepare(`SELECT COUNT(*) AS n, MIN(rec_date) AS first, MAX(rec_date) AS last, GROUP_CONCAT(DISTINCT county) AS counties
                          FROM aom_events_clean WHERE assignor_canon = ? OR assignee_canon = ?`).get(entity, entity) as any
    if (a?.n) lines.push(`${a.n} recorded mortgage assignments ${a.first?.slice(0, 4)}–${a.last?.slice(0, 4)} in ${String(a.counties || 'Florida').toLowerCase()} county.`)
    const cps = db.prepare(`SELECT CASE WHEN assignor_canon = ? THEN assignee_canon ELSE assignor_canon END AS other, COUNT(*) AS n
                            FROM aom_events_clean WHERE assignor_canon = ? OR assignee_canon = ? GROUP BY other ORDER BY n DESC LIMIT 4`).all(entity, entity, entity) as any[]
    if (cps.length) lines.push(`Most frequent counterparties: ${cps.map(c => c.other).join(', ')}.`)
    const raw = db.prepare(`SELECT assignee FROM aom_events_clean WHERE assignee_canon = ? AND assignee IS NOT NULL LIMIT 1`).get(entity) as any
    if (raw?.assignee && raw.assignee.toUpperCase() !== entity) lines.push(`Full name on a recorded document: ${raw.assignee}.`)
  } catch { /* table missing in some local copies */ }
  return lines
}

export type Suggestion = {
  entity: string; domain: string | null; company_name: string | null; location: string | null; confidence: string | null
  reason: string | null; name_match: number | null; page_title: string | null; status: string
}

/** One web search for one firm; stores and returns the suggestion (status 'pending', or 'none'). */
export async function suggestWebsite(db: Database.Database, entity: string): Promise<Suggestion> {
  ensureTable(db)
  if (!getOpenAiApiKey()) throw new Error('OPENAI_API_KEY is not set')
  const ctx = context(db, entity)
  const user = `Find the official website of this firm.

Name as written in Florida county records or our contacts list: "${entity}"
${ctx.join('\n')}
The firm lends on or invests in real estate (commercial or residential mortgages, bridge loans, private credit) or brokers such loans, and is active in Florida (Miami-Dade, Broward, Hillsborough), though it may be based elsewhere.

Rules:
- Return the company's OWN website domain. Never a directory, news, social media, regulator or data site (LinkedIn, Bloomberg, ZoomInfo, Crunchbase, Sunbiz, OpenCorporates, NMLS, BBB, Yelp, Facebook, LoopNet, The Real Deal).
- If several companies share this name and you cannot tell which one lends on real estate in Florida, or you find no website, return "website": null.
- Do not invent a domain from the name; only return a site you saw in the search results.

Return ONLY JSON:
{"website": "example.com" or null, "company_name": "name as shown on the site", "location": "head office city, state", "confidence": "high" | "medium" | "low", "reason": "one sentence: why this site is this firm"}`

  const model = process.env.OPENAI_FAST_MODEL?.trim() || 'gpt-4.1-mini'
  const notes: string[] = []
  const j = await callOpenAiJson({
    system: 'You identify the official website of a company. Use the web search tool. Return ONLY valid JSON. Prefer null over a guess.',
    user, tier: 'fast', temperature: 0, maxTokens: 400, webSearch: true,
  }, notes)
  if (!j && notes.some(n => /OpenAI call failed/.test(n))) throw new Error(notes.join(' '))

  let domain = toDomain(typeof j?.website === 'string' ? j.website : null)
  let reason = typeof j?.reason === 'string' ? j.reason.slice(0, 400) : null
  if (domain && NOT_A_COMPANY_SITE.test(domain)) { reason = `Refused ${domain}: a directory or news site, not the firm's own. ${reason ?? ''}`.trim(); domain = null }
  let title = ''
  if (domain && !(await hostIsPublic(domain))) { reason = `Refused ${domain}: it does not resolve on the internet. ${reason ?? ''}`.trim(); domain = null }
  if (domain) {
    const home = await safeGet(`https://${domain}/`, 1_500_000)
    title = home?.status === 200 ? (home.body.toString('utf8').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    enqueue(db, [domain])   // fetch its icon now so the reviewer sees the logo
  }
  const row: Suggestion = {
    entity, domain,
    company_name: typeof j?.company_name === 'string' ? j.company_name.slice(0, 200) : null,
    location: typeof j?.location === 'string' ? j.location.slice(0, 120) : null,
    confidence: ['high', 'medium', 'low'].includes(j?.confidence) ? j.confidence : null,
    reason,
    name_match: domain ? nameMatch(entity, domain, title) : null,
    page_title: title || null,
    status: domain ? 'pending' : 'none',
  }
  db.prepare(`INSERT INTO entity_website_suggestions (entity, domain, company_name, location, confidence, reason, name_match, page_title, status, model, suggested_at, reviewed_at)
              VALUES (@entity, @domain, @company_name, @location, @confidence, @reason, @name_match, @page_title, @status, @model, @at, NULL)
              ON CONFLICT(entity) DO UPDATE SET domain = excluded.domain, company_name = excluded.company_name, location = excluded.location,
                confidence = excluded.confidence, reason = excluded.reason, name_match = excluded.name_match, page_title = excluded.page_title,
                status = excluded.status, model = excluded.model, suggested_at = excluded.suggested_at, reviewed_at = NULL`)
    .run({ ...row, model, at: new Date().toISOString() })
  return row
}

/** Targets with no website (none from FDIC, none typed) and no suggestion yet. */
export function targetsNeedingSuggestion(db: Database.Database, redo = false): string[] {
  ensureTable(db)
  const done = new Set((db.prepare(`SELECT entity FROM entity_website_suggestions`).all() as { entity: string }[]).map(r => r.entity))
  return (db.prepare(`SELECT entity FROM target_entities ORDER BY entity`).all() as { entity: string }[])
    .map(r => r.entity)
    .filter(e => (redo || !done.has(e)) && !db.prepare(`SELECT 1 FROM entity_websites WHERE entity = ?`).get(e) && !websiteFor(db, e).domain)
}

function acceptSuggestion(db: Database.Database, entity: string, domain: string) {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO entity_websites (entity, domain, source, updated_at) VALUES (?, ?, 'reviewed', ?)
              ON CONFLICT(entity) DO UPDATE SET domain = excluded.domain, source = 'reviewed', updated_at = excluded.updated_at`).run(entity, domain, now)
  db.prepare(`UPDATE entity_website_suggestions SET status = 'accepted', domain = ?, reviewed_at = ? WHERE entity = ?`).run(domain, now, entity)
  enqueue(db, [domain])
}

export function registerWebsiteSuggestionRoutes(app: Express) {
  const db = getDb()
  ensureTable(db)

  // Review list: pending suggestions (best evidence first) plus counts by status.
  app.get('/api/website-suggestions', (_req: Request, res: Response) => {
    const counts = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM entity_website_suggestions GROUP BY status`).all() as any[]).map(r => [r.status, r.n]))
    const logos = new Map((db.prepare(`SELECT domain, fetched_at FROM entity_logos WHERE status = 'ok'`).all() as any[]).map(r => [r.domain, r.fetched_at]))
    const rows = (db.prepare(`SELECT * FROM entity_website_suggestions WHERE status = 'pending'
                              ORDER BY COALESCE(name_match, 0) DESC, CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, entity`).all() as any[])
      .map(r => ({ ...r, logo: logos.has(r.domain) ? `/api/logo/${encodeURIComponent(r.domain)}?v=${encodeURIComponent(logos.get(r.domain))}` : null }))
    const tried = new Set((db.prepare(`SELECT domain FROM entity_logos`).all() as any[]).map(r => r.domain))
    const missing = rows.filter(r => r.domain && !tried.has(r.domain)).map(r => r.domain)
    if (missing.length) enqueue(db, missing)   // previews for the reviewer
    const waiting = targetsNeedingSuggestion(db).length
    res.json({ counts, waiting, rows, previews_pending: missing.length })
  })

  // Body (optional): { domain } to accept a corrected website instead of the suggested one.
  app.post('/api/website-suggestions/:entity/accept', async (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.entity ?? '')).trim()
    const s = db.prepare(`SELECT domain FROM entity_website_suggestions WHERE entity = ?`).get(entity) as { domain: string | null } | undefined
    if (!s) return res.status(404).json({ error: 'no suggestion for this firm' })
    const domain = req.body?.domain ? toDomain(String(req.body.domain)) : s.domain
    if (!domain) return res.status(400).json({ error: 'Enter a website like example.com' })
    if (!(await hostIsPublic(domain))) return res.status(400).json({ error: `${domain} could not be found on the internet` })
    acceptSuggestion(db, entity, domain)
    res.json({ ok: true, domain })
  })

  app.post('/api/website-suggestions/:entity/reject', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.entity ?? '')).trim()
    const r = db.prepare(`UPDATE entity_website_suggestions SET status = 'rejected', reviewed_at = ? WHERE entity = ?`).run(new Date().toISOString(), entity)
    if (!r.changes) return res.status(404).json({ error: 'no suggestion for this firm' })
    res.json({ ok: true })
  })

  // "Suggest a website" on the firm card: one search now (about 3 cents).
  app.post('/api/entity/:name/website/suggest', async (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    if (!entity) return res.status(400).json({ error: 'name required' })
    if (!getOpenAiApiKey()) return res.status(503).json({ error: 'Website suggestions are not configured (no OpenAI key).' })
    try {
      res.json(await suggestWebsite(db, entity))
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/entity/:name/website/suggestion', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    res.json(db.prepare(`SELECT * FROM entity_website_suggestions WHERE entity = ?`).get(entity) ?? null)
  })
}
