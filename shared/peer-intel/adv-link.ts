/**
 * The committed Form ADV extract, and how its funds attach to the registry.
 *
 * IAPD's ADV PDFs run to 165 MB for an umbrella filer and nothing deployed can
 * hold or parse them, so `scripts/refresh-peer-adv.mts` reads them locally and
 * commits `adv-extract.json`: one entry per adviser CRD, every private fund it
 * reports, as parsed. The app reads the extract and never fetches a PDF.
 *
 * **Which advisers are read.** Every adviser recorded on a manager's vehicles,
 * plus the manager's own adviser unless every tracked vehicle names one of its
 * own. Apollo Capital Management's 165 MB umbrella filing is skipped that way
 * because the one Apollo vehicle tracked, Apollo Debt Solutions BDC, has its
 * own adviser. Note what that buys: Schedule D 7.B.(1) lists *private* funds
 * only, so a BDC's or a non-traded REIT's adviser reports none — BX REIT
 * Advisors files "No Information Filed" for BREIT, correctly. Those vehicles'
 * figures come from their own periodic reports instead.
 *
 * **How a fund attaches to a vehicle.** By the Form D file number first: the
 * ADV quotes it for each fund (question 22) and EDGAR's index carries it on
 * every Form D filing, so the two agree exactly, and a master and its feeder
 * that filed one Form D between them both attach to that vehicle. By folded
 * name second, for a fund whose ADV record quotes no file number. Each link
 * records which, so the panel can say it.
 *
 * Pure: the extract, the registry and the vehicles' file numbers in; one
 * manager's view out. The payload-sized view keeps every field of a linked
 * fund and a brief of each other fund the adviser reports.
 */

import type { AdvFiling, AdvFund } from "./adv"
import { adviserYears, currentPoint, seriesNotes, yearlySeries, type AdviserYear, type AdvHistory, type AdvSeriesNote, type AdvYearPoint } from "./adv-history"
import type { Peer } from "./registry"

export type AdvExtractEntry = AdvFiling & {
  /** `YYYY-MM-DD` the PDF was fetched. */
  fetchedOn: string
  pdfBytes: number
  pages: number
}

export type AdvExtract = {
  /** `YYYY-MM-DD` of the refresh run. */
  refreshedOn: string
  advisers: Record<string, AdvExtractEntry>
}

export type AdvSource = {
  crd: string
  name: string
  basis: string
  scope: "manager" | "vehicle"
  vehicleCik?: string
}

/** The CRDs a manager's ADV view is read from, and why. */
export function advisersToRead(peer: Peer): AdvSource[] {
  const out: AdvSource[] = []
  const vehicleAdvisers = peer.vehicles.filter((v) => v.adviser)
  for (const v of vehicleAdvisers) {
    if (out.some((o) => o.crd === v.adviser!.crd)) continue
    out.push({ crd: v.adviser!.crd, name: v.adviser!.name, basis: v.adviser!.basis, scope: "vehicle", vehicleCik: v.cik })
  }
  const everyVehicleHasItsOwn = peer.vehicles.length > 0 && vehicleAdvisers.length === peer.vehicles.length
  if (peer.adviser && !everyVehicleHasItsOwn && !out.some((o) => o.crd === peer.adviser!.crd)) {
    out.push({ crd: peer.adviser.crd, name: peer.adviser.name, basis: peer.adviser.basis, scope: "manager" })
  }
  return out
}

/**
 * A fund name folded for comparison: case, accents, punctuation and the
 * entity suffix dropped, so "FUND 4, L.P." meets "Fund 4, L.P." and
 * "Fund III L.P." meets "Fund III, LP". Parentheticals are kept — "(Employee)"
 * and "(Offshore)" tell sibling vehicles apart.
 */
export function fundKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,'’"&\-–—]/g, " ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/\b(l\s*l\s*c|l\s*p|llp|inc|ltd|limited|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export type AdvLinkBasis = "file-number" | "name"

export type LinkedFund = {
  fund: AdvFund
  /** The adviser whose filing lists it. */
  crd: string
  vehicleCik: string
  linkBasis: AdvLinkBasis
  /**
   * One point per year from the bulk history, then the current filing.
   * Just the current point for a fund that first appears after 2024.
   */
  series: AdvYearPoint[]
  notes: AdvSeriesNote[]
}

/** A fund the adviser reports that matches no tracked vehicle: enough to list, not the whole record. */
export type AdvFundBrief = {
  name: string
  fundId: string | null
  fundTypes: string[]
  grossAssetValue: number | null
  beneficialOwners: number | null
  isFeederFund: boolean | null
  annualAudit: boolean | null
  opinion: AdvFund["opinion"]
  statementsDistributed: boolean | null
  formDFileNumber: string | null
}

