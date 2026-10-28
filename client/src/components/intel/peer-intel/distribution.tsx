"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { agentUsage, distributionRows, distributionSummary } from "@shared/peer-intel/distribution"
import { layerName, money } from "@shared/peer-intel/panel"

/**
 * How competitors raise: how many investors, at what average, through whom.
 *
 * This exists because of a question about the investor count — can you click it
 * to see who those investors are? You cannot, from any source: Form D reports
 * `totalNumberAlreadyInvested` and nothing else about investors, and no SEC
 * filing discloses a private fund's limited partners. Rather than leave the
 * number inert, it opens this: the broker-dealers the issuer *did* name, with
 * their FINRA CRD numbers.
 *
 * That turns out to be the more useful half. Silverview reports 232 investors
 * against $262.6M through five agents including North Capital and FNEX, which
 * serve registered advisers and accredited retail. Rialto raises at an $8.6M
 * average through Morgan Stanley, Citigroup and Hines Private Wealth. Safe
 * Harbor's Fund 4 is 40 investors at $1.60M through one agent. Same asset
 * class, three different go-to-markets — and none of that is in any dollar
 * figure.
 */

const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"
const CELL = "px-3 py-2 text-sm text-slate-700"

const CHANNEL_STYLE = {
  intermediated: "border-primary/25 bg-primary/5 text-primary",
  direct: "border-slate-200 bg-slate-50 text-slate-600",
  unknown: "border-dashed border-slate-300 bg-card text-slate-400",
} as const

