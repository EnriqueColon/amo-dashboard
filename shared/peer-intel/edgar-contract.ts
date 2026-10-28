/**
 * SEC EDGAR access: the pure parts.
 *
 * The Peer & Private Credit tracker reads EDGAR the way the Market Analytics
 * tab reads FDIC BankFind — free, structured, authoritative, quarterly. This
 * module holds the decisions made before any fetch (which URL, which
 * parameters, is this identifier even well formed, should a failure be
 * retried) so they can be unit-tested without the network. The fetchers are in
 * `app/services/peer-intel.ts`.
 *
 * Every rule here was confirmed against the live API on 2026-10-21. Several
 * are counter-intuitive and all of them are silent when you get them wrong,
 * which is the reason this file exists rather than inline query strings.
 */

/**
 * EDGAR full-text search. The query parameter is `q`.
 *
 * `keys` is **silently ignored**: a request with `keys="Blackstone"&forms=D`
 * returns 10,000+ hits of unrelated Form D filings — the whole firehose,
 * newest first — rather than an error or an empty set. An earlier SEC
 * connector in this repo passed `keys` and filtered client-side, which is why
 * it found almost nothing; it was removed with the competitor-surveillance
 * framework on 2026-10-26. With `q` the same search returns 2,135 scored
 * Blackstone hits.
 */
const FTS_ENDPOINT = "https://efts.sec.gov/LATEST/search-index"

/** Structured company and filing data. Separate host from full-text search. */
const DATA_ENDPOINT = "https://data.sec.gov"

const ARCHIVES = "https://www.sec.gov/Archives/edgar/data"

/**
 * SEC requires a User-Agent that identifies the caller and gives a contact
 * address; requests without one are throttled or refused. The published limit
 * is 10 requests a second. We run below it — see `REQUEST_SPACING_MS`.
 */
export function edgarHeaders(contact: string): Record<string, string> {
  const who = contact.trim()
  if (!who) throw new Error("EDGAR requests need a contact address in the User-Agent.")
  return {
    "User-Agent": `MarketIntelligence/1.0 (${who})`,
    "Accept-Encoding": "gzip, deflate",
    Accept: "application/json",
  }
}

/**
 * Spacing between EDGAR requests, process-wide.
 *
 * SEC publishes a ceiling of 10 requests a second. 125ms is 8/s, which leaves
 * headroom for retries without tripping it. This is the binding constraint on
 * how fast a layer can be built: the US layer needs about 340 requests, so no
 * amount of concurrency gets it below 340 x 125ms.
 */
export const REQUEST_SPACING_MS = 125

/**
 * How many EDGAR requests may be in flight at once.
 *
 * The spacing above already enforces the rate, so concurrency only decides how
 * much of the round-trip latency is hidden. Without it the fetchers awaited
 * each response before asking for the next slot, which made the real cost
 * `spacing + latency` per request rather than `spacing` — the US layer took 73
 * seconds against a 42-second floor.
 */
export const REQUEST_CONCURRENCY = 6

/**
 * Full-text search is the only way to *discover* filers we do not already
 * know, but it has a sharp limitation that shapes the whole discovery design:
 *
 * **For Form D it matches the entity name, not narrative text.** A Form D is a
 * structured form with no free-text description, so there is nothing else to
 * index. `q="non-performing"` returns 0 hits; `q="opportunity fund"` returns
 * 194, all of them matching fund *names*. Discovery queries must therefore be
 * name patterns, and the broad ones pull in whole categories we do not want
 * (Opportunity-Zone funds, SPAC vehicles, CLO funds, digital-asset funds) —
 * see `EXCLUDE_NAME_PATTERNS`.
 *
 * `locationCodes` is plural. `locationCode=FL` is silently ignored exactly as
 * `keys` is: it returned 80 hits of which 25 were Florida. `locationCodes=FL`
 * returned 25, all Florida.
 */
export type FtsQuery = {
  /** A quoted phrase or term. Matched against entity names for Form D. */
  q: string
  /** e.g. `["D"]`, or `["10-Q", "10-K"]`. */
  forms?: string[]
  /** Two-letter state or territory code of the filer's business address. */
  locationCodes?: string
  /** `YYYY-MM-DD`. Both bounds or neither. */
  startdt?: string
  enddt?: string
  /** Result offset; EDGAR serves 10 hits a page and caps paging at 10,000. */
  from?: number
}

export function buildFtsUrl(query: FtsQuery): string {
  const p = new URLSearchParams()
  p.set("q", query.q)
  if (query.forms?.length) p.set("forms", query.forms.join(","))
  if (query.locationCodes) p.set("locationCodes", query.locationCodes)
  if (query.startdt && query.enddt) {
    p.set("startdt", query.startdt)
    p.set("enddt", query.enddt)
  }
  if (query.from) p.set("from", String(query.from))
  return `${FTS_ENDPOINT}?${p.toString()}`
}

/** CIKs are padded to ten digits in `data.sec.gov` paths and unpadded in Archives paths. */
export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "")
  if (!digits || Number(digits) === 0) throw new Error(`Not a CIK: ${cik}`)
  return digits.padStart(10, "0")
}

export function unpadCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "")
  if (!digits || Number(digits) === 0) throw new Error(`Not a CIK: ${cik}`)
  return String(Number(digits))
}

/** Every filing an entity has made, newest first, with form types and dates. */
export function buildSubmissionsUrl(cik: string | number): string {
  return `${DATA_ENDPOINT}/submissions/CIK${padCik(cik)}.json`
}

