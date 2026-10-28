/**
 * Provenance for every figure the peer tracker puts on screen.
 *
 * The same rule the Market Analytics tab works under: every value traces to a
 * named source field, and anything computed rather than reported is marked
 * `derived` and carries its formula. The bank-behaviour equivalent is
 * `BEHAVIOR_FIELD_CATALOG` in `lib/analytics/bank-behavior.ts`; this is the
 * Form D side of the same discipline.
 *
 * Two things make provenance matter more here than for Call Report data.
 * Form D is **self-reported by the issuer and not audited**, so a figure can be
 * stale, rounded or simply wrong, and the filing it came from has to stay one
 * click away. And the form's own vocabulary is misleading in places —
 * `totalOfferingAmount` is a cap the issuer set, not a target it is working
 * towards, and it is frequently the word "Indefinite" rather than a number.
 *
 * Dollar figures are in dollars, as Form D reports them — not thousands, which
 * is how FDIC reports and how the rest of this codebase's analytics read.
 */

export type PeerFieldBasis =
  /** Taken from a single filing, as of that filing's date. */
  | "filing"
  /** Computed across a vehicle's filing trail. */
  | "trail"
  /** Computed across the vehicles in a layer. */
  | "cohort"
  /** Taken from the adviser's Form ADV, Schedule D section 7.B.(1), as of its filing date. */
  | "adv"
  /** Found by EDGAR full-text search over the manager's names and people, then read from the filing it found. */
  | "search"

export type PeerFieldKind = "reported" | "derived"

export type PeerFieldSpec = {
  /** The property name on `OfferingRecord`, `Raise`, `ManagerRaises`, `PeerCohort` or, prefixed `adv`, `AdvFund`. */
  key: string
  label: string
  /** The Form D XML element, the Form ADV question, or the formula when derived. */
  source: string
  basis: PeerFieldBasis
  kind: PeerFieldKind
  /** Anything a reader would be misled by without it. */
  caveat?: string
}

function reported(
  key: string,
  element: string,
  label: string,
  basis: PeerFieldBasis,
  caveat?: string
): PeerFieldSpec {
  return { key, label, source: element, basis, kind: "reported", ...(caveat ? { caveat } : {}) }
}

function derived(key: string, formula: string, label: string, basis: PeerFieldBasis, caveat?: string): PeerFieldSpec {
  return { key, label, source: formula, basis, kind: "derived", ...(caveat ? { caveat } : {}) }
}

