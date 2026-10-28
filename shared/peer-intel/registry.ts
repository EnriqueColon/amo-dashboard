/**
 * The three-layer peer registry.
 *
 * Who counts as a competitor is a judgement, not a query result, so this file
 * is curated and reviewed rather than generated. `scripts/discover-peers.ts`
 * proposes candidates from EDGAR; this file records which of them are actually
 * peers, grouped by **manager** rather than by fund, because a manager files a
 * new CIK for each vintage and the question "how is this competitor raising?"
 * spans all of them.
 *
 * **Why three layers.** Safe Harbor is a lower-middle-market South Florida
 * manager: four vintages, $500M+ invested, deals in the $8.5M–$44M range,
 * buying non-performing CRE loans from banks. Its competition for LP dollars is
 * not Blackstone — several of the mega-managers are counterparties, selling
 * pools rather than bidding against it. So the layers separate the firms that
 * compete for the same deals and the same allocations (Miami-Dade), the ones
 * that compete statewide (Florida), and the broader private credit market the
 * brief also asks about (national), where the large registered vehicles live.
 *
 * **`relevance`** is the honest part. `direct` means there is evidence the
 * vehicle invests in real-estate credit or distressed debt — its Form D
 * industry group and fund type, its legal name, or published reporting.
 * `adjacent` means it is a nearby strategy (real-estate equity, generalist
 * private credit) worth watching but not a like-for-like comparison. Nothing
 * is marked `direct` on a guess.
 *
 * **`kind`** is not curated: `app/services/peer-intel.ts` decides it from what
 * the entity actually files, because it changes when a manager registers a
 * vehicle. The values here are the state at the time of the step 1 audit
 * (2026-10-21) and are re-derived on every run.
 *
 * Every CIK below was resolved against live EDGAR during that audit.
 */

import type { PeerLayer } from "./edgar-contract"

export type VehicleKind = "private" | "registered"

/**
 * Whether a vehicle is a raise in its own right.
 *
 * A single fundraise is routinely spread across several CIKs — an onshore LP, an
 * offshore or international feeder, a master, a parallel or "-R" sleeve. Each
 * files its own Form D, and each reports its own slice of the capital, so
 * counting them as separate raises would overstate the number of funds in the
 * market and understate the size of each. `sleeve` vehicles carry real capital
 * and are summed; they are not counted as distinct raises.
 *
 * Not represented here at all are the "Holdings LLC" aggregator shells that
 * some managers file alongside each vintage — Madison Realty has one per fund,
 * every single one reporting a $125,000 target fully sold to exactly 125
 * investors. They are a structural artefact of the feeder, not fundraising, and
 * including them would put a run of spurious "100% subscribed" rows into the
 * table. They are deliberately omitted.
 */
export type VehicleRole = "fund" | "sleeve"

/**
 * Whether a registered vehicle's shares trade.
 *
 * This decides what its flows *mean*, and it is not cosmetic. For a
 * **non-traded** BDC or REIT, share repurchases are the redemption programme
 * paying investors out and issuance is subscriptions coming in — together, the
 * evergreen liquidity signal the brief asks for. For a **listed** company the
 * same two tags are a buyback and an equity raise: capital-markets decisions
 * that say almost the opposite about investor demand, and that an investor
 * wanting out would not use at all, because they would simply sell the stock.
 *
 * So net flow is computed only for non-traded vehicles. Listed ones still
 * contribute portfolio and performance figures, where the tags mean the same
 * thing in both.
 */
export type VehicleQuotation = "listed" | "non-traded"

export type PeerVehicle = {
  /** Unpadded CIK, as EDGAR Archives paths use it. */
  cik: string
  name: string
  /**
   * `registered` entities file periodic reports and so have observable
   * quarterly redemption and portfolio figures; `private` ones have Form D and
   * nothing else. Re-derived at fetch time; this is the audited value.
   */
  kind: VehicleKind
  /** Defaults to `fund` when absent. */
  role?: VehicleRole
  /**
   * Required in practice for a `registered` vehicle, since it decides whether
   * its flows describe investor liquidity or a capital-markets decision.
   * Meaningless for a private fund, whose units do not trade at all.
   */
  quoted?: VehicleQuotation
  /**
   * The vehicle's own adviser on IAPD, where it differs from the manager's.
   *
   * A sponsor registers several advisers — Blackstone's BREIT is advised by
   * BX REIT Advisors and its BCRED by Blackstone Credit BDC Advisors — and
   * the Form ADV that lists a fund is the one filed by *its* adviser. Set
   * from the name the vehicle's own 10-K or Schedule TO gives, confirmed on
   * IAPD; absent means the manager's `adviser` applies.
   */
  adviser?: { crd: string; secNumber: string | null; name: string; basis: string; confirmedOn: string }
}

