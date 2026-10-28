"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import {
  buildManagerReading,
  buildManagerSnapshot,
  closeLabel,
  filingTrail,
  money,
  orderedSignals,
  percent,
} from "@shared/peer-intel/panel"
import { agentsForManager } from "@shared/peer-intel/distribution"
import { peerById } from "@shared/peer-intel/registry"
import { peerSignalSpec, type ManagerSignals, type SignalState } from "@shared/peer-intel/signals"
import { buildVintagePacing } from "@shared/peer-intel/vintage"
import { VintageLadder } from "@/components/intel/peer-intel/vintage-pacing"
import { FundDetail, FundDetailNote } from "@/components/intel/peer-intel/structure-people"
import { AdvSection } from "@/components/intel/peer-intel/adv-section"
import { ContinuationSection } from "@/components/intel/peer-intel/continuation-section"
import type { ManagerAdv } from "@shared/peer-intel/adv-link"
import type { ContinuationView } from "@shared/peer-intel/continuation"

/**
 * One manager, in full.
 *
 * Mirrors the institution drawer: signal chips with the firing rule on hover,
 * the figures behind them, a deterministic reading and Copy Snapshot. Three
 * things are deliberately different — there are no eight-quarter trend panels
 * for a private fund because it reports nothing quarterly, the sleeves of a
 * raise are listed here rather than in the table, and an unjudged signal says
 * *why* it could not be judged.
 *
 * `sm:max-w-5xl`, not `max-w-5xl`: the base `DialogContent` carries
 * `sm:max-w-lg`, which is a media-query rule and beats a bare `max-w-*` on
 * every desktop viewport. That trap rendered the institution drawer 512px wide
 * for weeks — see the README's traps section.
 */

const CHIP: Record<SignalState, string> = {
  fired: "border-red-200 bg-red-50 text-red-900",
  quiet: "border-slate-200 bg-card text-slate-500",
  unjudged: "border-dashed border-slate-300 bg-slate-50 text-slate-400",
}

const PRESSURE_FIRED = "border-amber-200 bg-amber-50 text-amber-900"

function SignalChips({ signals }: { signals: ManagerSignals }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {orderedSignals(signals).map((result) => {
        const spec = peerSignalSpec(result.key)
        if (!spec) return null
        const className =
          result.state === "fired" && spec.side === "pressure" ? PRESSURE_FIRED : CHIP[result.state]
        const title = [spec.meaning, spec.rule, result.detail ?? result.missing ?? ""]
          .filter(Boolean)
          .join("\n\n")
        return (
          <span
            key={result.key}
            title={title}
            className={`cursor-help rounded border px-2 py-0.5 text-[11px] font-medium ${className}`}
          >
            {spec.label}
            {result.state === "unjudged" && <span className="ml-1 font-normal">not judged</span>}
          </span>
        )
      })}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200/80 bg-card px-4 py-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <div className="mt-2">{children}</div>
    </section>
  )
}

