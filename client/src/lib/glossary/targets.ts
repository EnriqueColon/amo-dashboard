import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the targets page. Keys are namespaced "targets:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'targets:Entity': {
    definition: 'The canonical name of the market participant on the watchlist.',
    howCalculated: 'Matched to the canonical entity list by exact name. A name added before it has any recorded filings stays on the list and lights up when activity appears.',
    whyValuable: 'The watchlist drives the Reporting tab\'s "Targets only" view and the Monday activity email, so the name here must match the canonical one exactly.',
  },
  'targets:Type': {
    definition: 'The entity\'s classification (Bank, Private Credit, Trust, GSE, Servicer, MERS or Other), as set on the Entities page.',
    howCalculated: 'Read from the canonical entity record. Blank when the name has no recorded filings yet.',
    whyValuable: 'Quick context on what kind of participant you are watching, and whether its activity should be read as buying, selling or servicing.',
  },
  'targets:Total Txns': {
    definition: 'All clean assignment records naming this entity as either assignor or assignee, across all counties and all time.',
    howCalculated: 'Received + Assigned, from the canonical entity record.',
    whyValuable: 'The baseline size of the firm\'s footprint in these counties, against which the Last 90 Days figure is read.',
  },
  'targets:In / Out': {
    definition: 'Assignments received (in, shown with the up arrow) and assignments made (out, shown with the down arrow).',
    howCalculated: 'In = filings where the entity is the assignee; Out = filings where it is the assignor. Sorting uses the inbound figure.',
    whyValuable: 'The direction of the firm\'s business. A target whose "out" is growing faster than its "in" is shedding loans, which is the moment a distressed-debt buyer wants to be in contact.',
  },
  'targets:Last 90 Days': {
    definition: 'How many assignments naming this entity, in either role, were recorded in the last 90 days.',
    howCalculated: 'Count of clean assignment records with a recording date within 90 days of today where the entity is assignor or assignee. Computed live when the page loads.',
    whyValuable: 'The recency signal. A firm that is quiet for years and suddenly shows filings is exactly what the watchlist exists to catch.',
  },
  'targets:Last Activity': {
    definition: 'The recording date of the most recent assignment naming this entity.',
    howCalculated: 'Latest recording date across all clean assignment records where the entity is assignor or assignee.',
    whyValuable: 'Shows at a glance which targets are currently moving loans and which have gone dormant.',
  },
  'targets:Added': {
    definition: 'The date this participant was added to the watchlist.',
    whyValuable: 'Lets you tell a long-standing target from one added recently, and date any activity report back to when monitoring began.',
  },
}
