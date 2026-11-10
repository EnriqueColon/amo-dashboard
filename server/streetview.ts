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
}