export function ManagerDrawer({
  cohort,
  signals,
  peerId,
  adv,
  continuation,
  continuationFailure,
  onClose,
}: {
  cohort: PeerCohort
  signals: ManagerSignals[]
  peerId: string | null
  /** This manager's Form ADV view, or null where there is none to show. */
  adv: ManagerAdv | null
  /** This manager's continuation vehicles; null before the layer has been rebuilt with them. */
  continuation: ContinuationView | null
  /** Why the continuation search did not run for this manager, if it did not. */
  continuationFailure: string | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  // The fund whose row is open to its structure and people. Only ever set by
  // a click: no fund opens on its own, however few the manager has.
  const [expanded, setExpanded] = useState<string | null>(null)

  const manager = useMemo(
    () => (peerId ? cohort.managers.find((m) => m.peerId === peerId) ?? null : null),
    [cohort, peerId]
  )
  const managerSignalSet = useMemo(
    () => (peerId ? signals.find((s) => s.peerId === peerId) ?? null : null),
    [signals, peerId]
  )
  const registryEntry = peerId ? peerById(peerId) : undefined
  const pacing = useMemo(() => (manager ? buildVintagePacing(manager) : null), [manager])
  // The ladder needs two funds with a curve to say anything; a single-fund
  // manager gets no section rather than a chart with one line and a caveat.
  const showLadder = (pacing?.vintages.filter((v) => v.points.length > 0).length ?? 0) >= 2

  // Every row starts closed. Reset whenever a different manager is shown, so
  // one manager's open row never carries over to the next.
  useEffect(() => {
    setExpanded(null)
  }, [peerId])

  async function copySnapshot() {
    if (!manager || !managerSignalSet) return
    try {
      await navigator.clipboard.writeText(buildManagerSnapshot(manager, managerSignalSet, cohort, adv, continuation))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // A clipboard the browser will not grant is not worth an error dialog.
      setCopied(false)
    }
  }

  return (
    <Dialog open={Boolean(peerId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[96vw] sm:max-w-5xl max-h-[90vh] overflow-y-auto p-6">
        {!manager || !managerSignalSet ? (
          <>
            <DialogHeader>
              <DialogTitle>Manager unavailable</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-600">
              This manager is not in the current layer. Switch to a wider layer to see it.
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-lg">{manager.manager}</DialogTitle>
              <p className="text-xs text-slate-600">
                {manager.location} · {manager.relevance === "direct" ? "direct peer" : "adjacent strategy"}
                {manager.isSelf && " · this firm"}
              </p>
            </DialogHeader>

            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-xs text-slate-600">
                {manager.raiseCount} {manager.raiseCount === 1 ? "raise" : "raises"} ·{" "}
                {manager.openRaiseCount} open · {money(manager.totalRaised)} raised across all vintages
              </div>
              <Button size="sm" variant="outline" onClick={copySnapshot}>
                {copied ? "Copied" : "Copy Snapshot"}
              </Button>
            </div>

            <div className="mt-4 grid gap-3">
              <Section title="Signals">
                <SignalChips signals={managerSignalSet} />
                <p className="mt-2 text-[11px] text-slate-500">
                  Red is an action the manager has taken, amber a pressure it is under, outline a measure that was
                  judged and stayed quiet, dashed a measure that could not be judged. Hover for the firing rule.
                  Signals read only this manager&apos;s own filings, so they are the same in every layer.
                </p>
              </Section>

              <Section title="Reading">
                <p className="text-sm leading-relaxed text-slate-700">
                  {buildManagerReading(manager, managerSignalSet)}
                </p>
                <p className="mt-2 text-[11px] text-slate-500">
                  Built from the figures on this panel, not written by a model, so it cannot say anything the panel does
                  not show.
                </p>
              </Section>

              <Section title="Raises">
                {manager.raises.length === 0 ? (
                  <p className="text-sm text-slate-600">No readable Form D filing was found for this manager.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Fund</th>
                          <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Offering</th>
                          <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Raised</th>
                          <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Subscribed</th>
                          <th className="px-2 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500">Investors</th>
                          <th className="px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">Last filed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {manager.raises.map((r) => {
                          const open = expanded === r.cik
                          const toggle = () => setExpanded(open ? null : r.cik)
                          return (
                          <Fragment key={r.cik}>
                          <tr
                            onClick={toggle}
                            className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${open ? "bg-slate-50" : ""}`}
                          >
                            <td className="px-2 py-1.5 text-sm text-slate-700">
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-label={`${open ? "Hide" : "Show"} structure, terms and people for ${r.vehicleName}`}
                                onClick={(e) => {
                                  // The row handles the click; the button exists for keyboard and screen readers.
                                  e.stopPropagation()
                                  toggle()
                                }}
                                className="mr-1 inline-flex align-[-2px] text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                              >
                                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
                              </button>
                              {r.vehicleName}
                              {r.role === "sleeve" && (
                                <span
                                  className="ml-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500"
                                  title="A feeder or parallel vehicle of a larger raise. Its capital is part of that raise, so it is not counted as a separate fund."
                                >
                                  sleeve
                                </span>
                              )}
                              {!r.open && (
                                <span className="ml-2 text-[10px] text-slate-400">no filing in 4+ quarters</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-right text-sm tabular-nums text-slate-700">{money(r.raise.target)}</td>
                            <td className="px-2 py-1.5 text-right text-sm tabular-nums text-slate-700">{money(r.raise.sold)}</td>
                            <td className="px-2 py-1.5 text-right text-sm tabular-nums text-slate-700">
                              {r.raise.progress == null ? "—" : percent(r.raise.progress, 1)}
                            </td>
                            <td className="px-2 py-1.5 text-right text-sm tabular-nums text-slate-700">{r.raise.investorCount ?? "—"}</td>
                            <td className="px-2 py-1.5 text-sm whitespace-nowrap text-slate-700">
                              {r.raise.lastFiled ?? "—"}
                              {filingTrail(r.raise)[0]?.url && (
                                <>
                                  {" "}
                                  <a
                                    href={filingTrail(r.raise)[0].url as string}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs text-primary underline"
                                    title="Open on sec.gov"
                                  >
                                    filing
                                  </a>
                                </>
                              )}
                            </td>
                          </tr>
                          {open && (
                            <tr className="border-b border-slate-200 bg-slate-50">
                              <td colSpan={6} className="px-3 pb-3 pt-1">
                                <FundDetail manager={manager} cik={r.cik} allManagers={cohort.managers} adv={adv} />
                              </td>
                            </tr>
                          )}
                          </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {manager.raises.length > 0 && <FundDetailNote allManagers={cohort.managers} />}
              </Section>

              {showLadder && pacing && (
                <Section title="Vintage pacing">
                  <VintageLadder pacing={pacing} compact />
                </Section>
              )}

              <Section title="Form ADV — what its adviser manages">
                <AdvSection manager={manager} adv={adv} />
              </Section>

              <Section title="Continuation, annex and extension vehicles">
                <ContinuationSection manager={manager} view={continuation} failure={continuationFailure} />
              </Section>

              <Section title="How it raises">
                {(() => {
                  const agents = agentsForManager(manager)
                  const newest = manager.raises.find((r) => r.role === "fund" && r.open) ?? manager.raises[0]
                  const r = newest?.raise
                  return (
                    <>
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-700">
                        <span>
                          Investors: <strong>{r?.investorCount ?? "not reported"}</strong>
                        </span>
                        <span>
                          Average commitment: <strong>{money(r?.averageTicket ?? null)}</strong>
                        </span>
                        <span>
                          Minimum:{" "}
                          <strong>
                            {r?.minimumInvestment == null
                              ? "not reported"
                              : r.minimumInvestment === 0
                                ? "none stated"
                                : money(r.minimumInvestment)}
                          </strong>
                        </span>
                        {r?.hasNonAccreditedInvestors != null && (
                          <span>
                            Non-accredited investors: <strong>{r.hasNonAccreditedInvestors ? "yes" : "no"}</strong>
                          </span>
                        )}
                      </div>

                      {agents.length === 0 ? (
                        <p className="mt-2 text-xs text-slate-600">
                          No selling agent is named, so the issuer placed this itself.
                        </p>
                      ) : (
                        <>
                          <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            Paid to sell it ({agents.length})
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {agents.map((a) => (
                              <li key={`${a.name}-${a.crd ?? ""}`} className="text-xs text-slate-700">
                                {a.name}
                                {a.crd && <span className="ml-1 font-mono text-[10px] text-slate-500">CRD {a.crd}</span>}
                                {a.location && <span className="ml-1 text-slate-500">· {a.location}</span>}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      <p className="mt-2 text-[11px] leading-snug text-slate-500">
                        Who <em>bought</em> is not disclosed in any filing — Form D reports the investor count and
                        nothing more. Who was paid to <em>sell</em> is disclosed, and is above.
                      </p>
                    </>
                  )
                })()}
              </Section>

              <Section title="Filing trail">
                {manager.raises.length === 0 ? (
                  <p className="text-sm text-slate-600">No filings found.</p>
                ) : (
                  <div className="space-y-2">
                    {manager.raises.map((r) => (
                      <div key={`trail-${r.cik}`}>
                        <div className="text-xs font-medium text-slate-700">{r.vehicleName}</div>
                        <ul className="mt-0.5 space-y-0.5">
                          {filingTrail(r.raise).map((f) => (
                            <li key={`${r.cik}-${f.filedAt}-${f.formType}`} className="text-[11px] text-slate-600">
                              <span
                                className={
                                  f.close.kind === "interim"
                                    ? "font-medium text-slate-700"
                                    : f.close.kind === "restated"
                                      ? "font-medium text-amber-800"
                                      : "text-slate-500"
                                }
                              >
                                {closeLabel(f.close)}
                              </span>
                              {f.close.offeringFrom != null && typeof f.target === "number" && (
                                <span className="ml-1 text-amber-800">
                                  · offering {f.target < f.close.offeringFrom ? "cut" : "raised"} from {money(f.close.offeringFrom)} to{" "}
                                  {money(f.target)}
                                </span>
                              )}
                              <span className="ml-1 text-slate-400">· {money(f.sold)} sold to date ·</span>{" "}
                              {f.url ? (
                                <a
                                  href={f.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary underline"
                                  title={`Form ${f.formType} filed ${f.filedAt} — raised ${money(f.sold)} against an offering of ${money(f.target)}`}
                                >
                                  {f.formType} · {f.filedAt}
                                </a>
                              ) : (
                                <span>
                                  {f.formType} · {f.filedAt}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-slate-500">
                  Every filing, newest first, read as what it was: an amendment whose amount sold rose is an interim
                  close, one whose amount did not move is the mandatory annual re-file. The figure is cumulative and an
                  amendment need only follow a material change, so one filing can bundle several closes. Each links to
                  the document on sec.gov — these are the filings every figure in this drawer was read from.
                </p>
              </Section>

              {registryEntry && (
                <Section title="Why this manager is tracked">
                  <p className="text-sm leading-relaxed text-slate-700">{registryEntry.evidence}</p>
                  {registryEntry.website && (
                    <a
                      href={registryEntry.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs text-primary underline"
                    >
                      {registryEntry.website.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </Section>
              )}
            </div>

            <p className="mt-4 text-[11px] leading-snug text-slate-500">
              Source: SEC EDGAR Form D and XBRL company facts, as of {cohort.asOf}, and the adviser&apos;s Form ADV
              from IAPD. Form D figures are self-reported by the issuer and unaudited, and &ldquo;raised&rdquo; is
              cumulative since the offering opened rather than a period figure.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
