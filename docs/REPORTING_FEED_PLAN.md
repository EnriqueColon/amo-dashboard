# Reporting tab — activity feed + entity profiles (plan)

Status: **steps 1–3 built (open testing), not deployed**; steps 4–5 not started. Owner request, 4 Nov 2026.

## Goal

The filing list on the Reporting tab ("Assignments activity", 50 per page) should read like a
social-media feed instead of a 13-column table, and every firm named on a card should open a
one-screen profile of that firm built from everything we hold about it.

The feed is labelled **Open testing** on the page: it is a work in progress, and users are asked
to try it and send suggestions.

## Decisions taken (4 Nov 2026)

- Feed is the default view; the old table stays one click away (Feed | Table toggle, remembered
  per browser).
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
4. **SEC section** — EDGAR filings + XBRL financials for public companies; Form ADV for advisers /
   private credit managers; EDGAR for funds. A firm can show FDIC and SEC together (bank + holding
   company). Needs name → CIK / CRD matching.
5. **News per firm** — company-specific news search (e.g. Google News query), cached for a day.

## Matching names to FDIC / SEC ids (steps 3–4)

Deeds say "WELLS FARGO BANK NA"; FDIC knows cert 3511, SEC a CIK. Plan: automatic match on
cleaned names, stored in a small lookup table so each firm is matched once, plus a "link to
FDIC / SEC record" control on the profile to confirm or fix a match by hand. Unmatched firms
(small LLCs, trusts, MERS) show our own data only.
