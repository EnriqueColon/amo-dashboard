"use client"

import { Card } from "@/components/ui/card"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { portfolioRows, type VehicleTrend } from "@shared/peer-intel/liquidity"
import { layerName, money, percent } from "@shared/peer-intel/panel"
import { metricSpec } from "@shared/peer-intel/xbrl"

/**
 * Signs of stress in the underlying book.
 *
 * The brief asks for "performance trends, particularly signs of stress or
 * deterioration in underlying loan portfolios". Three things are observable
 * where a filer tags them: whether the book is shrinking, whether income is
 * increasingly being paid in kind rather than cash, and net asset value per
 * share.
 *
 * Unlike the liquidity panel this includes listed vehicles, because a shrinking
 * book and a rising payment-in-kind share mean the same thing in a listed REIT
 * as in a non-traded BDC.
 *
 * Coverage is thin and stated rather than smoothed over: payment-in-kind income
 * is tagged by only two of the twelve vehicles in the registry. A figure that is
 * not reported shows as a dash with the reason on hover, never as a zero and
 * never estimated.
 *
 * **Why a private fund shows nothing here is a reporting rule, not a structural
 * one** — a distinction the empty state has to make, because the two read very
 * differently. A drawdown fund genuinely has no redemption mechanism, which is
 * structural; but it does strike a NAV quarterly, does measure performance, and
 * is audited, so those figures exist. They are simply not public: Regulation D
 * carries no public reporting obligation, and the detailed data larger advisers
 * do file with the SEC on Form PF is held confidentially rather than published.
 */

const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"
const CELL = "px-3 py-2 text-sm text-slate-700"

function NotReported({ metric }: { metric: string }) {
  const spec = metricSpec(metric)
  return (
    <span
      className="text-slate-400"
      title={
        spec
          ? `${spec.label} is not tagged by this filer under any concept this reads. Measured coverage across the tier: ${spec.coverage}. Filers may use company-specific tags, which cannot be read at all.`
          : "Not reported by this filer."
      }
    >
      —
    </span>
  )
}

function Change({ value, suffix = "%" }: { value: number | null; suffix?: string }) {
  if (value == null) return <span className="text-slate-400">—</span>
  const bad = value < 0
  return (
    <span className={bad ? "text-amber-800" : "text-slate-700"}>
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}
      {suffix}
    </span>
  )
}

export function PortfolioStress({
  cohort,
  tier,
  onSelectManager,
}: {
  cohort: PeerCohort
  tier: VehicleTrend[]
  onSelectManager?: (peerId: string) => void
}) {
  const rows = portfolioRows(tier)

  if (!rows.length) {
    return (
      <Card className="p-6 surface-primary">
        <h3 className="text-base font-semibold text-slate-800">Portfolio stress</h3>
        <p className="mt-2 text-sm text-slate-600">
          <strong>No peer in {layerName(cohort.layer)} reports a portfolio publicly.</strong> Unlike the liquidity
          panel, this is a reporting rule rather than a structural one: these funds do strike a net asset value every
          quarter, do measure their own performance, and are audited annually — the figures exist. They go to the
          fund&apos;s own investors, not to the public. A fund raising under Regulation D has no public reporting
          obligation for any of it, and larger advisers file detailed portfolio and leverage data with the SEC on Form
          PF, which the SEC holds <em>confidentially</em> rather than publishing. So what a private fund raised is the
          whole of what is public, and that is on the panels above. Switch to the US layer for the twelve vehicles that
          file quarterly reports.
        </p>
      </Card>
    )
  }

  const withPik = rows.filter((r) => r.pikShare != null).length

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Portfolio stress — {layerName(cohort.layer)}</h3>
        <p className="mt-1 text-xs text-slate-600">
          For the {rows.length} {rows.length === 1 ? "vehicle" : "vehicles"} that file quarterly reports. A shrinking
          book means loans are running off faster than they are replaced; a rising payment-in-kind share means more
          income is arriving as paper rather than cash, which usually means borrowers cannot pay.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Vehicle</th>
              <th className={HEAD}>Quarter</th>
              <th className={`${HEAD} text-right`}>Investments</th>
              <th className={`${HEAD} text-right`}>8-quarter change</th>
              <th className={`${HEAD} text-right`}>PIK share</th>
              <th className={`${HEAD} text-right`}>PIK change</th>
              <th className={`${HEAD} text-right`}>NAV / share</th>
              <th className={`${HEAD} text-right`}>Unrealised</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.cik}
                onClick={onSelectManager && row.peerId ? () => onSelectManager(row.peerId) : undefined}
                className={`border-b border-slate-100 last:border-0 ${onSelectManager && row.peerId ? "cursor-pointer hover:bg-slate-50" : ""}`}
              >
                <td className={CELL}>
                  <div className="max-w-[230px] truncate" title={row.vehicleName}>
                    {row.vehicleName}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {row.manager}
                    {row.quoted && <span className="ml-1 text-slate-400">· {row.quoted}</span>}
                  </div>
                </td>
                <td className={`${CELL} whitespace-nowrap text-xs`}>{row.label ?? "—"}</td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.investments == null ? <NotReported metric="investmentsAtFairValue" /> : money(row.investments)}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  <Change value={row.investmentsChange == null ? null : row.investmentsChange * 100} />
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.pikShare == null ? <NotReported metric="pikIncome" /> : percent(row.pikShare, 1)}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.pikShareChange == null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className={row.pikShareChange >= 2 ? "font-semibold text-amber-800" : "text-slate-700"}>
                      {row.pikShareChange > 0 ? "+" : ""}
                      {row.pikShareChange.toFixed(1)}pp
                    </span>
                  )}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.navPerShare != null ? (
                    `$${row.navPerShare.toFixed(2)}`
                  ) : row.navRejected ? (
                    <span
                      className="text-slate-400"
                      title="This filer tags a net asset value per share that never changes across the quarters reported, so it is a par or subscription price rather than a NAV. Showing it would misstate the vehicle against its peers."
                    >
                      n/a
                    </span>
                  ) : (
                    <NotReported metric="navPerShare" />
                  )}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.unrealised == null ? <NotReported metric="unrealizedGainLoss" /> : money(row.unrealised)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        A dash is &ldquo;not reported by this filer&rdquo;, never zero — hover it for that metric&apos;s coverage across
        the tier. Only <strong>{withPik} of {rows.length}</strong> vehicles tag payment-in-kind income, so the PIK
        columns are blank for the rest and the signal is left unjudged rather than inferred. Changes are measured over
        the eight quarters shown, against the earliest reported balance in that window. Nothing here is an estimate. A
        NAV shown as <strong>n/a</strong> was reported but rejected: a net asset value that never moves across eight
        quarters is a par or subscription price tagged under the same concept, and showing it would misstate that
        vehicle against its peers.
      </p>
    </Card>
  )
}
