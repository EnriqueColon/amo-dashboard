import { useMemo, useState } from "react"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  digestFromFile,
  digestFromText,
  digestFromUrl,
  type ArticleDigest as ArticleDigestResult,
} from "@/lib/intel/news-api"

function formatDigestForCopy(d: ArticleDigestResult) {
  const lines: string[] = []
  lines.push(`Executive summary: ${d.executiveSummary}`)
  const addList = (label: string, items: string[]) => {
    if (!items.length) return
    lines.push("")
    lines.push(`${label}:`)
    for (const it of items) lines.push(`- ${it}`)
  }
  addList("Key bullets", d.keyBullets)
  addList("Why it matters", d.whyItMatters)
  addList("Entities", d.entities)
  addList("Red flags / gaps", d.redFlags)
  addList("Follow-ups", d.followUps)
  lines.push("")
  lines.push(`Confidence: ${d.confidence}/100`)
  if (d.notes?.length) lines.push(`Notes: ${d.notes.join(" ")}`)
  return lines.join("\n")
}

export function ArticleDigest() {
  const [mode, setMode] = useState<"url" | "file" | "text">("url")

  const [url, setUrl] = useState("")
  const [pasteText, setPasteText] = useState("")
  const [file, setFile] = useState<File | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [digest, setDigest] = useState<ArticleDigestResult | null>(null)

  const canRun = useMemo(() => {
    if (loading) return false
    if (mode === "url") return url.trim().length > 0
    if (mode === "text") return pasteText.trim().length > 0
    return Boolean(file)
  }, [file, loading, mode, pasteText, url])

  async function runDigest() {
    setLoading(true)
    setError(undefined)
    setDigest(null)
    try {
      if (mode === "url") {
        const result = await digestFromUrl(url)
        setDigest(result)
        return
      }
      if (mode === "text") {
        const result = await digestFromText(pasteText, "Pasted text")
        setDigest(result)
        return
      }
      const fd = new FormData()
      if (file) fd.set("file", file)
      const result = await digestFromFile(fd)
      setDigest(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  async function copyDigest() {
    if (!digest) return
    await navigator.clipboard.writeText(formatDigestForCopy(digest))
  }

  async function copyJson() {
    if (!digest) return
    await navigator.clipboard.writeText(JSON.stringify(digest, null, 2))
  }

  return (
    <Card className="p-6 border-slate-200/80 bg-slate-50/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Article Digest</h3>
          <p className="text-sm text-slate-600">
            Paste a URL, upload a PDF/text file, or paste content to generate a structured briefing.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!digest} onClick={copyDigest} title="Copy bullet summary">
            Copy summary
          </Button>
          <Button variant="outline" disabled={!digest} onClick={copyJson} title="Copy raw JSON">
            Copy JSON
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
          <TabsList className="grid w-full max-w-xl grid-cols-3">
            <TabsTrigger value="url">URL</TabsTrigger>
            <TabsTrigger value="file">Upload</TabsTrigger>
            <TabsTrigger value="text">Paste</TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="mt-3 space-y-2">
            <Input
              placeholder="Paste an article URL (PDF or web page)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="text-xs text-slate-600">
              Best-effort: paywalls/scanned PDFs may reduce extraction quality.
            </div>
          </TabsContent>

          <TabsContent value="file" className="mt-3 space-y-2">
            <Input
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,.html,text/plain,application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0] || null
                setFile(f)
              }}
            />
            <div className="text-xs text-slate-600">
              Supported: PDF (text-based) and common text files. For other formats, paste content.
            </div>
          </TabsContent>

          <TabsContent value="text" className="mt-3 space-y-2">
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste text to summarize (e.g., an investment memo excerpt, term sheet section, or article body)"
              className="min-h-[140px]"
            />
            <div className="text-xs text-slate-600">
              Tip: paste the most relevant sections to maximize accuracy.
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-3 flex items-center gap-3">
          <Button onClick={runDigest} disabled={!canRun}>
            {loading ? "Generating…" : "Generate digest"}
          </Button>
          {error ? <div className="text-sm text-destructive">Digest failed: {error}</div> : null}
        </div>
      </div>

      <div className="mt-5">
        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {!loading && digest && (
          <div className="space-y-4">
            {digest.inputLabel ? (
              <div className="text-xs text-slate-600">
                Input: <span className="font-medium text-slate-800">{digest.inputLabel}</span>
              </div>
            ) : null}

            {digest.extraction ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-slate-600">
                <div className="font-semibold uppercase text-[11px] text-slate-800/80">Extraction status</div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <div>
                    Method: <span className="text-slate-800">{digest.extraction.method}</span>
                    {digest.extraction.coverage.used_ocr ? " (OCR used)" : ""}
                  </div>
                  <div>
                    Pages: <span className="text-slate-800">{digest.extraction.coverage.num_pages || "—"}</span>
                  </div>
                  <div>
                    Pages w/ text:{" "}
                    <span className="text-slate-800">{digest.extraction.coverage.pages_with_text}</span>
                  </div>
                  <div>
                    Extracted chars:{" "}
                    <span className="text-slate-800">{digest.extraction.coverage.total_chars}</span>
                  </div>
                </div>
                {digest.extraction.errors?.length ? (
                  <div className="mt-2">
                    Errors:
                    <ul className="mt-1 list-disc pl-5">
                      {digest.extraction.errors.slice(0, 3).map((e, idx) => (
                        <li key={`exerr-${idx}`}>
                          <span className="text-slate-800">{e.stage}:</span> {e.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="text-sm text-slate-800">{digest.executiveSummary}</div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-600 uppercase">Key bullets</div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {digest.keyBullets.map((b, idx) => (
                    <li key={`kb-${idx}`}>{b}</li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-600 uppercase">Why it matters</div>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {digest.whyItMatters.map((b, idx) => (
                    <li key={`wm-${idx}`}>{b}</li>
                  ))}
                </ul>
              </div>
            </div>

            {(digest.entities.length > 0 || digest.redFlags.length > 0) && (
              <div className="grid gap-4 sm:grid-cols-2">
                {digest.entities.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-600 uppercase">Entities</div>
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {digest.entities.map((b, idx) => (
                        <li key={`en-${idx}`}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {digest.redFlags.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-600 uppercase">Red flags / gaps</div>
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {digest.redFlags.map((b, idx) => (
                        <li key={`rf-${idx}`}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-600 uppercase">Follow-ups</div>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {digest.followUps.map((b, idx) => (
                  <li key={`fu-${idx}`}>{b}</li>
                ))}
              </ul>
            </div>

            <div className="text-xs text-slate-600">
              Confidence: <span className="font-medium text-slate-800">{digest.confidence}/100</span>
              {digest.notes?.length ? <span className="ml-2">• {digest.notes.join(" ")}</span> : null}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

