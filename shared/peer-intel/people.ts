/**
 * People and entities behind each fund, and where the same name turns up at
 * another manager.
 *
 * Form D Item 3 lists the issuer's executive officers, directors and promoters
 * — for a fund, typically the principals of the GP and the GP or investment
 * manager entities themselves. Not the whole team, and not investors: who
 * *bought* is never disclosed.
 *
 * **Matching is by exact name, because that is all there is.** Form D carries
 * no identifier for a person — no CRD, no CIK — so "the same person at two
 * managers" means "the same normalised name in two managers' filings". That is
 * strong evidence for an unusual name and weak for a common one, and the panel
 * says it is a name match. Normalisation only folds case, punctuation and
 * spacing; it never drops a middle name or initial, because "H. Jack Miller"
 * and "Jack Miller" may not be one person and over-merging is the worse error.
 *
 * Pure: a cohort's raises in, grouped people out.
 */

import type { ManagerRaises } from "./cohort"
import type { RelatedPerson } from "./form-d"

/** Case, punctuation and spacing folded; nothing else changed. */
export function personKey(p: Pick<RelatedPerson, "name" | "kind">): string {
  const base = p.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,'’"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return `${p.kind}:${base}`
}

export type Appearance = {
  peerId: string
  manager: string
  vehicleName: string
  roles: string[]
  clarification: string | null
}

/** Every related person in the layer, keyed by `personKey`. */
export function buildPeopleIndex(managers: readonly ManagerRaises[]): Map<string, Appearance[]> {
  const index = new Map<string, Appearance[]>()
  for (const m of managers) {
    for (const r of m.raises) {
      for (const p of r.raise.relatedPersons ?? []) {
        // Entries cached before `kind` existed default to person, which is the
        // conservative reading for matching: entities rarely span managers.
        const key = personKey({ name: p.name, kind: p.kind ?? "person" })
        const list = index.get(key) ?? []
        list.push({ peerId: m.peerId, manager: m.manager, vehicleName: r.vehicleName, roles: p.relationships, clarification: p.clarification ?? null })
        index.set(key, list)
      }
    }
  }
  return index
}

export type ManagerPerson = {
  name: string
  kind: RelatedPerson["kind"]
  /** Roles across all of this manager's vehicles, deduplicated. */
  roles: string[]
  /** The filers' own notes on the role, deduplicated. */
  clarifications: string[]
  /** This manager's vehicles that name them. */
  vehicles: string[]
  /** Other managers in the layer whose filings carry the same name. */
  elsewhere: Array<{ peerId: string; manager: string; vehicles: string[]; roles: string[] }>
}

/**
 * One manager's people, each once however many of its vehicles name them.
 *
 * Ordered: people before entities, then anyone who also appears at another
 * manager, then by how many of this manager's vehicles name them.
 */
export function managerPeople(manager: ManagerRaises, index: ReadonlyMap<string, Appearance[]>): ManagerPerson[] {
  const byKey = new Map<string, ManagerPerson>()
  for (const r of manager.raises) {
    for (const p of r.raise.relatedPersons ?? []) {
      const kind = p.kind ?? "person"
      const key = personKey({ name: p.name, kind })
      const entry = byKey.get(key) ?? { name: p.name, kind, roles: [], clarifications: [], vehicles: [], elsewhere: [] }
      for (const role of p.relationships) if (!entry.roles.includes(role)) entry.roles.push(role)
      if (p.clarification && !entry.clarifications.includes(p.clarification)) entry.clarifications.push(p.clarification)
      if (!entry.vehicles.includes(r.vehicleName)) entry.vehicles.push(r.vehicleName)
      byKey.set(key, entry)
    }
  }

  for (const [key, entry] of byKey) {
    const others = new Map<string, { peerId: string; manager: string; vehicles: string[]; roles: string[] }>()
    for (const a of index.get(key) ?? []) {
      if (a.peerId === manager.peerId) continue
      const o = others.get(a.peerId) ?? { peerId: a.peerId, manager: a.manager, vehicles: [], roles: [] }
      if (!o.vehicles.includes(a.vehicleName)) o.vehicles.push(a.vehicleName)
      for (const role of a.roles) if (!o.roles.includes(role)) o.roles.push(role)
      others.set(a.peerId, o)
    }
    entry.elsewhere = [...others.values()].sort((a, b) => a.manager.localeCompare(b.manager))
  }

  return [...byKey.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "person" ? -1 : 1) ||
      (b.elsewhere.length > 0 ? 1 : 0) - (a.elsewhere.length > 0 ? 1 : 0) ||
      b.vehicles.length - a.vehicles.length ||
      a.name.localeCompare(b.name)
  )
}

/** Names appearing at two or more managers in the layer — the cross-manager links. */
export function sharedPeople(index: ReadonlyMap<string, Appearance[]>): Array<{ key: string; name: string; managers: string[] }> {
  const out: Array<{ key: string; name: string; managers: string[] }> = []
  for (const [key, list] of index) {
    const managers = [...new Set(list.map((a) => a.manager))]
    if (managers.length >= 2) out.push({ key, name: key.replace(/^(person|entity):/, ""), managers: managers.sort() })
  }
  return out.sort((a, b) => b.managers.length - a.managers.length || a.name.localeCompare(b.name))
}
