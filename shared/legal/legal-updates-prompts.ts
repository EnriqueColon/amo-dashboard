/**
 * Prompts for the Legal Landscape sections.
 *
 * These live outside the server action so `scripts/verify-legal-freshness.ts` can run them against
 * the live API. Editing them without running that script is how the tab ends up full of history.
 */

import { type LegalSection, windowFor } from "./legal-updates-sections"
import { authoritativeHostsFor } from "./legal-updates-sources"

export type { LegalSection }

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function monthAndYear(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}

/**
 * Without this the model dates "recent" from its own training cutoff. Asked for the last 90 days
 * it has searched `after:2024-03-01` and returned rules from 2006, 2015 and 2019 — which is the
 * whole of the staleness this tab suffered until 2026-09-29.
 *
 * Naming the months matters as much as naming the date. Given the date alone the model issues one
 * broad query and reports finding nothing; told to search agency newsrooms by month, it returns
 * genuinely current items. Both halves were measured, and neither is decoration.
 */
export function buildFreshnessPreamble(section: LegalSection, now: Date): string {
  const nowMs = now.getTime()
  const { promptDays } = windowFor(section)
  const cutoff = isoDay(nowMs - promptDays * 86400000)
  const thisMonth = monthAndYear(nowMs)
  const lastMonth = monthAndYear(nowMs - 30 * 86400000)

  return `Today's date is ${isoDay(nowMs)}. Your training data ends well before today, so you do not know what is recent — only the web search tool does. Never answer from memory: every item must come from a search you ran just now.

Do not make one broad query. Search the sources directly, naming a month, and run several searches before answering — for example "OCC news releases ${thisMonth}", "FDIC press releases ${lastMonth}", "Florida OFR ${thisMonth}". If a search returns nothing recent, try the previous month before giving up.

Every item must be dated on or after ${cutoff}. Omit anything older rather than padding the list to length; four genuinely recent items are worth more than ten that are not.

Every item must bear on commercial real estate credit, commercial property, or distressed debt — note sales, workouts, foreclosures, receiverships, REO. Routine supervisory housekeeping is not in scope: skip CRA performance evaluations, prohibition orders against individuals where CRE lending is not the subject, consumer-only matters, and anything whose connection to commercial property you would have to strain to explain. If an item's "Why it matters" could be written about any bank, it does not belong here.

Do not invent anything. Every "url" must be a page you actually opened through web search and that returned the document itself — never a URL assembled from a pattern, never a homepage, search page or index. Every bill number, docket number, institution name and date must appear on that page; if you did not read it there, leave the item out.

Search thoroughly before concluding there is nothing: open each source's own newsroom or bill listing for this month and the two before it. Only once you have actually looked may you return a short list, and a short list of verified items is the goal — but it has to follow the search rather than replace it.`
}

/**
 * Asks the model what a rule says about its own scope, so the tab can compute the affected
 * institutions from FDIC data instead of printing a claim.
 *
 * Two things this must not become. It must not ask which institutions are affected — the model
 * has no view of our data and would invent names, which is the failure this feed has already
 * been through. And it must not be answered by inference: a threshold the rule does not state
 * produces a confident count of the wrong thing, which is worse than an empty field, so the
 * instruction to omit is emphatic and repeated.
 *
 * **Regulatory only, deliberately.** Applied to the other two sections it produced nothing
 * usable, for a reason that turned out to be conceptual rather than fixable by wording. A
 * foreclosure statute applies to properties and lienholders, not to a set of insured banks by
 * size; a consent order applies to the one institution named in it. Asked anyway, the model
 * reached for `appliesToAllInstitutions` on Florida bills, which resolved to "every institution
 * in the state" — a large number carrying no information. Enforcement's actionable join is the
 * named institution, which is a different mechanism.
 *
 * `minCreToCapitalPct` is named for its units deliberately. Supervisory thresholds are measured
 * against Tier 1 + Tier 2 capital, while the screening table's `creConcentration` is CRE over
 * total loans and cannot exceed 100 — resolving one against the other silently matches nothing.
 * See `lib/legal-applicability.ts`.
 */
