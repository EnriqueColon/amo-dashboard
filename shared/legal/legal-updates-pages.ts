/**
 * Reading the page an item cites, for the items that have no record behind them.
 *
 * The Regulatory and Legislative sections draw from records that publish their own text. The
 * Enforcement section does not: the OCC and FDIC announce most actions in a monthly roundup page,
 * and until this existed the feed's summary of such a page was whatever the model recalled of it
 * at search time — which is how a roundup came to be summarised as "highlights the OCC's
 * commitment to maintaining integrity in the banking sector". The page is a few hundred words of
 * plain prose listing each order by name. Reading it is cheap and removes the guessing.
 *
 * Import-free, like its siblings, so the test runner can load it without a build.
 */

/** A roundup page is short; this cap only ever matters for a page that is not what we thought. */
export const PAGE_WORD_CAP = 3_000

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * The readable text of a page, with navigation and chrome left behind where the page marks them.
 *
 * Prefers `<main>`, then `<article>`, then the body. Block-level tags become line breaks so that
 * list items — one enforcement action each, on the OCC's pages — stay on separate lines; the
 * model is better at counting things that are already counted.
 */
export function htmlToText(html: string): string {
  const region =
    html.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<article[\s>][\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<body[\s>][\s\S]*?<\/body>/i)?.[0] ??
    html
  const text = region
    .replace(/<(script|style|noscript|nav|header|footer|form|svg)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

function truncateWords(s: string, limit: number): string {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length <= limit) return s.trim()
  return words.slice(0, limit).join(" ") + " […]"
}

/**
 * The cited page as text, or undefined when it cannot be had. A page that cannot be read leaves
 * the item exactly as it was, which is how every other fetch in this feed fails too.
 */
export async function fetchPageText(
  url: string,
  timeoutMs = 15_000,
  cap = PAGE_WORD_CAP
): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; MarketIntelligenceTool/1.0)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      cache: "no-store",
    })
    if (!res.ok) return undefined
    if (!/html/i.test(res.headers.get("content-type") ?? "")) return undefined
    const text = htmlToText(await res.text())
    return text.length > 0 ? truncateWords(text, cap) : undefined
  } catch {
    return undefined
  }
}

export type DigestPage = { key: string; title: string; date: string; text: string }

/**
 * Asks the model to report what a roundup page says, and nothing it does not.
 *
 * Keyed by the item's own id, the way the record prompts are keyed by document or bill number, so
 * a reordered or partial answer still lands on the right item. The page's actions against
 * individuals are counted and not named: the feed's rule is that a ruling on one person's career
 * is not an item, and that holds inside a list as much as outside it.
 */
export function buildDigestDetailPrompt(pages: DigestPage[]): string {
  const list = pages
    .map((p) => `- ${p.key} [${p.date}]: ${p.title}\n  Page text:\n"""\n${p.text}\n"""`)
    .join("\n\n")

  return `These are real pages published by federal bank regulators, each a monthly list of enforcement actions. Their titles and dates are already confirmed — do not change them, and do not add pages.

${list}

For each one, write three things for a firm that buys and works out distressed commercial real estate debt. Use only what the page text says; do not add anything you know or believe about these institutions from elsewhere.
- "summary": 2-3 sentences stating what the page lists: how many actions, against what kinds of party, and the institutions named. Name no individual person; refer to actions against individuals only by count ("and two prohibition orders against former employees").
- "details": one bullet per action against an institution — a bank, savings association, holding company or service provider — each one sentence of at most 35 words naming the institution, its city and state if given, the type of order, and the conduct or deficiency it addresses. Where the page lists only actions against individuals, return exactly one bullet saying so and giving the count. Where the page gives counts by type of order but does not name the institutions (the FDIC's releases do this), return one bullet giving those counts and saying the orders themselves are on the linked list; do not guess at names. Never name an individual.
- "whyItMatters": 1-2 sentences. Where an institutional order concerns credit, asset quality, commercial real estate, concentrations or capital, say what it signals for that lender's loan book. Where the month holds only BSA/AML orders or actions against individuals, say plainly that there is nothing here bearing on note purchases or workouts.

Return ONLY valid JSON, keyed exactly as written above:
{
  "summaries": {
    "${pages[0]?.key ?? "enforcement-0"}": { "summary": "...", "details": ["..."], "whyItMatters": "..." }
  }
}`
}