export const PEER_FIELD_CATALOG: readonly PeerFieldSpec[] = [
  // ---------------------------------------------------- straight from a filing
  reported("entityName", "entityName", "Fund legal name", "filing"),
  reported("jurisdiction", "jurisdictionOfInc", "Jurisdiction of organisation", "filing"),
  reported(
    "offeringAmount",
    "totalOfferingAmount",
    "Offering amount",
    "filing",
    'A cap the issuer set, not a target it is working towards, and routinely the literal string "Indefinite" for open-ended vehicles. Treated as the value "indefinite", against which no percentage is computed.'
  ),
  reported(
    "totalSold",
    "totalAmountSold",
    "Amount sold",
    "filing",
    "Cumulative since the offering opened, not a period figure. Self-reported and unaudited."
  ),
  reported("remaining", "totalRemaining", "Amount remaining", "filing", 'Also "Indefinite" where the offering is.'),
  reported(
    "investorCount",
    "totalNumberAlreadyInvested",
    "Investors",
    "filing",
    "Counts investors in this vehicle only. A fund raising through several sleeves reports each separately, so a manager-level sum is not a count of distinct LPs."
  ),
  reported("minimumInvestment", "minimumInvestmentAccepted", "Minimum investment accepted", "filing"),
  reported(
    "dateOfFirstSale",
    "dateOfFirstSale",
    "Date of first sale",
    "filing",
    'Absent while the issuer has selected "yet to occur", which is normal for a filing made before the first close.'
  ),
  reported("industryGroup", "industryGroupType", "Industry group", "filing"),
  reported(
    "fundType",
    "investmentFundType",
    "Fund type",
    "filing",
    "The issuer's own classification. Useful as a discriminator — it is what identifies a venture fund whose name suggests otherwise — but it is a self-selected label, not a verified strategy."
  ),
  reported("formType", "form type on the filing index", "Filing type (D or D/A)", "filing"),
  reported("filedAt", "filing date on the filing index", "Filed", "filing"),

  // ------------------------------------------- structure and terms (newest filing)
  reported("entityType", "primaryIssuer/entityType", "Entity type", "filing", "Read from the primary issuer only — the same element repeats for every co-issuer."),
  reported(
    "yearOfInc",
    "primaryIssuer/yearOfInc/value",
    "Year formed",
    "filing",
    'Given only for an issuer formed within five years; older issuers tick "over five years ago" and give no year.'
  ),
  reported(
    "coIssuers",
    "issuerList/issuer (cik, entityName, jurisdictionOfInc, entityType, yearOfInc)",
    "Files jointly with",
    "filing",
    "A joint filing reports the offering as a whole, so a co-issuer's capital is inside the filing's totals, not missing from them."
  ),
  reported(
    "exemptions",
    "federalExemptionsExclusions/item",
    "Exemptions claimed",
    "filing",
    "506(b) may not advertise and 506(c) may; 3(c)(1) caps a fund at 100 beneficial owners, 3(c)(7) admits only qualified purchasers, 3(c)(5) is the mortgage and real-estate exclusion. The umbrella code 3C is not shown beside a sub-item."
  ),
  reported("securities", "typesOfSecuritiesOffered (is…Type flags, descriptionOfOtherType)", "Securities offered", "filing", "Nearly every fund ticks pooled investment fund interests; the free-text description is quoted as filed."),
  reported("moreThanOneYear", "durationOfOffering/moreThanOneYear", "Offering expected to run over a year", "filing"),
  reported(
    "salesCommissions",
    "salesCommissionsFindersFees/salesCommissions (dollarAmount, isEstimate)",
    "Sales commissions",
    "filing",
    "Paid or expected for the offering as a whole, and frequently an estimate. Zero is shown as none; absent as not reported."
  ),
  reported("findersFees", "salesCommissionsFindersFees/findersFees", "Finder's fees", "filing"),
  reported("feesClarification", "salesCommissionsFindersFees/clarificationOfResponse", "Note on commissions", "filing", "Quoted as filed; often names a placement agent engaged or dropped."),
  reported(
    "proceedsToInsiders",
    "useOfProceeds/grossProceedsUsed (dollarAmount, isEstimate) and clarificationOfResponse",
    "Paid to officers, directors and promoters",
    "filing",
    "Usually zero with a note describing the management fee, which is quoted as filed."
  ),
  reported(
    "relatedPersons",
    "relatedPersonsList/relatedPersonInfo (firstName, middleName, lastName, relationship, relationshipClarification)",
    "People and entities",
    "filing",
    'Executive officers, directors and promoters of the issuer — not the whole team, never investors. An entity is recognised by a placeholder first name (".", "--", "[none]") or a legal suffix.'
  ),

  // ------------------------------------------------- computed across the trail
  derived(
    "target",
    "offeringAmount of the newest filing in the trail",
    "Current offering amount",
    "trail",
    "An amendment may raise or lower it; `targetHigh` records the largest ever stated."
  ),
  derived("sold", "totalSold of the newest filing in the trail", "Raised to date", "trail"),
  derived(
    "progress",
    "sold / target, null when target is indefinite or either side is missing",
    "Share of offering sold",
    "trail",
    "Never computed against an indefinite offering amount."
  ),
  derived(
    "averageTicket",
    "sold / investorCount of the newest filing",
    "Average commitment",
    "trail",
    "A mean, so a single anchor investor pulls it well above the typical cheque."
  ),
  derived(
    "soldLastYear",
    "sold (newest) − sold (the latest filing at least nine months earlier)",
    "Raised in the last twelve months",
    "trail",
    "Null when no filing sits far enough back to measure against, rather than a zero that would read as a stalled raise."
  ),
  derived(
    "investorsLastYear",
    "investorCount (newest) − investorCount (same prior filing as soldLastYear)",
    "Investors added in the last twelve months",
    "trail"
  ),
  derived(
    "targetCut",
    "any filing in the trail states a larger offeringAmount than the newest",
    "Offering amount reduced",
    "trail",
    "A reduction is a deliberate act by the issuer and is not otherwise announced; it is the strongest single read on a raise going badly."
  ),
  derived("targetHigh", "max numeric offeringAmount across the trail, when reduced since", "Previous offering amount", "trail"),
  derived(
    "quartersSinceFiling",
    "whole quarters between the newest filing and the as-of date",
    "Quarters since last filing",
    "trail"
  ),
  derived(
    "isLikelyOpen",
    "quartersSinceFiling < 4",
    "Raise still open",
    "trail",
    "Inferred, not reported: Form D carries no closed flag, and the annual amendment is mandatory while an offering is open, so four quarters of silence means it is not. A fund that closed the day after its last amendment reads as open for a year."
  ),
  derived(
    "isNewLaunch",
    "dateOfFirstSale, or the first filing date when absent, falls inside the window",
    "New launch",
    "trail"
  ),

  derived(
    "closeKind",
    "totalSold of a filing against the filing before it: rose → interim close; unchanged → annual amendment; fell → restated; the oldest filing is the first",
    "What the filing was",
    "trail",
    "An amendment is mandatory on a material increase in capital and once a year regardless, so a rise is a close and no rise is the annual re-file. The figure is cumulative and the filing only has to follow the change, so one amendment can bundle several closes — \"interim close\" is the right word, \"one amendment is one close\" is not guaranteed."
  ),

  derived("coIssuerFirstSeen", "the earliest filing in the trail whose issuerList includes the co-issuer", "Co-issuer first listed", "trail"),
  derived(
    "exemptionChanges",
    "the exemptions of each filing against the one before it, ignoring the umbrella 3C code",
    "Exemptions changed",
    "trail",
    "A move from 506(b) to 506(c) is a manager starting to advertise. Some changes are corrections — a sub-item dropped and restored a month later — and are shown as filed."
  ),
  derived("minimumChanges", "minimumAccepted of each filing against the previous filing that states one", "Minimum changed", "trail"),
  derived(
    "commissionShare",
    "salesCommissions ÷ the current numeric offering amount",
    "Commissions as a share of the offering",
    "trail",
    "Never computed against an indefinite offering or a zero commission."
  ),
  derived(
    "doubleCounted",
    "a co-issuer tracked as its own vehicle whose filing trail contains a filing from this raise's trail",
    "Co-issuer capital counted twice",
    "cohort",
    "None found across the US layer on 2026-10-26 (`npm run verify:peer-structure`)."
  ),
  derived(
    "personCrossLinks",
    "related persons whose name, with case, punctuation and accents folded, appears at another manager in the layer",
    "Same name at another manager",
    "cohort",
    "A name match, not a verified identity: Form D carries no identifier for a person. Initials and middle names are never dropped, so one person filed under two forms of their name is not merged."
  ),

  // ------------------------------------------------- vintage pacing, per manager
  derived(
    "vintageOrdinal",
    "rank of the fund by dateOfFirstSale (or first filing) among the manager's fund-role vehicles",
    "Vintage",
    "trail",
    "Derived from dates, never read from the name — a manager's \"Fund VI\" may be its fourth filer, and its \"Fund 1\" may be the newest. Sleeves are left out, because the registry holds no link to their parent fund."
  ),
  derived(
    "monthsIn",
    "whole months from dateOfFirstSale (or first filing) to the newest filing that reports totalSold",
    "Months in market",
    "trail",
    "A filing dated before the first sale reads as month 0."
  ),
  derived(
    "pace",
    "sold (newest vintage) ÷ sold (prior vintage at the same month, read from a filing at that month or a straight line between the two filings either side of it)",
    "Pace against the prior vintage",
    "trail",
    "Trails are sparse, so the prior's figure is usually interpolated; the panel says which two filings it sits between. Null when the prior's trail does not reach that month — nothing is extrapolated."
  ),

  // --------------------------------------------- computed across a manager/layer
  derived(
    "totalRaised",
    "sum of sold across every vehicle, sleeves included",
    "Capital raised",
    "cohort",
    "Sleeves are included because that is where part of a raise's capital is reported. It is capital raised across all vintages in the registry, not assets under management."
  ),
  derived(
    "totalSought",
    "sum of numeric target across fund-role vehicles only",
    "Capital sought",
    "cohort",
    "Excludes vehicles with an indefinite offering amount; `indefiniteTargets` counts them, so the figure is never read as the whole market's ask."
  ),
  derived(
    "activeRaiseCount",
    "count of fund-role vehicles where isLikelyOpen",
    "Raises open",
    "cohort",
    "Counts raises, not filers: a fund spread across an onshore LP and three sleeves counts once."
  ),
  derived("newLaunchCount", "count of fund-role vehicles where isNewLaunch", "Launches in the window", "cohort"),
  derived("targetCutCount", "count of fund-role vehicles where targetCut", "Offering amounts reduced", "cohort"),
  derived(
    "managersRaising",
    "count of managers with at least one open fund-role raise",
    "Managers in market",
    "cohort"
  ),

  // ------------------------------------------- from the adviser's Form ADV
  // Schedule D 7.B.(1) is the adviser's own list of the private funds it
  // manages, one record each. Read from IAPD by `scripts/refresh-peer-adv.mts`
  // and committed; the question numbers are the form's.
  reported(
    "advGrossAssetValue",
    "Form ADV 7.B.(1) Q11 — gross asset value of the private fund",
    "Gross assets (ADV)",
    "adv",
    "As of the adviser's fiscal year end and self-reported, so up to a year older than the filing date. Gross, not net: leverage is inside it."
  ),
  reported("advBeneficialOwners", "Form ADV 7.B.(1) Q13 — approximate number of beneficial owners", "Beneficial owners (ADV)", "adv"),
  reported(
    "advMinimumInvestment",
    "Form ADV 7.B.(1) Q12 — minimum investment commitment",
    "Minimum (ADV)",
    "adv",
    "Can differ from the Form D minimum: Form D states the minimum accepted from any outside investor, the ADV the fund's commitment minimum."
  ),
  reported("advFundTypes", "Form ADV 7.B.(1) Q10 — type of private fund", "Fund type (ADV)", "adv"),
  reported(
    "advExclusion",
    "Form ADV 7.B.(1) Q4 — exclusion from the Investment Company Act relied on, 3(c)(1) and/or 3(c)(7)",
    "Exclusion",
    "adv",
    "Can disagree with the Form D exemptions ticked by the issuer; the ADV is the adviser's answer and the Form D the issuer's."
  ),
  reported("advFormDFileNumber", "Form ADV 7.B.(1) Q22 — Form D file number", "Form D file number (ADV)", "adv"),
  reported(
    "advAnnualAudit",
    "Form ADV 7.B.(1) Q23(a) — are the private fund's financial statements subject to an annual audit?",
    "Audited annually",
    "adv",
    "No is a fact about the fund's governance, not a parse gap: a fund need not be audited."
  ),
  reported("advAuditor", "Form ADV 7.B.(1) Q23(b)–(f) — auditor, location, independence, PCAOB registration and inspection", "Auditor", "adv"),
  reported(
    "advStatementsDistributed",
    "Form ADV 7.B.(1) Q23(g) — are the audited financial statements distributed to the private fund's investors?",
    "Statements distributed",
    "adv",
    "No means investors did not all receive the audited statements. Read with Q23(h) before concluding anything."
  ),
  reported(
    "advOpinion",
    "Form ADV 7.B.(1) Q23(h) — do all audit reports since the last annual updating amendment contain unqualified opinions?",
    "Audit opinion",
    "adv",
    "Three answers: yes (unqualified), no, or report not yet received. The last is routine for a fund whose year end is close to the filing date."
  ),
  reported("advCustodians", "Form ADV 7.B.(1) Q25 — custodians, and whether each is a related person", "Custodians", "adv"),
  reported("advPrimeBrokers", "Form ADV 7.B.(1) Q24 — prime brokers", "Prime brokers", "adv"),
  reported("advAdministrators", "Form ADV 7.B.(1) Q26 — administrators", "Administrators", "adv"),
  reported("advMarketers", "Form ADV 7.B.(1) Q28 — marketers", "Marketers", "adv"),
  derived(
    "advLink",
    "the fund whose Q22 Form D file number equals the vehicle's EDGAR file number; failing that, whose folded name equals the registry name",
    "ADV record matched to vehicle",
    "adv",
    "A master and its feeder that filed one Form D between them both match the vehicle. A fund the adviser reports under a master with another name matches nothing, and is listed under 'not tracked here'."
  ),
  derived(
    "advSummaryGrossAssetValue",
    "sum of Q11 over the adviser's funds that are not feeders (Q6(c) not ticked) and report a value",
    "Gross assets across the adviser's funds",
    "adv",
    "Feeders are excluded because a feeder's assets are its stake in the master, already inside the master's figure."
  ),

  derived(
    "advSeries",
    "the fund's 7.B.(1) row on one filing per calendar year — the annual updating amendment where the filing index marks one, else the year's last filing — from the SEC's bulk Form ADV data 2011–2024, then the current filing",
    "ADV year by year",
    "adv",
    "Keyed by the fund's 805- number, so a renamed fund stays one series. The annual filing carries fiscal-year-end figures, so a 2024 row describes 2023 year end. Advisers registered after 2011 have shorter series; a fund that first appears after 2024 has only the current point."
  ),
  derived(
    "advSeriesNotes",
    "consecutive years compared: gross assets at a fifth either way, owners at any change, and the audit, statements and opinion answers whenever they move",
    "ADV change notes",
    "adv",
    "A fall in gross assets is reported as a fall. For a drawdown fund returning capital that is the plan; the filing does not say which it is."
  ),
  derived(
    "advAdviserYears",
    "per calendar year, the funds listed on the adviser's filing for that year and gross assets summed over those that are not feeders",
    "Adviser's book by year",
    "adv",
    "One filing per year, as for the fund series. Where a manager's view reads more than one adviser the years are summed across them."
  ),

  // ------------------------------- continuation, annex and extension vehicles
  derived(
    "continuationKind",
    "the filer's or fund's name — or a feeder's name on a master's ADV record — carries 'continuation', 'annex', 'extension', or the token 'CV' followed by a fund word",
    "Continuation vehicle",
    "search",
    "A name test, so a vehicle named without those words is missed, and 'CV' counts only before LP, Master, Fund, Feeder and the like — 'CV Platform Holdco' does not. A flag, never a score: the largest sponsors run these routinely."
  ),
  derived(
    "continuationAttribution",
    "the name matches a fund on the adviser's Form ADV; or the entity name carries a two-or-more-word phrase identifying the manager; or the filing's related persons share an exact folded name with the manager's tracked raises",
    "Attributed to manager",
    "search",
    "The search also matches a one-word name — 'Bridge', 'Apollo' — and a person's name on an unrelated filing; a hit with none of the three bases is counted and not shown. A shared person is a name match, as with People."
  ),
  derived(
    "continuationPredecessor",
    "the words before the marking term, folded, begin a tracked vehicle's folded name and are at least two words",
    "Likely continues",
    "search",
    "A name resemblance, not a filing fact: no form states which fund a continuation vehicle took its assets from."
  ),
]

