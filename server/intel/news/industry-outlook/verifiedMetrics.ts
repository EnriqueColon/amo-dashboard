import { unstable_cache } from "../../cache-shim"
import { floridaCohortFromBankStressDb } from "./florida-cohort"
import { newsCalendarDayET, NEWS_TAB_REVALIDATE_SECONDS } from "@shared/news/news-tab-cache"
import {
  buildFdicMetric,
  buildFredMetric,
  fdicQuarterLabel,
  FRED_VERIFIED_SERIES,
  parseFredCsv,
  selectWindow,
  type FdicCohort,
  type FredSeriesSpec,
  type VerifiedMetric,
} from "../verified-metrics"

/**
 * Collects the measured figures the outlook memo is anchored on.
 *
 * Both sources are deliberately keyless: FRED's public CSV endpoint needs no
 * API key (unlike the FRED_API_KEY paths elsewhere in the app, which are dead
 * without a key that is not configured), and the FDIC API accepts anonymous
 * requests. This has to keep working in production without new credentials.
 *
 * Nothing here is allowed to take the memo down. Every fetch is individually
 * time-boxed and a failed source is simply absent from the result.
 */

const FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv"
const FRED_TIMEOUT_MS = 6_000
const FDIC_TIMEOUT_MS = 9_000

/** Three years of history: enough for a year-over-year read on a quarterly series. */
function observationStart(): string {
  const start = new Date()
  start.setFullYear(start.getFullYear() - 3)
  return start.toISOString().slice(0, 10)
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/csv,*/*" },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchFredMetric(spec: FredSeriesSpec): Promise<VerifiedMetric | null> {
  try {
    const url = `${FRED_CSV_BASE}?id=${encodeURIComponent(spec.id)}&cosd=${observationStart()}`
    const res = await fetchWithTimeout(url, FRED_TIMEOUT_MS)
    if (!res.ok) {
      console.warn(`verified-metrics: FRED ${spec.id} returned ${res.status}`)
      return null
    }
    const window = selectWindow(parseFredCsv(await res.text()))
    if (!window) {
      console.warn(`verified-metrics: FRED ${spec.id} returned no usable observations`)
      return null
    }
    return buildFredMetric(spec, window)
  } catch (err) {
    console.warn(`verified-metrics: FRED ${spec.id} failed:`, err)
    return null
  }
}

/**
 * The Florida bank cohort, from this dashboard's weekly FDIC pull
 * (bank_stress.db) rather than the tool's live FDIC request — see
 * ./florida-cohort.ts for the aggregation.
 */
async function fetchFloridaMetric(): Promise<VerifiedMetric | null> {
  try {
    const cohort = floridaCohortFromBankStressDb()
    if (!cohort) {
      console.warn("verified-metrics: bank_stress.db has no Florida rows")
      return null
    }
    return buildFdicMetric(cohort)
  } catch (err) {
    console.warn("verified-metrics: Florida cohort failed:", err)
    return null
  }
}

async function collectVerifiedMetrics(): Promise<VerifiedMetric[]> {
  const results = await Promise.all([
    ...FRED_VERIFIED_SERIES.map((spec) => fetchFredMetric(spec)),
    fetchFloridaMetric(),
  ])
  const metrics = results.filter((m): m is VerifiedMetric => m !== null)
  console.info(
    `verified-metrics: resolved ${metrics.length}/${FRED_VERIFIED_SERIES.length + 1} sources`,
    metrics.map((m) => `${m.id}=${m.value}@${m.asOf}`).join(" ")
  )
  return metrics
}

/**
 * The measured figures for today, cached alongside the memo that uses them.
 *
 * An empty result throws inside the cached function so a bad fetch window is
 * never cached for the rest of the day; the caller treats absence as "generate
 * without measured data" rather than as an error.
 */
export async function getVerifiedMetrics(): Promise<VerifiedMetric[]> {
  const cached = unstable_cache(
    async () => {
      const metrics = await collectVerifiedMetrics()
      if (metrics.length === 0) throw new Error("No verified metrics available")
      return metrics
    },
    ["industry-outlook-verified-metrics-v1", newsCalendarDayET()],
    { revalidate: NEWS_TAB_REVALIDATE_SECONDS }
  )

  try {
    return await cached()
  } catch (err) {
    console.error("verified-metrics: unavailable for this run:", err)
    return []
  }
}