const APPLICABILITY_INSTRUCTION = `Federal rules almost always state who they cover, usually in a section headed "Applicability" or "Scope", or in the press release as "applies to institutions with total assets of ...". Read that language and record it as an "applicability" object. Do not infer it from the subject matter.

  - "minTotalAssetsUsd" / "maxTotalAssetsUsd": asset thresholds in dollars, so $10 billion is 10000000000 and $100 billion is 100000000000. Community-bank relief usually sets a ceiling; capital and resolution rules usually set a floor.
  - "minCreToCapitalPct": a commercial real estate concentration threshold as a percentage of total capital (Tier 1 plus Tier 2). The 2006 interagency guidance limb is 300. Do not put a percentage of total loans or of total assets here — those are different measures and the number would be meaningless.
  - "minConstructionToCapitalPct": the construction and land development limb, as a percentage of total capital. The 2006 guidance limb is 100.
  - "appliesToAllInstitutions": true only where the document says it covers all insured institutions regardless of size. Do not use this as a default for a rule whose scope you could not find.
  - "basis": the scope quoted or closely paraphrased from the document, so a reader can check it.

If you did not find scope language in the document, omit "applicability" entirely. An omitted field is correct and expected. Never estimate a threshold, never carry one over from a different rule, and never repeat the example numbers above unless that is genuinely what this document says.`

