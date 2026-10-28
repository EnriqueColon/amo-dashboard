"use client"

import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import { CHART_INK, CHART_SERIES, gridProps, numericTick } from "@/lib/chart-theme"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { aggregateNetFlow, liquidityRows, type VehicleTrend } from "@shared/peer-intel/liquidity"
import { layerName, money, percent } from "@shared/peer-intel/panel"
import type { PeerIntelPayload } from "@/lib/intel/peer-intel-types"

/**
 * Whether the semi-liquid complex is taking money in or paying it out.
 *
 * The brief asks for "redemption activity, withdrawal restrictions or gating
 * across semi-liquid structures". Redemption activity is reported quarterly and
 * is here. Gating — repurchase requests exceeding what was paid — lives in the
 * narrative of a 10-Q rather than in any tagged figure, so it is step 7, and
 * the footer says so instead of letting a reader assume its absence means none.
 *
 * Only non-traded vehicles appear. For a listed REIT the same two tags are a
 * buyback and an equity raise, which say almost nothing about investor demand:
 * someone wanting out of a listed vehicle sells the stock.
 *
 * **A drawdown fund's absence here is structural, which is not the same as the
 * portfolio panel's silence.** Its partnership agreement grants no redemption
 * right, so there is no programme to report — that is the fund's own terms. But
 * the empty state must not claim its investors have no exit: secondary sales and
 * GP-led continuation vehicles are real liquidity events that no filing records.
 * What is missing is a redemption programme, not liquidity.
 */

const TOOLTIP_STYLE = {
  contentStyle: { fontSize: 11, borderRadius: 6, borderColor: CHART_INK.grid, padding: "6px 8px" },
  labelStyle: { color: CHART_INK.label, fontWeight: 600 },
  cursor: { stroke: CHART_INK.reference, strokeDasharray: "3 3" },
} as const

const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"
const CELL = "px-3 py-2 text-sm text-slate-700"

