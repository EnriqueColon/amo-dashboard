/**
 * Vintage pacing: how each fund in a manager's series raised, side by side.
 *
 * A manager launches funds in sequence, and the question an LP — or the
 * manager's own board — asks is whether the newest one is raising faster or
 * slower than the ones before it. Preqin answers it with "funds in market" and
 * interim closes; nothing answers it for a sub-$500M regional manager. But the
 * data is already here: a fund must amend its Form D each time it takes money,
 * and every amendment states the cumulative amount sold. So a filing trail *is*
 * a fundraising curve, and lining the trails up by months-since-first-sale
 * rather than by calendar date puts every vintage on the same axes.
 *
 * Safe Harbor's own ladder, which this module is tested against, is the proof:
 * Fund 4 at month 28 had raised $64.2M against Fund 3's $61.7M at month 40 —
 * the same dollar pace, slightly ahead, against an offering that tripled.
 * That is the story behind the $500M → $300M cut.
 *
 * **Three decisions that shape everything here.**
 *
 * Vintages are ordered by **start date, never by name**. "Fund VI" is a name
 * the manager chose; "Fund 1" may be the newest. The ordinal is derived.
 *
 * **Sleeves are left out.** A feeder's capital is part of its parent raise,
 * but the registry holds no parent link, so a sleeve plotted on its own would
 * read as a small fund rather than part of a large one. Their count is
 * reported so the panel can say what was omitted.
 *
 * **Interpolation is stated, never hidden.** Trails are sparse — two to five
 * points, and Fund 2 has two points 71 months apart — so "where the prior fund
 * was at month 28" is usually a figure between two filings. The comparison
 * says which filings it sits between, and the reading repeats it.
 *
 * Pure: a manager's raises in, curves and a comparison out.
 */

import type { ManagerRaises } from "./cohort"
import { monthsBetween } from "./form-d"

export type VintagePoint = {
  /** Whole months since the fund's start; a filing before the start reads as 0. */
  month: number
  filedAt: string
  /** Cumulative dollars sold as at that filing. */
  sold: number
  target: number | "indefinite" | null
  investorCount: number | null
  cik: string
  accession: string
}

export type Vintage = {
  cik: string
  vehicleName: string
  /** 1-based, by start date within the manager's funds. Derived, not read from the name. */
  ordinal: number
  /** `YYYY-MM-DD`: the clock's zero for this fund. */
  start: string
  /** Whether the start is the reported first sale or, failing that, the first filing. */
  startBasis: "first-sale" | "first-filing"
  /** One per month, ascending; where two filings share a month the later one stands. */
  points: VintagePoint[]
  /** From the newest filing, as on `Raise`. */
  target: number | "indefinite" | null
  targetHigh: number | null
  sold: number | null
  /** Months from start to the newest filing that reports an amount sold. */
  monthsIn: number | null
  progress: number | null
  open: boolean
}

export type PriorAtMonth = {
  sold: number
  /** `point` when a filing sits exactly at that month, `interpolated` when it sits between two. */
  basis: "point" | "interpolated"
  /** The months of the two filings interpolated between, when interpolated. */
  between: [number, number] | null
}

export type VintageComparison = {
  newest: { cik: string; vehicleName: string; ordinal: number; month: number; sold: number }
  prior: { cik: string; vehicleName: string; ordinal: number }
  /**
   * What the prior fund had raised at the newest fund's current month. Null when
   * the prior's trail ends before that month — then there is nothing to
   * compare at the same point, and `priorLast` is all that can be said.
   */
  priorAtMonth: PriorAtMonth | null
  /** The prior fund's newest reported figure and when it was reported. */
  priorLast: { sold: number; month: number }
  /** newest sold ÷ prior sold at the same month. Null without the prior figure. */
  pace: number | null
  /** Newest offering ÷ prior offering. Null unless both are numeric. */
  targetMultiple: number | null
}

export type VintagePacing = {
  peerId: string
  manager: string
  isSelf: boolean
  /** Ordinal ascending. */
  vintages: Vintage[]
  /** The newest vintage with a curve against the one before it. Null with fewer than two. */
  comparison: VintageComparison | null
  /** Sleeve filers left out, so the panel can say so. */
  sleevesOmitted: number
}

/** Within this band of the prior's pace, the two are called level. */
export const PACE_LEVEL_BAND = 0.05

function numericTarget(v: number | "indefinite" | null): number | null {
  return typeof v === "number" && v > 0 ? v : null
}

/**
 * One fund's curve from its filing trail.
 *
 * A filing that reports no amount sold contributes no point — a fund that
 * omitted the figure is not a fund that raised nothing. A filing dated before
 * the first sale is clamped to month 0, which is faithful: nothing had been
 * sold before the first sale, so whatever it reports is the figure at the
 * start.
 */
