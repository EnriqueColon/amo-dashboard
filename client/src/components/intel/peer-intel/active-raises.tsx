"use client"

import { Card } from "@/components/ui/card"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { activeRaiseRows, filingUrl, money, newLaunchRows, percent } from "@shared/peer-intel/panel"

/**
 * Every open raise in the layer, with the firm's own pinned to the top.
 *
 * Pinning is the point: the comparison a reader wants is "us against them", and
 * making them scroll for their own row would bury it. Everything below is
 * ordered by capital raised, largest first.
 *
 * Sleeves are excluded — a fund raised across an onshore LP and three offshore
 * feeders would otherwise appear as four competitors. The manager drawer lists
 * them, because that is where the detail belongs.
 */

const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"
const CELL = "px-3 py-2 text-sm text-slate-700"
const NUM = `${CELL} text-right tabular-nums`

export function ActiveRaises({
  cohort,
  onSelectManager,
}: {
  cohort: PeerCohort
  onSelectManager?: (peerId: string) => void
}) {
  const rows = activeRaiseRows(cohort)

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Open Raises</h3>
        <p className="mt-1 text-xs text-slate-600">
          Offerings with a Form D filing in the last four quarters. One row per fund — a raise spread across offshore or
          parallel sleeves is counted once, and the sleeves are listed in the manager&apos;s drawer. Click a row for the
          manager.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-600">
          No tracked peer in this layer has filed an open offering in the last four quarters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] border-collapse">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={HEAD}>Manager</th>
                <th className={HEAD}>Fund</th>
                <th className={`${HEAD} text-right`}>Offering</th>
                <th className={`${HEAD} text-right`}>Raised</th>
                <th className={`${HEAD} text-right`}>Subscribed</th>
                <th className={`${HEAD} text-right`}>Investors</th>
                <th className={`${HEAD} text-right`}>Avg ticket</th>
                <th className={`${HEAD} text-right`}>Last 12m</th>
                <th className={HEAD}>Last filed</th>
                <th className={HEAD}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.cik}
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
                  <td className={`${CELL} max-w-[260px] truncate`} title={row.vehicleName}>
                    {row.vehicleName}
                    {row.raise.targetCut && row.raise.targetHigh != null && (
                      <span
                        className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                        title={`Reduced from ${money(row.raise.targetHigh)}`}
                      >
                        cut
                      </span>
                    )}
                  </td>
                  <td className={NUM}>{money(row.raise.target)}</td>
                  <td className={NUM}>{money(row.raise.sold)}</td>
                  <td className={NUM}>{row.raise.progress == null ? "—" : percent(row.raise.progress, 1)}</td>
                  <td className={NUM}>{row.raise.investorCount ?? "—"}</td>
                  <td className={NUM}>{money(row.raise.averageTicket)}</td>
                  <td className={NUM}>{row.raise.soldLastYear == null ? "—" : money(row.raise.soldLastYear)}</td>
                  <td className={`${CELL} whitespace-nowrap`}>{row.raise.lastFiled ?? "—"}</td>
                  <td className={CELL}>
                    {filingUrl(row.raise) ? (
                      <a
                        href={filingUrl(row.raise) as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="whitespace-nowrap text-xs text-primary underline"
                        title="Open this fund's Form D on sec.gov — the filing these figures were read from"
                      >
                        Form {row.raise.filings[row.raise.filings.length - 1]?.formType ?? "D"}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        &ldquo;Subscribed&rdquo; is blank where the offering states no cap, which is common for open-ended vehicles — a
        share of an uncapped offering has no meaning. &ldquo;Last 12m&rdquo; is measured between filings, so it ends at
        the date in the Last filed column rather than today. Every figure in a row comes from the filing linked under
        Source; it is self-reported by the issuer and unaudited.
      </p>
    </Card>
  )
}

/**
 * Funds whose first sale falls inside the last twelve months.
 *
 * Separate from the table above because a launch is a different event from a
 * raise in progress: it is the moment a competitor enters the market, and it is
 * the most actionable thing on the tab for someone raising against them.
 */
export function NewLaunches({
  cohort,
  onSelectManager,
}: {
  cohort: PeerCohort
  onSelectManager?: (peerId: string) => void
}) {
  const rows = newLaunchRows(cohort)

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Launched in the last twelve months</h3>
        <p className="mt-1 text-xs text-slate-600">
          Dated from the first sale the issuer reports, or from its first filing where no sale has occurred yet. Since{" "}
          {cohort.launchWindowStart}.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-600">No tracked peer in this layer has opened a fund in the last twelve months.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => (
            <li
              key={row.cik}
              onClick={onSelectManager ? () => onSelectManager(row.peerId) : undefined}
              className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 ${
                onSelectManager ? "cursor-pointer hover:bg-slate-50" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">{row.manager}</div>
                <div className="truncate text-xs text-slate-600" title={row.vehicleName}>
                  {row.vehicleName}
                </div>
              </div>
              <div className="text-right text-xs text-slate-600">
                <div className="tabular-nums">
                  <span className="font-semibold text-slate-800">{money(row.raise.sold)}</span> raised
                  {row.raise.investorCount != null && <> · {row.raise.investorCount} investors</>}
                </div>
                <div>
                  first sale {row.raise.firstSale ?? row.raise.firstFiled ?? "—"}
                  {filingUrl(row.raise) && (
                    <>
                      {" · "}
                      <a
                        href={filingUrl(row.raise) as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-primary underline"
                      >
                        filing
                      </a>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