export type AdvSummary = {
  /** Every fund on the filings read, linked or not. */
  funds: number
  feeders: number
  /** Gross asset value summed over funds that are not feeders, so a master and its feeder are not counted twice. */
  grossAssetValue: number | null
  /** How many non-feeder funds the sum covers. */
  grossAssetValueFunds: number
  byType: Array<{ type: string; funds: number; grossAssetValue: number }>
  audit: { audited: number; notAudited: number; unanswered: number }
  opinions: { unqualified: number; notUnqualified: number; reportNotYetReceived: number; unanswered: number }
  /** Funds whose audited statements were not distributed to all investors (question 23(g) answered No). */
  statementsNotDistributed: number
  regulationD: number
}

export type ManagerAdv = {
  peerId: string
  /** One per adviser read, in the order `advisersToRead` gives. */
  filings: Array<{
    crd: string
    adviserName: string
    scope: "manager" | "vehicle"
    basis: string
    filingType: string | null
    filedOn: string | null
    fetchedOn: string
    fundsReported: number | null
    fundsParsed: number
    notes: string[]
  }>
  /** Funds attached to a tracked vehicle, in full. */
  linked: LinkedFund[]
  /** Every other fund the adviser reports, largest first. */
  others: AdvFundBrief[]
  summary: AdvSummary
  /**
   * The advisers' book by year — funds listed and gross assets over
   * non-feeders — from the bulk history, then the current filing. Summed
   * across the advisers read where a manager has more than one.
   */
  years: AdviserYear[]
}

/** What a vehicle brings to the link: its registry name and, from its Form D trail, its file number. */
export type VehicleKey = { cik: string; name: string; fileNumber: string | null }

function brief(f: AdvFund): AdvFundBrief {
  return {
    name: f.name,
    fundId: f.fundId,
    fundTypes: f.fundTypes,
    grossAssetValue: f.grossAssetValue,
    beneficialOwners: f.beneficialOwners,
    isFeederFund: f.isFeederFund,
    annualAudit: f.annualAudit,
    opinion: f.opinion,
    statementsDistributed: f.statementsDistributed,
    formDFileNumber: f.formDFileNumber,
  }
}

export function summarise(funds: readonly AdvFund[]): AdvSummary {
  const nonFeeders = funds.filter((f) => f.isFeederFund !== true)
  const withGav = nonFeeders.filter((f) => f.grossAssetValue != null)
  const byType = new Map<string, { funds: number; grossAssetValue: number }>()
  for (const f of nonFeeders) {
    const types = f.fundTypes.length ? f.fundTypes : ["type not reported"]
    for (const t of types) {
      const e = byType.get(t) ?? { funds: 0, grossAssetValue: 0 }
      e.funds++
      e.grossAssetValue += f.grossAssetValue ?? 0
      byType.set(t, e)
    }
  }
  const count = (pred: (f: AdvFund) => boolean) => funds.filter(pred).length
  return {
    funds: funds.length,
    feeders: count((f) => f.isFeederFund === true),
    grossAssetValue: withGav.length ? withGav.reduce((a, f) => a + (f.grossAssetValue as number), 0) : null,
    grossAssetValueFunds: withGav.length,
    byType: [...byType]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.grossAssetValue - a.grossAssetValue || b.funds - a.funds),
    audit: {
      audited: count((f) => f.annualAudit === true),
      notAudited: count((f) => f.annualAudit === false),
      unanswered: count((f) => f.annualAudit == null),
    },
    opinions: {
      unqualified: count((f) => f.opinion === "unqualified"),
      notUnqualified: count((f) => f.opinion === "not-unqualified"),
      reportNotYetReceived: count((f) => f.opinion === "report-not-yet-received"),
      unanswered: count((f) => f.opinion == null),
    },
    statementsNotDistributed: count((f) => f.statementsDistributed === false),
    regulationD: count((f) => f.reliedOnRegulationD === true),
  }
}

/**
 * A manager's ADV view from the extract. Null when none of its advisers has
 * an entry — the case for a manager with no adviser, and for one whose
 * refresh has not run; the panel tells those apart from the registry.
 */
