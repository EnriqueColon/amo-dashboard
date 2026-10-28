import { test } from "node:test"
import assert from "node:assert/strict"
import type { AdvFund } from "./adv"
import { adviserYears, currentPoint, seriesNotes, yearlySeries, type AdvHistory, type AdvHistoryPoint } from "./adv-history"

const point = (over: Partial<AdvHistoryPoint> & { filedOn: string; filingId: number }): AdvHistoryPoint => ({
  annual: null,
  grossAssetValue: null,
  owners: null,
  annualAudit: true,
  statementsDistributed: false,
  opinion: "unqualified",
  isFeederFund: false,
  ...over,
})

function fund(over: Partial<AdvFund> & { name: string }): AdvFund {
  return {
    fundId: null, state: null, country: null, generalPartners: [], umbrellaAdvisers: [], exclusion3c1: null, exclusion3c7: null,
    isMasterFund: null, feeders: [], isFeederFund: null, master: null, fundOfFunds: null, fundTypes: [], grossAssetValue: null,
    minimumInvestment: null, beneficialOwners: null, pctOwnedByRelated: null, pctOwnedByFundsOfFunds: null,
    salesLimitedToQualifiedClients: null, pctOwnedByNonUs: null, isSubadviser: null, otherAdvisersAdvise: null, clientsSolicited: null,
    pctClientsInvested: null, reliedOnRegulationD: null, formDFileNumber: null, annualAudit: null, gaap: null, auditors: [],
    statementsDistributed: null, opinion: null, usesPrimeBroker: null, primeBrokers: [], usesCustodian: null, custodians: [],
    administrators: [], pctAssetsValuedByOthers: null, marketers: [],
    ...over,
  }
}

// Safe Harbor's Fund 3 as the bulk table has it, filing dates invented to one per year.
const fund3: AdvHistoryPoint[] = [
  point({ filedOn: "2021-03-30", filingId: 1353629, annual: true, grossAssetValue: 41_500_000, owners: 17, opinion: "report-not-yet-received" }),
  point({ filedOn: "2021-09-01", filingId: 1420668, annual: false, grossAssetValue: 41_500_000, owners: 17, opinion: "report-not-yet-received" }),
  point({ filedOn: "2022-03-28", filingId: 1500686, annual: true, grossAssetValue: 67_100_000, owners: 20 }),
  point({ filedOn: "2022-11-02", filingId: 1538226, annual: false, grossAssetValue: 62_192_495, owners: 20 }),
  point({ filedOn: "2023-03-29", filingId: 1614373, annual: true, grossAssetValue: 109_676_391, owners: 34 }),
  point({ filedOn: "2024-03-27", filingId: 1848864, annual: true, grossAssetValue: 155_575_033, owners: 46 }),
  point({ filedOn: "2024-07-15", filingId: 1907622, annual: false, grossAssetValue: 155_575_033, owners: 46 }),
]

test("one point per year, the annual amendment where there is one, then the current PDF record", () => {
  const current = currentPoint(fund({ name: "FUND 3", grossAssetValue: 84_147_927, beneficialOwners: 46, annualAudit: true, statementsDistributed: false, opinion: "unqualified" }), "2026-05-04")
  const s = yearlySeries(fund3, current)
  assert.deepEqual(
    s.map((p) => [p.year, p.basis, p.grossAssetValue, p.owners]),
    [
      [2021, "annual", 41_500_000, 17],
      [2022, "annual", 67_100_000, 20],
      [2023, "annual", 109_676_391, 34],
      [2024, "annual", 155_575_033, 46],
      [2026, "current", 84_147_927, 46],
    ],
    "the 2022 November amendment with a lower figure does not displace the annual one"
  )
  const noAnnualFlag = yearlySeries(fund3.map((p) => ({ ...p, annual: null })), null)
  assert.equal(noAnnualFlag.find((p) => p.year === 2022)?.grossAssetValue, 62_192_495, "without the flag, the year's last filing stands")
  assert.equal(noAnnualFlag[0].basis, "latest")
  assert.deepEqual(yearlySeries([], current).map((p) => p.year), [2026])
  const sameYear = yearlySeries(fund3, currentPoint(fund({ name: "FUND 3", grossAssetValue: 1 }), "2024-12-01"))
  assert.equal(sameYear.filter((p) => p.year === 2024).length, 1, "a current point in a year already present replaces it")
  assert.equal(sameYear[sameYear.length - 1].basis, "current")
})

