import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildFloridaSummaryPrompt,
  cleanAnalysisText,
  decodeEntities,
  describeFloridaFromRecord,
  describeFloridaRecord,
  describeFloridaSessionState,
  describeIntent,
  describeSponsors,
  isDeadStatus,
  fetchFloridaAnalysisText,
  isLocalBill,
  isReviserBill,
  selectCompanion,
  selectLastVote,
  selectLatestAnalysis,
  selectLatestText,
  selectRelevantFloridaBills,
  selectSessions,
  toCandidate,
  toDisplayNumber,
  toSourcedFloridaBill,
  type BillDetail,
  type FloridaCandidate,
  type SourcedFloridaBill,
} from "./legal-updates-florida.ts"
import { bearsOnFirmOperations } from "./legal-updates-relevance.ts"

/** The predicate the action passes in, so these tests exercise the real policy. */
const isRelevant = bearsOnFirmOperations

const candidate = (over: Partial<FloridaCandidate> = {}): FloridaCandidate => ({
  billId: 1888888,
  displayNumber: "SB 300",
  title: "Alternative Judicial Sales Procedures",
  description: "Revising procedures for judicial sales in foreclosure actions.",
  statusLabel: "Died in Rules",
  statusDate: "2026-03-13",
  chamber: "senate",
  sessionName: "2026 Regular Session",
  ...over,
})

const sourced = (over: Partial<SourcedFloridaBill> = {}): SourcedFloridaBill => ({
  displayNumber: "SB 300",
  title: "Alternative Judicial Sales Procedures",
  statusLabel: "Died in Rules",
  statusDate: "2026-03-13",
  url: "https://www.flsenate.gov/Session/Bill/2026/300",
  description: "Revising procedures for judicial sales in foreclosure actions.",
  chamber: "senate",
  sessionName: "2026 Regular Session",
  sponsors: [],
  ...over,
})

/** Shape taken from LegiScan's live `getBill` response for HB 759, trimmed to what is read. */
const DETAIL: BillDetail = {
  state_link: "https://www.flsenate.gov/Session/Bill/2026/759",
  description: "Court Fees; Revising service charges…",
  sponsors: [
    { name: "Justice Budget Subcommittee", role: "Rep", committee_sponsor: 1, sponsor_type_id: 1, sponsor_order: 1 },
    { name: "David Smith", role: "Rep", party: "R", district: "HD-038", committee_sponsor: 0, sponsor_type_id: 1, sponsor_order: 2 },
    { name: "Daniel Alvarez", role: "Rep", party: "R", district: "HD-069", committee_sponsor: 0, sponsor_type_id: 2, sponsor_order: 3 },
  ],
  history: [
    { date: "2025-12-12", action: "Filed" },
    { date: "2026-01-05", action: "Referred to Civil Justice & Claims Subcommittee" },
    { date: "2026-03-13", action: "Died in Rules" },
  ],
  votes: [
    { date: "2026-01-14", desc: "House Civil Justice &amp; Claims Subcommittee", yea: 17, nay: 0, passed: 1 },
    { date: "2026-02-25", desc: "House: Third Reading RCS#600", yea: 114, nay: 0, passed: 1 },
  ],
  sasts: [{ type: "Same As", sast_bill_number: "S532" }],
  texts: [
    { date: "2025-12-12", type: "Introduced", state_link: "https://www.flsenate.gov/Session/Bill/2026/759/BillText/Filed/PDF" },
    { date: "2026-01-22", type: "Comm Sub", state_link: "https://www.flsenate.gov/Session/Bill/2026/759/BillText/c1/PDF" },
  ],
  supplements: [
    { date: "2026-01-12", type: "Veto Letter", title: "Analysis", description: "Civil Justice &amp; Claims Subcommittee (Post-Meeting)", state_link: "https://www.flsenate.gov/Session/Bill/2026/759/Analyses/h0759.CIV.PDF" },
    { date: "2026-01-22", type: "Veto Letter", title: "Analysis", description: "Justice Budget Subcommittee (Post-Meeting)", state_link: "https://www.flsenate.gov/Session/Bill/2026/759/Analyses/h0759c.JUB.PDF" },
  ],
}

