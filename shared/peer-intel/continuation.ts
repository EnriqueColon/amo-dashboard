/**
 * Continuation, annex and extension vehicles — sponsor-stress step 4.
 *
 * A continuation vehicle is a GP-led secondary: the sponsor moves assets from
 * a fund at the end of its life into a new vehicle it also manages, with new
 * money and a fresh clock, instead of selling them. An annex or extension fund
 * is follow-on capital for an existing portfolio. Neither is evidence of
 * distress on its own — the largest sponsors run them routinely — but each is
 * a fact about how the sponsor is handling a portfolio it could not or did not
 * exit, and for a lower-middle-market note buyer a peer's first one is worth
 * knowing about. So this is a **flag, never a score**: the panel lists the
 * vehicles and what each filing says, and draws no conclusion.
 *
 * Two sources, both already in hand. **Form ADV** lists every private fund the
 * adviser manages, and "Bridge Multifamily CV LP" is on that list by name —
 * and "Pretium Residential Credit Annex Fund" only as a feeder on its master's
 * record, so feeders are read too. **EDGAR full-text search** finds the Form D
 * a vehicle filed, and — the fact that makes this precise — the index covers
 * the filing's related persons, not just the entity name: searching Safe
 * Harbor's GP "SHE DDF4 GP" returns Fund 4's filings. One query per term —
 * the manager's names and its known people — with the four words finds
 * vehicles named after the fund rather than the firm.
 *
 * **The query grammar, measured 2026-10-27.** EDGAR accepts one quoted phrase
 * followed by a bracketed group of bare words: `"Pretium" (annex OR
 * continuation)` returns the annex fund. It does **not** accept a bracketed
 * group of quoted phrases — `("Pretium Partners" OR "Pretium") (annex OR …)`
 * returns 0, silently — and an unbracketed `"a" OR "b" (…)` binds the OR
 * across everything and returns 964 hits. So it is one request per term, and
 * the terms are capped.
 *
 * A hit is attributed to a manager only when at least one of three things
 * holds, and the panel says which: the name matches a fund on the manager's
 * adviser's ADV; the entity name carries a phrase of two or more words that
 * identifies the manager; or the filing's related persons share an exact
 * folded name with the manager's tracked raises. A hit on a one-word token
 * alone — "Bridge", "Apollo" — is dropped, and counted, rather than shown.
 *
 * Pure: names, filings and the ADV view in; a per-manager view out.
 */

import type { AdvFund } from "./adv"
import { fundKey } from "./adv-link"
import type { ManagerRaises } from "./cohort"
import { identifyingPhrases } from "./developments"
import type { Raise, RelatedPerson } from "./form-d"
import { personKey } from "./people"
import type { Peer } from "./registry"

export type ContinuationKind = "continuation" | "annex" | "cv" | "extension"

/**
 * The search terms, and the words that mark a name. `CV` counts only as an
 * upper-case token followed by a fund word or the end of the name: "Bridge
 * Multifamily CV LP" and "… CV Master Fund" are continuation vehicles,
 * "Pretium CV Platform Holdco" is not.
 */
export const CONTINUATION_TERMS: ReadonlyArray<{ kind: ContinuationKind; term: string; pattern: RegExp }> = [
  { kind: "continuation", term: "continuation", pattern: /\bcontinuation\b/i },
  { kind: "annex", term: "annex", pattern: /\bannex\b/i },
  { kind: "cv", term: "CV", pattern: /\bCV\b(?=\s*(?:,|L\.?P\.?\b|LLC\b|Ltd\b|Master\b|Fund\b|PV\b|Offshore\b|Onshore\b|Feeder\b|Parallel\b|Partners\b|I+V?\b|$))/i },
  { kind: "extension", term: "extension", pattern: /\bextension\b/i },
]

/** Which term marks this name, if any. The first in the table wins when two apply. Case is folded except for `CV`. */
export function continuationKind(name: string): { kind: ContinuationKind; term: string } | null {
  for (const t of CONTINUATION_TERMS) {
    if (t.kind === "cv" ? /\bCV\b/.test(name) && t.pattern.test(name) : t.pattern.test(name)) return { kind: t.kind, term: t.term }
  }
  return null
}

