import assert from "node:assert/strict"
import { test } from "node:test"

import {
  bearsOnFirmOperations,
  isCreRelevant,
  isEnforcementDigest,
  isIndividualAction,
  partitionByRelevance,
} from "./legal-updates-relevance.ts"
import { LEGAL_SECTIONS, SECTION_LABELS, windowFor } from "./legal-updates-sections.ts"

test("keeps an item whose CRE bearing is only in the summary", () => {
  assert.ok(
    isCreRelevant({
      title: "Interagency Statement on Loan Accommodations",
      summary: "Guidance for banks working with borrowers on commercial real estate loans.",
    })
  )
})

// This suite previously asserted the opposite: that an item relevant *only* in `whyItMatters` was
// kept. That was the defect. The prompt tells the model to write that field about "relevance to
// distressed CRE debt investing", so reading it asked the model to certify its own item, and the
// gate passed essentially everything it was shown.
test("an item relevant only in whyItMatters is not kept on the model's own say-so", () => {
  assert.equal(
    isCreRelevant({
      title: "OCC Bulletin 2026-14",
      whyItMatters: "Raises the appraisal threshold for CRE-secured credit.",
    }),
    false
  )
})

test("the item a user reported as noise is rejected", () => {
  // Verbatim from the dev feed, with a whyItMatters of the kind the prompt asks for.
  const item = {
    title: "OCC Enforcement Action: Danny Seibel Prohibited from Banking Activities",
    summary:
      "The OCC issued a prohibition order against Danny Seibel, a former employee of a national bank, barring him from participating in the affairs of any insured depository institution.",
    whyItMatters:
      "Individual accountability actions signal heightened OCC scrutiny of bank operations, which can affect how lenders manage their CRE loan portfolios and workout negotiations.",
    status: "Prohibition Order",
  }
  assert.equal(bearsOnFirmOperations(item), false)
  assert.ok(isIndividualAction(item), "a prohibition order is an action against a person")
})

test("an individual action is dropped even when it does discuss CRE lending", () => {
  // The conduct behind an 8(e) order often involved the CRE book. It is still a ruling about one
  // person's employability, so topic alone must not be enough to carry it.
  const item = {
    title: "FDIC Issues Removal and Prohibition Order",
    summary:
      "The order concerns a former loan officer who falsified appraisals on commercial real estate loans.",
  }
  assert.ok(isCreRelevant(item), "the topic gate sees the CRE lending")
  assert.equal(bearsOnFirmOperations(item), false, "but it is still about one individual")
})

test("an institution-level consent order on CRE concentration is kept", () => {
  // The guard must not take the whole Enforcement section with it.
  assert.ok(
    bearsOnFirmOperations({
      title: "FDIC Announces Consent Order With Community Bank of the Gulf",
      summary:
        "The order requires the bank to reduce its commercial real estate concentration and strengthen credit administration.",
      status: "Consent Order Issued",
    })
  )
})

test("word-boundary anchoring keeps out client, resilience and lieutenant", () => {
  // `lien` as a bare substring admitted all three of the first group; `tenant` admitted the last.
  const noise = [
    "OCC Reports Improvement in Bank Client Satisfaction Survey",
    "FDIC Announces Resilience Exercise for Community Institutions",
    "SEC Charges Investment Adviser With Defrauding Retail Clients",
    "Lieutenant Colonel Sentenced for Procurement Fraud",
  ]
  for (const title of noise) {
    assert.equal(isCreRelevant({ title }), false, title)
  }
  // The words the anchors exist to protect still match.
  assert.ok(isCreRelevant({ title: "Florida bill on lien priority for construction lenders" }))
  assert.ok(isCreRelevant({ title: "Buyer takes title subject to existing liens" }))
})

test("residential and land-use policy is out of scope", () => {
  const outOfScope = [
    { title: "HUD Awards Grants to Support Homeless Youth Services" },
    { title: "Florida Bill Revises Residential Landlord and Tenant Act", summary: "Changes notice periods for residential evictions." },
    { title: "County Zoning Overhaul Advances", summary: "Rewrites single-family land use categories." },
  ]
  for (const item of outOfScope) {
    assert.equal(bearsOnFirmOperations(item), false, item.title)
  }
  // Multifamily is an asset class here, not housing policy, so it stays in.
  assert.ok(bearsOnFirmOperations({ title: "Fed guidance on multifamily loan workouts" }))
})

