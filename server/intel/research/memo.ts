import type { ResearchReport } from "./feed"

export type MemoSection = {
  heading: string
  body: string                // plain prose paragraph(s)
  bullets?: string[]          // optional supporting bullets
}

export type GeneratedMemo = {
  type: "market"
  title: string
  date: string
  sections: MemoSection[]
  disclaimer: string
}

function formatReportsContext(reports: ResearchReport[]): string {
  return reports
    .map((r, i) =>
      [
        `[${i + 1}] ${r.publisher} — "${r.title}" (${r.publishedDate || "recent"})`,
        `Topic: ${r.topic}`,
        `Summary: ${r.summary}`,
        `Key Findings:`,
        ...r.keyFindings.map((f) => `  • ${f}`),
      ].join("\n")
    )
    .join("\n\n")
}

function buildMarketMemoPrompt(reports: ResearchReport[]): string {
  return `You are a senior analyst at a distressed commercial real estate debt investment firm.

Using ONLY the research reports provided below, write a comprehensive Market Conditions Memo.
Do not invent data points — only use what is stated in the reports. Cite publisher names inline (e.g. "According to Trepp...").

SELECTED RESEARCH REPORTS:
${formatReportsContext(reports)}

Write the memo in the following structure. Return ONLY valid JSON:
{
  "title": "CRE Market Conditions Brief — [current month and year]",
  "sections": [
    {
      "heading": "Executive Summary",
      "body": "3-4 sentence overview of current CRE market conditions drawn from the research",
      "bullets": ["key signal 1", "key signal 2", "key signal 3"]
    },
    {
      "heading": "CRE Debt & Capital Markets Environment",
      "body": "Paragraph covering lending conditions, CMBS, distress signals, maturity walls, special servicing trends",
      "bullets": ["specific data point", "specific data point", "specific data point"]
    },
    {
      "heading": "Regional Market Context",
      "body": "Paragraph on Florida/Southeast conditions if covered in reports, otherwise broader regional dynamics",
      "bullets": ["specific data point", "specific data point"]
    },
    {
      "heading": "Property Type Outlooks",
      "body": "Summary of conditions for property types covered in selected reports",
      "bullets": ["property type + key stat", "property type + key stat"]
    },
    {
      "heading": "Risk Factors & Headwinds",
      "body": "Key risks and challenges identified across the research",
      "bullets": ["risk 1", "risk 2", "risk 3"]
    },
    {
      "heading": "Tailwinds Supporting Investment Activity",
      "body": "Factors that support opportunistic or distressed investing in current environment",
      "bullets": ["tailwind 1", "tailwind 2", "tailwind 3"]
    }
  ]
}`
}

async function callOpenAI(prompt: string): Promise<string> {
  const API_KEY = process.env.OPENAI_API_KEY?.trim()
  if (!API_KEY) throw new Error("Missing OPENAI_API_KEY")

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an expert CRE investment analyst. Return ONLY valid JSON as instructed. Write at a professional institutional level.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 3500,
    }),
    cache: "no-store",
  })

  if (!res.ok) {
    const err = await res.text().catch(() => "")
    throw new Error(`OpenAI error ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  return data?.choices?.[0]?.message?.content || ""
}

export async function generateResearchMemo(
  reports: ResearchReport[]
): Promise<GeneratedMemo> {
  if (reports.length === 0) throw new Error("No reports selected.")

  const prompt = buildMarketMemoPrompt(reports)

  const raw = await callOpenAI(prompt)

  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("No JSON returned from AI.")

  const parsed = JSON.parse(match[0])

  const sections: MemoSection[] = (parsed.sections ?? []).map(
    (s: { heading?: string; body?: string; bullets?: string[] }) => ({
      heading: typeof s.heading === "string" ? s.heading.trim() : "",
      body: typeof s.body === "string" ? s.body.trim() : "",
      bullets: Array.isArray(s.bullets)
        ? s.bullets
            .filter((b: unknown) => typeof b === "string")
            .map((b: string) => b.replace(/^\s*[-•]\s*/, "").trim())
        : [],
    })
  )

  return {
    type: "market",
    title:
      typeof parsed.title === "string"
        ? parsed.title.trim()
        : "CRE Market Conditions Brief",
    date: new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    sections,
    disclaimer:
      "This memo was generated using AI synthesis of selected third-party research reports. It is intended for internal use only and does not constitute investment advice. All data points should be independently verified before use in investment decisions.",
  }
}
