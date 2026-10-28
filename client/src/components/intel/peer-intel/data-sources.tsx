"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { PEER_FIELD_CATALOG, PRIVATE_FUND_LIMITS } from "@shared/peer-intel/catalog"
import type { PeerCohort } from "@shared/peer-intel/cohort"
import { PEER_METRICS } from "@shared/peer-intel/xbrl"
import { PEER_SIGNALS } from "@shared/peer-intel/signals"
import type { PeerIntelPayload } from "@/lib/intel/peer-intel-types"

/**
 * Where every figure on this tab comes from, and how it gets here.
 *
 * Not boilerplate. A reader deciding whether to act on "this competitor cut its
 * offering" needs to know that the figure is self-reported by the issuer,
 * unaudited, and only as current as its last amendment — and needs to be able
 * to open the filing it was read from. The provenance catalogue in
 * `lib/peer-intel/catalog.ts` already records that per field; this surfaces it
 * instead of leaving it in the source.
 *
 * It is collapsed by default because it is reference material, and open on one
 * click because the question "where did this number come from?" should never
 * need a developer to answer.
 */

const CELL = "px-2 py-1.5 align-top text-xs text-slate-700"
const HEAD = "px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500"

function Pipeline({ cohort, diagnostics }: { cohort: PeerCohort; diagnostics: PeerIntelPayload["diagnostics"] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">1 · Who is tracked</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          A reviewed registry of {cohort.totals.managers} managers and {cohort.totals.vehicles} vehicles, curated rather
          than generated. Candidates are proposed from EDGAR by business location and fund-name pattern, and by name
          lookup for managers whose funds are named after the firm; a person decides which are genuine peers, and each
          carries a note saying why. Miami-Dade and Florida peers are found by location, so the list keeps up as new
          funds file; the US layer is a reviewed list, because searching nationally returns thousands.
        </p>
      </div>
      <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">2 · What is read</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          <strong>Form D</strong> for the raise — mandatory for any Regulation D offering and amended annually while it
          stays open, which is what makes fundraising observable at all. <strong>XBRL company facts</strong> from
          quarterly and annual reports for the vehicles that file them, which is where redemptions, portfolio and
          income come from. Both are read directly from <span className="font-mono text-[10px]">sec.gov</span>. No
          survey, no subscription data, no estimates. <strong>Form ADV</strong>, the adviser&apos;s own registration
          filing on IAPD, for the private funds it manages — gross assets, owners, and whether each is audited with a
          clean opinion. Read offline and committed, because the PDFs run to tens of megabytes. And one{" "}
          <strong>full-text search</strong> per manager for Form D filings that carry its names or the people on its
          filings together with &ldquo;continuation&rdquo;, &ldquo;annex&rdquo;, &ldquo;CV&rdquo; or
          &ldquo;extension&rdquo; — the index covers a filing&apos;s related persons, not just the entity name.
        </p>
      </div>
      <div className="rounded-md border border-slate-200/80 bg-card px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">3 · How often</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Rebuilt <strong>weekly</strong>. A scheduled job runs daily at 05:00 UTC and rebuilds this layer on the first
          run of each new week; in between, the stored result is served unchanged. That suits inputs that move on
          quarterly reports and annual amendments. This layer was built{" "}
          <strong>{diagnostics.asOf}</strong> from {diagnostics.formDRequests} Form D and {diagnostics.xbrlRequests}{" "}
          XBRL requests.
        </p>
      </div>
    </div>
  )
}

