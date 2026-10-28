/**
 * Form D: the fundraising half of the peer tracker.
 *
 * Any manager raising from US investors under Regulation D must file a Form D
 * within 15 days of first sale, and must amend it annually while the offering
 * is open. That makes it the one fundraising dataset that is mandatory, free,
 * authoritative and current — no survey, no subscription, no self-reporting.
 *
 * One fund's filing trail answers the whole "fundraising activity" ask. Safe
 * Harbor Equity Distressed Debt Fund 4 (CIK 2017189), the control case this
 * module is tested against:
 *
 *   2024-03-28  D    target $500,000,000  sold          $0   0 investors
 *   2025-07-22  D/A  target $300,000,000  sold $52,918,863  30 investors
 *   2026-07-23  D/A  target $300,000,000  sold $64,168,863  40 investors
 *
 * From which: fund size, progress (21.4% of target), pace (+$11.25M and +10
 * investors in twelve months), average ticket ($1.60M), and a target cut from
 * $500M to $300M — which is the kind of thing a competitor does not put in a
 * press release.
 *
 * This module is pure: XML in, records and arithmetic out.
 */

/**
 * `null` means "not reported", never zero — the same discipline as
 * `lib/analytics/bank-behavior.ts`. A fund that reports no investor count is
 * not a fund with no investors.
 */
/**
 * A broker-dealer paid to sell the offering, from Form D's sales compensation
 * list.
 *
 * The most useful thing in the filing that is not a dollar figure. Form D never
 * says who *bought* — investor identities are confidential by design, and the
 * form reports only a count — but it does say who was paid to *sell*. For a
 * firm raising its own fund, a competitor's distribution tells you how they
 * raise: a book of 232 investors at a $1.13M average through accredited-retail
 * platforms is a different strategy from 40 investors placed direct.
 */
export type SalesRecipient = {
  name: string
  /** FINRA Central Registration Depository number, zero-padded as filed. */
  crd: string | null
  /** The broker-dealer this recipient is associated with, where one is named. */
  associatedBrokerDealer: string | null
  /** `City, ST` of the recipient's own address. */
  location: string | null
  /** States solicited; the literal "All States" is kept as filed. */
  states: string[]
  foreignSolicitation: boolean | null
}

/** An officer, director or promoter of the issuer. Not an investor. */
export type RelatedPerson = {
  /** Either a person's name or, commonly for a fund, the GP entity. */
  name: string
  /**
   * `entity` when the filer listed a company rather than a person — a fund's
   * GP or investment manager, typically — which Form D marks only by leaving
   * the first name as a placeholder: ".", "--", "[none]".
   */
  kind: "person" | "entity"
  relationships: string[]
  /** The filer's own words on the role, e.g. "Manager of SHE DDF4 GP, LLC the General Partner". */
  clarification: string | null
}

/** Another issuer on the same filing — a feeder, parallel or master vehicle filing jointly. */
export type CoIssuer = {
  cik: string
  name: string
  jurisdiction: string | null
  entityType: string | null
  /** Year of formation where given; Form D omits it for an issuer over five years old. */
  yearOfInc: number | null
  /** `YYYY-MM-DD` of the earliest filing in the trail that lists it. Set by `buildRaise`. */
  firstSeen?: string
}

/** A dollar figure Form D lets the issuer mark as an estimate. */
export type FeeFigure = {
  amount: number | null
  estimate: boolean
}

/**
 * The structure and terms of an offering, from the parts of Form D the raise
 * figures do not use. All self-reported, like the rest of the form.
 */
export type OfferingTerms = {
  entityType: string | null
  yearOfInc: number | null
  /** True where the issuer ticked "over five years ago" instead of giving a year. */
  formedOverFiveYearsAgo: boolean
  /**
   * Other issuers on this filing. **The filing's dollar figures cover the
   * offering across all of them** — a co-issuer's capital is inside the
   * totals, not missing from them.
   */
  coIssuers: CoIssuer[]
  /** Item 6 codes as filed: `06b`, `06c`, `3C`, `3C.1`, `3C.5`, `3C.7`, `04a5`, … */
  exemptions: string[]
  /** Item 9, normalised: `equity`, `debt`, `pooled-fund`, `option`, `security-to-acquire`, `mineral`, `business-combination`, `other`. */
  securities: string[]
  securitiesOther: string | null
  /** Item 8: whether the issuer expects the offering to last more than a year. */
  moreThanOneYear: boolean | null
  /** Item 15. Commissions paid or expected for the offering as a whole. */
  salesCommissions: FeeFigure
  findersFees: FeeFigure
  /** The issuer's note on Item 15, which often names or drops a placement agent. */
  feesClarification: string | null
  /** Item 16: gross proceeds paid to officers, directors or promoters. */
  proceedsToInsiders: FeeFigure
  /** The issuer's note on Item 16, usually a description of the management fee. */
  proceedsClarification: string | null
}

