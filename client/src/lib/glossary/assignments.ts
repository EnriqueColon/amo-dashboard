import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the assignments page. Keys are namespaced "assignments:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'assignments:CFN': {
    definition:
      "The county clerk's file number for the recorded document — the clerk's own unique ID for this filing. Miami-Dade numbers look like 2026R521735; Broward and Hillsborough numbers are all digits.",
    howCalculated:
      "Copied exactly from the county's Official Records index (the cfn field on the raw assignments table). Nothing is changed or reformatted.",
    whyValuable:
      "It is the one reference the county, the title company and this dashboard all agree on. Use it to pull the original document from the county portal, to match a row across the Raw and Clean views, or to confirm a filing exists when someone quotes a number.",
  },
  'assignments:Date': {
    definition:
      "The recording date — the day the county clerk officially stamped the document into the public record. It is usually a few days after the date the parties signed it.",
    howCalculated:
      "Copied from the county index (the rec_date field). It is the clerk's date, not the signing date printed inside the document.",
    whyValuable:
      "Recording date is when the transfer became public and enforceable against third parties, so it is the date to use for timelines, trend charts and 'what moved last week' questions.",
  },
  'assignments:County': {
    definition:
      "Which county's Official Records the document was recorded in: Miami-Dade, Broward or Hillsborough.",
    howCalculated:
      "Set by the collector that pulled the record; older Miami-Dade rows recorded before other counties were added default to Miami-Dade.",
    whyValuable:
      "Matters most under the All Counties scope, where every county's numbers sit side by side. The counties are not equally deep: Broward's pre-Aug-2026 history is index-only, and Hillsborough's documents are still being read, so a thin count there is a coverage gap, not a quiet market.",
  },
  'assignments:Grantor (Assignor)': {
    definition:
      "The party giving up the mortgage — the seller or transferor. This entity is handing over its right to collect on or enforce the loan. Typically a bank, servicer or fund offloading a loan from its book.",
    howCalculated:
      "The grantor name exactly as the county clerk indexed it, spelling variants and all (the grantor field on the raw assignments table). The small category badge beneath it is the dashboard's classification (bank, servicer, private credit, and so on), looked up from the cleaned transactions table by CFN.",
    whyValuable:
      "Tells you who is exiting a position. A grantor that keeps appearing is actively selling or restructuring, which is the earliest public sign of a portfolio disposition.",
  },
  'assignments:Grantee (Assignee)': {
    definition:
      "The party receiving the mortgage — the buyer or transferee. This entity now holds the right to collect payments or to foreclose.",
    howCalculated:
      "The grantee name exactly as the county clerk indexed it (the grantee field on the raw assignments table). The category badge beneath it comes from the cleaned transactions table by CFN.",
    whyValuable:
      "The grantee is the acquirer. Watching who repeatedly shows up on this side reveals which institutions and funds are buying performing or distressed debt in the market right now.",
  },
  'assignments:Address': {
    definition:
      "The street address of the property securing the mortgage being assigned, when the county captured one.",
    howCalculated:
      "Copied from the county index (the address field). Many assignments only reference a legal description, so this is often blank; the Clean Transactions page shows a richer address read from the document itself.",
    whyValuable:
      "Lets you tie a transfer to a specific property or neighbourhood, and to group several loans that share collateral or a sponsor.",
  },
  'assignments:Book / Page': {
    definition:
      "The Official Records book and page where the recorded document physically sits in the county's ledger — the clerk's older locator that predates CFNs.",
    howCalculated:
      "Copied from the county index (the rec_book and rec_page fields) and shown as book/page.",
    whyValuable:
      "Title searches, legal descriptions and older filings often cite book and page instead of a CFN, so this is the number you need to cross-reference with a title report or a lawyer's notes.",
  },
}
