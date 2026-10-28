/** Hygiene for the Legal Landscape feed: collapse repeats, drop developments that have gone cold. */

export type DedupableLegalItem = { title: string }

export type DatedLegalItem = { date?: string }

/**
 * The section prompts ask for the past 90 days. This is deliberately double that: the model dates
 * items imprecisely, and a bill signed at the close of a Florida legislative session stays relevant
 * well past the window. What it exists to catch is content that is not of this era at all — the
 * report that prompted it served a 2019 final rule under a 90-day heading.
 */
export const MAX_ITEM_AGE_DAYS = 180

export function normalizeTitleForKey(title: string) {
  return (title || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * One development can reach us several times over — a joint rule restated once per issuing
 * agency, or the same action surfacing in two sections. Titles are official and verbatim, so
 * they identify the development far better than the URL, which differs per agency mirror.
 * First occurrence wins, which keeps the model's own ordering.
 */
export function dedupeByTitle<T extends DedupableLegalItem>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = normalizeTitleForKey(item.title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"

/** Formats that pin a specific day. Anything vaguer is treated as no date at all — see below. */
const DAY_PRECISE_FORMATS = [
  new RegExp(`^(${MONTH})[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}$`, "i"),
  new RegExp(`^\\d{1,2}\\s+(${MONTH})[a-z]*\\.?,?\\s+\\d{4}$`, "i"),
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,
]

/**
 * The prompt asks for YYYY-MM-DD, which is parsed as UTC so the day cannot drift across timezones.
 *
 * Everything else must name a specific day to be accepted. Bare `Date.parse` is not safe here: it
 * pulls a year out of prose and pins it to January 1, so "Fall 2026" becomes 2026-01-01 — up to
 * nine months early, and early enough to get a current item withheld as stale. Returning null for
 * those is the safer failure, because an undated item is kept.
 */
export function parseItemDateToMs(date: string | undefined): number | null {
  const raw = (date || "").trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    return Number.isNaN(ms) ? null : ms
  }

  if (!DAY_PRECISE_FORMATS.some((re) => re.test(raw))) return null

  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Unlike the news feeds, a future date is not a defect here — an effective date or a scheduled
 * floor vote is precisely the "what is coming" this tab exists to show, so only the past is
 * bounded. An unparseable or absent date is kept: it cannot be shown to be stale, and dropping it
 * would let the model evade the filter by omitting the field.
 */
export function isStale(date: string | undefined, now: number, maxAgeDays = MAX_ITEM_AGE_DAYS) {
  const ms = parseItemDateToMs(date)
  if (ms === null) return false
  return now - ms > maxAgeDays * 86400000
}

export function dropStaleItems<T extends DatedLegalItem>(
  items: T[],
  now: number = Date.now(),
  maxAgeDays = MAX_ITEM_AGE_DAYS
): { kept: T[]; dropped: T[] } {
  const kept: T[] = []
  const dropped: T[] = []
  for (const item of items) {
    if (isStale(item.date, now, maxAgeDays)) dropped.push(item)
    else kept.push(item)
  }
  return { kept, dropped }
}
