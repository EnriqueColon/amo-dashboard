/**
 * Firm logos (16 Nov 2026, owner: "bring in the logos for target entities instead of AB for Amerant Bank").
 *
 * A firm's logo is its website's own icon. Phase 1 (this file):
 *   - Website: typed on the firm card (entity_websites, source 'manual') wins; otherwise,
 *     for a firm typed BANK or hand-linked to an FDIC charter, the website FDIC publishes
 *     for that charter (WEBADDR; e.g. Amerant -> www.amerantbank.com). The charter comes
 *     from entity-fdic.ts (saved link, else the top suggestion).
 *   - Logo: fetched once per website domain by the server and stored in entity_logos
 *     (apple-touch-icon / <link rel=icon> / favicon.ico, the largest wins; Google's public
 *     favicon service as a last resort, which receives only the domain name). Served from
 *     /api/logo/:domain, so a viewer's browser never contacts the firm's site.
 *   - Scope: firms on Targets, every firm typed BANK with 10+ filings (so the big banks in
 *     the feed, e.g. Wells Fargo, which are not targets), and any firm with a hand-typed website.
 *   - BRAND_SITES: FDIC lists a few banks under a consumer brand's site (Goldman Sachs Bank
 *     USA -> marcus.com); the firm's own site is used instead.
 *   - Firms without a website or whose icon can't be fetched keep their initials.
 * Phase 2 (not built): AI-suggested websites for non-bank targets, confirmed by a person.
 *
 * A hand-typed website makes the server fetch a URL a user chose, so every request
 * (and every redirect hop) is refused unless the host resolves to public addresses only.
 */
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { lookup } from 'dns/promises'
import net from 'net'
import { getDb } from './db'
import { fdicCandidates, fdicHoldingCompany, normBankName } from './entity-fdic'
import { openBankStressDb } from './bank-stress'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const MAX_ICON_BYTES = 1_000_000
const RETRY_FAILED_AFTER_MS = 14 * 24 * 3600_000
const FDIC_REFRESH_MS = 7 * 24 * 3600_000

// ── tables ───────────────────────────────────────────────────────────────────

export function ensureTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_websites (
      entity     TEXT PRIMARY KEY,
      domain     TEXT,                 -- NULL = "no website" chosen by hand
      source     TEXT NOT NULL,        -- 'manual' (typed) | 'reviewed' (accepted suggestion)
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entity_logos (
      domain     TEXT PRIMARY KEY,
      status     TEXT NOT NULL,        -- 'ok' | 'none'
      mime       TEXT,
      bytes      BLOB,
      width      INTEGER,              -- pixels; 0 = scalable (SVG); NULL = unknown
      source_url TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fdic_websites (
      cert       INTEGER PRIMARY KEY,
      webaddr    TEXT,
      fetched_at TEXT NOT NULL
    );
  `)
}

// ── domains ──────────────────────────────────────────────────────────────────

/** "https://www.AmerantBank.com/personal" -> "www.amerantbank.com"; null when not a usable public host name. */
export function toDomain(input: string | null | undefined): string | null {
  let s = String(input ?? '').trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`
  let host: string
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return null
    host = u.hostname.replace(/\.$/, '')
  } catch {
    return null
  }
  if (net.isIP(host)) return null
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(host)) return null
  return host
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const x = ip.toLowerCase()
  if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7))
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')
}

export async function hostIsPublic(host: string): Promise<boolean> {
  if (!toDomain(host)) return false
  try {
    const addrs = await lookup(host, { all: true })
    return addrs.length > 0 && addrs.every(a => !isPrivateAddress(a.address))
  } catch {
    return false
  }
}

/** GET with manual redirects; every hop must be http(s) on a public host. */
export async function safeGet(url: string, maxBytes: number, timeoutMs = 10_000): Promise<{ status: number; url: string; type: string; body: Buffer } | null> {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    let u: URL
    try { u = new URL(current) } catch { return null }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!(await hostIsPublic(u.hostname))) return null
    let res: globalThis.Response
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: 'text/html,image/*,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      res.body?.cancel().catch(() => {})
      if (!loc) return null
      current = new URL(loc, current).toString()
      continue
    }
    const chunks: Buffer[] = []
    let n = 0
    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done || !value) break
        n += value.byteLength
        if (n > maxBytes) { reader.cancel().catch(() => {}); return { status: 413, url: current, type: '', body: Buffer.alloc(0) } }
        chunks.push(Buffer.from(value))
      }
    }
    return { status: res.status, url: current, type: (res.headers.get('content-type') || '').toLowerCase(), body: Buffer.concat(chunks) }
  }
  return null
}

