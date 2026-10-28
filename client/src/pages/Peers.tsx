import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchPeerIntel } from "@/lib/intel/peer-intel-api"
import type { PeerIntelPayload } from "@/lib/intel/peer-intel-types"
import type { PeerLayer } from "@shared/peer-intel/edgar-contract"
import { layerName } from "@shared/peer-intel/panel"
import { getErrorMessage } from "@/lib/error-utils"
import { ActiveRaises, NewLaunches } from "@/components/intel/peer-intel/active-raises"
import { DataSources } from "@/components/intel/peer-intel/data-sources"
import { Developments } from "@/components/intel/peer-intel/developments"
import { Distribution } from "@/components/intel/peer-intel/distribution"
import { EvergreenLiquidity } from "@/components/intel/peer-intel/evergreen-liquidity"
import { ManagerRoster } from "@/components/intel/peer-intel/manager-roster"
import { PortfolioStress } from "@/components/intel/peer-intel/portfolio-stress"
import { ManagerDrawer } from "@/components/intel/peer-intel/manager-drawer"
import { RaiseEnvironment } from "@/components/intel/peer-intel/raise-environment"
import { VintagePacingPanel } from "@/components/intel/peer-intel/vintage-pacing"

/**
 * Peers — what competing managers are doing about raising capital.
 *
 * The tool's other tabs serve deal sourcing: find a bank under CRE stress and
 * get to the loan pool first. This one serves the other side of the business.
 * When the firm is in front of an LP, the questions are who else is raising, at
 * what size, how fast, and who is losing money out the back door.
 *
 * Three layers, matching the scopes the Market Analytics tab already uses and
 * cumulative upward: Miami-Dade is the firms competing for the same deals and
 * allocations, Florida adds the rest of the state, and the US layer adds the
 * broader private credit market — which is also the only layer with any
 * quarterly data, since every peer that files periodic reports is national.
 *
 * Everything comes from SEC EDGAR: Form D for the raise, XBRL company facts for
 * the reporting vehicles. Nothing here is a survey, a subscription feed or a
 * model's guess.
 */

const LAYERS: readonly PeerLayer[] = ["miami-dade", "florida", "national"]

function LayerTabs({ value, onChange }: { value: PeerLayer; onChange: (layer: PeerLayer) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-primary/20 bg-card p-1 shadow-sm">
      {LAYERS.map((layer) => (
        <button
          key={layer}
          type="button"
          onClick={() => onChange(layer)}
          className={[
            "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
            value === layer
              ? "bg-primary text-white shadow-sm"
              : "text-primary hover:bg-primary/5",
          ].join(" ")}
        >
          {layerName(layer)}
        </button>
      ))}
    </div>
  )
}

/** Roughly what a cold build costs per layer, measured 2026-10-21. */
const COLD_BUILD: Record<PeerLayer, { seconds: number; requests: number }> = {
  "miami-dade": { seconds: 17, requests: 139 },
  florida: { seconds: 22, requests: 178 },
  national: { seconds: 43, requests: 340 },
}

/**
 * A cold build reads every filing live from SEC, which takes tens of seconds —
 * SEC caps callers at ten requests a second, and the US layer needs 340 of
 * them. A bare skeleton for that long reads as a hang, so the wait says what is
 * happening, why it is slow, and that it happens once.
 *
 * After the first build the stored result is served immediately and refreshed
 * behind the request, so this screen should be rare in production, where the
 * scheduled job builds all three layers before anyone opens the tab.
 */
