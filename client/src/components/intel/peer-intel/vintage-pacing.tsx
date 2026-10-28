"use client"

import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import { CATEGORICAL_SERIES, axisLineProps, gridProps, numericTick } from "@/lib/chart-theme"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { buildFilingIndexUrl } from "@shared/peer-intel/edgar-contract"
import { money, percent } from "@shared/peer-intel/panel"
import { buildPacingReading, buildVintagePacing, type Vintage, type VintagePacing } from "@shared/peer-intel/vintage"

/**
 * Vintage pacing: each of a manager's funds on the same axes — months since
 * first sale along the bottom, cumulative dollars sold up the side, one line
 * per fund — so the newest can be read against the ones before it.
 *
 * Two surfaces share the chart. The tab-level card shows the firm's own ladder,
 * which is the question its board asks; the manager drawer shows the same
 * thing for any peer with two or more vintages on file. The reading is built
 * from the comparison in `lib/peer-intel/vintage.ts` and nothing else.
 *
 * **Colour is by position from the newest, not by ordinal.** The newest fund
 * is the subject of the reading and is always the brand blue; its predecessor
 * is always the second colour. A manager's fourth vintage does not get the
 * fourth colour simply for being fourth. The palette is the validated
 * categorical set, because the whole point here is which line is which.
 *
 * Points are drawn as markers and joined with straight segments. A fund files
 * only when it takes money, so a trail is two to five points, and a smoothed
 * curve would claim knowledge of the months between filings that no filing
 * provides.
 */

const CHART_HEIGHT = 220

/** Colour by position from the newest: the subject of the reading is always blue. */
function colourFor(vintage: Vintage, vintages: readonly Vintage[]): string {
  const fromNewest = vintages.length - vintage.ordinal
  return CATEGORICAL_SERIES[Math.min(fromNewest, CATEGORICAL_SERIES.length - 1)]
}

