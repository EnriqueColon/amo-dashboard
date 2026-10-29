import { useRef, useState } from "react"
import { generateResearchMemo, type GeneratedMemo } from "@/lib/intel/research-api"
import type { ResearchReport } from "@/lib/intel/research-types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  X,
} from "lucide-react"

interface Props {
  reports: ResearchReport[]
  onClose: () => void
}

async function downloadAsDocx(memo: GeneratedMemo) {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    BorderStyle,
  } = await import("docx")

  const children: InstanceType<typeof Paragraph>[] = []

  children.push(
    new Paragraph({
      text: memo.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  )

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `${memo.date}  •  Market Conditions Memo`,
          color: "555555",
          size: 20,
        }),
      ],
    })
  )

  for (const section of memo.sections) {
    children.push(
      new Paragraph({
        text: section.heading,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360, after: 120 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "006D95" },
        },
      })
    )

    if (section.body) {
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: section.body, size: 22 })],
        })
      )
    }

    for (const bullet of section.bullets ?? []) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 80 },
          children: [new TextRun({ text: bullet, size: 22 })],
        })
      )
    }
  }

  children.push(
    new Paragraph({
      spacing: { before: 600 },
      border: {
        top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      },
      children: [
        new TextRun({
          text: memo.disclaimer,
          size: 18,
          color: "888888",
          italics: true,
        }),
      ],
    })
  )

  const doc = new Document({ sections: [{ children }] })
  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${memo.title.replace(/[^a-z0-9]/gi, "_").slice(0, 60)}.docx`
  a.click()
  URL.revokeObjectURL(url)
}

function MemoRenderer({ memo }: { memo: GeneratedMemo }) {
  return (
    <div className="space-y-6 text-slate-800">
      <div className="text-center border-b border-slate-200 pb-4">
        <h2 className="text-lg font-bold text-slate-900">{memo.title}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {memo.date} &nbsp;·&nbsp; Market Conditions Memo
        </p>
      </div>

      {memo.sections.map((section, i) => (
        <div key={i} className="space-y-2">
          <h3 className="text-sm font-bold text-primary uppercase tracking-wide border-b border-primary/20 pb-1">
            {section.heading}
          </h3>
          {section.body && (
            <p className="text-sm leading-relaxed">{section.body}</p>
          )}
          {section.bullets && section.bullets.length > 0 && (
            <ul className="space-y-1.5 mt-2">
              {section.bullets.map((b, j) => (
                <li key={j} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <div className="border-t border-slate-200 pt-4">
        <p className="text-xs text-slate-400 italic leading-relaxed">
          {memo.disclaimer}
        </p>
      </div>
    </div>
  )
}

export function ResearchMemoModal({ reports, onClose }: Props) {
  const [memo, setMemo] = useState<GeneratedMemo | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const generate = async () => {
    setGenerating(true)
    setError(null)
    setMemo(null)
    try {
      const result = await generateResearchMemo(reports)
      setMemo(result)
      setTimeout(() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }), 100)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate memo.")
    } finally {
      setGenerating(false)
    }
  }

  const copyText = async () => {
    if (!memo) return
    const text = [
      memo.title,
      memo.date,
      "",
      ...memo.sections.flatMap((s) => [
        s.heading.toUpperCase(),
        s.body,
        ...(s.bullets ?? []).map((b) => `  • ${b}`),
        "",
      ]),
      "---",
      memo.disclaimer,
    ].join("\n")
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const download = async () => {
    if (!memo) return
    setDownloading(true)
    try {
      await downloadAsDocx(memo)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative flex flex-col w-full max-w-3xl max-h-[90vh] rounded-xl bg-card shadow-2xl overflow-hidden">

        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <span className="font-semibold text-slate-800">Market Conditions Memo</span>
            <span className="text-xs text-slate-400 ml-1">
              {reports.length} report{reports.length !== 1 ? "s" : ""} selected
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-2">
              Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {reports.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded-full bg-card border border-slate-200 px-2 py-0.5 text-xs text-slate-700"
                >
                  <span className="font-medium text-primary">{r.publisher}</span>
                  <span className="text-slate-400 max-w-[140px] truncate">{r.title}</span>
                </span>
              ))}
            </div>
          </div>

          {!memo && !generating && (
            <Button
              className="w-full bg-primary hover:bg-[#005a7a] text-white"
              onClick={generate}
            >
              Generate memo
            </Button>
          )}

          {generating && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Generating memo from {reports.length} report{reports.length !== 1 ? "s" : ""}…
              </div>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-5/6" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {memo && <MemoRenderer memo={memo} />}
        </div>

        {memo && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 bg-slate-50 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => { setMemo(null); setError(null) }}
            >
              Regenerate
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={copyText}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy text"}
              </Button>
              <Button
                size="sm"
                className="gap-1.5 text-xs bg-primary hover:bg-[#005a7a] text-white"
                onClick={download}
                disabled={downloading}
              >
                {downloading
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Download className="h-3.5 w-3.5" />}
                Download .docx
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
