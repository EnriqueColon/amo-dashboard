import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const MIN_CHARS = 500

function toErrorShape(stage, err) {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error"
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : undefined
  return { stage, message, stack }
}

async function tryExec(bins, args, options) {
  let lastErr
  for (const bin of bins) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: options?.timeoutMs ?? 45_000,
        cwd: options?.cwd,
        maxBuffer: options?.maxBuffer ?? 30 * 1024 * 1024,
      })
      return { ok: true, bin, stdout: String(stdout || ""), stderr: String(stderr || "") }
    } catch (err) {
      lastErr = err
    }
  }
  return { ok: false, error: lastErr }
}

function splitPagesFromText(text) {
  // poppler's pdftotext uses form-feed between pages.
  const parts = String(text || "")
    .split("\f")
    .map((p) => p.replace(/\s+/g, " ").trim())
  // keep empty pages as empty string to preserve page count
  return parts
}

function computeCoverage(page_text, num_pages, used_ocr) {
  const pages = Array.isArray(page_text) ? page_text : []
  const computedNumPages = typeof num_pages === "number" && num_pages > 0 ? num_pages : pages.length
  const chars_per_page = []
  let pages_with_text = 0
  let total_chars = 0

  for (let i = 0; i < (pages.length || 0); i++) {
    const t = typeof pages[i] === "string" ? pages[i] : ""
    const c = t.trim().length
    chars_per_page.push(c)
    total_chars += c
    if (c > 0) pages_with_text += 1
  }

  // If we know num_pages but extracted fewer page_text entries, pad metrics.
  while (computedNumPages > chars_per_page.length) chars_per_page.push(0)

  return {
    num_pages: computedNumPages,
    pages_with_text,
    total_chars,
    chars_per_page,
    used_ocr: Boolean(used_ocr),
  }
}

async function getPdfInfo(pdfPath) {
  const bins = ["pdfinfo", "/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo", "/usr/bin/pdfinfo"]
  const res = await tryExec(bins, [pdfPath], { timeoutMs: 10_000 })
  if (!res.ok) return { num_pages: 0 }
  const m = res.stdout.match(/Pages:\s+(\d+)/i)
  const pages = m ? Number(m[1]) : 0
  return { num_pages: Number.isFinite(pages) ? pages : 0 }
}

async function extractWithPdftotext(pdfPath, maxPages) {
  const bins = ["pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"]
  const args = [
    "-layout",
    "-f",
    "1",
    "-l",
    String(Math.max(1, maxPages || 50)),
    pdfPath,
    "-", // stdout
  ]
  const res = await tryExec(bins, args, { timeoutMs: 30_000 })
  if (!res.ok) throw res.error
  const page_text = splitPagesFromText(res.stdout)
  const text = page_text.join("\n\n").trim()
  return { text, page_text, bin: res.bin }
}

async function extractWithMuTool(pdfPath, maxPages) {
  const bins = ["mutool", "/opt/homebrew/bin/mutool", "/usr/local/bin/mutool"]
  // muPDF text extraction; output is a single stream but page breaks are usually present.
  const args = ["draw", "-F", "txt", "-o", "-", "-pages", `1-${Math.max(1, maxPages || 50)}`, pdfPath]
  const res = await tryExec(bins, args, { timeoutMs: 30_000 })
  if (!res.ok) throw res.error
  const page_text = splitPagesFromText(res.stdout)
  const text = page_text.join("\n\n").trim()
  return { text, page_text, bin: res.bin }
}

