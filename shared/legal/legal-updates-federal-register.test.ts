import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildRuleSummaryPrompt,
  cleanRuleText,
  dedupeRules,
  describeAgencies,
  describeCfrReference,
  describeRuleFromRecord,
  describeRuleRecord,
  normalizeRuleTitle,
  selectRelevantRules,
  selectRuleText,
  splitRuleSections,
  summariseCfrReferences,
  toSourcedRule,
  type SourcedRule,
} from "./legal-updates-federal-register.ts"
import { bearsOnFirmOperations } from "./legal-updates-relevance.ts"

/** The predicate the action passes in, so these tests exercise the real policy. */
const isRelevant = bearsOnFirmOperations

const rule = (over: Partial<SourcedRule> = {}): SourcedRule => ({
  documentNumber: "2026-10036",
  title: "Real Estate Lending Escrow Accounts",
  type: "Rule",
  agencies: ["Treasury Department", "Comptroller of the Currency"],
  publicationDate: "2026-06-29",
  url: "https://www.federalregister.gov/documents/2026/06/29/2026-10036/real-estate-lending-escrow-accounts",
  abstract: "The OCC is issuing a final rule to codify longstanding powers of national banks.",
  // Spelled out so the fixture has the same keys as a parsed record, which `deepEqual` compares.
  effectiveOn: undefined,
  commentsCloseOn: undefined,
  action: undefined,
  citation: undefined,
  cfrReferences: [],
  docketIds: [],
  rins: [],
  pageLength: undefined,
  pdfUrl: undefined,
  rawTextUrl: undefined,
  correctionOf: undefined,
  ...over,
})

test("a record entry becomes a sourced rule", () => {
  // Shape taken from a live Federal Register response.
  const sourced = toSourcedRule({
    document_number: "2026-10036",
    title: "Real Estate Lending Escrow Accounts",
    type: "Rule",
    publication_date: "2026-06-29",
    html_url:
      "https://www.federalregister.gov/documents/2026/06/29/2026-10036/real-estate-lending-escrow-accounts",
    agencies: [{ name: "Treasury Department" }, { name: "Comptroller of the Currency" }],
    abstract: "The OCC is issuing a final rule to codify longstanding powers of national banks.",
    effective_on: "2026-07-29",
    comments_close_on: null,
  })
  assert.deepEqual(sourced, { ...rule(), effectiveOn: "2026-07-29" })
})

test("the record's detail fields are carried, in a reader's form", () => {
  // Shape taken from the live record for 2026-10036.
  const sourced = toSourcedRule({
    document_number: "2026-10036",
    title: "Real Estate Lending Escrow Accounts",
    type: "Rule",
    publication_date: "2026-05-19",
    html_url: "https://www.federalregister.gov/documents/2026/05/19/2026-10036/real-estate-lending-escrow-accounts",
    action: "Final rule.",
    citation: "91 FR 29340",
    cfr_references: [
      { chapter: null, part: "34", title: 12 },
      { chapter: null, part: "160", title: 12 },
    ],
    docket_ids: ["Docket ID OCC-2025-0736"],
    regulation_id_numbers: ["1557-AF46"],
    page_length: 8,
    pdf_url: "https://www.govinfo.gov/content/pkg/FR-2026-05-19/pdf/2026-10036.pdf",
    raw_text_url: "https://www.federalregister.gov/documents/full_text/text/2026/05/19/2026-10036.txt",
    correction_of: null,
  })!
  assert.equal(sourced.action, "Final rule")
  assert.equal(sourced.citation, "91 FR 29340")
  assert.deepEqual(sourced.cfrReferences, ["12 CFR Part 34", "12 CFR Part 160"])
  assert.deepEqual(sourced.docketIds, ["OCC-2025-0736"])
  assert.deepEqual(sourced.rins, ["1557-AF46"])
  assert.equal(sourced.pageLength, 8)
  assert.equal(sourced.correctionOf, undefined)
})

test("a correction notice names the document it corrects", () => {
  const sourced = toSourcedRule({
    document_number: "C1-2026-10036",
    title: "Real Estate Lending Escrow Accounts",
    publication_date: "2026-06-29",
    html_url: "https://www.federalregister.gov/documents/2026/06/29/C1-2026-10036/real-estate-lending-escrow-accounts",
    correction_of: "https://www.federalregister.gov/api/v1/documents/2026-10036",
  })!
  assert.equal(sourced.correctionOf, "2026-10036")
})

test("a chapter-level CFR reference is described by chapter", () => {
  assert.equal(describeCfrReference({ title: 12, part: null, chapter: "XV" }), "12 CFR Chapter XV")
  assert.equal(describeCfrReference({ title: null, part: "1" }), null)
})