const BY_KEY = new Map(PEER_FIELD_CATALOG.map((spec) => [spec.key, spec]))

export function peerFieldSpec(key: string): PeerFieldSpec | undefined {
  return BY_KEY.get(key)
}

/** Every derived figure's formula, for the "how this is computed" disclosure. */
export function derivedFields(): PeerFieldSpec[] {
  return PEER_FIELD_CATALOG.filter((spec) => spec.kind === "derived")
}

/**
 * What the tracker cannot see, stated once so every panel can say it rather
 * than render an empty chart.
 *
 * **Two different reasons are deliberately kept apart here**, because they read
 * very differently to anyone deciding how much weight to give a blank.
 *
 * Most of these are *reporting* limits: the figures exist, the fund computes
 * them, its auditors check them and its investors receive them — they are
 * simply not public, because Regulation D carries no public reporting
 * obligation and the detailed data larger advisers file on Form PF is held
 * confidentially by the SEC. Saying a private fund "has no" portfolio or
 * performance would be wrong; it has both and does not publish them.
 *
 * Only the redemption line is *structural*: a drawdown fund's partnership
 * agreement grants no redemption right, so there is genuinely no programme to
 * report. Even there the limit is narrower than it first appears, since
 * secondaries and GP-led continuation vehicles move interests without any
 * filing recording it.
 */
export const PRIVATE_FUND_LIMITS: readonly string[] = [
  "Portfolio composition and credit quality are not public. The fund knows them and its auditors see them — Regulation D simply carries no public reporting obligation.",
  "Performance, IRR and valuations are not public. A private fund strikes a net asset value quarterly and reports it to its own investors, not to anyone else.",
  "Larger advisers do file detailed portfolio and leverage data with the SEC on Form PF. The SEC holds it confidentially rather than publishing it, so it cannot be read here.",
  "A drawdown fund has no redemption programme — its partnership agreement grants no redemption right, which is structural rather than a disclosure choice. That is not the same as its investors having no exit: interests change hands through secondary sales and GP-led continuation vehicles, and no filing records either.",
  "Amount sold is cumulative and self-reported, and is only as current as the latest amendment.",
]
