import {
  buildCompanyConceptUrl,
  buildFtsUrl,
  buildPrimaryDocUrl,
  buildSubmissionsUrl,
  edgarHeaders,
  isExcludedName,
  layerForLocation,
  REQUEST_CONCURRENCY,
  REQUEST_SPACING_MS,
  unpadCik,
  retryDelayMs,
  shouldRetry,
  type FtsQuery,
  type PeerLayer,
} from "@shared/peer-intel/edgar-contract"
import { buildRaise, parseFormD, type OfferingRecord } from "@shared/peer-intel/form-d"
import { layerAdv, type ManagerAdv, type VehicleKey } from "@shared/peer-intel/adv-link"
import {
  buildContinuationView,
  continuationKind,
  continuationQuery,
  MAX_SEARCH_PAGES,
  searchTerms,
  type AdvisedFund,
  type ContinuationHit,
  type ContinuationView,
} from "@shared/peer-intel/continuation"
import { advExtract, advHistory } from "@shared/peer-intel/adv-extract"
import { buildPeerCohort, type PeerCohort } from "@shared/peer-intel/cohort"
import { buildVehicleTrend, type VehicleTrend } from "@shared/peer-intel/liquidity"
import {
  developmentsQuery,
  isRecent,
  rankDevelopments,
  scoreDevelopment,
  type DevelopmentItem,
  type ScoredDevelopment,
} from "@shared/peer-intel/developments"
import { nonTradedVehiclesInScope, peersInScope } from "@shared/peer-intel/registry"
import { assessGating, plainText, type GatingAssessment } from "@shared/peer-intel/gating"
import {
  managerSignals,
  signalFiringRates,
  type ManagerSignals,
  type VehicleSeries,
} from "@shared/peer-intel/signals"
import {
  registeredVehiclesInScope,
  vehiclesInScope,
  type VehicleQuotation,
} from "@shared/peer-intel/registry"
import {
  netFlow,
  parseConceptFacts,
  PEER_METRICS,
  toQuarters,
  type QuarterPoint,
} from "@shared/peer-intel/xbrl"

/**
 * SEC EDGAR fetchers for the peer tracker.
 *
 * Nothing here is cached, by the same reasoning as `app/services/bank-behavior.ts`:
 * raw filing trails are large and uninteresting, and the reductions built on
 * them (raises, signals, the layer aggregate) are what get stored. Caching
 * happens one level up in `app/actions/peer-intel.ts`.
 *
 * Every request is spaced and retried according to
 * `lib/peer-intel/edgar-contract.ts`, which carries the reasoning for both.
 */

/**
 * SEC wants a contact address in the User-Agent. It is not a secret and not an
 * API key — there is no EDGAR key — so it falls back to a mailbox at the
 * deployment rather than failing closed, which would take the whole tab down
 * over an unset variable that grants nothing.
 */
function contact(): string {
  return process.env.SEC_EDGAR_CONTACT?.trim() || "market-intelligence@safeharborcp.com"
}

let nextSlot = 0

/**
 * Takes the next request slot, so EDGAR sees at most one call per
 * `REQUEST_SPACING_MS` however many callers are waiting.
 *
 * Reserving the slot *before* awaiting is what lets several requests be in
 * flight at once while still respecting the rate: each caller books a distinct
 * future instant, sleeps until it, then fires.
 */
async function rateLimited<T>(run: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const slot = Math.max(now, nextSlot)
  nextSlot = slot + REQUEST_SPACING_MS
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now))
  return run()
}

/**
 * Run `work` over `items` with at most `limit` in flight, preserving order.
 *
 * The rate limiter above already caps throughput, so this exists only to stop
 * each request's round-trip latency being paid serially. Results come back in
 * input order so a partial failure cannot silently reorder a cohort.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function getText(url: string): Promise<string> {
  const headers = edgarHeaders(contact())
  for (let attempt = 1; ; attempt++) {
    const res = await rateLimited(() => fetch(url, { headers, cache: "no-store" }))
    if (res.ok) return res.text()
    if (!shouldRetry(res.status, attempt)) {
      throw new Error(`EDGAR ${res.status} for ${url}`)
    }
    await new Promise((r) => setTimeout(r, retryDelayMs(attempt)))
  }
}

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T
}

export type FtsHit = {
  cik: string
  /** The filer name with EDGAR's trailing `(CIK ...)` removed. */
  name: string
  /** `City, ST`, or null when EDGAR reports no business location. */
  location: string | null
  layer: PeerLayer
  form: string
  accession: string
  filedAt: string
}

type FtsResponse = {
  hits?: {
    total?: { value?: number }
    hits?: Array<{
      _source?: {
        ciks?: string[]
        display_names?: string[]
        biz_locations?: string[]
        form?: string
        adsh?: string
        file_date?: string
      }
    }>
  }
}

