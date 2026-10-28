/**
 * The morning page's pure helpers: merging the three regional feeds, ordering for a once-a-day
 * reader, marking what is recent, and the shared topic filter. No fetching, no React.
 *
 * The page exists for a morning scan on a phone or a desktop (the user's description,
 * 2026-10-28): read top to bottom once, newest first, nothing hidden behind a hover. The data is
 * the same daily snapshot the tables show; only the presentation changes.
 */

export type MorningLevel = "national" | "florida" | "miami"
export const MORNING_LEVELS: MorningLevel[] = ["national", "florida", "miami"]

export type MorningItem = {
  id: string
  title: string
  url?: string
  resolved_url?: string
  source?: string
  date?: string
  snippet?: string
  region: MorningLevel
  topic: string
  access_status?: "open" | "partial" | "paywalled"
  undated?: boolean
}

export type MergedMorningItem<T extends MorningItem> = T & { feedLevel: MorningLevel }

function itemKey(item: MorningItem): string {
  if (item.url) {
    try {
      const u = new URL(item.url)
      return `u:${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase()
    } catch {
      return `u:${item.url.trim().toLowerCase()}`
    }
  }
  return `t:${(item.source || "").toLowerCase()}:${item.title.trim().toLowerCase()}`
}

/** The three regional lists as one, first occurrence wins, each item remembering its feed level. */
export function mergeLevels<T extends MorningItem>(perLevel: Array<{ level: MorningLevel; items: T[] }>): Array<MergedMorningItem<T>> {
  const seen = new Set<string>()
  const out: Array<MergedMorningItem<T>> = []
  for (const { level, items } of perLevel) {
    for (const item of items) {
      const key = itemKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...item, feedLevel: level })
    }
  }
  return out
}

/** Items whose URL is already shown elsewhere on the page (the subscriber cards) are not listed twice. */
export function withoutUrls<T extends MorningItem>(items: T[], urls: Iterable<string | undefined>): T[] {
  const taken = new Set<string>()
  for (const u of urls) if (u) taken.add(itemKey({ id: "", title: "", url: u, region: "national", topic: "" }))
  return items.filter((it) => !taken.has(itemKey(it)))
}

/**
 * Newest first for a reader who opens the tab once a day; undated items last, and within a day the
 * ones the tool could read in full before the ones it could not.
 */
export function newestFirst<T extends MorningItem>(items: T[]): T[] {
  const accessRank = (a?: MorningItem["access_status"]) => (a === "open" ? 0 : a === "partial" ? 1 : 2)
  return [...items].sort((a, b) => {
    const ad = a.date || ""
    const bd = b.date || ""
    if (ad !== bd) {
      if (!ad) return 1
      if (!bd) return -1
      return bd.localeCompare(ad)
    }
    return accessRank(a.access_status) - accessRank(b.access_status)
  })
}

/** The Eastern calendar day `days` before `todayET` (YYYY-MM-DD), by date arithmetic on the string. */
export function daysBeforeET(todayET: string, days: number): string {
  const [y, m, d] = todayET.split("-").map(Number)
  const t = Date.UTC(y, m - 1, d) - days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * "Since yesterday": published on today's or yesterday's Eastern calendar day. A once-a-day reader
 * needs this rather than read-tracking, which the tool cannot do without user accounts. Undated
 * items are never recent.
 */
export function isSinceYesterday(date: string | undefined, todayET: string): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  return date >= daysBeforeET(todayET, 1) && date <= todayET
}

/** Topics across every section, with counts, "All" first and the rest alphabetical. */
export function topicChips(items: Array<{ topic: string }>): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>()
  for (const it of items) {
    if (!it.topic) continue
    counts.set(it.topic, (counts.get(it.topic) || 0) + 1)
  }
  const rest = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([topic, count]) => ({ topic, count }))
  return [{ topic: "All", count: items.length }, ...rest]
}

export function byTopic<T extends { topic: string }>(items: T[], topic: string): T[] {
  return topic === "All" ? items : items.filter((it) => it.topic === topic)
}

export function regionLabel(region?: MorningLevel): string {
  if (region === "miami") return "Miami Metro"
  if (region === "florida") return "Florida"
  return "National"
}

function normalizeForCompare(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/**
 * Google News RSS titles end in " - Outlet". The outlet is already on the grey line, so the suffix
 * goes when it names the item's source; a dash inside a real headline stays.
 */
export function cleanHeadline(title: string, source?: string): string {
  const t = (title || "").trim()
  if (!source) return t
  const m = /^(.*\S)\s+[-–—]\s+([^-–—]+)$/.exec(t)
  if (!m) return t
  return normalizeForCompare(m[2]) === normalizeForCompare(source) ? m[1].trim() : t
}

/**
 * A snippet that only repeats the headline (Google News's description is the headline plus the
 * outlet) is nothing to read twice; return undefined so the row shows the headline once.
 */
export function usefulSnippet(title: string, snippet: string | undefined, source?: string): string | undefined {
  const s = (snippet || "").replace(/\s+/g, " ").trim()
  if (!s) return undefined
  const ns = normalizeForCompare(s)
  const nt = normalizeForCompare(title)
  const nbase = normalizeForCompare(cleanHeadline(title, source))
  const nsrc = normalizeForCompare(source || "")
  if (ns === nt || ns === nbase) return undefined
  if (nsrc && (ns === nbase + nsrc || ns === nt + nsrc || ns === nsrc + nbase)) return undefined
  // The headline followed by nothing but the outlet, however punctuated.
  if (ns.startsWith(nbase) && nsrc && ns.slice(nbase.length) === nsrc) return undefined
  return s
}

/** A long date for the page header, in Eastern time: "Tuesday, October 28, 2026". */
export function longDateET(todayET: string): string {
  const [y, m, d] = todayET.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  )
}