export function managerAdv(
  peer: Peer,
  extract: AdvExtract | null,
  vehicles: readonly VehicleKey[],
  history: AdvHistory | null = null
): ManagerAdv | null {
  if (!extract) return null
  const sources = advisersToRead(peer).filter((s) => extract.advisers[s.crd])
  if (!sources.length) return null

  const byFileNumber = new Map<string, VehicleKey>()
  const byName = new Map<string, VehicleKey>()
  for (const v of vehicles) {
    if (v.fileNumber) byFileNumber.set(v.fileNumber, v)
    byName.set(fundKey(v.name), v)
  }
  // The registry's names cover vehicles whose trail has not been read yet.
  for (const v of peer.vehicles) if (!byName.has(fundKey(v.name))) byName.set(fundKey(v.name), { cik: v.cik, name: v.name, fileNumber: null })

  const all: AdvFund[] = []
  const linked: LinkedFund[] = []
  const others: AdvFundBrief[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    for (const fund of extract.advisers[s.crd].funds) {
      const dedupe = fund.fundId ?? `${s.crd}:${fundKey(fund.name)}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      all.push(fund)
      const byNumber = fund.formDFileNumber ? byFileNumber.get(fund.formDFileNumber) : undefined
      const vehicle = byNumber ?? byName.get(fundKey(fund.name))
      if (vehicle) {
        const filedOn = extract.advisers[s.crd].filedOn
        const past = (fund.fundId ? history?.funds[fund.fundId]?.points : undefined) ?? []
        const series = yearlySeries(past, filedOn ? currentPoint(fund, filedOn) : null)
        linked.push({ fund, crd: s.crd, vehicleCik: vehicle.cik, linkBasis: byNumber ? "file-number" : "name", series, notes: seriesNotes(series) })
      } else others.push(brief(fund))
    }
  }
  others.sort((a, b) => (b.grossAssetValue ?? -1) - (a.grossAssetValue ?? -1) || a.name.localeCompare(b.name))

  // The book by year, summed across the advisers read.
  const yearsByYear = new Map<number, AdviserYear>()
  for (const s of sources) {
    const e = extract.advisers[s.crd]
    const own = history ? adviserYears(history, s.crd, { filedOn: e.filedOn, funds: e.funds }) : e.filedOn ? adviserYears({ builtOn: "", source: "", coverage: { from: "", to: "" }, funds: {} }, s.crd, { filedOn: e.filedOn, funds: e.funds }) : []
    for (const y of own) {
      const have = yearsByYear.get(y.year)
      if (!have) yearsByYear.set(y.year, { ...y })
      else {
        have.funds += y.funds
        have.grossAssetValue = have.grossAssetValue == null && y.grossAssetValue == null ? null : (have.grossAssetValue ?? 0) + (y.grossAssetValue ?? 0)
        have.grossAssetValueFunds += y.grossAssetValueFunds
        if (y.filedOn > have.filedOn) have.filedOn = y.filedOn
      }
    }
  }
  const years = [...yearsByYear.values()].sort((a, b) => a.year - b.year)

  return {
    peerId: peer.id,
    filings: sources.map((s) => {
      const e = extract.advisers[s.crd]
      return {
        crd: s.crd,
        adviserName: e.adviserName,
        scope: s.scope,
        basis: s.basis,
        filingType: e.filingType,
        filedOn: e.filedOn,
        fetchedOn: e.fetchedOn,
        fundsReported: e.fundsReported,
        fundsParsed: e.funds.length,
        notes: e.notes,
      }
    }),
    linked,
    others,
    summary: summarise(all),
    years,
  }
}

/** The ADV funds attached to one vehicle — a master and its feeder can both be. Masters first. */
export function advForVehicle(adv: ManagerAdv | null, cik: string): LinkedFund[] {
  return (adv?.linked ?? [])
    .filter((f) => f.vehicleCik === cik)
    .sort((a, b) => Number(a.fund.isFeederFund === true) - Number(b.fund.isFeederFund === true))
}

/** The ADV views for every manager in a layer, keyed by peer id. */
export function layerAdv(
  peers: readonly Peer[],
  extract: AdvExtract | null,
  vehicleKeys: ReadonlyMap<string, readonly VehicleKey[]>,
  history: AdvHistory | null = null
): { refreshedOn: string | null; historyTo: string | null; byManager: Record<string, ManagerAdv> } {
  const byManager: Record<string, ManagerAdv> = {}
  for (const peer of peers) {
    const view = managerAdv(peer, extract, vehicleKeys.get(peer.id) ?? [], history)
    if (view) byManager[peer.id] = view
  }
  return { refreshedOn: extract?.refreshedOn ?? null, historyTo: history?.coverage.to ?? null, byManager }
}
