import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the clean events page. Keys are namespaced "clean-events:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'clean-events:CFN': {
    definition:
      "The county clerk's file number for the recorded document — the clerk's own unique ID for this filing. Miami-Dade numbers look like 2026R521735; Broward and Hillsborough numbers are all digits. Click it to open the original document on the county portal.",
    howCalculated:
      "Copied from the county index unchanged. This view is deduplicated, so each CFN appears once even when the county recorded both sides of the transfer as separate index entries.",
    whyValuable:
      "It is the one reference the county, the title company and this dashboard all agree on. Use it to pull the original document, to match a row to the Raw Assignments page, or to confirm a filing someone quotes.",
  },
  'clean-events:Date': {
    definition:
      "The recording date — the day the county clerk officially stamped the assignment into the public record. Usually a few days after the parties signed it.",
    howCalculated:
      "Copied from the county index (the rec_date field on the cleaned transactions table). It is the clerk's date, not the signing date printed inside the document.",
    whyValuable:
      "Recording date is when the transfer became public, so it is the date to use for timelines, weekly activity and 'what moved recently' questions.",
  },
  'clean-events:County': {
    definition:
      "Which county's Official Records the document was recorded in: Miami-Dade, Broward or Hillsborough.",
    howCalculated:
      "Set by the collector that pulled the record; Miami-Dade rows from before other counties were added default to Miami-Dade.",
    whyValuable:
      "Matters most under the All Counties scope, where every county's numbers sit side by side. The counties are not equally deep: Broward's pre-Aug-2026 history is index-only, and Hillsborough's documents are still being read, so a thin count there is a coverage gap, not a quiet market.",
  },
  'clean-events:Assignor (Seller)': {
    definition:
      "The party giving up the mortgage — the seller or transferor. Typically the current servicer or note holder handing over its interest in the loan.",
    howCalculated:
      "The bold name is the canonical name: the dashboard's cleaned spelling after it strips suffixes like LLC and N.A., corrects typos and merges brand aliases (for example Quicken Loans and Rocket Mortgage). The smaller grey line beneath it, when shown, is the name exactly as the county clerk recorded it. An amber line marks a related or parent entity the extraction pipeline found named in the document text. The badge is the dashboard's entity type (bank, servicer, private credit, GSE, MERS, other).",
    whyValuable:
      "Tells you who is exiting a position. Because names are merged, every filing by the same institution lines up under one name, so a repeat seller stands out instead of hiding behind spelling variants.",
  },
  'clean-events:Assignee (Buyer)': {
    definition:
      "The party receiving the mortgage — the buyer or transferee. This entity now holds the right to collect payments or to foreclose. Private credit funds often appear here as acquirers of distressed or non-performing loans.",
    howCalculated:
      "The bold name is the canonical name after the dashboard merges spelling variants, strips suffixes and unifies brand aliases. The smaller grey line beneath it, when shown, is the name as the county clerk recorded it. An amber line marks a related or parent entity named in the document text. The badge is the dashboard's entity type.",
    whyValuable:
      "The assignee is the acquirer. Watching who repeatedly shows up on this side reveals which banks, servicers and funds are actively buying mortgage debt in the market right now.",
  },
  'clean-events:Type': {
    definition:
      "The dashboard's classification of what kind of transfer this is: Market Transfer (institution to institution — a true secondary-market trade), Origination (individual or private party to institution — new supply entering), MERS Release (the MERS registry stepping aside, housekeeping only), Self-Assign (the same entity on both sides — a rename or merger, not a sale), Inst. Out (institution to individual — a payoff, REO or distressed sale), or Private (individual to individual).",
    howCalculated:
      "Derived by the normalisation step from the entity types of the canonical assignor and assignee: for example two institutional parties become Market Transfer, and matching canonical names on both sides become Self-Assign. It is the dashboard's label, not something written on the document.",
    whyValuable:
      "Lets you separate real economic transfers from paperwork. Filter to Market Transfer to see actual loan sales; Self-Assign and MERS Release are noise for most analysis.",
  },
  'clean-events:Property': {
    definition:
      "The street address of the property securing the mortgage being assigned, when the document states one.",
    howCalculated:
      "Read from the text of the recorded document by the extraction pipeline; if the document gives none, it falls back to the address in the county index. Blank when the document only gives a legal description, which is common for assignments.",
    whyValuable:
      "Ties a transfer to a specific property or neighbourhood, and lets you spot several loans sharing collateral or a sponsor.",
  },
  'clean-events:Amount': {
    definition:
      "A dollar figure from the recorded document: the original loan or mortgage amount when it is stated, otherwise the actual consideration paid for the assignment. Blank when the document gives neither.",
    howCalculated:
      "Read from the document text by the extraction pipeline. The brighter green figure is the loan amount; the dimmer one is consideration paid, shown only when no loan amount was found. Nominal recitals such as '$10 and other good and valuable consideration' are ignored rather than shown as $10.",
    whyValuable:
      "Gives a sense of the size of the loan changing hands, so you can rank transfers and distinguish a single large commercial note from a run of small residential ones.",
  },
  'clean-events:Parties': {
    definition:
      "How many parties were named on the original county filing. Most assignments have two (one seller, one buyer).",
    howCalculated:
      "Counted from the raw index entries that share this CFN before the dashboard collapsed them to one row. A value above two is highlighted in amber.",
    whyValuable:
      "Three or more parties signals a co-assignment or a structured deal; this view keeps only the dominant seller-to-buyer direction, so a high count is a cue to open the original document for the full picture.",
  },
  'clean-events:Book / Page': {
    definition:
      "The Official Records book and page where the recorded document physically sits in the county's ledger — the clerk's older locator that predates CFNs.",
    howCalculated:
      "Copied from the county index (the rec_book and rec_page fields) and shown as book/page.",
    whyValuable:
      "Title searches, legal descriptions and older filings often cite book and page instead of a CFN, so this is the number you need to cross-reference with a title report or a lawyer's notes.",
  },
}
