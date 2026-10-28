import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the reporting page. Keys are namespaced "reporting:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'reporting:CFN': {
    definition: 'Clerk\'s File Number — the county clerk\'s file number of the recorded assignment document. One CFN is one recorded filing, and it is unique across every county the dashboard covers.',
    howCalculated: 'Taken straight from the county\'s official-records index when the filing is collected. Miami-Dade CFNs contain an "R" (e.g. 2026R626049); Broward and Hillsborough instrument numbers are digits only.',
    whyValuable: 'It is the key you quote to anyone else and the link to the document itself: click it to open the recorded image on the county clerk\'s portal. The search box above matches on it, so a CFN from an email or spreadsheet can be pulled up directly.',
  },
  'reporting:Date': {
    definition: 'The date the county clerk recorded the assignment — not the date the loan was sold or the document was signed.',
    howCalculated: 'The recording date from the county index. The table is sorted newest first, and the date filters above apply to this field.',
    whyValuable: 'Recording can lag the actual sale by weeks, so the date tells you when the transfer became public record. Clusters of recordings on one day from one assignor usually mean a bulk sale.',
  },
  'reporting:County': {
    definition: 'The county whose clerk recorded the filing: Miami-Dade, Broward or Hillsborough.',
    howCalculated: 'Stored with each filing when it is collected from that county\'s feed. Blank county on older rows means Miami-Dade, which was the only county before August 2026.',
    whyValuable: 'Names, document codes and coverage differ by county (Broward\'s "AST" is Miami-Dade\'s "AMO"), and the same company can be active in one county and absent in another. The county switch at the top of the app scopes this table.',
  },
  'reporting:Assignor': {
    definition: 'The party giving up the loan — the seller or transferor of the mortgage. The name shown is the cleaned, merged company name; a smaller amber line underneath, when present, is the parent or sponsor named on the document.',
    howCalculated: 'The assignor as indexed by the county, cleaned by the normalizer so spelling variants (e.g. "U S Bank N A", "US BANK") merge into one entity. The parent line comes from the document text when the extractor could read one. Expand the row to see the name exactly as written on the PDF.',
    whyValuable: 'This is who is selling. A bank or servicer that keeps appearing as assignor is reducing its exposure, which is the pattern a distressed-debt buyer looks for.',
  },
  'reporting:Type': {
    definition: 'The category of the party in the column immediately to its left — the assignor\'s type after the Assignor column, the assignee\'s type after the Assignee column. Values are BANK, SERVICER, PRIVATE_CREDIT, GSE (Fannie Mae / Freddie Mac), TRUST, MERS, or OTHER.',
    howCalculated: 'Assigned by the normalizer from the cleaned name: a list of known institutions and name patterns (e.g. "BANK", "N.A.", "CAPITAL", "TRUST") decides the type. OTHER covers individuals, shell LLCs and anything unrecognised.',
    whyValuable: 'Together the two types say which way the loan moved — bank → private credit is a sale out of the regulated system; OTHER → bank is an origination being booked. They also drive the Class column.',
  },
  'reporting:Assignee': {
    definition: 'The party receiving the loan — the buyer or transferee of the mortgage. Cleaned, merged name; the amber line underneath, when present, is the beneficial owner or parent the document names.',
    howCalculated: 'The assignee as indexed by the county, cleaned the same way as the assignor. The beneficial-owner line comes from the document text when it could be read. Expand the row for the exact wording on the PDF.',
    whyValuable: 'This is who is buying. Repeated assignees reveal who is accumulating loans in the market — competitors, or the counterparties a seller prefers.',
  },
  'reporting:Property': {
    definition: 'The street address of the mortgaged property, as read from the assignment document.',
    howCalculated: 'Extracted from the document image by the reading pipeline (OCR plus a language model). Blank ("—") means the document has not been read yet or no usable address was found; obviously garbled text is hidden rather than shown.',
    whyValuable: 'Ties the transfer to a specific asset, so you can check what secures the loan and whether the same property keeps changing hands.',
  },
  'reporting:Folio': {
    definition: 'The county property-appraiser\'s folio or parcel number for the mortgaged property.',
    howCalculated: 'Read from the document image where the form states it. Blank means it was not read or not printed on the filing.',
    whyValuable: 'The folio is the exact key into the county property-appraiser and tax-collector records, so it beats an address for looking up value, owner and tax status.',
  },
  'reporting:Loan Amt': {
    definition: 'The principal of the underlying mortgage, in dollars, when the document states it.',
    howCalculated: 'The loan amount read from the document; if that is missing but a consideration (price paid) is stated, the consideration is shown instead. Expand the row to see both separately. Blank means neither could be read.',
    whyValuable: 'Sizes the transfer. Dollar volumes elsewhere on this page add each filing\'s loan amount once per filing, attributed to its assignor and assignee. Note this is the mortgage principal, not what the buyer paid.',
  },
  'reporting:Signatory': {
    definition: 'The officer who signed the assignment on behalf of the assignor.',
    howCalculated: 'Read from the signature block of the document image. Blank means it was not read or could not be made out.',
    whyValuable: 'A named officer tells you which desk or servicing arm is executing the sales, and the same signatory across many assignors often means a document-preparation vendor rather than the seller itself.',
  },
  'reporting:Class.': {
    definition: 'What the document is: LoanSale (a loan changing hands between parties), WarehouseRelease (a MERS nominee release, not a true sale), NeedsReview (direction unclear), or a neutral grey Collateral, Rents & leases or Other for filings whose PDF turned out not to record a loan transfer.',
    howCalculated: 'From the two party types: a transfer between or into institutions reads LoanSale, anything touching MERS reads WarehouseRelease, and the rest NeedsReview. Non-loan categories come from reading the document. A classification someone set by hand always overrides the automatic one.',
    whyValuable: 'Separates the transfers worth chasing from registry housekeeping and from assignments of rents or collateral that look like loan sales in the county index but are not.',
  },
  'reporting:✓': {
    definition: 'Review status. A green tick means someone on the team has marked this filing reviewed; a grey clock means it is still pending.',
    howCalculated: 'Click the icon to toggle. The mark is stored on the server with the reviewer and timestamp, so everyone sees the same state. The Review filter above (All / Pending / Reviewed) uses this field.',
    whyValuable: 'A shared checklist: it stops two people working the same filing and lets you filter down to what has not been looked at yet.',
  },
}
