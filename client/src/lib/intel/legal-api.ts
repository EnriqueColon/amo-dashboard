import type { ApplicabilityRequest, LegalUpdatesResponse, ResolveApplicabilityResult } from "./legal-types"

export type { ApplicabilityRequest, LegalUpdatesResponse, ResolveApplicabilityResult }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/intel/legal${path}`, { credentials: "same-origin", ...init })
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`)
  if (!body) throw new Error("Empty response.")
  return body
}

/** Today's feed: the three sections, from this server's daily cache. */
export function fetchLegalUpdates(): Promise<LegalUpdatesResponse> {
  return call("")
}

/** Each item's stated scope counted against Florida's FDIC filers and the stress watch tiers. */
export function resolveLegalApplicability(requests: ApplicabilityRequest[]): Promise<ResolveApplicabilityResult> {
  return call("/applicability", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }) })
}
