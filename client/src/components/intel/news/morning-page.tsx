import { useEffect, useMemo, useState } from "react"
import { BookOpen, ExternalLink, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
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
  const visiblePicks = byTopic(picks, topic)
  const visibleIndustry = byTopic(industryRows, topic)
  const visibleFinance = byTopic(financeRows, topic)

  const trdReport = subscriber?.sources.find((s) => s.source === "The Real Deal")
  const asOf = subscriber?.generatedAt ? subscriber.generatedAt.slice(0, 10) : undefined

  const briefFor = (item: { title: string; url?: string; resolved_url?: string; source?: string; date?: string; snippet?: string }, level?: MorningLevel) => {
    setBriefTarget({ title: item.title, url: item.resolved_url || item.url, source: item.source, date: item.date, summary: item.snippet, level })
  }

  const recentPill = (date?: string) =>
    isSinceYesterday(date, today) ? (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">Since yesterday</span>
    ) : null

  const renderList = (rows: FeedItem[], showAll: boolean, onShowAll: () => void, emptyText: string, error?: string, loading?: boolean) => {
    if (loading) {
      return (
        <div className="space-y-3 py-2">
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-4 w-8/12" />
          <Skeleton className="h-4 w-11/12" />
        </div>
      )
    }
    if (error) return <p className="py-2 text-sm text-amber-700">Could not load this list: {error}</p>
    if (rows.length === 0) return <p className="py-2 text-sm text-slate-600">{emptyText}</p>
    const shown = showAll ? rows : rows.slice(0, LIST_PREVIEW)
    return (
      <>
        <ul className="divide-y divide-slate-200">
          {shown.map((item, i) => {
            const headline = cleanHeadline(item.title, item.source)
            const snippet = usefulSnippet(item.title, item.snippet, item.source)
            return (
            <li key={`${item.id}-${i}`} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                {item.url ? (
                  <a
                    href={item.resolved_url || item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[15px] font-medium leading-snug text-slate-900 hover:text-primary hover:underline"
                  >
                    {headline}
                  </a>
                ) : (
                  <span className="text-[15px] font-medium leading-snug text-slate-900">{headline}</span>
                )}
                {snippet ? <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{snippet}</p> : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{item.source || "—"}</span>
                  {item.date ? (
                    <>
                      <span>·</span>
                      <span>{item.date}</span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span>{regionLabel(item.region)}</span>
                  <span>·</span>
                  <span>{item.topic}</span>
                  {recentPill(item.date)}
                </div>
              </div>
              <Button variant="ghost" size="sm" className="shrink-0 text-slate-700" onClick={() => briefFor({ ...item, title: headline, snippet }, item.feedLevel)}>
                Brief
              </Button>
            </li>
            )
          })}
        </ul>
        {!showAll && rows.length > LIST_PREVIEW ? (
          <button type="button" onClick={onShowAll} className="mt-2 text-sm font-medium text-primary hover:underline">
            Show all {rows.length}
          </button>
        ) : null}
      </>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Morning scan</h2>
          <p className="text-sm text-slate-600">
            {longDateET(today)}. The firm&apos;s subscriptions first, then the feeds, newest first
            {asOf ? `; subscriber picks read ${asOf}` : ""}.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDigestOpen(true)} className="gap-1.5">
          <FileText className="h-4 w-4" />
          Summarize a link
        </Button>
      </div>

      <IndustryOutlook initialText={initialNews?.outlook} condensed />

      {chips.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map(({ topic: t, count }) => (
            <button
              key={t}
              type="button"
              onClick={() => setTopic(t)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                topic === t ? "bg-primary text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {t}
              {t !== "All" ? <span className="ml-1 opacity-60">{count}</span> : null}
            </button>
          ))}
        </div>
      )}

      <section aria-labelledby="subscriber-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="subscriber-heading" className="text-base font-semibold text-slate-800">
            From the firm&apos;s subscriptions
            <span className="ml-2 text-sm font-normal text-slate-500">The Real Deal</span>
          </h3>
          {trdReport ? (
            <span className="text-xs text-slate-500">
              Top {picks.length} of {trdReport.candidates} articles this week
            </span>
          ) : null}
        </div>
        {subscriber?.error ? (
          <p className="text-sm text-amber-700">Subscriber sources unavailable today: {subscriber.error}</p>
        ) : !subscriber ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={`sk-${i}`} className="space-y-2 rounded-xl border border-slate-200 bg-card p-4">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-5 w-11/12" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : visiblePicks.length === 0 ? (
          <p className="text-sm text-slate-600">
            {picks.length === 0 ? subscriber.notes.join(" ") || "No subscriber articles qualified this week." : "No subscriber articles under this topic."}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visiblePicks.map((p) => {
              const postId = postIdOf(p)
              return (
                <article key={p.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{p.source}</span>
                    <span>{p.date}</span>
                    {recentPill(p.date)}
                    <span className="text-slate-400">·</span>
                    <span>{regionLabel(p.region)}</span>
                    <span className="text-slate-400">·</span>
                    <span>{p.topic}</span>
                  </div>
                  <h4 className="text-base font-semibold leading-snug text-slate-900">{p.title}</h4>
                  {p.snippet ? <p className="text-sm leading-relaxed text-slate-700">{p.snippet}</p> : null}
                  {p.reasons.length > 0 ? (
                    <details className="text-xs text-slate-600">
                      <summary className="cursor-pointer select-none text-primary">Why it ranked (score {p.score})</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {p.reasons.map((r, i) => (
                          <li key={`r-${i}`}>{r}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {postId !== null ? (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-primary hover:bg-[#005a7a]"
                        onClick={() => setReadTarget({ postId, title: p.title, source: p.source, date: p.date, url: p.url })}
                      >
                        <BookOpen className="h-4 w-4" />
                        Read
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" asChild>
                      <a href={p.url} target="_blank" rel="noreferrer" className="gap-1.5">
                        Open
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                    <Button size="sm" variant="ghost" className="text-slate-700" onClick={() => briefFor(p, p.region)}>
                      Brief
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="industry-heading" className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="industry-heading" className="text-base font-semibold text-slate-800">
            Industry news
            <span className="ml-2 text-sm font-normal text-slate-500">distressed CRE debt, past 7 days</span>
          </h3>
          {industry.items ? <span className="text-xs text-slate-500">{visibleIndustry.length} stories</span> : null}
        </div>
        {renderList(visibleIndustry, showAllIndustry, () => setShowAllIndustry(true), "No qualifying industry stories in the past 7 days.", industry.error, industry.items === null)}
      </section>

      <section aria-labelledby="finance-heading" className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="finance-heading" className="text-base font-semibold text-slate-800">
            Finance news
            <span className="ml-2 text-sm font-normal text-slate-500">rates, credit and markets, past 7 days</span>
          </h3>
          {finance.items ? <span className="text-xs text-slate-500">{visibleFinance.length} stories</span> : null}
        </div>
        {renderList(visibleFinance, showAllFinance, () => setShowAllFinance(true), "No qualifying finance stories in the past 7 days.", finance.error, finance.items === null)}
      </section>

      <NewsBriefDialog target={briefTarget} onClose={() => setBriefTarget(null)} />
      <TrdReadDialog target={readTarget} onClose={() => setReadTarget(null)} />

      <Dialog open={digestOpen} onOpenChange={setDigestOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Summarize a link</DialogTitle>
            <DialogDescription>Paste an article URL or text; the digest is the same tool that sat at the foot of the tab.</DialogDescription>
          </DialogHeader>
          <ArticleDigest />
        </DialogContent>
      </Dialog>
    </div>
  )
}