function toHit(source: NonNullable<NonNullable<FtsResponse["hits"]>["hits"]>[number]["_source"]): FtsHit | null {
  const s = source ?? {}
  const cik = s.ciks?.[0]
  const accession = s.adsh
  if (!cik || !accession) return null
  const location = s.biz_locations?.[0] ?? null
  return {
    cik: String(Number(String(cik).replace(/\D/g, ""))),
    name: (s.display_names?.[0] ?? "").replace(/\s*\(CIK \d+\)\s*$/, "").trim(),
    location,
    layer: layerForLocation(location),
    form: s.form ?? "",
    accession,
    filedAt: (s.file_date ?? "").slice(0, 10),
  }
}

/** One full-text search page. Callers that want more pass `from`. */
export async function searchFilings(query: FtsQuery): Promise<{ total: number; hits: FtsHit[] }> {
  const data = await getJson<FtsResponse>(buildFtsUrl(query))
  const hits = (data.hits?.hits ?? []).map((h) => toHit(h._source)).filter((h): h is FtsHit => h != null)
  return { total: data.hits?.total?.value ?? 0, hits }
}

export type DiscoveredFiler = {
  cik: string
  name: string
  location: string | null
  layer: PeerLayer
  /** The newest Form D or D/A seen for this filer during discovery. */
  latestFiling: { form: string; accession: string; filedAt: string }
  /** Which name patterns surfaced it, for auditing the discovery query set. */
  matchedPatterns: string[]
}

/**
 * Find Form D filers in a state whose fund *names* look like real-estate credit.
 *
 * Form D full-text search matches the entity name and nothing else, because the
 * form carries no narrative — so this is name-pattern discovery, not semantic
 * search, and `isExcludedName` does the work of keeping Opportunity-Zone, CLO,
 * SPAC and venture funds out of the result. See `edgar-contract.ts` for the
 * measurements behind both facts.
 */
export async function discoverFilers(options: {
  locationCodes: string
  patterns: readonly string[]
  startdt: string
  enddt: string
}): Promise<DiscoveredFiler[]> {
  const byCik = new Map<string, DiscoveredFiler>()
  for (const pattern of options.patterns) {
    let page: { total: number; hits: FtsHit[] }
    try {
      page = await searchFilings({
        q: `"${pattern}"`,
        forms: ["D"],
        locationCodes: options.locationCodes,
        startdt: options.startdt,
        enddt: options.enddt,
      })
    } catch (error) {
      // A pattern that fails after its retries is skipped rather than failing
      // the whole discovery run: the other patterns still produce a usable list.
      console.warn(`peer discovery: pattern "${pattern}" failed`, error)
      continue
    }
    for (const hit of page.hits) {
      if (!hit.name || isExcludedName(hit.name)) continue
      const existing = byCik.get(hit.cik)
      if (!existing) {
        byCik.set(hit.cik, {
          cik: hit.cik,
          name: hit.name,
          location: hit.location,
          layer: hit.layer,
          latestFiling: { form: hit.form, accession: hit.accession, filedAt: hit.filedAt },
          matchedPatterns: [pattern],
        })
        continue
      }
      if (!existing.matchedPatterns.includes(pattern)) existing.matchedPatterns.push(pattern)
      if (hit.filedAt > existing.latestFiling.filedAt) {
        existing.latestFiling = { form: hit.form, accession: hit.accession, filedAt: hit.filedAt }
      }
    }
  }
  return [...byCik.values()].sort((a, b) => (a.latestFiling.filedAt < b.latestFiling.filedAt ? 1 : -1))
}

export type FilingRef = {
  form: string
  accession: string
  filedAt: string
  /**
   * The SEC file number, `021-…` for a Form D. One per offering, so every
   * amendment carries the original's — and it is the number an adviser's Form
   * ADV quotes for each private fund (Schedule D 7.B.(1) question 22), which
   * is what links a fund on the ADV to its vehicle here.
   */
  fileNumber: string | null
}

export type FilerProfile = {
  cik: string
  name: string
  location: string | null
  layer: PeerLayer
  /** Every Form D / D/A, newest first. */
  formD: FilingRef[]
  /** Periodic reports that mean the entity reports financials in XBRL. */
  periodic: FilingRef[]
  /**
   * `registered` when the entity files periodic reports (10-Q/10-K/N-CSR/N-CEN),
   * which is what makes quarterly redemption and portfolio figures observable.
   * `private` when it only files Form D — the fundraising view is all there is.
   */
  kind: "registered" | "private"
}