export type Peer = {
  /** Stable slug; used in cache keys and as the drawer's route value. */
  id: string
  /** The manager, not the fund. */
  manager: string
  layer: PeerLayer
  /** Business location as EDGAR reports it, `City, ST`. */
  location: string
  relevance: "direct" | "adjacent"
  /** Why this manager is in the registry, and where the strategy claim comes from. */
  evidence: string
  aliases: string[]
  website?: string
  vehicles: PeerVehicle[]
  /** Safe Harbor itself, shown alongside the peers rather than hidden. */
  isSelf?: boolean
  /**
   * The manager's SEC adviser record, which is the key to its Form ADV.
   *
   * Proposed by `npm run resolve:peer-crds` from IAPD's search and confirmed
   * by a person before it is written here — the search returns look-alikes
   * (Safe Harbor Family Capital beside Safe Harbor Capital Partners) and caps
   * large sponsors' results, so no CRD is recorded unreviewed. `basis` says
   * what the confirmation rested on. Absent means not yet resolved, or
   * resolved to "no adviser on file", which `noAdviser` records.
   */
  adviser?: {
    crd: string
    /** `801-…` registered, `802-…` exempt reporting adviser. */
    secNumber: string | null
    /** The adviser's name on IAPD, which may differ from the manager's. */
    name: string
    /** How it was confirmed, e.g. "exact name and Miami office; Form D names SHE DDF1 Manager as GP". */
    basis: string
    /** `YYYY-MM-DD` of the review. */
    confirmedOn: string
  }
  /** Reviewed and found to have no SEC adviser record under any known name. */
  noAdviser?: { checkedOn: string; note: string }
}

