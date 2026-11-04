# Reporting tab — activity feed + entity profiles (plan)

Status: **steps 1–2 built (open testing), not deployed**; steps 3–5 not started. Owner request, 4 Nov 2026.

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
3. **FDIC section (banks)** — Bank Stress score/rank/tier and key FDIC figures from
   `bank_stress.db`, link to the full bank card. Needs name → FDIC cert matching.
4. **SEC section** — EDGAR filings + XBRL financials for public companies; Form ADV for advisers /
   private credit managers; EDGAR for funds. A firm can show FDIC and SEC together (bank + holding
   company). Needs name → CIK / CRD matching.
5. **News per firm** — company-specific news search (e.g. Google News query), cached for a day.

## Matching names to FDIC / SEC ids (steps 3–4)

Deeds say "WELLS FARGO BANK NA"; FDIC knows cert 3511, SEC a CIK. Plan: automatic match on
cleaned names, stored in a small lookup table so each firm is matched once, plus a "link to
FDIC / SEC record" control on the profile to confirm or fix a match by hand. Unmatched firms
(small LLCs, trusts, MERS) show our own data only.
