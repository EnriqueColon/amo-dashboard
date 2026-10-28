import { unstable_cache } from "../cache-shim"
import { buildTrdArticleView, type TrdArticleView } from "@shared/news/trd"
import { fetchTrdPost } from "./trd-service"

/**
 * The Read view behind a pinned Real Deal row: the article's full text, read from the same public
 * API the picks come from, when a user asks for it. Not warmed — one request per article per day,
 * only for articles someone opens — and cached by post id for a day, since a published post's
 * text rarely changes and the view says when it was last modified. A refusal throws inside the
 * cache so nothing is stored, and the action returns the message for the dialog's one line.
 *
 * Built at the user's request (2026-10-27) so that anyone at the firm can read the article from
 * the tool without being signed in to the publisher. The View link beside it still opens the
 * article on the publisher's site.
 */

export type TrdArticleResult = { ok: true; article: TrdArticleView; readAt: string } | { ok: false; error: string }

const CACHE_VERSION = "trd-article-v1"
const ONE_DAY_SECONDS = 86_400

export async function fetchTrdArticle(postId: number): Promise<TrdArticleResult> {
  const id = Number(postId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "No article id on this row." }
  try {
    return await unstable_cache(
      async (): Promise<TrdArticleResult> => {
        const { post, record } = await fetchTrdPost(id)
        const article = buildTrdArticleView(post)
        if (!article) throw new Error(`The Real Deal API returned post ${id} without a readable body`)
        console.info("trd_article: read", { id, status: record.status, ms: record.ms, blocks: article.blocks.length, words: article.wordCount })
        return { ok: true, article, readAt: new Date().toISOString() }
      },
      [CACHE_VERSION, String(id)],
      { revalidate: ONE_DAY_SECONDS }
    )()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("trd_article: failed", { id, message })
    return { ok: false, error: message }
  }
}
