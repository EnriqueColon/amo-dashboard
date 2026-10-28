/**
 * Measured market figures for the industry outlook memo.
 *
 * Key Signals is the memo's Executive Summary, and it used to be barred from
 * carrying any figure at all — the only way to stop the model inventing one.
 * That kept it accurate and left it saying nothing.
 *
 * This module supplies the alternative: a small set of figures the app measures
 * itself, from FRED's public CSV endpoint and FDIC call reports. A number that
 * arrives this way cannot be fabricated — no model sees it before it is
 * formatted — so it is safe to print in the summary, and it gives the model
 * ground truth to write against instead of half-remembered statistics.
 *
 * Everything here is parsing and formatting only: no network calls, no Next.js
 * imports. Fetching lives in app/services/industry-outlook/verifiedMetrics.ts,
 * so this file stays unit testable with
 * `node --test --experimental-strip-types lib/verified-metrics.test.ts`.
 */

export type SeriesFrequency = "daily" | "weekly" | "monthly" | "quarterly"

/**
 * How a series' value reads, which also decides how its change is expressed.
 *
 * `net-percent` is separate from `percent` on purpose. Both print as "4.40%",
 * but a survey diffusion index is a share of respondents rather than a price,
 * so its moves belong in percentage points; describing one in basis points
 * would dress a survey result up as a rate.
 */
export type SeriesUnit =
  | "percent"
  | "net-percent"
  | "usd-billions"
  | "usd-millions"
  | "index"
  | "units-thousands"

export type FredSeriesSpec = {
  id: string
  /** Sentence subject, e.g. "The delinquency rate on CRE loans at U.S. banks". */
  subject: string
  unit: SeriesUnit
  frequency: SeriesFrequency
  /** Publisher credited for the underlying data, not FRED, which redistributes it. */
  publisher: string
  /** Set for a plural subject, so the sentence reads "were" instead of "was". */
  plural?: boolean
  /** Appended verbatim when present, for context a bare number does not carry. */
  note?: string
}

/**
 * The series the memo is anchored on: CRE credit quality first, then the
 * financing and risk-appetite benchmarks that drive distressed pricing.
 *
 * Every id here was verified against the live endpoint. `CABOREA`, named in
 * lib/fred-constants.ts as the CRE charge-off series, is not a real series id
 * and returns an error page; `CORCREXFACBS` is the one that resolves.
 */
export const FRED_VERIFIED_SERIES: FredSeriesSpec[] = [
  {
    id: "DRCRELEXFACBS",
    subject: "The delinquency rate on commercial real estate loans (excluding farmland) at U.S. commercial banks",
    unit: "percent",
    frequency: "quarterly",
    publisher: "Federal Reserve Board",
  },
  {
    id: "CORCREXFACBS",
    subject: "The net charge-off rate on commercial real estate loans (excluding farmland) at U.S. commercial banks",
    unit: "percent",
    frequency: "quarterly",
    publisher: "Federal Reserve Board",
  },
  {
    id: "CREACBM027NBOG",
    subject: "Commercial real estate loans outstanding at all U.S. commercial banks",
    unit: "usd-billions",
    frequency: "monthly",
    publisher: "Federal Reserve Board H.8",
    plural: true,
  },
  {
    id: "DGS10",
    subject: "The 10-year Treasury yield",
    unit: "percent",
    frequency: "daily",
    publisher: "U.S. Treasury",
    note: "the benchmark most CRE debt is priced off",
  },
  {
    id: "MORTGAGE30US",
    subject: "The average 30-year fixed mortgage rate",
    unit: "percent",
    frequency: "weekly",
    publisher: "Freddie Mac",
  },
  {
    id: "BAMLH0A0HYM2",
    subject: "The ICE BofA U.S. high-yield option-adjusted spread",
    unit: "percent",
    frequency: "daily",
    publisher: "ICE Data Indices",
    note: "a proxy for how much compensation credit investors are demanding for risk",
  },
]

export type Observation = { date: string; value: number }

/**
 * FRED's CSV is "observation_date,SERIESID" plus one row per period. Missing
 * periods are a bare "." (market holidays in the daily series), which parse to
 * NaN and would otherwise be printed as a figure.
 */
export function parseFredCsv(csv: string): Observation[] {
  const out: Observation[] = []
  const lines = csv.trim().split(/\r?\n/)
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(",")
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue
    const value = Number((raw || "").trim())
    if (!Number.isFinite(value)) continue
    out.push({ date: date.trim(), value })
  }
  return out
}

export type SeriesWindow = {
  latest: Observation
  /** The period immediately before `latest`, for a sequential change. */
  prior?: Observation
  /** Closest observation to one year before `latest`, for a year-over-year change. */
  yearAgo?: Observation
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000
}

