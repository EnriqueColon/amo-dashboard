/**
 * SEC XBRL company facts to quarterly series.
 *
 * This is the registered tier — the vehicles that file periodic reports, and so
 * the only peers whose redemption activity, portfolio and performance are
 * observable at all. Everything else in the tracker stops at the raise.
 *
 * The work this module does is the same shape as `withQuarterlyFlows` in
 * `lib/analytics/bank-behavior.ts`: a filer reports flows year-to-date, and the
 * quarter's own figure is the difference from the previous period, with a gap
 * leaving a null rather than a guess. Three things differ from the Call Report
 * case and each one is a trap:
 *
 * 1. **Fiscal years are not all calendar years.** Rather than keying on
 *    calendar quarters, the YTD facts of one fiscal year are grouped by their
 *    shared `start` date, which is the fiscal-year start by construction. A
 *    June-year-end filer groups on 07-01 and differences correctly with no
 *    special case.
 *
 * 2. **Prior-year comparatives are repeated.** A 10-Q restates the equivalent
 *    period of the prior year, so the same `(start, end)` appears under several
 *    `fy`/`fp` values and accessions — Blue Owl's 2023 full year appears in
 *    three different 10-Ks. Deduped on `(start, end)`.
 *
 * 3. **Instant and duration facts are different animals.** A balance
 *    (investments at fair value, NAV per share) carries only `end` and needs no
 *    differencing; a flow carries `start` and `end` and does. The concept
 *    registry declares which, because guessing from the presence of `start`
 *    works until a filer omits it.
 *
 * Dollar figures are in dollars, as the filer tags them.
 */

export type XbrlFact = {
  /** Absent on an instant fact. */
  start?: string
  end: string
  val: number
  form?: string
  filed?: string
  accn?: string
  fy?: number
  fp?: string
}

export type ConceptBasis = "duration" | "instant"

/**
 * A metric and the concepts that might carry it.
 *
 * Coverage across the registered tier is patchy — measured 2026-10-21 over the
 * twelve vehicles in the registry — so each metric lists candidates in
 * preference order and the first that resolves wins. Filers also use
 * company-specific extension tags in their own namespace, which
 * `companyconcept` under `us-gaap` cannot see at all; a metric simply comes
 * back absent for those, which is why nothing here may assume availability.
 */
export type MetricSpec = {
  key: string
  label: string
  basis: ConceptBasis
  /** `[taxonomy, concept]` pairs, tried in order. */
  candidates: ReadonlyArray<readonly [string, string]>
  /** How many of the twelve registered vehicles carried it at the audit. */
  coverage: string
  note?: string
}

export const PEER_METRICS: readonly MetricSpec[] = [
  {
    key: "subscriptions",
    label: "Capital in (share issuance)",
    basis: "duration",
    candidates: [["us-gaap", "ProceedsFromIssuanceOfCommonStock"]],
    coverage: "12/12",
    note: "The only metric every registered vehicle tags. Subscriptions into a semi-liquid vehicle; for a listed REIT it is ordinary equity issuance instead, so the two are not the same thing and are not compared across kinds.",
  },
  {
    key: "repurchases",
    label: "Capital out (share repurchases)",
    basis: "duration",
    candidates: [["us-gaap", "PaymentsForRepurchaseOfCommonStock"]],
    coverage: "11/12",
    note: "For a non-traded BDC or REIT this is the redemption programme paying investors out — the liquidity signal the brief asks for. For a listed company it is a buyback, which means close to the opposite.",
  },
  {
    key: "investmentsAtFairValue",
    label: "Investments at fair value",
    basis: "instant",
    candidates: [["us-gaap", "InvestmentOwnedAtFairValue"]],
    coverage: "6/12",
  },
  {
    key: "investmentIncome",
    label: "Investment income",
    basis: "duration",
    candidates: [
      ["us-gaap", "GrossInvestmentIncomeOperating"],
      ["us-gaap", "InvestmentIncomeInterest"],
    ],
    coverage: "9/12 across both candidates",
  },
  {
    key: "netInvestmentIncome",
    label: "Net investment income",
    basis: "duration",
    candidates: [["us-gaap", "NetInvestmentIncome"]],
    coverage: "6/12",
  },
  {
    key: "pikIncome",
    label: "Payment-in-kind income",
    basis: "duration",
    candidates: [["us-gaap", "InterestAndDividendIncomeOperatingPaidInKind"]],
    coverage: "2/12",
    note: "Rising PIK is a classic sign that borrowers cannot pay cash, but only two of the twelve vehicles tag it in us-gaap. The signal is therefore reported where available and absent elsewhere — never inferred.",
  },
  {
    key: "unrealizedGainLoss",
    label: "Unrealised gain / (loss) on investments",
    basis: "duration",
    candidates: [["us-gaap", "UnrealizedGainLossOnInvestments"]],
    coverage: "7/12",
  },
  {
    key: "navPerShare",
    label: "Net asset value per share",
    basis: "instant",
    candidates: [["us-gaap", "NetAssetValuePerShare"]],
    coverage: "5/12",
  },
]