export type OfferingRecord = {
  cik: string
  accession: string
  /** `D` for an original, `D/A` for an amendment. */
  formType: string
  /** `YYYY-MM-DD`, the filing date. */
  filedAt: string
  /**
   * The offering's SEC file number, `021-…`, from the EDGAR index rather than
   * the document. Optional because entries cached before it was read lack it.
   */
  fileNumber?: string | null
  entityName: string
  /** Business address as `City, ST`, when given. */
  location: string | null
  jurisdiction: string | null
  /**
   * The offering target in dollars, or `"indefinite"`.
   *
   * Evergreen and open-ended vehicles routinely file `totalOfferingAmount` as
   * the literal string `Indefinite` rather than a number. That is a real
   * answer, not missing data, so it gets its own value: a percentage of an
   * indefinite target is meaningless and must not be computed.
   */
  offeringAmount: number | "indefinite" | null
  totalSold: number | null
  /** What the filer says is still available. Also `"indefinite"`. */
  remaining: number | "indefinite" | null
  investorCount: number | null
  minimumInvestment: number | null
  /** `YYYY-MM-DD`. The start of the raise, and so the launch signal. */
  dateOfFirstSale: string | null
  /** e.g. `Pooled Investment Fund`. */
  industryGroup: string | null
  /** e.g. `Other Investment Fund`, `Private Equity Fund`, `Hedge Fund`. */
  fundType: string | null
  /** True only where the issuer says it accepted non-accredited investors. */
  hasNonAccreditedInvestors: boolean | null
  /** Who was paid to sell the offering. Empty where the issuer sold it itself. */
  salesRecipients: SalesRecipient[]
  /** Officers, directors and promoters — never investors. */
  relatedPersons: RelatedPerson[]
  /**
   * Structure and terms. Optional because the stored filings in the cache drop
   * it — `buildRaise` hoists the newest filing's onto the raise, the same
   * reason `salesRecipients` and `relatedPersons` are emptied there.
   */
  terms?: OfferingTerms | null
}

/**
 * XML character entities, decoded after tags are stripped.
 *
 * Fund names carry them routinely — "R &amp; R Capital", "SEGLO PRIVATE
 * CREDIT &amp; OPPORTUNITY FUND" — and an undecoded name reaches the screen
 * looking like markup and fails any name comparison against another source.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))
  if (!m) return null
  const v = decodeEntities(m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).trim()
  return v.length ? v : null
}

/** Dollar fields arrive as digits, as `Indefinite`, or absent. */
function money(raw: string | null): number | "indefinite" | null {
  if (raw == null) return null
  if (/indefinite/i.test(raw)) return "indefinite"
  const n = Number(raw.replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

function count(raw: string | null): number | null {
  if (raw == null) return null
  const n = Number(raw.replace(/[^0-9-]/g, ""))
  return Number.isFinite(n) ? n : null
}

function isoDate(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[0] : null
}

function tagIn(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))
  if (!m) return null
  const v = decodeEntities(m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).trim()
  return v.length ? v : null
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => m[1])
}

function boolOf(raw: string | null): boolean | null {
  if (raw == null) return null
  if (/^true$/i.test(raw)) return true
  if (/^false$/i.test(raw)) return false
  return null
}

/**
 * Placeholders issuers write into optional string fields.
 *
 * Form D's own convention is "None", but filers also write "N/A", "NA", a
 * dash, or a pair of them. Treating these as values produced a broker-dealer
 * called "N/A" appearing on sixteen funds and $28.9B of associated raises,
 * which would have led the agent table.
 */
const PLACEHOLDERS = /^(none|n\/a|na|n\.a\.|not applicable|-{1,2}|\.)$/i

function notNone(raw: string | null): string | null {
  return raw == null || PLACEHOLDERS.test(raw.trim()) ? null : raw
}