export function DataSources({
  cohort,
  diagnostics,
}: {
  cohort: PeerCohort
  diagnostics: PeerIntelPayload["diagnostics"]
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card className="p-6 surface-primary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Where this data comes from</h3>
          <p className="mt-1 text-xs text-slate-600">
            Every figure on this tab is read from a public SEC filing, and every row links to the filing it came from.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-primary/30 bg-card px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5"
        >
          {open ? "Hide detail" : "Show every field and its source"}
        </button>
      </div>

      <div className="mt-4">
        <Pipeline cohort={cohort} diagnostics={diagnostics} />
      </div>

      <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
          What these figures are not
        </div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-amber-900">
          <li>
            Form D figures are <strong>self-reported by the issuer and unaudited</strong>. Nobody checks them, and an
            amount sold is cumulative since the offering opened rather than a figure for any period.
          </li>
          <li>
            They are only as current as the <strong>last amendment</strong>. An offering amended in July says nothing
            about what happened in August.
          </li>
          <li>
            Whether a raise is still open is <strong>inferred</strong>, not reported — Form D carries no closed flag, so
            a fund that quietly closed looks the same as one that went quiet.
          </li>
          {cohort.coverage.registeredVehicles === 0 && (
            <li>
              Every peer in this layer is a <strong>private fund</strong>, which reports the raise and nothing else.
            </li>
          )}
        </ul>
      </div>

      {open && (
        <div className="mt-5 space-y-5">
          <section>
            <h4 className="text-sm font-semibold text-slate-800">Fundraising figures, from Form D and Form ADV</h4>
            <p className="mt-1 text-xs text-slate-600">
              &ldquo;Reported&rdquo; is taken straight from the filing. &ldquo;Derived&rdquo; is computed here, and the
              formula is given so it can be checked. Figures marked &ldquo;(ADV)&rdquo; come from the adviser&apos;s Form
              ADV rather than the issuer&apos;s Form D, and the two can disagree.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className={HEAD}>Figure</th>
                    <th className={HEAD}>Source or formula</th>
                    <th className={HEAD}>Basis</th>
                    <th className={HEAD}>Worth knowing</th>
                  </tr>
                </thead>
                <tbody>
                  {PEER_FIELD_CATALOG.map((spec) => (
                    <tr key={spec.key} className="border-b border-slate-100 last:border-0">
                      <td className={`${CELL} whitespace-nowrap font-medium`}>{spec.label}</td>
                      <td className={`${CELL} font-mono text-[10px] leading-relaxed`}>{spec.source}</td>
                      <td className={CELL}>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            spec.kind === "reported"
                              ? "border-slate-200 bg-slate-50 text-slate-600"
                              : "border-primary/25 bg-primary/5 text-primary"
                          }`}
                        >
                          {spec.kind}
                        </span>
                      </td>
                      <td className={`${CELL} max-w-[320px] leading-relaxed text-slate-600`}>{spec.caveat ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h4 className="text-sm font-semibold text-slate-800">Quarterly figures, from XBRL company facts</h4>
            <p className="mt-1 text-xs text-slate-600">
              Only for vehicles that file periodic reports. Coverage is uneven because filers choose their own tags —
              some use company-specific tags this cannot read at all — so a metric is shown where it exists and marked
              not reported where it does not. It is never estimated.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className={HEAD}>Figure</th>
                    <th className={HEAD}>Concept</th>
                    <th className={HEAD}>Coverage</th>
                    <th className={HEAD}>Worth knowing</th>
                  </tr>
                </thead>
                <tbody>
                  {PEER_METRICS.map((metric) => (
                    <tr key={metric.key} className="border-b border-slate-100 last:border-0">
                      <td className={`${CELL} whitespace-nowrap font-medium`}>{metric.label}</td>
                      <td className={`${CELL} font-mono text-[10px]`}>
                        {metric.candidates.map(([taxonomy, concept]) => `${taxonomy}:${concept}`).join(" · ")}
                      </td>
                      <td className={`${CELL} whitespace-nowrap tabular-nums`}>{metric.coverage}</td>
                      <td className={`${CELL} max-w-[320px] leading-relaxed text-slate-600`}>{metric.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h4 className="text-sm font-semibold text-slate-800">How each signal fires</h4>
            <p className="mt-1 text-xs text-slate-600">
              Every signal is judged on a manager&apos;s own filing history and absolute thresholds, never on where it
              ranks among peers — which is why a manager shows the same signals in all three layers. Thresholds are
              starting values and have not been backtested.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className={HEAD}>Signal</th>
                    <th className={HEAD}>Means</th>
                    <th className={HEAD}>Fires when</th>
                  </tr>
                </thead>
                <tbody>
                  {PEER_SIGNALS.map((spec) => (
                    <tr key={spec.key} className="border-b border-slate-100 last:border-0">
                      <td className={`${CELL} whitespace-nowrap font-medium`}>
                        {spec.label}
                        <div className="mt-0.5 text-[10px] font-normal text-slate-500">
                          {spec.family} · {spec.side}
                        </div>
                      </td>
                      <td className={`${CELL} max-w-[260px] leading-relaxed`}>{spec.meaning}</td>
                      <td className={`${CELL} max-w-[380px] leading-relaxed text-slate-600`}>{spec.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h4 className="text-sm font-semibold text-slate-800">What a private fund never reports</h4>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-600">
              {PRIVATE_FUND_LIMITS.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </section>

          <section>
            <h4 className="text-sm font-semibold text-slate-800">This build</h4>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-600">
              <li>
                Built {diagnostics.asOf} from {diagnostics.formDRequests} Form D and {diagnostics.xbrlRequests} XBRL
                requests to sec.gov.
              </li>
              <li>
                {cohort.coverage.registeredVehicles} of {cohort.totals.vehicles} vehicles file periodic reports;{" "}
                {cohort.coverage.privateVehicles} are private funds.
                {cohort.coverage.registeredWithoutFormD > 0 && (
                  <>
                    {" "}
                    {cohort.coverage.registeredWithoutFormD} file no Form D because they raise through a registered
                    offering rather than Regulation D.
                  </>
                )}
              </li>
              {diagnostics.offeringFailures.length > 0 ? (
                <li>
                  {diagnostics.offeringFailures.length} vehicle
                  {diagnostics.offeringFailures.length === 1 ? "" : "s"} could not be read and{" "}
                  {diagnostics.offeringFailures.length === 1 ? "is" : "are"} excluded:{" "}
                  {diagnostics.offeringFailures.map((f) => `${f.manager} (${f.reason})`).join("; ")}.
                </li>
              ) : (
                <li>Every private vehicle in the registry was read successfully.</li>
              )}
              <li>
                Source of record:{" "}
                <a
                  href="https://www.sec.gov/edgar/search/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  SEC EDGAR full-text search
                </a>
                . Every raise in the tables above links to its own filing.
              </li>
            </ul>
          </section>
        </div>
      )}
    </Card>
  )
}
