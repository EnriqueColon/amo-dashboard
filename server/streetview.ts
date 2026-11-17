/**
 * Street View photo for a property address (address hover cards on the Complaints tab).
 *
 *   GET /api/streetview/status          -> { enabled }  (false until GOOGLE_MAPS_API_KEY is set)
 *   GET /api/streetview?address=...     -> image/jpeg, or 404 when Google has no imagery there
 *
 * The key never reaches the browser: the server asks Google's free metadata endpoint whether imagery exists,
 * then fetches the Street View Static image and caches it on disk (STREETVIEW_CACHE_DIR), so each address is
 * billed at most once. A "no imagery" answer is cached too. Addresses that do not start with a house number
 * ("XXX Bermuda Road", redacted or partial) are refused, since Google would show some other spot on the street.
 *
 *   GET /api/staticmap?address=...      -> image/png, a street map with a red pin on the address (Maps Static API,
 *                                          enabled on the key 17 Nov 2026). Google places the pin from the address
 *                                          itself; business and transit labels are hidden. Cached on disk the same way.
 */
import type { Express, Request, Response } from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const CACHE_DIR = process.env.STREETVIEW_CACHE_DIR || path.resolve('streetview_cache')
const BASE = 'https://maps.googleapis.com/maps/api/streetview'

export function normalizeAddress(a: unknown): string | null {
  const s = String(a ?? '').replace(/\s+/g, ' ').trim()
  return /^\d+[A-Za-z]?\b/.test(s) && s.length <= 200 ? s : null
}

const STATIC_MAP = 'https://maps.googleapis.com/maps/api/staticmap'

/**
 * The Maps Static API query for one address (without the key): 374x235, the hover card's frame exactly, at double
 * resolution. Any wider and the card crops Google's logo and "Map data" credit, which must stay visible.
 */
export function staticMapQuery(address: string): string {
  const p = new URLSearchParams()
  p.set('size', '374x235')
  p.set('scale', '2')
  p.set('zoom', '16')
  p.set('markers', `color:red|${address}`)
  p.append('style', 'feature:poi|visibility:off')
  p.append('style', 'feature:transit|visibility:off')
  return p.toString()
}

export function registerStreetViewRoutes(app: Express) {
  app.get('/api/streetview/status', (_req: Request, res: Response) => {
    res.json({ enabled: !!process.env.GOOGLE_MAPS_API_KEY })
  })

  app.get('/api/streetview', async (req: Request, res: Response) => {
    const key = process.env.GOOGLE_MAPS_API_KEY
    const address = normalizeAddress(req.query.address)
    if (!key) return res.status(404).json({ error: 'street view not configured' })
    if (!address) return res.status(404).json({ error: 'no street address' })
    const id = crypto.createHash('sha256').update(address.toLowerCase()).digest('hex')
    const jpg = path.join(CACHE_DIR, id + '.jpg')
    const none = path.join(CACHE_DIR, id + '.none')
    const send = () => res.set('Cache-Control', 'private, max-age=2592000').type('image/jpeg').sendFile(jpg)
    if (fs.existsSync(jpg)) return send()
    if (fs.existsSync(none)) return res.status(404).json({ error: 'no imagery' })
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const q = `location=${encodeURIComponent(address)}&source=outdoor&key=${encodeURIComponent(key)}`
      const meta = await (await fetch(`${BASE}/metadata?${q}`)).json() as { status?: string }
      if (meta.status !== 'OK') {
        if (meta.status === 'ZERO_RESULTS' || meta.status === 'NOT_FOUND') fs.writeFileSync(none, meta.status)
        return res.status(404).json({ error: 'no imagery', status: meta.status })
      }
      const img = await fetch(`${BASE}?size=640x376&fov=80&${q}`)
      if (!img.ok || !(img.headers.get('content-type') ?? '').startsWith('image/')) {
        return res.status(502).json({ error: `street view image request failed (${img.status})` })
      }
      fs.writeFileSync(jpg, Buffer.from(await img.arrayBuffer()))
      return send()
    } catch (e: any) {
      return res.status(502).json({ error: 'street view request failed' })
    }
  })

  app.get('/api/staticmap', async (req: Request, res: Response) => {
    const key = process.env.GOOGLE_MAPS_API_KEY
    const address = normalizeAddress(req.query.address)
    if (!key) return res.status(404).json({ error: 'maps not configured' })
    if (!address) return res.status(404).json({ error: 'no street address' })
    const id = crypto.createHash('sha256').update(address.toLowerCase()).digest('hex')
    const png = path.join(CACHE_DIR, id + '.map.png')
    const send = () => res.set('Cache-Control', 'private, max-age=2592000').type('image/png').sendFile(png)
    if (fs.existsSync(png)) return send()
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const img = await fetch(`${STATIC_MAP}?${staticMapQuery(address)}&key=${encodeURIComponent(key)}`)
      if (!img.ok || !(img.headers.get('content-type') ?? '').startsWith('image/')) {
        return res.status(502).json({ error: `map image request failed (${img.status})` })
      }
      fs.writeFileSync(png, Buffer.from(await img.arrayBuffer()))
      return send()
    } catch {
      return res.status(502).json({ error: 'map request failed' })
    }
  })
}
