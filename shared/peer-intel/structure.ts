/**
 * Structure and terms: what a fund's Form D says about how it is built and
 * sold, beyond the raise figures.
 *
 * Four things here bear on fund dynamics, which is why they are on the drawer:
 *
 *  - **Co-issuers** show the master/feeder/parallel structure. A filing made
 *    jointly by several issuers reports the offering as a whole, so a
 *    co-issuer's capital is *inside* the filing's totals. The trap runs the
 *    other way: if a co-issuer is also tracked as a vehicle of its own and its
 *    trail contains the same filing, that capital is counted twice — which is
 *    flagged rather than silently summed.
 *  - **Exemptions** show who a manager may raise from and how: 506(b) cannot
 *    advertise, 506(c) can; 3(c)(1) caps a fund at 100 beneficial owners,
 *    3(c)(7) admits only qualified purchasers; 3(c)(5) is the mortgage and
 *    real-estate exclusion.
 *  - **Sales commissions** are what a manager pays to raise.
 *  - **The minimum's history**, because lowering a minimum is reaching for
 *    smaller cheques.
 *
 * Pure: a manager's raises and the registry in, display rows out.
 */

import type { ManagerRaises, VehicleRaise } from "./cohort"
import type { CoIssuer, OfferingTerms } from "./form-d"
import { PEERS } from "./registry"

export type ExemptionInfo = { code: string; label: string; meaning: string }

const EXEMPTIONS: Record<string, { label: string; meaning: string }> = {
  "06b": { label: "Rule 506(b)", meaning: "may not advertise; up to 35 non-accredited investors" },
  "06c": { label: "Rule 506(c)", meaning: "may advertise publicly; every investor verified as accredited" },
  "04a5": { label: "Section 4(a)(5)", meaning: "accredited investors only, no advertising" },
  "04": { label: "Rule 504", meaning: "small offering, up to $10M in a year" },
  "3C.1": { label: "3(c)(1)", meaning: "at most 100 beneficial owners" },
  "3C.5": { label: "3(c)(5)", meaning: "the mortgage and real-estate interests exclusion" },
  "3C.7": { label: "3(c)(7)", meaning: "qualified purchasers only" },
}

/**
 * Plain words for the exemptions a filing claims.
 *
 * `3C` is the umbrella code filed alongside its sub-items, so it is dropped
 * when a sub-item is present and only shown alone. Unknown codes are kept with
 * their code as the label rather than hidden — a reader can look them up.
 */
export function describeExemptions(codes: readonly string[]): ExemptionInfo[] {
  const hasSub = codes.some((c) => /^3C\.\d+$/.test(c))
  return codes
    .filter((c) => !(c === "3C" && hasSub))
    .map((code) => {
      const known = EXEMPTIONS[code] ?? (/^04\.\d$/.test(code) ? EXEMPTIONS["04"] : undefined)
      if (known) return { code, ...known }
      const sub = code.match(/^3C\.(\d+)$/)
      if (sub) return { code, label: `3(c)(${sub[1]})`, meaning: "an Investment Company Act exclusion" }
      if (code === "3C") return { code, label: "Section 3(c)", meaning: "an Investment Company Act exclusion" }
      return { code, label: code, meaning: "as filed" }
    })
}

const SECURITY_LABELS: Record<string, string> = {
  equity: "equity",
  debt: "debt",
  "pooled-fund": "pooled investment fund interests",
  option: "options or warrants",
  "security-to-acquire": "securities to be acquired on exercise",
  mineral: "mineral property",
  "tenant-in-common": "tenant-in-common interests",
  "business-combination": "a business combination",
  other: "other",
}

export function describeSecurities(keys: readonly string[]): string[] {
  return keys.map((k) => SECURITY_LABELS[k] ?? k)
}

/** Where a co-issuer sits in the registry, and whether its capital could be counted twice. */
export type CoIssuerView = CoIssuer & {
  tracking: "this-manager" | "other-manager" | "untracked"
  /** The registry's name for it, when tracked. */
  trackedAs: string | null
  /**
   * True when the co-issuer is tracked as a vehicle and its own filing trail
   * contains a filing from this raise's trail — the same filing read twice,
   * so its capital is in the manager's total twice.
   */
  doubleCounted: boolean
}

