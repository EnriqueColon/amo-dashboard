/**
 * Hostname matching for strict domain allowlist filtering.
 * Allows exact match or subdomain of each listed domain.
 */

import {
  getAssetDomainsForEntity,
  getLandingDomainsForEntity,
  type EntityId,
} from "./entity-sources"

/**
 * Extract hostname from URL (no port, lowercase).
 * Returns empty string if URL is invalid.
 */
export function extractHostname(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Check if hostname is allowed: exact match or subdomain of any allowed domain.
 * Subdomain: hostname.endsWith("." + domain) e.g. www.cbre.com for domain cbre.com
 */
export function isHostnameAllowed(hostname: string, allowedDomains: string[]): boolean {
  const h = hostname.toLowerCase().trim()
  if (!h) return false

  for (const domain of allowedDomains) {
    const d = domain.toLowerCase().trim()
    if (!d) continue
    if (h === d) return true
    if (h.endsWith("." + d)) return true
  }
  return false
}

/**
 * Filter results to only those whose URL hostname is in the allowlist for the given entity.
 */
export function filterByAllowlist<T extends { url: string }>(
  items: T[],
  entityId: EntityId
): T[] {
  const domains = getLandingDomainsForEntity(entityId)
  return items.filter((item) => {
    const hostname = extractHostname(item.url)
    return isHostnameAllowed(hostname, domains)
  })
}

export function isLandingUrlAllowed(url: string, entityId: EntityId): boolean {
  const hostname = extractHostname(url)
  return isHostnameAllowed(hostname, getLandingDomainsForEntity(entityId))
}

export function isAssetUrlAllowed(url: string, entityId: EntityId): boolean {
  const hostname = extractHostname(url)
  return isHostnameAllowed(hostname, getAssetDomainsForEntity(entityId))
}

/**
 * Strict rule:
 * - landing URL must be allowlisted landing domain
 * - extracted asset/PDF URL must be allowlisted asset domain
 */
export function isAssetUrlAllowedFromLanding(
  landingUrl: string,
  assetUrl: string,
  entityId: EntityId
): boolean {
  return isLandingUrlAllowed(landingUrl, entityId) && isAssetUrlAllowed(assetUrl, entityId)
}
