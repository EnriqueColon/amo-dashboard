# Accuracy audit — SHCP Intelligence Platform

**Run:** 31 Oct 2026, read-only against the production database. **Nothing in production was changed.**
**Scope:** every classification layer — document category, direction, parties, entity types, transaction types, amounts, addresses — measured against the data it was derived from (all 180,399 read documents, plus 194 hand-read documents).
**Tooling:** `collector/audit/accuracy_audit.py` (population measures), `collector/audit/fetch_sample_texts.py` (fetch + OCR a sample), `hand_read_verdicts.csv` (194 documents read in full against the stored verdicts). Full tables: `audit_tables.md`; row-level lists: the `s*.csv` files in this folder.

## How to read the numbers

Two kinds of evidence, and they must not be mixed:

* **Population counts** (title vs stored category, pre/post rebuild, party mismatch) are exact counts over every row. They say *how many rows disagree*, not how many are wrong.
* **The 194 hand-read documents** were *deliberately drawn from suspect strata* (e.g. collateral filings with mortgage titles, rents titles in the loan-transfer bucket). Their error rates are **not** population error rates. They tell us *whether a population disagreement is a real error*.

Where a population figure is an estimate built from both, it is labelled **estimate**.

## Verdict in one paragraph

The pipeline's **party and amount extraction is largely sound** (assignor right in 181/194 hand-read documents, assignee 184/194, direction 190/193). Its **document-category layer has two systematic faults** that remove real loan transfers from the dashboard and put non-transfers into it, and its **entity-type layer is wiped every night**, which changes the headline numbers on most pages by the time anyone looks at them. All three are code/logic faults with known causes, not random noise, and all three are fixable.

---

## Findings, ranked

### F1 — CRITICAL: the nightly rebuild erases the AI entity types (exact, verified before/after)

