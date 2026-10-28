/**
 * Form ADV Part 1A, Schedule D, Section 7.B.(1): one record per private fund.
 *
 * The input is the ordered lines `adv-pdf.mts` reads from IAPD's PDF — text
 * plus, on each line, the checkbox marks drawn on it and whether each is
 * ticked. This module is pure and knows nothing about PDFs, so it runs under
 * the test runner with a fixture of real lines.
 *
 * **How answers are read.** A yes/no question draws two boxes on its own
 * line; the leftmost is "Yes" and the rightmost "No" (their x positions move
 * between questions — 688, 697, 708, 710, 719, 722 for Yes on one filing — so
 * only the order is trusted). Neither ticked is `null`, never a guess. An
 * option list draws one box per option in the order the options are printed;
 * question 10's seven fund types, question 4's two exclusions, and 23(h)'s
 * three-way answer are read that way.
 *
 * **What a figure means.** Gross asset value is gross — it includes borrowed
 * money. Beneficial owners is "approximate". Both are as of the filing, which
 * is the adviser's own figure, with the audit answers the independent part:
 * an auditor's name with a PCAOB number, and the (g) and (h) answers about
 * whether audited statements reached investors and whether the opinion was
 * unqualified, report what a third party did.
 */

/** A text line in reading order, with any checkbox marks drawn on it. Produced by `adv-pdf.mts`. */
export type AdvLine = {
  page: number
  /** PDF y of the line's baseline (origin bottom-left), for ordering only. */
  y: number
  text: string
  marks: AdvMark[]
}

export type AdvMark = {
  /** PDF x of the image's left edge. Yes-column boxes sit left of No-column boxes on the same line. */
  x: number
  width: number
  height: number
  /** Dark-pixel fraction of the image. */
  ink: number
  /** Decided by clustering the page's marks of the same size: the inkier cluster is ticked. */
  ticked: boolean
}

export type YesNo = boolean | null

export type AdvAuditor = {
  name: string
  city: string | null
  state: string | null
  country: string | null
  independent: YesNo
  pcaobRegistered: YesNo
  pcaobNumber: string | null
  pcaobInspected: YesNo
}

export type AdvCustodian = {
  name: string
  city: string | null
  state: string | null
  country: string | null
  relatedPerson: YesNo
}

export type AdvFund = {
  name: string
  /** `805-…` */
  fundId: string | null
  state: string | null
  country: string | null
  /** Question 3(a): GP, manager, trustee or directors, as listed. */
  generalPartners: string[]
  /** Question 3(b): the filing or relying advisers named under an umbrella registration. */
  umbrellaAdvisers: string[]
  /** Question 4. Both may be ticked. */
  exclusion3c1: YesNo
  exclusion3c7: YesNo
  isMasterFund: YesNo
  /** Question 6(b): feeders investing in this fund, when it is a master. */
  feeders: Array<{ name: string; fundId: string | null }>
  isFeederFund: YesNo
  /** Question 6(d): the master, when this is a feeder. */
  master: { name: string; fundId: string | null } | null
  fundOfFunds: YesNo
  /** Question 10, as printed: hedge, liquidity, private equity, real estate, securitized asset, venture capital, other. */
  fundTypes: string[]
  grossAssetValue: number | null
  minimumInvestment: number | null
  beneficialOwners: number | null
  pctOwnedByRelated: number | null
  pctOwnedByFundsOfFunds: number | null
  /** Question 15(b): for a 3(c)(1) fund, whether sales are limited to qualified clients. */
  salesLimitedToQualifiedClients: YesNo
  pctOwnedByNonUs: number | null
  isSubadviser: YesNo
  otherAdvisersAdvise: YesNo
  clientsSolicited: YesNo
  pctClientsInvested: number | null
  reliedOnRegulationD: YesNo
  /** Question 22: `021-…`, the link to this fund's Form D. */
  formDFileNumber: string | null
  annualAudit: YesNo
  gaap: YesNo
  auditors: AdvAuditor[]
  /** Question 23(g). */
  statementsDistributed: YesNo
  /** Question 23(h): whether every audit report since the last annual update carried an unqualified opinion. */
  opinion: "unqualified" | "not-unqualified" | "report-not-yet-received" | null
  usesPrimeBroker: YesNo
  primeBrokers: string[]
  usesCustodian: YesNo
  custodians: AdvCustodian[]
  administrators: string[]
  /** Question 27: share of assets valued by someone other than the adviser or a related person. */
  pctAssetsValuedByOthers: number | null
  marketers: string[]
}