function parseSalesRecipients(xml: string): SalesRecipient[] {
  const list = blocks(xml, "salesCompensationList")[0]
  if (!list) return []
  const out: SalesRecipient[] = []
  for (const block of blocks(list, "recipient")) {
    const name = notNone(tagIn(block, "recipientName"))
    if (!name) continue
    const address = blocks(block, "recipientAddress")[0] ?? ""
    const city = tagIn(address, "city")
    const state = tagIn(address, "stateOrCountry")
    const statesBlock = blocks(block, "statesOfSolicitationList")[0] ?? ""
    out.push({
      name,
      crd: notNone(tagIn(block, "recipientCRDNumber")),
      associatedBrokerDealer: notNone(tagIn(block, "associatedBDName")),
      location: city && state ? `${city}, ${state}` : city ?? null,
      states: [...statesBlock.matchAll(/<value>([\s\S]*?)<\/value>/gi)]
        .map((m) => decodeEntities(m[1].trim()))
        .filter(Boolean),
      foreignSolicitation: boolOf(tagIn(block, "foreignSolicitation")),
    })
  }
  return out
}

/**
 * What filers put in the first-name field when the related person is a
 * company. Seen in real filings: "--" (Silverview), "." (BH3), "[none]"
 * (Bridge). `PLACEHOLDERS` covers the first two; brackets are added here.
 */
const NAME_PLACEHOLDER = /^(\[?none\]?|n\/a|na|-{1,2}|\.|)$/i

/** A legal-entity suffix, for an entity listed with a real-looking first name. */
const ENTITY_SUFFIX = /\b(LLC|L\.L\.C\.|LP|L\.P\.|LLP|Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|Trust|GP)\b/i

function parseRelatedPersons(xml: string): RelatedPerson[] {
  const list = blocks(xml, "relatedPersonsList")[0]
  if (!list) return []
  const out: RelatedPerson[] = []
  for (const block of blocks(list, "relatedPersonInfo")) {
    const nameBlock = blocks(block, "relatedPersonName")[0] ?? block
    const first = tagIn(nameBlock, "firstName")
    const middle = tagIn(nameBlock, "middleName")
    const last = tagIn(nameBlock, "lastName")
    // A fund usually files its GP entity here with a placeholder first name;
    // dropping it gives "BH3 Debt Opportunity Fund II GP, LLC" rather than
    // ". BH3 Debt Opportunity Fund II GP, LLC".
    const firstIsPlaceholder = first == null || NAME_PLACEHOLDER.test(first.trim())
    const name = [firstIsPlaceholder ? null : first, middle && !NAME_PLACEHOLDER.test(middle.trim()) ? middle : null, last]
      .filter((p): p is string => Boolean(p))
      .join(" ")
      .trim()
    if (!name) continue
    const relBlock = blocks(block, "relatedPersonRelationshipList")[0] ?? block
    out.push({
      name,
      kind: firstIsPlaceholder || ENTITY_SUFFIX.test(name) ? "entity" : "person",
      relationships: [...relBlock.matchAll(/<relationship>([\s\S]*?)<\/relationship>/gi)]
        .map((m) => decodeEntities(m[1].trim()))
        .filter(Boolean),
      clarification: notNone(tagIn(block, "relationshipClarification")),
    })
  }
  return out
}

const SECURITY_FLAGS: Array<[string, string]> = [
  ["isEquityType", "equity"],
  ["isDebtType", "debt"],
  ["isPooledInvestmentFundType", "pooled-fund"],
  ["isOptionToAcquireType", "option"],
  ["isSecurityToBeAcquiredType", "security-to-acquire"],
  ["isMineralPropertyType", "mineral"],
  ["isTenantInCommonType", "tenant-in-common"],
  ["isBusinessCombinationTransaction", "business-combination"],
  ["isOtherType", "other"],
]

function feeFigure(block: string | undefined): FeeFigure {
  if (!block) return { amount: null, estimate: false }
  const raw = tagIn(block, "dollarAmount")
  const n = raw == null ? null : Number(raw.replace(/[^0-9.-]/g, ""))
  return { amount: n != null && Number.isFinite(n) ? n : null, estimate: boolOf(tagIn(block, "isEstimate")) === true }
}

