/**
 * What the peer tab says in words, built from the figures on it.
 *
 * The readings here are **deterministic, not model calls** — the same decision
 * as the Balance-Sheet Actions panel (`buildReading` in
 * `lib/analytics/bank-behavior-panel.ts`). Building the sentence from the
 * figures already on the panel satisfies "every figure is checked against the
 * data" by construction, costs nothing per open, and cannot drift from the
 * table. So there is no figure-checker and no fallback path.
 *
 * Pure: aggregates in, strings out.
 */

import { buildFilingIndexUrl } from "./edgar-contract"
import type { ManagerRaises, PeerCohort, VehicleRaise } from "./cohort"
import { activeRaises, newLaunches, selfPositioning } from "./cohort"
import { peerSignalSpec, type ManagerSignals, type PeerSignalKey } from "./signals"
import { UNRESOLVED_WATCH } from "./registry"
import { structureRows } from "./structure"
import { buildPeopleIndex, managerPeople } from "./people"
import type { ManagerAdv } from "./adv-link"
import type { ContinuationView } from "./continuation"

export function money(value: number | "indefinite" | null | undefined): string {
  if (value === "indefinite") return "no stated cap"
  if (value == null) return "not reported"
  const sign = value < 0 ? "−" : ""
  const a = Math.abs(value)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`
  return `${sign}$${Math.round(a)}`
}

export function percent(value: number | null | undefined, digits = 0): string {
  return value == null ? "not reported" : `${(value * 100).toFixed(digits)}%`
}

/** `2026-07-23` to `July 2026`, for prose that should not read like a log line. */
export function monthYear(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return "an unknown date"
  const [y, m] = iso.split("-").map(Number)
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"]
  return `${months[m - 1]} ${y}`
}

const LAYER_NAMES: Record<string, string> = {
  "miami-dade": "Miami-Dade",
  florida: "Florida",
  national: "the US",
}

export function layerName(layer: string): string {
  return LAYER_NAMES[layer] ?? layer
}

/**
 * The reading above the Raise Environment figures.
 *
 * Answers, in order: how many competitors are in the market, how much they are
 * asking for, what has just launched, who is cutting back, and — where the data
 * exists — whether money is going in or coming out. Every clause is dropped
 * rather than hedged when its figure is missing.
 */
export function buildEnvironmentReading(cohort: PeerCohort): string {
  const t = cohort.totals
  const where = layerName(cohort.layer)
  const sentences: string[] = []

  if (!t.managersRaising) {
    sentences.push(
      `None of the ${t.managers} tracked ${where} managers has filed an open offering recently, so there is no live raise to compare against.`
    )
    return sentences.join(" ")
  }

  sentences.push(
    `${t.managersRaising} of ${t.managers} tracked ${where} managers are in the market, across ${t.activeRaiseCount} open ${t.activeRaiseCount === 1 ? "raise" : "raises"}.`
  )

  if (t.totalSought != null) {
    const indefinite = t.indefiniteTargets
      ? `, and a further ${t.indefiniteTargets} ${t.indefiniteTargets === 1 ? "offering states" : "offerings state"} no cap`
      : ""
    sentences.push(`They have raised ${money(t.totalRaised)} in total against stated offerings of ${money(t.totalSought)}${indefinite}.`)
  } else {
    sentences.push(`They have raised ${money(t.totalRaised)} in total; no offering in this layer states a cap, so there is no target to measure against.`)
  }

  if (t.newLaunchCount) {
    sentences.push(
      `${t.newLaunchCount} ${t.newLaunchCount === 1 ? "fund has" : "funds have"} opened in the last twelve months.`
    )
  }
  if (t.targetCutCount) {
    sentences.push(
      `${t.targetCutCount} ${t.targetCutCount === 1 ? "manager has" : "managers have"} reduced what they are asking for, which is not something a manager announces.`
    )
  }

  if (cohort.coverage.registeredVehicles === 0) {
    sentences.push(
      `Every peer in this layer is a private fund, so this is the raise and nothing else: portfolios, performance and redemptions are not reported at any point in a private fund's life.`
    )
  }

  return sentences.join(" ")
}

/**
 * Where the firm's own raise sits.
 *
 * Deliberately blunt in both directions — the point of putting Safe Harbor on
 * the same axes as its peers is to see the unflattering comparison as readily
 * as the flattering one.
 */
