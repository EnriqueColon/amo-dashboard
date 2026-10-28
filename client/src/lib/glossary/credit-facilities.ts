import type { MetricDef } from '@/components/DefTerm'

/**
 * Column-header definitions for the Lending Relationships page
 * (client/src/pages/CreditFacilities.tsx). Keys are namespaced
 * "credit-facilities:<Label>".
 *
 * Covers the relationship table (one row per lender ↔ borrower, or per
 * confirmed corporate family), the filing-history table that opens under a
 * row, and the Top Lenders leaderboard. Wording follows
 * docs/CONFLUENCE_AMO_DASHBOARD.md "Lending Relationships" and the comments in
 * server/lending/facilities.ts and the /api/credit-facility-events routes.
 */
export const GLOSSARY: Record<string, MetricDef> = {
  // ── Relationship table ────────────────────────────────────────────────────
  'credit-facilities:Lender': {
    definition:
      'The institution extending the credit facility: the bank or fund whose warehouse line, revolving facility or syndicated agreement the recorded document cites.',
    howCalculated:
      'Read from the document text by the extraction pipeline as the facility\'s named lender. This is not necessarily the recorded assignor or assignee. Capitalisation and known name variants of the same institution are merged, so one bank appears once no matter how its name was typed on each filing.',
    whyValuable:
      'Tells you who is funding whom. Lenders that recur across many borrowers are the active warehouse providers in the market, and the lender\'s name is the first thing to check when sizing a counterparty\'s exposure.',
  },
  'credit-facilities:Borrower': {
    definition:
      'The company drawing on the facility: the originator or investor pledging loans into the line. When several affiliated companies share one parent, the row shows the parent\'s name with an entity count and opens to list each member.',
    howCalculated:
      'Extracted from the document text as the facility\'s borrower. Borrowers confirmed to belong to the same corporate family are grouped under the parent name; open the group to see each affiliate\'s own facility.',
    whyValuable:
      'The borrower is the party under pressure if the line is pulled. Seeing the whole family together shows the true scale of one sponsor\'s dependence on a single lender, which a list of near-identical affiliate rows would hide.',
  },
  'credit-facilities:Type': {
    definition:
      'Which kind of facility the document describes. Warehouse / Revolving is an institutional line that loans are pledged into and released from. Syndicated Credit is a credit agreement with an agent bank and several lenders. Consumer / Business LOC is a line of credit to an individual or small business, mostly HELOCs.',
    howCalculated:
      'A fixed rule applied to the document\'s own wording: the pipeline looks for the terms that define each facility type. It is a deterministic rule, not a model\'s judgement. "Mixed" on a family row means the affiliates hold facilities of different types.',
    whyValuable:
      'Institutional lines are the funding story. Consumer lines use similar "revolving credit" language, so they are detected too but kept in their own bucket so they do not inflate the institutional picture.',
  },
  'credit-facilities:Credit Limit': {
    definition:
      'The facility\'s stated size: the committed maximum the lender has agreed to advance, as written in the document. Shown in compact form; hover the value for the exact figure.',
    howCalculated:
      'Taken from the dollar figure the document states for the facility. Every filing restates the same limit, so a facility is counted once no matter how many filings cite it. Family rows show a dash on purpose: each affiliate holds its own facility, and adding their limits together would double-count.',
    whyValuable:
      'This is committed capacity, not money drawn. Actual draw amounts never appear in the public record. The limit still sizes the relationship: a $200M warehouse line and a $2M line are very different exposures.',
  },
  'credit-facilities:Filings': {
    definition: 'How many recorded documents cite this facility.',
    howCalculated:
      'A count of every document in the county records whose text references this lender-borrower facility, within the current filters. On a family row it is the total across all member companies.',
    whyValuable:
      'Filing count is the best public proxy for how actively a line is used. Loans move in and out of a warehouse line as pledges and releases, and each movement is recorded.',
  },
  'credit-facilities:Activity': {
    definition:
      'The span from the first to the most recent filing for this relationship, shown by month. An "Active" badge means at least one filing was recorded in the last 90 days.',
    howCalculated:
      'The earliest and latest recording dates among the facility\'s filings. "Active" is set when the latest filing is less than 90 days old, counted from today.',
    whyValuable:
      'Separates live lines being drawn on today from archived relationships. A long span with recent activity is an established, ongoing funding source; a line that has gone quiet may have been repaid, refinanced or pulled.',
  },

  // ── Filing history (opens under a relationship row) ──────────────────────
  'credit-facilities:Recorded': {
    definition: 'The date the county clerk recorded the document.',
    howCalculated: 'The recording date from the county index, newest first.',
    whyValuable:
      'Puts each pledge or release on a timeline. Clusters of filings often follow a draw on the line, a sale of loans out of it, or an amendment to the facility.',
  },
  'credit-facilities:CFN': {
    definition:
      'The clerk\'s file number: the county\'s unique identifier for the recorded document. Miami-Dade numbers look like 2026R521735; Broward and Hillsborough use digit-only instrument numbers.',
    howCalculated:
      'Taken directly from the county index. Click it to open the document on the county Clerk portal. The CFN filter above the table matches any part of the number, upper or lower case.',
    whyValuable:
      'The reference to quote when pulling the document, discussing a specific filing with counsel, or checking that the tool holds the same record the county lists.',
  },
  'credit-facilities:Document': {
    definition:
      'The county\'s document type for the filing, for example "ASSIGNMENT - ASG" or an assignment of loan interest.',
    howCalculated: 'The document type code as recorded by the county, shown as the county wrote it.',
    whyValuable:
      'Shows which instrument carried the pledge or release. A plain assignment versus a collateral assignment or loan-interest assignment tells you how the lender takes its security.',
  },
  'credit-facilities:Direction': {
    definition:
      'Whether the filing moves collateral into the facility (Pledge: borrower to lender) or out of it (Release: lender to borrower). A dash means the recorded parties did not cleanly match the facility\'s lender and borrower.',
    howCalculated:
      'Computed by the pipeline by matching the document\'s assignor and assignee against the facility\'s named lender and borrower. The page shows what the pipeline recorded; there is no second calculation in the browser.',
    whyValuable:
      'Pledges show a line being drawn on; releases show loans being sold out of it or repaid. A run of releases with no new pledges can mean a line winding down.',
  },
  'credit-facilities:Assignor → Assignee': {
    definition:
      'The two parties on the recorded document: who gave up the interest and who received it. A "3rd party" chip marks a party that is neither the facility\'s lender nor its borrower.',
    howCalculated:
      'The grantor and grantee names from the county index. A filing belongs to a facility because its own text cites the facility agreement, not because of the party names, so a third party is usually an affiliate co-borrower pledging into the line or the prior holder of a loan being warehoused.',
    whyValuable:
      'Shows the actual legal parties to the transfer, and surfaces affiliates and prior holders that the lender-borrower pair alone would hide. Open the evidence quote or the county document to confirm a third party\'s role.',
  },
  'credit-facilities:Property': {
    definition: 'The address of the real estate securing the mortgage that was pledged or released in this filing.',
    howCalculated:
      'Read from the document by the extraction pipeline. Blank when the document is a blanket collateral assignment with no single property, or when the address was not captured.',
    whyValuable:
      'Ties the facility to specific collateral. Useful for spotting concentration in one project or neighbourhood, and for cross-checking the same loan on the Reporting page.',
  },
  'credit-facilities:Mortgage': {
    definition: 'The principal of the underlying mortgage pledged into or released from the facility in this filing.',
    howCalculated:
      'The loan amount the extraction pipeline read from the document. When a document states only the facility\'s credit limit, that figure is withheld here so the limit does not pose as a per-filing mortgage. A dotted underline means the amount was recovered from the evidence quote in the document text rather than the structured extraction; verify against the county document if precision matters.',
    whyValuable:
      'The closest public proxy for how much is moving through the line per transaction, since actual draw amounts are never recorded.',
  },

  // ── Top Lenders leaderboard ──────────────────────────────────────────────
  'credit-facilities:Top Lenders': {
    definition: 'The institutions that appear most often as the facility lender, ranked by number of filings.',
    howCalculated:
      'Count of filings per lender after merging capitalisation and name variants of the same institution. Click a lender to filter the table to that lender; click it again to clear.',
    whyValuable:
      'A quick read on which banks and funds dominate warehouse and revolving lending in the county, and the quickest way to pull up one lender\'s whole book.',
  },
}