test("HTML entities in the legislature's text are decoded, not rendered", () => {
  // Live defect: HB 759 rendered "clerk&#39;s office" on the tab.
  assert.equal(decodeEntities("clerk&#39;s office &amp; fees"), "clerk's office & fees")
  assert.equal(decodeEntities("&quot;Florida Statutes&quot; &lt;2026&gt;"), '"Florida Statutes" <2026>')
  assert.equal(decodeEntities("&#x27;quoted&#x27;"), "'quoted'")
  // Something that only looks like an entity is left alone rather than eaten.
  assert.equal(decodeEntities("AT&T &unknown; stays"), "AT&T &unknown; stays")
})

test("a master-list row's text arrives decoded", () => {
  const c = toCandidate(
    {
      bill_id: 1,
      number: "H0759",
      title: "Court Fees",
      description: "Increases service charges clerk of circuit court charges for clerk&#39;s office",
      last_action: "Died in Rules &amp; Calendar",
      last_action_date: "2026-03-13",
    },
    "2026 Regular Session"
  )
  assert.equal(c?.description, "Increases service charges clerk of circuit court charges for clerk's office")
  assert.equal(c?.statusLabel, "Died in Rules & Calendar")
})

test("LegiScan's number becomes the form Florida prints", () => {
  // This is not cosmetic: the bill-identity guard reads the number back out of the rendered title
  // and looks for it on the cited flsenate.gov page, which prints "HB 11", not "H0011".
  assert.equal(toDisplayNumber("H0011"), "HB 11")
  assert.equal(toDisplayNumber("S0274"), "SB 274")
  assert.equal(toDisplayNumber("H1423"), "HB 1423")
  assert.equal(toDisplayNumber("s0956"), "SB 956")
})

test("a special-session suffix is kept, being part of the number", () => {
  // flsenate prints "HB 1F" for the first bill of a special session.
  assert.equal(toDisplayNumber("H0001F"), "HB 1F")
})

test("a number that is not a Florida bill number is refused", () => {
  assert.equal(toDisplayNumber("HR 1234"), null)
  assert.equal(toDisplayNumber(""), null)
  assert.equal(toDisplayNumber("H0000"), null)
})

test("Florida's local bills are recognised by their numbering", () => {
  // Bills in the 4000s affect one county, city or district. Of the 53 in the 2026 regular session,
  // 48 name one in the title and none is about commercial real estate.
  assert.equal(isLocalBill("HB 4051"), true)
  assert.equal(isLocalBill("HB 4999"), true)
  assert.equal(isLocalBill("SB 4000"), true)
  assert.equal(isLocalBill("HB 3999"), false)
  assert.equal(isLocalBill("HB 5000"), false)
  assert.equal(isLocalBill("SB 300"), false)
})

test("the reviser's bills are recognised by their title", () => {
  // Six of them in the 2026 session, all titled exactly this, all housekeeping. They reach the
  // relevance gate on "provisions which have become inoperative by noncurrent repeal".
  assert.equal(isReviserBill("Florida Statutes"), true)
  assert.equal(isReviserBill("  florida statutes  "), true)
  assert.equal(isReviserBill("Revision of the Florida Statutes"), true)
  // A bill that merely amends the statutes is not a reviser's bill.
  assert.equal(isReviserBill("Florida Statutes of Limitation for Foreclosure"), false)
})

test("a master-list row becomes a candidate", () => {
  // Shape taken from a live LegiScan getMasterList response.
  assert.deepEqual(
    toCandidate(
      {
        bill_id: 1888888,
        number: "S0300",
        title: "Alternative Judicial Sales Procedures",
        description: "Revising procedures for judicial sales in foreclosure actions.",
        status: 6,
        status_date: "2026-03-13",
        last_action: "Died in Rules",
        last_action_date: "2026-03-13",
      },
      "2026 Regular Session"
    ),
    candidate()
  )
})

test("the richer last action is preferred to the status integer", () => {
  // "Died in Rules" says more than "Failed", and the integer is only a fallback.
  const withAction = toCandidate(
    { bill_id: 1, number: "S0300", title: "A Bill", status: 6, last_action: "Died in Rules", last_action_date: "2026-03-13" },
    "2026 Regular Session"
  )
  assert.equal(withAction?.statusLabel, "Died in Rules")

  const withoutAction = toCandidate(
    { bill_id: 1, number: "S0300", title: "A Bill", status: 4, status_date: "2026-07-01" },
    "2026 Regular Session"
  )
  assert.equal(withoutAction?.statusLabel, "Passed")
})

