/**
 * Does a legal development bear on how this firm operates?
 *
 * Two separate questions, because the answers fail in different ways.
 *
 * **Is it on topic?** Verification made the feed truthful without making it useful. "OCC Releases
 * CRA Performance Evaluations for 23 National Banks" is recent, real and primary-sourced, and tells
 * a note buyer nothing. So does a bill about data centres on federal land. All of that reached the
 * tab.
 *
 * **Is its subject the firm's world at all?** A prohibition order against a named individual is a
 * ruling about one person's employability. It is real, primary-sourced, on a regulator's site, and
 * changes nothing about buying notes or working out loans.
 *
 * Both gates read only what the source *says*, never the model's own case for the item — see
 * `describedBy` below, which is the fix for the defect that let the whole gate be talked past.
 */

/**
 * The model writes `whyItMatters` under instruction to explain the item's "relevance to distressed
 * CRE debt investing". Reading it here asked the model to certify its own item, and it always
 * obliged: "OCC Enforcement Action: Danny Seibel Prohibited from Banking Activities" reached the
 * tab on a `whyItMatters` reading "can affect how lenders manage their CRE loan portfolios", while
 * its title, summary and status mention nothing of the kind. The gate was not too loose so much as
 * self-defeating, and no amount of term tuning would have fixed it.
 *
 * `summary` is kept because the prompt asks it to describe what the document changes, which is
 * reporting rather than argument, and an enforcement action is often titled with nothing but an
 * institution's name.
 */
function describedBy(item: RelevanceCandidate): string {
  return [item.title, item.summary, item.status].filter(Boolean).join(" ")
}

/**
 * Commercial property, the credit secured on it, and what happens to either in distress.
 *
 * Residential and land-use policy came out deliberately. `housing`, `affordable housing`,
 * `eviction`, `landlord`, `tenant`, `property tax`, `zoning` and `land use` admitted HUD
 * homelessness grants and residential tenancy bills — real legislation that does not reach this
 * firm's operations. `multifamily` stays, being an asset class here rather than a housing policy.
 *
 * Every entry is anchored with `\b` or ends in a stem that cannot appear inside an unrelated word.
 * Bare substrings are how `lien` admitted "client", "clients", "resilience" and "salient", and
 * `tenant` admitted "lieutenant" — four false positives in fifteen sample headlines.
 *
 * The terms are split into two lists below, which together are this one. Nothing is scored: a term
 * either names this world or it does not, and the split records which of those two it is.
 */
/**
 * Split by how selective a term actually is, not by what it means.
 *
 * A core term names this firm's world wherever it appears: nothing writes "commercial mortgage"
 * about something else. An incidental term appears in a sentence about something else at least as
 * often as not — a Florida bill on court procedure mentions liens, an Office of Personnel
 * Management rule on staff reviews is titled "Performance Appraisal", and a statute reviser's bill
 * deletes provisions rendered inoperative by "noncurrent" repeal.
 *
 * Where a term sits decides how much it counts; see `isCreRelevant`.
 */
const CORE_TERMS = [
  // Commercial property and the loans against it
  "commercial real estate",
  "\\bcre\\b",
  "commercial propert\\w*",
  "commercial mortgage",
  "commercial lease",
  "\\bcmbs\\b",
  "\\bmultifamily\\b",
  "office building",
  "office tower",
  "retail cent(er|re)",
  "industrial propert\\w*",
  "construction loan",
  "acquisition, development",
  "\\badc\\b",
  "real estate lending",
  "real estate loan",
  "mortgage servic\\w*",
  "special servic\\w*",
  "loan-to-value",
  "\\bltv\\b",
  "concentration limit",
  "concentration risk",
  // Distress, and what happens to an asset in it
  "foreclos\\w*",
  "receivership",
  "\\breceiver\\b",
  "chapter 11",
  "\\bworkout\\w*",
  "loan modification",
  "troubled debt",
  "nonaccrual",
  "noncurrent",
  "charge-off",
  "note sale",
  "loan sale",
  "distressed",
  "\\breo\\b",
  "deed in lieu",
  "assignment of rents",
]