function buildVintage(raise: ManagerRaises["raises"][number]): Omit<Vintage, "ordinal"> | null {
  const r = raise.raise
  const start = r.firstSale ?? r.firstFiled
  if (!start) return null

  const byMonth = new Map<number, VintagePoint>()
  for (const f of r.filings) {
    if (f.totalSold == null || !/^\d{4}-\d{2}-\d{2}$/.test(f.filedAt)) continue
    const month = Math.max(0, monthsBetween(start, f.filedAt))
    // The trail is oldest-first, so a later filing in the same month overwrites.
    byMonth.set(month, {
      month,
      filedAt: f.filedAt,
      sold: f.totalSold,
      target: f.offeringAmount,
      investorCount: f.investorCount,
      cik: f.cik,
      accession: f.accession,
    })
  }
  const points = [...byMonth.values()].sort((a, b) => a.month - b.month)
  const last = points[points.length - 1]

  return {
    cik: raise.cik,
    vehicleName: raise.vehicleName,
    start,
    startBasis: r.firstSale ? "first-sale" : "first-filing",
    points,
    target: r.target,
    targetHigh: r.targetHigh,
    sold: r.sold,
    monthsIn: last ? last.month : null,
    progress: r.progress,
    open: raise.open,
  }
}

/**
 * The prior fund's cumulative sold at a given month.
 *
 * Exact where a filing sits at that month. Between two filings it is a straight
 * line between them — the only honest shape when nothing is known in between —
 * and the bracketing months are returned so the caller can say so. Before the
 * first filing or after the last there is no figure, and null is returned
 * rather than an extrapolation.
 */
export function priorSoldAt(points: readonly VintagePoint[], month: number): PriorAtMonth | null {
  if (!points.length) return null
  const exact = points.find((p) => p.month === month)
  if (exact) return { sold: exact.sold, basis: "point", between: null }

  let lo: VintagePoint | null = null
  let hi: VintagePoint | null = null
  for (const p of points) {
    if (p.month < month) lo = p
    else if (p.month > month && !hi) hi = p
  }
  if (!lo || !hi) return null
  const t = (month - lo.month) / (hi.month - lo.month)
  return { sold: lo.sold + t * (hi.sold - lo.sold), basis: "interpolated", between: [lo.month, hi.month] }
}

/**
 * A manager's vintages and the newest-against-prior comparison.
 *
 * Fund-role vehicles only; sleeves are counted and omitted. Vintages with no
 * start date cannot be placed on the axis and are dropped. The comparison is
 * between the newest vintage that has at least one point and the nearest
 * earlier one that does, so a fund that reported no amounts is skipped rather
 * than compared against as zero.
 */
export function buildVintagePacing(manager: ManagerRaises): VintagePacing {
  const funds = manager.raises.filter((r) => r.role === "fund")
  const sleevesOmitted = manager.raises.length - funds.length

  const unordered = funds.map(buildVintage).filter((v): v is Omit<Vintage, "ordinal"> => v != null)
  unordered.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.cik < b.cik ? -1 : 1))
  const vintages: Vintage[] = unordered.map((v, i) => ({ ...v, ordinal: i + 1 }))

  const withCurve = vintages.filter((v) => v.points.length > 0)
  let comparison: VintageComparison | null = null
  if (withCurve.length >= 2) {
    const newest = withCurve[withCurve.length - 1]
    const prior = withCurve[withCurve.length - 2]
    const month = newest.monthsIn as number
    const newestSold = newest.points[newest.points.length - 1].sold
    const priorAtMonth = priorSoldAt(prior.points, month)
    const priorLastPoint = prior.points[prior.points.length - 1]
    const nt = numericTarget(newest.target)
    const pt = numericTarget(prior.target)
    comparison = {
      newest: { cik: newest.cik, vehicleName: newest.vehicleName, ordinal: newest.ordinal, month, sold: newestSold },
      prior: { cik: prior.cik, vehicleName: prior.vehicleName, ordinal: prior.ordinal },
      priorAtMonth,
      priorLast: { sold: priorLastPoint.sold, month: priorLastPoint.month },
      pace: priorAtMonth && priorAtMonth.sold > 0 ? newestSold / priorAtMonth.sold : null,
      targetMultiple: nt != null && pt != null ? nt / pt : null,
    }
  }

  return {
    peerId: manager.peerId,
    manager: manager.manager,
    isSelf: manager.isSelf,
    vintages,
    comparison,
    sleevesOmitted,
  }
}

