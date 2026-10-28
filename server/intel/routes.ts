/**
 * Intelligence section — routes for the tabs ported from the Market
 * Intelligence tool (docs/MARKET_INTEL_MERGE_SESSION.md). First: Peers.
 *
 * `GET /api/intel/peers?layer=miami-dade|florida|national` returns the
 * layer's payload — what competing managers are raising, from SEC EDGAR
 * (Form D, XBRL company facts, the committed Form ADV extract). Building one
 * is 140–340 EDGAR requests at SEC's ten-a-second cap, 17–43 seconds cold, so
 * the result sits in the in-memory cache for a week (the inputs are quarterly
 * reports and annual amendments; nothing changes faster) and every layer is
 * rebuilt in the background shortly after the server starts, so the first
 * visitor after a deploy does not wait. A failed build is never cached: a
 * bad EDGAR day cannot pin an error for a week.
 *
 * The ADV views are rebuilt per request from the committed extract, as in
 * the tool: a newly deployed extract shows at once while the cached payload
 * still carries the cohort it is linked against.
 */
import type { Express, Request, Response } from "express"
import { clearCacheByPrefix, getCached, setCached } from "../cache"
import { buildLayerAdv, buildPeerIntelPayload, type PeerIntelPayload } from "./peer-intel-service"
import type { PeerLayer } from "@shared/peer-intel/edgar-contract"
import { registerNewsRoutes, scheduleNewsWarmup } from "./news/routes"
import { registerLegalRoutes } from "./legal/routes"

const LAYERS: readonly PeerLayer[] = ["miami-dade", "florida", "national"]
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// Bump when PeerIntelPayload changes shape, or a cached entry keeps serving
// the old one for up to a week (the tool's rule, carried over).
const PAYLOAD_VERSION = "v5"

function cacheKey(layer: PeerLayer): string {
  return `intel:peers:${PAYLOAD_VERSION}:${layer}`
}

// One build per layer at a time: a burst of visitors during a cold start
// must share the build, not each fire 340 EDGAR requests.
const inFlight = new Map<PeerLayer, Promise<PeerIntelPayload>>()

async function loadLayer(layer: PeerLayer): Promise<PeerIntelPayload> {
  const hit = getCached(cacheKey(layer)) as PeerIntelPayload | null
  if (hit) return hit
  let pending = inFlight.get(layer)
  if (!pending) {
    const day = new Date().toISOString().slice(0, 10)
    pending = buildPeerIntelPayload(layer, day)
      .then((payload) => {
        setCached(cacheKey(layer), payload, WEEK_MS)
        return payload
      })
      .finally(() => inFlight.delete(layer))
    inFlight.set(layer, pending)
  }
  return pending
}

function isLayer(value: unknown): value is PeerLayer {
  return typeof value === "string" && (LAYERS as readonly string[]).includes(value)
}

export function registerIntelRoutes(app: Express): void {
  registerNewsRoutes(app)
  registerLegalRoutes(app)

  app.get("/api/intel/peers", async (req: Request, res: Response) => {
    const layer = req.query.layer ?? "miami-dade"
    if (!isLayer(layer)) {
      res.status(400).json({ ok: false, error: `Unknown layer. Use one of ${LAYERS.join(", ")}.` })
      return
    }
    try {
      const payload = await loadLayer(layer)
      res.json({ ok: true, payload: { ...payload, adv: buildLayerAdv(layer, payload.cohort) } })
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : "Unable to load the peer tracker for this layer.",
      })
    }
  })

  // Rebuild on demand (the cache is in memory, so a restart empties it; this
  // is also what a scheduled warm-up calls). Same session gate as everything.
  app.post("/api/intel/peers/warm", async (_req: Request, res: Response) => {
    const results = await warmPeerIntel()
    res.json({ ok: results.every((r) => r.ok), results })
  })
}

/**
 * Build every layer, smallest first so the Miami-Dade scope — the one the
 * page opens on — is ready soonest. Sequential on purpose: the service's
 * rate limiter is shared, so parallel layers would only queue behind each
 * other at SEC's cap while holding three payloads' worth of filings in memory.
 */
export async function warmPeerIntel(): Promise<Array<{ layer: PeerLayer; ok: boolean; ms: number; error?: string }>> {
  const out: Array<{ layer: PeerLayer; ok: boolean; ms: number; error?: string }> = []
  for (const layer of LAYERS) {
    const started = Date.now()
    try {
      await loadLayer(layer)
      out.push({ layer, ok: true, ms: Date.now() - started })
    } catch (err) {
      out.push({ layer, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

function logWarm(results: Awaited<ReturnType<typeof warmPeerIntel>>): void {
  for (const r of results) {
    console.log(`[intel] peers ${r.layer}: ${r.ok ? "warm" : "FAILED"} in ${(r.ms / 1000).toFixed(1)}s${r.error ? ` — ${r.error}` : ""}`)
  }
}

/**
 * Called once after the server is listening; never blocks startup. Builds
 * every layer shortly after start, then again every six days — one day
 * inside the cache's week — so the expiry never lands on a visitor. Entries
 * are replaced in place (setCached overwrites), so the old payload serves
 * until the new one is ready.
 */
export function schedulePeerIntelWarmup(delayMs = 15_000, everyMs = 6 * 24 * 60 * 60 * 1000): void {
  const run = () => warmPeerIntel().then(logWarm).catch((err) => console.warn("[intel] peers warm-up failed:", err))
  setTimeout(run, delayMs).unref()
  setInterval(() => {
    clearCacheByPrefix(`intel:peers:${PAYLOAD_VERSION}:`)
    void run()
  }, everyMs).unref()
}

/** Every Intelligence warm-up: Peers after 15 s then every six days; News after 60 s then daily at 05:00 UTC. */
export function scheduleIntelWarmups(): void {
  schedulePeerIntelWarmup()
  scheduleNewsWarmup()
}