/** Name terms per manager — the manager and its aliases, longest first. */
export const MAX_NAME_TERMS = 4
/** People terms per manager — GP entities first, then the people on most of its raises. */
export const MAX_PEOPLE_TERMS = 4
/** Full-text search serves ten hits a page; more pages than this are not read. */
export const MAX_SEARCH_PAGES = 3

/**
 * The terms one manager is searched on, one request each: its names and
 * aliases (a one-word name is weak on its own, but a hit on it still has to
 * be confirmed below), then the entities and people on its tracked raises —
 * GP entities first, since a continuation vehicle is usually run by the same
 * GP, then individuals by how many raises they appear on.
 */
export function searchTerms(peer: Pick<Peer, "manager" | "aliases">, manager: ManagerRaises | null): string[] {
  const names = [peer.manager, ...peer.aliases]
    .map((n) => n.replace(/"/g, "").trim())
    .filter((n) => n.length >= 3 && !/^[A-Z]{2,5}$/.test(n)) // tickers and initialisms match nothing in a Form D
    .sort((a, b) => b.length - a.length)
  const counts = new Map<string, { name: string; kind: RelatedPerson["kind"]; n: number }>()
  for (const r of manager?.raises ?? []) {
    for (const p of r.raise.relatedPersons) {
      const kind = p.kind ?? "person"
      const key = personKey({ name: p.name, kind })
      const e = counts.get(key) ?? { name: p.name.replace(/"/g, "").trim(), kind, n: 0 }
      e.n++
      counts.set(key, e)
    }
  }
  const people = [...counts.values()]
    .filter((p) => p.name.split(/\s+/).length >= 2)
    .sort((a, b) => Number(b.kind === "entity") - Number(a.kind === "entity") || b.n - a.n || a.name.localeCompare(b.name))
    .map((p) => p.name)
  const seen = new Set<string>()
  const unique = (list: string[]) =>
    list.filter((t) => {
      const k = t.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return [...unique(names).slice(0, MAX_NAME_TERMS), ...unique(people).slice(0, MAX_PEOPLE_TERMS)]
}

/** The full-text query for one term: the term quoted, and any of the four words. */
export function continuationQuery(term: string): string {
  return `"${term.replace(/"/g, "")}" (${CONTINUATION_TERMS.map((t) => t.term).join(" OR ")})`
}

export type ContinuationAttribution =
  | { basis: "adv"; crd: string; fundId: string | null }
  | { basis: "name"; phrase: string }
  | { basis: "people"; names: string[] }

/** A Form D filer found by the search, with its trail already read. */
export type ContinuationHit = {
  cik: string
  name: string
  raise: Raise
}

export type ContinuationVehicle = {
  name: string
  kind: ContinuationKind
  term: string
  /** Every basis that held, strongest first. Never empty on a vehicle that is shown. */
  attribution: ContinuationAttribution[]
  formD: {
    cik: string
    fileNumber: string | null
    target: number | "indefinite" | null
    sold: number | null
    investorCount: number | null
    firstSale: string | null
    firstFiled: string | null
    lastFiled: string | null
    filings: number
    /** The newest filing's accession, for the sec.gov link. */
    accession: string
  } | null
  adv: {
    crd: string
    fundId: string | null
    grossAssetValue: number | null
    fundTypes: string[]
    beneficialOwners: number | null
    isFeederFund: boolean | null
    isMasterFund: boolean | null
    /** Set when the ADV lists it only as a feeder on this master's record, with no record of its own. */
    feederOf: string | null
  } | null
  /** The tracked vehicle whose name the stem matches — the fund this one most likely continues. */
  predecessor: { cik: string; name: string } | null
  /** Already one of the manager's tracked vehicles, so it also appears in Raises. */
  tracked: boolean
}

export type ContinuationView = {
  peerId: string
  vehicles: ContinuationVehicle[]
  /** Whether a search ran; false when the manager had no term to search on. */
  searched: boolean
  terms: string[]
  /** Search hits dropped because nothing attributed them to this manager. */
  unconfirmed: Array<{ cik: string; name: string }>
}

const normalise = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `

/** The keys of every related person on the manager's tracked raises. */
export function knownPeople(manager: ManagerRaises | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of manager?.raises ?? []) {
    for (const p of r.raise.relatedPersons) out.set(personKey({ name: p.name, kind: p.kind ?? "person" }), p.name)
  }
  return out
}

/** A fund on one of the manager's advisers' filings, with the CRD it was read from. */
export type AdvisedFund = { crd: string; fund: AdvFund }

/** Every name the ADV gives — each fund's own, and the feeders a master lists — with where it came from. */
function advNames(advFunds: readonly AdvisedFund[]): Array<{ crd: string; name: string; fundId: string | null; fund: AdvFund; feederOf: string | null }> {
  const out: Array<{ crd: string; name: string; fundId: string | null; fund: AdvFund; feederOf: string | null }> = []
  for (const { crd, fund } of advFunds) {
    out.push({ crd, name: fund.name, fundId: fund.fundId, fund, feederOf: null })
    for (const f of fund.feeders) out.push({ crd, name: f.name, fundId: f.fundId, fund, feederOf: fund.name })
  }
  // A feeder with a record of its own is that record, not the master's listing.
  const own = new Set(out.filter((x) => !x.feederOf).map((x) => fundKey(x.name)))
  return out.filter((x) => !x.feederOf || !own.has(fundKey(x.name)))
}

/** Which bases attribute a filer to the manager. Empty means it is not shown. */
export function attribute(
  hitName: string,
  hitPeople: readonly RelatedPerson[],
  peer: Pick<Peer, "manager" | "aliases">,
  advFunds: readonly AdvisedFund[],
  known: ReadonlyMap<string, string>
): ContinuationAttribution[] {
  const out: ContinuationAttribution[] = []
  const key = fundKey(hitName)
  const advFund = advNames(advFunds).find((f) => fundKey(f.name) === key)
  if (advFund) out.push({ basis: "adv", crd: advFund.crd, fundId: advFund.fundId })

  const name = normalise(hitName)
  const phrase = identifyingPhrases(peer.manager, peer.aliases).find((p) => name.includes(normalise(p)))
  if (phrase) out.push({ basis: "name", phrase })

  const shared = hitPeople
    .map((p) => ({ key: personKey({ name: p.name, kind: p.kind ?? "person" }), name: p.name }))
    .filter((p) => known.has(p.key))
    .map((p) => p.name)
  if (shared.length) out.push({ basis: "people", names: [...new Set(shared)] })
  return out
}

/**
 * The tracked vehicle this one most likely continues: the words before the
 * marking term, folded, must begin a tracked vehicle's folded name and be at
 * least two words. "Pretium Residential Credit Annex Fund" → "pretium
 * residential credit" → "Pretium Residential Credit Fund III".
 */
export function predecessorOf(
  name: string,
  term: string,
  vehicles: ReadonlyArray<{ cik: string; name: string }>
): { cik: string; name: string } | null {
  const at = name.search(new RegExp(`\\b${term}\\b`, "i"))
  if (at < 0) return null
  const stem = fundKey(name.slice(0, at))
  if (stem.split(" ").length < 2) return null
  const match = vehicles.find((v) => fundKey(v.name).startsWith(stem) && fundKey(v.name) !== stem)
  return match ? { cik: match.cik, name: match.name } : null
}

type AdvContinuation = NonNullable<ContinuationVehicle["adv"]> & { name: string; kind: ContinuationKind; term: string; fileNumber: string | null }

/**
 * The names on the manager's ADV that carry a term: funds with a record of
 * their own, with their figures, and feeders a master lists by name only,
 * with the master's figures left out — a feeder's size is not the master's.
 */
export function continuationFromAdv(advFunds: readonly AdvisedFund[]): AdvContinuation[] {
  const out: AdvContinuation[] = []
  for (const x of advNames(advFunds)) {
    const k = continuationKind(x.name)
    if (!k) continue
    out.push(
      x.feederOf
        ? { name: x.name, ...k, crd: x.crd, fundId: x.fundId, grossAssetValue: null, fundTypes: x.fund.fundTypes, beneficialOwners: null, isFeederFund: true, isMasterFund: false, feederOf: x.feederOf, fileNumber: null }
        : { name: x.name, ...k, crd: x.crd, fundId: x.fundId, grossAssetValue: x.fund.grossAssetValue, fundTypes: x.fund.fundTypes, beneficialOwners: x.fund.beneficialOwners, isFeederFund: x.fund.isFeederFund, isMasterFund: x.fund.isMasterFund, feederOf: null, fileNumber: x.fund.formDFileNumber }
    )
  }
  return out
}

/**
 * One manager's view: the confirmed Form D hits and the ADV's continuation
 * funds, merged by Form D file number where the ADV quotes one and by folded
 * name otherwise, largest first.
 */
export function buildContinuationView(
  peer: Peer,
  manager: ManagerRaises | null,
  advFunds: readonly AdvisedFund[],
  hits: readonly ContinuationHit[],
  terms: readonly string[],
  searched: boolean
): ContinuationView {
  const known = knownPeople(manager)
  const tracked = peer.vehicles.map((v) => ({ cik: v.cik, name: v.name }))
  const vehicles: ContinuationVehicle[] = []
  const unconfirmed: ContinuationView["unconfirmed"] = []

  for (const hit of hits) {
    const k = continuationKind(hit.name)
    if (!k) continue
    const attribution = attribute(hit.name, hit.raise.relatedPersons, peer, advFunds, known)
    const isTracked = peer.vehicles.some((v) => v.cik === hit.cik)
    if (!attribution.length && !isTracked) {
      unconfirmed.push({ cik: hit.cik, name: hit.name })
      continue
    }
    const newest = hit.raise.filings[hit.raise.filings.length - 1]
    vehicles.push({
      name: hit.name,
      ...k,
      attribution: isTracked && !attribution.length ? [{ basis: "name", phrase: peer.vehicles.find((v) => v.cik === hit.cik)!.name }] : attribution,
      formD: {
        cik: hit.cik,
        fileNumber: hit.raise.fileNumber,
        target: hit.raise.target,
        sold: hit.raise.sold,
        investorCount: hit.raise.investorCount,
        firstSale: hit.raise.firstSale,
        firstFiled: hit.raise.firstFiled,
        lastFiled: hit.raise.lastFiled,
        filings: hit.raise.filings.length,
        accession: newest?.accession ?? "",
      },
      adv: null,
      predecessor: predecessorOf(hit.name, k.term, tracked.filter((v) => v.cik !== hit.cik)),
      tracked: isTracked,
    })
  }

  // ADV names: attach to a Form D vehicle that shares the folded name, or the
  // file number when the ADV quotes one and no other name claims it; else
  // stand alone.
  for (const f of continuationFromAdv(advFunds)) {
    const { name, kind, term, fileNumber, ...brief } = f
    const existing =
      vehicles.find((v) => fundKey(v.name) === fundKey(name)) ??
      (fileNumber ? vehicles.find((v) => v.formD?.fileNumber === fileNumber && !v.adv) : undefined)
    if (existing) {
      existing.adv = brief
      if (!existing.attribution.some((a) => a.basis === "adv")) existing.attribution.unshift({ basis: "adv", crd: brief.crd, fundId: brief.fundId })
      continue
    }
    vehicles.push({
      name,
      kind,
      term,
      attribution: [{ basis: "adv", crd: brief.crd, fundId: brief.fundId }],
      formD: null,
      adv: brief,
      predecessor: predecessorOf(name, term, tracked),
      tracked: peer.vehicles.some((v) => fundKey(v.name) === fundKey(name)),
    })
  }

  const size = (v: ContinuationVehicle) => v.adv?.grossAssetValue ?? v.formD?.sold ?? -1
  vehicles.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name))
  return { peerId: peer.id, vehicles, searched, terms: [...terms], unconfirmed }
}