export function metricSpec(key: string): MetricSpec | undefined {
  return PEER_METRICS.find((m) => m.key === key)
}

type ConceptResponse = {
  units?: Record<string, Array<Record<string, unknown>>>
}

/** Prefer plain USD, then per-share USD, then whatever single unit exists. */
function pickUnit(units: Record<string, Array<Record<string, unknown>>>): string | null {
  const keys = Object.keys(units)
  if (!keys.length) return null
  return keys.find((k) => k === "USD") ?? keys.find((k) => k.startsWith("USD")) ?? keys[0]
}

export function parseConceptFacts(json: unknown): { unit: string; facts: XbrlFact[] } | null {
  const units = (json as ConceptResponse)?.units
  if (!units) return null
  const unit = pickUnit(units)
  if (!unit) return null
  const facts: XbrlFact[] = []
  for (const row of units[unit]) {
    const end = typeof row.end === "string" ? row.end : null
    const val = typeof row.val === "number" ? row.val : null
    if (!end || val == null) continue
    facts.push({
      ...(typeof row.start === "string" ? { start: row.start } : {}),
      end,
      val,
      ...(typeof row.form === "string" ? { form: row.form } : {}),
      ...(typeof row.filed === "string" ? { filed: row.filed } : {}),
      ...(typeof row.accn === "string" ? { accn: row.accn } : {}),
      ...(typeof row.fy === "number" ? { fy: row.fy } : {}),
      ...(typeof row.fp === "string" ? { fp: row.fp } : {}),
    })
  }
  return { unit, facts }
}

export type DedupedFact = XbrlFact & {
  /**
   * True when another filing reported a different value for the same period.
   * The latest filing wins — a restatement is the better number — but the
   * disagreement is itself worth surfacing rather than silently resolving.
   */
  restated?: boolean
}

/**
 * One fact per period, latest filing winning.
 *
 * The same period is reported many times: as the current period, then as a
 * comparative in each of the next year's filings. Those repeats normally carry
 * an identical value, so which one wins does not matter — until a filer
 * restates, and then the most recently filed figure is the correct one.
 */
export function dedupeFacts(facts: readonly XbrlFact[]): DedupedFact[] {
  const byPeriod = new Map<string, DedupedFact>()
  for (const fact of facts) {
    const key = `${fact.start ?? ""}|${fact.end}`
    const held = byPeriod.get(key)
    if (!held) {
      byPeriod.set(key, { ...fact })
      continue
    }
    const differs = held.val !== fact.val
    const newer = (fact.filed ?? "") > (held.filed ?? "")
    const winner = newer ? { ...fact } : held
    byPeriod.set(key, { ...winner, ...(differs || held.restated ? { restated: true } : {}) })
  }
  return [...byPeriod.values()].sort((a, b) =>
    a.end < b.end ? -1 : a.end > b.end ? 1 : (a.start ?? "") < (b.start ?? "") ? -1 : 1
  )
}