/**
 * Picks the reference points for one series. Rows are assumed ascending, which
 * is how the CSV arrives. The year-ago pick is nearest-match rather than a
 * fixed offset so it works for every frequency, and is rejected when nothing
 * lands within a quarter of the target — a stale series must not be described
 * as a year-over-year move.
 */
export function selectWindow(rows: Observation[]): SeriesWindow | null {
  if (rows.length === 0) return null
  const latest = rows[rows.length - 1]
  const prior = rows.length > 1 ? rows[rows.length - 2] : undefined

  const targetYearAgo = new Date(Date.parse(latest.date + "T00:00:00Z"))
  targetYearAgo.setUTCFullYear(targetYearAgo.getUTCFullYear() - 1)
  const target = targetYearAgo.toISOString().slice(0, 10)

  let yearAgo: Observation | undefined
  let bestGap = Infinity
  for (const row of rows) {
    if (row === latest) continue
    const gap = daysBetween(row.date, target)
    if (gap < bestGap) {
      bestGap = gap
      yearAgo = row
    }
  }
  if (bestGap > 92) yearAgo = undefined

  return { latest, prior, yearAgo }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/**
 * How a period reads in the memo. Parsed by hand rather than through Date so a
 * "2026-01-01" observation cannot shift to December 31 in a western timezone.
 *
 * FRED dates a period by its first day, so the quarterly and monthly labels
 * describe the period the observation covers, not the timestamp itself.
 */
export function periodLabel(date: string, frequency: SeriesFrequency): string {
  const [yearStr, monthStr, dayStr] = date.split("-")
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)

  switch (frequency) {
    case "quarterly":
      return `Q${Math.floor((month - 1) / 3) + 1} ${year}`
    case "monthly":
      return `${MONTHS[month - 1]} ${year}`
    case "weekly":
      return `the week ended ${MONTHS[month - 1]} ${day}, ${year}`
    default:
      return `${MONTHS[month - 1]} ${day}, ${year}`
  }
}

/** Two decimals, trailing zeros kept: rates move in hundredths and 1.6% hides that. */
export function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`
}

/** FRED reports these levels in billions; trillions is how the market says it. */
export function formatUsdFromBillions(value: number): string {
  return value >= 1000
    ? `$${(value / 1000).toFixed(2)} trillion`
    : `$${value.toFixed(1)} billion`
}

/** FRED counts starts and permits in thousands of units, at an annual rate. */
export function formatUnitsFromThousands(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}M units` : `${Math.round(value)}k units`
}

export function formatValue(value: number, unit: SeriesUnit): string {
  switch (unit) {
    case "percent":
    case "net-percent":
      return formatPercent(value)
    case "usd-billions":
      return formatUsdFromBillions(value)
    case "usd-millions":
      return formatUsdFromBillions(value / 1000)
    case "units-thousands":
      return formatUnitsFromThousands(value)
    case "index":
      return value.toFixed(1)
  }
}

/**
 * A rate change in basis points, which is how a 0.02 move is actually
 * discussed. Returns null when the move rounds to nothing, so the sentence can
 * omit the comparison rather than claim it moved "0 bps".
 */
export function describeRateChange(latest: number, prior: number): string | null {
  const bps = Math.round((latest - prior) * 100)
  if (bps === 0) return null
  const magnitude = Math.abs(bps)
  return `${bps > 0 ? "up" : "down"} ${magnitude} ${magnitude === 1 ? "bp" : "bps"}`
}

export function describeLevelChange(latest: number, prior: number): string | null {
  if (prior === 0) return null
  const pct = ((latest - prior) / prior) * 100
  if (Math.abs(pct) < 0.05) return null
  return `${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`
}

/**
 * A move in percentage points, for a figure that is a share of something
 * counted rather than a rate.
 *
 * The lending-standards series is the case that forces this. It is a net
 * percentage of surveyed banks, and it sits near zero, so both of the other
 * treatments mislead: basis points would report a swing from 0.0 to 4.4 as "up
 * 440 bps", and a proportional change would divide by a base that is routinely
 * zero or negative.
 */
export function describePointChange(latest: number, prior: number): string | null {
  const points = Number((latest - prior).toFixed(1))
  if (points === 0) return null
  return `${points > 0 ? "up" : "down"} ${Math.abs(points).toFixed(1)} pp`
}

export function describeChange(latest: number, prior: number, unit: SeriesUnit): string | null {
  switch (unit) {
    case "percent":
      return describeRateChange(latest, prior)
    case "net-percent":
      return describePointChange(latest, prior)
    default:
      return describeLevelChange(latest, prior)
  }
}

