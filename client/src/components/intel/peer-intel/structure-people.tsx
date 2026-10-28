"use client"

import { useMemo } from "react"
import type { ManagerRaises } from "@shared/peer-intel/cohort"
import { money, percent } from "@shared/peer-intel/panel"
import { buildPeopleIndex, managerPeople, sharedPeople, type ManagerPerson } from "@shared/peer-intel/people"
import { formationLine, structureRows, type StructureRow } from "@shared/peer-intel/structure"
import { advForVehicle, type LinkedFund, type ManagerAdv } from "@shared/peer-intel/adv-link"
import type { AdvFund } from "@shared/peer-intel/adv"
import { peerById } from "@shared/peer-intel/registry"

/**
 * One fund's structure, terms and people, opened in place from its row in the
 * drawer's Raises table — so a reader who clicks a fund sees what sits behind
 * it without scrolling to another card.
 *
 * Everything comes from the parts of Form D the raise figures do not use. Each
 * line is a field as filed or a stated derivation, all catalogued in
 * `lib/peer-intel/catalog.ts`, and the filer's own notes are quoted rather than
 * paraphrased, because that is where the useful detail sits: a placement agent
 * dropped, a minimum the GP may waive, how the management fee is charged.
 */

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 py-0.5 text-xs">
      <div className="text-slate-500">{label}</div>
      <div className="text-slate-700">{children}</div>
    </div>
  )
}

function Quote({ children }: { children: React.ReactNode }) {
  return <span className="text-slate-500">&ldquo;{children}&rdquo;</span>
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{children}</div>
}

function fee(amount: number | null, estimate: boolean): string {
  if (amount == null) return "not reported"
  if (amount === 0) return "none"
  return `${money(amount)}${estimate ? " (estimate)" : ""}`
}

function Structure({ row, target }: { row: StructureRow; target: number | "indefinite" | null }) {
  const t = row.terms
  return (
    <div>
      <div className="mb-1 text-[11px] text-slate-500">
        {formationLine(t, row.jurisdiction)}
        {t.moreThanOneYear != null && ` · offering expected to run ${t.moreThanOneYear ? "more" : "less"} than a year`}
      </div>

      <Line label="Exemptions">
        {row.exemptions.length === 0
          ? "not reported"
          : row.exemptions.map((e, i) => (
              <span key={e.code}>
                {i > 0 && "; "}
                <strong className="font-medium">{e.label}</strong> — {e.meaning}
              </span>
            ))}
        {row.exemptionChanges.map((ch) => (
          <div key={ch.filedAt} className="text-amber-800">
            Changed {ch.filedAt}:{ch.added.length > 0 && ` added ${ch.added.map((e) => e.label).join(", ")}`}
            {ch.added.length > 0 && ch.removed.length > 0 && ";"}
            {ch.removed.length > 0 && ` dropped ${ch.removed.map((e) => e.label).join(", ")}`}
          </div>
        ))}
      </Line>

      <Line label="Securities">
        {row.securities.length ? row.securities.join(", ") : "not reported"}
        {t.securitiesOther && (
          <div>
            <Quote>{t.securitiesOther}</Quote>
          </div>
        )}
      </Line>

      <Line label="Minimum">
        {row.minimum == null ? "not reported" : row.minimum === 0 ? "none stated" : money(row.minimum)}
        {row.minimumChanges.map((c) => (
          <div key={c.filedAt} className="text-amber-800">
            {c.from != null && c.to != null && c.to < c.from ? "Lowered" : "Changed"} from{" "}
            {c.from === 0 ? "none stated" : money(c.from)} to {c.to === 0 ? "none stated" : money(c.to)} on {c.filedAt}
          </div>
        ))}
      </Line>

      <Line label="Sales commissions">
        {fee(t.salesCommissions.amount, t.salesCommissions.estimate)}
        {row.commissionShare != null && typeof target === "number" && (
          <span className="text-slate-500"> — {percent(row.commissionShare, 2)} of the {money(target)} offering</span>
        )}
        {(t.findersFees.amount ?? 0) > 0 && <div>Finder&apos;s fees {fee(t.findersFees.amount, t.findersFees.estimate)}</div>}
        {t.feesClarification && (
          <div>
            <Quote>{t.feesClarification}</Quote>
          </div>
        )}
      </Line>

      {((t.proceedsToInsiders.amount ?? 0) > 0 || t.proceedsClarification) && (
        <Line label="Paid to insiders">
          {fee(t.proceedsToInsiders.amount, t.proceedsToInsiders.estimate)}
          {t.proceedsClarification && (
            <div>
              <Quote>{t.proceedsClarification}</Quote>
            </div>
          )}
        </Line>
      )}

      {row.coIssuers.length > 0 && (
        <Line label="Files jointly with">
          {row.coIssuers.map((c) => (
            <div key={c.cik}>
              {c.name}
              <span className="text-slate-500">
                {" "}
                — {formationLine({ ...t, entityType: c.entityType, yearOfInc: c.yearOfInc, formedOverFiveYearsAgo: false }, c.jurisdiction)}
                {c.firstSeen && ` · first listed ${c.firstSeen}`}
                {c.tracking === "untracked" ? " · not tracked separately" : ` · also tracked as ${c.trackedAs}`}
              </span>
              {c.doubleCounted && (
                <div className="text-amber-800">
                  Its own trail carries this same filing, so its capital is counted twice in the manager&apos;s total.
                </div>
              )}
            </div>
          ))}
        </Line>
      )}
    </div>
  )
}

