/**
 * Manager- and layer-level aggregation of Form D raises.
 *
 * `form-d.ts` turns one vehicle's filing trail into a `Raise`. This turns many
 * raises into the two things the tab needs: what each competing manager is
 * doing, and what the layer as a whole looks like — the "Raise Environment"
 * the capital-raising brief is really asking for.
 *
 * Pure: records in, aggregates out. The fetching is in
 * `app/services/peer-intel.ts` and the caching in `app/actions/peer-intel.ts`.
 *
 * **Counting rule, and the reason for it.** A single fundraise is routinely
 * spread across several SEC filers — an onshore LP, an offshore or
 * international feeder, a master, a parallel sleeve. Each files its own Form D
 * reporting its own slice of the capital. So capital is summed over *every*
 * vehicle, while raises are *counted* only over those the registry marks as a
 * fund. Bridge Debt Strategies Fund VI is one raise across four CIKs; counting
 * filers would say four, and would divide its capital four ways when averaging
 * progress.
 */

import { buildRaise, isLikelyOpen, isNewLaunch, type OfferingRecord, type Raise } from "./form-d"
import type { PeerLayer } from "./edgar-contract"
import {
  peersInScope,
  type Peer,
  type PeerVehicle,
  type VehicleKind,
  type VehicleRole,
} from "./registry"

/** A raise with the registry's view of the vehicle that filed it. */
export type VehicleRaise = {
  raise: Raise
  cik: string
  /** The registry's name, which is stable; `raise.fundName` comes from the filing. */
  vehicleName: string
  role: VehicleRole
  kind: VehicleKind
  open: boolean
  newLaunch: boolean
}

export type ManagerRaises = {
  peerId: string
  manager: string
  layer: PeerLayer
  location: string
  relevance: Peer["relevance"]
  isSelf: boolean
  /** Newest filing first, so the active raises lead. */
  raises: VehicleRaise[]
  /** Sum of amount sold across every vehicle, sleeves included. */
  totalRaised: number | null
  /** Sum of numeric offering amounts across fund-role vehicles only. */
  totalSought: number | null
  /** Fund-role vehicles whose offering amount is indefinite, so excluded above. */
  indefiniteTargets: number
  /** Raises, not filers: fund-role vehicles only. */
  raiseCount: number
  openRaiseCount: number
  newLaunchCount: number
  targetCutCount: number
  /** `YYYY-MM-DD` of the newest filing across all vehicles. */
  lastFiled: string | null
  /** Whether this manager has any open raise at all. */
  inMarket: boolean
}

export type PeerCohort = {
  layer: PeerLayer
  /** `YYYY-MM-DD`; staleness and the launch window are measured from here. */
  asOf: string
  /** The window `newLaunchCount` is measured over, `YYYY-MM-DD`. */
  launchWindowStart: string
  managers: ManagerRaises[]
  /** Safe Harbor's own row, pulled out so the tab can benchmark against the rest. */
  self: ManagerRaises | null
  totals: {
    managers: number
    managersRaising: number
    vehicles: number
    raiseCount: number
    activeRaiseCount: number
    newLaunchCount: number
    targetCutCount: number
    totalRaised: number | null
    totalSought: number | null
    indefiniteTargets: number
  }
  /** What is and is not observable in this layer, for the panel footers. */
  coverage: {
    registeredVehicles: number
    privateVehicles: number
    /**
     * Registered vehicles with no Form D, which is the expected shape rather
     * than a gap: a listed REIT or non-traded BDC raises through a registered
     * offering, not Regulation D, so it files no Form D at all. Its fundraising
     * shows up as share issuance in its periodic reports, which step 3 reads.
     * Some run a parallel Reg D offering as well — BREIT does — so this is
     * "expected", never "required".
     */
    registeredWithoutFormD: number
    /**
     * Private vehicles that returned no readable filing. These are real gaps:
     * a Reg D fund must have a Form D, so a missing one means a fetch failed or
     * the registry has the wrong CIK.
     */
    unresolvedVehicles: number
  }
}

function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null)
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

function roleOf(vehicle: PeerVehicle): VehicleRole {
  return vehicle.role ?? "fund"
}

/**
 * One manager's raises.
 *
 * `byCik` holds the offering records fetched for each of its vehicles. A
 * vehicle missing from it, or with no readable filing, is skipped rather than
 * counted as a raise of zero — a fetch failure must not read as a manager who
 * has raised nothing.
 */
export function buildManagerRaises(
  peer: Peer,
  byCik: ReadonlyMap<string, OfferingRecord[]>,
  asOf: string,
  launchWindowStart: string
): ManagerRaises {
  const raises: VehicleRaise[] = []
  for (const vehicle of peer.vehicles) {
    const records = byCik.get(vehicle.cik)
    if (!records?.length) continue
    const raise = buildRaise(records, asOf)
    if (!raise) continue
    raises.push({
      raise,
      cik: vehicle.cik,
      vehicleName: vehicle.name,
      role: roleOf(vehicle),
      kind: vehicle.kind,
      open: isLikelyOpen(raise),
      newLaunch: isNewLaunch(raise, launchWindowStart),
    })
  }
  raises.sort((a, b) => (a.raise.lastFiled ?? "") < (b.raise.lastFiled ?? "") ? 1 : -1)

  const funds = raises.filter((r) => r.role === "fund")

  return {
    peerId: peer.id,
    manager: peer.manager,
    layer: peer.layer,
    location: peer.location,
    relevance: peer.relevance,
    isSelf: peer.isSelf === true,
    raises,
    // Capital over every vehicle: a sleeve's slice is part of the raise.
    totalRaised: sumOrNull(raises.map((r) => r.raise.sold)),
    // Offering amounts over funds only: a sleeve restates the same ask.
    totalSought: sumOrNull(funds.map((r) => (typeof r.raise.target === "number" ? r.raise.target : null))),
    indefiniteTargets: funds.filter((r) => r.raise.target === "indefinite").length,
    raiseCount: funds.length,
    openRaiseCount: funds.filter((r) => r.open).length,
    newLaunchCount: funds.filter((r) => r.newLaunch).length,
    targetCutCount: funds.filter((r) => r.raise.targetCut).length,
    lastFiled: raises.map((r) => r.raise.lastFiled).filter((d): d is string => d != null).sort().pop() ?? null,
    inMarket: funds.some((r) => r.open),
  }
}