export type MinimumChange = { filedAt: string; from: number | null; to: number | null }

export type StructureRow = {
  cik: string
  vehicleName: string
  role: VehicleRaise["role"]
  /** From the newest filing, e.g. "DELAWARE". */
  jurisdiction: string | null
  terms: OfferingTerms
  coIssuers: CoIssuerView[]
  exemptions: ExemptionInfo[]
  exemptionChanges: Array<{ filedAt: string; added: ExemptionInfo[]; removed: ExemptionInfo[] }>
  securities: string[]
  /** The current minimum from the newest filing; 0 means none stated. */
  minimum: number | null
  minimumChanges: MinimumChange[]
  /** Sales commissions over the numeric offering amount, 0–1. Null without both. */
  commissionShare: number | null
}

const REGISTRY_BY_CIK = new Map(
  PEERS.flatMap((p) => p.vehicles.map((v) => [v.cik, { peerId: p.id, manager: p.manager, name: v.name }] as const))
)

/** Each change in the minimum investment across the trail, oldest first. */
export function minimumChanges(raise: VehicleRaise["raise"]): MinimumChange[] {
  const out: MinimumChange[] = []
  let prev: number | null | undefined
  for (const f of raise.filings) {
    if (f.minimumInvestment == null) continue
    if (prev !== undefined && prev !== f.minimumInvestment) out.push({ filedAt: f.filedAt, from: prev, to: f.minimumInvestment })
    prev = f.minimumInvestment
  }
  return out
}

/**
 * One row per vehicle with terms, funds before sleeves.
 *
 * `allManagers` is the layer's cohort, used only to see whether a tracked
 * co-issuer's own trail contains this raise's filings. A vehicle cached before
 * terms were read has none and is left out rather than shown empty.
 */
export function structureRows(manager: ManagerRaises, allManagers: readonly ManagerRaises[]): StructureRow[] {
  const raiseByCik = new Map(allManagers.flatMap((m) => m.raises.map((r) => [r.cik, r] as const)))
  return manager.raises
    .filter((r) => r.raise.terms != null)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "fund" ? -1 : 1))
    .map((r) => {
      const terms = r.raise.terms as OfferingTerms
      const ownAccessions = new Set(r.raise.filings.map((f) => f.accession))
      const coIssuers: CoIssuerView[] = terms.coIssuers.map((c) => {
        const reg = REGISTRY_BY_CIK.get(c.cik)
        const theirs = raiseByCik.get(c.cik)
        return {
          ...c,
          tracking: !reg ? "untracked" : reg.peerId === manager.peerId ? "this-manager" : "other-manager",
          trackedAs: reg?.name ?? null,
          doubleCounted: Boolean(theirs?.raise.filings.some((f) => ownAccessions.has(f.accession))),
        }
      })
      const target = typeof r.raise.target === "number" && r.raise.target > 0 ? r.raise.target : null
      const commissions = terms.salesCommissions.amount
      return {
        cik: r.cik,
        vehicleName: r.vehicleName,
        role: r.role,
        jurisdiction: r.raise.filings[r.raise.filings.length - 1]?.jurisdiction ?? null,
        terms,
        coIssuers,
        exemptions: describeExemptions(terms.exemptions),
        exemptionChanges: r.raise.exemptionChanges.map((ch) => ({
          filedAt: ch.filedAt,
          added: describeExemptions(ch.added),
          removed: describeExemptions(ch.removed),
        })),
        securities: describeSecurities(terms.securities),
        minimum: r.raise.minimumInvestment,
        minimumChanges: minimumChanges(r.raise),
        commissionShare: target != null && commissions != null && commissions > 0 ? commissions / target : null,
      }
    })
}

/** How a vehicle was formed, in words: "Delaware limited partnership, formed 2022". */
export function formationLine(terms: OfferingTerms, jurisdiction: string | null): string {
  const what = [jurisdiction ? titleCase(jurisdiction) : null, terms.entityType?.toLowerCase() ?? null].filter(Boolean).join(" ")
  const when = terms.yearOfInc != null ? `formed ${terms.yearOfInc}` : terms.formedOverFiveYearsAgo ? "formed over five years ago" : null
  return [what || "entity type not reported", when].filter(Boolean).join(", ")
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}