export function Distribution({
  cohort,
  onSelectManager,
}: {
  cohort: PeerCohort
  onSelectManager?: (peerId: string) => void
}) {
  const [showAgents, setShowAgents] = useState(false)
  const rows = distributionRows(cohort).filter((r) => r.investorCount != null || r.agents.length > 0)
  const summary = distributionSummary(cohort)
  const agents = agentUsage(cohort)

  if (!rows.length) {
    return (
      <Card className="p-6 surface-primary">
        <h3 className="text-base font-semibold text-slate-800">Distribution</h3>
        <p className="mt-2 text-sm text-slate-600">
          No peer in {layerName(cohort.layer)} reports an investor count or a selling agent on its newest filing.
        </p>
      </Card>
    )
  }

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Distribution — {layerName(cohort.layer)}</h3>
          <p className="mt-1 max-w-3xl text-xs text-slate-600">
            How each manager raises: investors, average commitment and the broker-dealers it pays to sell. From Form
            D&apos;s sales compensation list, with FINRA CRD numbers as filed.
          </p>
        </div>
        {agents.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAgents((v) => !v)}
            className="rounded-md border border-primary/30 bg-card px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5"
          >
            {showAgents ? "Hide agents" : `All ${agents.length} broker-dealers`}
          </button>
        )}
      </div>

      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-xs leading-relaxed text-amber-900">
          <strong>Investor identities are not public.</strong> Form D reports how many investors bought and whether any
          were non-accredited, and nothing more — no SEC filing discloses a private fund&apos;s limited partners. The
          count below cannot be opened into a list of names, because that list does not exist in any filing. What is
          disclosed is who was paid to <em>sell</em>, which is what this panel shows. Some individual investors can be
          found from the other direction, where a public pension or endowment discloses its own commitments.
        </p>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Sold through agents</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">
            {summary.intermediated} of {summary.intermediated + summary.direct}
          </div>
        </div>
        <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Broker-dealers named</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">{summary.agents}</div>
        </div>
        <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Median commitment</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">{money(summary.medianTicket)}</div>
        </div>
        <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Shared channel</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-slate-800" title={summary.mostUsed?.displayName}>
            {summary.mostUsed ? summary.mostUsed.displayName : "none shared"}
          </div>
          {summary.mostUsed && (
            <div className="text-[11px] text-slate-500">{summary.mostUsed.managers.length} managers</div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Manager</th>
              <th className={HEAD}>Fund</th>
              <th className={`${HEAD} text-right`}>Investors</th>
              <th className={`${HEAD} text-right`}>Raised</th>
              <th className={`${HEAD} text-right`}>Avg commitment</th>
              <th className={`${HEAD} text-right`}>Minimum</th>
              <th className={HEAD}>Channel</th>
              <th className={HEAD}>Sold by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.peerId}
                onClick={onSelectManager ? () => onSelectManager(row.peerId) : undefined}
                className={[
                  "border-b border-slate-100 last:border-0",
                  onSelectManager ? "cursor-pointer hover:bg-slate-50" : "",
                  row.isSelf ? "bg-primary/5 hover:bg-primary/10" : "",
                ].join(" ")}
              >
                <td className={CELL}>
                  <span className={row.isSelf ? "font-semibold text-primary" : ""}>{row.manager}</span>
                  {row.isSelf && (
                    <span className="ml-2 rounded border border-primary/30 bg-card px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      us
                    </span>
                  )}
                </td>
                <td className={`${CELL} max-w-[200px] truncate text-xs`} title={row.vehicleName ?? undefined}>
                  {row.vehicleName ?? "—"}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.investorCount == null ? (
                    "—"
                  ) : (
                    <span
                      className="cursor-help underline decoration-dotted decoration-slate-400 underline-offset-2"
                      title={
                        row.agents.length
                          ? `${row.investorCount} investors. Their identities are not disclosed in any filing — Form D reports only the count. Sold through: ${row.agents.map((a) => a.name).join(", ")}.`
                          : `${row.investorCount} investors. Their identities are not disclosed in any filing — Form D reports only the count. No selling agent is named, so the issuer placed this itself.`
                      }
                    >
                      {row.investorCount}
                    </span>
                  )}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.sold)}</td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.averageTicket)}</td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.minimumInvestment == null ? "—" : row.minimumInvestment === 0 ? "none" : money(row.minimumInvestment)}
                </td>
                <td className={CELL}>
                  <span
                    className={`rounded border px-2 py-0.5 text-[11px] font-medium ${CHANNEL_STYLE[row.channel]}`}
                    title={
                      row.channel === "intermediated"
                        ? "The filing names broker-dealers paid to sell the offering. Inferred from their presence, and says nothing about quality."
                        : row.channel === "direct"
                          ? "No selling agent is named, so the issuer placed the offering itself. Inferred from the absence of a sales compensation list."
                          : "No readable filing for this manager."
                    }
                  >
                    {row.channel}
                  </span>
                </td>
                <td className={`${CELL} text-xs`}>
                  {row.agents.length === 0 ? (
                    <span className="text-slate-400">issuer</span>
                  ) : (
                    <span title={row.agents.map((a) => `${a.name}${a.crd ? ` (CRD ${a.crd})` : ""}`).join("\n")}>
                      {row.agents.length === 1 ? row.agents[0].name.slice(0, 28) : `${row.agents.length} broker-dealers`}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAgents && (
        <div className="mt-5">
          <h4 className="text-sm font-semibold text-slate-800">Every broker-dealer named in {layerName(cohort.layer)}</h4>
          <p className="mt-1 text-xs text-slate-600">
            Firms that demonstrably place funds in this market, grouped by FINRA CRD so the same firm filed under
            different spellings counts once.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className={HEAD}>Broker-dealer</th>
                  <th className={HEAD}>CRD</th>
                  <th className={HEAD}>Location</th>
                  <th className={`${HEAD} text-right`}>Managers</th>
                  <th className={`${HEAD} text-right`}>Funds</th>
                  <th className={`${HEAD} text-right`}>Raised on those funds</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.key} className="border-b border-slate-100 last:border-0">
                    <td className={CELL}>
                      {a.displayName}
                      {a.foreign && (
                        <span className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
                          solicits abroad
                        </span>
                      )}
                    </td>
                    <td className={`${CELL} font-mono text-[11px]`}>{a.crd ?? "—"}</td>
                    <td className={`${CELL} text-xs`}>{a.location ?? "—"}</td>
                    <td className={`${CELL} text-right tabular-nums`} title={a.managers.join(", ")}>
                      {a.managers.length}
                    </td>
                    <td className={`${CELL} text-right tabular-nums`}>{a.funds}</td>
                    <td className={`${CELL} text-right tabular-nums`}>{money(a.associatedRaised)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            &ldquo;Raised on those funds&rdquo; is the total taken by every fund naming this agent, not the
            agent&apos;s own production — a fund may name several agents and the filing does not split the credit
            between them.
          </p>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        &ldquo;Avg commitment&rdquo; is capital raised divided by investor count, so one anchor investor lifts it.
        Channel is the only inference on this panel: a raise naming agents is intermediated, one naming none is direct.
        It says nothing about quality — placing direct with forty institutions and placing through five platforms to two
        hundred individuals are both ordinary ways to raise a credit fund.
      </p>
    </Card>
  )
}