test("the original wins over its correction, and records that it was corrected", () => {
  // Live case: C1-2026-10036 is a one-page typographical correction with no abstract and 197
  // words of text. Letting the later date win put the correction's text up as the rule's.
  const original = rule({
    documentNumber: "2026-10036",
    publicationDate: "2026-05-19",
    citation: "91 FR 29340",
    rawTextUrl: "https://www.federalregister.gov/documents/full_text/text/2026/05/19/2026-10036.txt",
  })
  const correction = rule({
    documentNumber: "C1-2026-10036",
    publicationDate: "2026-06-29",
    url: "https://www.federalregister.gov/documents/2026/06/29/C1-2026-10036/real-estate-lending-escrow-accounts",
    abstract: undefined,
    correctionOf: "2026-10036",
  })
  for (const order of [[original, correction], [correction, original]]) {
    const deduped = dedupeRules(order)
    assert.equal(deduped.length, 1)
    assert.equal(deduped[0].documentNumber, "2026-10036")
    assert.equal(deduped[0].publicationDate, "2026-05-19")
    assert.equal(deduped[0].rawTextUrl, original.rawTextUrl)
    assert.equal(deduped[0].correctedOn, "2026-06-29")
    assert.equal(deduped[0].correctionUrl, correction.url)
  }
})

test("an entry missing anything that identifies the document is discarded", () => {
  const base = {
    document_number: "2026-1",
    title: "A Rule",
    publication_date: "2026-01-01",
    html_url: "https://www.federalregister.gov/documents/2026/01/01/2026-1/a-rule",
  }
  assert.equal(toSourcedRule({ ...base, document_number: undefined }), null)
  assert.equal(toSourcedRule({ ...base, title: undefined }), null)
  assert.equal(toSourcedRule({ ...base, publication_date: undefined }), null)
  assert.equal(toSourcedRule({ ...base, html_url: undefined }), null)
})

test("a null comment deadline does not become the string 'null'", () => {
  // The API sends JSON null rather than omitting the field, and `"null".slice(0, 10)` is truthy.
  const sourced = toSourcedRule({
    document_number: "2026-2",
    title: "A Rule",
    publication_date: "2026-01-01",
    html_url: "https://www.federalregister.gov/x",
    comments_close_on: null,
    effective_on: null,
  })
  assert.equal(sourced?.commentsCloseOn, undefined)
  assert.equal(sourced?.effectiveOn, undefined)
})

test("one rule republished under two document numbers appears once, at the later date", () => {
  // Live case: "Real Estate Lending Escrow Accounts" was published on 2026-05-19 under the
  // Treasury Department and again on 2026-06-29 under Treasury and the Comptroller.
  const deduped = dedupeRules([
    rule({ documentNumber: "2026-10036", publicationDate: "2026-05-19", agencies: ["Treasury Department"] }),
    rule({ documentNumber: "2026-13000", publicationDate: "2026-06-29" }),
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].publicationDate, "2026-06-29")
})

test("the abstract survives deduplication even when the later record lacks one", () => {
  // Live defect: the 2026-06-29 republication of the escrow rule carried no abstract, and the tab
  // summarised a real OCC rule as "No agency abstract was published for this rule".
  const deduped = dedupeRules([
    rule({ documentNumber: "2026-10036", publicationDate: "2026-05-19", abstract: "The OCC is issuing a final rule." }),
    rule({ documentNumber: "2026-13000", publicationDate: "2026-06-29", abstract: undefined }),
  ])
  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].documentNumber, "2026-13000")
  assert.equal(deduped[0].abstract, "The OCC is issuing a final rule.")
})

test("a later record with its own abstract keeps it", () => {
  const deduped = dedupeRules([
    rule({ documentNumber: "a", publicationDate: "2026-05-19", abstract: "Old wording." }),
    rule({ documentNumber: "b", publicationDate: "2026-06-29", abstract: "Corrected wording." }),
  ])
  assert.equal(deduped[0].abstract, "Corrected wording.")
})

test("the prompt forbids the model from writing about a missing abstract", () => {
  assert.match(buildRuleSummaryPrompt([rule({ abstract: undefined })]), /never mention that an abstract is missing/)
})

test("the same document reached by two searches appears once", () => {
  assert.equal(dedupeRules([rule(), rule(), rule()]).length, 1)
})

test("titles differing only in punctuation are one rule", () => {
  assert.equal(
    normalizeRuleTitle("Real Estate Lending: Escrow Accounts"),
    normalizeRuleTitle("Real Estate Lending — Escrow Accounts")
  )
})