export function buildSelfReading(cohort: PeerCohort): string | null {
  const pos = selfPositioning(cohort)
  if (!pos) {
    const self = cohort.self
    if (!self) return null
    const open = self.raises.find((r) => r.role === "fund" && r.open)
    if (!open) {
      return `Safe Harbor has no open offering on file in this layer, so there is nothing to compare against its peers.`
    }
    return `Fewer than three peer raises in ${layerName(cohort.layer)} can be compared against ${open.vehicleName}, so no ranking is shown — a position among two funds would not mean anything.`
  }

  const r = pos.selfRaise.raise
  const total = pos.peerCount + 1
  const ahead = pos.rankBySold - 1
  const parts: string[] = [
    `${pos.selfRaise.vehicleName} has raised ${money(r.sold)}${r.progress != null ? ` of its ${money(r.target)} offering (${percent(r.progress, 1)})` : ""}, which ranks ${pos.rankBySold} of ${total} open raises in ${layerName(cohort.layer)}.`,
  ]
  parts.push(
    ahead === 0
      ? `No peer raise in this layer is larger.`
      : `${ahead} peer ${ahead === 1 ? "raise is" : "raises are"} larger.`
  )
  parts.push(
    `The median open peer raise has taken ${money(pos.medianSold)}${pos.medianProgress != null ? ` and is ${percent(pos.medianProgress, 1)} subscribed` : ""}.`
  )
  if (r.sold != null) {
    const vsMedian = r.sold - pos.medianSold
    parts.push(
      vsMedian >= 0
        ? `Safe Harbor is ${money(vsMedian)} above that median.`
        : `Safe Harbor is ${money(Math.abs(vsMedian))} below that median.`
    )
  }
  if (r.targetCut && r.targetHigh != null) {
    const peersCut = cohort.managers.filter((m) => !m.isSelf && m.targetCutCount > 0).length
    parts.push(
      `Its offering was cut from ${money(r.targetHigh)}${
        peersCut === 0
          ? `, and no other manager in this layer has cut one`
          : `; ${peersCut} other ${peersCut === 1 ? "manager has" : "managers have"} also cut`
      }.`
    )
  }
  return parts.join(" ")
}

/**
 * One manager's reading, for the drawer.
 *
 * Built from the signals that actually fired plus the figures behind them, so
 * it cannot say anything the panel does not show. Where a whole family is
 * unjudged it says why, because "no redemption signal" and "redemptions not
 * reported" mean very different things to a reader.
 */
export function buildManagerReading(manager: ManagerRaises, signals: ManagerSignals): string {
  const sentences: string[] = []
  const fired = new Set(signals.firedKeys)
  const stateOf = (key: PeerSignalKey) => signals.signals.find((s) => s.key === key)
  const detail = (key: PeerSignalKey) => stateOf(key)?.detail?.replace(/^[^:]+:\s*/, "") ?? null

  const open = manager.raises.filter((r) => r.role === "fund" && r.open)
  if (!manager.raises.length) {
    return `No readable Form D filing was found for ${manager.manager}, so nothing can be said about its fundraising.`
  }

  sentences.push(
    open.length
      ? `${manager.manager} has ${open.length} open ${open.length === 1 ? "raise" : "raises"} of ${manager.raiseCount} in the registry, and has raised ${money(manager.totalRaised)} across all vintages.`
      : `${manager.manager} has no open raise on file; the newest of its ${manager.raiseCount} ${manager.raiseCount === 1 ? "fund" : "funds"} last filed in ${monthYear(manager.lastFiled)}, and it has raised ${money(manager.totalRaised)} across all vintages.`
  )

  if (fired.has("newVehicle")) {
    sentences.push(`It has opened a new fund in the last twelve months${detail("newVehicle") ? ` (${detail("newVehicle")})` : ""}.`)
  }
  if (fired.has("raiseAccelerating")) {
    sentences.push(`Capital is arriving faster than it was: ${detail("raiseAccelerating")}.`)
  }
  if (fired.has("targetCut")) {
    sentences.push(`It has reduced what it is asking for — ${detail("targetCut")} — which a manager does not announce.`)
  }
  if (fired.has("raiseStalled")) {
    sentences.push(`One of its offerings is open on paper but has not been amended for a year (${detail("raiseStalled")}); Form D carries no closed flag, so a fund that quietly closed reads the same way.`)
  }

  if (fired.has("netOutflow")) {
    sentences.push(`Its semi-liquid vehicle is paying out more than it is taking in — net flow of ${detail("netOutflow")}.`)
  }
  if (fired.has("redemptionAcceleration")) {
    sentences.push(`Redemptions are running above anything that vehicle has seen before: ${detail("redemptionAcceleration")}.`)
  }
  if (fired.has("pikBuild")) {
    sentences.push(`More of its income is being paid in kind, which usually means borrowers cannot pay cash — ${detail("pikBuild")}.`)
  }
  if (fired.has("portfolioShrink")) {
    sentences.push(`Its book is shrinking: ${detail("portfolioShrink")}.`)
  }

  if (!fired.size) {
    sentences.push(`No signal fired on the measures available for it.`)
  }

  // Say what could not be judged, and why — the distinction a reader needs.
  const liquidity = stateOf("netOutflow")
  if (liquidity?.state === "unjudged") {
    sentences.push(
      liquidity.missing?.includes("listed")
        ? `Its liquidity signals are not judged: its shares trade, so repurchases are a buyback rather than investors being paid out.`
        : `Liquidity and portfolio figures are not observable for this manager — a private fund reports none of them.`
    )
  } else if (stateOf("pikBuild")?.state === "unjudged" && stateOf("pikBuild")?.missing?.includes("not tagged")) {
    sentences.push(`Payment-in-kind income is not tagged by this filer, so the PIK signal is not judged.`)
  }

  return sentences.join(" ")
}

