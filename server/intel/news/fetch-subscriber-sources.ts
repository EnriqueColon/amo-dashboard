import { unstable_cache } from "../cache-shim"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"
import { selectTrdTop, TRD_SOURCE_NAME, type TrdPick } from "@shared/news/trd"
import { fetchTrdPosts } from "./trd-service"

/**
 * Subscriber sources for Industry-Specific News: the publications the firm pays for, read by the
 * tool and pinned above the feed list. The Real Deal is the first; South Florida Business Journal
 * is held until the user decides its route (its site cannot be read by a server — see
 * `docs/NEWS_SUBSCRIBER_SOURCES_STATUS.md`).
 *
 * One daily snapshot, keyed on the Eastern calendar day like the rest of the News tab and warmed
 * by the 05:00 UTC cron. A build that gets nothing from a source throws inside the cached
 * function, so nothing is stored and the next read tries again; the action turns that into an
 * `error` the panel shows in one line.
 */

export type SubscriberItem = TrdPick

export type SubscriberSourceReport = {
  source: string
  candidates: number
  picked: number
  excluded: Record<string, number>
  requests: Array<{ name: string; status: number | null; count: number; ms: number; error?: string }>
}

export type SubscriberSourcesResponse = {
  items: SubscriberItem[]
  notes: string[]
  generatedAt: string
  sources: SubscriberSourceReport[]
  error?: string
}

// v2: ten picks rather than five (2026-10-27). Bumped so production shows ten on deploy rather than
// at the next day's rollover.
const CACHE_VERSION = "subscriber-sources-v2"

async function buildSubscriberSources(): Promise<SubscriberSourcesResponse> {
  const now = new Date()
  const notes: string[] = []
  const trd = await fetchTrdPosts(now)
  const selection = selectTrdTop(trd.posts, { now })
  for (const r of trd.requests) {
    if (r.error) notes.push(`${TRD_SOURCE_NAME}: the ${r.name} query failed (${r.error}); the other query's posts were used.`)
  }
  if (selection.picks.length === 0) {
    notes.push(`${TRD_SOURCE_NAME}: ${trd.posts.length} posts read, none within the last seven days.`)
  }
  console.info("subscriber_sources: trd", {
    requests: trd.requests.map((r) => ({ name: r.name, status: r.status, count: r.count, ms: r.ms, error: r.error })),
    candidates: selection.candidates,
    excluded: selection.excluded,
    picked: selection.picks.map((p) => ({ id: p.id, score: p.score, topic: p.topic })),
  })
  return {
    items: selection.picks,
    notes,
    generatedAt: now.toISOString(),
    sources: [
      {
        source: TRD_SOURCE_NAME,
        candidates: selection.candidates,
        picked: selection.picks.length,
        excluded: selection.excluded,
        requests: trd.requests.map(({ name, status, count, ms, error }) => ({ name, status, count, ms, error })),
      },
    ],
  }
}

export async function fetchSubscriberSources(): Promise<SubscriberSourcesResponse> {
  const day = newsCalendarDayET()
  try {
    return await unstable_cache(buildSubscriberSources, [CACHE_VERSION, day], { revalidate: NEWS_TAB_REVALIDATE_SECONDS })()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("subscriber_sources: build failed", { message })
    return { items: [], notes: [], generatedAt: new Date().toISOString(), sources: [], error: message }
  }
}