type SubmissionsResponse = {
  name?: string
  addresses?: { business?: { city?: string; stateOrCountry?: string } }
  filings?: { recent?: { form?: string[]; accessionNumber?: string[]; filingDate?: string[]; fileNumber?: string[] } }
}

const PERIODIC_FORMS = ["10-Q", "10-K", "N-CSR", "N-CSRS", "N-CEN", "N-2"]

/**
 * Everything the tracker needs to know about one filer, from one request.
 *
 * The `kind` decision is made here rather than curated, because it is a fact
 * about what the entity files and it changes when a fund registers a vehicle.
 */
export async function fetchFilerProfile(cik: string): Promise<FilerProfile> {
  const data = await getJson<SubmissionsResponse>(buildSubmissionsUrl(cik))
  const recent = data.filings?.recent
  const forms = recent?.form ?? []
  const accessions = recent?.accessionNumber ?? []
  const dates = recent?.filingDate ?? []
  const fileNumbers = recent?.fileNumber ?? []

  const formD: FilingRef[] = []
  const periodic: FilingRef[] = []
  for (let i = 0; i < forms.length; i++) {
    const ref: FilingRef = {
      form: forms[i],
      accession: accessions[i] ?? "",
      filedAt: (dates[i] ?? "").slice(0, 10),
      fileNumber: fileNumbers[i]?.trim() || null,
    }
    if (!ref.accession) continue
    if (ref.form === "D" || ref.form === "D/A") formD.push(ref)
    else if (PERIODIC_FORMS.includes(ref.form)) periodic.push(ref)
  }

  const city = data.addresses?.business?.city
  const state = data.addresses?.business?.stateOrCountry
  const location = city && state ? `${city}, ${state}` : null

  return {
    cik: String(Number(cik.replace(/\D/g, ""))),
    name: data.name ?? "",
    location,
    layer: layerForLocation(location),
    formD,
    periodic,
    kind: periodic.length ? "registered" : "private",
  }
}

/**
 * The offering record behind one Form D filing.
 *
 * One request per filing — there is no bulk form of this, because the figures
 * live in the filing's own XML rather than in any index.
 */
export async function fetchOffering(
  cik: string,
  filing: FilingRef,
  location?: string | null
): Promise<OfferingRecord> {
  const xml = await getText(buildPrimaryDocUrl(cik, filing.accession))
  return parseFormD(xml, {
    cik,
    accession: filing.accession,
    formType: filing.form,
    filedAt: filing.filedAt,
    fileNumber: filing.fileNumber,
    location: location ?? null,
  })
}

/** Every Form D offering record for one filer, oldest first. */
export async function fetchOfferingHistory(profile: FilerProfile): Promise<OfferingRecord[]> {
  const filings = [...profile.formD].reverse()
  const settled = await mapWithConcurrency(filings, REQUEST_CONCURRENCY, async (filing) => {
    try {
      return await fetchOffering(profile.cik, filing, profile.location)
    } catch (error) {
      // A single unreadable filing should not lose the rest of the trail; the
      // raise is still computable from the filings that did parse.
      console.warn(`peer intel: ${profile.cik} ${filing.accession} unreadable`, error)
      return null
    }
  })
  return settled.filter((r): r is OfferingRecord => r != null)
}

export type CohortOfferings = {
  /** Offering records per vehicle CIK, oldest filing first. */
  byCik: Map<string, OfferingRecord[]>
  /**
   * Vehicles that genuinely could not be read, with the reason. A Reg D fund
   * must have a Form D, so an entry here means a fetch failed or the registry
   * holds the wrong CIK — either way it needs looking at.
   */
  failures: Array<{ cik: string; manager: string; reason: string }>
  /**
   * Registered vehicles with no Form D. **Expected, not a failure**: a listed
   * REIT or non-traded BDC raises through a registered offering rather than
   * Regulation D. Their fundraising is share issuance in the periodic reports
   * step 3 reads. Kept separate so a panel does not report nine problems where
   * there are none.
   */
  noFormD: Array<{ cik: string; manager: string }>
  /** Requests issued, for the cron's budget — see `maxDuration` on warm-cache. */
  requests: number
}

/**
 * Every Form D offering record for every vehicle in a layer.
 *
 * This is the one expensive call in the tracker. Each vehicle needs one
 * submissions request plus one per Form D filing, because the offering figures
 * live in each filing's own XML and there is no bulk form of them. For the
 * national layer that is roughly 65 vehicles and 250-350 requests; at the
 * rate-limit spacing in `edgar-contract.ts` it runs in about a minute, which
 * fits inside warm-cache's 300-second ceiling with room to spare.
 *
 * A vehicle that fails is recorded in `failures` and omitted from `byCik`, so
 * the aggregation skips it rather than reading it as a manager who raised
 * nothing. The caller decides whether a partial cohort is worth caching.
 */