/** Twelve months before `asOf`, the default window for "newly launched". */
export function defaultLaunchWindowStart(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number)
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/**
 * The whole layer.
 *
 * Managers are ordered by capital raised, largest first, because the question
 * the tab answers first is who the big competitors are. Safe Harbor stays in
 * the list — it is a real competitor in its own market — and is also surfaced
 * separately as `self` so a panel can draw the comparison without searching.
 */
export function buildPeerCohort(
  layer: PeerLayer,
  byCik: ReadonlyMap<string, OfferingRecord[]>,
  asOf: string,
  launchWindowStart = defaultLaunchWindowStart(asOf)
): PeerCohort {
  const peers = peersInScope(layer)
  const managers = peers
    .map((peer) => buildManagerRaises(peer, byCik, asOf, launchWindowStart))
    .sort((a, b) => (b.totalRaised ?? -1) - (a.totalRaised ?? -1))

  const allVehicles = peers.flatMap((p) => p.vehicles)
  const resolved = new Set(managers.flatMap((m) => m.raises.map((r) => r.cik)))

  return {
    layer,
    asOf,
    launchWindowStart,
    managers,
    self: managers.find((m) => m.isSelf) ?? null,
    totals: {
      managers: managers.length,
      managersRaising: managers.filter((m) => m.inMarket).length,
      vehicles: allVehicles.length,
      raiseCount: managers.reduce((n, m) => n + m.raiseCount, 0),
      activeRaiseCount: managers.reduce((n, m) => n + m.openRaiseCount, 0),
      newLaunchCount: managers.reduce((n, m) => n + m.newLaunchCount, 0),
      targetCutCount: managers.reduce((n, m) => n + m.targetCutCount, 0),
      totalRaised: sumOrNull(managers.map((m) => m.totalRaised)),
      totalSought: sumOrNull(managers.map((m) => m.totalSought)),
      indefiniteTargets: managers.reduce((n, m) => n + m.indefiniteTargets, 0),
    },
    coverage: {
      registeredVehicles: allVehicles.filter((v) => v.kind === "registered").length,
      privateVehicles: allVehicles.filter((v) => v.kind === "private").length,
      registeredWithoutFormD: allVehicles.filter((v) => v.kind === "registered" && !resolved.has(v.cik)).length,
      unresolvedVehicles: allVehicles.filter((v) => v.kind === "private" && !resolved.has(v.cik)).length,
    },
  }
}

/**
 * The raises a reader should see first: open, fund-role, newest filing first.
 *
 * Sleeves are left out because showing four rows for one fund reads as four
 * competitors; step 5 can group them under their fund for display.
 */
export function activeRaises(cohort: PeerCohort): Array<VehicleRaise & { manager: string; peerId: string }> {
  return cohort.managers
    .flatMap((m) => m.raises.map((r) => ({ ...r, manager: m.manager, peerId: m.peerId })))
    .filter((r) => r.role === "fund" && r.open)
    .sort((a, b) => ((a.raise.lastFiled ?? "") < (b.raise.lastFiled ?? "") ? 1 : -1))
}

/** Raises whose first sale, or first filing, falls inside the launch window. */
export function newLaunches(cohort: PeerCohort): Array<VehicleRaise & { manager: string; peerId: string }> {
  return cohort.managers
    .flatMap((m) => m.raises.map((r) => ({ ...r, manager: m.manager, peerId: m.peerId })))
    .filter((r) => r.role === "fund" && r.newLaunch)
    .sort((a, b) => ((a.raise.firstSale ?? a.raise.firstFiled ?? "") < (b.raise.firstSale ?? b.raise.firstFiled ?? "") ? 1 : -1))
}

/**
 * Where Safe Harbor's current raise sits against the layer's open raises.
 *
 * Null when there is no open self raise or fewer than three peer raises to
 * compare against — a percentile over two funds is noise, and saying nothing is
 * better than saying something meaningless.
 */
export function selfPositioning(cohort: PeerCohort): {
  selfRaise: VehicleRaise
  peerCount: number
  /** Rank by amount raised, 1 = largest. */
  rankBySold: number
  /** Median amount sold across the compared raises. */
  medianSold: number
  /** Median share of offering sold, over raises with a numeric target. */
  medianProgress: number | null
} | null {
  if (!cohort.self) return null
  const selfRaise = cohort.self.raises.find((r) => r.role === "fund" && r.open)
  if (!selfRaise || selfRaise.raise.sold == null) return null

  const others = activeRaises(cohort).filter((r) => r.peerId !== cohort.self!.peerId && r.raise.sold != null)
  if (others.length < 3) return null

  const sold = others.map((r) => r.raise.sold as number).sort((a, b) => a - b)
  const progresses = others.map((r) => r.raise.progress).filter((p): p is number => p != null).sort((a, b) => a - b)
  const median = (xs: number[]) =>
    xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2

  return {
    selfRaise,
    peerCount: others.length,
    rankBySold: sold.filter((v) => v > (selfRaise.raise.sold as number)).length + 1,
    medianSold: median(sold),
    medianProgress: progresses.length ? median(progresses) : null,
  }
}
