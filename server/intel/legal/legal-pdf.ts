/**
 * PDF to text for the legal feed (the Florida legislature's staff analyses).
 * The tool used the pdf-parse package; here it is the same pdftotext-based
 * extractor the article digest uses, so there is one PDF path and no new
 * dependency. OCR is off: staff analyses are born-digital.
 */
import { extractTextWithFallbacks } from "../news/pdf-text-extraction.mjs"

export async function pdfToText(bytes: Uint8Array, timeoutMs = 15_000): Promise<string> {
  const result = await Promise.race([
    extractTextWithFallbacks(Buffer.from(bytes), { maxPages: 40, ocrPages: 0 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pdf text extraction timed out")), timeoutMs)),
  ])
  return String(result?.text ?? "")
}