/** Inclusive day count between two ISO dates, UTC so no timezone can shift it. */
function spanDays(from: string, to: string): number {
  const a = Date.UTC(...(from.split("-").map(Number) as [number, number, number]))
  const b = Date.UTC(...(to.split("-").map(Number) as [number, number, number]))
  return Math.round((b - a) / 86_400_000) + 1
}

/** A quarter averages 91.3 days, so the span rounds cleanly to a period count. */
const DAYS_PER_QUARTER = 91.3

/**
 * How many quarters a duration fact covers: 1 for a standalone quarter, 2 for a
 * half year, 4 for a full year.
 *
 * Measured in days rather than calendar months because a quarter's months do
 * not line up — 2026-04-01 to 2026-06-30 is two calendar-month boundaries but
 * three months of activity, and treating it as two put a quarterly fact into
 * the year-to-date series.
 */
function spanQuarters(from: string, to: string): number {
  return Math.max(1, Math.round(spanDays(from, to) / DAYS_PER_QUARTER))
}

export type QuarterPoint = {
  /** Period end, `YYYY-MM-DD`. */
  end: string
  /** Calendar label — `Q2 2026` — so periods line up across filers with different fiscal years. */
  label: string
  /**
   * The quarter's own value. `null` means not derivable, never zero: either the
   * period was not reported or the preceding year-to-date figure it would be
   * differenced against is missing.
   */
  value: number | null
  /** For a duration metric, the year-to-date figure this was derived from. */
  ytd?: number | null
  /** Position in the filer's fiscal year, 1-4. */
  fiscalQuarter?: number
  /**
   * `reported` when the filer tagged this quarter directly; `derived` when it
   * was differenced out of year-to-date figures. Reported always wins, and the
   * distinction belongs on screen for the same reason the Call Report
   * catalogue marks derived fields.
   */
  origin?: "reported" | "derived"
  restated?: boolean
}

function quarterLabel(end: string): string {
  const [y, m] = end.split("-").map(Number)
  return `Q${Math.min(4, Math.ceil(m / 3))} ${y}`
}

/**
 * Year-to-date duration facts to each quarter's own figure.
 *
 * Facts are grouped by their shared `start`, which is the fiscal-year start, so
 * a non-calendar filer needs no special handling. Within a year, position is
 * taken from the months elapsed rather than from `fp`, because `fp` describes
 * the *filing* and a comparative carries the filing's label, not the period's.
 *
 * The first quarter of a year is the year-to-date figure itself. Any later
 * quarter is the difference from the preceding one, and is **null when that
 * preceding period is absent** — a 10-K filed without the Q3 10-Q leaves Q4
 * unknown rather than carrying three quarters of flow into one bar. The same
 * rule as `withQuarterlyFlows`, for the same reason.
 */
export function durationToQuarters(facts: readonly XbrlFact[]): QuarterPoint[] {
  const deduped = dedupeFacts(facts.filter((f) => f.start))

  // Filers tag both forms for the same period: Blue Owl's Q2 2026 investment
  // income appears as a 181-day year-to-date figure and again as a 91-day
  // quarter, and the two reconcile. Taking both put two points on one period.
  // The directly reported quarter wins — it is reported rather than derived.
  const reported = new Map<string, QuarterPoint>()
  const cumulative: DedupedFact[] = []
  for (const fact of deduped) {
    if (spanQuarters(fact.start!, fact.end) === 1) {
      if (!reported.has(fact.end)) {
        reported.set(fact.end, {
          end: fact.end,
          label: quarterLabel(fact.end),
          value: fact.val,
          origin: "reported",
          ...(fact.restated ? { restated: true } : {}),
        })
      }
    } else {
      cumulative.push(fact)
    }
  }

  // Year-to-date facts of one fiscal year share a `start`, which is the fiscal
  // year start by construction — so a non-calendar filer needs no special case.
  const byYearStart = new Map<string, DedupedFact[]>()
  for (const fact of cumulative) {
    const list = byYearStart.get(fact.start!) ?? []
    list.push(fact)
    byYearStart.set(fact.start!, list)
  }

  const derived = new Map<string, QuarterPoint>()
  for (const [start, group] of byYearStart) {
    const byIndex = new Map<number, DedupedFact>()
    for (const fact of group) {
      const index = spanQuarters(start, fact.end)
      if (index >= 2 && index <= 4 && !byIndex.has(index)) byIndex.set(index, fact)
    }
    for (const [index, fact] of byIndex) {
      // The preceding period is either another cumulative fact or, for index 2,
      // the first quarter — which the filer may have tagged as a standalone
      // quarter rather than as a one-quarter year-to-date figure.
      const priorFact = byIndex.get(index - 1)
      const priorValue =
        priorFact?.val ??
        (index === 2 ? reported.get(previousQuarterEndOf(group, start, index))?.value ?? null : null)
      derived.set(fact.end, {
        end: fact.end,
        label: quarterLabel(fact.end),
        value: priorValue == null ? null : fact.val - priorValue,
        ytd: fact.val,
        fiscalQuarter: index,
        origin: "derived",
        ...(fact.restated || priorFact?.restated ? { restated: true } : {}),
      })
    }
  }

  const merged = new Map(derived)
  for (const [end, point] of reported) merged.set(end, point)
  return [...merged.values()].sort((a, b) => (a.end < b.end ? -1 : 1))
}

