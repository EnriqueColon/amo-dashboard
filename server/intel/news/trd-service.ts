import { TRD_QUERIES, trdPostUrl, trdQueryUrl, trdSinceParam, type TrdApiPost } from "@shared/news/trd"

/**
 * The Real Deal's WordPress REST API, fetched uncached. Two requests a day: the Miami market and
 * the commercial sector, each the last seven days (38 and 77 posts on 2026-10-27, so one page of
 * 100 covers each). The caller ranks them; see `lib/news/trd.ts`.
 *
 * Cloudflare fronts the site and answers 403 to any user agent it does not recognise as a browser,
 * including the `MarketIntelligence/1.0` string the feed fetchers send — which is why the tool's
 * RSS entries for TRD have returned nothing. A browser string passes from a laptop. Whether it
 * passes from Vercel's egress is a property of Cloudflare's rules, not of this code, so the
 * request records its status and the action turns a refusal into a note rather than a blank.
 */

export const TRD_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

const TIMEOUT_MS = 15_000

export type TrdRequestRecord = {
  name: string
  url: string
  status: number | null
  count: number
  ms: number
  error?: string
}

export type TrdFetchResult = {
  posts: TrdApiPost[]
  requests: TrdRequestRecord[]
  since: string
}

async function fetchQuery(name: string, url: string): Promise<{ posts: TrdApiPost[]; record: TrdRequestRecord }> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": TRD_BROWSER_UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })
    const ms = Date.now() - started
    if (!res.ok) {
      return { posts: [], record: { name, url, status: res.status, count: 0, ms, error: `HTTP ${res.status}` } }
    }
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) {
      return { posts: [], record: { name, url, status: res.status, count: 0, ms, error: "response is not a post array" } }
    }
    const posts = body.filter((p): p is TrdApiPost => typeof p === "object" && p !== null && typeof (p as TrdApiPost).id === "number")
    return { posts, record: { name, url, status: res.status, count: posts.length, ms: Date.now() - started } }
  } catch (err) {
    const message = err instanceof Error ? (err.name === "AbortError" ? `timeout after ${TIMEOUT_MS} ms` : err.message) : String(err)
    return { posts: [], record: { name, url, status: null, count: 0, ms: Date.now() - started, error: message } }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One post with its full body, for the Read view. Throws on a refusal or a missing body so the
 * caller's cache stores nothing; measured 0.4–1.4 s from a laptop.
 */
export async function fetchTrdPost(id: number): Promise<{ post: TrdApiPost; record: TrdRequestRecord }> {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid post id ${id}`)
  const url = trdPostUrl(id)
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": TRD_BROWSER_UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" },
    })
    if (!res.ok) throw new Error(`The Real Deal API answered HTTP ${res.status} for post ${id}`)
    const body = (await res.json()) as unknown
    if (!body || typeof body !== "object" || typeof (body as TrdApiPost).id !== "number") {
      throw new Error(`The Real Deal API returned no post for ${id}`)
    }
    const post = body as TrdApiPost
    return { post, record: { name: `post ${id}`, url, status: res.status, count: 1, ms: Date.now() - started } }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`The Real Deal API timed out after ${TIMEOUT_MS} ms for post ${id}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Both queries, concurrently. Throws only when every request failed, so a cached build never
 * stores an empty week that a refusal produced; one failed query of two is reported in `requests`
 * and the other's posts are used.
 */
export async function fetchTrdPosts(now = new Date()): Promise<TrdFetchResult> {
  const since = trdSinceParam(now)
  const results = await Promise.all(TRD_QUERIES.map((q) => fetchQuery(q.name, trdQueryUrl(q.params, since))))
  const requests = results.map((r) => r.record)
  if (requests.every((r) => r.error)) {
    throw new Error(`The Real Deal API refused every request: ${requests.map((r) => `${r.name} ${r.error}`).join("; ")}`)
  }
  const seen = new Set<number>()
  const posts: TrdApiPost[] = []
  for (const r of results) {
    for (const p of r.posts) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      posts.push(p)
    }
  }
  return { posts, requests, since }
}
