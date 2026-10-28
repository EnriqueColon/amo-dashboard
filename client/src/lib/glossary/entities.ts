import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the entities page. Keys are namespaced "entities:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'entities:Entity (Canonical)': {
    definition: 'The normalized, de-duplicated company name. Raw filing variants such as "BANK OF AMERICA N.A." and "BK OF AMERICA" are merged into one canonical identity.',
    howCalculated: 'The nightly rebuild cleans each party name on the county filings, applies the name-matching rules and every merge approved in the Duplicate Manager, and keeps the name marked "keep this name" for the cluster.',
    whyValuable: 'All volumes, counterparties and target tracking are built on this name. If a firm looks split across two rows, use the Duplicate Manager to merge them.',
  },
  'entities:Type': {
    definition: 'The entity\'s classification: Bank, Private Credit, Securitization Trust, GSE (Fannie Mae, Freddie Mac, Ginnie Mae), Servicer, MERS (the registry) or Other.',
    howCalculated: 'Assigned by the name-based classification cascade in the rebuild, with any manual reclassification made on this page taking precedence.',
    whyValuable: 'Drives the transaction-type labels and the market-flow metrics (for example bank-to-private-credit sales). A wrong type miscounts a whole flow, so fix it here.',
  },
  'entities:Received': {
    definition: 'How many assignments this entity received: the number of county filings on which it appears as the assignee (the party the mortgage was assigned to).',
    howCalculated: 'Count of clean assignment records where this canonical name is the assignee, across all counties.',
    whyValuable: 'A buyer\'s side of the ledger. High and rising inbound volume marks an active acquirer of mortgage debt.',
  },
  'entities:Assigned': {
    definition: 'How many assignments this entity made: the number of filings on which it appears as the assignor (the party transferring the mortgage out).',
    howCalculated: 'Count of clean assignment records where this canonical name is the assignor, across all counties.',
    whyValuable: 'A seller\'s side of the ledger. Outbound well above inbound points to net selling or a portfolio being wound down, which is the behaviour a distressed-debt buyer wants to spot early.',
  },
  'entities:Counterparties': {
    definition: 'How many distinct canonical entities this entity has transacted with, as buyer or seller.',
    howCalculated: 'Distinct assignees it has assigned to, plus distinct assignors it has received from. A firm that sits on both sides of its dealings is counted once per direction.',
    whyValuable: 'A high count signals broad market participation or an intermediary role; a low count with high volume usually means a captive relationship (for example a lender and its own trust).',
  },
  'entities:Active Period': {
    definition: 'The span from the entity\'s first recorded assignment to its most recent one.',
    howCalculated: 'Earliest and latest recording date on any clean assignment naming this entity, in either role.',
    whyValuable: 'Tells you whether a firm is still active in these counties. A last date that is months old for a once-busy name is itself a signal.',
  },
}
