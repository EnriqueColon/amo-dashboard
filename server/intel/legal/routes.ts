/**
 * Legal Landscape — routes for the tab ported from Market Intelligence.
 *
 * `GET /api/intel/legal` is the day's feed (regulatory, legislative,
 * enforcement), built once a day by OpenAI web search over the authoritative
 * sources and cached in intel.db; `POST /api/intel/legal/applicability`
 * resolves each item's stated scope against the Florida screening and the
 * stress tiers at render time (see resolve-legal-applicability.ts for why
 * that join is not in the cache).
 */
import type { Express, Request, Response } from "express"
import { fetchLegalUpdates } from "./fetch-legal-updates"
import { resolveLegalApplicability } from "./resolve-legal-applicability"

export function registerLegalRoutes(app: Express): void {
  app.get("/api/intel/legal", async (_req: Request, res: Response) => {
    try {
      res.json(await fetchLegalUpdates())
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post("/api/intel/legal/applicability", async (req: Request, res: Response) => {
    const requests = Array.isArray(req.body?.requests) ? req.body.requests : []
    try {
      res.json(await resolveLegalApplicability(requests))
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/** Builds (or serves) today's feed; called by the daily Intelligence warm-up. */
export async function warmLegal(): Promise<{ items: number; notes: string[] }> {
  const feed = await fetchLegalUpdates()
  return { items: feed.items.length, notes: feed.notes }
}
