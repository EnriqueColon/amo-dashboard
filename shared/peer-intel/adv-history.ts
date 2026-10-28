/**
 * Form ADV history — sponsor-stress step 5.
 *
 * The current extract is one snapshot per adviser. This module turns each
 * fund's Schedule D 7.B.(1) answers into a series: the SEC publishes every
 * Form ADV filing from November 2011 to December 2024 as bulk CSVs, and
 * `scripts/build-adv-history.mts` keeps the rows for the advisers in the
 * registry and commits `adv-history.json`, keyed by the fund's `805-` number
 * so a renamed fund stays one series (Safe Harbor's "Fund 3 Tides JV" became
 * "SHEDDF3 Tides LLC" under the same number). The current extract supplies
 * the newest point, since 2025 and later filings exist only as PDFs.
 *
 * Every point is an answer as filed, on the filing's date. An adviser files
 * an annual updating amendment each spring with fiscal-year-end figures and
 * other-than-annual amendments in between that usually repeat them, so the
 * year-by-year view takes one filing per calendar year — the annual one
 * where the filing index says which, else the last of the year — and the
 * change notes compare consecutive years. Nothing here scores; a fall in
 * gross assets is reported as a fall, which for a drawdown fund returning
 * capital is the plan rather than a problem, and the copy says so.
 *
 * Pure: history and the current record in; a series and its notes out.
 */

import type { AdvFund, YesNo } from "./adv"

export type AdvHistoryPoint = {
  /** `YYYY-MM-DD` the filing was made. */
  filedOn: string
  filingId: number
  /** Whether the filing was an annual updating amendment; null where the index does not say. */
  annual: boolean | null
  grossAssetValue: number | null
  owners: number | null
  annualAudit: YesNo
  statementsDistributed: YesNo
  opinion: AdvFund["opinion"]
  isFeederFund: YesNo
}

export type AdvHistory = {
  /** `YYYY-MM-DD` the file was built. */
  builtOn: string
  source: string
  /** Filing dates covered, `YYYY-MM-DD`. */
  coverage: { from: string; to: string }
  /** By fund `805-` id: the adviser it was read under, every name it has filed under in order, and its points, oldest filing first. */
  funds: Record<string, { crd: string; names: string[]; points: AdvHistoryPoint[] }>
}

/** One point per calendar year, for the panel. */
export type AdvYearPoint = {
  year: number
  filedOn: string
  /** "annual" when the year's annual amendment was used, "latest" when the last filing of the year was, "current" for the PDF extract. */
  basis: "annual" | "latest" | "current"
  grossAssetValue: number | null
  owners: number | null
  annualAudit: YesNo
  statementsDistributed: YesNo
  opinion: AdvFund["opinion"]
}

/** The current extract's record as a point, so the series ends at today's filing. */
export function currentPoint(fund: AdvFund, filedOn: string): AdvYearPoint {
  return {
    year: Number(filedOn.slice(0, 4)),
    filedOn,
    basis: "current",
    grossAssetValue: fund.grossAssetValue,
    owners: fund.beneficialOwners,
    annualAudit: fund.annualAudit,
    statementsDistributed: fund.statementsDistributed,
    opinion: fund.opinion,
  }
}

/**
 * One point per calendar year from the history, then the current point
 * where it is newer than the last. A year with an annual amendment uses it;
 * otherwise the year's last filing.
 */
export function yearlySeries(points: readonly AdvHistoryPoint[], current: AdvYearPoint | null): AdvYearPoint[] {
  const byYear = new Map<number, AdvHistoryPoint>()
  for (const p of [...points].sort((a, b) => a.filedOn.localeCompare(b.filedOn))) {
    const year = Number(p.filedOn.slice(0, 4))
    const have = byYear.get(year)
    if (!have || p.annual || !have.annual) byYear.set(year, p)
  }
  const out: AdvYearPoint[] = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, p]) => ({
      year,
      filedOn: p.filedOn,
      basis: p.annual ? "annual" : "latest",
      grossAssetValue: p.grossAssetValue,
      owners: p.owners,
      annualAudit: p.annualAudit,
      statementsDistributed: p.statementsDistributed,
      opinion: p.opinion,
    }))
  if (current && (!out.length || current.filedOn > out[out.length - 1].filedOn)) {
    if (out.length && out[out.length - 1].year === current.year) out.pop()
    out.push(current)
  }
  return out
}

export type AdvSeriesNote = {
  from: number
  to: number
  kind: "gross-assets" | "owners" | "audit" | "statements" | "opinion"
  text: string
}

const pctChange = (a: number, b: number) => (a === 0 ? null : (b - a) / a)