test("bare 'default' no longer admits default judgments", () => {
  assert.equal(isCreRelevant({ title: "Court Enters Default Judgment in Trademark Suit" }), false)
  assert.ok(isCreRelevant({ title: "Guidance on servicing a borrower default" }))
})

test("drops a consumer-banking item with no CRE bearing anywhere", () => {
  assert.equal(
    isCreRelevant({
      title: "CFPB Finalizes Overdraft Fee Rule",
      summary: "Caps overdraft fees charged on consumer deposit accounts.",
      whyItMatters: "Affects retail fee income at large banks.",
    }),
    false
  )
})

test("drops an individual prohibition order that never mentions lending", () => {
  assert.equal(
    isCreRelevant({
      title: "FDIC Issues Prohibition Order Against Former Teller",
      summary: "Order follows misappropriation of customer funds at a branch.",
    }),
    false
  )
})

test("partition returns both halves and loses nothing", () => {
  const items = [
    { title: "Florida bill on foreclosure procedure" },
    { title: "CFPB overdraft fee rule" },
    { title: "Fed guidance on multifamily loan workouts" },
  ]
  const { relevant, irrelevant } = partitionByRelevance(items)
  assert.equal(relevant.length, 2)
  assert.equal(irrelevant.length, 1)
  assert.equal(relevant.length + irrelevant.length, items.length)
})

test("legislative gets a wider window than the other two", () => {
  // A state legislature is out of session most of the year. A 180-day window emptied the section
  // between sessions even though the session's own laws were still the current law.
  const legislative = windowFor("legislative")
  assert.ok(legislative.promptDays > windowFor("regulatory").promptDays)
  assert.ok(legislative.filterDays >= 365, "must span a full annual session cycle")
})

test("every section has a window and a label", () => {
  for (const section of LEGAL_SECTIONS) {
    const { promptDays, filterDays } = windowFor(section)
    assert.ok(promptDays > 0)
    assert.ok(filterDays >= promptDays, "the filter must not be tighter than what the prompt asked for")
    assert.ok(SECTION_LABELS[section].length > 0)
  }
})

// ── Where a term sits ──────────────────────────────────────────────────────────
//
// A heading is read on every term; a body only on the core ones. These began as a stricter gate
// for record-sourced items and became the only gate when the model path admitted a stablecoin
// proposal on "capital requirements" in its body.

test("an incidental term in the title is the subject, and qualifies", () => {
  // `bankrupt` is incidental because a court-procedure bill mentions bankruptcy in passing. In a
  // title chosen to say what the thing is about, it is the thing it is about — and subchapter V
  // debt limits genuinely bear on how a workout is negotiated.
  assert.equal(
    bearsOnFirmOperations({ title: "Bankruptcy Threshold Adjustment Act" }),
    true
  )
})

test("an incidental term buried in a long description does not qualify", () => {
  // A bill about who files what with whom, which mentions liens on its way past. This is the case
  // that gating on any term anywhere got wrong: it kept 32 Florida bills where 6 were the subject.
  assert.equal(
    bearsOnFirmOperations({
      title: "Determination of Mental Conditions in Judicial Proceedings",
      summary:
        "Revising procedures for the appointment of experts; conforming cross-references to the "
        + "chapter governing liens and encumbrances recorded before the hearing date.",
    }),
    false
  )
})

test("a core term in boilerplate is why local bills are excluded by number, not by subject", () => {
  // This gate cannot catch Florida's local bills, and it is worth a test saying so. The charter
  // boilerplate for a fire district really does describe assessments against industrial property,
  // which is a core term meaning exactly what it says — the bill is simply not legislation anyone
  // here can act on. `isLocalBill` is what excludes it, on the numbering.
  assert.equal(
    bearsOnFirmOperations({
      title: "Pace Fire Rescue District, Santa Rosa County",
      summary:
        "Codifying the charter of the district; providing for the levy of assessments which shall "
        + "constitute a lien against industrial properties within the district until paid.",
    }),
    true
  )
})

test("a core term in the description qualifies, wherever it sits", () => {
  // "Court Fees" says nothing on its own; the description is where the legislature says the fees
  // are foreclosure fees.
  assert.equal(
    bearsOnFirmOperations({
      title: "Court Fees",
      summary: "Revising the service charges collected by clerks in foreclosure proceedings.",
    }),
    true
  )
})

