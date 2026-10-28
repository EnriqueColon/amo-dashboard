/**
 * The News page's data, from this server (`/api/intel/news/*`).
 *
 * Same function names and return shapes as the tool's server actions, so the
 * ported components call them unchanged; each is one request to a route that
 * runs the ported action on the server and reads intel.db's daily cache.
 */
import type {
  ArticleDigest,
  InvestingNewsResponse,
  NewsBrief,
  NewsLevel,
  NewsSummaryInput,
  PublicMentionItem,
  PublicMentionsResponse,
  SubscriberItem,
  SubscriberSourcesResponse,
  TrdArticleResult,
} from "./news-types"

export type {
  ArticleDigest,
  InvestingNewsResponse,
  NewsBrief,
  NewsLevel,
  NewsSummaryInput,
  PublicMentionItem,
  PublicMentionsResponse,
  SubscriberItem,
  SubscriberSourcesResponse,
  TrdArticleResult,
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/intel/news/${path}`, { credentials: "same-origin", ...init })
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`)
  if (!body) throw new Error("Empty response.")
  return body
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
}

export function fetchPublicMentions(level: NewsLevel): Promise<PublicMentionsResponse> {
  return call(`public-mentions?level=${level}`)
}

export function fetchInvestingNews(level: NewsLevel): Promise<InvestingNewsResponse> {
  return call(`investing-news?level=${level}`)
}

export function fetchSubscriberSources(): Promise<SubscriberSourcesResponse> {
  return call("subscriber-sources")
}

export function summarizeNewsItem(input: NewsSummaryInput & { level?: NewsLevel }): Promise<NewsBrief> {
  return post("brief", input)
}

export function fetchTrdArticle(postId: number): Promise<TrdArticleResult> {
  return call(`trd-article?postId=${encodeURIComponent(String(postId))}`)
}

export function digestFromUrl(url: string): Promise<ArticleDigest> {
  return post("digest/url", { url })
}

export function digestFromText(text: string, label?: string): Promise<ArticleDigest> {
  return post("digest/text", { text, label })
}

/**
 * The component hands over a FormData with the file; it goes up as base64
 * JSON (max 15 MB, the same cap the action enforces) and the server rebuilds
 * a File for the action.
 */
export async function digestFromFile(formData: FormData): Promise<ArticleDigest> {
  const file = formData.get("file")
  if (!(file instanceof File)) throw new Error("No file selected.")
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return post("digest/file", { name: file.name, type: file.type, base64: btoa(binary) })
}