function compactMoney(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`
  if (value >= 1e3) return `$${Math.round(value / 1e3)}K`
  return `$${value}`
}

type Row = { month: number } & Record<string, number | null>

/** One row per month any vintage filed in; a vintage absent that month is null and the line joins across it. */
function chartRows(vintages: readonly Vintage[]): Row[] {
  const months = new Set<number>()
  for (const v of vintages) for (const p of v.points) months.add(p.month)
  return [...months]
    .sort((a, b) => a - b)
    .map((month) => {
      const row: Row = { month }
      for (const v of vintages) {
        row[v.cik] = v.points.find((p) => p.month === month)?.sold ?? null
      }
      return row
    })
}

function filingUrlFor(v: Vintage): string | null {
  const last = v.points[v.points.length - 1]
  if (!last) return null
  try {
    return buildFilingIndexUrl(last.cik, last.accession)
  } catch {
    return null
  }
}

/**
 * The chart, its legend-table and the reading. Used by both surfaces.
 */
export function VintageLadder({ pacing, compact = false }: { pacing: VintagePacing; compact?: boolean }) {
  const drawn = useMemo(() => pacing.vintages.filter((v) => v.points.length > 0), [pacing])
  const rows = useMemo(() => chartRows(drawn), [drawn])
  const maxMonth = rows.length ? rows[rows.length - 1].month : 0

  if (drawn.length < 2) {
    return <p className="text-sm text-slate-600">{buildPacingReading(pacing)}</p>
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-700">{buildPacingReading(pacing)}</p>

      <div className="mt-3">
        <ResponsiveContainer width="100%" height={compact ? 180 : CHART_HEIGHT} debounce={0}>
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis
              dataKey="month"
              type="number"
              domain={[0, Math.max(maxMonth, 1)]}
              tick={numericTick}
              axisLine={axisLineProps}
              tickLine={false}
              label={{ value: "months since first sale", position: "insideBottomRight", offset: -2, fontSize: 10, fill: "#64748b" }}
            />
            <YAxis
              tick={numericTick}
              axisLine={false}
              tickLine={false}
              width={52}
              tickFormatter={(v: number) => compactMoney(v)}
            />
            <Tooltip
              cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
              labelFormatter={(m) => `Month ${m}`}
              formatter={(value, _name, item) => {
                if (value == null) return [null, null]
                const v = drawn.find((d) => d.cik === item.dataKey)
                const idx = v?.points.findIndex((p) => p.month === item.payload?.month) ?? -1
                const pt = idx >= 0 ? v!.points[idx] : null
                const prev = idx > 0 ? v!.points[idx - 1] : null
                // The same reading the drawer's trail gives: a rise is an interim
                // close, no rise is the annual re-file, the first point is the start.
                const what = !pt
                  ? ""
                  : idx === 0
                    ? "first filing"
                    : prev && pt.sold > prev.sold
                      ? `interim close, +${money(pt.sold - prev.sold)}`
                      : prev && pt.sold < prev.sold
                        ? "amount restated"
                        : "annual amendment"
                return [
                  `${money(Number(value))}${pt ? ` · ${what} · filed ${pt.filedAt}` : ""}`,
                  v?.vehicleName ?? String(item.dataKey),
                ]
              }}
              contentStyle={{ fontSize: 11, borderRadius: 6, borderColor: "#e2e8f0" }}
            />
            {drawn.map((v) => {
              const colour = colourFor(v, pacing.vintages)
              const isNewest = v.ordinal === pacing.vintages[pacing.vintages.length - 1]?.ordinal
              return (
                <Line
                  key={v.cik}
                  type="linear"
                  dataKey={v.cik}
                  stroke={colour}
                  strokeWidth={isNewest ? 2.5 : 1.75}
                  connectNulls
                  isAnimationActive={false}
                  dot={{ r: 4, strokeWidth: 2, stroke: "#ffffff", fill: colour }}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff", fill: colour }}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Vintage</th>
              <th className="px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">First sale</th>
              <th className="px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Offering</th>
              <th className="px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Raised</th>
              <th className="px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Months in</th>
              <th className="px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Subscribed</th>
              <th className="px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filings</th>
            </tr>
          </thead>
          <tbody>
            {pacing.vintages.map((v) => {
              const url = filingUrlFor(v)
              const hasCurve = v.points.length > 0
              return (
                <tr key={v.cik} className={`border-b border-slate-100 last:border-0 ${hasCurve ? "" : "text-slate-400"}`}>
                  <td className="px-2 py-1 text-sm text-slate-700">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: hasCurve ? colourFor(v, pacing.vintages) : "#cbd5e1" }}
                      />
                      <span>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">#{v.ordinal}</span>{" "}
                        {v.vehicleName}
                        {!v.open && <span className="ml-2 text-[10px] text-slate-400">no filing in 4+ quarters</span>}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-sm whitespace-nowrap text-slate-700">
                    {v.start}
                    {v.startBasis === "first-filing" && (
                      <span className="ml-1 text-[10px] text-slate-400" title="No first-sale date is reported, so the first filing date stands in for it.">
                        (first filing)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right text-sm tabular-nums text-slate-700">
                    {money(v.target)}
                    {v.targetHigh != null && <span className="ml-1 text-[10px] text-amber-800">cut from {money(v.targetHigh)}</span>}
                  </td>
                  <td className="px-2 py-1 text-right text-sm tabular-nums text-slate-700">{money(v.sold)}</td>
                  <td className="px-2 py-1 text-right text-sm tabular-nums text-slate-700">{v.monthsIn ?? "—"}</td>
                  <td className="px-2 py-1 text-right text-sm tabular-nums text-slate-700">
                    {v.progress == null ? "—" : percent(v.progress, 0)}
                  </td>
                  <td className="px-2 py-1 text-right text-sm tabular-nums text-slate-700">
                    {v.points.length}
                    {url && (
                      <>
                        {" "}
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline" title="Newest filing on sec.gov">
                          filing
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-slate-500">
        Months run from each fund&apos;s reported first sale, and &ldquo;raised&rdquo; is the cumulative amount sold on
        each Form D filing — so each marker is a filing, and the line between two markers is a straight join across
        months no filing describes. Vintages are numbered by first-sale date, not by name.
        {pacing.sleevesOmitted > 0 && (
          <>
            {" "}
            {pacing.sleevesOmitted} feeder or parallel {pacing.sleevesOmitted === 1 ? "vehicle is" : "vehicles are"} left out,
            because a sleeve&apos;s capital belongs to a parent fund the registry does not yet link it to.
          </>
        )}
      </p>
    </div>
  )
}

/**
 * The tab-level card: the firm's own ladder.
 *
 * Shown in every layer, since Safe Harbor is in each of them. Where the firm
 * has fewer than two vintages with a curve the card still renders and says so,
 * rather than vanishing and leaving a reader to wonder whether the data failed.
 */
export function VintagePacingPanel({ cohort }: { cohort: PeerCohort }) {
  const pacing = useMemo(() => (cohort.self ? buildVintagePacing(cohort.self) : null), [cohort])
  if (!pacing) return null

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-slate-800">Vintage Pacing — {pacing.manager}</h3>
        <p className="mt-1 text-xs text-slate-600">
          Each fund in the series on the same axes: months since first sale against cumulative capital raised, from the
          Form D filing trails already on this tab. The newest fund is the subject of the reading. Peers with two or
          more vintages show the same chart in their drawer.
        </p>
      </div>
      <VintageLadder pacing={pacing} />
    </Card>
  )
}