test("local and reviser bills are refused at the row, not left to the relevance gate", () => {
  // They are facts about what kind of bill this is, rather than judgements about its subject.
  assert.equal(
    toCandidate(
      { bill_id: 1, number: "H4051", title: "Pace Fire Rescue District, Santa Rosa County", last_action_date: "2026-07-01" },
      "2026 Regular Session"
    ),
    null
  )
  assert.equal(
    toCandidate({ bill_id: 2, number: "S0102", title: "Florida Statutes", last_action_date: "2026-03-31" }, "2026 Regular Session"),
    null
  )
})

test("a row with nothing to date it is discarded", () => {
  assert.equal(toCandidate({ bill_id: 1, number: "S0300", title: "A Bill" }, "2026 Regular Session"), null)
  assert.equal(toCandidate({ number: "S0300", title: "A Bill", last_action_date: "2026-01-01" }, "2026 Regular Session"), null)
})

test("every session that could still hold an action in the window is searched", () => {
  // Florida runs a regular session and any number of special ones; eight fall inside 400 days.
  const sessions = [
    { session_id: 2266, session_name: "2026 Sixth Special Session", year_end: 2026 },
    { session_id: 2220, session_name: "2026 Regular Session", year_end: 2026 },
    { session_id: 2135, session_name: "2025 Regular Session", year_end: 2025 },
    { session_id: 1950, session_name: "2022 Regular Session", year_end: 2022 },
    { session_name: "no id", year_end: 2026 },
  ]
  assert.deepEqual(selectSessions(sessions, 2025), [2266, 2220, 2135])
})

test("a housing bill does not qualify on a commercial term buried in its description", () => {
  // Live case. Five of fifteen otherwise-qualifying Florida bills were housing bills that reached
  // the gate on "multifamily" or "construction loan" somewhere in the official description, and
  // residential policy was ruled out of scope.
  const kept = selectRelevantFloridaBills(
    [
      candidate(),
      candidate({
        billId: 2,
        displayNumber: "SB 1350",
        title: "Affordable Housing Property Tax Exemptions",
        description: "Providing an exemption for multifamily projects meeting certain criteria.",
      }),
    ],
    isRelevant
  )
  assert.deepEqual(
    kept.map((c) => c.displayNumber),
    ["SB 300"]
  )
})

test("the most recent bills come first, and the limit is respected", () => {
  const kept = selectRelevantFloridaBills(
    [
      candidate({ displayNumber: "SB 1", statusDate: "2026-01-01" }),
      candidate({ displayNumber: "SB 2", statusDate: "2026-09-01" }),
      candidate({ displayNumber: "SB 3", statusDate: "2026-05-01" }),
    ],
    isRelevant,
    2
  )
  assert.deepEqual(
    kept.map((c) => c.displayNumber),
    ["SB 2", "SB 3"]
  )
})

test("an item reads from the record alone when the model is not asked or fails", () => {
  assert.match(describeFloridaFromRecord(sourced()), /^Revising procedures for judicial sales/)
  const bare = sourced({ description: undefined })
  assert.match(describeFloridaFromRecord(bare), /SB 300, Alternative Judicial Sales Procedures/)
  assert.match(describeFloridaFromRecord(bare), /Status as of 2026-03-13: Died in Rules/)
})

test("the summary prompt supplies the facts and asks the model not to touch them", () => {
  const prompt = buildFloridaSummaryPrompt([sourced()])
  assert.match(prompt, /SB 300/)
  assert.match(prompt, /do not restate, correct or change them/)
  assert.match(prompt, /Official description: Revising procedures/)
  assert.doesNotMatch(prompt, /\bsearch\b/i)
})

test("the prompt requires a bill that died to be described as having died", () => {
  // Most of what survives the gate over a full window is legislation that failed, and a summary
  // that reads as though it were law would be the most damaging thing this section could print.
  assert.match(buildFloridaSummaryPrompt([sourced()]), /say plainly that it did not pass/)
})

// ── The rest of the record ─────────────────────────────────────────────────────

test("primary sponsors are named as a reader would, co-sponsors are not", () => {
  // HB 759 carries ten sponsors; two are primary and one of those is a committee.
  assert.deepEqual(describeSponsors(DETAIL.sponsors), ["Justice Budget Subcommittee", "Rep. David Smith (R, HD-038)"])
  assert.deepEqual(describeSponsors(undefined), [])
})

