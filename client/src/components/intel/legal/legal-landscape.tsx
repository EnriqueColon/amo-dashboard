import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Gavel, Info, Scale, Search, TrendingUp } from "lucide-react"
import { DefTerm } from "@/components/DefTerm"
import { fetchLegalUpdates, resolveLegalApplicability } from "@/lib/intel/legal-api"
import type { LegalItem, LegalSection, LegalUpdatesResponse, ResolvedApplicability } from "@/lib/intel/legal-types"

/**
 * Legal Landscape, in the dashboard's own style: a titled header, a filter
 * bar, stat tiles, and one dense table per section with an expandable row
 * for the summary, the points read from the document and the exposure
 * arithmetic. Same data and resolver as the Market Intelligence tool's tab;
 * only the presentation differs (docs/MARKET_INTEL_MERGE_SESSION.md).
 */

const SECTIONS: ReadonlyArray<{ key: LegalSection; label: string; description: string }> = [
  { key: "regulatory", label: "Regulatory Watch", description: "OCC, FDIC, Fed, CFPB and Florida OFR proposals and final rules affecting CRE lending and servicing" },
  { key: "legislative", label: "Legislative Tracker", description: "Florida and federal bills this session affecting foreclosure, lending, property rights and CRE" },
  { key: "enforcement", label: "Enforcement & Litigation", description: "Bank enforcement actions, major CRE bankruptcies, receiverships and lender-liability cases" },
]

type SectionFilter = "all" | LegalSection
type JurisdictionFilter = "all" | LegalItem["jurisdiction"]

const JURISDICTION_CLASS: Record<LegalItem["jurisdiction"], string> = {
  Federal: "bg-slate-100 text-slate-700",
  Florida: "bg-primary/10 text-primary",
  "Multi-State": "bg-amber-50 text-amber-800",
}

function appliesTo(exposure: ResolvedApplicability | undefined): { text: string; watch?: string } | null {
  if (!exposure) return null
  const universal = exposure.matched >= exposure.universe
  const watch = exposure.onWatchlist > 0 ? `${exposure.onWatchlist} on the stress watchlist` : undefined
  return { text: universal ? "All institutions" : `${exposure.matched} of ${exposure.universe}`, watch }
}