export const PEERS: readonly Peer[] = [
  // ---------------------------------------------------------------- Miami-Dade
  {
    id: "safe-harbor-capital-partners",
    manager: "Safe Harbor Capital Partners",
    layer: "miami-dade",
    location: "Miami Beach, FL",
    relevance: "direct",
    evidence:
      "The firm itself. Acquires non-performing and sub-performing first mortgages and originates high-yield CRE financing; four fund vintages since 2015.",
    aliases: ["Safe Harbor Equity", "Safe Harbor Equity Distressed Debt Fund", "SHCP", "SHE"],
    website: "https://safeharborcp.com",
    isSelf: true,
    adviser: { crd: "305314", secNumber: "801-117908", name: "SAFE HARBOR CAPITAL PARTNERS", basis: "Exact name, Coconut Grove FL office; IAPD lists SHE DDF1 Manager LLC, the Fund 1 GP, among its other names", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1637588", name: "Safe Harbor Equity Distressed Debt Fund 1, L.P.", kind: "private" },
      { cik: "1685329", name: "Safe Harbor Equity Distressed Debt Fund 2, L.P.", kind: "private" },
      { cik: "1778808", name: "Safe Harbor Equity Distressed Debt Fund 3, L.P.", kind: "private" },
      { cik: "2017189", name: "Safe Harbor Equity Distressed Debt Fund 4, L.P.", kind: "private" },
    ],
  },
  {
    id: "rialto-capital-management",
    manager: "Rialto Capital Management",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "direct",
    evidence:
      "Miami-headquartered CRE credit and special-situations manager — the largest direct peer in the county by a wide margin. Rialto Real Estate Fund V - Debt raised $2.61B from 914 investors; Hines Rialto Credit Partners and Rialto Credit Opportunities are both still filing. Found by targeted lookup, not by name-pattern discovery, because its funds are named after the firm rather than the strategy.",
    aliases: ["Rialto", "Rialto Capital", "Rialto Real Estate Fund", "Rialto Credit"],
    website: "https://www.rialtocapital.com",
    adviser: { crd: "159998", secNumber: "801-74178", name: "RIALTO CAPITAL MANAGEMENT, LLC", basis: "Exact name and Miami office; other names are the fund GPs its Form Ds list (RCCF GP II, RSSF GP)", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2026136", name: "Hines Rialto Credit Partners, LP", kind: "private" },
      { cik: "1912768", name: "Rialto Credit Opportunities Fund, LP", kind: "private" },
      { cik: "1912769", name: "Rialto Credit Opportunities Fund (Offshore), LP", kind: "private", role: "sleeve" },
      { cik: "2143451", name: "Rialto Insurance Credit Partners, LP", kind: "private" },
      { cik: "1986577", name: "Rialto Real Estate Fund V - Debt, LP", kind: "private" },
      { cik: "1788190", name: "Rialto Real Estate Fund IV - Debt, LP", kind: "private" },
      { cik: "1942076", name: "Rialto Credit Partnership II, LP", kind: "private" },
      { cik: "1831112", name: "Rialto Relative Value Credit Fund, LP", kind: "private" },
      { cik: "1818200", name: "Rialto Special Situations Fund II, LP", kind: "private" },
    ],
  },
  {
    id: "bayview-asset-management",
    manager: "Bayview Asset Management",
    layer: "miami-dade",
    location: "Coral Gables, FL",
    relevance: "direct",
    evidence:
      "Form D: 'Bayview Commercial Real Estate Credit Fund', industry Pooled Investment Fund / Hedge Fund. A long-standing mortgage-credit and NPL buyer; the closest large peer in the county.",
    aliases: ["Bayview", "Bayview Asset Management LLC", "Bayview Opportunity"],
    adviser: { crd: "157053", secNumber: "801-73638", name: "BAYVIEW ASSET MANAGEMENT, LLC", basis: "Exact name and Florida office; Form D GP entities among its other names", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2053256", name: "Bayview Commercial Real Estate Credit Fund Domestic, L.P.", kind: "private" },
      { cik: "2053157", name: "Bayview Commercial Real Estate Credit Fund Domestic (Employee), L.P.", kind: "private" },
      { cik: "1925643", name: "Bayview Opportunity Fund Domestic VII, L.P.", kind: "private" },
      { cik: "1944326", name: "Bayview Opportunity Fund Domestic (Employee) VII, L.P.", kind: "private" },
    ],
  },
  {
    id: "3650-reit",
    manager: "3650 REIT",
    layer: "miami-dade",
    location: "Coconut Grove, FL",
    relevance: "direct",
    evidence: "Form D: '3650 Real Estate Credit Solutions Fund 5', Pooled Investment Fund. CRE bridge and event-driven lender.",
    aliases: ["3650 Capital", "3650 Real Estate Credit Solutions"],
    adviser: { crd: "286013", secNumber: "801-110624", name: "3650 REIT INVESTMENT MANAGEMENT LLC", basis: "Form D names it as investment manager; Miami office", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "2033725", name: "3650 Real Estate Credit Solutions Fund 5 LP", kind: "private" }],
  },
  {
    id: "hig-bayside",
    manager: "H.I.G. Capital (Bayside)",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "direct",
    evidence: "Form D: 'H.I.G. Bayside Loan Opportunity Fund' series. H.I.G.'s distressed-debt arm; buys loans, larger cheque size than Safe Harbor.",
    aliases: ["H.I.G.", "HIG Capital", "Bayside Capital", "H.I.G. Bayside"],
    adviser: { crd: "160711", secNumber: "801-74338", name: "H.I.G. CAPITAL, LLC", basis: "Umbrella filer; lists Bayside Capital, Inc. and WhiteHorse Capital Management as relying advisers; Miami office", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1899762", name: "H.I.G. Bayside Loan Opportunity Fund VII (Europe-US$), L.P.", kind: "private" },
      { cik: "1954463", name: "H.I.G. Bayside Loan Opportunity Fund VIII, L.P.", kind: "private" },
    ],
  },
  {
    id: "omnia",
    manager: "Omnia",
    layer: "miami-dade",
    location: "Aventura, FL",
    relevance: "direct",
    evidence: "Form D: 'Omnia Real Estate Debt Income Fund', Pooled Investment Fund / Hedge Fund. Closest size match to Safe Harbor's current raise.",
    aliases: ["Omnia Real Estate Debt Income Fund"],
    adviser: { crd: "170909", secNumber: "801-79590", name: "OMNIA FAMILY WEALTH, LLC", basis: "The Omnia Real Estate Debt Income Fund Form D names it as the fund's investment manager; Aventura FL office", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1858491", name: "Omnia Real Estate Debt Income Fund, LLC", kind: "private" }],
  },
  {
    id: "atipana-credit",
    manager: "Atipana Credit",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "direct",
    evidence: "Form D: 'Atipana Credit Opportunity Fund I', Pooled Investment Fund / Private Equity Fund. Small credit manager.",
    aliases: ["Atipana"],
    noAdviser: { checkedOn: "2026-10-26", note: "Searched the manager name, aliases and Form D entities on 2026-10-26; no adviser under any of them. Candidates were unrelated firms" },
    vehicles: [{ cik: "1796170", name: "Atipana Credit Opportunity Fund I, LP", kind: "private" }],
  },
  {
    id: "rr-capital",
    manager: "R&R Capital",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "direct",
    evidence:
      "Form D industry group 'Other Real Estate'; the firm describes itself (777 Brickell) as handling distressed residential mortgage assets. Raise not yet begun at the audit.",
    aliases: ["R & R Capital", "R&R Capital Holdings"],
    noAdviser: { checkedOn: "2026-10-26", note: "No adviser under R&R Capital or its Form D entities; a lender raising under Rule 506(c) without a registered adviser" },
    vehicles: [{ cik: "2131969", name: "R & R Capital Opportunity Fund LLC", kind: "private" }],
  },
  {
    id: "integra",
    manager: "Integra",
    layer: "miami-dade",
    location: "Miami, FL",
    relevance: "adjacent",
    evidence: "Form D industry group 'Other Real Estate' — multifamily equity, not credit. Competes for the same LP wallet, not the same assets.",
    aliases: ["Integra Multifamily"],
    noAdviser: { checkedOn: "2026-10-26", note: "No adviser for Integra Investments. Integra Wealth (Coconut Grove) is an unrelated wealth advisory" },
    vehicles: [{ cik: "2107754", name: "Integra Multifamily Opportunity Fund LP", kind: "private" }],
  },
  {
    id: "seglo",
    manager: "SEGLO",
    layer: "miami-dade",
    location: "Aventura, FL",
    relevance: "adjacent",
    evidence: "Form D: 'SEGLO Private Credit & Opportunity Fund', industry group 'Investing' with no fund type. Private credit, strategy not stated.",
    aliases: ["SEGLO Private Credit"],
    noAdviser: { checkedOn: "2026-10-26", note: "No IAPD hit under the manager name, aliases or Form D entities" },
    vehicles: [{ cik: "2081957", name: "SEGLO Private Credit & Opportunity Fund LLC", kind: "private" }],
  },

  // ------------------------------------------------------------------ Florida
  {
    id: "bh3-management",
    manager: "BH3 Management",
    layer: "florida",
    location: "Fort Lauderdale, FL",
    relevance: "direct",
    evidence:
      "Form D: 'BH3 Debt Opportunity Fund' II and III plus offshore, parallel and Harel sleeves. South Florida distressed CRE debt; Fund III filed 2026-10-08, the most recent peer launch found.",
    aliases: ["BH3", "BH3 Debt Opportunity"],
    adviser: { crd: "298967", secNumber: "801-130429", name: "BH3 FUND ADVISORS, LLC", basis: "Form D lists it as investment manager of the BH3 debt funds; IAPD has no record under the BH3 Management name", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1967366", name: "BH3 Debt Opportunity Fund II, L.P.", kind: "private" },
      { cik: "2021809", name: "BH3 Debt Opportunity Fund II-Offshore, L.P.", kind: "private" },
      { cik: "2000027", name: "BH3 Debt Opportunity Fund II-Parallel, L.P.", kind: "private" },
      { cik: "2158615", name: "BH3 Debt Opportunity Fund III L.P.", kind: "private" },
      { cik: "2158616", name: "BH3 Debt Opportunity Fund III-Offshore L.P.", kind: "private" },
      { cik: "2107712", name: "BH3 Harel Debt Opportunity Fund, LP", kind: "private" },
    ],
  },
  {
    id: "gelt-financial",
    manager: "Gelt Financial",
    layer: "florida",
    location: "Delray Beach, FL",
    relevance: "direct",
    evidence:
      "Buys non-performing and sub-performing CRE loans of $100K–$5M — the closest strategy and cheque-size match to Safe Harbor outside Miami-Dade. Its only Reg D raise ($1.8M, 12 investors) closed in 2019, so it appears to lend from its own balance sheet; the fundraising panels will show that raise as long closed, which is itself the useful fact about this competitor.",
    aliases: ["Gelt", "Gelt Financial LLC"],
    website: "https://geltfinancial.com",
    noAdviser: { checkedOn: "2026-10-26", note: "No IAPD hit; a balance-sheet lender, not an investment adviser" },
    vehicles: [{ cik: "1796479", name: "Gelt Financial, LLC", kind: "private" }],
  },
  {
    id: "silverview-capital",
    manager: "Silverview Capital",
    layer: "florida",
    location: "Tampa, FL",
    relevance: "direct",
    evidence: "Form D: 'Silverview Special Situations Lending Fund II', onshore and offshore. Special-situations lender; the largest Florida peer raise outside Miami-Dade.",
    aliases: ["Silverview", "Silverview Special Situations Lending"],
    adviser: { crd: "282955", secNumber: "801-107849", name: "SILVERVIEW CREDIT PARTNERS LP", basis: "Form D lists it as promoter; other names include Silverview Capital Partners; Tampa office", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1980247", name: "Silverview Special Situations Lending Onshore Fund II LP", kind: "private" },
      { cik: "1980377", name: "Silverview Special Situations Lending Offshore Fund II LP", kind: "private" },
    ],
  },
  {
    id: "naso",
    manager: "Naso",
    layer: "florida",
    location: "Boca Raton, FL",
    relevance: "direct",
    evidence: "Form D: 'Naso CRE Bridge Loan Fund'. CRE bridge lending — the origination half of Safe Harbor's strategy.",
    aliases: ["Naso CRE", "Naso Capital"],
    noAdviser: { checkedOn: "2026-10-26", note: "No adviser under Naso or its Form D entities; a bridge lender without a registered adviser" },
    vehicles: [{ cik: "1933138", name: "Naso CRE Bridge Loan Fund, L.P", kind: "private" }],
  },
  {
    id: "camden-credit",
    manager: "Camden",
    layer: "florida",
    location: "North Palm Beach, FL",
    relevance: "direct",
    evidence: "Form D: 'Camden Credit Opportunity Fund' series V–VIII, each fully subscribed. Series structure, retail-sized tickets.",
    aliases: ["Camden Credit", "Camden Credit Opportunity Fund"],
    adviser: { crd: "129505", secNumber: "801-62580", name: "CERTUITY, LLC", basis: "Form D names it as the Camden Credit Opportunity Fund series' adviser; IAPD's other names carry the Camden-era entity; North Palm Beach office", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2012451", name: "Camden Credit Opportunity Fund, LLC Series V", kind: "private" },
      { cik: "2012462", name: "Camden Credit Opportunity Fund, LLC Series VI", kind: "private" },
      { cik: "2012163", name: "Camden Credit Opportunity Fund, LLC Series VII", kind: "private" },
      { cik: "2012162", name: "Camden Credit Opportunity Fund, LLC Series VIII", kind: "private" },
    ],
  },

  // ----------------------------------------------------------------- National
  // CRE credit specifically: these are the listed and non-traded vehicles whose
  // quarterly filings make portfolio and liquidity figures observable at all.
  {
    id: "madison-realty-capital",
    manager: "Madison Realty Capital",
    layer: "national",
    location: "New York, NY",
    relevance: "direct",
    evidence:
      "CRE debt and distressed manager on the firm's watchlist. Debt Fund VI raised $2.04B after cutting its target from $2.25B; Debt Fund VII opened in April 2026 with nothing sold yet, and Debt MA IV has taken $464.4M. Its per-vintage 'Holdings LLC' feeder shells are omitted — see VehicleRole.",
    aliases: ["Madison Realty", "MRC", "Madison Realty Capital Debt Fund"],
    adviser: { crd: "158988", secNumber: "801-72909", name: "MADISON REALTY CAPITAL", basis: "Exact name and New York office; Form D GP entities among its other names", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2124480", name: "Madison Realty Capital Debt Fund VII LP", kind: "private" },
      { cik: "2001103", name: "Madison Realty Capital Debt MA IV LP", kind: "private" },
      { cik: "1943560", name: "Madison Realty Capital Debt Fund VI LP", kind: "private" },
      { cik: "1802090", name: "Madison Realty Capital Debt Fund V LP", kind: "private" },
      { cik: "1924061", name: "Madison Realty Capital Debt MA III LP", kind: "private" },
    ],
  },
  {
    id: "bridge-investment-group",
    manager: "Bridge Investment Group",
    layer: "national",
    location: "Salt Lake City, UT",
    relevance: "direct",
    evidence:
      "Real-estate credit and distressed platform on the firm's watchlist. Bridge Debt Strategies Fund VI opened in August 2026 against a $2.5B target with $500K taken — the clearest example in the registry of a raise caught at the very start.",
    aliases: ["Bridge", "Bridge Debt Strategies", "BRDG"],
    adviser: { crd: "159127", secNumber: "801-72790", name: "BRIDGE INVESTMENT GROUP", basis: "Exact name and Sandy UT office; umbrella filer whose other names include its fund managers. The debt funds' own GP (Bridge Debt Strategies Fund VI GP LLC) files no ADV of its own", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2151824", name: "Bridge Debt Strategies Fund VI LP", kind: "private" },
      { cik: "2151821", name: "Bridge Debt Strategies Fund VI International LP", kind: "private", role: "sleeve" },
      { cik: "2151822", name: "Bridge Debt Strategies Fund VI International Master LP", kind: "private", role: "sleeve" },
      { cik: "2151823", name: "Bridge Debt Strategies Fund VI-R LP", kind: "private", role: "sleeve" },
      { cik: "1969450", name: "Bridge Debt Strategies Fund V LP", kind: "private" },
      { cik: "1969394", name: "Bridge Debt Strategies Fund V International LP", kind: "private", role: "sleeve" },
    ],
  },
  {
    id: "pretium-partners",
    manager: "Pretium Partners",
    layer: "national",
    location: "New York, NY",
    relevance: "direct",
    evidence:
      "Real-estate credit and residential-focused manager on the firm's watchlist; Pretium Real Estate Debt Fund and its B sleeve have taken $132.8M and $124.2M and were still filing in August 2026. 'Pretium Packaging LLC' matches the name but is an unrelated company that last reported in 2014, and is excluded — the reason this registry is reviewed rather than generated.",
    aliases: ["Pretium", "Pretium Real Estate Debt"],
    website: "https://www.pretium.com",
    adviser: { crd: "171026", secNumber: "801-79924", name: "PRETIUM RESIDENTIAL CREDIT MANAGEMENT, LLC", basis: "The only Pretium adviser on IAPD; other names are Pretium Mortgage Credit Management and its fund GP; New York office", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "2065921", name: "Pretium Real Estate Debt Fund, LP", kind: "private" },
      { cik: "2065970", name: "Pretium Real Estate Debt Fund B, LP", kind: "private", role: "sleeve" },
      { cik: "2141000", name: "Pretium Low Beta Fund, LP", kind: "private" },
    ],
  },
  {
    id: "blackstone",
    manager: "Blackstone",
    layer: "national",
    location: "New York, NY",
    relevance: "direct",
    evidence:
      "BXMT is a CRE debt REIT; BREIT and BCRED are the flagship non-traded vehicles whose redemption activity sets the tone for the whole semi-liquid market.",
    aliases: ["Blackstone Real Estate Debt Strategies", "BREDS", "BXMT", "BCRED", "BREIT"],
    website: "https://www.blackstone.com",
    adviser: { crd: "296294", secNumber: "801-113393", name: "BLACKSTONE CREDIT BDC ADVISORS LLC", basis: "Blackstone registers many advisers; this is BCRED's, per its filings (336 EDGAR hits). BREIT's is recorded on the vehicle", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1061630", name: "Blackstone Mortgage Trust, Inc. (BXMT)", kind: "registered", quoted: "listed" },
      { cik: "1662972", name: "Blackstone Real Estate Income Trust, Inc. (BREIT)", kind: "registered", quoted: "non-traded", adviser: { crd: "288053", secNumber: "801-110350", name: "BX REIT ADVISORS L.L.C.", basis: "Named as BREIT's adviser in its own filings (239 EDGAR full-text hits on BREIT's CIK)", confirmedOn: "2026-10-26" } },
      { cik: "1803498", name: "Blackstone Private Credit Fund (BCRED)", kind: "registered", quoted: "non-traded", adviser: { crd: "296294", secNumber: "801-113393", name: "BLACKSTONE CREDIT BDC ADVISORS LLC", basis: "Named as BCRED's adviser in its own filings (336 hits)", confirmedOn: "2026-10-26" } },
      { cik: "1736035", name: "Blackstone Secured Lending Fund (BXSL)", kind: "registered", quoted: "listed" },
    ],
  },
  {
    id: "starwood",
    manager: "Starwood Capital",
    layer: "national",
    location: "Miami Beach, FL",
    relevance: "direct",
    evidence:
      "STWD is a CRE debt REIT; SREIT is the non-traded vehicle that gated redemptions in 2024, the canonical example of the liquidity signal this tab tracks. Headquarters moved to Miami Beach, but the business is national.",
    aliases: ["Starwood", "Starwood Property Trust", "STWD", "SREIT"],
    website: "https://www.starwoodcapital.com",
    adviser: { crd: "110148", secNumber: "801-56403", name: "STARWOOD CAPITAL GROUP MANAGEMENT, L.L.C.", basis: "Umbrella filer, Miami Beach office; SREIT's adviser Starwood REIT Advisors is a relying adviser under it, so its ADV carries SREIT", confirmedOn: "2026-10-26" },
    vehicles: [
      { cik: "1465128", name: "Starwood Property Trust, Inc. (STWD)", kind: "registered", quoted: "listed" },
      { cik: "1711929", name: "Starwood Real Estate Income Trust, Inc. (SREIT)", kind: "registered", quoted: "non-traded" },
    ],
  },
  {
    id: "brightspire",
    manager: "BrightSpire Capital",
    layer: "national",
    location: "New York, NY",
    relevance: "direct",
    evidence: "CRE credit REIT focused on debt investments; already on the firm's watchlist.",
    aliases: ["BrightSpire", "BRSP"],
    adviser: { crd: "312908", secNumber: "801-120521", name: "BRIGHTSPIRE CAPITAL ADVISORS, LLC", basis: "Name match, New York office. BrightSpire Capital itself is internally managed and files no ADV; this is its affiliated adviser for private vehicles", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1717547", name: "BrightSpire Capital, Inc. (BRSP)", kind: "registered", quoted: "listed" }],
  },
  {
    id: "ladder-capital",
    manager: "Ladder Capital",
    layer: "national",
    location: "New York, NY",
    relevance: "direct",
    evidence: "Internally managed CRE lender and securities holder; on the firm's watchlist under CRE Debt Platforms.",
    aliases: ["Ladder", "LADR"],
    adviser: { crd: "160383", secNumber: "801-121780", name: "LADDER CAPITAL ASSET MANAGEMENT LLC", basis: "Name match, New York office. Ladder Capital Corp is internally managed; this is its affiliated adviser", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1577670", name: "Ladder Capital Corp (LADR)", kind: "registered", quoted: "listed" }],
  },

  // The broader private credit market the brief also asks about. Not CRE
  // lenders, but they compete for the same private-credit allocation and their
  // redemption and PIK trends are the clearest read on how that allocation is
  // behaving.
  {
    id: "blue-owl",
    manager: "Blue Owl Capital",
    layer: "national",
    location: "New York, NY",
    relevance: "adjacent",
    evidence:
      "Blue Owl Credit Income Corp is the largest non-traded BDC by redemption volume: $1.18B repurchased across 2025 against $1.97B in the first half of 2026 alone, with PIK income up from $86.1M to $103.6M.",
    aliases: ["Blue Owl", "OBDC", "Blue Owl Credit Income", "OCIC"],
    adviser: { crd: "282575", secNumber: "801-107232", name: "BLUE OWL CREDIT ADVISORS LLC", basis: "The adviser Blue Owl Credit Income Corp's own filings name (formerly Owl Rock Capital Advisors; 228 EDGAR full-text hits on its CIK)", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1812554", name: "Blue Owl Credit Income Corp.", kind: "registered", quoted: "non-traded" }],
  },
  {
    id: "apollo",
    manager: "Apollo Global Management",
    layer: "national",
    location: "New York, NY",
    relevance: "adjacent",
    evidence: "Apollo Debt Solutions BDC is a flagship non-traded private credit vehicle; Apollo is on the firm's watchlist.",
    aliases: ["Apollo", "ADS BDC", "Apollo Debt Solutions"],
    website: "https://www.apollo.com",
    adviser: { crd: "143161", secNumber: "801-67592", name: "APOLLO CAPITAL MANAGEMENT, L.P.", basis: "Umbrella filer for Apollo's credit advisers; Apollo Debt Solutions BDC's own adviser is recorded on the vehicle", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1837532", name: "Apollo Debt Solutions BDC", kind: "registered", quoted: "non-traded", adviser: { crd: "156115", secNumber: "801-72098", name: "APOLLO CREDIT MANAGEMENT, LLC", basis: "Named as Apollo Debt Solutions BDC's adviser in its own filings (298 hits); files its own ADV", confirmedOn: "2026-10-26" } }],
  },
  {
    id: "ares",
    manager: "Ares Management",
    layer: "national",
    location: "Los Angeles, CA",
    relevance: "adjacent",
    evidence: "Ares Strategic Income Fund is its non-traded credit vehicle; Ares is on the firm's watchlist.",
    aliases: ["Ares", "ASIF", "Ares Strategic Income"],
    website: "https://www.aresmgmt.com",
    adviser: { crd: "130074", secNumber: "801-63800", name: "ARES MANAGEMENT LLC", basis: "Umbrella filer; Ares Strategic Income Fund's own adviser is recorded on the vehicle", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1918712", name: "Ares Strategic Income Fund", kind: "registered", quoted: "non-traded", adviser: { crd: "131619", secNumber: "801-63168", name: "ARES CAPITAL MANAGEMENT LLC", basis: "Named as Ares Strategic Income Fund's adviser in its own filings (295 hits); files its own ADV", confirmedOn: "2026-10-26" } }],
  },
  {
    id: "hps",
    manager: "HPS Investment Partners",
    layer: "national",
    location: "New York, NY",
    relevance: "adjacent",
    evidence: "HPS Corporate Lending Fund is among the largest non-traded BDCs; included so the national liquidity read is not drawn from two managers.",
    aliases: ["HPS", "HLEND", "HPS Corporate Lending"],
    adviser: { crd: "282125", secNumber: "801-107234", name: "HPS INVESTMENT PARTNERS, LLC", basis: "Umbrella filer; HPS Corporate Lending Fund's own adviser is recorded on the vehicle", confirmedOn: "2026-10-26" },
    vehicles: [{ cik: "1838126", name: "HPS Corporate Lending Fund", kind: "registered", quoted: "non-traded", adviser: { crd: "324983", secNumber: "801-127446", name: "HPS ADVISORS, LLC", basis: "Named as HPS Corporate Lending Fund's adviser in its own filings (164 hits); files its own ADV", confirmedOn: "2026-10-26" } }],
  },
]

/**
 * Managers worth tracking that produced no resolvable EDGAR entity.
 *
 * Empty as of the 2026-10-21 targeted lookups: every name previously listed
 * here — Rialto, Madison Realty, Bridge, Pretium and Gelt — was found and is
 * now in `PEERS`. Name-pattern discovery had missed all five because their
 * funds are named after the firm rather than the strategy, which is what
 * `scripts/lookup-peer.ts` exists to catch. Add a manager here only when a
 * lookup has actually come back empty.
 */
export const UNRESOLVED_WATCH: readonly string[] = []

export function peersForLayer(layer: PeerLayer): Peer[] {
  return PEERS.filter((p) => p.layer === layer)
}

/**
 * The peers a layer should show.
 *
 * A layer is cumulative upward: the Miami-Dade view shows the local managers,
 * the Florida view adds the rest of the state, and the national view shows
 * everything — because a Miami manager is still a competitor nationally, and
 * hiding it there would misstate the market.
 */
export function peersInScope(layer: PeerLayer): Peer[] {
  if (layer === "miami-dade") return peersForLayer("miami-dade")
  if (layer === "florida") return [...peersForLayer("miami-dade"), ...peersForLayer("florida")]
  return [...PEERS]
}

export function peerById(id: string): Peer | undefined {
  return PEERS.find((p) => p.id === id)
}

export function selfPeer(): Peer | undefined {
  return PEERS.find((p) => p.isSelf)
}

/** Every vehicle in a layer, flattened, with its manager attached. */
export function vehiclesInScope(layer: PeerLayer): Array<PeerVehicle & { peerId: string; manager: string }> {
  return peersInScope(layer).flatMap((p) =>
    p.vehicles.map((v) => ({ ...v, peerId: p.id, manager: p.manager }))
  )
}

/**
 * Vehicles that are raises in their own right — sleeves excluded.
 *
 * Use this to count funds or average their progress; use `vehiclesInScope` to
 * sum capital, which has to include the sleeves because that is where some of
 * it is reported.
 */
export function fundVehiclesInScope(layer: PeerLayer): Array<PeerVehicle & { peerId: string; manager: string }> {
  return vehiclesInScope(layer).filter((v) => (v.role ?? "fund") === "fund")
}

/**
 * Registered vehicles whose shares do not trade — the only ones whose share
 * issuance and repurchases describe investor liquidity rather than a
 * capital-markets decision. Net flow and the redemption signals are restricted
 * to these.
 */
export function nonTradedVehiclesInScope(layer: PeerLayer): Array<PeerVehicle & { peerId: string; manager: string }> {
  return registeredVehiclesInScope(layer).filter((v) => v.quoted === "non-traded")
}

export function registeredVehiclesInScope(layer: PeerLayer): Array<PeerVehicle & { peerId: string; manager: string }> {
  return vehiclesInScope(layer).filter((v) => v.kind === "registered")
}
