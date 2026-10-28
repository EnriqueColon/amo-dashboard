import type { MetricDef } from '@/components/DefTerm'

/** Column-header definitions for the News page. Keys are namespaced "news:<Label>". */
export const GLOSSARY: Record<string, MetricDef> = {
  'news:Date': {
    definition: 'The day the article was published, as the publisher reports it. A green "new" mark means it appeared since yesterday (US Eastern).',
    whyValuable: 'Every list is newest first; the mark picks out what has changed since the last morning scan.',
  },
  'news:Headline': {
    definition: 'The article\'s headline, with the publisher\'s suffix removed, and the first line of its summary where that adds something the headline does not say.',
    whyValuable: 'Click the headline to open the article on the publisher\'s site; Brief writes a short summary without leaving the page.',
  },
  'news:Source': {
    definition: 'The outlet that published the article, from the feed it came through (Google News, the publisher\'s own RSS, or a subscription).',
    whyValuable: 'Paywalled outlets are still listed; Brief falls back to open sources when the article itself cannot be read.',
  },
  'news:Region': {
    definition: 'Which feed level found the story: Miami, Florida or National. Decided by the search that returned it and the names in the text.',
    howCalculated: 'The three levels are fetched separately and merged; a story found at more than one level keeps the most local.',
    whyValuable: 'Filter to Miami for deal-sourcing reads, National for the macro picture.',
  },
  'news:Topic': {
    definition: 'A one-word subject tag assigned from the headline and summary: Debt/Financing, Foreclosure/Distress, Banking/Financial, Earnings, Interest Rates/Fed and so on.',
    howCalculated: 'Keyword rules in the feed fetcher; no model involved.',
    whyValuable: 'The Topic filter above the tables applies to all three lists at once.',
  },
  'news:Score': {
    definition: 'How strongly a subscriber article matched the firm\'s interests this week. Hover for the rules that fired.',
    howCalculated: 'Points for distress, debt and South Florida terms in the headline and standfirst, recency, and the publisher\'s own market and sector tags; the top ten of the week are shown.',
    whyValuable: 'Explains why an article was pinned rather than left in the feed.',
  },
  'news:Actions': {
    definition: 'Read opens the full article text inside the platform (subscriber sources). Open goes to the publisher. Brief writes a short summary of the article.',
    whyValuable: 'Read lets anyone at the firm read a subscription article without a login; Brief is cached per day so the second reader pays nothing.',
  },
}
