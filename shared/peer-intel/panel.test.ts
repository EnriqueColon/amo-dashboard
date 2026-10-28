import { test } from "node:test"
import assert from "node:assert/strict"
import { buildManagerRaises, buildPeerCohort, type PeerCohort } from "./cohort"
import type { OfferingRecord } from "./form-d"
import { managerSignals } from "./signals"
import {
  activeRaiseRows,
  managerRoster,
  standingLabel,
  filingTrail,
  filingUrl,
  buildEnvironmentReading,
  buildManagerReading,
  buildManagerSnapshot,
  buildSelfReading,
  classifyFilings,
  closeLabel,
  layerName,
  money,
  monthYear,
  orderedSignals,
  percent,
} from "./panel"

const ASOF = "2026-10-21"

/** A real accession shape: 10-digit CIK, 2-digit year, 6-digit sequence. */
function accessionFor(cik: string, filedAt: string): string {
  const yy = filedAt.slice(2, 4)
  const seq = filedAt.replace(/-/g, "").slice(-6)
  return `${cik.padStart(10, "0")}-${yy}-${seq}`
}

function rec(over: Partial<OfferingRecord> & { cik: string; filedAt: string }): OfferingRecord {
  return {
    accession: accessionFor(over.cik, over.filedAt),
    formType: "D", entityName: "Fund LP", location: "Miami, FL", jurisdiction: "DE",
    offeringAmount: null, totalSold: null, remaining: null, investorCount: null,
    minimumInvestment: null, dateOfFirstSale: null, industryGroup: null, fundType: null, hasNonAccreditedInvestors: null, salesRecipients: [], relatedPersons: [],
    ...over,
  }
}

/** Safe Harbor's real Fund 4 trail, plus three Rialto and Bayview raises to rank against. */
function miamiRecords(): Map<string, OfferingRecord[]> {
  return new Map<string, OfferingRecord[]>([
    ["2017189", [
      rec({ cik: "2017189", filedAt: "2024-03-28", offeringAmount: 500_000_000, totalSold: 0, investorCount: 0 }),
      rec({ cik: "2017189", filedAt: "2026-07-23", formType: "D/A", offeringAmount: 300_000_000, totalSold: 64_168_863, investorCount: 40 }),
    ]],
    ["2026136", [rec({ cik: "2026136", filedAt: "2026-09-04", offeringAmount: 2_000_000_000, totalSold: 1_080_000_000, investorCount: 126 })]],
    ["1912768", [rec({ cik: "1912768", filedAt: "2026-08-11", offeringAmount: 500_000_000, totalSold: 248_500_000, investorCount: 38 })]],
    ["2143451", [rec({ cik: "2143451", filedAt: "2026-07-06", offeringAmount: 400_000_000, totalSold: 200_000_000, investorCount: 5, dateOfFirstSale: "2026-07-01" })]],
  ])
}

test("money and percent never print a raw null or a bare number", () => {
  assert.equal(money(64_168_863), "$64.2M")
  assert.equal(money(1_080_000_000), "$1.08B")
  assert.equal(money(500_000), "$500K")
  assert.equal(money(-846_100_000), "−$846.1M")
  assert.equal(money("indefinite"), "no stated cap")
  assert.equal(money(null), "not reported")
  assert.equal(percent(0.214, 1), "21.4%")
  assert.equal(percent(null), "not reported")
})

test("dates read as prose, and a malformed one does not leak", () => {
  assert.equal(monthYear("2026-07-23"), "July 2026")
  assert.equal(monthYear(null), "an unknown date")
  assert.equal(monthYear("garbage"), "an unknown date")
  assert.equal(layerName("miami-dade"), "Miami-Dade")
  assert.equal(layerName("national"), "the US")
})

test("the environment reading states the market and names what is missing", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const text = buildEnvironmentReading(cohort)
  assert.match(text, /managers are in the market/)
  assert.match(text, /across 4 open raises/)
  assert.match(text, /\$1\.59B/, "total raised is stated")
  assert.match(text, /opened in the last twelve months/)
  assert.match(text, /reduced what they are asking for/)
  // Miami-Dade has no registered vehicle, so the reading must say so.
  assert.match(text, /private fund, so this is the raise and nothing else/)
})

test("an empty market says so rather than printing zeroes", () => {
  const text = buildEnvironmentReading(buildPeerCohort("miami-dade", new Map(), ASOF))
  assert.match(text, /has filed an open offering recently/)
  assert.ok(!text.includes("$0"))
})

test("a layer whose offerings are all uncapped says there is no target", () => {
  const records = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", offeringAmount: "indefinite", totalSold: 10_000_000 })]],
  ])
  const text = buildEnvironmentReading(buildPeerCohort("miami-dade", records, ASOF))
  assert.match(text, /no offering in this layer states a cap/)
})

