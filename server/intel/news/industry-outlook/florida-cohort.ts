/**
 * The Florida bank cohort for the outlook memo's verified-data block, from
 * bank_stress.db — the weekly FDIC pull this dashboard already keeps — in
 * place of the tool's live `fetchFDICFinancials("Florida", 500)` request.
 *
 * Same aggregation as the tool's `aggregateFloridaCohort`: the latest
 * reporting period only, dollar-weighted ratios, banks with loans. CRE is
 * this dashboard's definition (LNRECONS + LNREMULT + LNRENROT, owner-occupied
 * excluded — collector/bank_stress/README.md), which is also what Bank Stress
 * Ranking and FDIC Data Analytics show, so the memo and the pages agree.
 * Noncurrent uses NCLNLS over gross loans LNLSGR, both in $K.
 */
import { openBankStressDb } from "../../../bank-stress"
import { fdicQuarterLabel, type FdicCohort } from "../verified-metrics"

export function floridaCohortFromBankStressDb(): FdicCohort | null {
  const db = openBankStressDb()
  if (!db) return null
  const latest = db.prepare("SELECT MAX(REPDTE) AS q FROM fdic_financials_raw WHERE STALP = 'FL'").get() as
    | { q: string | null }
    | undefined
  if (!latest?.q) return null
  const row = db
    .prepare(
      `SELECT COUNT(*) AS institutions,
              SUM(LNLSGR) AS total_loans,
              SUM(COALESCE(LNRECONS,0) + COALESCE(LNREMULT,0) + COALESCE(LNRENROT,0)) AS cre_loans,
              SUM(COALESCE(NCLNLS,0)) AS noncurrent
         FROM fdic_financials_raw
        WHERE STALP = 'FL' AND REPDTE = ? AND LNLSGR > 0`
    )
    .get(latest.q) as { institutions: number; total_loans: number | null; cre_loans: number | null; noncurrent: number | null }
  if (!row || !row.total_loans || row.total_loans <= 0) return null
  return {
    scope: "Florida",
    institutions: row.institutions,
    // $K in the table; the tool's cohort carries dollars.
    creLoans: (row.cre_loans ?? 0) * 1000,
    creConcentration: ((row.cre_loans ?? 0) / row.total_loans) * 100,
    noncurrentRatio: ((row.noncurrent ?? 0) / row.total_loans) * 100,
    asOf: fdicQuarterLabel(latest.q),
  }
}