/**
 * The end date of the quarter before a cumulative fact at `index`, used only to
 * find a directly reported first quarter to difference against.
 *
 * Derived from the fiscal year start rather than from calendar arithmetic, so a
 * non-calendar filer resolves correctly.
 */
function previousQuarterEndOf(group: readonly DedupedFact[], start: string, index: number): string {
  const target = index - 1
  const match = group.find((f) => spanQuarters(start, f.end) === target)
  if (match) return match.end
  // No cumulative fact at that index: step back one quarter from the fiscal
  // year start, which for index 2 is the first quarter end.
  const [y, m, d] = start.split("-").map(Number)
  const endMonth = m + 3 * target - 1
  const year = y + Math.floor((endMonth - 1) / 12)
  const month = ((endMonth - 1) % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, "0")}-${String(d === 1 ? lastDay : lastDay).padStart(2, "0")}`
}

/** Instant facts need no differencing — the balance is the figure. */
export function instantToQuarters(facts: readonly XbrlFact[]): QuarterPoint[] {
  return dedupeFacts(facts.filter((f) => !f.start)).map((fact) => ({
    end: fact.end,
    label: quarterLabel(fact.end),
    value: fact.val,
    origin: "reported",
    ...(fact.restated ? { restated: true } : {}),
  }))
}

export function toQuarters(basis: ConceptBasis, facts: readonly XbrlFact[]): QuarterPoint[] {
  return basis === "duration" ? durationToQuarters(facts) : instantToQuarters(facts)
}

/** The newest `count` points, oldest first. */
export function trailingQuarters(points: readonly QuarterPoint[], count: number): QuarterPoint[] {
  return points.slice(-count)
}

export function pointAt(points: readonly QuarterPoint[], end: string): QuarterPoint | undefined {
  return points.find((p) => p.end === end)
}

/**
 * Capital in less capital out, per quarter.
 *
 * The one figure the brief's "evergreen fund liquidity" ask really wants, and
 * the only one derivable for nearly every registered vehicle: subscriptions and
 * repurchases are the two most widely tagged concepts in the tier. A quarter is
 * null unless both sides are known, so a net flow is never half a picture.
 */
export function netFlow(
  subscriptions: readonly QuarterPoint[],
  repurchases: readonly QuarterPoint[]
): QuarterPoint[] {
  const out: QuarterPoint[] = []
  const outByEnd = new Map(repurchases.map((p) => [p.end, p]))
  for (const sub of subscriptions) {
    const rep = outByEnd.get(sub.end)
    const value = sub.value != null && rep?.value != null ? sub.value - rep.value : null
    out.push({
      end: sub.end,
      label: sub.label,
      value,
      ...(sub.fiscalQuarter ? { fiscalQuarter: sub.fiscalQuarter } : {}),
      ...(sub.restated || rep?.restated ? { restated: true } : {}),
    })
  }
  return out
}