function PeopleList({ people }: { people: ManagerPerson[] }) {
  if (people.length === 0) return <p className="text-xs text-slate-600">No related persons are listed on this fund&apos;s filing.</p>
  return (
    <ul className="space-y-1">
      {people.map((p) => (
        <li key={`${p.kind}:${p.name}`} className="text-xs text-slate-700">
          <span className="font-medium text-slate-800">{p.name}</span>
          {p.kind === "entity" && (
            <span className="ml-1.5 rounded border border-slate-200 bg-card px-1 py-px text-[10px] text-slate-500">entity</span>
          )}
          <span className="text-slate-500"> — {p.roles.join(", ") || "role not stated"}</span>
          {p.clarifications.map((c) => (
            <div key={c} className="pl-3">
              <Quote>{c}</Quote>
            </div>
          ))}
          {p.elsewhere.map((o) => (
            <div key={o.peerId} className="pl-3 text-primary">
              Same name at {o.manager} — {o.roles.join(", ") || "role not stated"} · {o.vehicles.join(", ")}{" "}
              <span className="text-slate-400">(name match)</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  )
}

const WARN = "text-amber-800"

/** A yes/no answer as filed, with "not answered" where neither box is ticked. */
function yn(v: boolean | null, yes = "yes", no = "no"): string {
  return v == null ? "not answered" : v ? yes : no
}

export function opinionLabel(o: AdvFund["opinion"]): { text: string; warn: boolean } {
  switch (o) {
    case "unqualified":
      return { text: "unqualified (clean) opinion on every report since the last annual update", warn: false }
    case "not-unqualified":
      return { text: "at least one audit report was NOT unqualified", warn: true }
    case "report-not-yet-received":
      return { text: "audit report not yet received", warn: true }
    default:
      return { text: "opinion not answered", warn: false }
  }
}

function Place({ city, state, country }: { city: string | null; state: string | null; country: string | null }) {
  const parts = [city, state ?? (country && country !== "United States" ? country : null)].filter(Boolean)
  return parts.length ? <span className="text-slate-500"> · {parts.join(", ")}</span> : null
}

/**
 * One private fund as its adviser reported it on Form ADV Schedule D 7.B.(1).
 * Every line is an answer on the form, labelled by the question it answers;
 * nothing is inferred. Audit answers are shown in amber where they say less
 * than "a clean opinion, distributed to every investor".
 */
function AdvFundBlock({ link, adv }: { link: LinkedFund; adv: ManagerAdv }) {
  const f = link.fund
  const filing = adv.filings.find((x) => x.crd === link.crd)
  const op = opinionLabel(f.opinion)
  const structure = [
    f.isMasterFund ? `master fund${f.feeders.length ? ` of ${f.feeders.map((x) => x.name).join(", ")}` : ""}` : null,
    f.isFeederFund ? `feeder into ${f.master?.name ?? "a master fund"}` : null,
    f.fundOfFunds ? "fund of funds" : null,
  ].filter(Boolean)
  const pct = (v: number | null) => (v == null ? "not answered" : `${v}%`)
  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">{f.name}</span>
        {f.fundId && <span className="ml-1.5 font-mono text-[10px] text-slate-500">{f.fundId}</span>}
        {(f.state || f.country) && (
          <span className="text-slate-500"> · organised in {[f.state, f.country].filter(Boolean).join(", ")}</span>
        )}
        <span className="text-slate-400">
          {" "}
          · linked by {link.linkBasis === "file-number" ? `Form D file number ${f.formDFileNumber}` : "name"}
        </span>
      </div>
      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          <Line label="General partner">{f.generalPartners.length ? f.generalPartners.join("; ") : "not listed"}</Line>
          <Line label="Exclusion">
            {f.exclusion3c1 && f.exclusion3c7
              ? "3(c)(1) and 3(c)(7)"
              : f.exclusion3c1
                ? "3(c)(1) — up to 100 accredited investors"
                : f.exclusion3c7
                  ? "3(c)(7) — qualified purchasers only"
                  : "not ticked"}
            {f.salesLimitedToQualifiedClients != null && (
              <span className="text-slate-500"> · sales limited to qualified clients: {yn(f.salesLimitedToQualifiedClients)}</span>
            )}
          </Line>
          <Line label="Structure">
            {structure.length ? structure.join("; ") : "stand-alone"}
            {f.fundTypes.length > 0 && <span className="text-slate-500"> · {f.fundTypes.join(", ")}</span>}
          </Line>
          <Line label="Gross assets">
            {f.grossAssetValue == null ? "not reported" : money(f.grossAssetValue)}
            {filing?.filedOn && <span className="text-slate-500"> · per the ADV filed {filing.filedOn}</span>}
          </Line>
          <Line label="Owners">
            {f.beneficialOwners == null ? "not reported" : `${f.beneficialOwners} beneficial owners`}
            <span className="text-slate-500">
              {" "}
              · related persons {pct(f.pctOwnedByRelated)} · funds of funds {pct(f.pctOwnedByFundsOfFunds)} · non-US{" "}
              {pct(f.pctOwnedByNonUs)}
            </span>
          </Line>
          <Line label="Minimum">{f.minimumInvestment == null ? "not reported" : f.minimumInvestment === 0 ? "none stated" : money(f.minimumInvestment)}</Line>
          <Line label="Regulation D">
            {yn(f.reliedOnRegulationD, "relied on", "not relied on")}
            {f.formDFileNumber && <span className="ml-1 font-mono text-[10px] text-slate-500">{f.formDFileNumber}</span>}
          </Line>
        </div>
        <div>
          <Line label="Annual audit">
            <span className={f.annualAudit === false ? WARN : ""}>{yn(f.annualAudit, "yes", "NO — not audited annually")}</span>
            {f.annualAudit && f.gaap != null && <span className="text-slate-500"> · US GAAP: {yn(f.gaap)}</span>}
            {f.auditors.map((a) => (
              <div key={a.name}>
                {a.name}
                <Place city={a.city} state={a.state} country={a.country} />
                <span className="text-slate-500">
                  {" "}
                  · independent: {yn(a.independent)} · PCAOB-registered: {yn(a.pcaobRegistered)}
                  {a.pcaobNumber && ` (no. ${a.pcaobNumber})`} · subject to PCAOB inspection: {yn(a.pcaobInspected)}
                </span>
              </div>
            ))}
            {f.annualAudit && f.auditors.length === 0 && <div className="text-slate-500">auditor not named</div>}
          </Line>
          {f.annualAudit !== false && (
            <>
              <Line label="Opinion">
                <span className={op.warn ? WARN : ""}>{op.text}</span>
              </Line>
              <Line label="Statements">
                <span className={f.statementsDistributed === false ? WARN : ""}>
                  {yn(f.statementsDistributed, "audited statements distributed to all investors", "audited statements NOT distributed to all investors")}
                </span>
              </Line>
            </>
          )}
          <Line label="Custody">
            {f.usesCustodian === false ? (
              "no custodian"
            ) : f.custodians.length ? (
              f.custodians.map((c) => (
                <div key={c.name}>
                  {c.name}
                  <Place city={c.city} state={c.state} country={c.country} />
                  {c.relatedPerson && <span className={`ml-1 ${WARN}`}>related person</span>}
                </div>
              ))
            ) : (
              yn(f.usesCustodian, "custodian used, none named", "no custodian")
            )}
            {f.usesPrimeBroker && (
              <div className="text-slate-500">prime broker: {f.primeBrokers.length ? f.primeBrokers.join("; ") : "used, none named"}</div>
            )}
            {f.administrators.length > 0 && <div className="text-slate-500">administrator: {f.administrators.join("; ")}</div>}
            {f.pctAssetsValuedByOthers != null && (
              <div className="text-slate-500">{f.pctAssetsValuedByOthers}% of assets valued by someone other than the adviser</div>
            )}
          </Line>
          {f.marketers.length > 0 && <Line label="Marketers">{f.marketers.join("; ")}</Line>}
        </div>
      </div>
      {link.series.length > 1 && (
        <div className="mt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Year by year, as filed</div>
          <table className="mt-1 border-collapse text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                <th className="pr-3 text-left font-semibold">Filing</th>
                <th className="pr-3 text-right font-semibold">Gross assets</th>
                <th className="pr-3 text-right font-semibold">Owners</th>
                <th className="pr-3 text-left font-semibold">Audit</th>
              </tr>
            </thead>
            <tbody>
              {link.series.map((p) => {
                const op = opinionLabel(p.opinion)
                const audit =
                  p.annualAudit === false
                    ? { text: "not audited", warn: true }
                    : p.annualAudit == null
                      ? { text: "not answered", warn: false }
                      : {
                          text: `${p.opinion === "unqualified" ? "clean" : p.opinion === "not-unqualified" ? "not unqualified" : p.opinion === "report-not-yet-received" ? "report pending" : "opinion not answered"}${p.statementsDistributed === false ? ", not distributed" : ""}`,
                          warn: op.warn || p.statementsDistributed === false,
                        }
                return (
                  <tr key={p.filedOn} className="border-t border-slate-100">
                    <td className="pr-3 py-0.5 whitespace-nowrap text-slate-600">
                      {p.year}
                      <span className="ml-1 text-[10px] text-slate-400">{p.basis === "current" ? "current" : p.basis === "annual" ? "annual" : "last of year"}</span>
                    </td>
                    <td className="pr-3 py-0.5 text-right tabular-nums text-slate-700">{p.grossAssetValue == null ? "—" : money(p.grossAssetValue)}</td>
                    <td className="pr-3 py-0.5 text-right tabular-nums text-slate-700">{p.owners ?? "—"}</td>
                    <td className={`pr-3 py-0.5 ${audit.warn ? WARN : "text-slate-600"}`}>{audit.text}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {link.notes.length > 0 && (
            <ul className="mt-1 text-[11px] text-slate-600">
              {link.notes.map((n) => (
                <li key={`${n.from}-${n.to}-${n.kind}`} className={n.kind === "gross-assets" || n.kind === "owners" ? "" : WARN}>
                  {n.text}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-slate-400">
            Each row is the adviser&apos;s annual filing for that year, with fiscal-year-end figures, from the SEC&apos;s bulk Form ADV
            data; the last row is the current filing. A fall in gross assets is what a drawdown fund returning capital looks like,
            as well as what a loss looks like — the filing does not say which.
          </p>
        </div>
      )}
    </div>
  )
}

/** Why a fund row has no ADV record under it, in one sentence. */
function advAbsence(manager: ManagerRaises, cik: string, adv: ManagerAdv | null): string {
  const peer = peerById(manager.peerId)
  const vehicle = manager.raises.find((r) => r.cik === cik)
  if (vehicle?.kind === "registered") {
    return "Form ADV Schedule D 7.B.(1) lists private funds only. This vehicle is registered and reports its own figures in its periodic filings."
  }
  if (!adv) {
    if (peer?.noAdviser) return "No SEC-registered investment adviser is on file for this manager, so there is no Form ADV to read."
    if (peer?.adviser) return `Its adviser (${peer.adviser.name}, CRD ${peer.adviser.crd}) is on file, but its Form ADV has not been read yet.`
    return "No adviser has been recorded for this manager yet."
  }
  const filed = adv.filings.map((f) => f.adviserName).join(" / ")
  const number = vehicle?.raise.fileNumber
  if (adv.summary.funds === 0) return `${filed} reports no private funds on its Form ADV.`
  return `Not on ${filed}'s Form ADV by ${number ? `Form D file number ${number} or ` : ""}name. The adviser may report it under a master fund with a different name, or not at all.`
}

/**
 * The expanded content of one fund's row: structure and terms beside its
 * people, then the fund as its adviser reported it on Form ADV. People are
 * this fund's only, with any same-name match elsewhere in the layer; the
 * manager-wide list is the union of its rows.
 */
export function FundDetail({
  manager,
  cik,
  allManagers,
  adv,
}: {
  manager: ManagerRaises
  cik: string
  allManagers: readonly ManagerRaises[]
  adv: ManagerAdv | null
}) {
  const vehicle = manager.raises.find((r) => r.cik === cik)
  const advLinks = useMemo(() => advForVehicle(adv, cik), [adv, cik])
  const index = useMemo(() => buildPeopleIndex(allManagers), [allManagers])
  const row = useMemo(
    () => (vehicle ? structureRows({ ...manager, raises: [vehicle] }, allManagers)[0] ?? null : null),
    [manager, vehicle, allManagers]
  )
  const people = useMemo(
    () => (vehicle ? managerPeople({ ...manager, raises: [vehicle] }, index) : []),
    [manager, vehicle, index]
  )
  if (!vehicle) return null

  return (
    <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
      <div>
        <Heading>Structure &amp; terms</Heading>
        {row ? (
          <Structure row={row} target={vehicle.raise.target} />
        ) : (
          <p className="text-xs text-slate-600">
            Not yet read for this fund — it appears after the next refresh of this layer.
          </p>
        )}
      </div>
      <div>
        <Heading>People</Heading>
        <PeopleList people={people} />
      </div>
      <div className="md:col-span-2 border-t border-slate-200/80 pt-2">
        <Heading>
          Form ADV
          {advLinks.length > 0 && adv && (
            <span className="font-normal normal-case tracking-normal text-slate-400">
              {" "}
              · {adv.filings.find((f) => f.crd === advLinks[0].crd)?.adviserName ?? "adviser"}
            </span>
          )}
        </Heading>
        {advLinks.length === 0 || !adv ? (
          <p className="text-xs text-slate-600">{advAbsence(manager, cik, adv)}</p>
        ) : (
          advLinks.map((l) => <AdvFundBlock key={l.fund.fundId ?? l.fund.name} link={l} adv={adv} />)
        )}
      </div>
    </div>
  )
}

/** The explanation for every expanded row, said once under the table. */
export function FundDetailNote({ allManagers }: { allManagers: readonly ManagerRaises[] }) {
  const shared = useMemo(() => sharedPeople(buildPeopleIndex(allManagers)).length, [allManagers])
  return (
    <p className="mt-2 text-[11px] leading-snug text-slate-500">
      Click a fund for its structure, terms and people, from its newest Form D, self-reported. A filing made jointly
      with other issuers reports the offering as a whole, so a co-issuer&apos;s capital is already inside the figures
      above; commissions are paid or expected for the whole offering. People are the issuer&apos;s executive officers,
      directors and promoters — usually the GP&apos;s principals and the GP and manager entities, not the whole team and
      never investors. Names are compared across managers by exact match only, because Form D carries no identifier for
      a person, and a person filed under two forms of their name is not merged. The Form ADV block is the fund as its
      SEC-registered adviser reported it on Schedule D 7.B.(1): gross assets at the adviser&apos;s fiscal year end,
      beneficial owners, and whether an independent auditor gave a clean opinion that reached every investor.{" "}
      {shared === 0
        ? "No name in this layer appears at more than one manager."
        : `${shared} ${shared === 1 ? "name appears" : "names appear"} at more than one manager in this layer.`}
    </p>
  )
}