test("the self reading ranks the firm and does not flatter it", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const text = buildSelfReading(cohort)
  assert.ok(text)
  assert.match(text, /ranks 4 of 4 open raises/, "three peers raised more")
  assert.match(text, /3 peer raises are larger/)
  assert.match(text, /below that median/, "it is below the median here and must say so")
  assert.match(text, /cut from \$500\.0M/)
  assert.match(text, /no other manager in this layer has cut one/)
})

test("the self reading stays silent rather than ranking against too few peers", () => {
  const thin = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", offeringAmount: 300_000_000, totalSold: 64_168_863 })]],
  ])
  const text = buildSelfReading(buildPeerCohort("miami-dade", thin, ASOF))
  assert.match(text ?? "", /would not mean anything/)
})

test("with no open self raise the reading says that, not nothing", () => {
  const closed = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2021-01-01", offeringAmount: 300_000_000, totalSold: 50_000_000 })]],
  ])
  assert.match(buildSelfReading(buildPeerCohort("miami-dade", closed, ASOF)) ?? "", /no open offering on file/)
})

function managerAndSignals(cohort: PeerCohort, peerId: string) {
  const manager = cohort.managers.find((m) => m.peerId === peerId)!
  return { manager, signals: managerSignals(manager, new Map()) }
}

test("the manager reading only says what the panel shows", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const { manager, signals } = managerAndSignals(cohort, "safe-harbor-capital-partners")
  const text = buildManagerReading(manager, signals)
  assert.match(text, /Safe Harbor Capital Partners has 1 open raise/)
  assert.match(text, /reduced what it is asking for/)
  assert.match(text, /\$500\.0M to \$300\.0M/)
  // Private funds report no liquidity, and the reading must distinguish that
  // from a signal that simply did not fire.
  assert.match(text, /not observable for this manager/)
})

test("a manager with no filings says so instead of reading as a quiet one", () => {
  const cohort = buildPeerCohort("miami-dade", new Map(), ASOF)
  const { manager, signals } = managerAndSignals(cohort, "rialto-capital-management")
  assert.match(buildManagerReading(manager, signals), /No readable Form D filing was found/)
})

test("a manager whose signals are all quiet says that plainly", () => {
  const records = new Map<string, OfferingRecord[]>([
    ["1912768", [
      rec({ cik: "1912768", filedAt: "2025-09-01", offeringAmount: 500_000_000, totalSold: 240_000_000 }),
      rec({ cik: "1912768", filedAt: "2026-09-01", formType: "D/A", offeringAmount: 500_000_000, totalSold: 248_500_000 }),
    ]],
  ])
  const cohort = buildPeerCohort("miami-dade", records, ASOF)
  const { manager, signals } = managerAndSignals(cohort, "rialto-capital-management")
  assert.match(buildManagerReading(manager, signals), /No signal fired on the measures available/)
})

test("signals order fired first, action before pressure", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const { signals } = managerAndSignals(cohort, "safe-harbor-capital-partners")
  const ordered = orderedSignals(signals)
  const states = ordered.map((s) => s.state)
  assert.deepEqual([...states].sort((a, b) => states.indexOf(a) - states.indexOf(b)), states, "stable")
  const firstUnjudged = states.indexOf("unjudged")
  const lastFired = states.lastIndexOf("fired")
  assert.ok(lastFired < firstUnjudged || firstUnjudged === -1)
})

test("the snapshot carries the raises, the fired signals and what was not judged", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const { manager, signals } = managerAndSignals(cohort, "safe-harbor-capital-partners")
  const snap = buildManagerSnapshot(manager, signals, cohort)
  assert.match(snap, /^Safe Harbor Capital Partners — Miami Beach, FL/)
  assert.match(snap, /Safe Harbor Equity Distressed Debt Fund 4/)
  assert.match(snap, /cut from \$500\.0M/)
  assert.match(snap, /Signals fired:/)
  assert.match(snap, /Not judged:/)
  assert.match(snap, /Reading:/)
  assert.match(snap, /self-reported by the issuer and unaudited/, "the caveat travels with the figures")
  assert.ok(!snap.includes("undefined"))
  assert.ok(!snap.includes("NaN"))
})

test("the firm's own raise is pinned to the top of the table", () => {
  const rows = activeRaiseRows(buildPeerCohort("miami-dade", miamiRecords(), ASOF))
  assert.equal(rows[0].isSelf, true)
  assert.match(rows[0].vehicleName, /Safe Harbor/)
  // Everything after it is ordered by size, largest first.
  const rest = rows.slice(1).map((r) => r.raise.sold ?? -1)
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a))
})

