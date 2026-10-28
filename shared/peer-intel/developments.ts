/**
 * "Other relevant developments" — the last of the brief's five asks.
 *
 * Everything else on this tab comes from a filing, which means it is accurate
 * and late. News is the opposite: a fund close is reported weeks before the
 * Form D amendment that confirms it. So this is deliberately held to a lower
 * standard of certainty and labelled as such — it is a prompt to go and look,
 * not a figure to quote.
 *
 * **The whole difficulty is name collisions.** The registry contains managers
 * called Bridge, Ladder, Camden, Integra, Omnia, Naso, Apollo, Ares, Pretium
 * and Safe Harbor. A search for "Bridge" returns bridges; "Apollo" returns a
 * theatre, a spacecraft and a Greek god; "Camden" is a town in New Jersey and
 * another in London. Matching on a manager's short name would fill the panel
 * with noise and, worse, attribute someone else's news to a competitor.
 *
 * So nothing here matches on a token. A manager is only recognised by an exact
 * phrase of at least two words — its full name, or an alias long enough to be
 * unambiguous — and a one-word alias is refused outright rather than used
 * carefully. That loses some genuine coverage, which is the right trade: a
 * missing item is a gap, a misattributed one is a wrong answer.
 *
 * Pure: items in, scored items out. The fetching is in the service.
 */

/** Fund-level events worth a reader's attention. */
const DEVELOPMENT_TERMS = [
  "closes",
  "closed",
  "final close",
  "first close",
  "launches",
  "launched",
  "raises",
  "raised",
  "fundraising",
  "fund raise",
  "capital raise",
  "commitment",
  "commitments",
  "oversubscribed",
  "vintage",
  "redemption",
  "redemptions",
  "withdrawal",
  "gate",
  "gated",
  "gating",
  "liquidity",
  "nav",
  "net asset value",
  "write-down",
  "writedown",
  "mark down",
  "markdown",
  "default",
  "non-accrual",
  "nonaccrual",
  "restructur",
  "downgrade",
  "performance",
  "hires",
  "hired",
  "appoints",
  "appointed",
  "steps down",
  "departs",
  "promoted",
  "acquires",
  "acquisition",
  "merger",
  "stake",
  "spin out",
  "spinout",
  "lawsuit",
  "sues",
  "sued",
  "investigation",
  "sec charges",
  "settlement",
] as const

/**
 * Items that mention a manager but are not a development about the manager.
 *
 * Mostly single-asset transaction coverage, which for these firms is constant
 * and says nothing about the business. A competitor financing one building is
 * not news about the competitor.
 */
const NOISE_TERMS = [
  // Sell-side coverage of a listed vehicle. Constant, and about the share price
  // rather than the business — these alone produced most of the first live run.
  "price target",
  "target price",
  "cuts target",
  "raises target",
  "buy rating",
  "sell rating",
  "hold rating",
  "outperform",
  "underperform",
  "overweight",
  "underweight",
  "analyst",
  "analysts",
  "forecast",
  "estimates",
  "eps",
  "short interest",
  "insider",
  "dividend yield",
  "stock",
  "shares of",

  "square feet",
  "square foot",
  "sq ft",
  "apartment complex",
  "office tower",
  "shopping center",
  "shopping centre",
  "strip mall",
  "ground lease",
  "groundbreaking",
  "ribbon cutting",
  "leases ",
  "signs lease",
  "renews lease",
  "tops out",
  "unveils plans",
  "files plans",
  "rendering",
  "obituary",
  "wedding",
  "charity",
  "gala",
  "sponsorship",
] as const

/** A phrase has to be this long before it can identify a manager on its own. */
const MIN_PHRASE_WORDS = 2