export type AdvFiling = {
  crd: string
  /** "Primary Business Name" on the cover. */
  adviserName: string
  /** e.g. "Annual Amendment - All Sections", "Other-Than-Annual Amendment - All Sections". */
  filingType: string | null
  /** `YYYY-MM-DD`, from the cover's timestamp. */
  filedOn: string | null
  /** "Total Funds: N" on the section header; null where the section says "No Information Filed". */
  fundsReported: number | null
  funds: AdvFund[]
  /** Anything the parser could not reconcile, for the refresh report. */
  notes: string[]
}

const PLACEHOLDER = /^(No Information Filed|-|—|N\/A)$/i

function money(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.replace(/[$,\s]/g, "")
  if (!/^-?\d+(\.\d+)?$/.test(m)) return null
  return Number(m)
}

function integer(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.replace(/[,\s]/g, "")
  return /^\d+$/.test(m) ? Number(m) : null
}

function percent(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%$/)
  return m ? Number(m[1]) : null
}

/** Leftmost box is Yes, rightmost No; neither ticked, or fewer than two boxes, is null. */
export function yesNo(line: AdvLine | undefined): YesNo {
  if (!line || line.marks.length < 2) return null
  const yes = line.marks[0]
  const no = line.marks[line.marks.length - 1]
  if (yes.ticked && !no.ticked) return true
  if (no.ticked && !yes.ticked) return false
  return null
}

/** The ticked options of a list drawn on one line, by the order printed. */
export function tickedOptions(line: AdvLine | undefined, options: readonly string[]): string[] {
  if (!line || line.marks.length < options.length) return []
  return options.filter((_, i) => line.marks[i].ticked)
}

const FUND_TYPES = ["hedge fund", "liquidity fund", "private equity fund", "real estate fund", "securitized asset fund", "venture capital fund", "other private fund"] as const

/** A small cursor over the record's lines. */
class Cursor {
  constructor(
    readonly lines: AdvLine[],
    public i = 0
  ) {}
  /** Index of the first line at or after `from` whose text matches, or -1. */
  find(re: RegExp, from = this.i): number {
    for (let k = from; k < this.lines.length; k++) if (re.test(this.lines[k].text)) return k
    return -1
  }
  text(k: number): string | null {
    return k >= 0 && k < this.lines.length ? this.lines[k].text : null
  }
  /** The text of the line after the first match, unless it is a placeholder. */
  valueAfter(re: RegExp, from = this.i): string | null {
    const k = this.find(re, from)
    if (k < 0) return null
    const v = this.text(k + 1)
    return v && !PLACEHOLDER.test(v) ? v : null
  }
  lineMatching(re: RegExp, from = this.i): AdvLine | undefined {
    const k = this.find(re, from)
    return k < 0 ? undefined : this.lines[k]
  }
}

/** "SAFE HARBOR … FEEDER, L.P. 805-9876746577" → name and id. */
function nameAndId(s: string): { name: string; fundId: string | null } {
  const m = s.match(/^(.*?)\s+(805-\d+)\s*$/)
  return m ? { name: m[1].trim(), fundId: m[2] } : { name: s.trim(), fundId: null }
}

