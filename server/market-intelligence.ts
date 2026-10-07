/**
 * Market Intelligence — the data source for the "FDIC Data Analytics" page.
 *
 * Since 2026-10-07 this app no longer computes FDIC analytics itself. The
 * Market Intelligence tool's Market Analytics data API is the source of truth:
 * screening rows, scores, cohort watch, behaviour signals and the per-bank
 * drawer all come from it, and this module is the only place that talks to it.
 *
 * Contract reference: docs/market-intelligence-meta.json (a saved copy of
 * GET /api/analytics/v1/meta). Every success is
 *   { ok: true, meta: { quarter, scope, contractVersion, servedAt }, ...payload }
 * and every failure is { ok: false, error } with 400/401/502/503.
 *
 * Configuration (both required, read from process.env):
 *   MI_BASE_URL           e.g. https://market-intelligence-tool-gilt.vercel.app
 *   MI_ANALYTICS_API_KEY  bearer token. It never leaves this process: the
 *                         browser talks to /api/mi/*, which is behind checkAuth,
 *                         and this module adds the Authorization header.
 *
 * Caching: ok:true responses are stored in server/cache.ts for the same 7-day
 * horizon the FDIC proxy used, keyed by endpoint + scope + band + cert. Failures
 * are never cached, so a transient upstream error does not pin a blank page
 * for a week. Note the figures therefore change only when Market Intelligence's
 * own cache refreshes (a daily job keyed by FDIC quarter) AND this cache is
 * cleared (pm2 restart or POST /api/cache/bust).
 */

import type { Express, Request, Response } from 'express'
import { getCached, setCached, makeCacheKey, DEFAULT_TTL_MS } from './cache'

const MI_API_PREFIX = '/api/analytics/v1'
const UPSTREAM_TIMEOUT_MS = 60_000

// Read at call time rather than module load so a test or a dev shell can set
// the variables after import. Trailing slash stripped so BASE + path is stable.
function readConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = (process.env.MI_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const apiKey = (process.env.MI_ANALYTICS_API_KEY ?? '').trim()
  if (!baseUrl || !apiKey) return null
  return { baseUrl, apiKey }
}

export function isMarketIntelligenceConfigured(): boolean {
  return readConfig() !== null
}

export const MI_UNCONFIGURED_MESSAGE =
  'Market Intelligence is not configured — set MI_BASE_URL and MI_ANALYTICS_API_KEY in the server environment and restart.'

/** Called once at startup so a missing key is visible in the PM2 log, not only on first click. */
export function warnIfMarketIntelligenceUnconfigured(log: (msg: string, source?: string) => void) {
  const missing = ['MI_BASE_URL', 'MI_ANALYTICS_API_KEY'].filter((k) => !(process.env[k] ?? '').trim())
  if (missing.length) {
    log(`WARNING: ${missing.join(' and ')} not set — the FDIC Data Analytics page will return 503 until configured`, 'market-intelligence')
  }
}

export type MiEnvelope =
  | ({ ok: true; meta: { quarter: string; scope: string; contractVersion: string; servedAt: string } } & Record<string, unknown>)
  | { ok: false; error: string }

export type MiResult = { status: number; body: MiEnvelope; cached: boolean }

/**
 * One upstream GET. Query values that are undefined/empty are dropped so the
 * cache key for "no band" and "band=" is the same entry.
 */
export async function fetchMarketIntelligence(
  endpoint: string,
  query: Record<string, string | undefined> = {},
): Promise<MiResult> {
  const cfg = readConfig()
  if (!cfg) return { status: 503, body: { ok: false, error: MI_UNCONFIGURED_MESSAGE }, cached: false }

  const cleanQuery: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') cleanQuery[k] = v

  const cacheKey = makeCacheKey(`mi:${endpoint}`, cleanQuery)
  const hit = getCached(cacheKey) as MiEnvelope | null
  if (hit) return { status: 200, body: hit, cached: true }

  const qs = new URLSearchParams(cleanQuery).toString()
  const url = `${cfg.baseUrl}${MI_API_PREFIX}${endpoint}${qs ? `?${qs}` : ''}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    let body: MiEnvelope
    try {
      body = (await res.json()) as MiEnvelope
    } catch {
      return { status: 502, body: { ok: false, error: `Market Intelligence returned a non-JSON response (HTTP ${res.status})` }, cached: false }
    }
    if (res.ok && body && body.ok === true) {
      setCached(cacheKey, body, DEFAULT_TTL_MS)
      return { status: 200, body, cached: false }
    }
    // Pass the upstream status and message through unchanged so the client can
    // tell "bad key" (401) from "upstream down" (502/503) from "bad scope" (400).
    const status = res.ok ? 502 : res.status
    const error = body && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `Market Intelligence error (HTTP ${res.status})`
    return { status, body: { ok: false, error }, cached: false }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: 502,
      body: { ok: false, error: aborted ? 'Market Intelligence timed out' : `Market Intelligence unreachable: ${err instanceof Error ? err.message : String(err)}` },
      cached: false,
    }
  } finally {
    clearTimeout(timer)
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function send(res: Response, result: MiResult) {
  res.setHeader('X-MI-Cache', result.cached ? 'HIT' : 'MISS')
  res.status(result.status).json(result.body)
}

/**
 * /api/mi/* mirrors the upstream endpoints 1:1 — same query parameters, same
 * body — so the client and a curl against upstream see the same shapes.
 * These are registered inside registerRoutes, after app.use(checkAuth) in
 * server/index.ts, so they are login-gated like every other /api route.
 */
export function registerMarketIntelligenceRoutes(app: Express) {
  app.get('/api/mi/meta', async (_req: Request, res: Response) => {
    send(res, await fetchMarketIntelligence('/meta'))
  })

  for (const endpoint of ['screening', 'visuals', 'cohort-watch'] as const) {
    app.get(`/api/mi/${endpoint}`, async (req: Request, res: Response) => {
      send(res, await fetchMarketIntelligence(`/${endpoint}`, { scope: str(req.query.scope) }))
    })
  }

  app.get('/api/mi/behavior-signals', async (req: Request, res: Response) => {
    send(res, await fetchMarketIntelligence('/behavior-signals', { scope: str(req.query.scope), band: str(req.query.band) }))
  })

  app.get('/api/mi/institution/:cert', async (req: Request, res: Response) => {
    const cert = String(req.params.cert ?? '').trim()
    if (!/^\d{1,7}$/.test(cert)) {
      res.status(400).json({ ok: false, error: 'cert must be a numeric FDIC certificate number' })
      return
    }
    // ?include=narrative calls OpenAI upstream; it is passed through only when
    // the client asks for it explicitly, and cached under its own key.
    send(res, await fetchMarketIntelligence(`/institution/${cert}`, { include: str(req.query.include) }))
  })
}
