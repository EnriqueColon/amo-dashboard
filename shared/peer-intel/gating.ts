/**
 * Gating: did a vehicle pay everyone out, or did it hit its own cap?
 *
 * The brief asks for "redemption activity, withdrawal restrictions or gating
 * across semi-liquid structures". Redemption activity is tagged quarterly and
 * is on the liquidity panel. Gating is harder, and the reason is worth stating
 * because it shaped everything here.
 *
 * **The 10-Q does not tabulate requests received.** Blue Owl's share-repurchase
 * note lists, per class and per quarter, the offer date, the amount and the
 * shares repurchased — and shares repurchased multiplied by the purchase price
 * equals the stated offer amount exactly, so that column is what was *bought*,
 * not what was *asked for*.
 *
 * **They are reported, though — in the tender offer, not the financial
 * statements.** A non-traded fund runs its repurchase programme as an issuer
 * tender offer, and Rule 13e-4(c)(4) obliges it to file a Schedule TO final
 * amendment reporting the results. BCRED's, filed 2026-08-04, states it plainly:
 * 191,782,834 shares validly tendered, 93,100,272 accepted on a pro rata basis
 * representing 5% of shares outstanding, $2,201,821,426 of net asset value, at
 * $23.65 a share. That is requests, fulfilment, proration and the cap in one
 * short filing whose wording is prescribed by rule rather than left to each
 * sponsor's prose.
 *
 * So this module reads the 10-Q because that is where it started, and it works,
 * but **`SC TO-I/A` is the better source and the one to move to.** BCRED alone
 * has 59 Schedule TO filings, giving a long per-quarter history per fund.
 *
 * **Which applies to five of the seven vehicles, not all of them** — checked
 * against live EDGAR on 2026-10-21. The five BDCs run quarterly issuer tenders.
 * BREIT has never filed a Schedule TO at all, and SREIT's five are `SC TO-T`,
 * the *third-party* form, filed by Cox Capital and Saba against it rather than
 * by it. Both REITs run share repurchase *plans* and disclose requests and
 * fulfilment in 10-Q prose instead, BREIT monthly and alongside the cap used.
 * So select on `SC TO-I`, never on `SC TO`, and expect two extractors.
 * `docs/PEER_TRACKER_STATUS.md` §3 has the counts and the wording traps.
 *
 * What the filing does state plainly, in words, is the cap: "intends to limit
 * the number of shares to be repurchased in each quarter to no more than 5.00%
 * of its outstanding shares of common stock." And that makes the question
 * answerable from the other side. If a vehicle repurchased essentially its full
 * 5%, the offer was taken up to the limit — which means requests reached or
 * exceeded it and anyone wanting more was prorated. Blue Owl repurchased 105.2M
 * shares in Q2 2026 against roughly 2,126M outstanding: **4.95% against a 5.00%
 * cap**, which is proration, and which matches the Wall Street Journal's report
 * that two of its funds saw requests above 5%.
 *
 * So this module reads the cap and the repurchase rows from the filing and
 * reports utilisation against the cap. **It does not read requests received** —
 * not because no filing says, which was the original and mistaken reason, but
 * because the filings that say are the ones above, which this module does not
 * yet read. Utilisation against the cap is a weaker proxy than the fulfilment
 * rate those filings state outright.
 *
 * Pure: document text in, figures out.
 */

/** How close to its cap a vehicle has to get before the offer is treated as full. */
export const AT_CAP_THRESHOLD = 0.95

export type RepurchaseCap = {
  /** The cap as a fraction, e.g. 0.05 for 5.00%. */
  fraction: number
  /** What the cap is measured against, as the filing words it. */
  basis: "shares" | "nav" | "unstated"
  /** The sentence it came from, so a reader can check it. */
  quote: string
}

/**
 * The stated quarterly repurchase cap.
 *
 * Deliberately narrow: it matches the standard formulation and nothing else. A
 * filing worded differently returns null rather than a guessed number, because
 * a wrong cap makes every utilisation figure wrong in the same direction.
 */