/** Year of formation: `<value>` within five years, or nothing when "over five years". */
function yearOf(block: string | undefined): { year: number | null; overFive: boolean } {
  const y = block ? blocks(block, "yearOfInc")[0] : undefined
  if (!y) return { year: null, overFive: false }
  const v = tagIn(y, "value")
  const n = v ? Number(v) : NaN
  return { year: Number.isFinite(n) && n > 1900 ? n : null, overFive: boolOf(tagIn(y, "overFiveYears")) === true }
}

/**
 * Items 1, 6, 8, 9, 15 and 16 — the structure and terms of the offering.
 *
 * Read from named blocks rather than with the whole-document `tag`, because
 * `entityType`, `jurisdictionOfInc` and `yearOfInc` repeat for every co-issuer
 * and the first match would be whichever issuer the filer happened to list
 * first.
 */
export function parseTerms(xml: string): OfferingTerms {
  const primary = blocks(xml, "primaryIssuer")[0]
  const { year, overFive } = yearOf(primary)
  const issuerList = blocks(xml, "issuerList")[0]
  const coIssuers: CoIssuer[] = issuerList
    ? blocks(issuerList, "issuer")
        .map((b) => {
          const cik = tagIn(b, "cik")
          const name = tagIn(b, "entityName")
          if (!cik || !name) return null
          return {
            cik: String(Number(cik.replace(/\D/g, ""))),
            name,
            jurisdiction: tagIn(b, "jurisdictionOfInc"),
            entityType: tagIn(b, "entityType"),
            yearOfInc: yearOf(b).year,
          }
        })
        .filter((c): c is CoIssuer => c != null)
    : []

  const exemptionsBlock = blocks(xml, "federalExemptionsExclusions")[0] ?? ""
  const securitiesBlock = blocks(xml, "typesOfSecuritiesOffered")[0] ?? ""
  const feesBlock = blocks(xml, "salesCommissionsFindersFees")[0]
  const proceedsBlock = blocks(xml, "useOfProceeds")[0]

  return {
    entityType: primary ? tagIn(primary, "entityType") : null,
    yearOfInc: year,
    formedOverFiveYearsAgo: overFive,
    coIssuers,
    exemptions: [...exemptionsBlock.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1].trim()).filter(Boolean),
    securities: SECURITY_FLAGS.filter(([el]) => boolOf(tagIn(securitiesBlock, el)) === true).map(([, key]) => key),
    securitiesOther: notNone(tagIn(securitiesBlock, "descriptionOfOtherType")),
    moreThanOneYear: boolOf(tagIn(blocks(xml, "durationOfOffering")[0] ?? "", "moreThanOneYear")),
    salesCommissions: feeFigure(feesBlock ? blocks(feesBlock, "salesCommissions")[0] : undefined),
    findersFees: feeFigure(feesBlock ? blocks(feesBlock, "findersFees")[0] : undefined),
    feesClarification: feesBlock ? notNone(tagIn(feesBlock, "clarificationOfResponse")) : null,
    proceedsToInsiders: feeFigure(proceedsBlock ? blocks(proceedsBlock, "grossProceedsUsed")[0] : undefined),
    proceedsClarification: proceedsBlock ? notNone(tagIn(proceedsBlock, "clarificationOfResponse")) : null,
  }
}

/**
 * Parse a Form D `primary_doc.xml`.
 *
 * `dateOfFirstSale` is nested inside a wrapper element that also carries a
 * "yet to occur" flag, so the date is pulled by pattern rather than by reading
 * the wrapper's text — which would otherwise come back as the whole subtree.
 */
export function parseFormD(
  xml: string,
  context: {
    cik: string
    accession: string
    formType: string
    filedAt: string
    fileNumber?: string | null
    location?: string | null
  }
): OfferingRecord {
  return {
    cik: String(Number(context.cik.replace(/\D/g, ""))),
    accession: context.accession,
    formType: context.formType,
    filedAt: context.filedAt,
    fileNumber: context.fileNumber ?? null,
    entityName: tag(xml, "entityName") ?? "",
    location: context.location ?? null,
    jurisdiction: tag(xml, "jurisdictionOfInc") ?? tag(xml, "stateOrCountry"),
    offeringAmount: money(tag(xml, "totalOfferingAmount")),
    totalSold: (() => {
      const v = money(tag(xml, "totalAmountSold"))
      return typeof v === "number" ? v : null
    })(),
    remaining: money(tag(xml, "totalRemaining")),
    investorCount: count(tag(xml, "totalNumberAlreadyInvested")),
    minimumInvestment: count(tag(xml, "minimumInvestmentAccepted")),
    dateOfFirstSale: isoDate(tag(xml, "dateOfFirstSale")),
    industryGroup: tag(xml, "industryGroupType"),
    fundType: tag(xml, "investmentFundType"),
    hasNonAccreditedInvestors: boolOf(tag(xml, "hasNonAccreditedInvestors")),
    salesRecipients: parseSalesRecipients(xml),
    relatedPersons: parseRelatedPersons(xml),
    terms: parseTerms(xml),
  }
}