/**
 * What changed between consecutive years, in words a reader can check
 * against the two points. Gross assets are noted at a fifth either way,
 * owners at any change, and the three audit answers whenever they move.
 */
export function seriesNotes(series: readonly AdvYearPoint[]): AdvSeriesNote[] {
  const notes: AdvSeriesNote[] = []
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]
    const b = series[i]
    if (a.grossAssetValue != null && b.grossAssetValue != null) {
      const c = pctChange(a.grossAssetValue, b.grossAssetValue)
      if (c != null && Math.abs(c) >= 0.2) {
        notes.push({ from: a.year, to: b.year, kind: "gross-assets", text: `gross assets ${c < 0 ? "fell" : "rose"} ${Math.round(Math.abs(c) * 100)}% between the ${a.year} and ${b.year} filings` })
      }
    }
    if (a.owners != null && b.owners != null && a.owners !== b.owners) {
      notes.push({ from: a.year, to: b.year, kind: "owners", text: `owners ${b.owners < a.owners ? "fell" : "rose"} from ${a.owners} to ${b.owners}` })
    }
    if (a.annualAudit != null && b.annualAudit != null && a.annualAudit !== b.annualAudit) {
      notes.push({ from: a.year, to: b.year, kind: "audit", text: b.annualAudit ? `audited annually from the ${b.year} filing` : `no longer audited annually from the ${b.year} filing` })
    }
    if (a.statementsDistributed != null && b.statementsDistributed != null && a.statementsDistributed !== b.statementsDistributed) {
      notes.push({ from: a.year, to: b.year, kind: "statements", text: b.statementsDistributed ? `audited statements distributed to all investors from the ${b.year} filing` : `audited statements no longer distributed to all investors from the ${b.year} filing` })
    }
    if (a.opinion != null && b.opinion != null && a.opinion !== b.opinion) {
      const word = (o: AdvFund["opinion"]) => (o === "unqualified" ? "unqualified" : o === "not-unqualified" ? "not unqualified" : "report not yet received")
      notes.push({ from: a.year, to: b.year, kind: "opinion", text: `opinion went from "${word(a.opinion)}" to "${word(b.opinion)}" at the ${b.year} filing` })
    }
  }
  return notes
}

export type AdviserYear = {
  year: number
  filedOn: string
  funds: number
  /** Over funds that are not feeders and report a value, as the current summary does. */
  grossAssetValue: number | null
  grossAssetValueFunds: number
}

/**
 * An adviser's book by year: one filing per calendar year, the annual one
 * where known, with every fund it listed on that filing. The current extract
 * supplies the last year.
 */
export function adviserYears(
  history: AdvHistory,
  crd: string,
  current: { filedOn: string | null; funds: readonly AdvFund[] } | null
): AdviserYear[] {
  // Group the adviser's points by filing, then pick one filing per year.
  const byFiling = new Map<number, { filedOn: string; annual: boolean | null; points: AdvHistoryPoint[] }>()
  for (const entry of Object.values(history.funds)) {
    if (entry.crd !== crd) continue
    for (const p of entry.points) {
      const f = byFiling.get(p.filingId) ?? { filedOn: p.filedOn, annual: p.annual, points: [] }
      f.points.push(p)
      byFiling.set(p.filingId, f)
    }
  }
  const byYear = new Map<number, { filedOn: string; annual: boolean | null; points: AdvHistoryPoint[] }>()
  for (const f of [...byFiling.values()].sort((a, b) => a.filedOn.localeCompare(b.filedOn))) {
    const year = Number(f.filedOn.slice(0, 4))
    const have = byYear.get(year)
    if (!have || f.annual || !have.annual) byYear.set(year, f)
  }
  const sum = (pts: ReadonlyArray<{ grossAssetValue: number | null; isFeederFund: YesNo }>) => {
    const counted = pts.filter((p) => p.isFeederFund !== true && p.grossAssetValue != null)
    return { grossAssetValue: counted.length ? counted.reduce((a, p) => a + (p.grossAssetValue as number), 0) : null, grossAssetValueFunds: counted.length }
  }
  const out: AdviserYear[] = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, f]) => ({ year, filedOn: f.filedOn, funds: f.points.length, ...sum(f.points) }))
  if (current?.filedOn && (!out.length || current.filedOn > out[out.length - 1].filedOn)) {
    const year = Number(current.filedOn.slice(0, 4))
    if (out.length && out[out.length - 1].year === year) out.pop()
    out.push({ year, filedOn: current.filedOn, funds: current.funds.length, ...sum(current.funds) })
  }
  return out
}
