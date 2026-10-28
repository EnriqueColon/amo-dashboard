/**
 * Turns a legal development's stated scope into a count of institutions it
 * touches — on this dashboard's own FDIC data.
 *
 * The tool joined against its Market Analytics screening (a live FDIC pull)
 * and a Postgres watchlist. Here the universe is the Florida screening rows
 * from bank_stress.db (server/fdic-analytics.ts — same row contract), and
 * "watchlist" is the Bank Stress Ranking's watch tiers: banks the ranking
 * flags as under pressure or on the watchlist in the latest quarter. So "3 on
 * the watchlist" means three of the matched banks are ones the ranking
 * already points at — which is the call the reader wants to make.
 *
 * Kept apart from the feed's day-keyed cache for the tool's reasons: the
 * screening is keyed to the FDIC quarter, the tiers change weekly, and
 * neither belongs in a shared daily payload.
 */
import { screeningUniverse } from "../../fdic-analytics"
import { openBankStressDb } from "../../bank-stress"
import {
  type ApplicabilityExample,
  describeTest,
  normalizeApplicability,
  selectMatching,
  summarizeMatches,
} from "@shared/legal/legal-applicability"

const UNIVERSE_SCOPE = "Florida"

export type ResolvedApplicability = {
  matched: number
  universe: number
  examples: ApplicabilityExample[]
  onWatchlist: number
  watchlistNames: string[]
  test: string
  basis?: string
  capped: boolean
}

export type ApplicabilityRequest = { id: string; applicability: unknown }

export type ResolveApplicabilityResult = {
  resolved: Record<string, ResolvedApplicability>
  scope: string
  watchlistAvailable: boolean
  /** Which quarter the universe comes from, for the page to label the counts. */
  quarter?: string
}

const EMPTY = (watchlistAvailable: boolean): ResolveApplicabilityResult => ({ resolved: {}, scope: UNIVERSE_SCOPE, watchlistAvailable })

/** Certs the Bank Stress Ranking flags in the latest quarter (tier watchlist or pressure). */
function stressWatchlist(): { certs: Set<string>; available: boolean } {
  const db = openBankStressDb()
  if (!db) return { certs: new Set(), available: false }
  try {
    const rows = db
      .prepare(
        `SELECT cert FROM bank_scores
          WHERE repdte = (SELECT MAX(repdte) FROM bank_scores) AND tier IN ('watchlist', 'pressure')`
      )
      .all() as Array<{ cert: number }>
    return { certs: new Set(rows.map((r) => String(r.cert))), available: true }
  } catch {
    return { certs: new Set(), available: false }
  }
}

export async function resolveLegalApplicability(requests: ApplicabilityRequest[]): Promise<ResolveApplicabilityResult> {
  if (!Array.isArray(requests) || requests.length === 0) return EMPTY(false)
  const screening = screeningUniverse(UNIVERSE_SCOPE)
  if (!screening || screening.rows.length === 0) return EMPTY(false)

  const universe = screening.rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    state: r.state,
    totalAssets: r.totalAssets,
    capitalRatios: r.capitalRatios,
  }))
  const { certs: watchlistCerts, available: watchlistAvailable } = stressWatchlist()

  const resolved: Record<string, ResolvedApplicability> = {}
  for (const request of requests) {
    if (typeof request?.id !== "string") continue
    const test = normalizeApplicability(request.applicability)
    if (!test) continue
    const matchedRows = selectMatching(test, universe)
    const summary = summarizeMatches(matchedRows, universe.length)
    const hits = matchedRows.filter((row) => watchlistCerts.has(String(row.id)))
    resolved[request.id] = {
      ...summary,
      onWatchlist: hits.length,
      watchlistNames: hits.slice(0, 3).map((row) => row.name),
      test: describeTest(test),
      basis: test.basis,
      // The screening holds every filer in the state; nothing is capped here.
      capped: false,
    }
  }
  return { resolved, scope: UNIVERSE_SCOPE, watchlistAvailable, quarter: screening.quarter }
}