/**
 * One fund's offering history and what it implies, oldest filing first.
 *
 * A "raise" is the filing trail of a single CIK: the original Form D plus its
 * amendments. Managers file a new CIK per fund vintage, so a CIK is a fund and
 * the trail is that fund's raise.
 */
export type Raise = {
  cik: string
  fundName: string
  location: string | null
  layerHint: string | null
  filings: OfferingRecord[]
  /** From the newest filing. */
  target: number | "indefinite" | null
  sold: number | null
  investorCount: number | null
  minimumInvestment: number | null
  firstSale: string | null
  firstFiled: string | null
  lastFiled: string | null
  /**
   * The offering's SEC file number, `021-…`, the key a Form ADV uses for the
   * fund. Null for a trail cached before file numbers were read.
   */
  fileNumber: string | null
  /**
   * Sold as a share of target, 0–1. Null when the target is indefinite or
   * either side is missing — never a number computed against `"indefinite"`.
   */
  progress: number | null
  /** Sold per investor, from the newest filing. */
  averageTicket: number | null
  /** Change in sold and investors since the filing closest to twelve months earlier. */
  soldLastYear: number | null
  investorsLastYear: number | null
  /** True when any amendment reduced the stated target. */
  targetCut: boolean
  /** The largest target the fund ever stated, when it has since been cut. */
  targetHigh: number | null
  /** Quarters since the last filing, as a staleness measure for the stall signal. */
  quartersSinceFiling: number | null
  /** Who is paid to sell it, from the newest filing. */
  salesRecipients: SalesRecipient[]
  /** Officers, directors and promoters, from the newest filing. Not investors. */
  relatedPersons: RelatedPerson[]
  /** Whether the issuer accepted non-accredited investors, per the newest filing. */
  hasNonAccreditedInvestors: boolean | null
  /**
   * Structure and terms from the newest filing, with each co-issuer's
   * `firstSeen` filled from the trail. Null where no filing in the trail was
   * parsed with terms — an entry cached before they were read.
   */
  terms: OfferingTerms | null
  /**
   * Each point where the exemptions claimed changed between consecutive
   * filings, oldest first. A move from 506(b) to 506(c) is a manager starting
   * to advertise; adding 3(c)(7) is opening to qualified purchasers.
   */
  exemptionChanges: Array<{ filedAt: string; added: string[]; removed: string[] }>
}

function numericTarget(v: number | "indefinite" | null): number | null {
  return typeof v === "number" && v > 0 ? v : null
}

/** Whole months between two ISO dates, positive when `b` is later. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  return (by - ay) * 12 + (bm - am) - (bd < ad ? 1 : 0)
}

/**
 * Build the raise from one CIK's filings.
 *
 * `asOf` is the date the view is being computed for; it decides staleness, and
 * is passed in rather than read from the clock so the result is testable and
 * so a cached entry does not change meaning between reads.
 */
