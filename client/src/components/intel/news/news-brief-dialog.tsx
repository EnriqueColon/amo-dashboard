import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { summarizeNewsItem, type NewsBrief, type NewsSummaryInput } from "@/lib/intel/news-api"

export type BriefTarget = NewsSummaryInput & { level?: "national" | "florida" | "miami" }

/**
 * The Brief dialog as the two news tables render it, lifted out so the morning page can share it.
 * The tables keep their own copy for now; when the morning page replaces them this is the only one.
 * Owns the summarize call: pass a target to open, null to close.
 */
export function NewsBriefDialog({ target, onClose }: { target: BriefTarget | null; onClose: () => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [brief, setBrief] = useState<NewsBrief | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      if (!target) return
      setLoading(true)
      setError(undefined)
      setBrief(null)
      try {
        const result = await summarizeNewsItem(target)
        if (!mounted) return
        setBrief(result)
      } catch (err) {
        if (!mounted) return
        setError(err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error")
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
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Brief</DialogTitle>
          <DialogDescription>
            {target?.source ? `${target.source}` : "Unknown source"}
            {target?.date ? ` • ${target.date}` : ""}
            {target?.url ? (
              <>
                {" "}
                •{" "}
                <a className="text-primary underline" href={target.url} target="_blank" rel="noreferrer">
                  Open article
                </a>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {target?.title ? <div className="text-sm font-semibold">{target.title}</div> : null}

          {loading && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Preparing brief… first view of an article can take up to a minute; it loads instantly after that.
              </p>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {!loading && error && <div className="text-sm text-destructive">Failed to generate summary: {error}</div>}

          {!loading && brief && (
            <div className="space-y-4">
              <div className="text-sm text-slate-800 leading-relaxed">{brief.executiveSummary}</div>

              {brief.dealSpecifics && Object.values(brief.dealSpecifics).some(Boolean) && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <div className="text-xs font-semibold text-primary uppercase mb-2">Deal Specifics</div>
                  <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    {brief.dealSpecifics.assetType && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Asset Type:</span> {brief.dealSpecifics.assetType}
                      </div>
                    )}
                    {brief.dealSpecifics.location && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Location:</span> {brief.dealSpecifics.location}
                      </div>
                    )}
                    {brief.dealSpecifics.loanAmount && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Loan Amount:</span> {brief.dealSpecifics.loanAmount}
                      </div>
                    )}
                    {brief.dealSpecifics.lender && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Lender:</span> {brief.dealSpecifics.lender}
                      </div>
                    )}
                    {brief.dealSpecifics.borrower && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Borrower:</span> {brief.dealSpecifics.borrower}
                      </div>
                    )}
                    {brief.dealSpecifics.dealStatus && (
                      <div className="text-xs text-slate-700">
                        <span className="font-medium">Status:</span> {brief.dealSpecifics.dealStatus}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-900 uppercase">Key bullets</div>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {brief.keyBullets.map((b, idx) => (
                      <li key={`kb-${idx}`}>{b}</li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-900 uppercase">Why it matters</div>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {brief.whyItMatters.map((b, idx) => (
                      <li key={`wm-${idx}`}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {(brief.entities.length > 0 || brief.redFlags.length > 0) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  {brief.entities.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold text-slate-900 uppercase">Entities</div>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {brief.entities.map((b, idx) => (
                          <li key={`en-${idx}`}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {brief.redFlags.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold text-slate-900 uppercase">Red flags / gaps</div>
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {brief.redFlags.map((b, idx) => (
                          <li key={`rf-${idx}`}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900 uppercase">Follow-ups</div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {brief.followUps.map((b, idx) => (
                    <li key={`fu-${idx}`}>{b}</li>
                  ))}
                </ul>
              </div>

              <div className="text-xs text-slate-900">
                Confidence: <span className="font-medium text-slate-800">{brief.confidence}/100</span>
                {brief.notes?.length ? <span className="ml-2">• {brief.notes.join(" ")}</span> : null}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