/** The fired signals in a stable display order: action first, then pressure. */
export function orderedSignals(signals: ManagerSignals): ManagerSignals["signals"] {
  const weight = (key: PeerSignalKey) => {
    const spec = peerSignalSpec(key)
    return spec?.side === "action" ? 0 : 1
  }
  return [...signals.signals].sort((a, b) => {
    const stateRank = (s: string) => (s === "fired" ? 0 : s === "quiet" ? 1 : 2)
    return stateRank(a.state) - stateRank(b.state) || weight(a.key) - weight(b.key) || a.key.localeCompare(b.key)
  })
}

/**
 * Copy Snapshot for a manager, matching the institution drawer's behaviour.
 *
 * Plain text, because it is pasted into an email or a memo.
 */
export function buildManagerSnapshot(
  manager: ManagerRaises,
  signals: ManagerSignals,
  cohort: PeerCohort,
  adv: ManagerAdv | null = null,
  continuation: ContinuationView | null = null
): string {
  const lines: string[] = [
    `${manager.manager} — ${manager.location}`,
    `Layer: ${layerName(manager.layer)} · relevance: ${manager.relevance}`,
    `Raised across all vintages: ${money(manager.totalRaised)}`,
    `Raises: ${manager.raiseCount} (${manager.openRaiseCount} open)${manager.lastFiled ? ` · last filed ${manager.lastFiled}` : ""}`,
    "",
  ]

  if (manager.raises.length) {
    lines.push("Raises:")
    for (const r of manager.raises) {
      lines.push(
        `  ${r.vehicleName}${r.role === "sleeve" ? " (sleeve)" : ""} — ` +
          `offering ${money(r.raise.target)}, raised ${money(r.raise.sold)}` +
          `${r.raise.progress != null ? ` (${percent(r.raise.progress, 1)})` : ""}` +
          `${r.raise.investorCount != null ? `, ${r.raise.investorCount} investors` : ""}` +
          `${r.raise.lastFiled ? `, last filed ${r.raise.lastFiled}` : ""}` +
          `${r.raise.targetCut && r.raise.targetHigh != null ? `, cut from ${money(r.raise.targetHigh)}` : ""}`
      )
    }
    lines.push("")
  }

  const firedSignals = signals.signals.filter((s) => s.state === "fired")
  lines.push(firedSignals.length ? "Signals fired:" : "Signals fired: none")
  for (const s of firedSignals) {
    lines.push(`  ${peerSignalSpec(s.key)?.label ?? s.key}${s.detail ? ` — ${s.detail}` : ""}`)
  }

  const unjudged = signals.signals.filter((s) => s.state === "unjudged")
  if (unjudged.length) {
    lines.push("", "Not judged:")
    for (const s of unjudged) {
      lines.push(`  ${peerSignalSpec(s.key)?.label ?? s.key}${s.missing ? ` — ${s.missing}` : ""}`)
    }
  }

  const structure = structureRows(manager, cohort.managers)
  if (structure.length) {
    lines.push("", "Structure & terms:")
    for (const row of structure) {
      const t = row.terms
      const commissions =
        t.salesCommissions.amount == null
          ? "commissions not reported"
          : t.salesCommissions.amount === 0
            ? "no commissions"
            : `commissions ${money(t.salesCommissions.amount)}${t.salesCommissions.estimate ? " (est.)" : ""}${row.commissionShare != null ? `, ${percent(row.commissionShare, 2)} of offering` : ""}`
      lines.push(
        `  ${row.vehicleName}${row.role === "sleeve" ? " (sleeve)" : ""} — ${row.exemptions.map((e) => e.label).join(", ") || "exemptions not reported"}; ${commissions}` +
          `${row.coIssuers.length ? `; files jointly with ${row.coIssuers.map((c) => c.name).join(", ")}` : ""}`
      )
      for (const ch of row.exemptionChanges) {
        lines.push(`    exemptions changed ${ch.filedAt}: +${ch.added.map((e) => e.label).join(", ") || "—"} −${ch.removed.map((e) => e.label).join(", ") || "—"}`)
      }
    }
  }

  const people = managerPeople(manager, buildPeopleIndex(cohort.managers))
  if (people.length) {
    lines.push("", "People (Form D related persons):")
    for (const p of people) {
      lines.push(
        `  ${p.name}${p.kind === "entity" ? " [entity]" : ""} — ${p.roles.join(", ") || "role not stated"}` +
          `${p.elsewhere.length ? `; same name at ${p.elsewhere.map((o) => o.manager).join(", ")} (name match)` : ""}`
      )
    }
  }

  if (adv) {
    const s = adv.summary
    lines.push("", "Form ADV (adviser's own filing, Schedule D 7.B.(1)):")
    for (const f of adv.filings) {
      lines.push(`  ${f.adviserName} CRD ${f.crd} — ${f.filingType ?? "Form ADV"}${f.filedOn ? ` filed ${f.filedOn}` : ""}, ${f.fundsParsed} private funds`)
    }
    if (s.funds > 0) {
      lines.push(
        `  ${s.funds} private funds${s.feeders ? ` (${s.feeders} feeders)` : ""}, gross assets ${money(s.grossAssetValue)} over ${s.grossAssetValueFunds} non-feeder funds; ` +
          `audited ${s.audit.audited} of ${s.funds}, clean opinions ${s.opinions.unqualified}, not unqualified ${s.opinions.notUnqualified}, ` +
          `report pending ${s.opinions.reportNotYetReceived}, statements not distributed ${s.statementsNotDistributed}`
      )
      for (const l of adv.linked) {
        const vehicle = manager.raises.find((r) => r.cik === l.vehicleCik)
        const f = l.fund
        lines.push(
          `  ${f.name}${vehicle ? ` [${vehicle.vehicleName}]` : ""} — gross assets ${money(f.grossAssetValue)}, ${f.beneficialOwners ?? "?"} owners` +
            `${f.annualAudit === false ? ", NOT audited" : f.opinion ? `, ${f.opinion.replace(/-/g, " ")}` : ""}` +
            `${f.statementsDistributed === false ? ", statements not distributed" : ""}` +
            `${f.auditors.length ? `, auditor ${f.auditors.map((a) => a.name).join("; ")}` : ""}`
        )
        if (l.series.length > 1) {
          lines.push(`    by year: ${l.series.map((p) => `${p.year} ${money(p.grossAssetValue)} / ${p.owners ?? "?"} owners`).join("; ")}`)
          for (const n of l.notes) lines.push(`    ${n.text}`)
        }
      }
      if (adv.years.length > 1) {
        lines.push(`  book by year: ${adv.years.map((y) => `${y.year} ${money(y.grossAssetValue)} (${y.funds} funds)`).join("; ")}`)
      }
    }
  }

  if (continuation) {
    lines.push("", continuation.vehicles.length ? "Continuation, annex and extension vehicles (a flag, not a score):" : `Continuation, annex and extension vehicles: none found${continuation.searched ? "" : " (not searched)"}`)
    for (const v of continuation.vehicles) {
      lines.push(
        `  ${v.name} — ${v.kind === "cv" ? "continuation vehicle" : `${v.kind} fund`}` +
          `${v.predecessor ? `, likely continues ${v.predecessor.name}` : ""}` +
          `${v.formD ? (!v.formD.sold && !v.formD.investorCount ? `; Form D filed ${v.formD.lastFiled ?? "n/a"}, no sale reported yet` : `; Form D first sale ${v.formD.firstSale ?? "n/a"}, raised ${money(v.formD.sold)}${v.formD.investorCount != null ? ` from ${v.formD.investorCount} investors` : ""}`) : ""}` +
          `${v.adv ? `; ADV gross assets ${money(v.adv.grossAssetValue)}` : ""}` +
          `; attributed by ${v.attribution.map((a) => (a.basis === "adv" ? "ADV record" : a.basis === "name" ? `name "${a.phrase}"` : `shared people (${a.names.join(", ")})`)).join(", ")}`
      )
    }
  }

  lines.push("", "Reading:", buildManagerReading(manager, signals))
  lines.push("", `Source: SEC EDGAR Form D and XBRL company facts, as of ${cohort.asOf}. Form D figures are self-reported by the issuer and unaudited.`)
  return lines.join("\n")
}

