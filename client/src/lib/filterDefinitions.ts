/**
 * Plain-English definitions for every filter and view button in the app, shown
 * on hover. One file so a term means the same thing on every page — "Loan
 * transfers" on Reporting and on the weekly email should never be explained two
 * different ways.
 *
 * Written for the reader who needs to explain the numbers to someone else, not
 * for whoever built the filter: what is IN the view, in market terms, with an
 * example where one helps. Each entry was checked against what the filter
 * actually does in server/routes.ts and collector/normalize.py, not against its
 * label — where the two differ (the UCC Collateral/Other split, see below), the
 * definition says so rather than inventing a distinction the data doesn't have.
 */

export type Definition = { title: string; body: string };

const d = (title: string, body: string): Definition => ({ title, body });

// ── Reporting: "Shows" — what the document turned out to BE once read ─────────
export const CATEGORY_DEFS: Record<string, Definition> = {
  '':         d('Loan transfers', 'A mortgage loan sold or transferred from one company to another. The seller (assignor) gives up the loan; the buyer (assignee) now owns it. This is the default view.'),
  collateral: d('Collateral', 'A lender pledging loans it owns to its own lender as security for borrowing — for example, a mortgage company posting loans against a warehouse line. Nothing is sold outright.'),
  rents:      d('Rents & leases', 'A property owner assigning tenant rents or leases to the bank that financed the building. Routine paperwork alongside a commercial mortgage — no loan is bought or sold.'),
  other:      d('Other', 'Assignment documents that are none of the above — for example assignments of permits, contracts, judgments or development rights.'),
  all:        d('All documents', 'Every assignment document we have read, whatever kind it turned out to be.'),
};

// ── Reporting: "Document" — the code the COUNTY filed it under ─────────────────
export const DOC_TYPE_DEFS: Record<string, Definition> = {
  '':  d('All filing codes', 'Every county filing code. This row filters by how the county labelled the filing; to filter by what the document actually is, use Shows.'),
  amo: d('Mortgage (AMO)', "Miami-Dade's dedicated \"Assignment of Mortgage\" code. Almost always a loan transfer, but check Shows to be sure."),
  asg: d('Generic (ASG)', "Miami-Dade's catch-all \"Assignment\" code. A mix of loan transfers, collateral pledges, rent assignments and permits — use Shows to narrow it down."),
  ast: d('Broward (AST)', 'Assignments recorded in Broward County, under its own filing code.'),
};

// ── Reporting: review status ───────────────────────────────────────────────────
export const REVIEW_DEFS: Record<string, Definition> = {
  '':  d('All', 'Every row, whether or not anyone has reviewed it.'),
  no:  d('Pending', 'Rows nobody has marked as reviewed yet (the ✓ column on the right).'),
  yes: d('Reviewed', 'Rows someone has already checked and marked as reviewed.'),
};

export const TARGETS_ONLY_DEF = d('Targets only', 'Only transactions involving a company on your Targets watchlist. Add or remove companies in the Targets tab.');

// ── Reporting: entity report direction ─────────────────────────────────────────
export const DIRECTION_DEFS: Record<string, Definition> = {
  '':       d('All activity', 'Every filing where the selected company appears — as seller or as buyer.'),
  assignor: d('Sold / assigned out', 'Only filings where the selected company is the seller (assignor).'),
  assignee: d('Acquired', 'Only filings where the selected company is the buyer (assignee).'),
};

// ── Reporting: chart and panel views ───────────────────────────────────────────
export const CHART_VIEW_DEFS: Record<string, Definition> = {
  monthly:     d('Monthly Volume', 'How many filings were recorded each month.'),
  top_buyers:  d('Top Buyers', 'The companies that acquired the most loans — most often named as the buyer (assignee).'),
  top_sellers: d('Top Sellers', 'The companies that sold or assigned out the most loans — most often named as the seller (assignor).'),
  txn_type:    d('Txn Types', 'How the filings split across transaction types: market transfer, origination and so on. Hover those buttons on Clean Transactions for each definition.'),
  entity_type: d('Entity Types', 'How the filings split by the kind of company that ACQUIRED the loan — bank, servicer, trust and so on.'),
};

export const PARTICIPANT_VIEW_DEFS: Record<string, Definition> = {
  active:  d('Most Active', 'Companies with the most filings on either side — buying and selling combined.'),
  sellers: d('Top Senders', 'Companies that assigned out (sold) the most loans.'),
  buyers:  d('Top Receivers', 'Companies that received (acquired) the most loans.'),
};

export const ENTITY_REPORT_VIEW_DEFS: Record<string, Definition> = {
  timeline:       d('Activity Timeline', 'Filings per month for the selected companies, bought and sold.'),
  counterparties: d('Counterparties', 'Who the selected companies traded with most — the company on the other side of each transaction.'),
  inout:          d('Bought vs Sold', 'For each selected company, how many loans it acquired against how many it sold.'),
  combined:       d('Combined', 'One line for all the selected companies together.'),
  'per-entity':   d('Per entity', 'A separate line for each selected company.'),
};