test("notes say what moved between consecutive years, in checkable words", () => {
  const current = currentPoint(fund({ name: "FUND 3", grossAssetValue: 84_147_927, beneficialOwners: 30, annualAudit: true, statementsDistributed: true, opinion: "not-unqualified" }), "2026-05-04")
  const notes = seriesNotes(yearlySeries(fund3, current))
  assert.deepEqual(
    notes.map((n) => n.text),
    [
      "gross assets rose 62% between the 2021 and 2022 filings",
      "owners rose from 17 to 20",
      'opinion went from "report not yet received" to "unqualified" at the 2022 filing',
      "gross assets rose 63% between the 2022 and 2023 filings",
      "owners rose from 20 to 34",
      "gross assets rose 42% between the 2023 and 2024 filings",
      "owners rose from 34 to 46",
      "gross assets fell 46% between the 2024 and 2026 filings",
      "owners fell from 46 to 30",
      "audited statements distributed to all investors from the 2026 filing",
      'opinion went from "unqualified" to "not unqualified" at the 2026 filing',
    ]
  )
  assert.deepEqual(seriesNotes([]), [])
  assert.deepEqual(seriesNotes(yearlySeries([point({ filedOn: "2023-01-01", filingId: 1, grossAssetValue: 100 }), point({ filedOn: "2024-01-01", filingId: 2, grossAssetValue: 115 })], null)), [], "a move under a fifth is not noted")
})

test("an adviser's book by year sums non-feeder funds on one filing per year, then the current extract", () => {
  const history: AdvHistory = {
    builtOn: "2026-10-27",
    source: "test",
    coverage: { from: "2021-03-30", to: "2024-07-15" },
    funds: {
      "805-3": { crd: "305314", names: ["FUND 3"], points: fund3 },
      "805-4": {
        crd: "305314",
        names: ["FUND 4"],
        points: [
          point({ filedOn: "2024-03-27", filingId: 1848864, annual: true, grossAssetValue: 50_000_000, owners: 10 }),
          point({ filedOn: "2024-07-15", filingId: 1907622, annual: false, grossAssetValue: 60_000_000, owners: 12 }),
        ],
      },
      "805-4f": { crd: "305314", names: ["FUND 4 FEEDER"], points: [point({ filedOn: "2024-07-15", filingId: 1907622, annual: false, grossAssetValue: 5_000_000, isFeederFund: true })] },
      "805-x": { crd: "999", names: ["SOMEONE ELSE"], points: [point({ filedOn: "2024-03-01", filingId: 7, annual: true, grossAssetValue: 1 })] },
    },
  }
  const years = adviserYears(history, "305314", { filedOn: "2026-05-04", funds: [fund({ name: "FUND 3", grossAssetValue: 84_147_927 }), fund({ name: "FUND 4", grossAssetValue: 186_673_253 }), fund({ name: "FEEDER", grossAssetValue: 7_472_585, isFeederFund: true })] })
  assert.deepEqual(
    years.map((y) => [y.year, y.funds, y.grossAssetValue, y.grossAssetValueFunds]),
    [
      [2021, 1, 41_500_000, 1],
      [2022, 1, 67_100_000, 1],
      [2023, 1, 109_676_391, 1],
      [2024, 2, 205_575_033, 2],
      [2026, 3, 270_821_180, 2],
    ],
    "2024 is the annual filing (two funds, the feeder not yet listed); 2026 excludes the feeder from the sum"
  )
  assert.deepEqual(adviserYears(history, "999", null).map((y) => y.year), [2024])
  assert.deepEqual(adviserYears(history, "none", null), [])
})