`run_nightly_normalize.sh` (08:30 UTC daily) rebuilds `entity_classifications` using only the rule-based waterfall, then upserts over the rows the AI step (`enrich_entities.py`, run by the Friday job) wrote. Compared the 03:15 backup of 31 Oct (taken after Friday's enrichment) with the live database after the 08:30 rebuild:

| | before rebuild | after rebuild |
|---|---|---|
| Entities typed by the AI (`llm`) | 10,785 | **59** |
| Entities typed `OTHER` (default) | 16,045 | **26,784** |
| Entities whose type changed overnight | | **7,089 of 12,992** |
| Clean rows whose transaction type changed | | **18,230 of 88,355 (21%)** |
| MARKET_TRANSFER → ORIGINATION | | 10,206 rows, $26.3B stated |
| MARKET_TRANSFER → PRIVATE | | 2,268 rows, $20.3B |
| MARKET_TRANSFER → INSTITUTIONAL_OUT | | 3,324 rows, $17.1B |
| **Private Credit page: filings shown** | **12,181** | **6,838** (distinct private-credit names ≈2,800 → ≈130) |
| Miami-Dade `ORIGINATION` rows (Overview tile) | 1,926 | **7,647** |
| Hillsborough `ORIGINATION` rows | 652 | 4,255 |

Why it matters: the AI step is the only thing that recognises most private lenders, trusts and servicers. After the wipe, hundreds of real lenders (American Advisors Group, Upstart Mortgage, Atlantis Holdings AM, Homeowners Financial Group, Washington Mutual Bank FA, …) are `OTHER`, so their loan transfers are labelled *origination* and drop out of Private Credit, Market Transfers and the bank-vs-private splits. Friday's job repairs it for about 22 hours; Saturday's rebuild breaks it again. **The numbers on the dashboard are in the wiped state most of every week, and they swing 20%+ between states.**

This is by the code (`normalize.py` upserts `ON CONFLICT … DO UPDATE` over `llm` rows, with no preservation); the nightly job has existed since 21 Jul 2026, so the pattern is likely that old — not verified for earlier months.

### F2 — CRITICAL: real loan transfers filed as COLLATERAL never reach the dashboard

`COLLATERAL` documents go to `aom_events_nonloan`, not the clean table. Title evidence: **1,577 filings** (MD 1,275, Broward 257, Hillsborough 45; **$33.3B** stated) are stored COLLATERAL while their recorded title is a mortgage / note / security-instrument assignment.

Hand-read confirmation: of the 48 COLLATERAL-stored documents read, **36 were plain outright loan transfers**, 9 genuine pledges, 3 other. All 10 "Assignment of Security Instrument" filings read (Fannie Mae / Freddie Mac DUS deliveries) were sales. Cause: the extraction prompt's COLLATERAL definition is tripped by the word "security" (every mortgage assignment contains it); an earlier text-based correction (Sept) only ran where OCR text was stored, and **749 of these MD filings carry no correction evidence at all**.

Estimate: most of the 1,577 are real transfers (the hand-read supports a clear majority, but the 9 genuine pledges show a rule must read the text, not the title alone). **Effect:** Clean Transactions, Reporting, leaderboards and the Monday email under-count GSE and CMBS deliveries; stated volume $29B (MD) is missing from the loan-transfer view.

### F3 — HIGH: borrower rents/leases instruments counted as loan transfers

The title-based correction (`reclassify_rents_by_title`) only ever fires on a `COLLATERAL` verdict. A rents-only instrument the AI labels `LOAN_TRANSFER` is never corrected.

* Population: **438 filings** are LOAN_TRANSFER with a rents/leases title naming no mortgage/note/loan/deed (**432 reach the clean table**). 217 of those have a non-institution assignor (a borrower), shown as `ORIGINATION`, ~$3.3B stated. This audit's refined lexicon puts 247 MD + 145 Hillsborough + 15 Broward at ~407.
* Hand-read: **26 of 98** LOAN_TRANSFER-stored documents in the sample were truly RENTS_LEASES (this sample is enriched; the population rate is the 438 above, not 27%).
* Another 8 hand-read documents were stored OTHER but are rents instruments; ~1,430 MD and ~1,240 Hillsborough filings sit in OTHER with a rents title (not in the clean table, so no number moves, but Reporting's category filters under-report them).
* Lender "Assignment of Assignment of Leases and Rents" companions (≈150 MD) are ambiguous: they travel with a real loan sale; the readers marked them RENTS_LEASES. Needs your rule (keep as companion, or count).

### F4 — HIGH: direction is only corrected in Miami-Dade; Hillsborough partly, Broward not at all

Miami-Dade: swap logic works — 7,914 rows swapped, none left in the index order; **1,528 flagged for review, 0 reviewed**. Hillsborough: **1,334 of 32,262 loan transfers (4.1%) name the parties in the opposite order to the county index** and no correction runs; **Broward 10 (0.4%)**. The clean table follows the index there. Hand-read of 4 Hillsborough reverse candidates found 1 wrong (too few to rate it; **a 40-document read is needed before deciding to extend the Miami-Dade rule**). Three direction errors (of 193 read) were in clean rows where the clean pair was swapped relative to the document (two self-assignments, one Hillsborough market transfer).

### F5 — MEDIUM: parties — mostly right; recurring failure shapes

Hand-read: assignor correct 181/194, assignee 184/194. The 23 errors cluster in: borrower or co-party stored in place of the lender (index lists the borrower as grantor), multi-party deals (CMBS, multi-lender) keeping one name, an attorney-in-fact/"c/o" address taken as a party, and affiliate swaps in self-assignments. Population mismatch clean-vs-document: **MD 14% assignee / 9% assignor differ** (this count includes harmless trust-vs-trustee and spelling differences as well as real misses; the split was not measured); **Hillsborough 15.6% / 10.3%**, higher partly because the collector keeps only the first name per side of the county's party lists (24,424 of 32,319 Hillsborough rows have several grantees). The normalizer repairs most of it from the document, not all. Person-shaped parties in the clean table are <0.5% — not an issue.

### F6 — MEDIUM: entity-type taxonomy

Behavioural typing (`behavioral_classify`) labels high-volume names `BANK` from trading pattern alone: Fannie Mae, Freddie Mac, FDIC, Select Portfolio Servicing, Rushmore, SLS, Nationstar, Homebridge. These are GSEs/servicers. M&T Bank is typed `SERVICER`. Wells Fargo, JPMorgan, Citibank and Goldman Sachs are typed `BANK` (correct) but the **Goldman Sachs bank and mortgage company canonicalise to one name, so 4,609 SELF_ASSIGN rows include $51.7B of Goldman Sachs Bank ↔ Goldman Sachs Mortgage Co transfers** (affiliate sales, excluded from the email but present on the dashboard as "self"). Whether affiliates should count as self-assignments is a business rule, not a bug — flagged for decision.

### F7 — MEDIUM: amounts

Hand-read: 113 of 194 stored amounts verified, 60 documents state none, **18 state a principal but nothing is stored (11 on rents/leases documents, 4 collateral, 3 loan transfers), 2 wrong**. Several stored figures are *whole-portfolio / pool* principals (multistate CMBS, CLO pools — e.g. $3.46B, $2.95B on a single Miami-Dade parcel), which inflate Miami-Dade/Hillsborough totals: **36 Hillsborough and 45 Miami-Dade rows exceed $1B**. The $544,185 repeated 492 times is genuine (the FHA/HUD recorded reverse-mortgage amount), not an echo. Not a defect in extraction; a labelling issue — these should be shown as portfolio amounts.

### F8 — LOW: addresses

145 property addresses carry SUITE/FLOOR/P.O. Box (corporate addresses), 87 outside Florida, 30 equal the sponsor address. Out of 48,521 addresses (0.3%) — cosmetic.

### F9 — OPERATIONAL

* **Nothing reviews the review queue**: 1,528 direction flags, 0 reviewed.
* **No accuracy test runs against the documents themselves.** `check_doc_category.py` tests the correction functions, not the stored data. This audit's harness is the first measurement against the stored table.
* Hillsborough 'FIN' (UCC) rows: 31,563 read but excluded by design — consistent with Miami-Dade 'FST'. Correct.

---

## Recommended fixes, in order (each is a separate, reviewable change)

| # | Fix | Where | Effect | Risk / cost |
|---|---|---|---|---|
| 1 | **Make `llm` and `manual_override` entity types survive the nightly rebuild** (don't overwrite them in the `entity_classifications` upsert; read them back as the preferred source) | `normalize.py` | Ends the weekly 20% swing; restores Private Credit, Market Transfers, Overview tiles | Low code risk; a rebuild; backup first |
| 2 | **Route outright-sale titles out of COLLATERAL** (title names a mortgage/note/security instrument and carries no pledge phrase → LOAN_TRANSFER); confirm pledge candidates from stored text for the Miami-Dade 749 | `extract_pdfs.py` (+ backfill script, `reread_documents`) | Adds ~1,500 real transfers (MD $29B) to the dashboard | Moves published numbers up; needs your approval of the rule and the new totals |
| 3 | **Extend the title rule to LOAN_TRANSFER → RENTS_LEASES** (title is rents/leases only, assignor is not an institution or title has no debt instrument) | `extract_pdfs.py` | Removes ~400 rows ($3–5B stated) from loan transfers | Moves numbers down; decide the lender-companion rule first |
| 4 | **Extend the direction check to Hillsborough** after a 40-document read to confirm the rate and the Hillsborough text patterns; keep 'flag' for Broward | `document_direction.py`, `normalize.py` | Fixes up to 1,334 Hillsborough rows | Needs stored text (fetch on demand) |
| 5 | Re-type Fannie/Freddie/FDIC/servicers (rule: GSE list + servicer list instead of behavioural `BANK`) | `normalize.py` overrides | Cleaner bank/servicer split | Judgment: owner's taxonomy |
| 6 | Show portfolio-level amounts as such (flag > $250M multistate/CLO, or divide) | dashboard/email | Stops single deals inflating monthly volume | Presentation decision |
| 7 | Review queue + a weekly **accuracy check** (run this audit nightly, alert on regression) | `collector/audit/` | Catches the next F1-type fault in a day | Small |

Order logic: **1 first** (pure code fix, restores last week's numbers, no judgement needed), then **2 and 3 together** (one backfill, one rebuild, one explained change in totals), then 4–7.

## What this audit did not do

* It read 194 of 180,399 documents. The hand-read verifies *that* rules are wrong, not the exact population rate; fixes 2–4 should each be followed by a fresh random sample (n≥100) and the harness re-run.
* Hillsborough and Broward have no stored OCR text, so text-level checks (S3) cover Miami-Dade only. Their category checks rest on titles.
* No new LLM calls were made; nothing was re-extracted.
* Entity types were judged from names and volumes, not from outside research; the taxonomy items (F6) are for the owner to rule on.