export async function fetchCohortOfferings(layer: PeerLayer): Promise<CohortOfferings> {
  const byCik = new Map<string, OfferingRecord[]>()
  const failures: CohortOfferings["failures"] = []
  const noFormD: CohortOfferings["noFormD"] = []
  let requests = 0

  const vehicles = vehiclesInScope(layer)
  const outcomes = await mapWithConcurrency(vehicles, REQUEST_CONCURRENCY, async (vehicle) => {
    try {
      const profile = await fetchFilerProfile(vehicle.cik)
      if (!profile.formD.length) {
        // A registered vehicle without a Form D is raising through a
        // registered offering, which is normal; a private one without a Form D
        // should not exist.
        const expected = vehicle.kind === "registered" || profile.kind === "registered"
        return { vehicle, requests: 1, ...(expected ? { noFormD: true as const } : { reason: "no Form D filings" }) }
      }
      const records = await fetchOfferingHistory(profile)
      if (!records.length) return { vehicle, requests: 1 + profile.formD.length, reason: "no readable Form D" }
      return { vehicle, requests: 1 + profile.formD.length, records }
    } catch (error) {
      return { vehicle, requests: 1, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  for (const outcome of outcomes) {
    requests += outcome.requests
    const { cik, manager } = outcome.vehicle
    if ("records" in outcome && outcome.records) byCik.set(cik, outcome.records)
    else if ("noFormD" in outcome) noFormD.push({ cik, manager })
    else if ("reason" in outcome && outcome.reason) failures.push({ cik, manager, reason: outcome.reason })
  }

  return { byCik, failures, noFormD, requests }
}

export type VehicleMetrics = {
  cik: string
  manager: string
  vehicleName: string
  /** Quarterly series per metric key; a metric the filer does not tag is absent. */
  series: Record<string, QuarterPoint[]>
  /** Which concept answered for each metric, for the provenance disclosure. */
  resolvedConcepts: Record<string, string>
  /** Metric keys the filer tags under no candidate concept. */
  missingMetrics: string[]
  /**
   * Whether the vehicle's shares trade, carried through because it decides what
   * the flows mean.
   */
  quoted?: VehicleQuotation
  /**
   * Capital in less capital out, per quarter. Empty when either side is
   * missing, **and empty for a listed vehicle**: there, issuance and
   * repurchases are an equity raise and a buyback rather than subscriptions and
   * redemptions, so a net figure would read as investor demand when it is a
   * capital-markets decision.
   */
  netFlow: QuarterPoint[]
}

/**
 * The quarterly series for one registered vehicle.
 *
 * One request per metric, not one for the whole entity: `companyfacts` returns
 * every concept a filer has ever tagged, which for Blue Owl is 570 KB against
 * 4.9 KB for a single concept — 117x the payload for data we discard. The
 * `frames` API would be fewer requests still but cannot read these filers at
 * all; `edgar-contract.ts` carries that measurement.
 *
 * A 404 on a concept means the filer does not tag it, which is ordinary and
 * common — coverage across the tier runs from 12/12 for share issuance down to
 * 2/12 for payment-in-kind income. It is recorded in `missingMetrics` rather
 * than thrown, so a panel can say the figure is not reported instead of showing
 * a zero.
 */
export async function fetchVehicleMetrics(vehicle: {
  cik: string
  manager: string
  name: string
  quoted?: VehicleQuotation
}): Promise<VehicleMetrics> {
  const series: Record<string, QuarterPoint[]> = {}
  const resolvedConcepts: Record<string, string> = {}
  const missingMetrics: string[] = []

  const resolvedPerMetric = await mapWithConcurrency(PEER_METRICS, REQUEST_CONCURRENCY, async (metric) => {
    for (const [taxonomy, concept] of metric.candidates) {
      let json: unknown
      try {
        json = await getJson<unknown>(buildCompanyConceptUrl(vehicle.cik, taxonomy, concept))
      } catch {
        // A 404 is the normal answer for a concept this filer does not tag;
        // getText only throws after exhausting retries on transient statuses.
        continue
      }
      const parsed = parseConceptFacts(json)
      if (!parsed?.facts.length) continue
      return {
        key: metric.key,
        points: toQuarters(metric.basis, parsed.facts),
        source: `${taxonomy}:${concept} (${parsed.unit})`,
      }
    }
    return null
  })

  for (const [index, result] of resolvedPerMetric.entries()) {
    if (result) {
      series[result.key] = result.points
      resolvedConcepts[result.key] = result.source
    } else {
      missingMetrics.push(PEER_METRICS[index].key)
    }
  }

  return {
    cik: vehicle.cik,
    manager: vehicle.manager,
    vehicleName: vehicle.name,
    series,
    resolvedConcepts,
    missingMetrics,
    ...(vehicle.quoted ? { quoted: vehicle.quoted } : {}),
    netFlow:
      vehicle.quoted === "non-traded" && series.subscriptions && series.repurchases
        ? netFlow(series.subscriptions, series.repurchases)
        : [],
  }
}

export type RegisteredTier = {
  vehicles: VehicleMetrics[]
  failures: Array<{ cik: string; manager: string; reason: string }>
  requests: number
}

/**
 * Every registered vehicle in a layer.
 *
 * Only the registered tier is fetched, because a private fund files no periodic
 * report and has none of this to give. In this registry that tier is entirely
 * national, so the Miami-Dade and Florida layers return nothing here — which is
 * the fact the coverage footers have to state rather than leave as an empty
 * chart.
 */
export async function fetchRegisteredTier(layer: PeerLayer): Promise<RegisteredTier> {
  const vehicles: VehicleMetrics[] = []
  const failures: RegisteredTier["failures"] = []
  let requests = 0

  const tier = registeredVehiclesInScope(layer)
  const outcomes = await mapWithConcurrency(tier, Math.max(2, Math.floor(REQUEST_CONCURRENCY / 2)), async (vehicle) => {
    try {
      return { vehicle, metrics: await fetchVehicleMetrics(vehicle) }
    } catch (error) {
      return { vehicle, reason: error instanceof Error ? error.message : String(error) }
    }
  })
  for (const outcome of outcomes) {
    requests += PEER_METRICS.length
    if ("metrics" in outcome && outcome.metrics) vehicles.push(outcome.metrics)
    else if ("reason" in outcome) failures.push({ cik: outcome.vehicle.cik, manager: outcome.vehicle.manager, reason: outcome.reason })
  }

  return { vehicles, failures, requests }
}

export type PeerIntelPayload = {
  cohort: PeerCohort
  /** One entry per manager in the layer, in the cohort's order. */
  signals: ManagerSignals[]
  firingRates: ReturnType<typeof signalFiringRates>
  /**
   * The registered tier's quarterly series, trimmed to the trailing window.
   *
   * Trimmed before storage rather than after: a full history for twelve
   * vehicles across eight metrics would add most of a megabyte to an entry that
   * is otherwise 144 KB, and no panel shows more than eight quarters. The
   * untrimmed series are still used to compute the signals, which need five.
   *
   * Empty for the Miami-Dade and Florida layers, because every peer there is a
   * private fund — which the panels state rather than rendering blank charts.
   */
  tier: VehicleTrend[]
  /**
   * Recent news about tracked managers, gated for name and subject.
   *
   * The only part of the payload that is not from a filing, and the only part
   * that may be empty because an external service was unavailable rather than
   * because there was nothing to report — `developments.failures` says which.
   */
  developments: DevelopmentsResult
  /**
   * Whether each non-traded vehicle's repurchase offer was taken to its stated
   * cap — the closest thing to gating that any filing supports. Empty for a
   * layer with no non-traded vehicle.
   */
  gating: GatingResult
  /**
   * Each manager's private funds as its SEC-registered adviser reports them on
   * Form ADV Schedule D 7.B.(1): gross asset value, owners, audit and
   * custody. Read from the committed extract, not fetched — see
   * `lib/peer-intel/adv-link.ts` — and attached again after the cache by the
   * action, so a newly committed extract shows without waiting for a rebuild.
   * Keyed by peer id; a manager with no adviser, or whose adviser has not
   * been read, has no entry.
   */
  adv: LayerAdv
  /**
   * Each manager's continuation, annex and extension vehicles, from one
   * full-text search per manager over its names and people and from its ADV —
   * see `lib/peer-intel/continuation.ts`. A flag, never a score. Keyed by peer
   * id; every manager in scope has an entry, searched or not.
   */
  continuation: ContinuationResult
  /** What the fetch cost and what it could not read, so a panel can be honest. */
  diagnostics: {
    asOf: string
    formDRequests: number
    xbrlRequests: number
    continuationRequests: number
    /** Private vehicles whose Form D could not be read — real gaps. */
    offeringFailures: Array<{ cik: string; manager: string; reason: string }>
    /** Registered vehicles with no Form D, which is expected rather than a gap. */
    registeredWithoutFormD: Array<{ cik: string; manager: string }>
    metricFailures: Array<{ cik: string; manager: string; reason: string }>
  }
}

export type LayerAdv = { refreshedOn: string | null; historyTo: string | null; byManager: Record<string, ManagerAdv> }

/**
 * The ADV views for a layer, from the committed extract and the cohort's
 * Form D file numbers. Pure and cheap, so the action calls it on every read
 * rather than trusting the copy stored with the cached payload.
 */
export function buildLayerAdv(layer: PeerLayer, cohort: PeerCohort): LayerAdv {
  const keys = new Map<string, VehicleKey[]>()
  for (const m of cohort.managers) {
    keys.set(
      m.peerId,
      m.raises.map((r) => ({ cik: r.cik, name: r.vehicleName, fileNumber: r.raise.fileNumber ?? null }))
    )
  }
  return layerAdv(peersInScope(layer), advExtract(), keys, advHistory())
}

export type ContinuationResult = {
  byManager: Record<string, ContinuationView>
  /** Managers whose search or trail reads failed; their view says "not searched". */
  failures: Array<{ manager: string; reason: string }>
  requests: number
}

/** Search hits read per manager; beyond this the rest are left unread rather than spending the budget. */
const MAX_CONTINUATION_HITS = 8

/**
 * Continuation, annex and extension vehicles for every manager in a layer.
 *
 * One full-text search per term — the manager's names and the people on its
 * tracked raises, each with the four marking words; EDGAR takes one quoted
 * phrase per query, see `continuation.ts` — then the Form D trail of each
 * filer whose own name carries a marking word. The search index covers a
 * filing's related persons, which is what lets a vehicle named after a fund
 * rather than the firm be found; attribution is then decided from the trail
 * and the adviser's ADV records in `buildContinuationView`, and a hit nothing
 * attributes is counted, not shown. A filer that is already a tracked vehicle
 * reuses the cohort's trail.
 *
 * Cost: up to eight searches per manager (about 150 for the national layer)
 * plus one submissions request and one per filing for each new filer, under
 * the same rate limiter as everything else — some twenty seconds nationally.
 */
export async function fetchContinuationVehicles(layer: PeerLayer, cohort: PeerCohort, adv: LayerAdv): Promise<ContinuationResult> {
  const failures: ContinuationResult["failures"] = []
  let requests = 0
  const extract = advExtract()

  const views = await mapWithConcurrency(peersInScope(layer), 3, async (peer) => {
    const manager = cohort.managers.find((m) => m.peerId === peer.id) ?? null
    // The full records, not the payload briefs: a feeder named only on its
    // master's record is where Pretium's annex fund appears.
    const advFunds: AdvisedFund[] = (adv.byManager[peer.id]?.filings ?? []).flatMap((f) =>
      (extract.advisers[f.crd]?.funds ?? []).map((fund) => ({ crd: f.crd, fund }))
    )
    const terms = searchTerms(peer, manager)
    if (!terms.length) return buildContinuationView(peer, manager, advFunds, [], terms, false)
    try {
      const newestByCik = new Map<string, FtsHit>()
      for (const term of terms) {
        for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
          const res = await searchFilings({ q: continuationQuery(term), forms: ["D"], from: page * 10 })
          requests++
          for (const h of res.hits) {
            const prev = newestByCik.get(h.cik)
            if (!prev || h.filedAt > prev.filedAt) newestByCik.set(h.cik, h)
          }
          if (res.hits.length < 10 || (page + 1) * 10 >= res.total) break
        }
      }
      const hits: ContinuationHit[] = []
      for (const h of newestByCik.values()) {
        // The search matches the words anywhere in the filing; only a filer
        // whose own name carries one is a candidate.
        if (!continuationKind(h.name)) continue
        if (hits.length >= MAX_CONTINUATION_HITS) break
        const tracked = manager?.raises.find((r) => r.cik === h.cik)
        if (tracked) {
          hits.push({ cik: h.cik, name: h.name, raise: tracked.raise })
          continue
        }
        const profile = await fetchFilerProfile(h.cik)
        requests++
        const records = await fetchOfferingHistory(profile)
        requests += profile.formD.length
        const built = buildRaise(records, cohort.asOf)
        if (built) hits.push({ cik: h.cik, name: profile.name || h.name, raise: built })
      }
      return buildContinuationView(peer, manager, advFunds, hits, terms, true)
    } catch (error) {
      failures.push({ manager: peer.manager, reason: error instanceof Error ? error.message : String(error) })
      return buildContinuationView(peer, manager, advFunds, [], terms, false)
    }
  })

  const byManager: Record<string, ContinuationView> = {}
  for (const v of views) byManager[v.peerId] = v
  return { byManager, failures, requests }
}

/**
 * Build a whole layer: Form D trails, the registered tier's quarterly series,
 * the aggregate and the signals.
 *
 * The work lives here rather than in the server action so it can be exercised
 * against live data without Next — importing a `"use server"` module outside
 * the framework pulls in React's server entry point and fails. Same split as
 * `app/services/bank-behavior.ts` under `app/actions/bank-behavior.ts`:
 * the service does the work, the action adds the cache.
 */
export async function buildPeerIntelPayload(layer: PeerLayer, asOf: string): Promise<PeerIntelPayload> {
  // The SEC fetches share a process-wide rate limiter, so they cannot together
  // exceed its ceiling; the news feeds are a different host entirely and run
  // alongside. A news failure is collected rather than thrown, so an outage
  // there cannot take the filings panels down.
  const [offerings, tier, developments, gating] = await Promise.all([
    fetchCohortOfferings(layer),
    fetchRegisteredTier(layer),
    fetchDevelopments(layer, asOf).catch((error) => ({
      items: [],
      unsearchable: [],
      failures: [{ manager: "all", reason: error instanceof Error ? error.message : String(error) }],
      considered: 0,
      requests: 0,
    })),
    fetchGating(layer).catch((error) => ({
      assessments: [],
      unassessable: [],
      failures: [{ manager: "all", reason: error instanceof Error ? error.message : String(error) }],
      requests: 0,
    })),
  ])

  const cohort = buildPeerCohort(layer, offerings.byCik, asOf)
  const adv = buildLayerAdv(layer, cohort)
  // Needs the cohort's people and the ADV views, so it runs after them. Its
  // failures are collected per manager; a search outage leaves the section
  // saying "not searched" rather than taking the layer down.
  const continuation = await fetchContinuationVehicles(layer, cohort, adv).catch((error) => ({
    byManager: {},
    failures: [{ manager: "all", reason: error instanceof Error ? error.message : String(error) }],
    requests: 0,
  }))

  const seriesByCik = new Map<string, { series: VehicleSeries; quoted?: VehicleQuotation }>()
  for (const vehicle of tier.vehicles) {
    seriesByCik.set(vehicle.cik, {
      series: { ...vehicle.series, ...(vehicle.netFlow.length ? { netFlow: vehicle.netFlow } : {}) },
      ...(vehicle.quoted ? { quoted: vehicle.quoted } : {}),
    })
  }

  // CIK to manager comes from the registry, not from the raises: a registered
  // vehicle files no Form D, so it never appears in its manager's `raises` and
  // could not be matched that way. Getting this wrong silently drops every
  // liquidity and portfolio signal, because the series would reach no manager.
  const ownerOf = new Map(vehiclesInScope(layer).map((v) => [v.cik, v.peerId]))

  const signals = cohort.managers.map((manager) => {
    // Only this manager's own vehicles, so a signal can never be drawn from a
    // peer's figures — the rule that keeps the three layers agreeing.
    const own = new Map([...seriesByCik].filter(([cik]) => ownerOf.get(cik) === manager.peerId))
    return managerSignals(manager, own)
  })

  return {
    cohort,
    signals,
    firingRates: signalFiringRates(signals),
    tier: tier.vehicles.map((v) => buildVehicleTrend(v, ownerOf.get(v.cik) ?? "")),
    developments,
    gating,
    adv,
    continuation,
    diagnostics: {
      asOf,
      formDRequests: offerings.requests,
      xbrlRequests: tier.requests,
      continuationRequests: continuation.requests,
      offeringFailures: offerings.failures,
      registeredWithoutFormD: offerings.noFormD,
      metricFailures: tier.failures,
    },
  }
}

/**
 * Google News RSS. No key, no quota published, so it is used politely and its
 * absence is never an error — the panel says the feed was unavailable and the
 * filings-based panels are unaffected.
 */
function newsFeedUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
}

function rssTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, "i"))
  if (!m) return null
  const v = m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  return v.length ? v : null
}

