import type { RetrievedSource } from "./schema"

type PromptMessages = {
  system: string
  user: string
}

export function buildIndustryOutlookPrompt(sources: RetrievedSource[]): PromptMessages {
  const system = [
    "Return ONLY valid JSON. No markdown, no extra text, no trailing commas.",
    "You MUST cite facts only from SOURCES_CONTEXT.",
    "Do not invent numbers or sources.",
    "If sources are insufficient, explicitly state that in facts.",
  ].join(" ")

  const task =
    "I would like the current and projected industry outlook for the commercial real estate sector for Miami, Florida, and the US level as it pertains to investing in distressed debt. Provide sources."

  const rules = `
You are writing a market brief suitable for an INVESTMENT COMMITTEE memo.
Time window: recent and current conditions (do not limit strictly to past 7 days).
Topic scope (national): distressed COMMERCIAL REAL ESTATE DEBT (CMBS stress, special servicing, delinquencies/defaults, refinancing stress, note/loan sales, workouts, receiverships, foreclosures).
Topic scope (Florida/Miami): use Florida/Miami-specific sources. If distressed-debt facts are thin, include regional CRE market signals tied to distressed-debt investing (transactions, refinancing, workouts, foreclosures, lender activity, financing markets).
Desired tone: concise, investment-committee ready. Mimic this style (but do NOT invent numbers): “Distress is real but pocketed…”, “Liquidity is returning selectively…”, “Maturing debt wall persists…”, “Investor angle: …”.
Use short labeled sentences in analysis like “Current: …”, “Liquidity: …”, “Maturities: …”, “Investor angle: …”, “Risk: …”.

Output MUST be ONLY valid JSON (no markdown, no extra text) matching EXACTLY:
{
  "keyThemes": ["...3–6 short phrases..."],
  "facts": {
    "national": "Reported facts paragraph.",
    "florida": "Reported facts paragraph.",
    "miami": "Reported facts paragraph."
  },
  "analysis": {
    "national": "LLM analysis (assumptions noted): ...",
    "florida": "LLM analysis (assumptions noted): ...",
    "miami": "LLM analysis (assumptions noted): ..."
  },
  "sources": [{"title":"...","url":"https://..."}]
}

FACTS RULES (STRICT):
- Include ONLY statements directly supported by the sources you cite.
- Statistical facts MUST include: the metric + the source name + the reported value exactly as stated + as-of date if provided.
- Forbidden in facts: estimates, inferred totals, blended statistics, and ANY forward-looking language (could/may/likely/expect/forecast).
- No inline citation markers like [1], [2], (1) in the text.
- Every factual sentence must be attributable (e.g., "According to Trepp, ...", "The Federal Reserve reported ...", "Moody's said ...").
- Florida facts must follow this sequence:
  1) Include at least 2 Florida-specific distressed-debt facts with sources. If not available, use Florida CRE market signals tied to debt stress (foreclosures, refinancings, workouts) and clearly label them "Regional market signals:".
  2) Always include a Florida snapshot sentence if any regional metrics exist: "Snapshot (most recent available): ..." with dates.
- Miami facts must follow this sequence:
  1) Include at least 2 Miami-specific distressed-debt facts with sources. If not available, use Miami CRE market signals tied to debt stress (foreclosures, refinancings, workouts) and clearly label them "Regional market signals:".
  2) Always include a Miami snapshot sentence if any regional metrics exist: "Snapshot (most recent available): ..." with dates.
- Truncate at sentence boundaries.

ANALYSIS RULES:
- Each analysis paragraph MUST begin with: "LLM analysis (assumptions noted):"
- Any inference or projection MUST be labeled explicitly as: "Assumption: …"
- Analysis must be logically derived from the facts above and can include a short forward-looking outlook for distressed-debt investing, clearly labeled as assumptions.
- No new numbers in analysis unless already stated in facts.
- Structure analysis as 4–6 short labeled sentences: Current, Liquidity, Maturities, Investor angle, Risk (assumptions labeled).

SOURCES RULES:
- 5–10 sources total, mixing articles and reports.
- Must include at least 2 Florida sources and 2 Miami sources when regional facts are provided.
- Prefer: Trepp, Federal Reserve releases, rating agencies, major CRE trade press, business journals, and local Florida/Miami sources (South Florida Business Journal, Miami Herald business, local Business Journals, county clerk/foreclosure portals).
- Do not bypass paywalls.
`

  const sourcesContext = JSON.stringify(
    sources.map((s) => ({
      title: s.title,
      url: s.url,
      region: s.region,
      publisher: s.publisher,
      date: s.date,
      snippet: s.snippet,
    })),
    null,
    2
  )

  const user = `${task}\n${rules}\nSOURCES_CONTEXT:\n${sourcesContext}`

  return { system, user }
}
