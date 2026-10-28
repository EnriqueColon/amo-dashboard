import { useEffect, useMemo, useState } from "react"
import { BookOpen, ExternalLink, FileText, Newspaper, Search } from "lucide-react"
import { DefTerm } from "@/components/DefTerm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { IndustryOutlook } from "./industry-outlook"
import { ArticleDigest } from "./article-digest"
import { fetchPublicMentions, type PublicMentionItem } from "@/lib/intel/news-api"
import { fetchInvestingNews } from "@/lib/intel/news-api"
import { fetchSubscriberSources, type SubscriberItem, type SubscriberSourcesResponse } from "@/lib/intel/news-api"
import { newsCalendarDayET } from "@shared/news/news-tab-cache"
import {
  byTopic,
  cleanHeadline,
  isSinceYesterday,
  longDateET,
  mergeLevels,
  newestFirst,
  regionLabel,
  topicChips,
  usefulSnippet,
  withoutUrls,
  MORNING_LEVELS,
  type MergedMorningItem,
  type MorningLevel,
} from "@shared/news/morning"
import { NewsBriefDialog, type BriefTarget } from "./news-brief-dialog"
import { TrdReadDialog, type ReadTarget } from "./trd-read-dialog"

/**
 * The News tab as one page for a morning scan, on a phone or a desktop: the Key Signals, the
 * firm's subscriber picks as cards, then the two feeds as lists, newest first, with one topic
 * filter over all of it and the Article Digest behind a button. Same data and caches as the table
 * layout it replaces (`public-mentions.tsx`, `investing-business-mentions.tsx`); only the
 * presentation differs. Shown when the `news-v2` feature is on — every preview, and production
 * once the user adds it to `ENABLED_TABS`.
 */

type FeedItem = MergedMorningItem<PublicMentionItem>
type FeedState = { items: FeedItem[] | null; error?: string }

const LIST_PREVIEW = 8

let industryCache: FeedItem[] | undefined
let financeCache: FeedItem[] | undefined
let subscriberCache: SubscriberSourcesResponse | undefined

function fromLevels(byLevel: Record<MorningLevel, PublicMentionItem[]>): FeedItem[] {
  return mergeLevels(MORNING_LEVELS.map((level) => ({ level, items: byLevel[level] ?? [] })))
}

async function loadLevels(fetchLevel: (level: MorningLevel) => Promise<{ news: PublicMentionItem[] }>): Promise<FeedItem[]> {
  const results = await Promise.allSettled(MORNING_LEVELS.map((level) => fetchLevel(level)))
  return mergeLevels(
    results.map((res, i) => ({ level: MORNING_LEVELS[i], items: res.status === "fulfilled" ? res.value.news : [] }))
  )
}

function postIdOf(item: SubscriberItem): number | null {
  const m = /^trd-(\d+)$/.exec(item.id)
  return m ? Number(m[1]) : null
}

type InitialNewsData = {
  outlook?: string
  publicMentions?: Record<"national" | "florida" | "miami", PublicMentionItem[]>
  investingNews?: Record<"national" | "florida" | "miami", PublicMentionItem[]>
  subscriberSources?: SubscriberSourcesResponse
}

