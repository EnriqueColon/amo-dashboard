// Type-only bridge to the ported News server modules; erased at build time,
// so the client bundle never pulls server code in (see peer-intel-types.ts).
export type { PublicMentionItem, PublicMentionsResponse } from "../../../../server/intel/news/fetch-public-mentions"
export type { InvestingNewsResponse } from "../../../../server/intel/news/fetch-investing-news"
export type { SubscriberItem, SubscriberSourcesResponse } from "../../../../server/intel/news/fetch-subscriber-sources"
export type { NewsBrief, NewsSummaryInput } from "../../../../server/intel/news/fetch-news-summary"
export type { TrdArticleResult } from "../../../../server/intel/news/fetch-trd-article"
export type { ArticleDigest } from "../../../../server/intel/news/fetch-article-digest"
export type NewsLevel = "national" | "florida" | "miami"
