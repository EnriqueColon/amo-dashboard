# QC fix list — weekend of 18–21 Sep 2026

QC run `20260917T2100Z` (Thu 5:00 PM ET, finished in 8 min). Reviewed Fri 18 Sep, ~9:30 AM ET.
Everything below is read-only verification. **Nothing has been changed and nothing will be until you confirm.**
I read 9 documents myself and re-ran the key counts on this morning's data.

---

## 1. Bottom line

- **The tool is running well. Two display problems are bigger than they looked.** The dashboard, the exports, the email build, backups and the weekly collection all check out. About **1 in 4 Miami-Dade transfers shows the wrong seller**: either the two sides are swapped (~7,500 rows, already planned), or a **homeowner appears as the seller** (~7,700 rows, new).
- **The homeowner problem is new and it's real.** I read 3 of these documents. Each one names a real seller, such as "MERS as nominee for Caliber Home Loans" or "Forethought Life Insurance". The dashboard shows the borrower instead. Tuesday's fix only covered sellers it recognised as banks, so these rows slipped through.
- **6 fixes for this weekend.** All six go into the one planned rebuild. None needs its own long job.
- **Schedule still fits, but the clock is running.** The weekend job has been waiting for your confirmation since 2:05 AM ET. Friday's collection finished at 6:05 AM ET. If you confirm by about noon ET, the work finishes around 1 AM ET Sunday, about 12 hours ahead of Sunday afternoon.

---

## 2. Confirm for this weekend

All six go into the **same single rebuild** (~1.5 h, dashboard blank while it runs). All are permanent code changes, so the nightly 4:30 AM rebuild won't undo them. They're built Friday while the re-read runs, so none of them lengthens the weekend.