test("no reading ever emits undefined, NaN or a raw null", () => {
  for (const layer of ["miami-dade", "florida", "national"] as const) {
    for (const records of [new Map<string, OfferingRecord[]>(), miamiRecords()]) {
      const cohort = buildPeerCohort(layer, records, ASOF)
      const texts = [buildEnvironmentReading(cohort), buildSelfReading(cohort) ?? ""]
      for (const m of cohort.managers) texts.push(buildManagerReading(m, managerSignals(m, new Map())))
      for (const text of texts) {
        assert.ok(!text.includes("undefined"), text.slice(0, 120))
        assert.ok(!text.includes("NaN"), text.slice(0, 120))
        assert.ok(!text.includes("null"), text.slice(0, 120))
      }
    }
  }
})

test("every raise links to the SEC filing its figures came from", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const self = cohort.managers.find((m) => m.isSelf)!
  const raise = self.raises[0].raise
  const url = filingUrl(raise)
  assert.ok(url, "a raise with filings must link to one")
  // The newest filing, since that is where target/sold/investors are read from.
  assert.match(url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/2017189\//)
  assert.match(url, /-index\.html$/)
})

test("a raise with no readable accession links to nothing rather than a broken URL", () => {
  const cohort = buildPeerCohort("miami-dade", new Map([
    ["2017189", [rec({ cik: "2017189", filedAt: "2026-07-23", accession: "not-an-accession", totalSold: 1 })]],
  ]), ASOF)
  const raise = cohort.managers.find((m) => m.isSelf)!.raises[0].raise
  assert.equal(filingUrl(raise), null)
})

test("the filing trail is newest first and carries each filing's own figures", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const raise = cohort.managers.find((m) => m.isSelf)!.raises[0].raise
  const trail = filingTrail(raise)
  assert.equal(trail.length, 2)
  assert.equal(trail[0].filedAt, "2026-07-23", "newest first")
  assert.equal(trail[0].formType, "D/A")
  assert.equal(trail[0].sold, 64_168_863)
  assert.equal(trail[1].filedAt, "2024-03-28")
  assert.equal(trail[1].sold, 0, "the original filing's own figure, not the latest")
  assert.equal(trail[1].target, 500_000_000, "and its own offering amount, before the cut")
  for (const f of trail) assert.match(f.url ?? "", /sec\.gov/)

  // Read as closes: the original is the first filing, the amendment took $64.2M and cut the offering.
  assert.deepEqual(trail[1].close, { kind: "first", delta: null, offeringFrom: null })
  assert.deepEqual(trail[0].close, { kind: "interim", delta: 64_168_863, offeringFrom: 500_000_000 })
  assert.equal(closeLabel(trail[0].close), "Interim close, +$64.2M")
  assert.equal(closeLabel(trail[1].close), "First filing")
})

test("each amendment is read against the one before it: a rise is a close, no rise is the annual re-file", () => {
  const filings = [
    rec({ cik: "1", filedAt: "2023-01-10", offeringAmount: 100_000_000, totalSold: 10_000_000 }),
    rec({ cik: "1", filedAt: "2023-09-10", formType: "D/A", offeringAmount: 100_000_000, totalSold: 40_000_000 }),
    rec({ cik: "1", filedAt: "2024-09-10", formType: "D/A", offeringAmount: 100_000_000, totalSold: 40_000_000 }),
    rec({ cik: "1", filedAt: "2025-03-10", formType: "D/A", offeringAmount: 100_000_000, totalSold: 38_000_000 }),
    rec({ cik: "1", filedAt: "2025-09-10", formType: "D/A", offeringAmount: 100_000_000, totalSold: null }),
    rec({ cik: "1", filedAt: "2026-03-10", formType: "D/A", offeringAmount: 150_000_000, totalSold: 70_000_000 }),
  ]
  const closes = classifyFilings(filings)
  assert.deepEqual(closes.map((c) => c.kind), ["first", "interim", "annual", "restated", "unknown", "unknown"])
  assert.equal(closes[1].delta, 30_000_000)
  assert.equal(closes[2].delta, 0, "the annual re-file reports the same cumulative figure")
  assert.equal(closes[3].delta, -2_000_000, "a decrease is a restatement, said rather than hidden")
  assert.equal(closes[4].delta, null, "no figure on this filing, so nothing to compare")
  assert.equal(closes[5].delta, null, "no figure on the previous filing either")
  assert.equal(closes[5].offeringFrom, 100_000_000, "the offering change is still read when the sold figure cannot be")

  assert.equal(closeLabel(closes[2]), "Annual amendment, no new capital")
  assert.equal(closeLabel(closes[3]), "Amount sold restated, −$2.0M")
  assert.equal(closeLabel(closes[4]), "Amendment")
  assert.deepEqual(classifyFilings([]), [])
})

