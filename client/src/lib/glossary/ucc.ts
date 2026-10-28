import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the ucc page. Keys are namespaced "ucc:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  // ── Filings table ──────────────────────────────────────────────────────────
  'ucc:CFN': {
    definition: 'Clerk\'s File Number — the county clerk\'s file number of the recorded UCC financing statement. One CFN is one recorded filing.',
    howCalculated: 'Taken straight from the county\'s official-records index when the filing is collected.',
    whyValuable: 'The reference to quote and the link to the document: click it to open the recorded image on the county portal. The search box above matches on it, so a CFN from elsewhere can be pulled up directly.',
  },
  'ucc:Date': {
    definition: 'The date the county clerk recorded the financing statement.',
    howCalculated: 'The recording date from the county index. Newest first; the date filters above apply to this field.',
    whyValuable: 'A UCC filing is usually recorded at or just after closing, so this is close to when the loan was made — unlike an assignment, which can be recorded long after the sale.',
  },
  'ucc:Borrower': {
    definition: 'The debtor — the party pledging collateral to secure a debt. On a UCC filing this is the borrower, the opposite of the Reporting tab where the first party is the seller of a loan.',
    howCalculated: 'Taken from the document itself when the extraction pipeline has read it; otherwise from the county index, whose party order is unreliable (the lender is listed first on about a third of filings). Names are shown exactly as filed and are not merged into canonical entities, because borrowers here are mostly single-property LLCs named after street numbers.',
    whyValuable: 'Identifies the property owner or operating company that took on the debt — the entity that will be in trouble if the loan goes bad.',
  },
  'ucc:Lender': {
    definition: 'The secured party — the lender recording a security interest against the borrower\'s collateral. An amber warning icon before the name means the direction was taken from the county index and may be reversed.',
    howCalculated: 'Taken from the document itself where the pipeline has read it (the confirmed rows, about 90%); otherwise from the county index. The "Roles from document" filter narrows to the confirmed ones. Names are exactly as filed, not merged.',
    whyValuable: 'Shows who is lending against which assets — the active secured lenders in the county, and the ones a distressed borrower\'s debt would have to be bought from.',
  },
  'ucc:Property': {
    definition: 'The street address of the real estate the filing is tied to, when the document states one.',
    howCalculated: 'Read from the document image by the extraction pipeline. "none stated" means the document was read and names no property; "not read yet" means the image has not been read, so the field is unknown rather than empty.',
    whyValuable: 'This is what makes the page useful — 84% of filings carry an address, which ties a named lender to a specific property.',
  },
  'ucc:Collateral': {
    definition: 'What kind of collateral the filing records: collateral (general security interest in assets or fixtures), rents & leases (an assignment of the property\'s income), or other.',
    howCalculated: 'The category the extraction pipeline assigned when it read the document. Blank means the document has not been read yet. The "Collateral type" filter above uses this field.',
    whyValuable: 'A rents-and-leases filing means the lender has a claim on the property\'s cash flow, which is a stronger real-estate signal than a general asset pledge.',
  },
  'ucc:Amount': {
    definition: 'The dollar amount stated on the filing, when there is one.',
    howCalculated: 'Read from the document image. Only about 7% of filings carry an amount — a UCC form describes what secures a debt, not its size — so a blank is normal, not a gap.',
    whyValuable: 'Where present it sizes the debt; where absent, do not read anything into it.',
  },

  // ── Summary tiles ──────────────────────────────────────────────────────────
  'ucc:Filings': {
    definition: 'How many UCC financing statements match the current filters.',
    howCalculated: 'A count of filings after the date, search, collateral-type, property and consumer-finance filters are applied. With no filters it covers 2023 to the present. Consumer solar and home-improvement lenders are hidden unless toggled on.',
    whyValuable: 'The denominator for the other tiles, and a quick read on how much secured lending activity the filters capture.',
  },
  'ucc:Distinct lenders': {
    definition: 'How many different lenders appear in the filtered filings. The note underneath says what share of filings had their roles read off the document itself.',
    howCalculated: 'Distinct lender names after case and punctuation are ignored and trailing legal boilerplate ("a Florida limited liability company") is removed. Leading numbers and corporate suffixes are kept, so unrelated firms with similar names stay separate. The percentage is confirmed-role filings divided by all filings.',
    whyValuable: 'Shows how concentrated the lending is — a few lenders across many filings versus a long tail — and how much of the borrower/lender direction you can trust.',
  },
  'ucc:With a property': {
    definition: 'How many of the filtered filings state a property address.',
    howCalculated: 'Count of filings whose extracted property address is not blank, with the share of all filings shown underneath.',
    whyValuable: 'These are the filings that can be tied to a specific piece of real estate, which is the point of the page.',
  },
  'ucc:With an amount': {
    definition: 'How many of the filtered filings state a dollar amount.',
    howCalculated: 'Count of filings whose extracted amount is greater than zero, with the share of all filings shown underneath.',
    whyValuable: 'Sets expectations before you read the Amount column: a UCC form states collateral, not debt size, so only a small minority carry a figure.',
  },
}