export function NewsMorningPage({ initialNews }: { initialNews?: InitialNewsData } = {}) {
  const today = newsCalendarDayET()

  const [industry, setIndustry] = useState<FeedState>(() => {
    const items = initialNews?.publicMentions ? fromLevels(initialNews.publicMentions) : industryCache ?? null
    if (items && items.length > 0) industryCache = items
    return { items }
  })
  const [finance, setFinance] = useState<FeedState>(() => {
    const items = initialNews?.investingNews ? fromLevels(initialNews.investingNews) : financeCache ?? null
    if (items && items.length > 0) financeCache = items
    return { items }
  })
  const [subscriber, setSubscriber] = useState<SubscriberSourcesResponse | undefined>(() => {
    const s = initialNews?.subscriberSources ?? subscriberCache
    if (s && !s.error) subscriberCache = s
    return s
  })

  const [topic, setTopic] = useState("All")
  const [region, setRegion] = useState<"all" | MorningLevel>("all")
  const [onlyNew, setOnlyNew] = useState(false)
  const [search, setSearch] = useState("")
  const [showAllIndustry, setShowAllIndustry] = useState(false)
  const [showAllFinance, setShowAllFinance] = useState(false)
  const [briefTarget, setBriefTarget] = useState<BriefTarget | null>(null)
  const [readTarget, setReadTarget] = useState<ReadTarget | null>(null)
  const [digestOpen, setDigestOpen] = useState(false)

  useEffect(() => {
    let mounted = true
    if (industry.items === null) {
      loadLevels(fetchPublicMentions)
        .then((items) => {
          if (!mounted) return
          if (items.length > 0) industryCache = items
          setIndustry({ items })
        })
        .catch((err) => mounted && setIndustry({ items: [], error: err instanceof Error ? err.message : String(err) }))
    }
    if (finance.items === null) {
      loadLevels(fetchInvestingNews)
        .then((items) => {
          if (!mounted) return
          if (items.length > 0) financeCache = items
          setFinance({ items })
        })
        .catch((err) => mounted && setFinance({ items: [], error: err instanceof Error ? err.message : String(err) }))
    }
    if (!subscriber || subscriber.error) {
      fetchSubscriberSources()
        .then((s) => {
          if (!mounted) return
          if (!s.error) subscriberCache = s
          setSubscriber(s)
        })
        .catch((err) => mounted && setSubscriber({ items: [], notes: [], generatedAt: "", sources: [], error: err instanceof Error ? err.message : String(err) }))
    }
    return () => {
      mounted = false
    }
    // Once per mount; the initial props decide what is fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const picks = subscriber?.items ?? []
  const pickUrls = useMemo(() => picks.map((p) => p.url), [picks])
  const industryRows = useMemo(() => newestFirst(withoutUrls(industry.items ?? [], pickUrls)), [industry.items, pickUrls])
  const financeRows = useMemo(() => newestFirst(withoutUrls(finance.items ?? [], pickUrls)), [finance.items, pickUrls])

  const chips = topicChips([...picks, ...industryRows, ...financeRows])
  const q = search.trim().toLowerCase()
  const narrow = <T extends { region: string; date?: string; title: string; snippet?: string; source?: string }>(rows: T[]): T[] =>
    rows.filter(
      (r) =>
        (region === "all" || r.region === region) &&
        (!onlyNew || isSinceYesterday(r.date, today)) &&
        (!q || `${r.title} ${r.snippet ?? ""} ${r.source ?? ""}`.toLowerCase().includes(q))
    )
  const visiblePicks = narrow(byTopic(picks, topic))
  const visibleIndustry = narrow(byTopic(industryRows, topic))
  const visibleFinance = narrow(byTopic(financeRows, topic))
  const newCount = [...picks, ...industryRows, ...financeRows].filter((r) => isSinceYesterday(r.date, today)).length

  const trdReport = subscriber?.sources.find((s) => s.source === "The Real Deal")
  const asOf = subscriber?.generatedAt ? subscriber.generatedAt.slice(0, 10) : undefined

  const briefFor = (item: { title: string; url?: string; resolved_url?: string; source?: string; date?: string; snippet?: string }, level?: MorningLevel) => {
    setBriefTarget({ title: item.title, url: item.resolved_url || item.url, source: item.source, date: item.date, summary: item.snippet, level })
  }

  const th = (label: string, extra = "") => (
    <th className={`py-2 px-2 text-left font-medium text-slate-600 whitespace-nowrap ${extra}`}>
      <DefTerm term={`news:${label}`}>{label}</DefTerm>
    </th>
  )

  const dateCell = (date?: string) => (
    <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums text-slate-600">
      {date || "—"}
      {isSinceYesterday(date, today) ? (
        <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">new</span>
      ) : null}
    </td>
  )

  const headlineCell = (title: string, href: string | undefined, snippet: string | undefined, clamp = "line-clamp-1") => (
    <td className="py-2 px-2 align-top min-w-[320px]">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="text-[13px] font-medium leading-snug text-slate-900 hover:text-primary hover:underline">
          {title}
        </a>
      ) : (
        <span className="text-[13px] font-medium leading-snug text-slate-900">{title}</span>
      )}
      {snippet ? <p className={`mt-0.5 text-xs leading-snug text-slate-500 ${clamp}`}>{snippet}</p> : null}
    </td>
  )

  const smallBtn = "h-6 px-2 text-[11px]"

  const feedTable = (
    rows: FeedItem[],
    showAll: boolean,
    onShowAll: () => void,
    emptyText: string,
    error?: string,
    loading?: boolean
  ) => {
    if (loading) return <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
    if (error) return <p className="px-3 py-4 text-sm text-amber-700">Could not load this list: {error}</p>
    if (rows.length === 0) return <p className="px-3 py-4 text-sm text-slate-500">{emptyText}</p>
    const shown = showAll ? rows : rows.slice(0, LIST_PREVIEW)
    return (
      <>
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {th("Date")}
              {th("Headline")}
              {th("Source")}
              {th("Region")}
              {th("Topic")}
              {th("Actions", "text-right")}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((item, i) => {
              const headline = cleanHeadline(item.title, item.source)
              const snippet = usefulSnippet(item.title, item.snippet, item.source)
              return (
                <tr key={`${item.id}-${i}`} className="hover:bg-slate-50/60">
                  {dateCell(item.date)}
                  {headlineCell(headline, item.resolved_url || item.url, snippet)}
                  <td className="py-2 px-2 align-top whitespace-nowrap text-slate-700">{item.source || "—"}</td>
                  <td className="py-2 px-2 align-top whitespace-nowrap text-slate-600">{regionLabel(item.region)}</td>
                  <td className="py-2 px-2 align-top whitespace-nowrap text-slate-600">{item.topic}</td>
                  <td className="py-2 px-2 align-top text-right whitespace-nowrap">
                    <Button variant="outline" size="sm" className={smallBtn} onClick={() => briefFor({ ...item, title: headline, snippet }, item.feedLevel)}>
                      Brief
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!showAll && rows.length > LIST_PREVIEW ? (
          <div className="border-t border-slate-200 px-3 py-2">
            <button type="button" onClick={onShowAll} className="text-xs font-medium text-primary hover:underline">
              Show all {rows.length}
            </button>
          </div>
        ) : null}
      </>
    )
  }

  const section = (title: string, hint: string, count: number | null, children: React.ReactNode) => (
    <section className="rounded-md border border-slate-200 bg-white overflow-x-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          {title}
          <span className="ml-2 text-xs font-normal text-slate-500">{hint}</span>
        </h2>
        {count !== null ? <span className="text-[11px] text-slate-500">{count} stories</span> : null}
      </div>
      {children}
    </section>
  )

  const tiles = [
    { label: "Subscriber picks", value: subscriber && !subscriber.error ? picks.length : null },
    { label: "Industry stories", value: industry.items ? industryRows.length : null },
    { label: "Finance stories", value: finance.items ? financeRows.length : null },
    { label: "Since yesterday", value: industry.items || finance.items ? newCount : null, tone: "text-emerald-700" },
  ]

  return (
    <div className="max-w-[1500px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Newspaper className="h-6 w-6 text-slate-500" /> News
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            The morning scan: the firm&apos;s subscription picks, then industry and finance news for the past seven days, newest first,
            with the industry outlook condensed to its key signals.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {longDateET(today)}
            {asOf ? (
              <>
                {" "}· subscriber picks read <span className="font-medium text-slate-700">{asOf}</span>
              </>
            ) : null}
            {" "}· feeds refreshed each morning at 05:00 UTC
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDigestOpen(true)} className="gap-1.5">
          <FileText className="h-4 w-4" />
          Summarize a link
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Topic
          <select className="border rounded px-2 py-1 text-sm" value={topic} onChange={(e) => setTopic(e.target.value)}>
            {chips.map(({ topic: t, count }) => (
              <option key={t} value={t}>
                {t === "All" ? "All topics" : `${t} (${count})`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Region
          <select className="border rounded px-2 py-1 text-sm" value={region} onChange={(e) => setRegion(e.target.value as "all" | MorningLevel)}>
            <option value="all">All regions</option>
            {MORNING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {regionLabel(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700 pb-1">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
          Since yesterday only
        </label>
        <label className="flex items-center gap-1 border rounded px-2 py-1 text-sm ml-auto">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input className="outline-none w-48 text-sm" placeholder="Headline, source or text" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
            <p className={`text-xl font-semibold tabular-nums ${t.tone ?? "text-slate-900"}`}>{t.value === null ? "—" : t.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <IndustryOutlook initialText={initialNews?.outlook} condensed />

        {section(
          "From the firm's subscriptions",
          trdReport ? `The Real Deal · top ${picks.length} of ${trdReport.candidates} articles this week` : "The Real Deal",
          subscriber && !subscriber.error ? visiblePicks.length : null,
          subscriber?.error ? (
            <p className="px-3 py-4 text-sm text-amber-700">Subscriber sources unavailable today: {subscriber.error}</p>
          ) : !subscriber ? (
            <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>
          ) : visiblePicks.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-500">
              {picks.length === 0 ? subscriber.notes.join(" ") || "No subscriber articles qualified this week." : "No subscriber articles match these filters."}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {th("Date")}
                  {th("Headline")}
                  {th("Region")}
                  {th("Topic")}
                  {th("Score", "text-right")}
                  {th("Actions", "text-right")}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visiblePicks.map((p) => {
                  const postId = postIdOf(p)
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/60">
                      {dateCell(p.date)}
                      {headlineCell(p.title, p.url, p.snippet, "line-clamp-2")}
                      <td className="py-2 px-2 align-top whitespace-nowrap text-slate-600">{regionLabel(p.region)}</td>
                      <td className="py-2 px-2 align-top whitespace-nowrap text-slate-600">{p.topic}</td>
                      <td
                        className="py-2 px-2 align-top text-right tabular-nums text-slate-700 cursor-help"
                        title={p.reasons.length ? `Why it ranked:\n• ${p.reasons.join("\n• ")}` : undefined}
                      >
                        {p.score}
                      </td>
                      <td className="py-2 px-2 align-top text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          {postId !== null ? (
                            <Button size="sm" className={`${smallBtn} gap-1`} onClick={() => setReadTarget({ postId, title: p.title, source: p.source, date: p.date, url: p.url })}>
                              <BookOpen className="h-3 w-3" />
                              Read
                            </Button>
                          ) : null}
                          <Button size="sm" variant="outline" className={`${smallBtn} gap-1`} asChild>
                            <a href={p.url} target="_blank" rel="noreferrer">
                              Open
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </Button>
                          <Button size="sm" variant="outline" className={smallBtn} onClick={() => briefFor(p, p.region)}>
                            Brief
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        )}

        {section(
          "Industry news",
          "distressed CRE debt, past 7 days",
          industry.items ? visibleIndustry.length : null,
          feedTable(visibleIndustry, showAllIndustry, () => setShowAllIndustry(true), "No qualifying industry stories in the past 7 days.", industry.error, industry.items === null)
        )}

        {section(
          "Finance news",
          "rates, credit and markets, past 7 days",
          finance.items ? visibleFinance.length : null,
          feedTable(visibleFinance, showAllFinance, () => setShowAllFinance(true), "No qualifying finance stories in the past 7 days.", finance.error, finance.items === null)
        )}
      </div>

      <NewsBriefDialog target={briefTarget} onClose={() => setBriefTarget(null)} />
      <TrdReadDialog target={readTarget} onClose={() => setReadTarget(null)} />

      <Dialog open={digestOpen} onOpenChange={setDigestOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Summarize a link</DialogTitle>
            <DialogDescription>Paste an article URL or text, or upload a PDF, for a short digest.</DialogDescription>
          </DialogHeader>
          <ArticleDigest />
        </DialogContent>
      </Dialog>
    </div>
  )
}
