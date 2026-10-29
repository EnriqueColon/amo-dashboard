import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BookOpen, ChevronDown, ChevronRight, Download, ExternalLink, FileText, RefreshCw, Search, Trash2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DefTerm } from "@/components/DefTerm"
import {
  deleteReport,
  fetchResearchFeed,
  getSummary,
  listReports,
  refreshResearchFeed,
  reportFileUrl,
  summarizeReport,
  uploadReport,
  type FeedResponse,
  type ReportRow,
  type ResearchReport,
  type StoredSummary,
} from "@/lib/intel/research-api"
import { ResearchMemoModal } from "./research-memo-modal"

/**
 * Market Research, in the dashboard's style. Two halves on one page: the
 * publications the daily sweep found at the major research houses (with the
 * archive of everything found before, and a market memo from any selection),
 * and the firm's own library of uploaded reports with summaries. Same data
 * and prompts as the Market Intelligence tool; the admin upload token is gone
 * — anyone signed in can upload, summarise and delete.
 */

const TOPIC_CLASS: Record<string, string> = {
  "Distressed/CMBS": "bg-red-50 text-red-700",
  "Capital Markets": "bg-purple-50 text-purple-700",
  Office: "bg-slate-100 text-slate-700",
  Multifamily: "bg-blue-50 text-blue-700",
  Retail: "bg-orange-50 text-orange-700",
  Industrial: "bg-yellow-50 text-yellow-800",
  "Market Outlook": "bg-primary/10 text-primary",
  "Florida/Southeast": "bg-emerald-50 text-emerald-700",
  "Banking/Lending": "bg-indigo-50 text-indigo-700",
  "Investment Sales": "bg-pink-50 text-pink-700",
}

function monthYear(dateStr: string | null | undefined): string {
  if (!dateStr) return "—"
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
}

function dayDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—"
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

type UploadState = { name: string; status: "uploading" | "done" | "failed"; note?: string }