test("the roster reaches every tracked manager, not just those raising", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const signals = cohort.managers.map((m) => managerSignals(m, new Map()))
  const rows = managerRoster(cohort, signals)

  assert.equal(rows.length, cohort.managers.length, "every manager must be reachable")
  // The tables only show open raises, so the roster is the only route to the rest.
  const openPeerIds = new Set(activeRaiseRows(cohort).map((r) => r.peerId))
  const unreachableWithoutRoster = rows.filter((r) => !openPeerIds.has(r.peerId))
  assert.ok(unreachableWithoutRoster.length > 0, "the fixture has managers with no open raise")
})

test("the firm sorts first, then managers in market by size, then the quiet", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const rows = managerRoster(cohort, cohort.managers.map((m) => managerSignals(m, new Map())))
  assert.equal(rows[0].isSelf, true)
  const standings = rows.map((r) => r.standing)
  const firstQuiet = standings.findIndex((s) => s !== "in-market")
  if (firstQuiet > -1) {
    assert.ok(
      standings.slice(firstQuiet).every((s) => s !== "in-market"),
      "in-market managers must all come before the quiet ones"
    )
  }
})

test("a manager with no readable filing is not-raising, which is an answer not a gap", () => {
  const cohort = buildPeerCohort("miami-dade", new Map(), ASOF)
  const rows = managerRoster(cohort, cohort.managers.map((m) => managerSignals(m, new Map())))
  assert.ok(rows.every((r) => r.standing === "not-raising"))
  assert.equal(standingLabel(rows[0]), "no Reg D filing")
})

test("standing says how long a manager has been quiet, in plain words", () => {
  const long = new Map<string, OfferingRecord[]>([
    ["2017189", [rec({ cik: "2017189", filedAt: "2019-12-11", offeringAmount: 1_800_000, totalSold: 1_800_000 })]],
  ])
  const cohort = buildPeerCohort("miami-dade", long, ASOF)
  const row = managerRoster(cohort, cohort.managers.map((m) => managerSignals(m, new Map())))
    .find((r) => r.isSelf)!
  assert.equal(row.standing, "quiet")
  // Gelt's real shape: a raise that closed years ago, stated as such.
  assert.match(standingLabel(row), /last raised \d+ years ago/)
})

test("an open raise reports its count rather than a quiet duration", () => {
  const cohort = buildPeerCohort("miami-dade", miamiRecords(), ASOF)
  const row = managerRoster(cohort, cohort.managers.map((m) => managerSignals(m, new Map())))
    .find((r) => r.isSelf)!
  assert.equal(row.standing, "in-market")
  assert.equal(standingLabel(row), "1 open raise")
})

test("Copy Snapshot carries structure and people when the filings have them", () => {
  const base = miamiRecords()
  const fund4 = base.get("2017189")!
  fund4[fund4.length - 1] = {
    ...fund4[fund4.length - 1],
    relatedPersons: [{ name: "Rafael Serrano", kind: "person", relationships: ["Executive Officer", "Director"], clarification: null }],
    terms: {
      entityType: "Limited Partnership", yearOfInc: 2022, formedOverFiveYearsAgo: false,
      coIssuers: [{ cik: "2017088", name: "Safe Harbor Equity Distressed Debt Fund 4 Feeder, L.P.", jurisdiction: "CAYMAN ISLANDS", entityType: "Limited Partnership", yearOfInc: 2023 }],
      exemptions: ["06b", "3C", "3C.1", "3C.7"], securities: ["pooled-fund"], securitiesOther: null, moreThanOneYear: true,
      salesCommissions: { amount: 2_000_000, estimate: true }, findersFees: { amount: 0, estimate: false }, feesClarification: null,
      proceedsToInsiders: { amount: 0, estimate: false }, proceedsClarification: null,
    },
  }
  const cohort = buildPeerCohort("miami-dade", base, ASOF)
  const self = cohort.managers.find((m) => m.isSelf)!
  const snap = buildManagerSnapshot(self, managerSignals(self, new Map()), cohort)
  assert.match(snap, /Structure & terms:/)
  assert.match(snap, /Rule 506\(b\), 3\(c\)\(1\), 3\(c\)\(7\); commissions \$2\.0M \(est\.\), 0\.67% of offering; files jointly with Safe Harbor Equity Distressed Debt Fund 4 Feeder, L\.P\./)
  assert.match(snap, /People \(Form D related persons\):\n  Rafael Serrano — Executive Officer, Director/)
  assert.ok(snap.indexOf("Structure & terms:") < snap.indexOf("Reading:"), "before the reading, which summarises")
})