function normalise(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

/**
 * The phrases that may identify this manager in a headline.
 *
 * A one-word name or alias is dropped, not shortened — "Bridge" cannot be made
 * safe by context, and a wrong attribution is worse than a missing item. A
 * manager left with no usable phrase is reported by `hasUsablePhrase` so the UI
 * can say it is not covered rather than silently showing nothing.
 */
export function identifyingPhrases(manager: string, aliases: readonly string[]): string[] {
  const candidates = [manager, ...aliases]
  const kept = candidates.filter((c) => wordCount(c) >= MIN_PHRASE_WORDS)
  // Deduplicate on the normalised form, keeping the longest spelling.
  const byKey = new Map<string, string>()
  for (const phrase of kept.sort((a, b) => b.length - a.length)) {
    const key = normalise(phrase).trim()
    if (!byKey.has(key)) byKey.set(key, phrase)
  }
  return [...byKey.values()]
}

export function hasUsablePhrase(manager: string, aliases: readonly string[]): boolean {
  return identifyingPhrases(manager, aliases).length > 0
}

/**
 * The Google News query for one manager.
 *
 * Quoted phrases only, OR-ed, with a fund-context term required — so a search
 * for Bridge Investment Group cannot return bridge engineering, and a search
 * for Apollo Global Management cannot return the space programme. Returns null
 * where the manager has no phrase long enough to be safe.
 */
export function developmentsQuery(manager: string, aliases: readonly string[]): string | null {
  const phrases = identifyingPhrases(manager, aliases)
  if (!phrases.length) return null
  const names = phrases.slice(0, 4).map((p) => `"${p.replace(/"/g, "")}"`).join(" OR ")
  const context = '("fund" OR "credit" OR "capital" OR "investors" OR "real estate")'
  return `(${names}) AND ${context}`
}

export type DevelopmentItem = {
  title: string
  url: string
  /** `YYYY-MM-DD`, where the feed gives one. */
  publishedAt: string | null
  source: string | null
}

export type ScoredDevelopment = DevelopmentItem & {
  peerId: string
  manager: string
  /** The phrase that matched, so a reader can see why it was attributed here. */
  matchedPhrase: string
  /** The development terms found, for the "why this is here" tooltip. */
  matchedTerms: string[]
  score: number
  /** Noise terms found, which subtract. */
  matchedNoise: string[]
}

export type ScoreDecision =
  | { kept: true; item: ScoredDevelopment }
  | { kept: false; reason: "no name match" | "no development term" | "looks like single-asset coverage" }

/**
 * Does this headline belong to this manager, and is it a development?
 *
 * Both must hold. The name test is an exact phrase match against the title, not
 * the URL — a publisher's domain or slug can contain anything, and a story
 * about one firm routinely links to another. The development test needs at
 * least one fund-level term, so generic market commentary that happens to
 * mention a manager is dropped.
 */
export function scoreDevelopment(
  item: DevelopmentItem,
  peer: { peerId: string; manager: string; aliases: readonly string[] }
): ScoreDecision {
  const title = normalise(item.title)
  const phrases = identifyingPhrases(peer.manager, peer.aliases)

  const matchedPhrase = phrases.find((p) => title.includes(normalise(p)))
  if (!matchedPhrase) return { kept: false, reason: "no name match" }

  // Padded on both sides, so a term cannot match inside a longer word. Without
  // this, "Issues Pessimistic Forecast" matched "sues" and read as litigation.
  const matchedTerms = DEVELOPMENT_TERMS.filter((t) => title.includes(normalise(t)))
  if (!matchedTerms.length) return { kept: false, reason: "no development term" }

  const matchedNoise = NOISE_TERMS.filter((t) => title.includes(normalise(t)))
  const score = Math.min(matchedTerms.length, 4) * 3 - Math.min(matchedNoise.length, 3) * 4

  if (score <= 0) return { kept: false, reason: "looks like single-asset coverage" }

  return {
    kept: true,
    item: {
      ...item,
      peerId: peer.peerId,
      manager: peer.manager,
      matchedPhrase,
      matchedTerms: [...matchedTerms],
      matchedNoise: [...matchedNoise],
      score,
    },
  }
}

/**
 * The publisher Google News appends as " - Publisher Name".
 *
 * The same story syndicated to three outlets arrives as three items differing
 * only in that suffix, so it is stripped before deduplicating.
 */
function withoutPublisher(title: string): string {
  return title.replace(/\s+[-–—]\s+[^-–—]{2,40}$/, "")
}

/** Newest first, then by score; deduplicated on title across managers. */
export function rankDevelopments(items: readonly ScoredDevelopment[]): ScoredDevelopment[] {
  const byTitle = new Map<string, ScoredDevelopment>()
  for (const item of items) {
    const key = normalise(withoutPublisher(item.title)).trim()
    const held = byTitle.get(key)
    if (!held || item.score > held.score) byTitle.set(key, item)
  }
  return [...byTitle.values()].sort((a, b) => {
    const da = a.publishedAt ?? ""
    const db = b.publishedAt ?? ""
    if (da !== db) return da < db ? 1 : -1
    return b.score - a.score
  })
}

/** Items older than this are dropped: a development is only news for so long. */
export const DEVELOPMENT_MAX_AGE_DAYS = 45

export function isRecent(item: DevelopmentItem, asOf: string, maxAgeDays = DEVELOPMENT_MAX_AGE_DAYS): boolean {
  if (!item.publishedAt) return false
  const published = Date.parse(`${item.publishedAt}T00:00:00Z`)
  const now = Date.parse(`${asOf}T00:00:00Z`)
  if (Number.isNaN(published) || Number.isNaN(now)) return false
  return now - published <= maxAgeDays * 86_400_000 && published <= now + 86_400_000
}