/** "City: State: Country:" followed by "MIAMI Florida United States" — the values are unlabelled and space-separated. */
function cityStateCountry(valueLine: string | null): { city: string | null; state: string | null; country: string | null } {
  if (!valueLine || PLACEHOLDER.test(valueLine)) return { city: null, state: null, country: null }
  const countries = ["United States", "Cayman Islands", "United Kingdom", "Luxembourg", "Ireland", "Bermuda", "Canada", "Jersey", "Guernsey"]
  let rest = valueLine.trim()
  let country: string | null = null
  for (const c of countries) {
    if (rest.endsWith(c)) {
      country = c
      rest = rest.slice(0, -c.length).trim()
      break
    }
  }
  if (!country) {
    const parts = rest.split(/\s+/)
    country = parts.pop() ?? null
    rest = parts.join(" ")
  }
  // State is the last word (or two for "New York", "New Jersey", …); city is the rest.
  const twoWordStates = /\b(New York|New Jersey|North Carolina|South Carolina|North Dakota|South Dakota|New Hampshire|New Mexico|Rhode Island|West Virginia|District of Columbia)$/
  const two = rest.match(twoWordStates)
  const state = two ? two[1] : (rest.split(/\s+/).pop() ?? null)
  const city = state ? rest.slice(0, rest.length - state.length).trim() : rest
  return { city: city || null, state: state || null, country }
}