/**
 * Real signals, but ones that a document about something else uses in passing. Enough on their own
 * in a heading, where the publisher is telling you the subject; not enough buried in a body.
 */
const INCIDENTAL_TERMS = [
  "mortgage lending",
  "loan servicing",
  "\\bappraisal\\w*",
  "risk-based capital",
  "capital requirement",
  "allowance for credit loss",
  "bankrupt\\w*",
  "delinquen\\w*",
  "\\blien\\b",
  "\\bliens\\b",
  // `default` alone matched "default judgment" and "by default". Qualified, it is the real thing.
  "(loan|payment|monetary|mortgage|borrower) default\\w*",
  "default(ed|ing) (on|loan)",
]

const RELEVANT_TERMS = [...CORE_TERMS, ...INCIDENTAL_TERMS]

const RELEVANCE_PATTERN = new RegExp(RELEVANT_TERMS.join("|"), "i")

/**
 * Removal-and-prohibition orders under 12 U.S.C. 1818(e) can only be issued against a person, not
 * an institution, so the phrasing is a reliable marker rather than a guess at whether a name is a
 * human. That precision is the point: no attempt is made to classify names, which would misfile
 * institutions named after their founders.
 *
 * These are dropped whatever else they say. A prohibition order can mention a CRE loan portfolio
 * as the setting for the underlying conduct and still be a ruling about one person's career.
 */
const INDIVIDUAL_ACTION_TERMS = [
  "prohibition order",
  "order of prohibition",
  "removal and prohibition",
  "prohibited from (participating|banking|the banking)",
  "barred from (participating|banking|the banking)",
  "personal cease and desist",
  "\\bformer (teller|employee|officer|loan officer|branch manager|cashier)\\b",
]

const INDIVIDUAL_ACTION_PATTERN = new RegExp(INDIVIDUAL_ACTION_TERMS.join("|"), "i")

/**
 * The OCC and FDIC do not announce enforcement actions one at a time. Each publishes a monthly
 * roundup — "OCC Enforcement Actions for July 2026", "FDIC Makes Public August Enforcement
 * Actions" — listing every consent order, civil money penalty and prohibition order of the month
 * on one page. The page is the record; there is no per-action release behind it to cite instead.
 *
 * Read as an item, a roundup fails both gates below for reasons that have nothing to do with what
 * is on the page. Its title names a month, not a subject, so it is never on topic by its own words;
 * and its summary almost always mentions a prohibition order, because almost every month has one,
 * so it reads as an action against a person. Live, that left the section with nothing from the
 * regulators at all — three runs, every roundup dropped — while the model had found and cited the
 * real pages.
 *
 * A month name alongside "enforcement actions" is what a roundup title has that a single action's
 * does not ("OCC Enforcement Action Against United Texas Bank" has neither). The match is on the
 * title only, where the publisher named the thing.
 */
const MONTHS =
  "(january|february|march|april|may|june|july|august|september|october|november|december)"

const ENFORCEMENT_DIGEST_PATTERN = new RegExp(
  `\\b${MONTHS}\\b.*\\benforcement actions\\b|\\benforcement actions\\b.*\\b${MONTHS}\\b`,
  "i"
)

/**
 * Subjects ruled out of scope, matched against the title only.
 *
 * Dropping the residential terms from the relevance list stopped those items being *admitted* on
 * their own subject, but not through a body that mentions something commercial in passing. Over a
 * 400-day window of Florida legislation, five of fifteen otherwise-qualifying bills were housing
 * bills that reached the gate on the word "multifamily" or "construction loan" somewhere in their
 * official description — "Affordable Housing Property Tax Exemptions" among them.
 *
 * Title only, deliberately. A commercial foreclosure bill may well mention homestead exemptions in
 * its text; what puts an item out of scope is being *about* housing, and the title is where a
 * legislature says what a bill is about.
 */