function parseFeed(xml: string): DevelopmentItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((m) => m[1])
    .map((block) => {
      const title = rssTag(block, "title")
      const url = rssTag(block, "link")
      if (!title || !url) return null
      const published = rssTag(block, "pubDate")
      const parsed = published ? Date.parse(published) : NaN
      return {
        title,
        url,
        publishedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10),
        source: rssTag(block, "source"),
      } satisfies DevelopmentItem
    })
    .filter((i): i is DevelopmentItem => i != null)
}

export type DevelopmentsResult = {
  items: ScoredDevelopment[]
  /** Managers with no name phrase safe enough to search on. */
  unsearchable: string[]
  /** Managers whose feed could not be read. */
  failures: Array<{ manager: string; reason: string }>
  /** How many raw items were considered, so a panel can say how selective it is. */
  considered: number
  requests: number
}

/**
 * Recent developments for every manager in a layer.
 *
 * One feed per manager, each query built from phrases long enough to be
 * unambiguous — see `lib/peer-intel/developments.ts` for why a manager called
 * Bridge or Apollo cannot be searched on its short name. A manager with no safe
 * phrase is reported rather than searched loosely.
 *
 * Failures are collected, never thrown: this is the one part of the tab that
 * depends on something other than SEC, and a news outage must not take the
 * filings panels down with it.
 */