test("the last roll call is the one that says how far the bill got", () => {
  // Live: HB 759 passed the House 114–0 and then died in Senate Rules. The vote is the story.
  const vote = selectLastVote(DETAIL.votes)
  assert.deepEqual(vote, { description: "House: Third Reading RCS#600", yea: 114, nay: 0, date: "2026-02-25", passed: true })
  assert.equal(selectLastVote([]), undefined)
})

test("the latest text, companion and analysis are picked out and cited to flsenate", () => {
  assert.deepEqual(selectLatestText(DETAIL.texts), {
    type: "Comm Sub",
    date: "2026-01-22",
    url: "https://www.flsenate.gov/Session/Bill/2026/759/BillText/c1/PDF",
  })
  assert.equal(selectCompanion(DETAIL.sasts), "SB 532")
  // LegiScan mislabels Florida's analyses as "Veto Letter"; the title and the path say what they are.
  assert.deepEqual(selectLatestAnalysis(DETAIL.supplements), {
    description: "Justice Budget Subcommittee (Post-Meeting)",
    date: "2026-01-22",
    url: "https://www.flsenate.gov/Session/Bill/2026/759/Analyses/h0759c.JUB.PDF",
  })
})

test("a sourced bill carries the whole record, and still needs the legislature's link", () => {
  const bill = toSourcedFloridaBill(candidate({ displayNumber: "HB 759", title: "Court Fees", chamber: "house" }), DETAIL)!
  assert.equal(bill.url, "https://www.flsenate.gov/Session/Bill/2026/759")
  assert.equal(bill.filedOn, "2025-12-12")
  assert.equal(bill.companion, "SB 532")
  assert.equal(bill.lastVote?.yea, 114)
  assert.equal(bill.analysis?.date, "2026-01-22")
  assert.equal(toSourcedFloridaBill(candidate(), { ...DETAIL, state_link: undefined }), null)
  assert.equal(toSourcedFloridaBill(candidate(), undefined), null)
})

test("the record's facts are listed as a reader would cite them", () => {
  const bill = toSourcedFloridaBill(candidate({ displayNumber: "HB 759", title: "Court Fees", chamber: "house" }), DETAIL)!
  assert.deepEqual(
    describeFloridaRecord(bill).map((f) => [f.label, f.value]),
    [
      ["Sponsors", "Justice Budget Subcommittee; Rep. David Smith (R, HD-038)"],
      ["Filed", "2025-12-12"],
      ["Companion", "SB 532"],
      ["Last vote", "House: Third Reading RCS#600: 114–0 (2026-02-25)"],
      ["Text", "Comm Sub (2026-01-22)"],
      ["Staff analysis", "Justice Budget Subcommittee (Post-Meeting) (2026-01-22)"],
    ]
  )
  assert.equal(describeFloridaRecord(bill).find((f) => f.label === "Text")?.url, DETAIL.texts![1].state_link)
  assert.deepEqual(describeFloridaRecord(sourced()), [], "a bare record has no facts to list")
})

test("a failed vote says so", () => {
  const facts = describeFloridaRecord(
    sourced({ lastVote: { description: "Senate: Third Reading", yea: 10, nay: 28, date: "2026-03-01", passed: false } })
  )
  assert.equal(facts[0].value, "Senate: Third Reading: 10–28, failed (2026-03-01)")
})

test("the House's page furniture is not part of the analysis", () => {
  // Shape taken from pdf-parse's output for h0759c.JUB.PDF.
  const raw = [
    "STORAGE NAME: h0759c.JUB",
    "DATE: 1/22/2026 1",
    "FLORIDA HOUSE OF REPRESENTATIVES",
    "BILL ANALYSIS",
    "SUMMARY",
    "Effect of the Bill:",
    "HB 759 increases certain service charges which the Clerks of the Circuit Court may impose.",
    "JUMP TO SUMMARY ANALYSIS RELEVANT INFORMATION BILL HISTORY",
    "ANALYSIS",
    "EFFECT OF THE BILL:",
  ].join("\n")
  const cleaned = cleanAnalysisText(raw)
  assert.doesNotMatch(cleaned, /JUMP TO/)
  assert.doesNotMatch(cleaned, /STORAGE NAME/)
  assert.doesNotMatch(cleaned, /^DATE: 1\/22/m)
  assert.match(cleaned, /HB 759 increases certain service charges/)
  assert.match(cleaned, /EFFECT OF THE BILL:/)
})