function compact(value: number): string {
  const sign = value < 0 ? "−" : ""
  const a = Math.abs(value)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${sign}$${Math.round(a / 1e6)}M`
  return `${sign}$${Math.round(a / 1e3)}K`
}

export function EvergreenLiquidity({
  cohort,
  tier,
  gating,
  onSelectManager,
}: {
  cohort: PeerCohort
  tier: VehicleTrend[]
  gating?: PeerIntelPayload["gating"]
  onSelectManager?: (peerId: string) => void
}) {
  const aggregate = aggregateNetFlow(tier)
  const rows = liquidityRows(tier)

  if (!rows.length) {
    return (
      <Card className="p-6 surface-primary">
        <h3 className="text-base font-semibold text-slate-800">Evergreen liquidity</h3>
        <p className="mt-2 text-sm text-slate-600">
          <strong>Not applicable to any peer in {layerName(cohort.layer)}</strong> — this is a structural fact, not
          missing data.{" "}
          {cohort.coverage.registeredVehicles === 0 ? (
            <>
              Every manager in this layer raises drawdown funds, whose partnership agreements grant investors no
              redemption right at all — so there is no quarterly window, no cap and <strong>no redemption programme
              to gate</strong>. That is the fund&apos;s own structure rather than a disclosure choice. Of the 20 direct
              peers in the registry, only Blackstone and Starwood run a redeemable vehicle; the rest raise drawdown
              funds exclusively. Switch to the US layer to see the seven that do.
              <br />
              <br />
              It does not follow that these investors have no way out. Interests change hands through secondary sales,
              and increasingly through GP-led continuation vehicles — both real liquidity events, and both invisible,
              because no filing records them. What is absent here is a redemption programme, not liquidity.
            </>
          ) : (
            <>
              The vehicles here that report quarterly are listed, where a share repurchase is a buyback rather than
              investors being paid out — a holder wanting liquidity sells the stock instead.
            </>
          )}
        </p>
      </Card>
    )
  }

  const chartData = aggregate.points.map((p) => ({
    label: p.label,
    In: p.subscriptions,
    Out: p.repurchases != null ? -p.repurchases : null,
    Net: p.netFlow,
    vehicles: p.vehicles,
  }))

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Evergreen liquidity — {layerName(cohort.layer)}</h3>
        <p className="mt-1 text-xs text-slate-600">
          Capital in and out of the non-traded vehicles that report quarterly, from their own filings. Capital in is
          share issuance, capital out is the redemption programme paying investors back.
        </p>
      </div>

      <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700">
        <strong>Read this as market context, not competitor intelligence.</strong> Only 7 of the 65 vehicles tracked
        have a redemption programme at all, and only two direct peers — Blackstone and Starwood — are among them.
        Every Miami-Dade and Florida competitor raises drawdown funds, where an investor is committed for the
        fund&apos;s life and there is nothing to redeem. What these figures show is whether allocators are putting
        money into private credit or taking it out, which bears on any raise competing for the same money, including
        our own. They say nothing about what a drawdown-fund peer is doing.
      </p>

      {aggregate.newest && (
        <div className="mb-4 rounded-md border border-primary/25 bg-primary/5 px-4 py-3">
          <p className="text-sm leading-relaxed text-slate-700">
            In <strong>{aggregate.newest.label}</strong> the {aggregate.newest.vehicles} reporting{" "}
            {aggregate.newest.vehicles === 1 ? "vehicle" : "vehicles"} took in {money(aggregate.newest.subscriptions)}{" "}
            and paid out {money(aggregate.newest.repurchases)} — a net{" "}
            <strong>{(aggregate.newest.netFlow ?? 0) < 0 ? "outflow" : "inflow"}</strong> of{" "}
            {money(Math.abs(aggregate.newest.netFlow ?? 0))}.{" "}
            {aggregate.inOutflow > 0 && (
              <>
                {aggregate.inOutflow} of {aggregate.contributing}{" "}
                {aggregate.inOutflow === 1 ? "vehicle is" : "vehicles are"} individually in net outflow.
              </>
            )}
          </p>
        </div>
      )}

      {chartData.length > 1 && (
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid {...gridProps} vertical={false} />
              <XAxis dataKey="label" tick={numericTick} tickLine={false} axisLine={{ stroke: CHART_INK.axisLine }} />
              <YAxis tick={numericTick} tickLine={false} axisLine={false} tickFormatter={(v: number) => compact(v)} width={56} />
              <ReferenceLine y={0} stroke={CHART_INK.reference} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(value, name) => [typeof value === "number" ? compact(Math.abs(value)) : "—", String(name)]}
              />
              {/* Capital out is plotted negative so in and out read as opposite
                  sides of zero; the tooltip takes the absolute value back. */}
              <Bar dataKey="In" name="Capital in" fill={CHART_SERIES[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="Out" name="Capital out" fill={CHART_SERIES[3]} radius={[0, 0, 2, 2]} isAnimationActive={false} />
              <Line
                type="linear"
                dataKey="Net"
                name="Net flow"
                stroke={CHART_INK.label}
                strokeWidth={2}
                dot={{ r: 2, strokeWidth: 0, fill: CHART_INK.label }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={HEAD}>Vehicle</th>
              <th className={HEAD}>Quarter</th>
              <th className={`${HEAD} text-right`}>Capital in</th>
              <th className={`${HEAD} text-right`}>Capital out</th>
              <th className={`${HEAD} text-right`}>Net flow</th>
              <th className={`${HEAD} text-right`}>Out, % of book</th>
              <th className={`${HEAD} text-right`}>Outflow run</th>
              <th className={`${HEAD} text-right`}>Net, 8 quarters</th>
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
                  <div className="max-w-[240px] truncate" title={row.vehicleName}>
                    {row.vehicleName}
                  </div>
                  <div className="text-[11px] text-slate-500">{row.manager}</div>
                </td>
                <td className={`${CELL} whitespace-nowrap text-xs`}>{row.label ?? "—"}</td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.subscriptions)}</td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.repurchases)}</td>
                <td className={`${CELL} text-right tabular-nums ${(row.netFlow ?? 0) < 0 ? "font-semibold text-red-800" : ""}`}>
                  {money(row.netFlow)}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.redemptionShare == null ? (
                    <span className="text-slate-400" title="Investments at fair value are not tagged by this filer, so the share cannot be computed.">
                      —
                    </span>
                  ) : (
                    percent(row.redemptionShare, 1)
                  )}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>
                  {row.outflowStreak === 0 ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className={row.outflowStreak >= 2 ? "text-amber-800" : ""}>
                      {row.outflowStreak}Q
                    </span>
                  )}
                </td>
                <td className={`${CELL} text-right tabular-nums`}>{money(row.windowNetFlow)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        A quarter counts only the vehicles that reported both sides of it, and the chart tooltip gives that count — so a
        quarter where half the tier has not filed yet cannot read as a collapse in flows. &ldquo;Out, % of book&rdquo;
        is repurchases against investments at fair value, blank where that balance is not tagged.{" "}
        <strong>Gating is not shown here yet, but it is obtainable.</strong> The repurchase table in a 10-Q reports
        only what was bought — shares times price equals the stated amount exactly. Requests received are reported
        elsewhere: a non-traded fund runs its repurchase programme as a tender offer, and Rule 13e-4(c)(4) obliges it
        to file a final amendment stating how many shares were tendered, how many were accepted and whether
        acceptance was pro rata. Those filings are short and their wording is prescribed, so this is a better source
        than the 10-Q prose we first tried. Not yet built. Meanwhile the developments panel below surfaces gating
        where it is reported as news.
      </p>
    </Card>
  )
}