test("relevance is judged on the title and the agency's own abstract", () => {
  const kept = selectRelevantRules(
    [
      rule(),
      // Live false positive: the search for "commercial real estate" returns this because the
      // phrase appears somewhere in the document. Neither its title nor its abstract is about it.
      rule({
        documentNumber: "2026-18164",
        title: "Driving Efficiency in Farm Loan Delivery",
        agencies: ["Farm Service Agency"],
        abstract:
          "The Farm Service Agency is amending the Farm Loan Program regulations to permanently implement changes.",
      }),
    ],
    isRelevant
  )
  assert.deepEqual(
    kept.map((r) => r.documentNumber),
    ["2026-10036"]
  )
})

test("an Office of Personnel Management staff-review rule is not an appraisal rule", () => {
  // Live false positive, and the reason "performance appraisal" is an excluded subject: the term
  // `appraisal` is real but this is about federal employees' annual reviews.
  const kept = selectRelevantRules(
    [
      rule({
        documentNumber: "2026-14000",
        title: "Performance Appraisal for General Schedule and Prevailing Rate Employees",
        agencies: ["Personnel Management Office"],
        abstract: "OPM is revising its regulations on performance appraisal systems.",
      }),
    ],
    isRelevant
  )
  assert.deepEqual(kept, [])
})

test("the most recent rules come first, and the limit is respected", () => {
  const kept = selectRelevantRules(
    [
      rule({ documentNumber: "a", publicationDate: "2026-01-01" }),
      rule({ documentNumber: "b", publicationDate: "2026-09-01" }),
      rule({ documentNumber: "c", publicationDate: "2026-05-01" }),
    ],
    isRelevant,
    2
  )
  assert.deepEqual(
    kept.map((r) => r.publicationDate),
    ["2026-09-01", "2026-05-01"]
  )
})

test("the specific agency is named rather than the parent department", () => {
  // "Treasury Department, Comptroller of the Currency" is one issuer described twice.
  assert.equal(describeAgencies(rule()), "Comptroller of the Currency")
  assert.equal(describeAgencies(rule({ agencies: [] })), "Federal Register")
})

test("an item reads from the record alone when the model is not asked or fails", () => {
  // The agency's abstract is the description when there is one.
  assert.match(describeRuleFromRecord(rule()), /^The OCC is issuing a final rule/)
})

test("a rule with no abstract still describes itself, with the date that matters", () => {
  const proposed = rule({
    abstract: undefined,
    type: "Proposed Rule",
    commentsCloseOn: "2026-08-31",
  })
  const described = describeRuleFromRecord(proposed)
  assert.match(described, /Proposed Rule issued by Comptroller of the Currency/)
  // A comment deadline is the actionable date on a proposed rule, so it wins over the effective one.
  assert.match(described, /Comments close 2026-08-31/)
})

test("the summary prompt supplies the facts and asks the model not to touch them", () => {
  const prompt = buildRuleSummaryPrompt([rule()])
  assert.match(prompt, /2026-10036/)
  assert.match(prompt, /do not restate, correct or change them/)
  assert.match(prompt, /Agency abstract: The OCC is issuing/)
  // There is nothing to look up, so nothing should send the model to the web.
  assert.doesNotMatch(prompt, /\bsearch\b/i)
})

test("the prompt tells the model not to go beyond the abstract it was given", () => {
  // Otherwise a thin abstract invites the model to fill the gap from memory, which is the whole
  // failure this module exists to avoid.
  assert.match(buildRuleSummaryPrompt([rule()]), /do not introduce facts they do not contain/)
})

// ── Full text ──────────────────────────────────────────────────────────────────

/** The shape of the Federal Register's plain text: a contents list, then the body under the same headings. */
const DOCUMENT = `
SUMMARY: The OCC is issuing a final rule.

DATES: This final rule is effective on June 18, 2026.

SUPPLEMENTARY INFORMATION:

Table of Contents

I. Introduction
II. Background
    A. History
    B. Authority and the long and winding statutory road that brought the agency to this point
    C. Prior Rulemakings and their reception by the industry and by the public at large
III. Description of the Final Rule
IV. Administrative Law Matters

I. Introduction

Real estate lending has been core to the business of national banks for over 100 years.
[[Page 29341]]
Banks are a key pillar supporting commercial real estate in the United States.

II. Background

A. History

The statute was enacted in 1864.<SUP>1</SUP> It has been amended many times.

I. Nested Point

This is a sub-sub-section whose numeral restarts, and it belongs to Background.

III. Description of the Final Rule

The final rule codifies the authority of banks to establish escrow accounts and to set their
terms, including whether to pay interest on balances.

IV. Administrative Law Matters

The Paperwork Reduction Act does not apply.

List of Subjects in 12 CFR Part 34

Banks, banking.
`

