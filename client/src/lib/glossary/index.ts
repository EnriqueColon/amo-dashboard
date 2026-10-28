/**
 * Column-header glossary, one file per page, merged here for DefTerm.
 *
 * Every table header in the app is wrapped in <DefTerm term="<page>:<Label>">
 * and resolves to an entry with a plain-language definition, how it is
 * calculated where that is not obvious, and why it matters. Keys are
 * namespaced by page because the same word ("Assignor", "Amount") means
 * slightly different things on different pages.
 */
import type { MetricDef } from '@/components/DefTerm'
import { GLOSSARY as assignments } from './assignments'
import { GLOSSARY as cleanEvents } from './clean-events'
import { GLOSSARY as reporting } from './reporting'
import { GLOSSARY as ucc } from './ucc'
import { GLOSSARY as creditFacilities } from './credit-facilities'
import { GLOSSARY as privateCredit } from './private-credit'
import { GLOSSARY as collectionLog } from './collection-log'
import { GLOSSARY as entities } from './entities'
import { GLOSSARY as targets } from './targets'
import { GLOSSARY as bankStress } from './bank-stress'
import { GLOSSARY as news } from './news'
import { GLOSSARY as legal } from './legal'

export const COLUMN_GLOSSARY: Record<string, MetricDef> = {
  ...assignments, ...cleanEvents, ...reporting, ...ucc, ...creditFacilities,
  ...privateCredit, ...collectionLog, ...entities, ...targets, ...bankStress, ...news, ...legal,
}
