"use client"

import { Card } from "@/components/ui/card"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { buildEnvironmentReading, buildSelfReading, layerName, money } from "@shared/peer-intel/panel"

/**
 * What the layer looks like as a whole, and where the firm sits in it.
 *
 * This is the answer to the question the tab exists for — "who else is raising,
 * at what size, how fast" — so it sits above the tables rather than under them.
 * Both readings are built from the figures beside them
 * (`lib/peer-intel/panel.ts`), not written by a model, so they cannot drift
 * from the numbers on screen.
 */

function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-800">{value}</div>
      {note && <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{note}</div>}
    </div>
  )
}

export function RaiseEnvironment({ cohort }: { cohort: PeerCohort }) {
  const t = cohort.totals
  const selfReading = buildSelfReading(cohort)

  return (
    <Card className="p-6 surface-primary">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-slate-800">Raise Environment — {layerName(cohort.layer)}</h3>
        <p className="mt-1 text-xs text-slate-600">
          Every Regulation D offering by a tracked peer, from SEC Form D filings, as of {cohort.asOf}. Figures are
          self-reported by the issuer and unaudited.
        </p>
      </div>

      <p className="mb-4 text-sm leading-relaxed text-slate-700">{buildEnvironmentReading(cohort)}</p>

      <div className="grid gap-3 @container sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Figure label="Managers in market" value={`${t.managersRaising} of ${t.managers}`} />
        <Figure label="Open raises" value={String(t.activeRaiseCount)} note={`${t.raiseCount} in the registry`} />
        <Figure label="Capital raised" value={money(t.totalRaised)} note="all vintages, cumulative" />
        <Figure
          label="Capital sought"
          value={money(t.totalSought)}
          note={t.indefiniteTargets ? `excludes ${t.indefiniteTargets} uncapped` : "stated offerings"}
        />
        <Figure label="Launched, 12 months" value={String(t.newLaunchCount)} />
        <Figure label="Offerings cut" value={String(t.targetCutCount)} />
      </div>

      {selfReading && (
        <div className="mt-4 rounded-md border border-primary/25 bg-primary/5 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">Safe Harbor against this layer</div>
          <p className="mt-1 text-sm leading-relaxed text-slate-700">{selfReading}</p>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-snug text-slate-500">
        {cohort.coverage.registeredVehicles === 0 ? (
          <>
            All {cohort.coverage.privateVehicles} vehicles in this layer are private funds, which report the raise and
            nothing else — no portfolio, no performance, no redemptions, at any point in the fund&apos;s life. Those
            figures appear in the US layer, where some peers file periodic reports.
          </>
        ) : (
          <>
            {cohort.coverage.registeredVehicles} of {t.vehicles} vehicles file periodic reports, so liquidity and
            portfolio figures are observable for those only; the remaining {cohort.coverage.privateVehicles} are private
            funds and report the raise alone.
            {cohort.coverage.registeredWithoutFormD > 0 && (
              <>
                {" "}
                {cohort.coverage.registeredWithoutFormD} of the reporting vehicles file no Form D, because they raise
                through a registered offering rather than Regulation D.
              </>
            )}
          </>
        )}
      </p>
    </Card>
  )
}
