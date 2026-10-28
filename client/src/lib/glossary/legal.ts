import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the Legal Landscape page. Keys are namespaced "legal:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'legal:Date': {
    definition: 'The date on the development\'s own record: a rule\'s publication date, a bill\'s latest action, an order\'s filing date.',
    whyValuable: 'Each section keeps its own window (90 days for rules and enforcement, up to a year for bills, because legislatures do not sit all year); anything older is dropped.',
  },
  'legal:Development': {
    definition: 'The rule, bill, order or case, linked to its primary source (Federal Register, Congress.gov, the Florida legislature, the agency). Below it, the record\'s own facts — citation, docket, CFR parts, length — exactly as the source states them.',
    howCalculated: 'Found by OpenAI web search restricted to authoritative hosts, then kept only if the source could be verified and the item has a clear bearing on CRE lending, servicing or foreclosure.',
    whyValuable: 'Expand the row for the summary, points drawn from the document\'s own text, and why it matters to the firm.',
  },
  'legal:Jurisdiction': {
    definition: 'Federal, Florida, or Multi-State (a rule or case whose effect spans several states).',
    whyValuable: 'Florida items touch the firm\'s own collateral and foreclosure process directly.',
  },
  'legal:Status': {
    definition: 'Where the development stands: proposed or final for a rule, the bill\'s latest stage, the order\'s disposition. "Moved" means the stage changed since this platform last checked, with the previous stage and date.',
    howCalculated: 'Bill stages are compared against the last one recorded in the platform\'s own history table each morning; only a real transition is marked.',
    whyValuable: 'The one thing a reader cannot get by opening the bill themselves is that it changed.',
  },
  'legal:Applies to': {
    definition: 'How many Florida FDIC filers meet the rule\'s own scope test (asset size, CRE or construction concentration), and how many of those the Bank Stress Ranking already flags.',
    howCalculated: 'The test is taken from the document\'s stated scope, re-checked for plausibility, and applied to the latest quarter\'s screening rows in bank_stress.db. "All" means the rule applies regardless of size or concentration. Blank means the document states no quantitative scope.',
    whyValuable: 'Turns a headline into a list of banks to call; expand the row for the largest affected names and the test as applied.',
  },
}