// ── icons ────────────────────────────────────────────────────────────────────

type Icon = { mime: string; bytes: Buffer; width: number | null; source: string }

/** Width in pixels of a PNG / ICO / JPEG / GIF / WebP; 0 for SVG; null when unknown. */
export function imageWidth(buf: Buffer, mime: string): number | null {
  if (mime.includes('svg')) return 0
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16)
  if (buf.length > 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    const count = buf.readUInt16LE(4)
    let best = 0
    for (let i = 0; i < count && 6 + 16 * (i + 1) <= buf.length; i++) best = Math.max(best, buf[6 + 16 * i] || 256)
    return best || null
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return buf.readUInt16LE(6)
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return 1 + buf.readUIntLE(24, 3)
    if (kind === 'VP8L') return 1 + (buf.readUInt16LE(21) & 0x3fff)
    if (kind === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xc3) return buf.readUInt16BE(i + 7)
      i += 2 + len
    }
  }
  return null
}

function sniffMime(buf: Buffer, declared: string): string | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length > 4 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return 'image/x-icon'
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 4 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 400)).trimStart().toLowerCase()
  if ((declared.includes('svg') || head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) return 'image/svg+xml'
  return null
}

/** Icon links in a home page, best first: apple-touch-icon, then sized icons by size. */
export function iconLinks(html: string, base: string): string[] {
  const out: Array<{ href: string; score: number }> = []
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1] || '').toLowerCase()
    if (!/\b(icon|apple-touch-icon(-precomposed)?)\b/.test(rel) || rel.includes('mask-icon')) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/\bhref\s*=\s*([^\s>]+)/i)?.[1]
    if (!href || href.startsWith('data:')) continue
    const size = Number((tag.match(/\bsizes\s*=\s*["']?(\d+)x\d+/i)?.[1]) || 0)
    const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + (/\.svg(\?|$)/i.test(href) ? 500 : 0) + size
    try { out.push({ href: new URL(href.replace(/&amp;/g, '&'), base).toString(), score }) } catch { /* skip */ }
  }
  return [...new Set(out.sort((a, b) => b.score - a.score).map(x => x.href))]
}

async function tryIcon(url: string): Promise<Icon | null> {
  const r = await safeGet(url, MAX_ICON_BYTES)
  if (!r || r.status !== 200 || r.body.length < 100) return null
  const mime = sniffMime(r.body, r.type)
  if (!mime) return null
  return { mime, bytes: r.body, width: imageWidth(r.body, mime), source: r.url }
}

const rank = (i: Icon) => (i.width === 0 ? 10_000 : i.width ?? 1)

export async function fetchLogo(domain: string): Promise<Icon | null> {
  const home = await safeGet(`https://${domain}/`, 2_000_000)
  const base = home?.url || `https://${domain}/`
  const origin = new URL(base).origin
  const candidates = [
    ...(home && home.status === 200 ? iconLinks(home.body.toString('utf8'), base) : []),
    `${origin}/apple-touch-icon.png`,
    `${origin}/favicon.ico`,
  ]
  let best: Icon | null = null
  for (const c of [...new Set(candidates)].slice(0, 6)) {
    const icon = await tryIcon(c)
    if (icon && (!best || rank(icon) > rank(best))) best = icon
    if (best && rank(best) >= 120) break
  }
  if (!best || rank(best) < 48) {
    // Many bank sites refuse servers; Google's favicon service usually has their icon.
    const g = await tryIcon(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`)
    if (g && (!best || rank(g) > rank(best))) best = { ...g, source: `google-favicons:${domain}` }
  }
  // A 16px favicon stretched to an avatar looks blurred; initials read better.
  if (best && best.width != null && best.width !== 0 && best.width < 32) return null
  return best
}

// ── FDIC websites ────────────────────────────────────────────────────────────

let fdicLoad: Promise<void> | null = null

async function refreshFdicWebsites(db: Database.Database): Promise<void> {
  const last = db.prepare(`SELECT MAX(fetched_at) AS t FROM fdic_websites`).get() as { t: string | null }
  if (last.t && Date.now() - Date.parse(last.t) < FDIC_REFRESH_MS) return
  if (!fdicLoad) {
    fdicLoad = (async () => {
      try {
        const res = await fetch('https://api.fdic.gov/banks/institutions?filters=ACTIVE:1&fields=CERT,WEBADDR&limit=10000', {
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw new Error(`FDIC HTTP ${res.status}`)
        const j = await res.json() as { data?: Array<{ data: { CERT: number; WEBADDR?: string | null } }> }
        const rows = (j.data ?? []).map(d => d.data).filter(d => Number.isInteger(d.CERT))
        if (rows.length < 1000) throw new Error(`FDIC returned only ${rows.length} institutions`)
        const now = new Date().toISOString()
        const up = db.prepare(`INSERT INTO fdic_websites (cert, webaddr, fetched_at) VALUES (?, ?, ?)
                               ON CONFLICT(cert) DO UPDATE SET webaddr = excluded.webaddr, fetched_at = excluded.fetched_at`)
        db.transaction(() => { for (const r of rows) up.run(r.CERT, r.WEBADDR || null, now) })()
        console.log(`[logos] FDIC websites loaded for ${rows.length} institutions`)
      } catch (err) {
        console.warn('[logos] FDIC website load failed:', err instanceof Error ? err.message : err)
      } finally {
        fdicLoad = null
      }
    })()
  }
  return fdicLoad
}

// ── which website a firm has ─────────────────────────────────────────────────

type Site = { domain: string | null; source: 'manual' | 'reviewed' | 'fdic' | null; cert?: number | null }

/** FDIC WEBADDR that is a consumer brand, not the firm (checked 16 Nov 2026). */
const BRAND_SITES: Record<string, string> = {
  'www.marcus.com': 'www.goldmansachs.com',      // Goldman Sachs Bank USA
  'www.etrade.com': 'www.morganstanley.com',     // Morgan Stanley Private Bank
}

function isBankLike(db: Database.Database, entity: string): boolean {
  const typed = db.prepare(`SELECT 1 FROM entity_nodes WHERE entity = ? AND entity_type = 'BANK'
                            UNION SELECT 1 FROM entity_classifications WHERE name = ? AND category = 'BANK' LIMIT 1`).get(entity, entity)
  if (typed) return true
  try {
    return !!db.prepare(`SELECT 1 FROM entity_fdic_links WHERE entity = ? AND status = 'confirmed'`).get(entity)
  } catch {
    return false
  }
}

export function websiteFor(db: Database.Database, entity: string): Site {
  // 'manual' = typed on the card; 'reviewed' = an AI suggestion a person accepted (entity-website-suggest.ts).
  const manual = db.prepare(`SELECT domain, source FROM entity_websites WHERE entity = ?`).get(entity) as { domain: string | null; source: string } | undefined
  if (manual) return { domain: manual.domain, source: manual.source === 'reviewed' ? 'reviewed' : 'manual' }
  if (!isBankLike(db, entity)) return { domain: null, source: null }
  // A one-word name ("FIRST") only takes an FDIC bank whose name is exactly that word;
  // otherwise it would borrow the largest bank whose name merely starts with it.
  const linked = db.prepare(`SELECT 1 FROM entity_fdic_links WHERE entity = ? AND status = 'confirmed'`).get(entity)
  if (!linked && !normBankName(entity).includes(' ')) {
    const bs = openBankStressDb()
    if (!bs || !fdicCandidates(bs, entity)[0]?.exact) return { domain: null, source: null }
  }
  const fdic = fdicHoldingCompany(entity)
  if (!fdic) return { domain: null, source: null }
  const w = db.prepare(`SELECT webaddr FROM fdic_websites WHERE cert = ?`).get(fdic.cert) as { webaddr: string | null } | undefined
  const d = toDomain(w?.webaddr)
  return { domain: d ? (BRAND_SITES[d] ?? d) : null, source: 'fdic', cert: fdic.cert }
}

// ── background fill ──────────────────────────────────────────────────────────

const inFlight = new Set<string>()
let queue: string[] = []
let running = 0

export function enqueue(db: Database.Database, domains: string[]) {
  for (const d of domains) if (!inFlight.has(d)) { inFlight.add(d); queue.push(d) }
  while (running < 3 && queue.length) {
    const d = queue.shift()!
    running++
    void (async () => {
      try {
        const icon = await fetchLogo(d)
        db.prepare(`INSERT INTO entity_logos (domain, status, mime, bytes, width, source_url, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(domain) DO UPDATE SET status = excluded.status, mime = excluded.mime, bytes = excluded.bytes,
                      width = excluded.width, source_url = excluded.source_url, fetched_at = excluded.fetched_at`)
          .run(d, icon ? 'ok' : 'none', icon?.mime ?? null, icon?.bytes ?? null, icon?.width ?? null, icon?.source ?? null, new Date().toISOString())
      } catch (err) {
        console.warn(`[logos] ${d}:`, err instanceof Error ? err.message : err)
      } finally {
        inFlight.delete(d)
        running--
        enqueue(db, [])
      }
    })()
  }
}

// ── routes ───────────────────────────────────────────────────────────────────

export function registerEntityLogoRoutes(app: Express) {
  const db = getDb()
  ensureTables(db)

  // Map of firm name -> logo URL for every firm that has one (Targets, busy banks, hand-typed websites).
  // Also starts fetching logos not yet tried, so they appear on a later load.
  app.get('/api/entity-logos', async (_req: Request, res: Response) => {
    await refreshFdicWebsites(db)
    const names = new Set<string>()
    for (const r of db.prepare(`SELECT entity FROM target_entities`).all() as { entity: string }[]) names.add(r.entity)
    for (const r of db.prepare(`SELECT entity FROM entity_nodes WHERE entity_type = 'BANK' AND total_vol >= 10`).all() as { entity: string }[]) names.add(r.entity)
    for (const r of db.prepare(`SELECT entity FROM entity_websites WHERE domain IS NOT NULL`).all() as { entity: string }[]) names.add(r.entity)

    const logos = new Map<string, { status: string; fetched_at: string }>()
    for (const r of db.prepare(`SELECT domain, status, fetched_at FROM entity_logos`).all() as any[]) logos.set(r.domain, r)

    const out: Record<string, string> = {}
    const missing: string[] = []
    for (const name of names) {
      const site = websiteFor(db, name)
      if (!site.domain) continue
      const l = logos.get(site.domain)
      if (l?.status === 'ok') out[name.toUpperCase()] = `/api/logo/${encodeURIComponent(site.domain)}?v=${encodeURIComponent(l.fetched_at)}`
      else if (!l || Date.now() - Date.parse(l.fetched_at) > RETRY_FAILED_AFTER_MS) missing.push(site.domain)
    }
    if (missing.length) enqueue(db, [...new Set(missing)])
    res.json({ logos: out, pending: missing.length })
  })

  app.get('/api/logo/:domain', (req: Request, res: Response) => {
    const domain = toDomain(String(req.params.domain ?? ''))
    const row = domain && db.prepare(`SELECT mime, bytes FROM entity_logos WHERE domain = ? AND status = 'ok'`).get(domain) as { mime: string; bytes: Buffer } | undefined
    if (!row) return res.status(404).end()
    res.setHeader('Content-Type', row.mime)
    res.setHeader('Cache-Control', 'private, max-age=604800')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // An SVG opened directly must not run script on our origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    res.end(row.bytes)
  })

  app.get('/api/entity/:name/website', async (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    if (!entity) return res.status(400).json({ error: 'name required' })
    await refreshFdicWebsites(db)
    const site = websiteFor(db, entity)
    const l = site.domain ? db.prepare(`SELECT status, width, source_url, fetched_at FROM entity_logos WHERE domain = ?`).get(site.domain) as any : null
    if (site.domain && !l) enqueue(db, [site.domain])
    res.json({
      ...site,
      logo: l?.status === 'ok' ? `/api/logo/${encodeURIComponent(site.domain!)}?v=${encodeURIComponent(l.fetched_at)}` : null,
      logo_status: !site.domain ? null : l ? l.status : 'pending',
      logo_width: l?.width ?? null,
      logo_source: l?.source_url ?? null,
    })
  })

  // Body: { website: "amerantbank.com" } to set; { website: null } for "no website".
  app.put('/api/entity/:name/website', async (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    const raw = (req.body ?? {}).website
    if (!entity) return res.status(400).json({ error: 'name required' })
    let domain: string | null = null
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      domain = toDomain(String(raw))
      if (!domain) return res.status(400).json({ error: 'Enter a website like amerantbank.com' })
      if (!(await hostIsPublic(domain))) return res.status(400).json({ error: `${domain} could not be found on the internet` })
    }
    db.prepare(`INSERT INTO entity_websites (entity, domain, source, updated_at) VALUES (?, ?, 'manual', ?)
                ON CONFLICT(entity) DO UPDATE SET domain = excluded.domain, source = 'manual', updated_at = excluded.updated_at`)
      .run(entity, domain, new Date().toISOString())
    if (domain) {
      db.prepare(`DELETE FROM entity_logos WHERE domain = ? AND status = 'none'`).run(domain)
      enqueue(db, [domain])
    }
    res.json({ ok: true, domain })
  })

  // Back to automatic (FDIC for banks, none otherwise).
  app.delete('/api/entity/:name/website', (req: Request, res: Response) => {
    const entity = decodeURIComponent(String(req.params.name ?? '')).trim()
    db.prepare(`DELETE FROM entity_websites WHERE entity = ?`).run(entity)
    res.json({ ok: true })
  })
}