export async function fetchDevelopments(layer: PeerLayer, asOf: string): Promise<DevelopmentsResult> {
  const peers = peersInScope(layer)
  const unsearchable: string[] = []
  const failures: DevelopmentsResult["failures"] = []
  let considered = 0
  let requests = 0

  const searchable = peers
    .map((peer) => ({ peer, query: developmentsQuery(peer.manager, peer.aliases) }))
    .filter((entry): entry is { peer: (typeof peers)[number]; query: string } => {
      if (!entry.query) {
        unsearchable.push(entry.peer.manager)
        return false
      }
      return true
    })

  const perManager = await mapWithConcurrency(searchable, 4, async ({ peer, query }) => {
    try {
      const res = await fetch(newsFeedUrl(query), {
        headers: { "User-Agent": "MarketIntelligence/1.0 (peer-developments)" },
        cache: "no-store",
      })
      requests++
      if (!res.ok) {
        failures.push({ manager: peer.manager, reason: `feed returned ${res.status}` })
        return []
      }
      const items = parseFeed(await res.text())
      considered += items.length
      return items
        .filter((item) => isRecent(item, asOf))
        .map((item) => scoreDevelopment(item, { peerId: peer.id, manager: peer.manager, aliases: peer.aliases }))
        .flatMap((decision) => (decision.kept ? [decision.item] : []))
    } catch (error) {
      failures.push({ manager: peer.manager, reason: error instanceof Error ? error.message : String(error) })
      return []
    }
  })

  return { items: rankDevelopments(perManager.flat()), unsearchable, failures, considered, requests }
}

