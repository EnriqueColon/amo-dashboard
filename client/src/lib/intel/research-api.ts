import type { GeneratedMemo, ReportRow, ResearchFeedResponse, ResearchReport, StoredSummary } from "./research-types"

export type { GeneratedMemo, ReportRow, ResearchFeedResponse, ResearchReport, StoredSummary }
export type FeedResponse = ResearchFeedResponse & { archiveTotal: number }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/intel/research${path}`, { credentials: "same-origin", ...init })
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`)
  if (!body) throw new Error("Empty response.")
  return body
}
const post = <T,>(path: string, payload: unknown) =>
  call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })

export const fetchResearchFeed = () => call<FeedResponse>("/feed")
export const refreshResearchFeed = () => post<FeedResponse>("/feed/refresh", {})
export const generateResearchMemo = (reports: ResearchReport[]) => post<GeneratedMemo>("/memo", { reports })

export const listReports = (q?: string, producer?: string) => {
  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (producer) params.set("producer", producer)
  const qs = params.toString()
  return call<{ ok: true; items: ReportRow[] }>(`/reports${qs ? `?${qs}` : ""}`)
}

/** One PDF, as base64 JSON (25 MB cap enforced by the server). */
export async function uploadReport(file: File): Promise<{ ok: true; id: number; action: string; title: string; producer: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return post("/upload", { name: file.name, type: file.type, base64: btoa(binary) })
}

export const summarizeReport = (reportId: number) => post<{ ok: true; summary: StoredSummary } | { ok: false; error: string }>("/summarize", { reportId })
export const getSummary = (reportId: number) => call<{ ok: true; summary: StoredSummary }>(`/summary?reportId=${reportId}`)
export const deleteReport = (id: number) => post<{ ok: true; id: number; title: string }>("/delete", { id })
export const reportFileUrl = (id: number, download = false) => `/api/intel/research/report-file?id=${id}${download ? "&download=1" : ""}`
