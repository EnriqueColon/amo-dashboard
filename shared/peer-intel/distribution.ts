/**
 * How competitors actually raise: who is paid to sell their offerings.
 *
 * Form D never discloses who *bought* — investor identities are confidential by
 * design and the form reports only a count — but it does disclose who was paid
 * to *sell*, with each broker-dealer's FINRA CRD number. For a firm raising its
 * own fund that is arguably the more useful half: a competitor's distribution
 * tells you its go-to-market, and the agents themselves are a list of firms
 * that demonstrably place credit funds in your market.
 *
 * Silverview Special Situations Lending Fund II is the case that prompted this.
 * It reports 232 investors against $262.6M — a $1.13M average — sold through
 * five broker-dealers including North Capital and FNEX, which serve registered
 * advisers and accredited retail. Safe Harbor's Fund 4 is 40 investors at a
 * $1.60M average through a single agent. Rialto raises at an $8.6M average
 * through Morgan Stanley, Citigroup and Hines Private Wealth. Same asset class,
 * three different ways of raising, and none of it is in any dollar figure.
 *
 * Pure: raises in, rows and aggregates out.
 */

import type { ManagerRaises, PeerCohort } from "./cohort"
import type { SalesRecipient } from "./form-d"

export type AgentUse = {
  /** Normalised for grouping; `displayName` is what the filings actually say. */
  key: string
  displayName: string
  crd: string | null
  location: string | null
  /** Distinct managers using this agent. */
  managers: string[]
  /** Distinct funds it is named on. */
  funds: number
  /** Capital raised by the funds it is named on. Not its own production — a
   *  fund may use several agents and the filing does not split the credit. */
  associatedRaised: number | null
  /** True where any of those funds solicits outside the US. */
  foreign: boolean
}

/** CRD is the stable identity; fall back to a normalised name where absent. */
function agentKey(recipient: SalesRecipient): string {
  const crd = recipient.crd?.replace(/^0+/, "")
  if (crd) return `crd:${crd}`
  return `name:${recipient.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
}

/**
 * Every broker-dealer named across the layer, most-used first.
 *
 * Grouped on CRD rather than name, because the same firm is filed with
 * different capitalisation and suffixes across issuers.
 */
export function agentUsage(cohort: PeerCohort): AgentUse[] {
  const byKey = new Map<string, AgentUse>()

  for (const manager of cohort.managers) {
    for (const vehicle of manager.raises) {
      for (const recipient of vehicle.raise.salesRecipients) {
        const key = agentKey(recipient)
        const held =
          byKey.get(key) ??
          ({
            key,
            displayName: recipient.name,
            crd: recipient.crd,
            location: recipient.location,
            managers: [],
            funds: 0,
            associatedRaised: null,
            foreign: false,
          } satisfies AgentUse)
        if (!held.managers.includes(manager.manager)) held.managers.push(manager.manager)
        held.funds += 1
        if (vehicle.raise.sold != null) held.associatedRaised = (held.associatedRaised ?? 0) + vehicle.raise.sold
        if (recipient.foreignSolicitation) held.foreign = true
        // Prefer a location once any filing gives one.
        if (!held.location && recipient.location) held.location = recipient.location
        byKey.set(key, held)
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.managers.length - a.managers.length || b.funds - a.funds || (b.associatedRaised ?? 0) - (a.associatedRaised ?? 0)
  )
}

export type DistributionRow = {
  peerId: string
  manager: string
  isSelf: boolean
  /** The newest open fund, or failing that the newest raise of any kind. */
  vehicleName: string | null
  investorCount: number | null
  sold: number | null
  /** Sold per investor. A mean, so one anchor investor lifts it. */
  averageTicket: number | null
  minimumInvestment: number | null
  /** True only where the issuer states it accepted non-accredited investors. */
  hasNonAccredited: boolean | null
  agents: SalesRecipient[]
  /**
   * How the raise appears to be distributed, inferred from the filing and
   * labelled as inferred wherever it is shown.
   */
  channel: "direct" | "intermediated" | "unknown"
}

/**
 * One row per manager: how many investors, at what average, through whom.
 *
 * `channel` is the only inference here. A raise with named agents is
 * intermediated; one with none, where the issuer sold it itself, is direct. It
 * says nothing about quality — placing direct with forty institutions and
 * placing through five platforms to two hundred individuals are both ordinary
 * ways to raise a credit fund.
 */
export function distributionRows(cohort: PeerCohort): DistributionRow[] {
  return cohort.managers
    .map((manager) => {
      const funds = manager.raises.filter((r) => r.role === "fund")
      const chosen =
        funds.find((r) => r.open) ??
        [...funds].sort((a, b) => ((a.raise.lastFiled ?? "") < (b.raise.lastFiled ?? "") ? 1 : -1))[0]
      if (!chosen) {
        return {
          peerId: manager.peerId,
          manager: manager.manager,
          isSelf: manager.isSelf,
          vehicleName: null,
          investorCount: null,
          sold: null,
          averageTicket: null,
          minimumInvestment: null,
          hasNonAccredited: null,
          agents: [],
          channel: "unknown" as const,
        }
      }
      const r = chosen.raise
      return {
        peerId: manager.peerId,
        manager: manager.manager,
        isSelf: manager.isSelf,
        vehicleName: chosen.vehicleName,
        investorCount: r.investorCount,
        sold: r.sold,
        averageTicket: r.averageTicket,
        minimumInvestment: r.minimumInvestment,
        hasNonAccredited: r.hasNonAccreditedInvestors,
        agents: r.salesRecipients,
        channel: r.salesRecipients.length ? ("intermediated" as const) : ("direct" as const),
      }
    })
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return (b.investorCount ?? -1) - (a.investorCount ?? -1)
    })
}

export type DistributionSummary = {
  /** Managers whose newest fund names at least one agent. */
  intermediated: number
  direct: number
  /** Distinct broker-dealers named across the layer. */
  agents: number
  /** Median average ticket across managers reporting both sold and investors. */
  medianTicket: number | null
  /** The widest-used agent, when any agent appears for more than one manager. */
  mostUsed: AgentUse | null
}

export function distributionSummary(cohort: PeerCohort): DistributionSummary {
  const rows = distributionRows(cohort)
  const agents = agentUsage(cohort)
  const tickets = rows
    .map((r) => r.averageTicket)
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b)
  const median = tickets.length
    ? tickets.length % 2
      ? tickets[(tickets.length - 1) / 2]
      : (tickets[tickets.length / 2 - 1] + tickets[tickets.length / 2]) / 2
    : null

  return {
    intermediated: rows.filter((r) => r.channel === "intermediated").length,
    direct: rows.filter((r) => r.channel === "direct").length,
    agents: agents.length,
    medianTicket: median,
    mostUsed: agents[0]?.managers.length > 1 ? agents[0] : null,
  }
}

/** The agents named on one manager's raises, deduplicated across its funds. */
export function agentsForManager(manager: ManagerRaises): SalesRecipient[] {
  const byKey = new Map<string, SalesRecipient>()
  for (const vehicle of manager.raises) {
    for (const recipient of vehicle.raise.salesRecipients) {
      const key = agentKey(recipient)
      if (!byKey.has(key)) byKey.set(key, recipient)
    }
  }
  return [...byKey.values()]
}
