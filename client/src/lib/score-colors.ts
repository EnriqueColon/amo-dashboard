/**
 * Institutional color scaling for Market Analytics.
 * Additive-only: no changes to calculations. Subtle, professional, consistent.
 * Light background shades; dark text remains readable.
 */

export type ScoreColorType = "structural" | "earnings" | "vulnerability"

/** Light background colors for table cells. Higher structural/vulnerability = redder. Higher earnings = greener. */
const STRUCTURAL_BG = {
  "0-30": "bg-slate-100",
  "30-50": "bg-amber-50",
  "50-70": "bg-orange-100",
  "70-85": "bg-red-100",
  "85-100": "bg-red-200",
} as const

const EARNINGS_BG = {
  "0-30": "bg-red-100",
  "30-50": "bg-amber-100",
  "50-70": "bg-slate-100",
  "70-85": "bg-emerald-100",
  "85-100": "bg-emerald-200",
} as const

/** Vulnerability: same scale as structural but slightly stronger red emphasis */
const VULNERABILITY_BG = {
  "0-30": "bg-slate-100",
  "30-50": "bg-amber-100",
  "50-70": "bg-orange-200",
  "70-85": "bg-red-200",
  "85-100": "bg-red-300",
} as const

/** CRE/Capital ratio thresholds: ratio as decimal (1.0 = 100%) */
const CRE_CAPITAL_BG = {
  neutral: "bg-transparent",
  "100-200": "bg-amber-50",
  "200-300": "bg-orange-100",
  "300-400": "bg-red-100",
  "400+": "bg-red-200",
} as const

function getScoreBand(score: number): keyof typeof STRUCTURAL_BG {
  if (score < 30) return "0-30"
  if (score < 50) return "30-50"
  if (score < 70) return "50-70"
  if (score < 85) return "70-85"
  return "85-100"
}

/**
 * Returns Tailwind background class for score-based table cells.
 * @param score 0–100
 * @param type structural (higher=redder), earnings (higher=greener), vulnerability (higher=redder, stronger)
 */
export function getScoreColor(
  score: number,
  type: ScoreColorType
): string {
  if (!Number.isFinite(score)) return ""
  const band = getScoreBand(Math.max(0, Math.min(100, score)))
  switch (type) {
    case "structural":
      return STRUCTURAL_BG[band]
    case "earnings":
      return EARNINGS_BG[band]
    case "vulnerability":
      return VULNERABILITY_BG[band]
    default:
      return ""
  }
}

/**
 * Returns Tailwind background class for CRE/Capital ratio.
 * @param ratio CRE/(T1+T2) as decimal (e.g. 2.5 = 250%)
 */
export function getCreCapitalColor(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 1) return CRE_CAPITAL_BG.neutral
  if (ratio < 2) return CRE_CAPITAL_BG["100-200"]
  if (ratio < 3) return CRE_CAPITAL_BG["200-300"]
  if (ratio < 4) return CRE_CAPITAL_BG["300-400"]
  return CRE_CAPITAL_BG["400+"]
}

/** Hex fill colors for chart bubbles (Composite Vulnerability). Light to deep red. */
const VULNERABILITY_FILL: Record<keyof typeof STRUCTURAL_BG, string> = {
  "0-30": "#e2e8f0",
  "30-50": "#fcd34d",
  "50-70": "#fb923c",
  "70-85": "#f87171",
  "85-100": "#dc2626",
}

/**
 * Returns hex fill color for scatter chart bubbles by Composite Vulnerability Score.
 */
export function getVulnerabilityFillHex(score: number): string {
  if (!Number.isFinite(score)) return VULNERABILITY_FILL["0-30"]
  const band = getScoreBand(Math.max(0, Math.min(100, score)))
  return VULNERABILITY_FILL[band]
}
