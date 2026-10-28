// Type-only bridge to the ported Legal server modules; erased at build time.
export type { LegalItem, LegalUpdatesResponse } from "../../../../server/intel/legal/fetch-legal-updates"
export type {
  ResolvedApplicability,
  ApplicabilityRequest,
  ResolveApplicabilityResult,
} from "../../../../server/intel/legal/resolve-legal-applicability"
export type { LegalSection } from "@shared/legal/legal-updates-sections"