export type VerifiedMetric = {
  /** Stable identifier, for logging and de-duplication. */
  id: string
  /** The figure on its own, used to detect that the model already stated it. */
  value: string
  /** Period the figure describes, e.g. "Q1 2026". */
  asOf: string
  /** Complete, attributed sentence — printable as a Key Signals bullet as-is. */
  sentence: string
}

/**
 * One measured figure as a finished sentence, carrying its own attribution and
 * as-of period. Written as a full sentence rather than a label/value pair
 * because it has to survive as a memo bullet without further editing.
 */
export function buildFredMetric(spec: FredSeriesSpec, window: SeriesWindow): VerifiedMetric {
  const { latest, prior, yearAgo } = window
  const value = formatValue(latest.value, spec.unit)
  const asOf = periodLabel(latest.date, spec.frequency)

  const movements: string[] = []
  const sequential = prior ? describeChange(latest.value, prior.value, spec.unit) : null
  if (sequential && prior) {
    // A period label reads naturally for a quarter or month ("from Q4 2025");
    // for a daily or weekly series the previous date carries no meaning to a
    // reader, so the comparison is named instead.
    const from =
      spec.frequency === "quarterly" || spec.frequency === "monthly"
        ? `from ${periodLabel(prior.date, spec.frequency)}`
        : spec.frequency === "weekly"
          ? "from the prior week"
          : "from the prior session"
    movements.push(`${sequential} ${from}`)
  }
  const annual = yearAgo ? describeChange(latest.value, yearAgo.value, spec.unit) : null
  if (annual) movements.push(`${annual} year over year`)

  const movement = movements.length ? `, ${movements.join(" and ")}` : ""
  const note = spec.note ? ` — ${spec.note}` : ""
  const attribution = `(${spec.publisher} via FRED series ${spec.id}, ${asOf})`
  // "on August 14, 2026" but "in Q1 2026" / "in the week ended August 13, 2026".
  const preposition = spec.frequency === "daily" ? "on" : "in"
  const verb = spec.plural ? "were" : "was"

  return {
    id: spec.id,
    value,
    asOf,
    sentence: `${spec.subject} ${verb} ${value} ${preposition} ${asOf}${movement}${note}. ${attribution}`,
  }
}

export type FdicCohort = {
  /** State cohort the figures describe, e.g. "Florida". */
  scope: string
  institutions: number
  /** Sum of CRE loan balances across the cohort, in dollars. */
  creLoans: number
  /** Cohort CRE loans as a share of total loans, in percent points. */
  creConcentration: number
  /** Dollar-weighted noncurrent loans to gross loans, in percent points. */
  noncurrentRatio: number
  /** FDIC reporting period, e.g. "Q1 2026". */
  asOf: string
}

function formatUsdFromDollars(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)} trillion`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)} billion`
  return `$${(value / 1e6).toFixed(0)} million`
}

/**
 * The cohort figures as one sentence. This is the only number in the memo the
 * app computes from primary filings rather than reading off a publication,
 * which is exactly why it belongs in Key Signals: it is unfalsifiable here and
 * unavailable to anything the model could search.
 */
export function buildFdicMetric(cohort: FdicCohort): VerifiedMetric {
  const balance = formatUsdFromDollars(cohort.creLoans)
  return {
    id: `fdic-${cohort.scope.toLowerCase()}-cre`,
    value: balance,
    asOf: cohort.asOf,
    sentence:
      `${cohort.scope}-headquartered banks held ${balance} of CRE loans as of ${cohort.asOf}, ` +
      `equal to ${cohort.creConcentration.toFixed(1)}% of their total loans, with noncurrent loans at ` +
      `${cohort.noncurrentRatio.toFixed(2)}% of gross loans across ${cohort.institutions} reporting institutions. ` +
      `(FDIC call reports, ${cohort.asOf})`,
  }
}

/** FDIC dates a report by period end: "20260331" is Q1 2026. */
export function fdicQuarterLabel(reportDate: string): string {
  if (!/^\d{8}$/.test(reportDate)) return reportDate
  const year = reportDate.slice(0, 4)
  const month = Number(reportDate.slice(4, 6))
  return `Q${Math.ceil(month / 3)} ${year}`
}

/**
 * The block handed to the model. Labelled as measured rather than searched
 * because the prompt's evidence rules turn on that distinction: these are the
 * figures it may state without finding a source for them.
 */
export function formatVerifiedDataBlock(metrics: VerifiedMetric[]): string {
  if (metrics.length === 0) return ""
  return [
    "VERIFIED MARKET DATA — measured by this system directly from FRED and FDIC filings, not from a search.",
    "These figures are correct as written. Quote them verbatim, keep their attribution and as-of period,",
    "and never adjust, round, extrapolate or update them:",
    ...metrics.map((m) => `- ${m.sentence}`),
  ].join("\n")
}