export function MarketResearch() {
  // ── Publisher feed ───────────────────────────────────────────────────────
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [feedLoading, setFeedLoading] = useState(true)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [topic, setTopic] = useState("All")
  const [publisher, setPublisher] = useState("All")
  const [search, setSearch] = useState("")
  const [includeArchive, setIncludeArchive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [memoOpen, setMemoOpen] = useState(false)

  // ── Library ──────────────────────────────────────────────────────────────
  const [items, setItems] = useState<ReportRow[] | null>(null)
  const [libError, setLibError] = useState<string | null>(null)
  const [libSearch, setLibSearch] = useState("")
  const [libProducer, setLibProducer] = useState("all")
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [dragging, setDragging] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [summaryDialog, setSummaryDialog] = useState<{ title: string; summary?: StoredSummary; error?: string; loading: boolean } | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const loadFeed = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setFeedLoading(true)
    setFeedError(null)
    try {
      setFeed(refresh ? await refreshResearchFeed() : await fetchResearchFeed())
    } catch (err) {
      setFeedError(err instanceof Error ? err.message : String(err))
    } finally {
      setFeedLoading(false)
      setRefreshing(false)
    }
  }, [])

  const loadLibrary = useCallback(async () => {
    setLibError(null)
    try {
      setItems((await listReports()).items)
    } catch (err) {
      setLibError(err instanceof Error ? err.message : String(err))
      setItems([])
    }
  }, [])

  useEffect(() => {
    void loadFeed(false)
    void loadLibrary()
  }, [loadFeed, loadLibrary])

  const reports = feed?.reports ?? []
  const archive = feed?.archive ?? []
  const topics = useMemo(() => {
    const c = new Map<string, number>()
    for (const r of [...reports, ...(includeArchive ? archive : [])]) c.set(r.topic, (c.get(r.topic) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [reports, archive, includeArchive])
  const publishers = useMemo(
    () => [...new Set([...reports, ...(includeArchive ? archive : [])].map((r) => r.publisher))].sort(),
    [reports, archive, includeArchive]
  )
  const q = search.trim().toLowerCase()
  const narrow = <T extends ResearchReport>(rows: T[]) =>
    rows.filter(
      (r) =>
        (topic === "All" || r.topic === topic) &&
        (publisher === "All" || r.publisher === publisher) &&
        (!q || `${r.title} ${r.summary} ${r.publisher} ${r.keyFindings.join(" ")}`.toLowerCase().includes(q))
    )
  const visibleReports = narrow(reports)
  const visibleArchive = includeArchive ? narrow(archive) : []
  const selectedReports = [...reports, ...archive].filter((r) => selected.has(r.id))

  const toggleSet = (setter: (f: (prev: Set<string>) => Set<string>) => void, id: string) =>
    setter((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // ── Uploads ──────────────────────────────────────────────────────────────
  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))
    if (list.length === 0) return
    for (const file of list) {
      setUploads((prev) => [...prev, { name: file.name, status: "uploading" }])
      try {
        const r = await uploadReport(file)
        setUploads((prev) => prev.map((u) => (u.name === file.name && u.status === "uploading" ? { ...u, status: "done", note: `${r.action} · ${r.producer}` } : u)))
      } catch (err) {
        setUploads((prev) => prev.map((u) => (u.name === file.name && u.status === "uploading" ? { ...u, status: "failed", note: err instanceof Error ? err.message : String(err) } : u)))
      }
    }
    await loadLibrary()
  }

  const openSummary = async (item: ReportRow, generate: boolean) => {
    setSummaryDialog({ title: item.title, loading: true })
    try {
      if (generate) {
        setBusyId(item.id)
        const r = await summarizeReport(item.id)
        if (!r.ok) throw new Error(r.error)
        setSummaryDialog({ title: item.title, summary: r.summary, loading: false })
        await loadLibrary()
      } else {
        const r = await getSummary(item.id)
        setSummaryDialog({ title: item.title, summary: r.summary, loading: false })
      }
    } catch (err) {
      setSummaryDialog({ title: item.title, error: err instanceof Error ? err.message : String(err), loading: false })
    } finally {
      setBusyId(null)
    }
  }

  const removeReport = async (item: ReportRow) => {
    if (!window.confirm(`Delete "${item.title}" and its file?`)) return
    setBusyId(item.id)
    try {
      await deleteReport(item.id)
      await loadLibrary()
    } catch (err) {
      setLibError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const libQ = libSearch.trim().toLowerCase()
  const producers = useMemo(() => [...new Set((items ?? []).map((i) => i.producer))].sort(), [items])
  const visibleItems = (items ?? []).filter(
    (i) =>
      (libProducer === "all" || i.producer === libProducer) &&
      (!libQ || `${i.title} ${i.producer} ${String(i.tags.originalFilename ?? "")}`.toLowerCase().includes(libQ))
  )

  const th = (label: string, extra = "") => (
    <th className={`py-2 px-2 text-left font-medium text-slate-600 whitespace-nowrap ${extra}`}>
      <DefTerm term={`research:${label}`}>{label}</DefTerm>
    </th>
  )

  const tiles = [
    { label: "Publications today", value: feed ? reports.length : null },
    { label: "In the archive", value: feed ? feed.archiveTotal : null },
    { label: "Uploaded reports", value: items ? items.length : null },
    { label: "Summarised", value: items ? items.filter((i) => i.has_summary).length : null },
  ]

  const feedRow = (r: ResearchReport, archived?: { fetchedAt: string }) => {
    const open = expanded.has(r.id)
    const checked = selected.has(r.id)
    return (
      <>
        <tr key={r.id} className={`hover:bg-slate-50/60 ${checked ? "bg-primary/5" : ""}`}>
          <td className="py-2 px-2 align-top">
            <input type="checkbox" checked={checked} onChange={() => toggleSet(setSelected, r.id)} aria-label={`Select ${r.title}`} />
          </td>
          <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums text-slate-600">{monthYear(r.publishedDate)}</td>
          <td className="py-2 px-2 align-top min-w-[360px]">
            <div className="flex items-start gap-1.5">
              <button type="button" className="mt-0.5 text-slate-400 hover:text-slate-700" aria-label={open ? "Collapse" : "Expand"} onClick={() => toggleSet(setExpanded, r.id)}>
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <div className="min-w-0">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium leading-snug text-slate-900 hover:text-primary hover:underline inline-flex items-start gap-1">
                    {r.title}
                    <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0 opacity-50" />
                  </a>
                ) : (
                  <span className="text-[13px] font-medium leading-snug text-slate-900">{r.title}</span>
                )}
                {r.summary ? <p className={`mt-0.5 text-xs leading-snug text-slate-500 ${open ? "" : "line-clamp-1"}`}>{r.summary}</p> : null}
                {open && r.keyFindings.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-slate-700">
                    {r.keyFindings.map((f, i) => (
                      <li key={i} className="flex gap-2">
                        <span aria-hidden="true" className="mt-[6px] h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </td>
          <td className="py-2 px-2 align-top whitespace-nowrap text-slate-700">{r.publisher}</td>
          <td className="py-2 px-2 align-top whitespace-nowrap">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${TOPIC_CLASS[r.topic] ?? "bg-slate-100 text-slate-600"}`}>{r.topic}</span>
          </td>
          {archived ? <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums text-slate-500">{dayDate(archived.fetchedAt)}</td> : null}
        </tr>
      </>
    )
  }

  return (
    <div className="max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-slate-500" /> Market Research
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            The latest publications from Trepp, CBRE, JLL, Cushman &amp; Wakefield, Colliers, Marcus &amp; Millichap, MBA, Moody&apos;s, Green
            Street, Newmark and others, found each morning; tick reports to write a market memo from them. Below, the firm&apos;s own
            library of uploaded reports with summaries.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {feed ? (
              <>
                Publications found <span className="font-medium text-slate-700">{new Date(feed.generatedAt).toLocaleString()}</span>
              </>
            ) : (
              "Loading…"
            )}
            {" "}· refreshed each morning at 05:00 UTC
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => loadFeed(true)} disabled={refreshing || feedLoading}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh publications
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" />
            Upload reports
          </Button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => e.target.files && void handleFiles(e.target.files)} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Topic
          <select className="border rounded px-2 py-1 text-sm" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="All">All topics</option>
            {topics.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Publisher
          <select className="border rounded px-2 py-1 text-sm" value={publisher} onChange={(e) => setPublisher(e.target.value)}>
            <option value="All">All publishers</option>
            {publishers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700 pb-1">
          <input type="checkbox" checked={includeArchive} onChange={(e) => setIncludeArchive(e.target.checked)} />
          Include the archive
        </label>
        <label className="flex items-center gap-1 border rounded px-2 py-1 text-sm ml-auto">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input className="outline-none w-48 text-sm" placeholder="Title, publisher or finding" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
            <p className="text-xl font-semibold tabular-nums text-slate-900">{t.value === null ? "—" : t.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {feed?.notes && feed.notes.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 mb-4">{feed.notes.join(" ")}</div>
      ) : null}

      <div className="space-y-4">
        <section className="rounded-md border border-slate-200 bg-white overflow-x-auto">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold text-foreground">
              Latest publications
              <span className="ml-2 text-xs font-normal text-slate-500">past 90 days, Florida and distress first</span>
            </h2>
            {feed ? <span className="text-[11px] text-slate-500">{visibleReports.length} of {reports.length}</span> : null}
          </div>
          {feedLoading ? (
            <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
          ) : feedError ? (
            <p className="px-3 py-4 text-sm text-amber-700">Could not load the publications: {feedError}</p>
          ) : visibleReports.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-500">{reports.length === 0 ? "No publications found today; the morning sweep will try again." : "No publications match these filters."}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="py-2 px-2 w-6" />
                  {th("Date")}
                  {th("Report")}
                  {th("Publisher")}
                  {th("Topic")}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">{visibleReports.map((r) => feedRow(r))}</tbody>
            </table>
          )}
        </section>

        {includeArchive ? (
          <section className="rounded-md border border-slate-200 bg-white overflow-x-auto">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-2">
              <h2 className="text-sm font-semibold text-foreground">
                Archive
                <span className="ml-2 text-xs font-normal text-slate-500">found before today, kept a year</span>
              </h2>
              <span className="text-[11px] text-slate-500">{visibleArchive.length} of {archive.length}</span>
            </div>
            {visibleArchive.length === 0 ? (
              <p className="px-3 py-4 text-sm text-slate-500">Nothing in the archive matches these filters.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-2 w-6" />
                    {th("Date")}
                    {th("Report")}
                    {th("Publisher")}
                    {th("Topic")}
                    {th("Found")}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">{visibleArchive.map((r) => feedRow(r, { fetchedAt: r.fetchedAt }))}</tbody>
              </table>
            )}
          </section>
        ) : null}

        <section className="rounded-md border border-slate-200 bg-white overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold text-foreground">
              Firm library
              <span className="ml-2 text-xs font-normal text-slate-500">uploaded reports, stored on this server</span>
            </h2>
            <div className="flex items-center gap-2">
              <select className="border rounded px-2 py-1 text-xs" value={libProducer} onChange={(e) => setLibProducer(e.target.value)}>
                <option value="all">All producers</option>
                {producers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 border rounded px-2 py-1 text-xs">
                <Search className="h-3 w-3 text-slate-400" />
                <input className="outline-none w-40 text-xs" placeholder="Title, producer or file" value={libSearch} onChange={(e) => setLibSearch(e.target.value)} />
              </label>
            </div>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void handleFiles(e.dataTransfer.files)
            }}
            onClick={() => fileInput.current?.click()}
            className={`m-3 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs ${dragging ? "border-primary bg-primary/5 text-primary" : "border-slate-300 text-slate-500 hover:border-slate-400"}`}
          >
            <Upload className="h-3.5 w-3.5" />
            Drop PDF reports here or click to choose files. Producer, title and date are read from the document.
          </div>
          {uploads.length > 0 ? (
            <ul className="mx-3 mb-2 space-y-0.5 text-[11px]">
              {uploads.map((u, i) => (
                <li key={`${u.name}-${i}`} className={u.status === "failed" ? "text-red-700" : u.status === "done" ? "text-emerald-700" : "text-slate-500"}>
                  {u.status === "uploading" ? "Uploading" : u.status === "done" ? "Saved" : "Failed"} · {u.name}
                  {u.note ? ` · ${u.note}` : ""}
                </li>
              ))}
              <li>
                <button type="button" className="text-slate-400 hover:text-slate-600" onClick={() => setUploads([])}>
                  clear
                </button>
              </li>
            </ul>
          ) : null}
          {libError ? <p className="px-3 pb-3 text-sm text-amber-700">{libError}</p> : null}

          {items === null ? (
            <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
          ) : visibleItems.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-500">{items.length === 0 ? "No reports uploaded yet." : "No reports match these filters."}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {th("Date")}
                  {th("Report")}
                  {th("Producer")}
                  {th("Summary")}
                  {th("Actions", "text-right")}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleItems.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/60">
                    <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums text-slate-600">{item.published_date ?? "—"}</td>
                    <td className="py-2 px-2 align-top min-w-[300px]">
                      <a href={reportFileUrl(item.id)} target="_blank" rel="noreferrer" className="text-[13px] font-medium leading-snug text-slate-900 hover:text-primary hover:underline">
                        {item.title}
                      </a>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {String(item.tags.originalFilename ?? "")}
                        {item.tags.uploadedAt ? ` · uploaded ${dayDate(String(item.tags.uploadedAt))}` : ""}
                      </p>
                    </td>
                    <td className="py-2 px-2 align-top whitespace-nowrap text-slate-700">{item.producer}</td>
                    <td className="py-2 px-2 align-top whitespace-nowrap">
                      {item.has_summary ? (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">Summarised</span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">Pending</span>
                      )}
                    </td>
                    <td className="py-2 px-2 align-top text-right whitespace-nowrap">
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-1" asChild>
                          <a href={reportFileUrl(item.id)} target="_blank" rel="noreferrer">
                            Open <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-1" asChild>
                          <a href={reportFileUrl(item.id, true)}>
                            <Download className="h-3 w-3" /> Download
                          </a>
                        </Button>
                        <Button size="sm" variant={item.has_summary ? "outline" : "default"} className="h-6 px-2 text-[11px] gap-1" disabled={busyId === item.id} onClick={() => openSummary(item, !item.has_summary)}>
                          <FileText className="h-3 w-3" />
                          {busyId === item.id ? "Working…" : item.has_summary ? "View summary" : "Summarise"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-700" disabled={busyId === item.id} onClick={() => removeReport(item)} aria-label="Delete">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {selected.size > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium text-slate-700">
            {selected.size} report{selected.size === 1 ? "" : "s"} selected
          </span>
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setMemoOpen(true)}>
            <FileText className="h-3.5 w-3.5" />
            Market memo
          </Button>
          <button type="button" className="text-slate-400 hover:text-slate-600" onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {memoOpen ? <ResearchMemoModal reports={selectedReports} onClose={() => setMemoOpen(false)} /> : null}

      <Dialog open={summaryDialog !== null} onOpenChange={(open) => !open && setSummaryDialog(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Report summary</DialogTitle>
            <DialogDescription>{summaryDialog?.title}</DialogDescription>
          </DialogHeader>
          {summaryDialog?.loading ? (
            <p className="text-sm text-slate-500">Reading the report and writing the summary…</p>
          ) : summaryDialog?.error ? (
            <p className="text-sm text-red-700">{summaryDialog.error}</p>
          ) : summaryDialog?.summary ? (
            <div className="space-y-3 text-sm text-slate-700">
              <p className="leading-relaxed">{summaryDialog.summary.executiveSummary}</p>
              {summaryDialog.summary.keyTakeaways.length > 0 ? (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Key takeaways</p>
                  <ul className="mt-1 space-y-1">
                    {summaryDialog.summary.keyTakeaways.map((k, i) => (
                      <li key={i} className="flex gap-2">
                        <span aria-hidden="true" className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
                        <span>{k}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {summaryDialog.summary.metadata.warning ? <p className="text-xs text-amber-700">{summaryDialog.summary.metadata.warning}</p> : null}
              <p className="text-[11px] text-slate-400">Summarised {dayDate(summaryDialog.summary.metadata.summarizedAt)} · {summaryDialog.summary.metadata.producer}</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
