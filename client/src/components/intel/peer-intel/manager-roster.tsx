"use client"

import { Card } from "@/components/ui/card"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { layerName, managerRoster, money, standingLabel, unresolvedWatchList } from "@shared/peer-intel/panel"
import type { ManagerSignals } from "@shared/peer-intel/signals"
import type { ContinuationView } from "@shared/peer-intel/continuation"

/**
 * Every tracked manager in the layer, raising or not.
 *
 * Open Raises and New Launches both filter to live offerings, which left the
 * quiet managers with no route into the drawer at all — eleven of twenty-six
 * nationally. A tab that says it tracks twenty-six managers has to let a reader
 * reach all of them, and a competitor that has *stopped* raising is itself worth
 * knowing: Gelt Financial's only Regulation D raise closed in 2019 because it
 * lends from its own balance sheet, which is a fact about how it competes
 * rather than a hole in the data.
 */

const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"
const CELL = "px-3 py-2 text-sm text-slate-700"

const STANDING_STYLE = {
  "in-market": "border-emerald-200 bg-emerald-50 text-emerald-900",
  quiet: "border-slate-200 bg-slate-50 text-slate-600",
  "not-raising": "border-dashed border-slate-300 bg-card text-slate-500",
} as const

export function ManagerRoster({
  cohort,
  signals,
  continuation = {},
  onSelectManager,
}: {
  cohort: PeerCohort
  signals: ManagerSignals[]
  /** Each manager's continuation vehicles, for the marker beside its name. */
  continuation?: Record<string, ContinuationView>
  onSelectManager?: (peerId: string) => void
}) {
  const rows = managerRoster(cohort, signals)
  const watched = unresolvedWatchList()
  const inMarket = rows.filter((r) => r.standing === "in-market").length

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">All tracked managers — {layerName(cohort.layer)}</h3>
        <p className="mt-1 text-xs text-slate-600">
          {rows.length} managers, {inMarket} with an open offering. The ones that are quiet are kept here deliberately:
          a competitor that has stopped raising, or that funds from its own balance sheet, is worth knowing about.
          Click any row for its filings and signals.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Manager</th>
              <th className={HEAD}>Location</th>
              <th className={HEAD}>Standing</th>
              <th className={`${HEAD} text-right`}>Raised, all vintages</th>
              <th className={`${HEAD} text-right`}>Raises</th>
              <th className={HEAD}>Last filed</th>
              <th className={`${HEAD} text-right`}>Signals</th>
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
                  {row.relevance === "adjacent" && (
                    <span
                      className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500"
                      title="A nearby strategy worth watching, not a like-for-like comparison — real-estate equity, or generalist private credit rather than CRE lending."
                    >
                      adjacent
                    </span>
                  )}
                  {(continuation[row.peerId]?.vehicles.length ?? 0) > 0 && (
                    <span
                      className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                      title={`${continuation[row.peerId].vehicles.length} continuation, annex or extension ${continuation[row.peerId].vehicles.length === 1 ? "vehicle" : "vehicles"} on file — a flag, not a score. Open the row for the list.`}
                    >
                      {continuation[row.peerId].vehicles.length} CV
                    </span>
                  )}
                </td>
                <td className={`${CELL} whitespace-nowrap text-xs text-slate-600`}>{row.location}</td>
                <td className={CELL}>
                  <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${STANDING_STYLE[row.standing]}`}>
                    {standingLabel(row)}
                  </span>
                </td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.totalRaised)}</td>
                <td className={`${CELL} text-right tabular-nums`}>{row.raiseCount}</td>
                <td className={`${CELL} whitespace-nowrap text-xs`}>{row.lastFiled ?? "—"}</td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.firedCount === 0 ? (
                    <span className="text-slate-400">none</span>
                  ) : (
                    <span className={row.pressureCount > 0 ? "text-amber-800" : "text-slate-700"}>
                      {row.firedCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {watched.length > 0 && (
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Also watched but not shown above, because no SEC filer could be resolved for them:{" "}
          {watched.join(", ")}. They are listed rather than hidden so the registry does not look more complete than it
          is.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        &ldquo;Quiet&rdquo; means no Form D amendment for four quarters or more. Form D carries no closed flag, so a
        fund that closed looks the same as one that stopped filing — the standing says how long it has been, and the
        drawer shows the filings it is inferred from.
      </p>
    </Card>
  )
}
