/**
 * Which sources the Legal Landscape tab will believe.
 *
 * The model fabricates confidently in this feed. Asked for five recent bills when the Florida
 * legislature is out of session, it produced a bill number copied from the prompt's own formatting
 * example, a "2026 update" linked to a statute enacted in 2020, a Federal Reserve rate decision
 * filed as legislation, and a bill page that 404s. Enforcement was worse: plausible-sounding
 * consent orders against "Sunset Bank" and "Liberty Bank", every URL constructed from a pattern
 * and none of them real.
 *
 * Prompt wording alone does not fix that — it is the same lesson as the dedupe. An item is only
 * shown if its URL is on this list *and* that URL actually loads.
 */

import { extractHostname, isHostnameAllowed } from "./domain-allowlist"
import type { LegalSection } from "./legal-updates-sections"

/**
 * Primary sources only: the body that issued the thing, or an official publisher of record.
 * Trade press and law-firm commentary are deliberately excluded — they resolve, which makes them
 * indistinguishable from a real citation to a link check, while still being someone's summary.
 */
const AUTHORITATIVE_HOSTS: Record<LegalSection, string[]> = {
  regulatory: [
    "occ.gov",
    // Live alternate OCC host serving the same releases. Note occ.ustreas.gov does not resolve —
    // the model has produced it, and the URL check is what catches that.
    "occ.treas.gov",
    "fdic.gov",
    "federalreserve.gov",
    "consumerfinance.gov",
    "hud.gov",
    "flofr.gov",
    "federalregister.gov",
    "regulations.gov",
    "govinfo.gov",
    "ncua.gov",
    "fhfa.gov",
    "treasury.gov",
    // FDIC issues Financial Institution Letters through GovDelivery rather than fdic.gov.
    "content.govdelivery.com",
  ],
  legislative: [
    "congress.gov",
    "govinfo.gov",
    "govtrack.us",
    "flsenate.gov",
    "myfloridahouse.gov",
    "leg.state.fl.us",
    "laws.flrules.org",
    "flrules.org",
    // The Governor's office is where Florida bill signings are announced.
    "flgov.com",
  ],
  enforcement: [
    "fdic.gov",
    "occ.gov",
    "occ.treas.gov",
    "federalreserve.gov",
    "justice.gov",
    "sec.gov",
    "fincen.gov",
    "ncua.gov",
    // Covers the district and bankruptcy courts, which sit on *.uscourts.gov subdomains.
    "uscourts.gov",
    "flcourts.gov",
    "govinfo.gov",
    // Free mirror of PACER filings. Included because bankruptcy dockets are otherwise paywalled,
    // which previously left the model citing the PACER homepage as though it were a document.
    "courtlistener.com",
    // FDIC announces its monthly enforcement decisions and orders through GovDelivery, the same
    // way it announces Financial Institution Letters. Omitting it here rejected real bulletins.
    "content.govdelivery.com",
  ],
}

export function authoritativeHostsFor(section: LegalSection): string[] {
  return AUTHORITATIVE_HOSTS[section]
}

export function isAuthoritativeSource(url: string | undefined, section: LegalSection): boolean {
  if (!url) return false
  return isHostnameAllowed(extractHostname(url), AUTHORITATIVE_HOSTS[section])
}

export type UrlVerdict = "ok" | "missing" | "unlisted" | "dead"

/**
 * A 403 or 429 means the host refused *us*, not that the page is absent — and since the host is
 * already known-authoritative by this point, refusing the item would drop real developments
 * whenever a .gov rate-limits. Only an outright absence disqualifies.
 */
export async function checkSourceUrl(
  url: string | undefined,
  section: LegalSection,
  timeoutMs = 12_000
): Promise<UrlVerdict> {
  if (!url?.trim()) return "missing"
  if (!isAuthoritativeSource(url, section)) return "unlisted"

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (res.ok) return "ok"
    if (res.status === 403 || res.status === 429) return "ok"
    return "dead"
  } catch {
    return "dead"
  }
}

/** Keeps only items backed by a listed source that loads. Bounded concurrency; order preserved. */
export async function keepVerifiableItems<T extends { url?: string; section: LegalSection }>(
  items: T[],
  concurrency = 6
): Promise<{ kept: T[]; rejected: Array<{ item: T; verdict: UrlVerdict }> }> {
  const verdicts = new Array<UrlVerdict>(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      verdicts[i] = await checkSourceUrl(items[i].url, items[i].section)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))

  const kept: T[] = []
  const rejected: Array<{ item: T; verdict: UrlVerdict }> = []
  items.forEach((item, i) => {
    if (verdicts[i] === "ok") kept.push(item)
    else rejected.push({ item, verdict: verdicts[i] })
  })
  return { kept, rejected }
}
