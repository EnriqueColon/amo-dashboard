"use client"

import { useState } from "react"
import type { ManagerRaises } from "@shared/peer-intel/cohort"
import type { ManagerAdv } from "@shared/peer-intel/adv-link"
import { money } from "@shared/peer-intel/panel"
import { peerById } from "@shared/peer-intel/registry"
import { opinionLabel } from "@/components/intel/peer-intel/structure-people"

/**
 * The manager's private funds as its SEC-registered adviser reports them on
 * Form ADV — the whole book, not just the vehicles the registry tracks.
 *
 * This is the view Form D cannot give. Form D shows what each vehicle raised;
 * the ADV shows what the adviser manages in total, at what gross asset value,
 * and — the part that matters for sponsor stress — whether each fund is
 * audited, whether the auditor's opinion was clean, and whether the audited
 * statements reached investors. Those answers are about a third party's work,
 * which is why they carry more weight than the self-reported raise figures.
 *
 * Everything here is a count or a sum of answers on the form. The amber
 * figures are the ones where an answer fell short of "audited, clean opinion,
 * distributed": they are flags to read the fund's record, not verdicts.
 */

const IAPD = (crd: string) => `https://adviserinfo.sec.gov/firm/summary/${crd}`
const SHOW = 8

function Stat({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="min-w-[7rem]">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm tabular-nums ${warn ? "font-medium text-amber-800" : "text-slate-800"}`}>{value}</div>
    </div>
  )
}

export function AdvSection({ manager, adv }: { manager: ManagerRaises; adv: ManagerAdv | null }) {
  const [showAll, setShowAll] = useState(false)
  const peer = peerById(manager.peerId)

  if (!adv) {
    if (peer?.noAdviser) {
      return (
        <p className="text-sm text-slate-600">
          No SEC-registered investment adviser is on file for this manager, so there is no Form ADV to read.{" "}
          <span className="text-xs text-slate-500">
            Checked on IAPD {peer.noAdviser.checkedOn}: {peer.noAdviser.note}.
          </span>
        </p>
      )
    }
    if (peer?.adviser) {
      return (
        <p className="text-sm text-slate-600">
          Adviser on file:{" "}
          <a href={IAPD(peer.adviser.crd)} target="_blank" rel="noopener noreferrer" className="text-primary underline">
            {peer.adviser.name}
          </a>{" "}
          <span className="font-mono text-xs text-slate-500">CRD {peer.adviser.crd}</span>. Its Form ADV has not been read yet —
          it appears after the next <span className="font-mono text-xs">refresh:peer-adv</span> run is committed.
        </p>
      )
    }
    return <p className="text-sm text-slate-600">No adviser has been recorded for this manager yet.</p>
  }

  const s = adv.summary
  const linkedVehicles = new Set(adv.linked.map((l) => l.vehicleCik)).size
  const privateVehicles = manager.raises.filter((r) => r.kind === "private").length
  const byNumber = adv.linked.filter((l) => l.linkBasis === "file-number").length
  const others = showAll ? adv.others : adv.others.slice(0, SHOW)
  const auditShort = s.audit.notAudited + s.opinions.notUnqualified + s.opinions.reportNotYetReceived + s.statementsNotDistributed

  return (
    <div>
      <ul className="space-y-1">
        {adv.filings.map((f) => {
          const vehicle = f.scope === "vehicle" ? peer?.vehicles.find((v) => v.adviser?.crd === f.crd) : null
          return (
            <li key={f.crd} className="text-xs text-slate-700">
              <a href={IAPD(f.crd)} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline">
                {f.adviserName}
              </a>{" "}
              <span className="font-mono text-[10px] text-slate-500">CRD {f.crd}</span>
              <span className="text-slate-500">
                {" "}
                · {f.filingType ?? "Form ADV"}
                {f.filedOn && ` filed ${f.filedOn}`} · {f.fundsParsed} private {f.fundsParsed === 1 ? "fund" : "funds"}
                {f.fundsReported != null && f.fundsReported !== f.fundsParsed && ` (header says ${f.fundsReported})`}
                {vehicle && ` · ${vehicle.name}'s adviser`}
              </span>
              {f.fundsParsed === 0 && vehicle?.kind === "registered" && (
                <div className="text-[11px] text-slate-500">
                  Lists no private funds, as expected: 7.B.(1) covers private funds only, and {vehicle.name} is a registered
                  vehicle whose figures are in its own periodic reports.
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {s.funds > 0 && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <Stat label="Private funds" value={`${s.funds}${s.feeders ? ` (${s.feeders} feeders)` : ""}`} />
            <Stat
              label="Gross assets"
              value={s.grossAssetValue == null ? "not reported" : money(s.grossAssetValue)}
            />
            <Stat label="Audited annually" value={`${s.audit.audited} of ${s.funds}`} warn={s.audit.notAudited > 0} />
            <Stat label="Clean opinions" value={`${s.opinions.unqualified} of ${s.audit.audited}`} warn={s.opinions.notUnqualified > 0} />
            {s.opinions.reportNotYetReceived > 0 && <Stat label="Report pending" value={s.opinions.reportNotYetReceived} warn />}
            {s.opinions.notUnqualified > 0 && <Stat label="Not unqualified" value={s.opinions.notUnqualified} warn />}
            <Stat label="Statements withheld" value={s.statementsNotDistributed} warn={s.statementsNotDistributed > 0} />
          </div>
          {s.byType.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              By type:{" "}
              {s.byType.map((t, i) => (
                <span key={t.type}>
                  {i > 0 && " · "}
                  {t.type} {t.funds}
                  {t.grossAssetValue > 0 && ` (${money(t.grossAssetValue)})`}
                </span>
              ))}
              . Gross assets are summed over the {s.grossAssetValueFunds} non-feeder funds that report one, so a master and
              its feeder are not counted twice.
            </p>
          )}
          {adv.years.length > 1 && (
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">The book by year</div>
              <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {adv.years.map((y) => (
                  <div key={y.year} className="min-w-[5.5rem]">
                    <div className="text-[10px] text-slate-500">{y.year}</div>
                    <div className="tabular-nums text-slate-800">{y.grossAssetValue == null ? "—" : money(y.grossAssetValue)}</div>
                    <div className="text-[10px] text-slate-500">{y.funds} {y.funds === 1 ? "fund" : "funds"}</div>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Gross assets over non-feeder funds on each year&apos;s annual filing, from the SEC&apos;s bulk Form ADV data
                through 2024 and the current filing after it. Funds and feeders are counted as listed that year.
              </p>
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-500">
            {linkedVehicles} of the {privateVehicles} private {privateVehicles === 1 ? "vehicle" : "vehicles"} tracked here{" "}
            {linkedVehicles === 1 ? "matches" : "match"} a fund on the ADV
            {adv.linked.length > 0 && ` (${byNumber} of ${adv.linked.length} records by Form D file number, the rest by name)`}; its
            record is under the fund&apos;s row in Raises.
            {auditShort > 0 && (
              <span className="text-amber-800">
                {" "}
                {auditShort} audit {auditShort === 1 ? "answer falls" : "answers fall"} short of audited, clean and distributed —
                read those funds&apos; records before drawing a conclusion.
              </span>
            )}
          </p>
        </>
      )}

      {adv.others.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Not tracked here ({adv.others.length})
          </div>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">Fund</th>
                  <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">Type</th>
                  <th className="px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-500">Gross assets</th>
                  <th className="px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-500">Owners</th>
                  <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">Audit</th>
                </tr>
              </thead>
              <tbody>
                {others.map((o) => {
                  const op = opinionLabel(o.opinion)
                  const audit =
                    o.annualAudit === false
                      ? { text: "not audited", warn: true }
                      : o.annualAudit == null
                        ? { text: "not answered", warn: false }
                        : o.opinion === "unqualified"
                          ? { text: o.statementsDistributed === false ? "clean, not distributed" : "clean", warn: o.statementsDistributed === false }
                          : { text: op.text.replace(/^at least one audit report was /, "").replace(/^audit /, ""), warn: op.warn }
                  return (
                    <tr key={o.fundId ?? o.name} className="border-b border-slate-100">
                      <td className="px-2 py-1 text-xs text-slate-700">
                        {o.name}
                        {o.isFeederFund && <span className="ml-1.5 rounded border border-slate-200 bg-card px-1 py-px text-[10px] text-slate-500">feeder</span>}
                      </td>
                      <td className="px-2 py-1 text-xs text-slate-600">{o.fundTypes.join(", ") || "—"}</td>
                      <td className="px-2 py-1 text-right text-xs tabular-nums text-slate-700">{o.grossAssetValue == null ? "—" : money(o.grossAssetValue)}</td>
                      <td className="px-2 py-1 text-right text-xs tabular-nums text-slate-700">{o.beneficialOwners ?? "—"}</td>
                      <td className={`px-2 py-1 text-xs ${audit.warn ? "text-amber-800" : "text-slate-600"}`}>{audit.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {adv.others.length > SHOW && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 text-xs text-primary underline"
            >
              {showAll ? `Show the ${SHOW} largest` : `Show all ${adv.others.length}`}
            </button>
          )}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-snug text-slate-500">
        Form ADV is the adviser&apos;s own registration filing, read from IAPD as of the refresh on{" "}
        {adv.filings[0]?.fetchedOn}. Gross asset value is as of the adviser&apos;s fiscal year end and self-reported; the
        audit answers describe what an independent auditor did, which is why they are the part worth weight. A fund
        the adviser reports under a master with a different name may not match a vehicle tracked here.
      </p>
    </div>
  )
}
