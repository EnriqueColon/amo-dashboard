import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetchTrdArticle, type TrdArticleResult } from "@/lib/intel/news-api"

export type ReadTarget = { postId: number; title: string; source?: string; date?: string; url?: string }

const articleCache = new Map<number, TrdArticleResult>()

/**
 * The Read view of a Real Deal pick, lifted out of the Industry-Specific News table so the morning
 * page can share it. On a phone it fills the screen; on a desktop it is a wide dialog. Owns the
 * fetch and a per-session cache: pass a target to open, null to close.
 */
export function TrdReadDialog({ target, onClose }: { target: ReadTarget | null; onClose: () => void }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TrdArticleResult | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!target) return
      const cached = articleCache.get(target.postId)
      if (cached) {
        setResult(cached)
        return
      }
      setLoading(true)
      setResult(null)
      try {
        const r = await fetchTrdArticle(target.postId)
        if (!mounted) return
        if (r.ok) articleCache.set(target.postId, r)
        setResult(r)
      } catch (err) {
        if (!mounted) return
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [target])

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col overflow-hidden rounded-none sm:h-auto sm:max-h-[85vh] sm:w-auto sm:max-w-3xl sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="pr-6 text-left leading-snug">{result?.ok ? result.article.title : target?.title || "Article"}</DialogTitle>
          <DialogDescription className="text-left">
            {target?.source || "The Real Deal"}
            {result?.ok
              ? ` • published ${result.article.date}${
                  result.article.modified && result.article.modified !== result.article.date ? `, updated ${result.article.modified}` : ""
                } • ${result.article.wordCount.toLocaleString()} words`
              : target?.date
                ? ` • ${target.date}`
                : ""}
            {target?.url ? (
              <>
                {" "}
                •{" "}
                <a className="text-primary underline" href={target.url} target="_blank" rel="noreferrer">
                  Open on The Real Deal
                </a>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto pr-2">
          {loading && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Reading the article from The Real Deal…</p>
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-4 w-9/12" />
            </div>
          )}

          {!loading && result && !result.ok && (
            <div className="text-sm text-slate-800">
              <p className="text-destructive">The article could not be read from the publisher: {result.error}</p>
              {target?.url ? (
                <p className="mt-2">
                  <a className="text-primary underline" href={target.url} target="_blank" rel="noreferrer">
                    Open it on The Real Deal
                  </a>{" "}
                  while signed in with the firm&apos;s account.
                </p>
              ) : null}
            </div>
          )}

          {!loading && result?.ok && (
            <article className="text-[15px] leading-relaxed text-slate-800 sm:text-sm">
              {result.article.blocks.map((b, i) =>
                b.kind === "h" ? (
                  <h3 key={`rb-${i}`} className="mt-4 mb-1 text-base font-semibold text-slate-900">
                    {b.text}
                  </h3>
                ) : b.kind === "quote" ? (
                  <blockquote key={`rb-${i}`} className="my-3 border-l-2 border-primary/40 pl-3 italic text-slate-700">
                    {b.text}
                  </blockquote>
                ) : b.kind === "li" ? (
                  <li key={`rb-${i}`} className="ml-5 list-disc">
                    {b.text}
                  </li>
                ) : (
                  <p key={`rb-${i}`} className="my-3">
                    {b.text}
                  </p>
                )
              )}
              <p className="mt-5 border-t border-slate-200 pt-3 text-xs text-slate-600">
                Text as published by The Real Deal, read from its public API on {result.readAt.slice(0, 10)}. Images, charts and embedded
                media are not shown; the article&apos;s own page has them.
              </p>
            </article>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