export function extractRepurchaseCap(text: string): RepurchaseCap | null {
  const patterns: Array<{ re: RegExp; basis: RepurchaseCap["basis"] }> = [
    {
      re: /limit the (?:number|aggregate number|aggregate amount) of shares[^.]{0,220}?no more than\s*([\d.]+)\s*%\s*of (?:its|the) (?:outstanding )?shares[^.]{0,80}\./i,
      basis: "shares",
    },
    {
      re: /(?:intends to |will )?(?:limit|repurchase)[^.]{0,200}?no more than\s*([\d.]+)\s*%\s*of (?:its|the)[^.]{0,40}net asset value[^.]{0,80}\./i,
      basis: "nav",
    },
    {
      re: /(?:up to|not (?:to )?exceed(?:ing)?)\s*([\d.]+)\s*%\s*of (?:its|the) (?:outstanding )?shares[^.]{0,100}(?:each|per) quarter[^.]{0,60}\./i,
      basis: "shares",
    },
    {
      // Blackstone's vehicles word it as a cap rather than a limit, and against
      // NAV rather than shares: "5% cap on NAV for Class S shares".
      re: /([\d.]+)\s*%\s*cap on NAV[^.]{0,120}\./i,
      basis: "nav",
    },
  ]

  for (const { re, basis } of patterns) {
    const m = text.match(re)
    if (!m) continue
    const pct = Number(m[1])
    // A quarterly repurchase cap is a small single-digit percentage. Anything
    // outside that is a different sentence that happened to match.
    if (!Number.isFinite(pct) || pct <= 0 || pct > 25) continue
    return { fraction: pct / 100, basis, quote: m[0].replace(/\s+/g, " ").trim() }
  }
  return null
}

export type RepurchaseRow = {
  /** `YYYY-MM-DD` of the tender expiry, which is the quarter end. */
  expiration: string
  /** Share class as filed, where the table gives one. */
  shareClass: string | null
  /** Dollars, in thousands as the table states. */
  amountThousands: number
  pricePerShare: number | null
  shares: number
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
}

function isoDate(month: string, day: string, year: string): string | null {
  const m = MONTHS[month.toLowerCase()]
  return m ? `${year}-${m}-${day.padStart(2, "0")}` : null
}

/**
 * The share-repurchase table's rows.
 *
 * One row per class per quarter. Multi-class vehicles file three rows a quarter,
 * which have to be summed — a single class's shares against total outstanding
 * would understate utilisation threefold.
 */
export function extractRepurchaseRows(text: string): RepurchaseRow[] {
  const rows: RepurchaseRow[] = []
  // Offer date, class, expiry, amount, price, shares — the column order in the
  // note. Amounts carry thousands separators and an optional leading $.
  const re =
    /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\s+([A-Z]{1,3})\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\s+\$?\s*([\d,]+)\s+\$?\s*([\d.]+)\s+([\d,]+)/g
  for (const m of text.matchAll(re)) {
    const expiration = isoDate(m[5], m[6], m[7])
    if (!expiration) continue
    const amount = Number(m[8].replace(/,/g, ""))
    const price = Number(m[9])
    const shares = Number(m[10].replace(/,/g, ""))
    if (!Number.isFinite(amount) || !Number.isFinite(shares) || shares <= 0) continue
    rows.push({
      expiration,
      shareClass: m[4],
      amountThousands: amount,
      pricePerShare: Number.isFinite(price) ? price : null,
      shares,
    })
  }
  return rows
}

/**
 * Total shares outstanding, from the earnings-per-share table.
 *
 * Needed because `companyconcept` cannot read it for a multi-class filer: those
 * tag shares with a class dimension, and the un-dimensioned endpoint returns a
 * 404. Six of the seven non-traded vehicles expose it in XBRL; Blue Owl, the one
 * whose redemptions matter most, does not — so it is read here instead.
 *
 * **The table's shape is what makes this tractable.** A multi-class filer lists
 * the current period's classes and then the prior year's, in the same order:
 * "677,788,032 45,717,405 1,402,819,846 607,882,907 58,468,742 1,172,654,549"
 * is three classes twice. So the figures are taken in order from the label and
 * the first half summed. Taking the largest values instead over-counted Blue
 * Owl by half a billion shares, because the section also carries the six-month
 * table — which is why this reads position rather than magnitude.
 *
 * Returns null on an odd count or no match, rather than a figure that would make
 * every utilisation number wrong in the same direction.
 */
