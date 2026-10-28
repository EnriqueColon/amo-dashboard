/**
 * IAPD: resolving a tracked manager to its SEC adviser record.
 *
 * Form D identifies a *fund* by CIK. Form ADV identifies the *adviser* by CRD
 * number, and that is the key every ADV figure hangs off — gross asset value,
 * owner counts, audit status. The registry holds CIKs; this is how it gets
 * CRDs.
 *
 * The Investment Adviser Public Disclosure site has a search endpoint that
 * returns JSON. It is a public website's own API rather than a documented one:
 * `search/firm?query=` works, the firm-detail endpoints answer 403, and the
 * page caps results at 20 of however many matched. So this is used once, by a
 * script, to *propose* a CRD per manager for a person to confirm — never at
 * runtime, and never written into the registry unreviewed.
 *
 * **Why proposals, not answers.** "Safe Harbor Capital Partners" matched 40
 * advisers, among them Safe Harbor Family Capital, Safe Harbor Capital
 * Advisers and a Harbor Capital Partners. "Blackstone" matched 54, of which
 * the one advising BCRED may not be in the twenty returned. A name match is
 * evidence, and the scoring below weighs it with the adviser's state, its
 * other names against the registry's aliases, and — the strongest link — the
 * GP or investment-manager entity that the manager's own Form D names as a
 * related person, which is frequently the registered adviser under a name the
 * registry does not carry ("BH3 Fund Advisors, LLC" for BH3 Management).
 *
 * Pure: a manager, its known names and IAPD's hits in; a ranked proposal out.
 */

import type { Peer } from "./registry"

export const IAPD_SEARCH = "https://api.adviserinfo.sec.gov/search/firm"

/** Spacing between IAPD requests. Undocumented limit; EDGAR's 125 ms doubled. */
export const IAPD_SPACING_MS = 300

export function iapdSearchUrl(query: string): string {
  return `${IAPD_SEARCH}?query=${encodeURIComponent(query)}`
}

export type IapdHit = {
  crd: string
  /** `801-…` for a registered adviser, `802-…` for an exempt reporting adviser, null when absent. */
  secNumber: string | null
  name: string
  otherNames: string[]
  /** `ACTIVE`, `INACTIVE`, or null where IAPD gives none (typically a broker-dealer only). */
  scope: string | null
  city: string | null
  state: string | null
}

type RawHit = {
  firm_source_id?: string | number
  firm_ia_full_sec_number?: string
  firm_name?: string
  firm_other_names?: string[]
  firm_ia_scope?: string
  /** A JSON *string* of `{ officeAddress: { city, state, … } }`, as IAPD serves it. */
  firm_ia_address_details?: string
}

/** One IAPD search hit, with the address string decoded and the fields named plainly. */
export function parseIapdHit(raw: RawHit): IapdHit | null {
  const crd = raw.firm_source_id != null ? String(raw.firm_source_id).trim() : ""
  const name = (raw.firm_name ?? "").trim()
  if (!crd || !name) return null
  let city: string | null = null
  let state: string | null = null
  if (raw.firm_ia_address_details) {
    try {
      const addr = JSON.parse(raw.firm_ia_address_details)?.officeAddress ?? {}
      city = addr.city ? String(addr.city) : null
      state = addr.state ? String(addr.state) : null
    } catch {
      // An unparseable address is no address, not a failed hit.
    }
  }
  return {
    crd,
    secNumber: raw.firm_ia_full_sec_number?.trim() || null,
    name,
    otherNames: (raw.firm_other_names ?? []).map((n) => String(n).trim()).filter((n) => n && n !== name),
    scope: raw.firm_ia_scope?.trim() || null,
    city,
    state,
  }
}

/**
 * Case, punctuation, legal suffixes and spacing folded, so "BH3 Fund Advisors,
 * LLC" equals "bh3 fund advisors". IAPD's qualifiers in parentheses —
 * "(RELYING ADVISOR)", "(MANAGEMENT SERIES)" — are dropped first: H.I.G.'s
 * record lists "BAYSIDE CAPITAL, INC. (RELYING ADVISOR)", and that is the
 * registry's alias "Bayside Capital".
 */