/** Managers in a cohort with at least two vintages that have a curve, for a panel to choose from. */
export function managersWithLadders(managers: readonly ManagerRaises[]): VintagePacing[] {
  return managers
    .map(buildVintagePacing)
    .filter((p) => p.vintages.filter((v) => v.points.length > 0).length >= 2)
}

// --------------------------------------------------------------------- reading

function dollars(value: number): string {
  const a = Math.abs(value)
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `$${Math.round(a / 1e3)}K`
  return `$${Math.round(a)}`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`
}

function months(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`
}

/**
 * The pacing reading, built from the comparison and nothing else.
 *
 * Blunt in both directions, as the self reading is: the point of the chart is
 * to see "behind" as readily as "ahead". The interpolation and the sparseness
 * of the trails are always said, because a reader who takes the curve for a
 * measured trajectory will over-read it.
 */
export function buildPacingReading(p: VintagePacing): string {
  const withCurve = p.vintages.filter((v) => v.points.length > 0)
  if (!withCurve.length) {
    return `No fund of ${p.manager}'s reports an amount sold on any Form D filing, so there is no curve to draw.`
  }
  if (!p.comparison) {
    const only = withCurve[0]
    return `${p.manager} has one fund with a readable raise on file — ${only.vehicleName}, ${dollars(only.sold ?? 0)} in ${months(only.monthsIn ?? 0)} — so there is no earlier vintage to pace it against.`
  }

  const c = p.comparison
  const s: string[] = []
  s.push(`${c.newest.vehicleName} has raised ${dollars(c.newest.sold)} in ${months(c.newest.month)}.`)

  if (c.priorAtMonth && c.pace != null) {
    const at = c.priorAtMonth
    const where =
      at.basis === "point"
        ? `At the same point ${c.prior.vehicleName} had raised ${dollars(at.sold)}`
        : `At the same point ${c.prior.vehicleName} had raised about ${dollars(at.sold)} — a figure between its filings at ${months(at.between![0])} and ${months(at.between![1])}, not a reported one`
    const verdict =
      c.pace >= 1 + PACE_LEVEL_BAND
        ? `so the newer fund is running ahead, at ${c.pace.toFixed(2)}× its predecessor's dollar pace`
        : c.pace <= 1 - PACE_LEVEL_BAND
          ? `so the newer fund is running behind, at ${c.pace.toFixed(2)}× its predecessor's dollar pace`
          : `so the two are raising at the same dollar pace`
    s.push(`${where}, ${verdict}.`)
  } else {
    const passed = c.newest.sold >= c.priorLast.sold
    s.push(
      `${c.prior.vehicleName}'s trail ends at ${months(c.priorLast.month)} with ${dollars(c.priorLast.sold)}, ${
        c.priorLast.month < c.newest.month ? "before" : "after"
      } the point the newer fund has reached, so the two cannot be compared at the same month; the newer fund has ${
        passed ? "already passed" : "not yet reached"
      } that figure.`
    )
  }

  if (c.targetMultiple != null) {
    const newest = p.vintages.find((v) => v.cik === c.newest.cik)!
    const multiple =
      c.targetMultiple >= 1.05
        ? `an offering ${c.targetMultiple.toFixed(1)}× the size of its predecessor's`
        : c.targetMultiple <= 0.95
          ? `an offering ${(1 / c.targetMultiple).toFixed(1)}× smaller than its predecessor's`
          : `an offering the same size as its predecessor's`
    const cut = newest.targetHigh != null ? `, cut from ${dollars(newest.targetHigh)}` : ""
    const progress = newest.progress != null ? ` and is ${pct(newest.progress)} subscribed` : ""
    s.push(`That pace is against ${multiple}${cut}${progress}.`)
  } else {
    const newest = p.vintages.find((v) => v.cik === c.newest.cik)!
    if (newest.target === "indefinite") {
      s.push(`The newer fund states no cap, so there is no share of offering to measure.`)
    }
  }

  const prior = p.vintages.find((v) => v.cik === c.prior.cik)!
  s.push(
    `${c.prior.vehicleName} last reported ${dollars(c.priorLast.sold)} at ${months(c.priorLast.month)}${
      prior.progress != null ? `, ${pct(prior.progress)} of its offering` : ""
    }${prior.open ? "" : "; it has not filed in a year or more"}.`
  )

  const counts = withCurve.map((v) => v.points.length)
  const lo = Math.min(...counts)
  const hi = Math.max(...counts)
  s.push(
    `Each fund files only when it takes money, so the curves have ${
      lo === hi ? `${lo}` : `${lo} to ${hi}`
    } points each and show direction rather than a measured trajectory.`
  )

  return s.join(" ")
}
