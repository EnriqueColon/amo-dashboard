import type { MetricDef } from '@/components/DefTerm'

/**
 * Column-header definitions for the Private Credit page
 * (client/src/pages/PrivateCredit.tsx). Keys are namespaced
 * "private-credit:<Label>".
 *
 * The page lists every assignment with a PRIVATE_CREDIT entity (a non-bank
 * private lender) on either side, self-assignments excluded, plus the Top
 * Private Credit Acquirers leaderboard. Wording follows
 * docs/CONFLUENCE_AMO_DASHBOARD.md ("Private Credit", "Entity types",
 * "Transaction types") and the /api/private-credit statements in server/routes.ts.
 */
export const GLOSSARY: Record<string, MetricDef> = {
  // ── Transactions table ───────────────────────────────────────────────────
  'private-credit:CFN': {
    definition:
      'The clerk\'s file number: the county\'s unique identifier for the recorded assignment. Miami-Dade numbers look like 2026R521735; Broward and Hillsborough use digit-only instrument numbers.',
    howCalculated:
      'Taken directly from the county index. The link icon at the end of the row opens the document on the county Clerk portal. The CFN filter above the table matches any part of the number, upper or lower case.',
    whyValuable:
      'The reference to quote when pulling the document, discussing a specific transfer with counsel, or checking that the tool holds the same record the county lists.',
  },
  'private-credit:Date': {
    definition: 'The date the county clerk recorded the assignment.',
    howCalculated: 'The recording date from the county index, newest first.',
    whyValuable:
      'Places the transfer on a timeline. The recording date can lag the actual sale by days or weeks, and Broward publishes several business days late, so a quiet recent window is often the county, not the market.',
  },
  'private-credit:County': {
    definition: 'Which county\'s Official Records the document was recorded in.',
    howCalculated:
      'The county the document was collected from. Matters most under the All Counties scope, where every county\'s document numbers sit side by side.',
    whyValuable:
      'The counties are not equally deep: Broward\'s pre-Aug-2026 history is index-only, and Hillsborough\'s documents are still being read. Knowing the county tells you how complete the row\'s detail can be.',
  },
  'private-credit:Grantor (Seller)': {
    definition:
      'The party assigning the mortgage away: the seller of the loan. The bold name is the canonical company name; the smaller line below is the name exactly as recorded, shown when it differs; the badge is the entity type.',
    howCalculated:
      'The assignor from the county index, resolved to one canonical entity by name matching and any approved duplicate merges. The entity type comes from the classification cascade (manual override, FDIC match, legal-suffix signal, behaviour, rules, then model). Where the county index listed the parties backwards, the document\'s own text decides who is the seller.',
    whyValuable:
      'Who is exiting the loan. A bank or servicer selling to a private lender is the clearest sign of paper moving out of the regulated system; a private lender selling is a position being unwound.',
  },
  'private-credit:Grantee (Buyer)': {
    definition:
      'The party receiving the mortgage: the buyer of the loan. The bold name is the canonical company name; the smaller line below is the name exactly as recorded, shown when it differs; the badge is the entity type.',
    howCalculated:
      'The assignee from the county index, resolved to one canonical entity by name matching and any approved duplicate merges. The entity type comes from the same classification cascade as the grantor. Where the county index listed the parties backwards, the document\'s own text decides who is the buyer.',
    whyValuable:
      'Who now holds the loan. When the grantee is a private credit entity, this is non-bank capital entering the market, which is the signal this page exists to show.',
  },
  'private-credit:Type': {
    definition:
      'What kind of transfer this is. Market Transfer: institution to institution, the real signal that debt changed hands. Origination: paper entering institutional hands. Inst. Out: paper leaving them. MERS Release: the registry handing over or taking the nominee interest it holds, record-keeping rather than a trade. Private: neither side is an institution.',
    howCalculated:
      'Derived from the entity types of the two parties when the clean event table is built. Self-assignments, where both sides resolve to the same company, are excluded from this page entirely.',
    whyValuable:
      'Tells you whether the row is debt actually changing hands or administrative housekeeping, so a burst of MERS releases is not mistaken for a wave of private credit buying.',
  },
  'private-credit:PE Role': {
    definition:
      'Which side of the transfer the private credit entity is on. Acquiring: the private lender is the grantee, buying the loan. Selling: the private lender is the grantor. PE ↔ PE: both sides are private credit entities.',
    howCalculated:
      'From the entity types of the two parties: a PRIVATE_CREDIT grantee gives Acquiring, a PRIVATE_CREDIT grantor alone gives Selling, and both together give PE ↔ PE.',
    whyValuable:
      'Acquiring rows are non-bank capital entering the market. Selling rows are private lenders exiting positions, which can precede distress, a fund wind-down or a portfolio sale, and are the rows a distressed-debt desk watches most closely.',
  },

  // ── Top Private Credit Acquirers leaderboard ─────────────────────────────
  'private-credit:Top Private Credit Acquirers': {
    definition: 'The ten private credit entities that have received the most mortgage assignments.',
    howCalculated:
      'A count of assignments where the grantee is a PRIVATE_CREDIT entity, grouped by canonical company name, with self-assignments excluded. Scoped to the county currently selected.',
    whyValuable:
      'The fastest read on which non-bank lenders are buying the most paper in the county, and therefore which ones are building the books that may later come to market.',
  },
}