export function firmKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[.,'’"()&]/g, " ")
    .replace(/\b(l\s*l\s*c|l\s*p|llp|inc|incorporated|corp|corporation|ltd|limited|co|company|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export type CandidateScore = {
  hit: IapdHit
  score: number
  /** Why it scored what it did, for the reviewer. */
  reasons: string[]
}

/** Below this the best candidate is not proposed at all. */
export const RESOLVE_MIN_SCORE = 60
/** A runner-up this close to the best makes the proposal ambiguous. */
export const RESOLVE_MARGIN = 20

const WEIGHTS = {
  nameExact: 50,
  /** The registry name plus a management suffix: "Starwood Capital" → "Starwood Capital Group Management". */
  nameExtends: 35,
  nameContains: 15,
  otherNameExact: 35,
  relatedEntityExact: 45,
  stateMatch: 20,
  cityMatch: 10,
  active: 10,
  inactive: -30,
} as const

/**
 * What an adviser's name adds to the sponsor's. "Safe Harbor Family Capital"
 * does not match — "family capital" is a different business, which is the
 * whole point of scoring it below an exact name.
 */
const MANAGEMENT_SUFFIX =
  /^(group |credit |capital |asset |investment |fund |private fund |real estate |residential credit |mortgage credit )?(management|advisors|advisers|manager|partners)$/

function extendsName(hitName: string, known: readonly string[]): boolean {
  return known.some((k) => k && hitName.startsWith(k + " ") && MANAGEMENT_SUFFIX.test(hitName.slice(k.length + 1)))
}

/**
 * Score one hit against what the registry and the manager's own Form D know.
 *
 * `knownNames` is the manager name and its aliases; `relatedEntities` the GP
 * and investment-manager entities its Form D filings list. A hit earns the
 * exact-name weight once, whichever name matched, so a long alias list cannot
 * inflate a score.
 */
export function scoreCandidate(
  peer: Pick<Peer, "manager" | "aliases" | "location">,
  relatedEntities: readonly string[],
  hit: IapdHit
): CandidateScore {
  const reasons: string[] = []
  let score = 0
  const known = [peer.manager, ...peer.aliases].map(firmKey).filter(Boolean)
  const related = relatedEntities.map(firmKey).filter(Boolean)
  const hitName = firmKey(hit.name)
  const hitOthers = hit.otherNames.map(firmKey)

  if (known.includes(hitName)) {
    score += WEIGHTS.nameExact
    reasons.push(`name is the registry's "${peer.manager}" or an alias`)
  } else if (related.includes(hitName)) {
    score += WEIGHTS.relatedEntityExact
    reasons.push(`name is an entity the manager's Form D lists as GP or investment manager`)
  } else if (extendsName(hitName, known)) {
    score += WEIGHTS.nameExtends
    reasons.push(`name is a registry name with a management suffix`)
  } else if (known.some((k) => hitName.includes(k) || k.includes(hitName))) {
    score += WEIGHTS.nameContains
    reasons.push(`name contains or is contained by a registry name`)
  }

  const otherMatch = hitOthers.find((o) => known.includes(o) || related.includes(o))
  if (otherMatch) {
    score += WEIGHTS.otherNameExact
    reasons.push(`lists "${hit.otherNames[hitOthers.indexOf(otherMatch)]}" among its other names`)
  }

  const registryState = peer.location.match(/,\s*([A-Z]{2})$/)?.[1] ?? null
  const registryCity = peer.location.split(",")[0]?.trim().toLowerCase() ?? ""
  if (registryState && hit.state && hit.state.toUpperCase() === registryState) {
    score += WEIGHTS.stateMatch
    reasons.push(`office in ${hit.state}, as the registry has it`)
    if (hit.city && hit.city.toLowerCase() === registryCity) {
      score += WEIGHTS.cityMatch
      reasons.push(`and in ${hit.city}`)
    }
  } else if (registryState && hit.state) {
    reasons.push(`office in ${hit.state}; registry says ${registryState}`)
  }

  if (hit.scope === "ACTIVE") {
    score += WEIGHTS.active
  } else if (hit.scope === "INACTIVE") {
    score += WEIGHTS.inactive
    reasons.push("IAPD marks it inactive")
  } else {
    reasons.push("no adviser scope on IAPD (a broker-dealer record, not an adviser)")
  }

  return { hit, score, reasons }
}

export type Resolution = {
  peerId: string
  manager: string
  status: "resolved" | "ambiguous" | "none"
  /** The proposal, where there is one worth making. */
  best: CandidateScore | null
  /** Every scored hit, best first, for the reviewer. */
  candidates: CandidateScore[]
  /** Plain words on why the status is what it is. */
  note: string
}

/**
 * Rank IAPD's hits for one manager and say whether the top one can be
 * proposed. Duplicate CRDs across several searches collapse to the best score.
 */
export function resolveManager(
  peer: Pick<Peer, "id" | "manager" | "aliases" | "location">,
  relatedEntities: readonly string[],
  hits: readonly IapdHit[],
  totalMatched: number
): Resolution {
  const byCrd = new Map<string, CandidateScore>()
  for (const hit of hits) {
    const scored = scoreCandidate(peer, relatedEntities, hit)
    const prior = byCrd.get(hit.crd)
    if (!prior || scored.score > prior.score) byCrd.set(hit.crd, scored)
  }
  const candidates = [...byCrd.values()].sort((a, b) => b.score - a.score)
  const best = candidates[0] ?? null
  const second = candidates[1] ?? null
  const base = { peerId: peer.id, manager: peer.manager, candidates }

  // A capped result set with no strong match is not "none" — Blackstone has an
  // adviser, it just is not among the twenty IAPD returned of fifty-four. Say
  // that, rather than "likely not registered", which would be false.
  const strong = WEIGHTS.nameExact + WEIGHTS.stateMatch
  if (totalMatched > hits.length && (!best || best.score < strong)) {
    return {
      ...base,
      status: "ambiguous",
      best: best && best.score >= RESOLVE_MIN_SCORE ? best : null,
      note: `IAPD matched ${totalMatched} advisers and returned ${hits.length}; the right one may not be among them.`,
    }
  }
  if (!best || best.score < RESOLVE_MIN_SCORE) {
    return {
      ...base,
      status: "none",
      best: null,
      note: candidates.length
        ? `${candidates.length} hits, none above ${RESOLVE_MIN_SCORE}: likely not an SEC-registered or exempt reporting adviser under any name the registry knows.`
        : "No IAPD hit for the manager, its aliases or its Form D entities.",
    }
  }
  if (second && best.score - second.score < RESOLVE_MARGIN) {
    return {
      ...base,
      status: "ambiguous",
      best,
      note: `Top two within ${RESOLVE_MARGIN} points (${best.score} vs ${second.score}); needs a person.`,
    }
  }
  return { ...base, status: "resolved", best, note: best.reasons.join("; ") }
}
