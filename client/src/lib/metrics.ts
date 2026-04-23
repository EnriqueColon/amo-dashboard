export function normalizePercentToDecimal(rawValue: number | null | undefined): number | null {
  if (rawValue === null || rawValue === undefined || !Number.isFinite(rawValue)) return null
  return rawValue / 100
}

export function normalizePercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value > 100) return value / 100
  if (value > 0 && value <= 1) return value * 100
  return value
}

export function formatPercent(valuePercentUnits: number | null | undefined, decimals = 2): string {
  if (valuePercentUnits === null || valuePercentUnits === undefined || !Number.isFinite(valuePercentUnits))
    return "—"
  return valuePercentUnits.toFixed(decimals) + "%"
}

export function formatDecimalAsPercent(decimal: number | null | undefined, decimals = 2): string {
  if (decimal === null || decimal === undefined || !Number.isFinite(decimal)) return "—"
  return (decimal * 100).toFixed(decimals) + "%"
}

export function formatDeltaPercentPoints(deltaPercentUnits: number | null | undefined, decimals = 2): string {
  if (deltaPercentUnits === null || deltaPercentUnits === undefined || !Number.isFinite(deltaPercentUnits))
    return "—"
  const sign = deltaPercentUnits >= 0 ? "+" : ""
  return sign + deltaPercentUnits.toFixed(decimals) + "%"
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  if (abs >= 1e9) return "$" + (value / 1e9).toFixed(1) + "B"
  if (abs >= 1e6) return "$" + (value / 1e6).toFixed(1) + "M"
  if (abs >= 1e3) return "$" + (value / 1e3).toFixed(1) + "K"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

export function formatMultiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return value.toFixed(2) + "x"
}

export function formatCapitalMultiple(value: number | null | undefined): string {
  return formatMultiple(value)
}
