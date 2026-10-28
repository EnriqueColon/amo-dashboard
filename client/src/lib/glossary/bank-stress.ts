import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the bank stress page. Keys are namespaced "bank-stress:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'bank-stress:#': {
    definition: 'The bank\'s rank among all ranked banks in the selected quarter. 1 = the most stressed.',
    howCalculated: 'Ordered by composite score, highest first; ties are broken by CRE concentration. Banks established in the last three years are shown but not ranked, so they have no number.',
    whyValuable: 'A single ordering for sourcing calls. The rank is national, so filtering to Florida shows where Florida banks sit in the whole cohort.',
  },
  'bank-stress:Bank': {
    definition: 'The institution\'s name, with its FDIC certificate number, state, and whether it is owned by a holding company, had a merger in the quarter, or is excluded from the ranking.',
    whyValuable: 'The cert number is the stable identifier across FDIC data; "merger qtr" warns that trend figures for the quarter are unreliable and have been left blank.',
  },
  'bank-stress:Band': {
    definition: 'The asset-size peer group the bank is scored within: under $1B, $1-10B, $10-100B or over $100B in total assets.',
    howCalculated: 'From total assets on the quarter\'s Call Report.',
    whyValuable: 'Every score on this page is a percentile within the band, so a 90 for a $500M community bank and a 90 for a $50B regional each mean "more stressed than 90% of its size peers".',
  },
  'bank-stress:Composite': {
    definition: 'The overall stress score, 0-100, higher = more stress. The headline number for the ranking.',
    howCalculated: 'Weighted mean of the three sub-scores: Condition 40%, Deterioration 40%, CRE Exposure 20%. Each sub-score is itself a percentile rank within the asset-size peer band. When a sub-score cannot be computed the weights are re-spread over the ones that can; nothing is imputed.',
    whyValuable: 'The early signal for which banks are under enough earnings, credit and commercial-real-estate pressure to become sellers of distressed CRE loans.',
  },
  'bank-stress:Condition': {
    definition: 'Where the bank stands today, 0-100, higher = more stress.',
    howCalculated: 'Mean of the bank\'s peer-band percentiles for return on assets, core ROA (excluding loan and OREO sale gains), efficiency ratio, noncurrent loans / gross loans, reserve coverage of noncurrent loans, Tier 1 leverage ratio and loans / deposits. Each is oriented so a higher percentile means worse.',
    whyValuable: 'Weak earnings, thin reserves or capital and a stretched balance sheet limit how long a bank can carry problem CRE before it has to sell.',
  },
  'bank-stress:Deterior.': {
    definition: 'Deterioration: which way the bank is moving, 0-100, higher = getting worse faster than peers.',
    howCalculated: 'Mean of the peer-band percentiles for the year-over-year change and the four-quarter trend of net interest income / assets, funding cost ratio, provision / assets, CRE net charge-offs and noncurrent loans. Blank when the window spans a merger, because the comparison would mix two balance sheets.',
    whyValuable: 'A bank getting worse is a likelier seller than one that is merely weak. This is the score that catches a deterioration before it shows up in Condition.',
  },
  'bank-stress:CRE': {
    definition: 'CRE Exposure: how much of the bank\'s problem is commercial real estate, 0-100, higher = more stress.',
    howCalculated: 'Mean of the peer-band percentiles for CRE loans / Tier 1 capital, the CRE share of net charge-offs, and gains or losses on loan and OREO sales (losses score as stress).',
    whyValuable: 'Points the ranking at the banks whose stress will surface specifically as CRE loan sales rather than, say, consumer or C&I problems.',
  },
  'bank-stress:Flags': {
    definition: 'How many of the eight plain-English stress rules the bank trips, and its tier: 0-2 normal, 3-4 watchlist, 5 or more likely pressure. Hover the chip to see which rules fired.',
    howCalculated: 'One point per rule: (1) ROA below 0.5% or core ROA down 30%+ year over year; (2) net interest income / assets down 25 bp+; (3) funding cost ratio up 10 points+; (4) efficiency ratio over 70%; (5) provisions behind charge-offs two quarters running, or provision tripled; (6) CRE net charge-offs rising two quarters in a row; (7) standalone banks paying out more than they earn, or cutting the dividend to zero; (8) a loss on loan or OREO sales this quarter.',
    whyValuable: 'Explains a score in rules an analyst can check against the Call Report. The composite says how stressed; the flags say why.',
  },
  'bank-stress:Top drivers': {
    definition: 'The three components pushing this bank\'s score up the most, with the bank\'s percentile on each.',
    howCalculated: 'Of the twenty scored components, the three with the highest peer-band percentiles (higher = more stress).',
    whyValuable: 'Tells you what the conversation with the bank is about: a capital problem, a funding problem or a CRE credit problem call for different approaches.',
  },
  'bank-stress:Signal': {
    definition: 'The CRE seller signal: a red badge when flags 5, 6 and 8 fire together, meaning the bank is provisioning behind its losses, its CRE charge-offs are rising, and it is already selling loans or OREO at a loss.',
    howCalculated: 'Flag 5 (provision coverage under 1x two quarters running or a provision spike) AND flag 6 (CRE net charge-offs up two consecutive quarters) AND flag 8 (loss on loan or OREO sales this quarter).',
    whyValuable: 'The strongest single indicator on the page that a bank is actively disposing of distressed CRE, not just carrying it. These are the first calls to make.',
  },
  'bank-stress:CRE / T1': {
    definition: 'Commercial real estate loans as a percentage of Tier 1 capital.',
    howCalculated: '(Construction and land development + multifamily + non-owner-occupied nonfarm nonresidential loans) / Tier 1 capital. Owner-occupied commercial property is excluded under the interagency definition, because it repays from the occupant\'s business rather than rents or a sale.',
    whyValuable: 'The regulatory concentration test: supervisors watch banks above 300%, and that is the level at which examiners push for CRE reduction, which means loan sales.',
  },
  'bank-stress:Noncurr.': {
    definition: 'Noncurrent loans as a percentage of gross loans: loans 90+ days past due plus loans on nonaccrual.',
    howCalculated: 'Noncurrent loans and leases / gross loans and leases, from the quarter\'s Call Report. Over 2% raises a watch flag.',
    whyValuable: 'The cleanest measure of how much of the loan book has already gone bad. A rising figure alongside a thin reserve is where forced sales come from.',
  },
  'bank-stress:T1 lev.': {
    definition: 'Tier 1 leverage ratio: Tier 1 capital as a percentage of average total assets.',
    howCalculated: 'Taken directly from the Call Report (FDIC field RBC1AAJ). Below 8% raises a watch flag; below 5% is critical and is the regulatory undercapitalized threshold.',
    whyValuable: 'The bank\'s cushion for absorbing losses. A low ratio means it cannot afford to hold problem loans to recovery and is more likely to sell at a discount.',
  },
  'bank-stress:Assets': {
    definition: 'Total assets at quarter end, in dollars.',
    howCalculated: 'FDIC field ASSET, reported in thousands and shown here in full.',
    whyValuable: 'Sizes the opportunity: a stressed $300M bank and a stressed $30B bank are different kinds of counterparty.',
  },
}