export function extractSharesOutstanding(text: string): number | null {
  const label = /Weighted average (?:number of )?shares (?:of common stock )?outstanding[^\d]{0,60}/i
  const at = text.search(label)
  if (at < 0) return null
  const after = text.slice(at).replace(label, "")

  // Consume the run of share counts that immediately follows the label, and
  // stop at the first token that is not one — a per-share figure, a currency
  // symbol or the next row's prose.
  const numbers: number[] = []
  for (const token of after.split(/\s+/)) {
    const m = token.match(/^([\d]{1,3}(?:,\d{3}){2,})$/)
    if (!m) {
      if (numbers.length) break
      if (/^[$(),.\u2014-]*$/.test(token)) continue
      break
    }
    const n = Number(m[1].replace(/,/g, ""))
    if (!Number.isFinite(n) || n < 1_000_000) break
    numbers.push(n)
    if (numbers.length >= 12) break
  }

  if (!numbers.length) return null
  // A single figure is a one-class filer. Otherwise the run is the current
  // period's classes followed by the prior year's, so sum the first half.
  if (numbers.length === 1) return numbers[0]
  if (numbers.length % 2 !== 0) return null
  return numbers.slice(0, numbers.length / 2).reduce((a, b) => a + b, 0)
}

export type GatingAssessment = {
  cik: string
  manager: string
  vehicleName: string
  /** The quarter assessed, `YYYY-MM-DD`. */
  quarter: string
  cap: RepurchaseCap
  /** Shares repurchased in the quarter, summed across classes. */
  sharesRepurchased: number
  /** Dollars repurchased in the quarter, in thousands, summed across classes. */
  amountThousands: number
  sharesOutstanding: number | null
  /** Repurchased as a fraction of shares outstanding. Null without a denominator. */
  utilisation: number | null
  /** Utilisation as a fraction of the cap: 1.0 means the cap was fully used. */
  capUsed: number | null
  /**
   * `at-cap` means the offer was taken to its limit, so requests reached or
   * exceeded it and holders were prorated. `below-cap` means everyone who asked
   * was paid. `unknown` means no denominator could be established.
   */
  verdict: "at-cap" | "below-cap" | "unknown"
  /** Classes the quarter's figures were summed from, for the disclosure. */
  classes: string[]
}

/**
 * Assess one vehicle's newest repurchase quarter against its stated cap.
 *
 * Returns null where the filing states no cap or the table has no rows — both
 * are reported as unassessable rather than guessed at.
 */
export function assessGating(
  vehicle: { cik: string; manager: string; vehicleName: string },
  text: string
): GatingAssessment | null {
  const cap = extractRepurchaseCap(text)
  const rows = extractRepurchaseRows(text)
  if (!cap || !rows.length) return null

  const newestQuarter = rows.map((r) => r.expiration).sort().pop()!
  const quarterRows = rows.filter((r) => r.expiration === newestQuarter)
  const sharesRepurchased = quarterRows.reduce((a, r) => a + r.shares, 0)
  const amountThousands = quarterRows.reduce((a, r) => a + r.amountThousands, 0)
  const sharesOutstanding = cap.basis === "shares" ? extractSharesOutstanding(text) : null

  const utilisation =
    sharesOutstanding && sharesOutstanding > 0 ? sharesRepurchased / sharesOutstanding : null
  const capUsed = utilisation != null && cap.fraction > 0 ? utilisation / cap.fraction : null

  return {
    ...vehicle,
    quarter: newestQuarter,
    cap,
    sharesRepurchased,
    amountThousands,
    sharesOutstanding,
    utilisation,
    capUsed,
    verdict: capUsed == null ? "unknown" : capUsed >= AT_CAP_THRESHOLD ? "at-cap" : "below-cap",
    classes: [...new Set(quarterRows.map((r) => r.shareClass).filter((c): c is string => c != null))],
  }
}

/** Plain text of a filing's HTML, which is what every function here expects. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
}