const EXCLUDED_SUBJECT_TERMS = [
  "\\bhousing\\b",
  "\\bhomestead\\b",
  "residential tenanc\\w*",
  "\\blandlord\\w*",
  "\\beviction\\w*",
  "mobile home",
  "manufactured home",
  "\\bhomeless\\w*",
  "property tax exemption",
  "\\bad valorem\\b",
  // Not a subject so much as a collision: `appraisal` is an incidental term, and the Office of
  // Personnel Management titles its staff-review rules "Performance Appraisal for the General
  // Schedule". Excluding the phrase is narrower than qualifying the term.
  "performance appraisal",
]

const CORE_PATTERN = new RegExp(CORE_TERMS.join("|"), "i")
const EXCLUDED_SUBJECT_PATTERN = new RegExp(EXCLUDED_SUBJECT_TERMS.join("|"), "i")

export type RelevanceCandidate = {
  title?: string
  summary?: string
  whyItMatters?: string
  status?: string
}

/** True for a regulator's monthly enforcement roundup, which is admitted as one item on its own. */
export function isEnforcementDigest(item: RelevanceCandidate): boolean {
  return ENFORCEMENT_DIGEST_PATTERN.test(item.title || "")
}

/** True for an action against a named individual rather than an institution or a rule. */
export function isIndividualAction(item: RelevanceCandidate): boolean {
  return INDIVIDUAL_ACTION_PATTERN.test(describedBy(item))
}

/**
 * True when the source's own description touches commercial property, credit or distress.
 *
 * Where a term appears is what decides, because length is what makes a term unreliable. A title
 * is a few words the publisher chose to say what the thing is about, so `bankrupt` in a title is
 * almost always the subject — "Bankruptcy Threshold Adjustment Act" is real and it matters here.
 * A two-hundred-word summary mentions liens on its way to somewhere else, and a stablecoin proposal
 * mentions capital requirements. So **a heading is read on all the terms and a body only on the
 * core ones.** The status is treated as heading: it is short, and the publisher chose it.
 *
 * This began as a stricter rule for record-sourced items only, on the theory that a model asked
 * about CRE returns a list that is mostly CRE and so a term anywhere in it is good evidence. The
 * model path then admitted a Federal Reserve stablecoin proposal on "capital requirements" in its
 * body, which is the same failure at a different base rate. One rule is simpler to reason about
 * and there is no longer an argument for two.
 */
export function isCreRelevant(item: RelevanceCandidate): boolean {
  const heading = [item.title, item.status].filter(Boolean).join(" ")
  if (EXCLUDED_SUBJECT_PATTERN.test(item.title || "")) return false
  if (RELEVANCE_PATTERN.test(heading)) return true
  return CORE_PATTERN.test([heading, item.summary].filter(Boolean).join(" "))
}

/**
 * The single question the feed acts on: would this change how the firm operates?
 *
 * On topic and about an institution, a rule or a case — not about one person's licence. A
 * regulator's monthly roundup passes on its own: it is the section's own subject, published by the
 * primary regulator, and the only form in which most bank enforcement actions are ever announced.
 * What it contains that month is for the reader to see on the page; the feed does not pretend to
 * know, and the summary is written to say what the page is, not to pick an action out of it.
 */
export function bearsOnFirmOperations(item: RelevanceCandidate): boolean {
  if (isEnforcementDigest(item)) return true
  return isCreRelevant(item) && !isIndividualAction(item)
}

export function partitionByRelevance<T extends RelevanceCandidate>(
  items: T[]
): { relevant: T[]; irrelevant: T[] } {
  const relevant: T[] = []
  const irrelevant: T[] = []
  for (const item of items) {
    if (bearsOnFirmOperations(item)) relevant.push(item)
    else irrelevant.push(item)
  }
  return { relevant, irrelevant }
}