export type GatingResult = {
  assessments: GatingAssessment[]
  /** Vehicles whose filing was read but stated no cap or had no table. */
  unassessable: Array<{ manager: string; vehicleName: string }>
  failures: Array<{ manager: string; reason: string }>
  requests: number
}

/**
 * Gating for the non-traded tier, read from each vehicle's newest 10-Q.
 *
 * This is the only part of the tracker that downloads a whole filing rather
 * than a structured endpoint, because the repurchase cap exists only in prose
 * and a multi-class filer's share count exists only in the earnings-per-share
 * table — `companyconcept` returns a 404 for it. The documents are large (Blue
 * Owl's is 14 MB) so this runs only over the seven non-traded vehicles, not the
 * whole registry, and only the newest 10-Q each.
 *
 * Listed vehicles are skipped: they have no repurchase programme to gate, and a
 * holder wanting out sells the stock.
 */
export async function fetchGating(layer: PeerLayer): Promise<GatingResult> {
  const vehicles = nonTradedVehiclesInScope(layer)
  const assessments: GatingAssessment[] = []
  const unassessable: GatingResult["unassessable"] = []
  const failures: GatingResult["failures"] = []
  let requests = 0

  const outcomes = await mapWithConcurrency(vehicles, 3, async (vehicle) => {
    try {
      const submissions = await getJson<SubmissionsResponse>(buildSubmissionsUrl(vehicle.cik))
      requests++
      const recent = submissions.filings?.recent
      const forms = recent?.form ?? []
      const index = forms.findIndex((f) => f === "10-Q")
      if (index < 0) return { vehicle, reason: "no 10-Q on file" }

      const accession = (recent?.accessionNumber ?? [])[index]
      const document = (recent as { primaryDocument?: string[] })?.primaryDocument?.[index]
      if (!accession || !document) return { vehicle, reason: "10-Q has no primary document" }

      const bare = accession.replace(/-/g, "")
      const url = `https://www.sec.gov/Archives/edgar/data/${unpadCik(vehicle.cik)}/${bare}/${document}`
      const html = await getText(url)
      requests++
      // Distinguish a filing that states no cap from a download that failed —
      // treating both as "unassessable" hid six empty fetches behind a result
      // that looked like a data limitation.
      if (html.length < 50_000) return { vehicle, reason: `10-Q returned only ${html.length} bytes` }
      const assessment = assessGating(
        { cik: vehicle.cik, manager: vehicle.manager, vehicleName: vehicle.name },
        plainText(html)
      )
      return assessment ? { vehicle, assessment } : { vehicle, unassessable: true as const }
    } catch (error) {
      return { vehicle, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  for (const outcome of outcomes) {
    if ("assessment" in outcome && outcome.assessment) assessments.push(outcome.assessment)
    else if ("unassessable" in outcome) unassessable.push({ manager: outcome.vehicle.manager, vehicleName: outcome.vehicle.name })
    else if ("reason" in outcome && outcome.reason) failures.push({ manager: outcome.vehicle.manager, reason: outcome.reason })
  }

  return { assessments, unassessable, failures, requests }
}
