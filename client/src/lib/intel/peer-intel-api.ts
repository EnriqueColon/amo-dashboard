import type { PeerLayer } from "@shared/peer-intel/edgar-contract"
import type { PeerIntelPayload } from "./peer-intel-types"

export type PeerIntelResult = { ok: true; payload: PeerIntelPayload } | { ok: false; error: string }

/**
 * The layer payload from this server (`GET /api/intel/peers`), which builds it
 * from SEC EDGAR and keeps it for a week — the tool's server action and
 * Next cache, replaced by an ordinary request and the dashboard's cache.
 */
export async function fetchPeerIntel(layer: PeerLayer): Promise<PeerIntelResult> {
  const res = await fetch(`/api/intel/peers?layer=${encodeURIComponent(layer)}`, { credentials: "same-origin" })
  const body = (await res.json().catch(() => null)) as PeerIntelResult | null
  if (!body) return { ok: false, error: `Unexpected response (${res.status}).` }
  return body
}