function parseFund(lines: AdvLine[]): AdvFund {
  const c = new Cursor(lines)
  const name = c.text(1) ?? ""
  const idLine = c.find(/^\(b\) Private fund identification number/)
  let fundId: string | null = null
  for (let k = idLine + 1; k <= idLine + 3 && k < lines.length; k++) {
    const m = lines[k]?.text.match(/^(805-\d+)$/)
    if (m) {
      fundId = m[1]
      break
    }
  }
  const stateLine = c.find(/^2\. Under the laws of what state/)
  const sc = stateLine >= 0 ? cityStateCountry("x " + (c.text(stateLine + 2) ?? "")) : { state: null, country: null }
  // "Delaware United States": cityStateCountry treats the leading word as city; shift it.
  const state = sc.country ? (c.text(stateLine + 2) ?? "").replace(sc.country, "").trim() || null : null

  const gpHeader = c.find(/^Name of General Partner, Manager, Trustee, or Director$/)
  const umbrellaLine = c.find(/^\(b\) If filing an umbrella registration/)
  const generalPartners: string[] = []
  if (gpHeader >= 0 && umbrellaLine > gpHeader) for (let k = gpHeader + 1; k < umbrellaLine; k++) generalPartners.push(lines[k].text)
  const q4 = c.find(/^4\. The private fund \(check all that apply/)
  const umbrellaAdvisers: string[] = []
  if (umbrellaLine >= 0 && q4 > umbrellaLine) {
    for (let k = umbrellaLine + 1; k < q4; k++) {
      const t = lines[k].text
      if (!PLACEHOLDER.test(t) && !/^Name of /.test(t) && !/^\(b\) /.test(t)) umbrellaAdvisers.push(t)
    }
  }

  const exclusion3c1 = (() => {
    const l = c.lineMatching(/^\(1\) qualifies for the exclusion .* 3\(c\)\(1\)/, q4)
    return l && l.marks.length ? l.marks[0].ticked : null
  })()
  const exclusion3c7 = (() => {
    const l = c.lineMatching(/^\(2\) qualifies for the exclusion .* 3\(c\)\(7\)/, q4)
    return l && l.marks.length ? l.marks[0].ticked : null
  })()

  const masterQ = c.find(/^6\. \(a\) Is this a "master fund"/)
  const isMasterFund = yesNo(lines[masterQ])
  const feeders: AdvFund["feeders"] = []
  const feederQ = c.find(/^\(c\) Is this a "feeder fund"/, masterQ)
  if (isMasterFund && masterQ >= 0 && feederQ > masterQ) {
    const hdr = c.find(/^Name of private fund Private fund identification number$/, masterQ)
    if (hdr > 0 && hdr < feederQ) for (let k = hdr + 1; k < feederQ; k++) {
      const t = lines[k].text
      if (/^Yes No$/.test(t)) break
      if (!PLACEHOLDER.test(t)) feeders.push(nameAndId(t))
    }
  }
  const isFeederFund = yesNo(lines[feederQ])
  let master: AdvFund["master"] = null
  if (isFeederFund) {
    const nm = c.valueAfter(/^Name of private fund ?:$/, feederQ)
    const idK = c.find(/^\(include the "805-" prefix also\)$/, feederQ)
    const idv = c.text(idK + 1)
    if (nm) master = { name: nm, fundId: idv && /^805-\d+$/.test(idv) ? idv : null }
  }

  const fundOfFunds = yesNo(c.lineMatching(/^8\. \(a\) Is this private fund a "fund of funds"/))
  const fundTypes = tickedOptions(c.lineMatching(/^hedge fund liquidity fund private equity fund/), FUND_TYPES)

  const grossAssetValue = money(c.valueAfter(/^11\. Current gross asset value/))
  const minimumInvestment = money(c.valueAfter(/^12\. Minimum investment commitment/))
  const beneficialOwners = integer(c.valueAfter(/^13\. Approximate number of the private fund's beneficial owners/))
  const pctOwnedByRelated = percent(c.valueAfter(/^14\. What is the approximate percentage .* by you and your related persons/))
  const pctOwnedByFundsOfFunds = percent(c.valueAfter(/^15\. \(a\) What is the approximate percentage .* funds of funds/))
  const salesLimitedToQualifiedClients = yesNo(c.lineMatching(/^\(b\) If the private fund qualifies for the exclusion .* 3\(c\)\(1\)/))
  const pctOwnedByNonUs = percent(c.valueAfter(/^16\. What is the approximate percentage .* non- ?United States persons/))
  const isSubadviser = yesNo(c.lineMatching(/^17\. \(a\) Are you a subadviser/))
  const otherAdvisersAdvise = yesNo(c.lineMatching(/^18\. \(a\) Do any investment advisers/))
  const clientsSolicited = yesNo(c.lineMatching(/^19\. Are your clients solicited/))
  const pctClientsInvested = percent(c.valueAfter(/^20\. Approximately what percentage of your clients/))
  const reliedOnRegulationD = yesNo(c.lineMatching(/^21\. Has the private fund ever relied on an exemption/))
  const formD = c.valueAfter(/^Form D file number$/)
  const formDFileNumber = formD && /^0\d\d-\d+$/.test(formD) ? formD : null

  const auditQ = c.find(/^23\. \(a\) \(1\) Are the private fund's financial statements subject to an annual audit/)
  const annualAudit = yesNo(lines[auditQ])
  const gaap = yesNo(c.lineMatching(/^\(2\) If the answer to question 23\.\(a\)\(1\) is "yes," are the financial statements/, auditQ))
  const auditors: AdvAuditor[] = []
  const primeQ = c.find(/^24\. \(a\) Does the private fund use one or more prime brokers/, auditQ)
  const auditEnd = primeQ > 0 ? primeQ : lines.length
  for (let k = c.find(/^\(b\) Name of the auditing firm:?$/, auditQ); k >= 0 && k < auditEnd; k = c.find(/^\(b\) Name of the auditing firm:?$/, k + 1)) {
    const nm = c.text(k + 1)
    if (!nm || PLACEHOLDER.test(nm)) continue
    const loc = cityStateCountry(c.text(c.find(/^City: State: Country:$/, k) + 1))
    const pcaobK = c.find(/^If yes, Public Company Accounting Oversight Board-Assigned Number:?$/, k)
    const pcaobV = pcaobK > 0 && pcaobK < auditEnd ? c.text(pcaobK + 1) : null
    auditors.push({
      name: nm,
      ...loc,
      independent: yesNo(c.lineMatching(/^\(d\) Is the auditing firm an independent public accountant/, k)),
      pcaobRegistered: yesNo(c.lineMatching(/^\(e\) Is the auditing firm registered with the Public Company/, k)),
      pcaobNumber: pcaobV && /^\d+$/.test(pcaobV) ? pcaobV : null,
      pcaobInspected: yesNo(c.lineMatching(/^\(f\) If "yes" to \(e\) above, is the auditing firm subject to regular inspection/, k)),
    })
  }
  const statementsDistributed = yesNo(c.lineMatching(/^\(g\) Are the private fund's audited financial statements/, auditQ))
  const opinionLine = c.lineMatching(/^Yes No Report Not Yet Received$/, auditQ)
  const opinionTicked = tickedOptions(opinionLine, ["unqualified", "not-unqualified", "report-not-yet-received"])
  const opinion = (opinionTicked[0] as AdvFund["opinion"]) ?? null

  const usesPrimeBroker = yesNo(lines[primeQ])
  const primeBrokers: string[] = []
  const custQ = c.find(/^25\. \(a\) Does the private fund use any custodians/, primeQ > 0 ? primeQ : auditQ)
  for (let k = c.find(/^\(b\) Name of the prime broker:?$/, primeQ); primeQ > 0 && k > 0 && k < custQ; k = c.find(/^\(b\) Name of the prime broker:?$/, k + 1)) {
    const nm = c.text(k + 1)
    if (nm && !PLACEHOLDER.test(nm)) primeBrokers.push(nm)
  }
  const usesCustodian = yesNo(lines[custQ])
  const custodians: AdvCustodian[] = []
  const adminQ = c.find(/^26\. \(a\) Does the private fund use an administrator/, custQ)
  const custEnd = adminQ > 0 ? adminQ : lines.length
  for (let k = c.find(/^\(b\) Legal name of custodian:?$/, custQ); custQ > 0 && k > 0 && k < custEnd; k = c.find(/^\(b\) Legal name of custodian:?$/, k + 1)) {
    const nm = c.text(k + 1)
    if (!nm || PLACEHOLDER.test(nm)) continue
    const loc = cityStateCountry(c.text(c.find(/^City: State: Country:$/, k) + 1))
    custodians.push({ name: nm, ...loc, relatedPerson: yesNo(c.lineMatching(/^\(e\) Is the custodian a related person of your firm/, k)) })
  }
  const administrators: string[] = []
  const valQ = c.find(/^27\. During your last fiscal year, what percentage of the private fund's assets/, adminQ > 0 ? adminQ : custQ)
  for (let k = c.find(/^\(b\) Name of administrator:?$/, adminQ); adminQ > 0 && k > 0 && (valQ < 0 || k < valQ); k = c.find(/^\(b\) Name of administrator:?$/, k + 1)) {
    const nm = c.text(k + 1)
    if (nm && !PLACEHOLDER.test(nm)) administrators.push(nm)
  }
  const pctAssetsValuedByOthers = valQ > 0 ? percent(c.text(valQ + 1)) ?? percent(c.text(valQ + 2)) : null
  const marketers: string[] = []
  const mkQ = c.find(/^28\. \(a\) Does the private fund use the services of someone other than you/, valQ > 0 ? valQ : custQ)
  for (let k = c.find(/^\(c\) Name of the marketer:?$/, mkQ); mkQ > 0 && k > 0; k = c.find(/^\(c\) Name of the marketer:?$/, k + 1)) {
    const nm = c.text(k + 1)
    if (nm && !PLACEHOLDER.test(nm)) marketers.push(nm)
  }

  return {
    name,
    fundId,
    state,
    country: sc.country,
    generalPartners,
    umbrellaAdvisers,
    exclusion3c1,
    exclusion3c7,
    isMasterFund,
    feeders,
    isFeederFund,
    master,
    fundOfFunds,
    fundTypes,
    grossAssetValue,
    minimumInvestment,
    beneficialOwners,
    pctOwnedByRelated,
    pctOwnedByFundsOfFunds,
    salesLimitedToQualifiedClients,
    pctOwnedByNonUs,
    isSubadviser,
    otherAdvisersAdvise,
    clientsSolicited,
    pctClientsInvested,
    reliedOnRegulationD,
    formDFileNumber,
    annualAudit,
    gaap,
    auditors,
    statementsDistributed,
    opinion,
    usesPrimeBroker,
    primeBrokers,
    usesCustodian,
    custodians,
    administrators,
    pctAssetsValuedByOthers,
    marketers,
  }
}

/** The cover's date "5/4/2026 11:19:59 AM" → `2026-05-04`. */
export function coverDate(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/)
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null
}

/**
 * Parse a whole filing's lines.
 *
 * Fund records are split at "1. (a) Name of the private fund :" and end at
 * the next record or at SECTION 7.B.(2). A filing whose 7.B.(1) says "No
 * Information Filed" yields no funds and `fundsReported: null`, which is a
 * fact about the adviser — Madison Realty Capital's does — not a parse
 * failure; the note says which.
 */
export function parseAdvFiling(crd: string, lines: AdvLine[]): AdvFiling {
  const notes: string[] = []
  const c = new Cursor(lines)
  const coverName = c.text(c.find(/^Primary Business Name:/))?.match(/^Primary Business Name:\s*(.*?)\s+CRD Number:\s*(\d+)/)
  const adviserName = coverName?.[1] ?? ""
  if (coverName && coverName[2] !== crd) notes.push(`cover says CRD ${coverName[2]}, expected ${crd}`)
  const filingType = c.text(c.find(/Amendment - All Sections|Initial Application|Rev\. \d{2}\/\d{4}$/))?.replace(/\s*Rev\. \d{2}\/\d{4}$/, "").trim() ?? null
  const filedOn = coverDate(c.text(c.find(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M$/)))

  const section = c.find(/^SECTION 7\.B\.\(1\) Private Fund Reporting$/)
  if (section < 0) {
    notes.push("no SECTION 7.B.(1) in the filing")
    return { crd, adviserName, filingType, filedOn, fundsReported: null, funds: [], notes }
  }
  const sectionEnd = (() => {
    const e = c.find(/^SECTION 7\.B\.\(2\) Private Fund Reporting$/, section + 1)
    return e < 0 ? lines.length : e
  })()
  // A filing of up to 15 funds carries "Funds per Page: 15 Total Funds: N"
  // under the section heading; one of more than 15 is paginated and carries
  // no total at all, going straight to "A. PRIVATE FUND". Only a heading that
  // is neither of those, nor the no-funds placeholder, is worth a note.
  const header = c.text(section + 1)
  const total = header?.match(/Total Funds:\s*(\d+)/)
  const fundsReported = total ? Number(total[1]) : null
  if (!total) {
    if (header && PLACEHOLDER.test(header)) notes.push("7.B.(1) reports no private funds")
    else if (header !== "A. PRIVATE FUND") notes.push(`7.B.(1) header not understood: ${JSON.stringify(header)}`)
  }

  const starts: number[] = []
  for (let k = section; k < sectionEnd; k++) if (/^1\. \(a\) Name of the private fund ?:$/.test(lines[k].text)) starts.push(k)
  const funds = starts.map((s, i) => parseFund(lines.slice(s, starts[i + 1] ?? sectionEnd)))
  if (fundsReported != null && funds.length !== fundsReported) notes.push(`header says ${fundsReported} funds, parsed ${funds.length}`)
  for (const f of funds) if (f.grossAssetValue == null) notes.push(`${f.name}: gross asset value not read`)

  return { crd, adviserName, filingType, filedOn, fundsReported, funds, notes }
}