// ── Clean Transactions: transaction type ───────────────────────────────────────
export const TXN_TYPE_DEFS: Record<string, Definition> = {
  '':                d('All', 'Every transaction type.'),
  MARKET_TRANSFER:   d('Market Transfer', 'Institution to institution — a bank, servicer, fund or trust selling a loan to another. The true secondary market.'),
  ORIGINATION:       d('Origination', 'A non-institution (an individual, small or private lender) selling a loan into an institution. New supply entering the market.'),
  MERS_RELEASE:      d('MERS Release', "MERS — the industry's electronic loan registry — handing over the placeholder interest it holds. Record-keeping, not a sale."),
  SELF_ASSIGN:       d('Self-Assign', 'The same company on both sides, such as moving a loan between its own affiliates. Administrative, not a market trade.'),
  INSTITUTIONAL_OUT: d('Inst. Out', 'An institution transferring a loan to a non-institution — typically a payoff, a foreclosed property (REO) or a distressed sale.'),
  PRIVATE:           d('Private', 'Neither side is an institution — for example an individual or small private lender transferring to another. Outside the institutional market.'),
};

// ── Entities / Raw Assignments: kind of company ────────────────────────────────
export const ENTITY_TYPE_DEFS: Record<string, Definition> = {
  '':             d('All', 'Every kind of company.'),
  BANK:           d('Bank', 'Chartered banks — for example Wells Fargo, JPMorgan Chase, US Bank.'),
  PRIVATE_CREDIT: d('Private Credit', 'Non-bank investment firms and funds that buy loans or lend against them — for example Blackstone, Apollo, KKR, Ares.'),
  TRUST:          d('Securitization Trust', 'Trusts that hold pools of loans on behalf of bond investors — usually named with a series and year, for example Towd Point or MEB Loan Trust.'),
  GSE:            d('GSE', 'Government-sponsored enterprises: Fannie Mae, Freddie Mac and Ginnie Mae.'),
  SERVICER:       d('Servicer', 'Companies that collect payments and manage loans, and often buy servicing portfolios — for example Newrez/Shellpoint, Nationstar/Mr. Cooper, Lakeview.'),
  MERS:           d('MERS', 'Mortgage Electronic Registration Systems — the industry registry that holds loans on paper as a placeholder. Not a real buyer or seller.'),
  OTHER:          d('Other', 'Everyone not matched to a category above — mostly individuals, small lenders, and companies not yet classified.'),
};

// ── Lending Relationships: kind of credit facility ─────────────────────────────
export const FACILITY_TYPE_DEFS: Record<string, Definition> = {
  '':                                     d('All Types', 'Every credit facility found in the recorded documents.'),
  warehouse_or_revolving_credit_facility: d('Warehouse / Revolving', 'A revolving line a bank gives a lender, secured by the loans that lender makes: it draws on the line to fund loans and repays as it sells them. Identified by warehouse, repurchase-agreement or borrowing-base language in the document.'),
  syndicated_credit_agreement:            d('Syndicated Credit', 'One large loan shared by a group of lenders and run by a single agent bank. Identified by "administrative agent", "as agent for the lenders" or similar language.'),
  consumer_or_business_line_of_credit:    d('Consumer / Business LOC', 'A line of credit for an individual or a business, including home-equity lines (HELOCs). Not institutional lending.'),
};

// ── UCC Filings ────────────────────────────────────────────────────────────────
// Collateral vs Other is described honestly: measured 17 Sep 2026, both buckets
// hold the same mix of original filings, terminations, continuations and
// amendments, so the split does not separate kinds of filing reliably.
export const UCC_CATEGORY_DEFS: Record<string, Definition> = {
  '':         d('All', 'Every UCC filing.'),
  collateral: d('Collateral', 'Filings the document reader classified as a lender recording a security interest in a borrower\'s assets — the large majority. Note: this and Other are not a clean split; both include original filings, amendments, continuations and terminations.'),
  other:      d('Other', 'Filings the reader did not classify as a security interest. Not a reliable category on its own — it holds the same kinds of filing as Collateral.'),
  rents:      d('Rents & leases', "Filings covering a property's rents or leases. Rare in UCC records."),
};

export const UCC_HAS_PROPERTY_DEF = d('Has a property', 'Only filings where a property address was found in the document.');
export const UCC_CONSUMER_DEF = d('Consumer finance', 'Solar, home-improvement and other consumer lenders — plus filing agents and utilities — are hidden by default because none of it is commercial real estate. Click to show or hide them.');
export const UCC_ROLES_DEF = d('Roles from document', "Only filings where the lender and borrower were read from the document itself. On the rest the county's index decides who is who, and it sometimes lists them in reverse.");
export const UCC_TAB_DEFS: Record<string, Definition> = {
  lenders:   d('Lenders', 'Companies most often named as the secured party — the lender.'),
  borrowers: d('Borrowers', 'Companies most often named as the debtor — the borrower.'),
};

// ── Global ─────────────────────────────────────────────────────────────────────
export const COUNTY_DEF = d('County', "Which county's records every page shows. All Counties combines both. Broward's history before August 2026 is thinner, so compare the two counties with care.");
export const FDIC_SCOPE_DEF = d('Region', 'Which banks to screen: United States covers institutions above roughly $1B in assets; choosing a state shows every bank in that state.');
