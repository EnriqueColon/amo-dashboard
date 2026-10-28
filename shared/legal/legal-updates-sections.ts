/**
 * Per-section configuration for the Legal Landscape tab.
 *
 * Lowest level of the `legal-updates-*` modules: the type lives here so that prompts, sources and
 * the filter can all depend on it without depending on each other.
 */

export type LegalSection = "regulatory" | "legislative" | "enforcement"

export const LEGAL_SECTIONS: readonly LegalSection[] = ["regulatory", "legislative", "enforcement"]

export const SECTION_LABELS: Record<LegalSection, string> = {
  regulatory: "Regulatory Watch",
  legislative: "Legislative Tracker",
  enforcement: "Enforcement & Litigation",
}

export type SectionWindow = {
  /** What the prompt asks the model for. */
  promptDays: number
  /** What the feed will still display. Wider, because the model dates items imprecisely. */
  filterDays: number
}

/**
 * Legislatures do not run all year, and a single 90-day window across all three sections is what
 * left the Legislative Tracker blank. Florida's regular session sits roughly January to March, so
 * for most of the year the most recent real bill activity is months old — and Florida session laws
 * conventionally take effect on 1 July, which is why genuine items cluster on that date rather
 * than only fabricated ones.
 *
 * Regulators and courts act continuously, so those two keep the tighter window.
 */
export const SECTION_WINDOWS: Record<LegalSection, SectionWindow> = {
  regulatory: { promptDays: 90, filterDays: 180 },
  legislative: { promptDays: 270, filterDays: 400 },
  enforcement: { promptDays: 90, filterDays: 180 },
}

export function windowFor(section: LegalSection): SectionWindow {
  return SECTION_WINDOWS[section]
}