test("the contents list is recognised by its headings repeating, not by its length", () => {
  // The list carries lettered sub-entries that run to paragraphs, so a gap-based test called the
  // list's "IV." the first body heading and the real "I. Introduction" a sub-section of it.
  const sections = splitRuleSections(cleanRuleText(DOCUMENT))
  assert.deepEqual(
    sections.map((s) => s.heading),
    ["Introduction", "Background", "Description of the Final Rule", "Administrative Law Matters"]
  )
})

test("a sub-section whose numeral restarts stays inside its parent", () => {
  const sections = splitRuleSections(cleanRuleText(DOCUMENT))
  const background = sections.find((s) => s.heading === "Background")!
  assert.match(background.body, /Nested Point/)
  assert.match(background.body, /belongs to Background/)
})

test("page markers and footnote markup are not part of the rule", () => {
  const cleaned = cleanRuleText(DOCUMENT)
  assert.doesNotMatch(cleaned, /\[\[Page/)
  assert.doesNotMatch(cleaned, /<SUP>/)
  assert.match(cleaned, /enacted in 1864\.1 It has/)
})

test("the explanatory section is chosen first and the procedural one not at all", () => {
  const selected = selectRuleText(DOCUMENT)
  assert.match(selected, /Description of the Final Rule/)
  assert.match(selected, /codifies the authority of banks/)
  assert.match(selected, /Introduction/)
  assert.doesNotMatch(selected, /Paperwork Reduction Act/, "administrative matters are procedure")
  assert.doesNotMatch(selected, /Banks, banking\./, "the regulatory text after List of Subjects is cut")
  // Read in document order once chosen.
  assert.ok(selected.indexOf("Introduction") < selected.indexOf("Description of the Final Rule"))
})

test("the word cap truncates the lowest-ranked text, visibly", () => {
  const selected = selectRuleText(DOCUMENT, 30)
  assert.match(selected, /codifies the authority/, "the explanatory section survives a tight cap")
  assert.match(selected, /\[…\]/)
  assert.ok(selected.split(/\s+/).length < 60)
})

test("a document with no headings is taken from the top", () => {
  const flat = "SUPPLEMENTARY INFORMATION: The agency is amending one paragraph. That is all it does."
  assert.equal(selectRuleText(flat), "The agency is amending one paragraph. That is all it does.")
})

test("the record's facts are listed as a reader would cite them", () => {
  const facts = describeRuleRecord(
    rule({
      action: "Final rule",
      citation: "91 FR 29340",
      cfrReferences: ["12 CFR Part 34", "12 CFR Part 160"],
      docketIds: ["OCC-2025-0736"],
      rins: ["1557-AF46"],
      pageLength: 8,
      pdfUrl: "https://www.govinfo.gov/content/pkg/FR-2026-05-19/pdf/2026-10036.pdf",
      correctedOn: "2026-06-29",
      correctionUrl: "https://www.federalregister.gov/documents/2026/06/29/C1-2026-10036/x",
    })
  )
  assert.deepEqual(
    facts.map((f) => [f.label, f.value]),
    [
      ["Action", "Final rule"],
      ["Citation", "91 FR 29340"],
      ["Amends", "12 CFR Parts 34 and 160"],
      ["Docket", "OCC-2025-0736"],
      ["RIN", "1557-AF46"],
      ["Length", "8 pages"],
      ["Corrected", "2026-06-29"],
      ["Official PDF", "govinfo.gov"],
    ]
  )
  assert.equal(facts.find((f) => f.label === "Corrected")?.url, "https://www.federalregister.gov/documents/2026/06/29/C1-2026-10036/x")
  assert.deepEqual(describeRuleRecord(rule()), [], "a bare record has no facts to list")
})

test("CFR references to one title are summarised together", () => {
  assert.equal(summariseCfrReferences(["12 CFR Part 34"]), "12 CFR Part 34")
  assert.equal(summariseCfrReferences(["12 CFR Part 34", "12 CFR Part 160"]), "12 CFR Parts 34 and 160")
  assert.equal(
    summariseCfrReferences(["12 CFR Part 5", "12 CFR Part 24", "12 CFR Part 25", "26 CFR Part 1"]),
    "12 CFR Parts 5, 24 and 25; 26 CFR Part 1"
  )
})

test("the prompt carries the document's text when there is one, and asks for details only then", () => {
  const texts = new Map([["2026-10036", "Description of the Final Rule\nThe final rule codifies…"]])
  const prompt = buildRuleSummaryPrompt([rule(), rule({ documentNumber: "2026-99999", title: "Another" })], texts)
  assert.match(prompt, /Explanatory text from the document:/)
  assert.match(prompt, /The final rule codifies…/)
  assert.match(prompt, /Where no text is given, return an empty list; never fill it from memory/)
  // The second rule has no text, and the prompt must not pretend otherwise for it.
  const second = prompt.slice(prompt.indexOf("2026-99999"))
  assert.doesNotMatch(second, /Explanatory text from the document/)
})
