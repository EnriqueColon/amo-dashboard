/**
 * One visual language for every chart in the tool.
 *
 * The series colours mirror the --chart-1 through --chart-5 tokens in
 * app/globals.css. They are repeated here as literals because Recharts writes
 * SVG fills directly and cannot resolve CSS variables during the headless
 * Playwright pass that renders the PDF.
 */

export const CHART_SERIES = ["hsl(var(--primary))", "#0088b3", "#005a7a", "#00a3cc", "#004d6b"] as const

/**
 * Series that have to be told apart.
 *
 * `CHART_SERIES` is five steps of one blue, which suits a trend panel where
 * one line leads and the rest are context — but a reader cannot tell the
 * steps apart (adjacent pairs differ by ΔE 8.5, under the 15 a full-colour
 * reader needs), so a chart whose whole point is *which* line is which cannot
 * use it. This set keeps the brand blue first and adds three hues at the same
 * lightness, checked on 2026-10-22 against the lightness band, chroma floor,
 * colour-vision-deficiency separation (worst pair ΔE 17.7 protan, 21.4
 * tritan), normal-vision separation (25.4) and 3:1 contrast on white.
 *
 * Four, deliberately: a fifth distinguishable hue is not available at this
 * lightness, and a chart that needs more than four identities needs small
 * multiples instead.
 */
export const CATEGORICAL_SERIES = ["hsl(var(--primary))", "#b45309", "#7c3aed", "#be185d"] as const

export const CHART_INK = {
  /** Axis numbers and units */
  axis: "#64748b",
  /** The axis rule itself */
  axisLine: "#cbd5e1",
  grid: "#e2e8f0",
  /** Category names, which need more weight than axis numbers */
  label: "#334155",
  /** Median lines and other annotations */
  reference: "#94a3b8",
} as const

export const CHART_TYPE = {
  tick: 10,
  value: 9,
} as const

/** Numeric axes align digit-for-digit so bars can be compared by eye. */
export const numericTick = {
  fontSize: CHART_TYPE.tick,
  fill: CHART_INK.axis,
  fontVariantNumeric: "tabular-nums",
} as const

export const categoryTick = {
  fontSize: CHART_TYPE.tick,
  fill: CHART_INK.label,
  fontWeight: 500,
} as const

export const gridProps = {
  strokeDasharray: "3 3",
  stroke: CHART_INK.grid,
} as const

export const axisLineProps = { stroke: CHART_INK.axisLine } as const

/** Shortens an institution name to fit a category axis without wrapping. */
export function truncateLabel(name: string, max = 24): string {
  const value = String(name)
  return value.length > max ? `${value.slice(0, max - 2)}…` : value
}

/**
 * A category tick that never wraps.
 *
 * Recharts' default tick breaks a long label across lines to fit the axis
 * width. On a twenty-row ranking the second line runs into the row below and
 * the names become unreadable, so this renders one line and lets `format`
 * decide how much of the name survives.
 */
export function singleLineTick(format: (value: string, index: number) => string) {
  return function CategoryTick({ x, y, payload, index }: any) {
    return (
      <text
        x={x}
        y={y}
        dy={3}
        textAnchor="end"
        fontSize={CHART_TYPE.tick}
        fontWeight={500}
        fill={CHART_INK.label}
      >
        {format(String(payload?.value ?? ""), index ?? 0)}
      </text>
    )
  }
}