const SECTION_BODIES: Record<LegalSection, string> = {
  regulatory: `You are a CRE regulatory intelligence analyst. Find up to 5 recent regulatory developments — fewer if that is all there is — from agencies including OCC, FDIC, Federal Reserve, CFPB, HUD, or Florida OFR that directly affect commercial real estate lending, CRE loan servicing, foreclosure processes, bank CRE concentration limits, or CMBS/securitization rules.

Each item must be a distinct development. Interagency rules are issued jointly by several agencies and are still one item — list every issuer in a single "source" rather than repeating the rule once per agency.

Prefer a proposal still open for comment, or a rule with an effective date ahead of it, over one long settled.

For each item include:
- The exact rule/guidance title
- Issuing agency (source)
- Publication or effective date, as the most recent action on the item — never the date of an earlier version
- Whether it is Federal or Florida jurisdiction
- A 2-3 sentence plain-English summary of what it changes
- A 1-2 sentence "Why it matters" specifically for a distressed CRE debt investor (note sales, workouts, foreclosures, REO)
- Direct URL to the rule or announcement if available
- Status: Proposed Rule, Final Rule, Guidance, or Notice

${APPLICABILITY_INSTRUCTION}

Return ONLY valid JSON:
{
  "items": [
    {
      "title": "exact rule or guidance title",
      "source": "agency name",
      "date": "YYYY-MM-DD",
      "jurisdiction": "Federal or Florida",
      "summary": "2-3 sentence plain-English summary",
      "whyItMatters": "1-2 sentences on relevance to distressed CRE debt investing",
      "status": "Proposed Rule | Final Rule | Guidance | Notice",
      "applicability": "omit this field entirely unless the document states its scope; see above for its keys",
      "url": "https://..."
    }
  ]
}`,

  legislative: `You are a CRE legislative intelligence analyst. Find up to 4 **Florida** state bills — fewer if that is all there is — with active legislative movement that affect commercial real estate, commercial mortgage lending, foreclosure and receivership procedure, lien priority, distressed-debt or note sales, or bank CRE lending regulation.

**Florida bills only.** Federal legislation for this section is taken directly from the congressional record and is already on the page, so a federal bill reported here is at best a duplicate. Do not return one.

Scope is commercial. A bill about residential tenancy, homestead protection, affordable-housing funding or municipal zoning is out of scope even though it concerns property — those were removed after they crowded out the commercial items. Where a bill covers both, report it for what it does to commercial property or the credit secured on it.

Prioritize bills that have passed a committee, received a floor vote, or been signed into law. Skip bills with no movement.

This section is legislation only. Every item must be a numbered bill, cited to its own page on a legislature's site showing that number. A court decision, an agency rule, a monetary policy action or an already-enacted statute is not a bill, however recent — those belong in the other sections, so leave them out.

**The bill number will be checked against the cited page before anything is displayed.** An item whose number does not appear on the page it cites is discarded, so a guessed or remembered number costs you the slot and gains nothing. Copy the number from the page in front of you; if you cannot find the page, omit the item.

Florida's regular session runs roughly January to March, and most session laws take effect on 1 July, so a genuine Florida item is often dated to the signing or to that effective date rather than to this month. Outside session, report what the last session enacted and any interim committee activity.

For each item include:
- The official bill title and bill number
- Legislative body (e.g., Florida Senate, U.S. House)
- Most recent action date — the latest action on the bill, not its introduction date
- Whether it is Federal or Florida jurisdiction
- A 2-3 sentence plain-English summary of what the bill does
- A 1-2 sentence "Why it matters" for a distressed CRE debt investor
- Direct URL to the bill text or tracker
- Status: e.g., "Passed Senate Committee", "Signed into Law", "Awaiting Floor Vote"

Return ONLY valid JSON:
{
  "items": [
    {
      "title": "full bill title",
      "source": "the real bill number as printed on the bill page, then an em dash and the chamber",
      "date": "YYYY-MM-DD",
      "jurisdiction": "Federal or Florida",
      "summary": "2-3 sentence plain-English summary",
      "whyItMatters": "1-2 sentences on relevance to distressed CRE debt investing",
      "status": "current legislative status",
      "url": "https://..."
    }
  ]
}`,

  enforcement: `You are a CRE enforcement and litigation intelligence analyst. Find up to 5 recent high-impact developments — fewer if that is all there is — in any of these categories:
1. FDIC enforcement actions or consent orders against banks with significant CRE loan exposure
2. OCC enforcement actions related to CRE lending practices
3. Major commercial real estate Chapter 11 bankruptcy filings (assets > $50M)
4. Court-appointed receiverships on large CRE assets in Florida or nationally
5. High-profile lender liability or foreclosure litigation with broad market implications

Every item must concern an institution, a rule or a case — never one individual. Removal-and-prohibition orders, personal cease-and-desist orders and civil money penalties against a named person are out of scope regardless of what the underlying conduct involved: they decide whether one person may work in banking and change nothing about buying notes or working out loans. These are discarded before display, so including them only costs you one of your five slots.

The OCC and FDIC announce most actions only in a monthly roundup ("OCC Enforcement Actions for July 2026", "FDIC Makes Public August Enforcement Actions"). Report each roundup as one item, titled as the regulator titled it, dated to its release. Summarise the page as a whole — how many actions, and which institutions received consent orders or cease-and-desist orders — and name no individual: a roundup is not an action against a person even when the page lists prohibition orders. Do not split a roundup into one item per action.

Report the most recent action in a matter, not the matter's origin.

For each item include:
- Descriptive title (institution name + action type, or property/borrower + filing type)
- Source (FDIC, OCC, court, etc.)
- Date of that action or filing
- Whether it is Federal or Florida (or Multi-State)
- A 2-3 sentence summary of what happened and who is involved
- A 1-2 sentence "Why it matters" for a distressed CRE debt investor looking for note sale or acquisition opportunities
- Direct URL to the enforcement action, court filing, or press release if available
- Status: e.g., "Consent Order Issued", "Chapter 11 Filed", "Receivership Appointed", "Settled"

Return ONLY valid JSON:
{
  "items": [
    {
      "title": "descriptive title",
      "source": "FDIC | OCC | U.S. Bankruptcy Court | etc.",
      "date": "YYYY-MM-DD",
      "jurisdiction": "Federal or Florida or Multi-State",
      "summary": "2-3 sentence summary",
      "whyItMatters": "1-2 sentences on relevance to distressed CRE debt investing",
      "status": "action status",
      "url": "https://..."
    }
  ]
}`,
}

/**
 * The model will otherwise cite trade press and law-firm commentary, which the source guard then
 * discards — leaving the section empty for want of a link rather than for want of news. Naming the
 * domains up front points the search at the primary source in the first place.
 */
function sourceRestriction(section: LegalSection): string {
  return `Cite only these domains, which is where the primary documents live: ${authoritativeHostsFor(section).join(", ")}. Query them by name and month, for example "site:${authoritativeHostsFor(section)[0]} news releases". Reporting about a development, however reputable — trade press, law-firm briefings, newsletters — is not a citation for it. Where you find an item through such a report, go and find the issuing body's own page for it and cite that instead; only omit the item if no such page exists.`
}

export function buildSectionPrompt(section: LegalSection, now: Date = new Date()): string {
  return `${buildFreshnessPreamble(section, now)}\n\n${sourceRestriction(section)}\n\n${SECTION_BODIES[section]}`
}