| # | Problem (real numbers) | Why it matters | Fix | Adds | Risk | How we verify |
|---|---|---|---|---|---|---|
| **1** | **Seller and buyer swapped.** Miami-Dade's county index sometimes lists the two parties backwards. Exact reverse: **3,566 rows**. Reverse with a spelling difference: **3,912 rows**. That's **7,478 rows (13.6% of Miami-Dade)**. QC sample: 16 of 20 and 12 of 25 flagged reversed. I read 2 more: both reversed (Rushmore→Nationstar shown as Nationstar→Rushmore; A&D Mortgage→Anchor Bank shown the other way). | The top relationships are backwards. "Nationstar → Wells Fargo 283" is really Wells Fargo → Nationstar. | *Already agreed.* Re-read every Miami-Dade document (~54,600, ~33 h). Take the direction from the document and the spelling from the index. Rows where they disagree go to "Needs review". | 0 (already scheduled) | Medium (biggest change) | Before/after counts per bucket. Re-read ~10 of the documents listed here. The "Wells Fargo → Nationstar" direction must flip. |
| **2** | **Homeowner shown as the seller.** **~7,700 Miami-Dade rows (~14%)**: 4,330 where the document's seller is MERS, 3,372 where it's another company (life insurers, the FDIC, Reverse Mortgage Funding, etc.). I read 3: `2023R100219`, `2025R944628`, `2026R68031`. All three show a borrower; the documents name a lender. In a random sample of 20, ~17 were clearly this. In ~3, the document's "seller" was actually the buyer. | The Assignor column and seller rankings list private individuals (a privacy issue too). The rows are also counted as "originations" instead of what they are. | Extend Tuesday's rule. When the index name is a person and the document names a company or MERS, show the document's party. **Guard:** skip the swap if that party is the same as the buyer (that would create a fake self-transfer). | ~2–3 h build + dry run | Medium-low (narrow extension of an already-tested rule) | Dry run first. The 3 documents above must change. Re-read 10 random changed rows. Self-transfers must not jump. |
| **3** | **MERS counted as a bank that sells loans.** MERS is a registry that holds loans in name only. It's typed "BANK" because a stored classification overrides the code, which already says MERS. So **2,867 MERS filings count as market sales** (2,758 on Thursday's data), MERS ranks **#2 seller** after Wells Fargo, and the "MERS release" category fires **6 times** in total. | Market transfers are inflated ~8%, and a registry sits near the top of the seller rankings. | Code rule: MERS is always type MERS, whatever the stored classification says. Together with #2, MERS rows move to "MERS release" (roughly 7,000 rows once #2 is in). | ~1 h | Low | MERS disappears from the top-sellers list. Market-transfer count drops by about the MERS amount. Guardrail tests pass. |
| **4** | **One company under several names.** Only the clear-cut cases: FaceBank ×3 (70 / 59 / 31), Benworth Capital (84 / 80), Homebridge "FINCANCIAL" (27 → 222), Rushmore ×3 (452 / 22 / 21), First Citizens "&" vs "AND" (78 / 20), Wilmington Savings Fund "…TRU" (62 → 404), Wilmington Trust "…TRU" (20 → 117), Chase Home Lending 2023-RPL1 "MTG" vs "MORTGAGE" (81 / 21). | Mid-tier rankings undercount these firms. | Add name aliases. **Not merged** because they really are different firms: Citibank vs CIT Bank, Civic vs CV3, My Mortgage vs TY Mortgage, Churchill MRA, Headlands/Legacy trust series. | ~1 h | Low | Each firm appears once with the combined count. The guardrail test for name handling passes. |
| **5** | **Real lenders labelled "Other".** Now only **8 of the 40 largest** (Thursday: 28; Friday's automatic re-typing fixed most). Still wrong: Casa Finance Group 118, FaceBank (fixed by #4), National Homebuyers Fund 31, Mortgage Assets Management 28, Newtek 26, International Mortgage Brokers 16. | Skews the transaction-type mix a little. | Add code patterns (not stored labels) so the weekly re-typing can't undo them. | ~30 min | Low | Those names show a lender type after the rebuild. |
| **6** | **7 Miami-Dade documents marked "read" but never actually read.** | Their parties and amounts are missing (tiny). | Re-read those 7 during the apply step. | ~10 min | Very low | The guardrail check `check_extraction_completeness.py` goes green. |

**Build time Friday: ~5–6 hours total, done in parallel with the 33-hour re-read.**

---

## 3. Recommend for next week

These need investigation or their own job. Squeezing them in would put the weekend at risk.

| | Item | What I found | Next step |
|---|---|---|---|
| A | **23 truncated days (CAPPED)** | The biggest bulk-sale days hold 109–145 filings against a normal ~57. Collection already splits busy periods into single days (it did so this morning). These single days still exceed the portal's 500-row limit. | Test whether the portal can search by part of a day or by party. Size how many filings are missing. Then decide. |
| B | **Name the real lender behind MERS** | The documents say "MERS as nominee for [lender]" (4 of 4 I read). Our stored extraction kept that wording on only **4 of 2,915** MERS rows. | This weekend's re-read stores the full text. Pull "as nominee for X" from it and show X as the seller. |
| C | **The numbers shift every Friday with no code change** | Between Thursday's QC and this morning, market transfers went **31,095 → 38,312** and originations **14,289 → 11,054**. The cause is Friday's automatic re-typing of companies. | Add a weekly "what moved and why" check. Consider locking the types of the top ~200 firms. **Use this morning's numbers, not the QC's, as the weekend baseline.** |
| D | **8 business days with zero filings** | 6 of the 8 are almost certainly **county closures**. For each, three separate searches (mortgage assignments, other assignments, UCC), run months apart, all succeeded and found filings on neighbouring days but none on that day. 4 of the 8 fall on the 2nd Friday of May every year; 2024-10-10 is Hurricane Milton. **2024-05-10** is the only day never searched successfully (all searches errored). | Re-search 2024-05-10 (minutes). Ask the clerk about the May Fridays. Likely closures, not data loss. |
| E | **Lending-relationship reader "failing"** | **Not an outage.** The backlog was finished on 9 Sep, and new documents are still read (4 of 4 this morning at 4:20 AM ET). The same **14 documents** time out on every 20-minute run. One has been retried 3,843 times. The QC saw "0 processed" only because nothing else was waiting. | Stop retrying a document after ~5 failures. List the 14 so someone can fetch them by hand. |
| F | **"Collateral" category holds some non-loan pledges** | 6 of 20 sampled weren't loan pledges. I read `2024R311065`: a borrower pledging its permits, licences and rents to its own lender. | Reclassify by title, as done on 15 Sep. |
| G | **UCC page "Collateral" vs "Other" filter** | Both options return the same mix of filings. The tooltip already says so. | Redefine or remove the filter. |
| H | **Login returns an error on a blank request** | 84 times, last on 15 Sep. It's the wrong error code, not a security hole. | One-line fix at the next deploy. |
| I | **Loans over $1 billion (16) and under $1,000 (27)** | Large loans: not checked individually (**unverified**); dollar volume already counts each loan once. Small: the $10 ones are often real. I read `2024R214883`, a Habitat for Humanity mortgage that literally secures $10.00. | Spot-check 3 of the billion-dollar loans. Leave the small ones. |
| J | **QC tool's own noise** | Its direction check was wrong on all 3 flags I read (a correct row called "reversed", a reversed row called "confirmed", a reversed row called "different party"). It also counts the unused AIT type as errors. | Tune the QC before the next run. |
| K | **Housekeeping** | 9 old database copies take 1.8 GB (the disk is 7% used). | Delete after the weekend. |

---

## 4. Checked and fine

- **Dashboard:** all 37 screens respond, none slow. The three county views work. Reporting table = chart = CSV export (Miami-Dade 43,791; all 44,443). Clean Transactions = Overview (56,026). UCC table = UCC export (20,305). The Wells Fargo entity report adds up.
- **Data integrity:** 0 duplicate filings, 0 filings in two tables, 0 future dates, 0 same-company rows not marked as self-transfers, 7 rows with an unknown party.
- **Freshness:** Miami-Dade filings through 17 Sep (after this morning's collection: 560 new filings, 563 documents read). Broward is current to 14 Sep.
- **Miami-Dade documents read:** 72,828 of 72,839 (100%).
- **Property address** matched the document 41 of 41. **Loan amount** matched 67 of 69 (2 not found, unverified). Blank amounts (43%) are genuine: the documents state none.
- **AIT (Assignment of Interest):** the 126 "error" days aren't lost data. The county has **never returned a single AIT filing** since we started asking on 16 Jun. Before 9 Sep, "no results" was mislabelled as an error; it's now labelled correctly. AIT has no daily filings to miss.
- **Collection errors that really lost data:** only 3 day-and-type combinations (2024-05-10 ×2, 2026-05-08), and both dates are probable closures (item D).
- **Operations:** weekly collection ran this morning (finished 6:05 AM ET). The nightly rebuild ran (6:02 AM ET). Broward daily is OK. **Offsite backup ran** (Wed 11:15 PM ET, status OK). `.env` is locked down. No passwords in the git settings. The web server is up with no restarts.
- **Email:** Microsoft Graph login works, the report builds (514 transfers), both counties appear, hidden companies are excluded, and the Monday 9:00 AM ET send is scheduled. Nothing was sent.
- **Guardrail tests:** 14 of 15 pass. The one failure is the completeness check (fix 6).
- **Broward:** only 4.7% of documents read. This is blocked on the bulk image order from the county, not a bug.

---

## 5. Schedule impact

| Step | If you confirm by ~12 PM ET Fri |
|---|---|
| Re-read starts | Fri ~12 PM ET (weekly collection already done) |
| Fixes 1–6 built and tested | Fri afternoon/evening, in parallel |
| Re-read finishes (~33 h) + retry pass | Sat ~10 PM ET |
| One rebuild (~1.5 h) | Sat ~11:30 PM ET |
| Email end-to-end check | Sun ~1 AM ET |
| **Slack before Sunday afternoon** | **~12 hours** |
| Monday send | Mon 9:00 AM ET (automatic if both checks pass) |

- **Yes, it still fits with all six fixes.** Fixes 2–6 add build time on Friday but no time to the overnight chain.
- **Each hour you wait before confirming moves the finish by an hour.** Confirming by about **1 AM ET Saturday** still finishes by Sunday afternoon, with no margin.
- **If time gets tight, drop in this order:** 5, then 4 (both cosmetic). **Keep 1–3**: they change who is shown buying and selling.

---

Reply with the numbers you confirm (e.g. 'confirm 1–6'), or 'confirm all'.