/**
 * One XBRL concept's full history for one entity.
 *
 * Deliberately not `companyfacts`, which returns every concept the filer has
 * ever tagged: for Blue Owl Credit Income that is 570 KB against 4.9 KB for a
 * single concept — 117× the payload for data we would discard. And deliberately
 * not the `frames` API, which looks ideal (all filers, one concept, one period,
 * one request) but is unusable for these filers: `frames/.../CY2026Q2` returned
 * 134 entities and not one of the evergreen vehicles, because their figures are
 * year-to-date durations that do not match a calendar-quarter frame.
 */
export function buildCompanyConceptUrl(cik: string | number, taxonomy: string, concept: string): string {
  return `${DATA_ENDPOINT}/api/xbrl/companyconcept/CIK${padCik(cik)}/${taxonomy}/${concept}.json`
}

/** The filing's own primary document — for Form D, the XML carrying the offering figures. */
export function buildPrimaryDocUrl(cik: string | number, accession: string): string {
  const bare = accession.replace(/-/g, "")
  if (!/^\d{18}$/.test(bare)) throw new Error(`Not an accession number: ${accession}`)
  return `${ARCHIVES}/${unpadCik(cik)}/${bare}/primary_doc.xml`
}

/** The human-readable index for a filing, for linking out from the UI. */
export function buildFilingIndexUrl(cik: string | number, accession: string): string {
  const bare = accession.replace(/-/g, "")
  if (!/^\d{18}$/.test(bare)) throw new Error(`Not an accession number: ${accession}`)
  return `${ARCHIVES}/${unpadCik(cik)}/${bare}/${accession}-index.html`
}

/**
 * Full-text search returns intermittent 500s under no particular load — one of
 * eight discovery queries failed this way during the audit. A 500 or 503 is
 * worth retrying; a 400 or 404 means the request itself is wrong and retrying
 * it just wastes the rate limit. 403 is how SEC refuses a bad User-Agent, which
 * no amount of retrying fixes.
 */
export function shouldRetry(status: number, attempt: number, maxAttempts = 3): boolean {
  if (attempt >= maxAttempts) return false
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** Exponential with a floor at the rate-limit spacing, so a retry never outpaces it. */
export function retryDelayMs(attempt: number): number {
  return Math.max(REQUEST_SPACING_MS, 500 * 2 ** (attempt - 1))
}

/**
 * Name patterns that discovery searches on. Form D full-text matches names
 * only, so these are the vocabulary a real-estate-credit fund actually uses in
 * its legal name. Ordered roughly by precision: the first few rarely need
 * filtering, `opportunity fund` needs all of `EXCLUDE_NAME_PATTERNS`.
 */
export const DISCOVERY_NAME_PATTERNS: readonly string[] = [
  "real estate credit",
  "real estate debt",
  "commercial real estate credit",
  "mortgage fund",
  "bridge loan",
  "special situations lending",
  "debt opportunity",
  "credit opportunity",
  "distressed debt",
  "opportunity fund",
]

/**
 * Categories whose names collide with the patterns above but which are not
 * real-estate credit managers. Opportunity-Zone funds are the big one: they
 * share the words "opportunity fund" and outnumber real peers.
 */
export const EXCLUDE_NAME_PATTERNS: readonly string[] = [
  "opportunity zone",
  "qualified opportunity",
  "qoz",
  "spac",
  "clo ",
  "collateralized loan",
  "digital asset",
  "crypto",
  "bitcoin",
  "venture",
  "emerging markets",
  "performing arts",
  "legal opportunity",
  "litigation",
  "life science",
  "biotech",
  "farmland",
  "timber",
  "oil",
  "gas ",
  "energy",
  "solar",
]

export function isExcludedName(name: string): boolean {
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `
  return EXCLUDE_NAME_PATTERNS.some((p) => n.includes(` ${p.trim()} `) || n.includes(p))
}

/**
 * Miami-Dade municipalities as EDGAR writes them in `biz_locations` ("City, ST").
 *
 * The brief asks for a Miami-Dade layer, and a filer's business address is the
 * only location EDGAR gives. Broward and Palm Beach names are deliberately
 * absent: Fort Lauderdale and Boca Raton managers belong to the Florida layer.
 */
export const MIAMI_DADE_CITIES: readonly string[] = [
  "miami",
  "miami beach",
  "north miami",
  "north miami beach",
  "south miami",
  "miami shores",
  "miami springs",
  "miami lakes",
  "coral gables",
  "coconut grove",
  "doral",
  "aventura",
  "sunny isles beach",
  "key biscayne",
  "bal harbour",
  "bay harbor islands",
  "surfside",
  "hialeah",
  "hialeah gardens",
  "homestead",
  "pinecrest",
  "palmetto bay",
  "cutler bay",
  "opa locka",
  "sweetwater",
  "west miami",
  "virginia gardens",
  "medley",
]

export type PeerLayer = "miami-dade" | "florida" | "national"

/**
 * Which layer a business address falls in. Note this is the *filer's* address,
 * which for a fund is usually its manager's office — that is what we want.
 */
export function layerForLocation(bizLocation: string | null | undefined): PeerLayer {
  const loc = (bizLocation ?? "").trim()
  if (!loc) return "national"
  const parts = loc.split(",")
  const state = (parts[parts.length - 1] ?? "").trim().toUpperCase()
  if (state !== "FL") return "national"
  const city = parts.slice(0, -1).join(",").trim().toLowerCase()
  return MIAMI_DADE_CITIES.includes(city) ? "miami-dade" : "florida"
}