export function LegalLandscape() {
  const [data, setData] = useState<LegalUpdatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState<SectionFilter>("all")
  const [jurisdiction, setJurisdiction] = useState<JurisdictionFilter>("all")
  const [movedOnly, setMovedOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [exposure, setExposure] = useState<Record<string, ResolvedApplicability>>({})
  const [exposureScope, setExposureScope] = useState("Florida")
  const [exposureQuarter, setExposureQuarter] = useState<string | undefined>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let mounted = true
    setLoading(true)
    fetchLegalUpdates()
      .then((res) => mounted && setData(res))
      .catch((err) =>
        mounted && setData({ items: [], generatedAt: new Date().toISOString(), notes: [err instanceof Error ? err.message : "Failed to load legal intelligence."], sectionNotes: {} })
      )
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  // Resolved in a second pass: the join is against the FDIC quarter and the
  // stress tiers, neither of which belongs in the feed's day-keyed cache.
  useEffect(() => {
    const requests = (data?.items ?? []).filter((i) => i.applicability).map((i) => ({ id: i.id, applicability: i.applicability }))
    if (requests.length === 0) return
    let mounted = true
    resolveLegalApplicability(requests)
      .then((res) => {
        if (!mounted) return
        setExposure(res.resolved)
        setExposureScope(res.scope)
        setExposureQuarter(res.quarter)
      })
      .catch(() => {
        /* the rows stand on their own without it */
      })
    return () => {
      mounted = false
    }
  }, [data])

  const items = data?.items ?? []
  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (section === "all" || i.section === section) &&
          (jurisdiction === "all" || i.jurisdiction === jurisdiction) &&
          (!movedOnly || Boolean(i.movement)) &&
          (!q || `${i.title} ${i.summary} ${i.source} ${i.status ?? ""}`.toLowerCase().includes(q))
      ),
    [items, section, jurisdiction, movedOnly, q]
  )
  const bySection = useMemo(() => {
    const map: Record<string, LegalItem[]> = {}
    for (const i of filtered) (map[i.section] ??= []).push(i)
    return map
  }, [filtered])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const i of items) c[i.section] = (c[i.section] ?? 0) + 1
    return c
  }, [items])
  const movedCount = items.filter((i) => i.movement).length
  const watchHits = Object.values(exposure).filter((e) => e.onWatchlist > 0).length
  const visibleSections = section === "all" ? SECTIONS : SECTIONS.filter((s) => s.key === section)

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const th = (label: string, extra = "") => (
    <th className={`py-2 px-2 text-left font-medium text-slate-600 whitespace-nowrap ${extra}`}>
      <DefTerm term={`legal:${label}`}>{label}</DefTerm>
    </th>
  )

  const emptyMessage = (key: LegalSection) => {
    if ((counts[key] ?? 0) > 0) return "No items in this section match the selected filters."
    return data?.sectionNotes?.[key] ?? "Nothing to report."
  }

  const tiles = [
    { label: "Regulatory", value: data ? counts.regulatory ?? 0 : null },
    { label: "Legislative", value: data ? counts.legislative ?? 0 : null },
    { label: "Enforcement", value: data ? counts.enforcement ?? 0 : null },
    { label: "Moved since last check", value: data ? movedCount : null, tone: movedCount ? "text-amber-700" : undefined },
    { label: "Touching watchlist banks", value: data ? watchHits : null, tone: watchHits ? "text-primary" : undefined },
  ]

  const renderRow = (item: LegalItem) => {
    const open = expanded.has(item.id)
    const exp = exposure[item.id]
    const applies = appliesTo(exp)
    return (
      <>
        <tr key={item.id} className="hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(item.id)}>
          <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums text-slate-600">{item.date}</td>
          <td className="py-2 px-2 align-top min-w-[360px]">
            <div className="flex items-start gap-1.5">
              <button type="button" className="mt-0.5 text-slate-400 hover:text-slate-700" aria-label={open ? "Collapse" : "Expand"} onClick={(e) => { e.stopPropagation(); toggle(item.id) }}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <div className="min-w-0">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-[13px] font-medium leading-snug text-slate-900 hover:text-primary hover:underline inline-flex items-start gap-1">
                    {item.title}
                    <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 opacity-50" />
                  </a>
                ) : (
                  <span className="text-[13px] font-medium leading-snug text-slate-900">{item.title}</span>
                )}
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {item.source}
                  {item.record?.map((fact) => (
                    <span key={fact.label}>
                      {" · "}
                      <span className="text-slate-400">{fact.label}</span>{" "}
                      {fact.url ? (
                        <a href={fact.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="underline decoration-slate-300 underline-offset-2 hover:text-primary">
                          {fact.value}
                        </a>
                      ) : (
                        fact.value
                      )}
                    </span>
                  ))}
                </p>
                {!open && item.summary ? <p className="mt-0.5 text-xs leading-snug text-slate-500 line-clamp-1">{item.summary}</p> : null}
              </div>
            </div>
          </td>
          <td className="py-2 px-2 align-top whitespace-nowrap">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${JURISDICTION_CLASS[item.jurisdiction]}`}>{item.jurisdiction}</span>
          </td>
          <td className="py-2 px-2 align-top text-slate-700 min-w-[140px]">
            {item.status || "—"}
            {item.movement ? (
              <p className="mt-0.5 text-[11px] text-amber-800">
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 font-semibold ring-1 ring-amber-200">
                  <TrendingUp className="h-3 w-3" /> Moved
                </span>{" "}
                {item.movement.from} → <strong>{item.movement.to}</strong> on {item.movement.on}
              </p>
            ) : null}
          </td>
          <td className="py-2 px-2 align-top whitespace-nowrap text-slate-700">
            {applies ? (
              <>
                <span className="font-medium">{applies.text}</span>
                {applies.watch ? <p className="text-[11px] font-medium text-primary">{applies.watch}</p> : null}
              </>
            ) : item.applicability ? (
              <span className="text-slate-400">…</span>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </td>
        </tr>
        {open ? (
          <tr key={`${item.id}-detail`} className="bg-slate-50/50">
            <td colSpan={5} className="px-4 py-3">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] text-xs text-slate-700">
                <div className="space-y-3">
                  {item.summary ? <p className="text-sm leading-relaxed text-slate-700">{item.summary}</p> : null}
                  {item.details && item.details.length > 0 ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.detailsSource ?? "From the rule text"}</p>
                      <ul className="mt-1 space-y-1 leading-relaxed">
                        {item.details.map((point, i) => (
                          <li key={i} className="flex gap-2">
                            <span aria-hidden="true" className="mt-[6px] h-1 w-1 flex-shrink-0 rounded-full bg-slate-400" />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {item.intent ? (
                    <p className="text-slate-600">
                      <span className="font-medium text-slate-700">Possible intent: </span>
                      {item.intent}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-3">
                  {item.whyItMatters ? (
                    <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
                      <Gavel className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                      <p className="leading-relaxed">
                        <span className="font-semibold">Why it matters: </span>
                        {item.whyItMatters}
                      </p>
                    </div>
                  ) : null}
                  {exp ? (
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 space-y-1">
                      <p className="text-[11px] uppercase tracking-wide text-slate-500">
                        Who it hits · {exposureScope} filers{exposureQuarter ? `, ${exposureQuarter.slice(0, 4)} Q${Math.ceil(Number(exposureQuarter.slice(4, 6)) / 3)}` : ""}
                      </p>
                      <p>
                        {exp.matched >= exp.universe ? (
                          <>
                            <span className="font-medium">Scope: </span>
                            {exp.test}.
                          </>
                        ) : (
                          <>
                            <span className="font-medium">
                              {exp.matched} of {exp.universe}
                            </span>{" "}
                            meet this rule's own test — {exp.test}.
                          </>
                        )}
                      </p>
                      {exp.onWatchlist > 0 ? (
                        <p className="font-medium text-primary">
                          {exp.onWatchlist} on the Bank Stress watchlist{exp.watchlistNames.length ? `: ${exp.watchlistNames.join(", ")}` : ""}
                        </p>
                      ) : null}
                      {exp.matched < exp.universe && exp.examples.length > 0 ? (
                        <p className="text-slate-500">Largest affected: {exp.examples.map((e) => e.name).join(", ")}</p>
                      ) : null}
                      {exp.basis ? <p className="italic text-slate-400">Stated scope: {exp.basis}</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </td>
          </tr>
        ) : null}
      </>
    )
  }

  return (
    <div className="max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Scale className="h-6 w-6 text-slate-500" /> Legal Landscape
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Regulatory, legislative and enforcement developments bearing on distressed CRE debt, found by web search over the
            authoritative sources each morning and kept only where the primary source checks out. Expand a row for the summary,
            the points read from the document, and which Florida banks its scope test selects.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {data ? (
              <>
                Sourced <span className="font-medium text-slate-700">{new Date(data.generatedAt).toLocaleString()}</span>
              </>
            ) : (
              "Loading…"
            )}
            {" "}· exposure counted over {exposureScope} FDIC filers · refreshed each morning at 05:00 UTC
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Section
          <select className="border rounded px-2 py-1 text-sm" value={section} onChange={(e) => setSection(e.target.value as SectionFilter)}>
            <option value="all">All sections</option>
            {SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
                {counts[s.key] ? ` (${counts[s.key]})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Jurisdiction
          <select className="border rounded px-2 py-1 text-sm" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as JurisdictionFilter)}>
            <option value="all">All jurisdictions</option>
            <option value="Federal">Federal</option>
            <option value="Florida">Florida</option>
            <option value="Multi-State">Multi-State</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700 pb-1">
          <input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
          Moved since last check
        </label>
        <label className="flex items-center gap-1 border rounded px-2 py-1 text-sm ml-auto">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input className="outline-none w-48 text-sm" placeholder="Title, source or status" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
            <p className={`text-xl font-semibold tabular-nums ${t.tone ?? "text-slate-900"}`}>{t.value === null ? "—" : t.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {data?.notes && data.notes.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
          <ul className="space-y-0.5 text-xs">
            {data.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-4">
        {visibleSections.map((s) => {
          const rows = bySection[s.key] ?? []
          const context = data?.sectionContext?.[s.key]
          const dead = rows.filter((i) => i.intent)
          return (
            <section key={s.key} className="rounded-md border border-slate-200 bg-white overflow-x-auto">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-2">
                <h2 className="text-sm font-semibold text-foreground">
                  {s.label}
                  <span className="ml-2 text-xs font-normal text-slate-500">{s.description}</span>
                </h2>
                {data ? <span className="text-[11px] text-slate-500">{rows.length} item{rows.length === 1 ? "" : "s"}</span> : null}
              </div>
              {rows.length > 0 && context ? (
                <p className="flex items-start gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                  {context}
                </p>
              ) : null}
              {loading ? (
                <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="px-3 py-4 text-sm text-slate-500">{emptyMessage(s.key)}</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {th("Date")}
                      {th("Development")}
                      {th("Jurisdiction")}
                      {th("Status")}
                      {th("Applies to")}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">{rows.map(renderRow)}</tbody>
                </table>
              )}
              {dead.length > 0 ? (
                <p className="border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
                  {dead.length} of these bills died this session; expand a row for what its record says about the next one.
                </p>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}