test("a housing bill is out of scope however commercial its description sounds", () => {
  // Residential policy was ruled out of scope. Dropping the residential terms from the relevance
  // list stopped these being admitted on their own subject but not through a body that mentions
  // something commercial, so the title carries an exclusion of its own.
  assert.equal(
    bearsOnFirmOperations({
      title: "Affordable Housing Property Tax Exemptions",
      summary: "Providing an exemption for multifamily projects meeting certain criteria.",
    }),
    false
  )
})

test("a staff-review rule is not an appraisal rule", () => {
  // Live false positive from the Federal Register, and the one place a term had to be excluded as
  // a phrase rather than qualified.
  assert.equal(
    bearsOnFirmOperations({
      title: "Performance Appraisal for General Schedule and Prevailing Rate Employees",
      summary: "OPM is revising its regulations on performance appraisal systems.",
    }),
    false
  )
})

test("an action against an individual is still out, record or not", () => {
  // The one rule both gates share, and for the same reason: it is a ruling about one person's
  // employability whatever the underlying conduct involved.
  assert.equal(
    bearsOnFirmOperations({
      title: "Notice of Prohibition Order",
      summary: "Removal and prohibition order concerning a former loan officer's commercial mortgage file.",
    }),
    false
  )
})

test("a stablecoin proposal does not qualify on 'capital requirements' in its body", () => {
  // Live case from the model path, and the reason there is one gate rather than two.
  assert.equal(
    bearsOnFirmOperations({
      title:
        "Federal Reserve Board requests public comment on two proposals related to establishing a regulatory framework for Board-supervised payment stablecoin issuers under the GENIUS Act",
      summary:
        "The second proposal introduces standardized capital requirements and risk management standards to address credit and operational risks associated with payment stablecoin activities.",
    }),
    false
  )
})

test("the status is read as a heading", () => {
  // "Receivership Appointed" is two words the publisher chose; it is not a body.
  assert.equal(
    bearsOnFirmOperations({
      title: "Sunwest Bank Assumes All Deposits of Nano Banc",
      status: "Receivership Appointed",
      summary: "Depositors automatically became depositors of Sunwest Bank.",
    }),
    true
  )
})

test("a regulator's monthly roundup is admitted as one item on its own", () => {
  // Live, three runs in a row: every roundup the model found and correctly cited was dropped.
  // The title names a month rather than a subject, and the summary leads with that month's
  // prohibition order because almost every month has one. Neither says anything about the page.
  const occ = {
    title: "OCC Enforcement Actions for June 2026",
    status: "Enforcement Actions Announced",
    summary:
      "The OCC announced enforcement actions for June 2026, including an Order of Prohibition against a former Senior Mortgage Lending Officer at Quontic Bank.",
  }
  assert.ok(isEnforcementDigest(occ))
  assert.ok(isIndividualAction(occ), "the summary alone still reads as an action against a person")
  assert.equal(isCreRelevant(occ), false, "and nothing in it is on topic by its own words")
  assert.ok(bearsOnFirmOperations(occ), "but the roundup passes as the section's own subject")

  // The FDIC puts the month first.
  assert.ok(isEnforcementDigest({ title: "FDIC Makes Public August Enforcement Actions" }))
  assert.ok(
    isEnforcementDigest({
      title: "FDIC Releases List of Enforcement Actions Taken in September 2026",
    })
  )
})

test("a single action is not a roundup, and is judged on its own terms", () => {
  // The same month's page, split by the model into one item per action. Each is judged as the
  // action it is: a BSA/AML order is off topic, a prohibition order is about a person.
  assert.equal(isEnforcementDigest({ title: "OCC Enforcement Action Against United Texas Bank" }), false)
  assert.equal(
    bearsOnFirmOperations({
      title: "OCC Enforcement Action Against United Texas Bank",
      status: "Cease and Desist Order Issued",
      summary: "Deficiencies in its Bank Secrecy Act/anti-money laundering compliance program.",
    }),
    false
  )
  assert.equal(
    bearsOnFirmOperations({
      title: "OCC Enforcement Action Against Quontic Bank",
      status: "Order of Prohibition Issued",
      summary: "Order of Prohibition against a former Senior Mortgage Lending Officer.",
    }),
    false
  )
  // A month in the title is not enough without the roundup's own phrase.
  assert.equal(isEnforcementDigest({ title: "Open Chapter 11 Cases in Minnesota as of October 2, 2026" }), false)
  // "May" is a month and a verb; the roundup phrase must be there too.
  assert.equal(isEnforcementDigest({ title: "Bank may face enforcement over CRE concentration" }), false)
})