async function ocrPdfFirstPages(pdfBytes, notes, maxPages) {
  // Test hook: allow deterministic OCR success in unit tests without external tools.
  if (process.env.MI_PDF_EXTRACTOR_TEST_MODE === "1" && process.env.MI_PDF_EXTRACTOR_FAKE_OCR_TEXT) {
    notes.push("OCR: using test-mode fake OCR text.")
    return String(process.env.MI_PDF_EXTRACTOR_FAKE_OCR_TEXT)
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mi-pdf-ocr-"))
  const pdfPath = path.join(tmpRoot, "input.pdf")
  const outDir = path.join(tmpRoot, "pages")
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(pdfPath, pdfBytes)

  const pdftoppmBins = ["pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm", "/usr/bin/pdftoppm"]
  const magickBins = ["magick", "/opt/homebrew/bin/magick", "/usr/local/bin/magick"]
  const tesseractBins = ["tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]

  let pngPaths = []
  const prefix = path.join(outDir, "page")

  // Convert PDF pages → PNG
  const convA = await tryExec(
    pdftoppmBins,
    ["-png", "-f", "1", "-l", String(Math.max(1, maxPages || 3)), pdfPath, prefix],
    { timeoutMs: 60_000, cwd: outDir }
  )

  if (convA.ok) {
    const entries = await fs.readdir(outDir)
    pngPaths = entries
      .filter((e) => e.toLowerCase().endsWith(".png"))
      .map((e) => path.join(outDir, e))
      .sort((a, b) => a.localeCompare(b))
    notes.push(`OCR: converted PDF → PNG via ${convA.bin}. Pages: ${pngPaths.length}.`)
  } else {
    const convB = await tryExec(
      magickBins,
      ["-density", "200", `${pdfPath}[0-${Math.max(0, (maxPages || 3) - 1)}]`, path.join(outDir, "page-%02d.png")],
      { timeoutMs: 90_000, cwd: outDir }
    )
    if (convB.ok) {
      const entries = await fs.readdir(outDir)
      pngPaths = entries
        .filter((e) => e.toLowerCase().endsWith(".png"))
        .map((e) => path.join(outDir, e))
        .sort((a, b) => a.localeCompare(b))
      notes.push(`OCR: converted PDF → PNG via ${convB.bin}. Pages: ${pngPaths.length}.`)
    } else {
      notes.push("OCR: no PDF→image tool found (pdftoppm/magick).")
      return undefined
    }
  }

  if (!pngPaths.length) {
    notes.push("OCR: conversion produced no PNG pages.")
    return undefined
  }

  const parts = []
  for (const img of pngPaths.slice(0, maxPages || 3)) {
    const r = await tryExec(tesseractBins, [img, "stdout", "-l", "eng", "--psm", "1"], { timeoutMs: 90_000 })
    if (!r.ok) {
      notes.push("OCR: tesseract not found or failed.")
      return undefined
    }
    const txt = (r.stdout || "").trim()
    if (txt) parts.push(txt)
  }
  const joined = parts.join("\n\n").trim()
  return joined || undefined
}

function likelyScannedFromCoverage(coverage) {
  if (!coverage || !coverage.num_pages) return false
  const ratio = coverage.pages_with_text / Math.max(1, coverage.num_pages)
  // "Likely scanned" only when most pages have near-zero chars.
  if (ratio > 0.2) return false
  const per = Array.isArray(coverage.chars_per_page) ? coverage.chars_per_page : []
  const nearZero = per.filter((c) => (c || 0) < 10).length
  return nearZero / Math.max(1, coverage.num_pages) >= 0.8
}

/**
 * extractTextWithFallbacks(pdfBytes, opts)
 *
 * Returns:
 * {
 *   text: string,
 *   page_text: string[],
 *   method: "engineA"|"engineB"|"ocr",
 *   coverage: {...},
 *   errors: [{stage,message,stack}]
 * }
 */
async function extractTextWithFallbacks(pdfBytes, opts) {
  const errors = []
  const notes = []
  const maxPages = typeof opts?.maxPages === "number" ? opts.maxPages : 50
  const ocrPages = typeof opts?.ocrPages === "number" ? opts.ocrPages : 3

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mi-pdf-extract-"))
  const pdfPath = path.join(tmpRoot, "input.pdf")
  await fs.writeFile(pdfPath, pdfBytes)

  const info = await getPdfInfo(pdfPath)
  const num_pages = info.num_pages || 0

  // Engine A (pdftotext)
  try {
    if (process.env.MI_PDF_EXTRACTOR_TEST_MODE === "1" && process.env.MI_PDF_EXTRACTOR_SIMULATE_ENGINEA_CRASH === "1") {
      throw new Error("Object.defineProperty called on non-object")
    }
    const a = await extractWithPdftotext(pdfPath, maxPages)
    const coverageA = computeCoverage(a.page_text, num_pages, false)
    const textA = a.text || ""
    if (coverageA.total_chars > 0) {
      return {
        text: textA,
        page_text: a.page_text,
        method: "engineA",
        coverage: coverageA,
        errors,
        notes: [`engineA: ${a.bin}`].concat(notes),
      }
    }
    notes.push("engineA extracted 0 chars.")
  } catch (err) {
    errors.push(toErrorShape("engineA", err))
  }

  // Engine B (mutool)
  try {
    if (process.env.MI_PDF_EXTRACTOR_TEST_MODE === "1" && process.env.MI_PDF_EXTRACTOR_SIMULATE_ENGINEB_CRASH === "1") {
      throw new Error("Simulated engineB crash")
    }
    const b = await extractWithMuTool(pdfPath, maxPages)
    const coverageB = computeCoverage(b.page_text, num_pages, false)
    const textB = b.text || ""
    if (coverageB.total_chars > 0) {
      return {
        text: textB,
        page_text: b.page_text,
        method: "engineB",
        coverage: coverageB,
        errors,
        notes: [`engineB: ${b.bin}`].concat(notes),
      }
    }
    notes.push("engineB extracted 0 chars.")
  } catch (err) {
    errors.push(toErrorShape("engineB", err))
  }

  // Classify / OCR decision:
  // If we extracted some pages but total chars are low, don't assume scanned. Try OCR only if very low coverage.
  const emptyCoverage = computeCoverage([], num_pages, false)
  const scanned = likelyScannedFromCoverage(emptyCoverage)
  if (!scanned && num_pages > 0) {
    // still consider OCR if we have essentially nothing
  }

  // OCR fallback
  try {
    const ocrText = await ocrPdfFirstPages(pdfBytes, notes, ocrPages)
    if (ocrText && ocrText.trim().length > 0) {
      const page_text = [ocrText]
      const coverageO = computeCoverage(page_text, num_pages || 1, true)
      return {
        text: ocrText,
        page_text,
        method: "ocr",
        coverage: coverageO,
        errors,
        notes,
      }
    }
    notes.push("ocr extracted 0 chars.")
  } catch (err) {
    errors.push(toErrorShape("ocr", err))
  }

  return {
    text: "",
    page_text: [],
    method: "engineA",
    coverage: computeCoverage([], num_pages, false),
    errors,
    notes,
  }
}

export { extractTextWithFallbacks, MIN_CHARS }

