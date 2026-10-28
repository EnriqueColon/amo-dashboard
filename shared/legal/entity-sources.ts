/**
 * Central registry of approved report publishers (entities) and their allowed domains.
 * Used for Search Industry Reports: entity dropdown and strict domain allowlist filtering.
 */

export type EntityId =
  | "all"
  | "federalreserve"
  | "fdic"
  | "cbre"
  | "jll"
  | "cushmanwakefield"
  | "colliers"
  | "naiop"
  | "uli"
  | "mba"
  | "mhn"
  | "commercialsearch"

export type EntityRecord = {
  id: EntityId
  label: string
  /** Landing/report pages for this entity. Subdomains are allowed. */
  landingDomains: string[]
  /**
   * Asset domains where PDFs can live for this entity.
   * Keep strict and only include known, expected hosts.
   */
  assetDomains: string[]
}

/** Allowed domains per entity. Subdomains of each are allowed. */
export const ENTITY_SOURCES: EntityRecord[] = [
  {
    id: "federalreserve",
    label: "Federal Reserve",
    landingDomains: ["federalreserve.gov"],
    assetDomains: ["federalreserve.gov"],
  },
  {
    id: "fdic",
    label: "FDIC",
    landingDomains: ["fdic.gov"],
    assetDomains: ["fdic.gov"],
  },
  {
    id: "cbre",
    label: "CBRE",
    landingDomains: ["cbre.com", "cbre.us"],
    assetDomains: ["cbre.com", "cbre.us", "cbre-propertysearch.com"],
  },
  {
    id: "jll",
    label: "JLL",
    landingDomains: ["jll.com"],
    assetDomains: ["jll.com"],
  },
  {
    id: "cushmanwakefield",
    label: "Cushman & Wakefield",
    landingDomains: ["cushmanwakefield.com"],
    assetDomains: ["cushmanwakefield.com"],
  },
  {
    id: "colliers",
    label: "Colliers",
    landingDomains: ["colliers.com"],
    assetDomains: ["colliers.com"],
  },
  {
    id: "naiop",
    label: "NAIOP",
    landingDomains: ["naiop.org"],
    assetDomains: ["naiop.org"],
  },
  {
    id: "uli",
    label: "ULI",
    landingDomains: ["uli.org"],
    assetDomains: ["uli.org"],
  },
  {
    id: "mba",
    label: "MBA",
    landingDomains: ["mba.org"],
    assetDomains: ["mba.org"],
  },
  {
    id: "mhn",
    label: "MHN",
    landingDomains: ["multihousingnews.com"],
    assetDomains: ["multihousingnews.com"],
  },
  {
    id: "commercialsearch",
    label: "CommercialSearch",
    landingDomains: ["commercialsearch.com"],
    assetDomains: ["commercialsearch.com"],
  },
]

/** The primary Search Industry Reports publishers. Also what "all" resolves to. */
const PRIMARY_V1_ENTITY_IDS: EntityId[] = [
  "federalreserve",
  "fdic",
  "cbre",
  "jll",
  "cushmanwakefield",
  "colliers",
  "naiop",
  "uli",
]

/**
 * Get domains for entityId. "all" means the primary Search Industry Reports sources, not every
 * approved domain: it resolves to PRIMARY_V1_ENTITY_IDS, so `mba`, `mhn` and `commercialsearch`
 * stay allowlisted for URLs that reach us but are kept out of an unqualified search. They are also
 * absent from ENTITY_DROPDOWN_OPTIONS, so widening one without the other is inconsistent.
 */
export function getDomainsForEntity(entityId: EntityId): string[] {
  return getLandingDomainsForEntity(entityId)
}

/** Get landing domains for entityId. */
export function getLandingDomainsForEntity(entityId: EntityId): string[] {
  if (entityId === "all") {
    return ENTITY_SOURCES.filter((e) => PRIMARY_V1_ENTITY_IDS.includes(e.id)).flatMap((e) => e.landingDomains)
  }
  const entity = ENTITY_SOURCES.find((e) => e.id === entityId)
  return entity ? entity.landingDomains : []
}

/** Get asset domains for entityId. */
export function getAssetDomainsForEntity(entityId: EntityId): string[] {
  if (entityId === "all") {
    return ENTITY_SOURCES.filter((e) => PRIMARY_V1_ENTITY_IDS.includes(e.id)).flatMap((e) => e.assetDomains)
  }
  const entity = ENTITY_SOURCES.find((e) => e.id === entityId)
  return entity ? entity.assetDomains : []
}

/** Get entity label for display. */
export function getEntityLabel(entityId: EntityId): string {
  if (entityId === "all") return "All (Approved Sources)"
  const entity = ENTITY_SOURCES.find((e) => e.id === entityId)
  return entity ? entity.label : "Unknown"
}

/** Dropdown options for the Search UI. */
export const ENTITY_DROPDOWN_OPTIONS: { value: EntityId; label: string }[] = [
  { value: "all", label: "All (Approved Sources)" },
  ...ENTITY_SOURCES
    .filter((e) => PRIMARY_V1_ENTITY_IDS.includes(e.id))
    .map((e) => ({ value: e.id, label: e.label })),
]