/** The rows the Active Raises table shows, with the firm's own raise first. */
export function activeRaiseRows(cohort: PeerCohort): Array<VehicleRaise & { manager: string; peerId: string; isSelf: boolean }> {
  const selfId = cohort.self?.peerId
  return activeRaises(cohort)
    .map((r) => ({ ...r, isSelf: r.peerId === selfId }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return (b.raise.sold ?? -1) - (a.raise.sold ?? -1)
    })
}

/**
 * The SEC filing a raise's headline figures came from.
 *
 * The strongest provenance available: rather than asking a reader to trust the
 * table, link them to the document it was read from. Always the newest filing
 * in the trail, because that is the one `target`, `sold` and `investorCount`
 * are taken from.
 */
export function filingUrl(raise: VehicleRaise["raise"]): string | null {
  const newest = raise.filings[raise.filings.length - 1]
  if (!newest?.accession || !newest.cik) return null
  try {
    return buildFilingIndexUrl(newest.cik, newest.accession)
  } catch {
    return null
  }
}

/**
 * What a filing *was*, in fundraising terms rather than the SEC's.
 *
 * "D/A" says only that a Form D was amended. A fund must amend whenever it
 * takes materially more capital and once a year regardless, so an amendment
 * whose amount sold rose is an **interim close** — the word every LP uses, and
 * the unit Preqin's "funds in market" is organised around — while one whose
 * amount sold did not move is the mandatory annual re-file. The figure is
 * cumulative, so the difference between two filings is the capital taken in
 * between them; a single amendment may bundle several closes, which the
 * catalogue entry says.
 *
 * `restated` is a decrease, which does happen — an issuer correcting a prior
 * figure — and is labelled as what it is rather than hidden as "no change".
 */