function LoadingLayer({ layer }: { layer: PeerLayer }) {
  const [elapsed, setElapsed] = useState(0)
  const expected = COLD_BUILD[layer]

  useEffect(() => {
    setElapsed(0)
    const id = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(id)
  }, [layer])

  // Only explain the wait once it is long enough to need explaining; a cache
  // hit returns well inside this and should just show a skeleton.
  const slow = elapsed >= 3

  return (
    <>
      <Card className="p-6 surface-primary">
        {slow ? (
          <>
            <h3 className="text-base font-semibold text-slate-800">
              Reading {layerName(layer)} filings from SEC EDGAR…
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Nothing was cached for this layer, so every filing is being read live. SEC limits callers to ten requests
              a second and this layer needs about {expected.requests}, so a first build takes roughly{" "}
              {expected.seconds} seconds. It is stored afterwards — later visits are immediate, and the refresh happens
              in the background.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-1000 ease-linear"
                  style={{ width: `${Math.min(96, (elapsed / expected.seconds) * 100)}%` }}
                />
              </div>
              <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">
                {elapsed}s of about {expected.seconds}s
              </span>
            </div>
            {elapsed > expected.seconds * 2 && (
              <p className="mt-2 text-xs text-amber-800">
                This is taking longer than usual. SEC may be rate-limiting or briefly unavailable; the request will
                either finish or report an error rather than hanging indefinitely.
              </p>
            )}
          </>
        ) : (
          <>
            <Skeleton className="h-5 w-72" />
            <Skeleton className="mt-3 h-16 w-full" />
          </>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </Card>
      <Card className="p-6 surface-primary">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-48 w-full" />
      </Card>
    </>
  )
}

export default function Peers() {
  const [layer, setLayer] = useState<PeerLayer>("miami-dade")
  const [payload, setPayload] = useState<PeerIntelPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedManager, setSelectedManager] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    fetchPeerIntel(layer)
      .then((result) => {
        if (!active) return
        if (result.ok) setPayload(result.payload)
        else setError(result.error)
      })
      .catch((err) => {
        if (active) setError(getErrorMessage(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [layer])

  // The drawer is keyed on a manager id, which only exists in the layer that
  // was loaded when it was opened. Closing it on a layer change avoids showing
  // "manager unavailable" to someone who simply switched scope.
  useEffect(() => {
    setSelectedManager(null)
  }, [layer])

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-slate-800">Peers &amp; Private Credit</h2>
            <span
              className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900"
              title="New. The data is read straight from SEC filings and every figure links to its source, but the peer list is still being reviewed and the signal thresholds have not been backtested — read the figures, and treat the signals as a prompt to look rather than a verdict."
            >
              beta
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            What competing managers are doing about raising capital — ongoing raises, fund sizes and progress, new
            launches, and where the data exists, redemption activity and portfolio stress. From SEC filings only.
          </p>
        </div>
        <LayerTabs value={layer} onChange={setLayer} />
      </div>

      {error && (
        <Card className="p-6 surface-primary">
          <h3 className="text-base font-semibold text-slate-800">Peer data unavailable</h3>
          <p className="mt-1 text-sm text-red-700">{error}</p>
          <p className="mt-2 text-xs text-slate-600">
            The tracker reads SEC EDGAR directly. A failure here is usually EDGAR being briefly unavailable; the weekly
            cron will rebuild this layer on its next run.
          </p>
        </Card>
      )}

      {loading && !error && <LoadingLayer layer={layer} />}

      {!loading && !error && payload && (
        <>
          <RaiseEnvironment cohort={payload.cohort} />
          <VintagePacingPanel cohort={payload.cohort} />
          <ActiveRaises cohort={payload.cohort} onSelectManager={setSelectedManager} />
          <NewLaunches cohort={payload.cohort} onSelectManager={setSelectedManager} />
          <Distribution cohort={payload.cohort} onSelectManager={setSelectedManager} />
          <EvergreenLiquidity
            cohort={payload.cohort}
            tier={payload.tier}
            gating={payload.gating}
            onSelectManager={setSelectedManager}
          />
          <PortfolioStress cohort={payload.cohort} tier={payload.tier} onSelectManager={setSelectedManager} />
          <Developments layer={layer} developments={payload.developments} onSelectManager={setSelectedManager} />
          <ManagerRoster
            cohort={payload.cohort}
            signals={payload.signals}
            continuation={payload.continuation?.byManager ?? {}}
            onSelectManager={setSelectedManager}
          />
          <DataSources cohort={payload.cohort} diagnostics={payload.diagnostics} />

          <ManagerDrawer
            cohort={payload.cohort}
            signals={payload.signals}
            peerId={selectedManager}
            adv={selectedManager ? payload.adv?.byManager[selectedManager] ?? null : null}
            continuation={selectedManager ? payload.continuation?.byManager[selectedManager] ?? null : null}
            continuationFailure={
              selectedManager
                ? payload.continuation?.failures.find(
                    (f) => f.manager === "all" || f.manager === payload.cohort.managers.find((m) => m.peerId === selectedManager)?.manager
                  )?.reason ?? null
                : null
            }
            onClose={() => setSelectedManager(null)}
          />

          <p className="text-[11px] leading-snug text-slate-500">
            {payload.cohort.totals.managers} managers and {payload.cohort.totals.vehicles} vehicles tracked in{" "}
            {layerName(layer)}. Read from SEC EDGAR, rebuilt weekly — see &ldquo;Where this data comes from&rdquo; above
            for every field and its source.
          </p>
        </>
      )}
    </div>
  )
}