test("the analysis is fetched through the parser it is given, and a bill without one gets nothing", async () => {
  const noAnalysis = sourced()
  assert.equal(await fetchFloridaAnalysisText(noAnalysis, async () => "never called"), undefined)
  // A parser that throws leaves the bill on its description rather than failing the section.
  const withAnalysis = sourced({ analysis: { description: "Judiciary", date: "2026-02-10", url: "https://www.flsenate.gov/Session/Bill/2026/300/Analyses/x.PDF" } })
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })) as typeof fetch
  try {
    assert.equal(await fetchFloridaAnalysisText(withAnalysis, async () => { throw new Error("bad pdf") }), undefined)
    assert.equal(await fetchFloridaAnalysisText(withAnalysis, async () => "STORAGE NAME: x\nThe bill does a thing."), "The bill does a thing.")
  } finally {
    globalThis.fetch = original
  }
})

test("the prompt carries the analysis when there is one, and asks for details only then", () => {
  const texts = new Map([["SB 300", "SUMMARY\nEffect of the Bill:\nThe bill revises judicial sales."]])
  const prompt = buildFloridaSummaryPrompt([sourced(), sourced({ displayNumber: "HB 1", title: "Other" })], texts)
  assert.match(prompt, /Legislative staff analysis:/)
  assert.match(prompt, /The bill revises judicial sales\./)
  assert.match(prompt, /Where no analysis is given, return an empty list; never fill it from memory/)
  const second = prompt.slice(prompt.indexOf("- HB 1"))
  assert.doesNotMatch(second, /Legislative staff analysis/)
})

// ── Dead bills ─────────────────────────────────────────────────────────────────

test("the clerk's phrasings for a bill that lapsed are recognised", () => {
  for (const s of ["Died in Rules", "Died in Judiciary Committee", "Indefinitely postponed and withdrawn from consideration", "Failed", "Vetoed by Governor"]) {
    assert.ok(isDeadStatus(s), s)
  }
  for (const s of ["Introduced", "Engrossed", "Chapter No. 2026-207", "Referred to Judiciary", undefined]) {
    assert.equal(isDeadStatus(s), false, String(s))
  }
})

test("the section is told when every Florida bill on it is dead, and not otherwise", () => {
  const note = describeFloridaSessionState([
    { status: "Died in Rules", date: "2026-03-13" },
    { status: "Died in Judiciary", date: "2026-03-13" },
  ])
  assert.match(note ?? "", /2026 session has ended/)
  assert.match(note ?? "", /Filing for the 2027 session usually opens in the autumn/)
  assert.equal(describeFloridaSessionState([{ status: "Died in Rules", date: "2026-03-13" }, { status: "Introduced", date: "2026-09-20" }]), undefined)
  assert.equal(describeFloridaSessionState([]), undefined)
})

test("a dead bill's intent line is written from its record, and says how far it got", () => {
  // HB 759 passed the House 114–0 and died in Senate Rules — the strongest signal a dead bill gives.
  const passedHouse = toSourcedFloridaBill(candidate({ displayNumber: "HB 759", title: "Court Fees", chamber: "house" }), DETAIL)!
  assert.equal(
    describeIntent(passedHouse),
    "Passed the House 114–0 on 2026-02-25, then died in Rules. A bill that clears one chamber is commonly refiled. Companion SB 532 in the other chamber."
  )
  // Cleared a committee only.
  assert.equal(
    describeIntent(sourced({ statusLabel: "Died in Judiciary Committee", lastVote: { description: "House Civil Justice & Claims Subcommittee", yea: 14, nay: 3, date: "2026-01-29", passed: true } })),
    "Cleared House Civil Justice & Claims Subcommittee 14–3 on 2026-01-29, then died in Judiciary Committee."
  )
  // Never heard.
  assert.equal(describeIntent(sourced({ filedOn: "2025-10-28" })), "Filed 2025-10-28; died in Rules without a hearing or a vote.")
  // A live bill has no intent line; its status is the story.
  assert.equal(describeIntent(sourced({ statusLabel: "Referred to Judiciary" })), undefined)
})