export function buildRaise(filings: OfferingRecord[], asOf: string): Raise | null {
  const ordered = [...filings]
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.filedAt))
    .sort((a, b) => (a.filedAt < b.filedAt ? -1 : a.filedAt > b.filedAt ? 1 : a.accession < b.accession ? -1 : 1))
  if (!ordered.length) return null

  const newest = ordered[ordered.length - 1]
  const oldest = ordered[0]

  const targets = ordered.map((f) => numericTarget(f.offeringAmount)).filter((n): n is number => n != null)
  const high = targets.length ? Math.max(...targets) : null
  const current = numericTarget(newest.offeringAmount)
  const targetCut = high != null && current != null && current < high

  const sold = newest.totalSold
  const progress = current != null && sold != null && current > 0 ? sold / current : null
  const averageTicket = sold != null && newest.investorCount ? sold / newest.investorCount : null

  // The filing closest to a year before the newest, so pace is measured over a
  // real interval rather than between whichever two filings happen to exist.
  let prior: OfferingRecord | null = null
  for (const f of ordered.slice(0, -1)) {
    const months = monthsBetween(f.filedAt, newest.filedAt)
    if (months >= 9) prior = f
  }
  const soldLastYear = prior && sold != null && prior.totalSold != null ? sold - prior.totalSold : null
  const investorsLastYear =
    prior && newest.investorCount != null && prior.investorCount != null
      ? newest.investorCount - prior.investorCount
      : null

  const months = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? monthsBetween(newest.filedAt, asOf) : null

  // The per-filing records are stored in the weekly cache, so they carry only
  // what the filing trail actually renders. `salesRecipients` and
  // `relatedPersons` are hoisted onto the raise from the newest filing below,
  // and keeping a copy on all nine filings of sixty-five vehicles added 155 KB
  // of which the related-person lists — which nothing displays — were 132 KB.
  const stored: OfferingRecord[] = ordered.map((f) => ({ ...f, salesRecipients: [], relatedPersons: [], terms: null }))

  // Terms come from the newest filing, but two things need the whole trail:
  // when each co-issuer first appeared, and how the exemptions moved.
  const withTerms = ordered.filter((f): f is OfferingRecord & { terms: OfferingTerms } => f.terms != null)
  const newestTerms = withTerms[withTerms.length - 1]?.terms ?? null
  const terms: OfferingTerms | null = newestTerms
    ? {
        ...newestTerms,
        coIssuers: newestTerms.coIssuers.map((c) => ({
          ...c,
          firstSeen: withTerms.find((f) => f.terms.coIssuers.some((x) => x.cik === c.cik))?.filedAt,
        })),
      }
    : null
  const exemptionChanges: Raise["exemptionChanges"] = []
  // `3C` is the umbrella code filed beside 3(c)(1), (5) or (7). H.I.G. adds and
  // drops it between amendments with no sub-item moving, which is a change in
  // how the form was filled in, not in what is claimed — so it is ignored here.
  const claimed = (codes: readonly string[]) => new Set(codes.filter((c) => c !== "3C"))
  for (let i = 1; i < withTerms.length; i++) {
    const before = claimed(withTerms[i - 1].terms.exemptions)
    const after = claimed(withTerms[i].terms.exemptions)
    const added = [...after].filter((x) => !before.has(x))
    const removed = [...before].filter((x) => !after.has(x))
    if (added.length || removed.length) exemptionChanges.push({ filedAt: withTerms[i].filedAt, added, removed })
  }

  return {
    cik: newest.cik,
    fundName: newest.entityName || oldest.entityName,
    location: newest.location ?? oldest.location,
    layerHint: null,
    filings: stored,
    target: newest.offeringAmount,
    sold,
    investorCount: newest.investorCount,
    minimumInvestment: newest.minimumInvestment,
    firstSale: ordered.map((f) => f.dateOfFirstSale).find((d) => d) ?? null,
    firstFiled: oldest.filedAt,
    lastFiled: newest.filedAt,
    fileNumber: ordered.map((f) => f.fileNumber ?? null).filter((n): n is string => n != null).pop() ?? null,
    progress,
    averageTicket,
    soldLastYear,
    investorsLastYear,
    targetCut,
    targetHigh: targetCut ? high : null,
    quartersSinceFiling: months == null ? null : Math.floor(months / 3),
    salesRecipients: newest.salesRecipients,
    relatedPersons: newest.relatedPersons,
    hasNonAccreditedInvestors: newest.hasNonAccreditedInvestors,
    terms,
    exemptionChanges,
  }
}

/**
 * Is this raise still open?
 *
 * A fund that has stopped filing amendments has almost always stopped raising,
 * but Form D carries no "closed" flag — the absence of a filing is the only
 * signal. Four quarters is the threshold because the annual amendment is
 * mandatory while the offering is open, so a year of silence means it is not.
 */
export function isLikelyOpen(raise: Raise): boolean {
  if (raise.quartersSinceFiling == null) return true
  return raise.quartersSinceFiling < 4
}

/** New if its first sale, or failing that its first filing, falls inside the window. */
export function isNewLaunch(raise: Raise, windowStart: string): boolean {
  const start = raise.firstSale ?? raise.firstFiled
  return start != null && start >= windowStart
}
