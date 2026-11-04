# Reporting tab — activity feed + entity profiles (plan)

Status: **steps 1–4 LIVE in production (open testing) since 4 Nov 2026 14:11 UTC** (`9b3633a`; separate table and feed cards live 14:17 UTC, `c4fa7ed`); step 5 (news) not started. Owner request, 4 Nov 2026.

## Goal

The filing list on the Reporting tab ("Assignments activity", 50 per page) should read like a
social-media feed instead of a 13-column table, and every firm named on a card should open a
one-screen profile of that firm built from everything we hold about it.

The feed is labelled **Open testing** on the page: it is a work in progress, and users are asked
to try it and send suggestions.

## Decisions taken (4 Nov 2026)

- ~~Feed is the default view with a Feed | Table toggle~~ — changed 4 Nov 2026 (owner: "the table
  and the feed should be separate cards"): the table card is back as it was, and the feed is its
  own card underneath ("Activity feed", Open testing) with its own pages and its own scroll area.
  With 2+ firms selected there is one table per firm and one feed for all of them.
- Same endpoint (`/api/reporting`), same filters, same 50-per-page pagination. No infinite scroll.
- Filings on the same page with the same assignor, assignee and recording date are grouped into
  one card ("and N more"), so bulk MERS/servicer batches don't flood the feed.
- No right-hand sidebar for now (the charts above the list already cover it).
- Save and notes are left for a later pass (they need a new table).
- Profiles open as a centred pop-up card, not a side drawer (owner rule, 3 Nov 2026).

## Build order

1. **Feed layout** — DONE (open testing). `FeedCard` + Feed | Table toggle in `TransactionsTable`
   (`client/src/pages/Reporting.tsx`). Firm names on each card already open the
   existing entity card (`EntityDetailPanel`) as a stop-gap until step 2.
2. **Entity profile (our own data)** — DONE (open testing). `GET /api/entity/:name/snapshot`
   (`server/routes.ts`) + `client/src/components/EntitySnapshot.tsx`, shown at the top of the entity
   card's Overview everywhere the card opens (Reporting feed, Entities, Dashboard). Shows: target
   flag; "Named with" chips (the parent/servicer names written on the firm's filings, which are
   mostly servicers or predecessors, not true parents); counties; $ acquired / sold with how many
   filings carry an amount; 24-month in/out bar chart; latest 10 filings (counterparty clickable to
   switch profile); UCC filings as lender/borrower; credit facilities; foreclosure complaints as
   plaintiff. UCC, facilities and complaints are matched on the START of the firm's name and are
   labelled "name match". Esc now closes the card.
3. **FDIC section (banks)** — DONE (open testing). `server/entity-fdic.ts`
   (`GET/PUT/DELETE /api/entity/:name/fdic`) + `client/src/components/EntityFdicSection.tsx`, at the
   top of the snapshot for firms typed BANK (or any firm linked by hand). Shows the FDIC charter,
   holding company, assets, Bank Stress tier / score / rank / quarter / flags and six figures (Tier 1
   leverage, CRE concentration, noncurrent loans, ROA, loans/deposits, uninsured deposits), with
   "Open full bank card" (the Bank Stress card on top). Matching: active FDIC institutions whose
   cleaned name equals the firm's, or starts with it; exact first, then largest assets. Shown as
   "Suggested match" until someone clicks Confirm, picks another charter, or marks "Not an FDIC
   bank"; decisions live in `entity_fdic_links` (main DB, created at server start) and always win.
   Checked on the 20 busiest bank names on production: all 20 suggestions right.
   **Do not use `fdic_institution_cache` for "which bank"**: it keeps an arbitrary charter when
   names collide (US BANK -> Focus Bank, WELLS FARGO -> Wells Fargo National Bank West, JPMORGAN
   CHASE -> a Dearborn charter, BANK OF AMERICA -> First National Bank of America). The Bank Stress
   card's "In the county filings as" note used to read `bank_entity_link` (seeded from that cache);
   since 4 Nov 2026 it reads `countyNamesForCert()` in `server/entity-fdic.ts` instead (saved
   decision, else the top suggestion, over every BANK-typed firm), fresh on every request.
3a. **Foreclosure complaints in the feed** — DONE (open testing, 4 Nov 2026, owner: "both").
   `server/feed.ts` (`GET /api/reporting/feed-complaints`) + `ComplaintCard` / `ForeclosureFlag` in
   `Reporting.tsx`; `complaintFeedRows()` exported from `server/complaints.ts` (same summary and
   result labels as the Complaints tab). (a) Complaint cards mixed into the feed by date: page n
   shows complaints filed in [oldest date on page n, oldest date on page n-1), page 1 open above,
   last page open below, so each complaint shows exactly once. Checkbox to hide them (remembered
   per browser); hidden while the Review / Shows / Document filters are set (assignment-only
   filters); search and firm filters apply to plaintiff / case / address. Plaintiff mapped to our
   canonical firm (longest canonical name the plaintiff starts with, "U S" = "US") so it opens the
   profile. (b) Assignment cards get a red "Foreclosure filed" box when a complaint is on the same
   property; complaint cards list the earlier assignments of that property. Same property = same
   county + street address + unit (or no unit on either side); complaints have no folio. "The firm
   that received this assignment is foreclosing" when plaintiff = assignee (cleaned names).
4. **SEC section** — DONE (open testing). `server/entity-sec.ts` (`GET/PUT/DELETE
   /api/entity/:name/sec`, table `entity_sec_links` keyed by entity + kind) +
   `client/src/components/EntitySecSection.tsx`, under the FDIC block in the snapshot. Two identities:
   **EDGAR filer** (CIK): suggested from SEC's ticker list on the firm's name, then (banks) on the
   FDIC holding-company name via `fdicHoldingCompany()` (US BANK -> US Bancorp, CITIBANK ->
   Citigroup), then an EDGAR filer with exactly this name; aliases for Fannie Mae / Freddie Mac.
   Shows name, ticker/exchange, CIK, SIC, location, latest 8 key filings, and for listed companies
   total assets / equity / net income / revenue from the latest 10-K (XBRL companyconcept; a concept
   older than the latest fiscal year is dropped: Wells Fargo stopped tagging Revenues in FY2019).
   **Investment adviser** (IAPD CRD): suggested when exactly the name or the name + Management /
   Advisors / Partners (not "Investments": Wells Fargo Investments is a broker arm). Shows CRD,
   SEC number, status, registration, latest ADV date, office, brochure, links. No AUM: IAPD's API
   has none (needs SEC's bulk Form ADV data). Each identity: Confirm / pick a different one / none
   / reset. EDGAR's name search ranks poorly, so it only feeds the pick list. Upstream calls spaced
   (EDGAR 125 ms, IAPD 300 ms) and cached a day; answers cached 12 h, cleared on any link change.
5. **News per firm** — company-specific news search (e.g. Google News query), cached for a day.

## Matching names to FDIC / SEC ids (steps 3–4)

Deeds say "WELLS FARGO BANK NA"; FDIC knows cert 3511, SEC a CIK. Plan: automatic match on
cleaned names, stored in a small lookup table so each firm is matched once, plus a "link to
FDIC / SEC record" control on the profile to confirm or fix a match by hand. Unmatched firms
(small LLCs, trusts, MERS) show our own data only.
