"use client"

import type { ManagerRaises } from "@shared/peer-intel/cohort"
import type { ContinuationKind, ContinuationView } from "@shared/peer-intel/continuation"
import { buildFilingIndexUrl } from "@shared/peer-intel/edgar-contract"
import { money } from "@shared/peer-intel/panel"

/**
 * A manager's continuation, annex and extension vehicles.
 *
 * A flag, never a score. Each vehicle is shown with what the two sources say
 * about it — the Form D it filed and the adviser's ADV record — and with the
 * basis on which it was attributed to this manager, because the search that
 * found it can match a person's name on an unrelated filing and the reader
 * should see why it is here. What a continuation vehicle means is said once,
 * under the list, in the same words whether the list is long or empty.
 */

const KIND_LABEL: Record<ContinuationKind, string> = {
  continuation: "continuation fund",
  annex: "annex fund",
  cv: "continuation vehicle",
  extension: "extension fund",
}

const KIND_TITLE: Record<ContinuationKind, string> = {
  continuation: "A GP-led secondary: assets moved from a fund at the end of its life into a new vehicle the same sponsor manages, with new investors and a fresh term.",
  annex: "Follow-on capital raised for an existing fund's portfolio, usually when that fund is fully invested.",
  cv: "A continuation vehicle: assets rolled from an older fund into a new one the same sponsor manages.",
  extension: "A vehicle that extends an existing fund's life or capital.",
}

export function ContinuationSection({
  manager,
  view,
  failure,
}: {
  manager: ManagerRaises
  view: ContinuationView | null
  /** The fetch's failure reason for this manager, if it had one. */
  failure: string | null
}) {
  const people = view ? view.terms.filter((t) => !/\b(fund|capital|partners|management|group|llc|lp)\b/i.test(t)).length : 0

  return (
    <div>
      {!view ? (
        <p className="text-sm text-slate-600">Not read for this layer yet — it appears after the next weekly rebuild.</p>
      ) : view.vehicles.length === 0 ? (
        <p className="text-sm text-slate-600">
          None found.
          {view.searched
            ? ` EDGAR was searched for Form D filings carrying the firm's names and ${view.terms.length - 1 > 0 ? "the people on its filings" : "its name"} with the words continuation, annex, CV or extension, and its adviser's Form ADV lists no fund by those names.`
            : failure
              ? ` The search did not run: ${failure}.`
              : " The search did not run for this manager."}
        </p>
      ) : (
        <ul className="space-y-3">
          {view.vehicles.map((v) => (
            <li key={`${v.formD?.cik ?? ""}:${v.name}`} className="text-xs text-slate-700">
              <div>
                <span className="font-medium text-slate-800">{v.name}</span>
                <span
                  className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                  title={KIND_TITLE[v.kind]}
                >
                  {KIND_LABEL[v.kind]}
                </span>
                {v.tracked && (
                  <span className="ml-1.5 rounded border border-slate-200 bg-card px-1.5 py-0.5 text-[10px] text-slate-500">
                    also in Raises above
                  </span>
                )}
                {v.predecessor && <span className="ml-2 text-slate-500">likely continues {v.predecessor.name}</span>}
              </div>
              {v.formD && (
                <div className="mt-0.5 text-slate-600">
                  Form D:{" "}
                  {!v.formD.sold && !v.formD.investorCount
                    ? `no sale reported yet${typeof v.formD.target === "number" ? ` on an offering of ${money(v.formD.target)}` : v.formD.target === "indefinite" ? " on an indefinite offering" : ""}`
                    : `first sale ${v.formD.firstSale ?? "not reported"} · raised ${money(v.formD.sold)}${typeof v.formD.target === "number" ? ` of ${money(v.formD.target)}` : v.formD.target === "indefinite" ? " of an indefinite offering" : ""}${v.formD.investorCount != null ? ` from ${v.formD.investorCount} investors` : ""}`}{" "}
                  · {v.formD.filings} {v.formD.filings === 1 ? "filing" : "filings"}, last {v.formD.lastFiled ?? "—"}
                  {v.formD.accession && (
                    <>
                      {" "}
                      <a
                        href={buildFilingIndexUrl(v.formD.cik, v.formD.accession)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                        title="Open the newest filing on sec.gov"
                      >
                        filing
                      </a>
                    </>
                  )}
                </div>
              )}
              {v.adv && (
                <div className="mt-0.5 text-slate-600">
                  Form ADV: gross assets {v.adv.grossAssetValue == null ? (v.adv.feederOf ? "not given for a feeder" : "not reported") : money(v.adv.grossAssetValue)}
                  {v.adv.fundTypes.length > 0 && ` · ${v.adv.fundTypes.join(", ")}`}
                  {v.adv.beneficialOwners != null && ` · ${v.adv.beneficialOwners} owners`}
                  {v.adv.feederOf ? ` · listed as a feeder of ${v.adv.feederOf}, with no record of its own` : v.adv.isFeederFund ? " · feeder" : ""}
                  {v.adv.isMasterFund && " · master"}
                </div>
              )}
              <div className="mt-0.5 text-[11px] text-slate-400">
                Attributed by{" "}
                {v.attribution
                  .map((a) =>
                    a.basis === "adv"
                      ? "its record on the adviser's Form ADV"
                      : a.basis === "name"
                        ? `the name "${a.phrase}"`
                        : `${a.names.length === 1 ? "a related person" : "related persons"} shared with the tracked funds (${a.names.join(", ")}; name match)`
                  )
                  .join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}

      {view && view.unconfirmed.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-500">
          {view.unconfirmed.length} {view.unconfirmed.length === 1 ? "filer" : "filers"} matched the search but nothing on{" "}
          {view.unconfirmed.length === 1 ? "its" : "their"} filings attributes {view.unconfirmed.length === 1 ? "it" : "them"} to{" "}
          {manager.manager}, so {view.unconfirmed.length === 1 ? "it is" : "they are"} not shown:{" "}
          {view.unconfirmed.map((u) => u.name).join("; ")}.
        </p>
      )}

      <p className="mt-2 text-[11px] leading-snug text-slate-500">
        A continuation vehicle is a GP-led secondary — assets the sponsor could not or chose not to sell, moved into a
        new fund it also manages; an annex or extension fund is follow-on capital for an existing portfolio. Neither is
        distress on its own, and the largest sponsors run them routinely; each is a fact about how a portfolio is being
        handled, listed here and not scored. Found by searching EDGAR for Form D filings that carry the firm&apos;s
        names or the people on its filings together with those words, and by name on its adviser&apos;s Form ADV. A
        filer is shown only when its own filing or the ADV ties it to this manager; a hit on a one-word name alone is
        not.
        {people > 0 && ` The search covered ${people} names and people from this manager's filings.`}
      </p>
    </div>
  )
}