export type FilingClose = {
  kind: "first" | "interim" | "annual" | "restated" | "unknown"
  /** Change in amount sold since the previous filing; null for the first or where either side is missing. */
  delta: number | null
  /** The previous filing's offering amount when this one states a different numeric one. */
  offeringFrom: number | null
}

/** Classify each filing against the one before it. `filings` oldest-first, as on `Raise`. */
export function classifyFilings(filings: readonly VehicleRaise["raise"]["filings"][number][]): FilingClose[] {
  return filings.map((f, i) => {
    if (i === 0) return { kind: "first", delta: null, offeringFrom: null }
    const prev = filings[i - 1]
    const offeringFrom =
      typeof prev.offeringAmount === "number" &&
      typeof f.offeringAmount === "number" &&
      prev.offeringAmount !== f.offeringAmount
        ? prev.offeringAmount
        : null
    if (f.totalSold == null || prev.totalSold == null) return { kind: "unknown", delta: null, offeringFrom }
    const delta = f.totalSold - prev.totalSold
    const kind: FilingClose["kind"] = delta > 0 ? "interim" : delta < 0 ? "restated" : "annual"
    return { kind, delta, offeringFrom }
  })
}

/** Plain words for a close, for the trail and the chart. */
export function closeLabel(close: FilingClose): string {
  switch (close.kind) {
    case "first":
      return "First filing"
    case "interim":
      return `Interim close, +${money(close.delta)}`
    case "annual":
      return "Annual amendment, no new capital"
    case "restated":
      return `Amount sold restated, ${money(close.delta)}`
    default:
      return "Amendment"
  }
}

