// The extractor is plain JavaScript (carried over from the tool); its result
// shape is defined by the caller's cast in fetch-article-digest.ts.
export const MIN_CHARS: number
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTextWithFallbacks(bytes: Buffer, opts?: { maxPages?: number; ocrPages?: number }): Promise<any>
