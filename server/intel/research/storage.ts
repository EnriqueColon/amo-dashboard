/**
 * Uploaded research PDFs on disk. The tool kept them in Vercel Blob (later a
 * folder on the bridge copy); here they live under REPORT_STORAGE_DIR —
 * by default `research_uploads/` beside the AMO database — and a report's
 * document_url records them as "local-report://<relative path>". The nightly
 * backup copies the folder (collector/run_mi_backup.sh → run_backup.sh).
 */
import { promises as fs } from "fs"
import path from "path"

export const LOCAL_REPORT_URL_PREFIX = "local-report://"

export function isLocalReportUrl(url: string): boolean {
  return url.startsWith(LOCAL_REPORT_URL_PREFIX)
}

export function storageDir(): string {
  const configured = (process.env.REPORT_STORAGE_DIR ?? "").trim()
  if (configured) return path.resolve(configured)
  const amo = (process.env.AMO_DB_PATH ?? "").trim()
  const base = amo ? path.dirname(path.resolve(amo)) : process.cwd()
  return path.join(base, "research_uploads")
}

function safeSegment(segment: string): string {
  return segment.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").replace(/^\.+/, "")
}

export function safeRelativePath(pathname: string): string {
  const segments = pathname
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter((s) => s && s !== "." && s !== "..")
  if (segments.length === 0) return `report-${Date.now()}.pdf`
  const last = segments[segments.length - 1]
  if (!last.endsWith(".pdf")) segments[segments.length - 1] = `${last}.pdf`
  return segments.join("/")
}

function absolutePathFor(relative: string): string {
  const root = storageDir()
  const abs = path.resolve(root, relative)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Report path escapes the storage folder.")
  return abs
}

export async function saveReportToDisk(pathname: string, bytes: Buffer): Promise<{ url: string; pathname: string }> {
  const relative = safeRelativePath(pathname)
  const abs = absolutePathFor(relative)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, bytes)
  return { url: `${LOCAL_REPORT_URL_PREFIX}${relative}`, pathname: relative }
}

export async function readLocalReport(url: string): Promise<Buffer | null> {
  if (!isLocalReportUrl(url)) return null
  try {
    return await fs.readFile(absolutePathFor(url.slice(LOCAL_REPORT_URL_PREFIX.length)))
  } catch {
    return null
  }
}

export async function deleteLocalReport(url: string): Promise<boolean> {
  if (!isLocalReportUrl(url)) return false
  try {
    await fs.unlink(absolutePathFor(url.slice(LOCAL_REPORT_URL_PREFIX.length)))
    return true
  } catch {
    return false
  }
}