/** Every filing behind a raise, newest first, for the drawer's trail. */
export function filingTrail(raise: VehicleRaise["raise"]): Array<{
  formType: string
  filedAt: string
  url: string | null
  sold: number | null
  target: number | "indefinite" | null
  close: FilingClose
}> {
  const closes = classifyFilings(raise.filings)
  return raise.filings
    .map((f, i) => {
      let url: string | null = null
      try {
        url = f.accession && f.cik ? buildFilingIndexUrl(f.cik, f.accession) : null
      } catch {
        url = null
      }
      return { formType: f.formType, filedAt: f.filedAt, url, sold: f.totalSold, target: f.offeringAmount, close: closes[i] }
    })
    .reverse()
}

export function newLaunchRows(cohort: PeerCohort): Array<VehicleRaise & { manager: string; peerId: string }> {
  return newLaunches(cohort)
}

/**
 * Where a manager stands, for the roster.
 *
 * `in-market` has an open offering. `quiet` has raised before but has filed
 * nothing for four quarters — which includes funds that simply closed, since
 * Form D has no closed flag. `not-raising` has no readable filing at all, which
 * for a manager that funds from its own balance sheet is the accurate answer
 * rather than a gap.
 */
export type ManagerStanding = "in-market" | "quiet" | "not-raising"

export type RosterRow = {
  peerId: string
  manager: string
  location: string
  relevance: ManagerRaises["relevance"]
  isSelf: boolean
  standing: ManagerStanding
  totalRaised: number | null
  raiseCount: number
  openRaiseCount: number
  lastFiled: string | null
  firedCount: number
  pressureCount: number
  /** Quarters since the newest filing, for the "last raised" wording. */
  quartersQuiet: number | null
}

/**
 * Every tracked manager in the layer, not just the ones currently raising.
 *
 * The Open Raises and New Launches tables both filter to live offerings, which
 * left the quiet managers with no route into the drawer at all — eleven of
 * twenty-six nationally, including Gelt Financial, whose only Reg D raise
 * closed in 2019 because it lends from its own balance sheet. A tab that says
 * it tracks twenty-six managers has to let a reader reach all of them, and a
 * competitor that has stopped raising is itself worth knowing about.
 *
 * Ordered: the firm itself first, then managers in market by capital raised,
 * then the quiet ones.
 */
export function managerRoster(cohort: PeerCohort, signals: readonly ManagerSignals[]): RosterRow[] {
  const byPeer = new Map(signals.map((s) => [s.peerId, s]))
  const rows = cohort.managers.map((m) => {
    const signalSet = byPeer.get(m.peerId)
    const quartersQuiet = m.raises
      .map((r) => r.raise.quartersSinceFiling)
      .filter((q): q is number => q != null)
      .sort((a, b) => a - b)[0] ?? null
    const standing: ManagerStanding = m.inMarket ? "in-market" : m.raises.length ? "quiet" : "not-raising"
    return {
      peerId: m.peerId,
      manager: m.manager,
      location: m.location,
      relevance: m.relevance,
      isSelf: m.isSelf,
      standing,
      totalRaised: m.totalRaised,
      raiseCount: m.raiseCount,
      openRaiseCount: m.openRaiseCount,
      lastFiled: m.lastFiled,
      firedCount: signalSet?.firedKeys.length ?? 0,
      pressureCount: signalSet?.pressureCount ?? 0,
      quartersQuiet,
    }
  })

  const rank = (r: RosterRow) => (r.isSelf ? 0 : r.standing === "in-market" ? 1 : r.standing === "quiet" ? 2 : 3)
  return rows.sort((a, b) => rank(a) - rank(b) || (b.totalRaised ?? -1) - (a.totalRaised ?? -1))
}

/** Plain words for a manager's standing, including how long it has been quiet. */
export function standingLabel(row: RosterRow): string {
  if (row.standing === "in-market") {
    return `${row.openRaiseCount} open ${row.openRaiseCount === 1 ? "raise" : "raises"}`
  }
  if (row.standing === "not-raising") return "no Reg D filing"
  if (row.quartersQuiet == null) return "quiet"
  const years = Math.floor(row.quartersQuiet / 4)
  if (years >= 1) return `last raised ${years} ${years === 1 ? "year" : "years"} ago`
  return `quiet ${row.quartersQuiet} ${row.quartersQuiet === 1 ? "quarter" : "quarters"}`
}

/** Managers the registry watches but could not resolve to an SEC filer. */
export function unresolvedWatchList(): readonly string[] {
  return UNRESOLVED_WATCH
}
