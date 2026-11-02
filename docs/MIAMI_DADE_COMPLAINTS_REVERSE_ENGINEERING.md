# Miami-Dade Foreclosure Complaints — Reverse Engineering of the Existing Collector

Source reviewed: `Safe Harbor Equity_ Document Processing Outputs (4).xlsx` (the other collector's output).
Status: **spreadsheet-only analysis. NOT yet verified against the PDFs** (Drive links return 404 without the owner's login; see §7).

## 1. What the workbook is

| Tab | Rows | What it is |
|---|---|---|
| Complaints | ~7,800 (all counties) | One row per complaint PDF. 24 extracted fields + 7 workflow columns + valuation/LTV formulas |
| PropertyRadar | ~8,200 | One row per subject address: PropertyRadar subject data + 3 comps + calculated $/sqft |
| Mortgages / Assignment / Collateral Assignment / Loans | <1,000 | Other doc types (Official Records style). Out of scope here |
| Lido Backend Updates | 2 | Change log. Key entry: the criteria change of 4 Nov 2024 (§4) |
| PDFs with issues, 10042024 Audit, 11142024/11222024 Check | small | Manual QC (COUNTIF of PDF link against Complaints!Y) |

Complaints is multi-county (Kings, New York, Hillsborough, Orange, Broward, Palm Beach...). **Miami-Dade = 2,359 rows (~30%)**, county label is inconsistent ("Miami-Dade", "MIAMI-DADE", "Miami-Dade County", "MIAMI-DADE COUNTY, FLORIDA"). Normalise on ingest.

## 2. Field map: what comes from the PDF, what is computed

Everything in A–AD is LLM extraction from the PDF text (the model output is a JSON object; 15 rows contain the literal string `Invalid JSON input`, i.e. a parse failure was written into the cell).

| Col | Field | Format observed | Where in the complaint | Notes |
|---|---|---|---|---|
| A | Document Title | Caption as printed, mixed case ("VERIFIED COMPLAINT TO FORECLOSE MORTGAGE", "COMPLAINT TO FORECLOSE CLAIM OF LIEN AND FOR DAMAGES") | Caption/first page | 543 distinct strings. **Not usable as a classifier** — same type has dozens of wordings |
| B | County | Free text from caption | Court caption "IN THE CIRCUIT COURT OF THE ELEVENTH JUDICIAL CIRCUIT IN AND FOR MIAMI-DADE COUNTY" | Not normalised |
| C | Date Filed | date | Clerk e-filing stamp or signature date | Need to confirm which |
| D | Plaintiff | UPPERCASE as printed | Caption | Full trust/trustee wording kept |
| E–H | Plaintiff Attorney Name / Email / Phone / Firm | Email can hold several, `; ` separated | Signature block at the end | Email missing ("NA") on ~2,100 of 7,800 rows. Designated service emails are included |
| I | Defendant | Multiple, separated by `;` + `\n\n\n` | Caption | Includes "Unknown Tenant", "John Doe", HOAs, City of Miami |
| J | Property Address | Single address, or several joined with `;\n\n\n` (68 Miami rows) | Property description paragraph | `NA` when only a legal description or unit number is given. This is the **join key to PropertyRadar** |
| K | Property Legal Description | As printed incl. Plat Book/Page | Property description / Exhibit | Multiple parcels joined the same way |
| L | Original Loan Amount | float | Allegation: "On [date] Borrower executed a Note in the principal amount of..." | |
| M | Original Loan Date | date | Same paragraph | |
| N | Original Loan Note Rate | text with unit: "10% per year", "12.00% per annum" | Note allegations | Text, not numeric. Unit wording varies |
| O | Maturity Date | date | Note allegations | `NA` on ~1,400 rows (mostly HOA/lien cases with no note) |
| P | Guarantor | `; ` separated names | Guaranty count / guaranty exhibit | `NA` for 4,500 rows — only populated on commercial deals |
| Q | Default Reason | Free-text sentence | Default paragraph | Paraphrase of the complaint |
| R | Default Date | date | "due for the [date] payment and all subsequent" | |
| S | Unpaid Balance(s) | **Mixed**: bare float, or "$483,671.03; $26,155.90" list of components | Damages paragraph: "principal balance of $X, plus interest, plus..." | Only the principal-type amounts, not interest/fees |
| T | Sum of Unpaid Balance(s) | float; `NA` when nothing | **Computed** from S (equals S on 2,134 of 2,359 Miami rows; sum of components on the rest) | Must be recomputed in code, not LLM |
| U | Default Rate | Text: "18% per annum", "5.000% of overdue payment", also bare `0.05` | Late-charge / default interest allegation | Two different concepts mixed: interest rate vs late fee percent. Needs splitting |
| V | Right To Reinstate | Yes/No | Whether the complaint or Note gives a reinstatement/cure right | Yes on ~42%. Tied to residential owner-occupied |
| W | Fannie Mae / Freddie Mac Incl.? | Yes/No | Mention of Fannie/Freddie/HUD in the loan | |
| X | SBA? | Yes/No | Mention of SBA | |
| Y | PDF Link | Drive URL | n/a | Dedupe key (the Audit tabs COUNTIF on it) |
| Z | Meets Criteria? | "Meets criteria" / "Does not meet criteria" | **Computed rule** (§4) | `#VALUE!` when T was text |
| AA | Plaintiff Attorney Email Sent? | `success` / `-` / error string | Workflow state of the outbound email | 335 Miami rows sent. Not a collected field |
| AB | Processing Log | date | Date the PDF was processed | Lag vs Date Filed is the pipeline latency |
| AC | Pages Processed | float, **capped at 50** (1,696 rows = exactly 50) | Page count fed to the model | Long complaints are truncated at 50 pages. Fields in later exhibits can be missed |
| AD | Priority # of the Plaintiff as Lender | 1.0 (1,869), 2.0 (21), 0.0, 3.0, NA | Lien-priority language | Has a paired Source column |
| AE | Priority ... Source | One sentence quoting the page and words | The supporting quote | Good: audit trail with page number. Keep this idea |

**Cols AF–AN (valuation) are not from the PDF.** They are Google Sheets ARRAYFORMULA lookups into the PropertyRadar tab keyed on Property Address (J), split on `;`, one value per address:
- AF "Likely land deal", AG/AH median/mean value from $/sqft, AI/AJ median/mean value from $/lot-sqft, AK–AN = Sum of Unpaid ÷ each valuation (LTV).
- PropertyRadar tab: subject (sqft, lot, year built, type, zoning, last sale, owner, APN, units, taxes) + 3 comps (address, sqft, sale date, price, $/sqft, year, lot, type) → median/mean $/sqft × subject sqft.
- The cached values show many rows "Subject address sq. footage not found in PropertyRadar", so valuation coverage is partial. Valuation depends on the address extraction being clean enough to geocode.

## 3. Cleaning conventions the old collector follows (replicate or improve)
- Absent = `NA` (string), sometimes `-`, sometimes blank. Three spellings of missing. Use NULL in our DB.
- Dates: real dates in most rows; 2 Miami rows have text dates.
- Multi-valued fields use `; ` or `;\n\n\n`. We should store these as child rows or arrays.
- Money: mix of float and "$x; $y" text. Store numeric components + computed total.
- Rates: store `rate_pct` numeric + `rate_basis` text.

## 4. Decision rule (reverse-engineered, tested on 2,271 Miami rows processed after 4 Nov 2024)
Original (before 4 Nov 2024, per Lido change log): Reinstate = No AND SBA = No AND Fannie = No AND Freddie = No AND Sum of Unpaid ≥ $500,000.
Current: **Reinstate = No AND Sum of Unpaid ≥ $500,000**.
Test: 287 rows match "No/No/No ≥500k → Meets". Exceptions are explained: 18 Yes/Yes rows and a few SBA/Fannie rows were back-filled to "Meets" when the rule was loosened. Only ~48 of 2,341 rows (2%) deviate from the old rule, and they are the re-scored ones. Note the current sheet still shows 213 rows with Fannie = Yes and ≥$500k as "Does not meet" — those are not re-scored, so the label column is stale in places. **Our pipeline should compute this label from the stored fields, never store it.**

## 5. What the Miami-Dade data contains vs. what the owner wants
The workbook has no homestead or commercial flag. Miami rows are a mix: commercial notes, residential mortgages, HOA/condo lien foreclosures ("Complaint to foreclose claim of lien"), timeshare liens. Only ~13% of rows meet the criteria.
The Clerk classifies circuit-civil foreclosures by case type (my understanding: Homestead Residential, Non-Homestead Residential, and Commercial Foreclosure, each split into dollar tiers). If the Clerk exposes that type, **filtering at the Clerk gives us exactly "non-homestead + commercial" before any PDF is downloaded**, and removes the HOA/lien noise. To be confirmed on the live site.

## 6. Proposed shape of the new pipeline (nothing built yet)
1. **Discover**: Clerk civil case search by case type + filing date range → case number, parties, filing date.
2. **Fetch**: the initial complaint PDF per case (from the docket).
3. **Extract**: text first (pdftotext/OCR), then one LLM call with a strict JSON schema (§2 fields), page limit raised above 50 or chunked, with a quoted-source field for the critical numbers.
4. **Compute in code**: unpaid sum, criteria label, dedupe, county normalisation.
5. **Value**: PropertyRadar API by address → comps → LTV (same maths as AG–AN).
6. Runs on the droplet via cron/PM2.

## 7. Open items before building
1. **PDFs.** The Drive links are private. Need ~15–20 sample Miami-Dade PDFs (mix: commercial with guaranty, residential non-homestead, an HOA lien case, a 50-page-capped one, an `Invalid JSON input` one) so each column can be checked against the source text. Without that, §2 "where in the complaint" is inferred, not confirmed.
2. Does the Clerk's civil search expose case type and download the complaint PDF without login/CAPTCHA (and any fee)? Not yet tested — `www2.miamidadeclerk.gov/ocs` is a JavaScript app.
3. Which model to use for extraction (the existing collector runs on OpenAI, and gpt-4.1-nano was shut down on 24 Oct 2026).
4. Should the old criteria (Reinstate = No, ≥ $500k) carry over unchanged?
5. Is the PropertyRadar API key in hand, and what is its per-call cost at ~2,300+ addresses?

## 8. Clerk access findings (2 Nov 2026) — scraping the public site is not a viable route
- `www2.miamidadeclerk.gov/ocs` (Civil, Family and Probate Courts Online System) is gated by reCAPTCHA / Cloudflare Turnstile for anonymous users and applies search limits; registering or logging in avoids both. We do not bypass CAPTCHAs or create accounts on the owner's behalf.
- The site's notice limits use to personal, non-commercial use and forbids reproducing, storing or redistributing content without the Clerk's written permission. It points commercial users to the Clerk's "Commercial Data Services" site (`www2.miamidadeclerk.gov/Developers`).
- **Official commercial channel (listed prices, to be confirmed with the Clerk):** Civil Court data via APIs and/or bulk files. Bulk files over FTP: $110 per folder per month, prepaid. APIs: $0.20 per request from a prepaid balance. Official Records images over FTP: $420 per month (that is the Official Records feed, not civil complaints).
- Not yet known: whether the civil API/bulk folders include the complaint PDF itself or only case index data (parties, case type, dates). This decides whether we still need a separate image fetch.
- This mirrors the Broward and Palm Beach decisions: use the county's paid/official feed rather than scraping.

## 9. Clerk OCS walkthrough with the owner's login (2 Nov 2026) — discovery works, document images not yet
Logged in (owner signed in manually; no credentials handled by Claude).
- **File Date search** (`/ocs`, Multiple Case Search → File Date): inputs are Filing Date From/To (required), Case Type, Section. Returns a case list: case name, local case number (`2025-017183-CA-01`), state case number (`132025CA01718301GE01`), section/judge, case type code (`CA070`), filing date, status.
- **Case types (select value IDs):** `RPMF -COMMERCIAL` 27185, `RPMF -NON-HOMESTEAD` 27187, plus dollar-tier variants (`...($250,000 OR MORE)` 25886 commercial, 25891 non-homestead, and $50,001–249,999 / $0–50,000 tiers), `RPMF -HOMESTEAD` 27186, `RPMF -OTHER ACTION` 27188, and legacy "Z DO NOT USE" types. **The tier variants returned 0 results for a day where the parent type returned the case, so current filings use the parent types 27185 and 27187.** This confirms the Clerk itself separates commercial / non-homestead / homestead, which is the owner's filter.
- **Proof against the spreadsheet:** commercial search for 1–7 Sep 2025 returned 5 cases, including TRYON STREET ACQUISITION TRUST I vs UGP 36 NE 65TH LP et al, filed 09/03/2025 — the same filing the workbook has (plaintiff attorney Ronald B. Cohn, Burr & Forman).
- **Case page:** details, Related Cases, Hearings, Parties (10), Dockets (391 entries, DIN / date / book-page / entry / event type / comments, sortable, CSV download). Docket entries 1–6 of that case: Civil Cover Sheet, Complaint (DIN 2), Certificate of Possession of Note, Email Notice, Lis Pendens (book/page 34929/516). Parties and plaintiff attorney email are visible here without any PDF.
- **No document links appear in the docket table** (plain `<td>` rows, no anchors). My Desk shows the account uses prepaid **units** ("Purchase Units", "View Unit Usage History"), so document images are probably pay-per-view. Not tested: no units purchased, nothing downloaded.
- Implication: the Clerk list can replace much of discovery and several extracted fields (case type = non-homestead/commercial, filing date, parties, attorney email), leaving the complaint PDF for the loan fields (amount, dates, rate, default, guarantor, reinstatement).
- Open: how the other collector gets the complaint image (which URL / which account), and the unit cost per image.

## 10. First field-by-field check against a real complaint (2 Nov 2026)
**How the PDF is reached (supersedes the "no document link" note in §9):** on the case page, the Dockets table has an **Image** column. A file icon ("Open docket entry file") on each entry opens `https://www2.miamidadeclerk.gov/ocs/pdfHandler?qs=<encrypted token>`, a viewer titled with Document Name / Case Number / DIN. It opens on the "Order Certified Copies" tab (paid; not used) — click "Document Image" for the free public view, watermarked "NOT AN OFFICIAL COPY - PUBLIC ACCESS". The docket table in my first read had no Image column; it appeared on a later load while signed in, so a collector must wait for it. The `qs` token is encrypted per document, so it must be obtained by clicking the icon, not constructed. The text layer is real text (no OCR needed); the viewer renders pages lazily, so the collector should download the PDF rather than read the screen. Unit cost per view: not verified.

**Case checked:** 2025-017183-CA-01, Tryon Street Acquisition Trust I v. UGP 36 NE 65th LP, complaint DIN 2 (140 pages), against the workbook row.

| Workbook field | Value in sheet | What the PDF shows | Result |
|---|---|---|---|
| Document Title | VERIFIED COMPLAINT FOR FORECLOSURE AND DAMAGES | Caption title | Match |
| Plaintiff / Defendant | Parties from the caption, `;` joined, "JOHN / JANE DOE" | Caption, p.1 | Match (tenant description dropped) |
| Date Filed | 2025-09-03 | Footer stamp "E-Filed 09/03/2025 11:39:58 AM" on every page | Match — **source is the e-filing footer** |
| Original Loan Amount | 2,982,000 | ¶8 "$2,982,000.00" | Match |
| Original Loan Date | 2022-12-22 | ¶8 Note dated December 22, 2022 | Match |
| Maturity Date | 2025-07-01 | ¶16 latest extension to July 1, 2025 | Match — **takes the last extension, not the original maturity** |
| Guarantor | Bayles; Arutyunyan | ¶4 defines "the Guarantors" | Match |
| Default Reason | Paraphrase of missed May/June 2025 payments, July 1 balloon, 2023–24 taxes | ¶18 | Match (near-verbatim) |
| Default Date | 2025-07-01 | ¶18 gives May 1 2025 (first missed payment) and July 1 2025 (balloon) | **Judgment call** — the model chose the balloon date. Needs a written rule |
| Unpaid Balance(s) | 2,944,880.3 | ¶20 "$2,944,880.30" | Match (principal only) |
| Priority # = 1, with quoted source | "page 5... 'subject, subordinate, and inferior...'" | ¶22 on page 5, same wording | Match — page cite is accurate |
| Property Address | 36 NE 65th Street, Miami, FL 33138 | Complaint heading says **"36 N.W. 65th Street"**; the later filings say NE | **Mismatch** — the sheet value is not what the complaint printed. Full analysis in §11 (why, what is unproven, proposed two-field rule) |
| Pages Processed | 50 | **140 pages** | Confirms the 50-page cap truncates long complaints |
| Legal description (Lots 53, 54, 67, 68, Liberty Park), Note rate 10%, Default rate 20%, Attorney name/email/phone/firm | as listed | Not in the body text I could load: legal description, rates and default rate come from the exhibits (Note, Mortgage); attorney block is at the end | Not yet checked (needs the full 140-page PDF) |
| Right to Reinstate / Fannie-Freddie / SBA = No | No | No mention in the body | Consistent (absence = No), not independently verifiable |

**What this tells us for the build:**
1. Rate, default rate and legal description live in the exhibits, so the page cap matters; extract the body, the Note, the Mortgage and the signature block, not the first 50 pages blindly.
2. Define rules for the two judgment fields (Default Date, address when the complaint has a typo).
3. The Clerk list already gives case type, filing date and parties, so those fields can be cross-checked against the PDF for free.

## 11. The address discrepancy in detail (case 2025-017183-CA-01) and a larger finding about scanned pages
**What each source says (all read from the complaint PDF's text layer unless stated):**
| Where | Text | Is it the property address? |
|---|---|---|
| Complaint p.1, title block under the caption | "(36 **N.W.** 65th Street, Miami, FL 33138)" | Yes — the only place in the complaint body that gives a street address. **Printed once.** |
| Caption and body, ¶2 and elsewhere (pp.1, 8, 9) | "UGP 36 **NE** 65TH LP" | No — this is the borrower's **name**, not an address |
| Loan Extension Agreement, pp.86–91 | "UGP 36 NE 65th LP"; page footer / file name "36_NE_65th_St" | Borrower name and a file name, not a printed address |
| Later filings in the same case (final judgment, proof of service, seen in the viewer for DIN 375) | "36 NE 65th Street" / "36 N.E. 65th Street" | Yes — the court and the plaintiff's own later filings use NE |
| Workbook | "36 NE 65th Street, Miami, FL 33138" | — |

**Why they differ — what is established and what is not.**
- Established: the complaint itself contains "N.W." exactly once, in the title block; every NE in the complaint's text layer is the borrower's name; the plaintiff's own later filings say NE. So the complaint's N.W. looks like a typo, and the true address is very likely NE.
- **RESOLVED later the same day (see §12.4): the complaint's own Note and Mortgage exhibits say "36 NE 65th Street" (Note p.17, Allonge p.23, Mortgage pp.25–29, Loan Agreement p.54), so the old collector followed the exhibits, not the typo in the title block.** The three candidate explanations below were written before the exhibits had been OCR'd; #1 is the one that fits.
- ~~Not established: how the old collector arrived at NE.~~ I could not see its prompt or code. Candidate explanations, none proven:
  1. The model took the address from an exhibit (Note, Mortgage, or the title-insurance/loan pages), which in this PDF are scanned images that I could not read from the text layer.
  2. The model "corrected" the typo itself, by matching the street words in the borrower's name ("36 NE 65TH LP") to the title-block address.
  3. The workbook row was built from a different PDF than DIN 2 (the case has amended complaints, DIN 345 is a Second Amended Complaint). The Drive link in the sheet cannot be opened without the owner's Drive login, so which filing the row came from is unconfirmed.
- Test that would settle it: run the old extraction prompt on this exact PDF and see whether it returns NW or NE; or open the sheet's own Drive PDF and look at which filing it is.

**Rule to decide before building (owner decision):**
- Store **two** values: `property_address_as_printed` (N.W.) and `property_address_reconciled` (NE), with `address_source` and a flag `address_conflict = true` when they disagree.
- Reconcile against, in order: the Mortgage exhibit address, the legal description / folio from the Property Appraiser, the borrower's entity name, later filings. When no second source exists, keep as printed and flag it.
- Why it matters: the address is the join key to PropertyRadar. NW and NE 65th Street in Miami are different parcels, so a wrong quadrant produces a wrong valuation and wrong loan-to-value, silently.

**Larger finding: most of the complaint is scanned images.** In this 140-page PDF only pages 1–10 (the complaint body) and 86–91 (one typed agreement) have a text layer. Pages 11–85 and 92–140 — the verification page, the Note, the Mortgage and the other exhibits — are image-only. Consequences:
- The fields that live in exhibits (note rate, default rate, legal description, the mortgage's property address, loan amounts on later agreements) cannot come from plain text extraction. The pipeline needs OCR or a vision model on the scanned pages, and a page-selection step (find the Note and Mortgage first pages) instead of a 50-page cut-off.
- The old tool's value for "Original Loan Note Rate = 10% per year" and "Default Rate = 20% per year" therefore had to come from reading images (or from text elsewhere). That still needs checking against the Note page itself.

## 12. Understanding the complaints — both categories (5 complaints read, 2 Nov 2026)
Purpose: confirm we understand the document before building extraction. Sample: all filed 1–4 Sep 2025 in Miami-Dade circuit civil. PDFs saved locally for the build (scratchpad `pdfs/`, not in the repo).

| # | Case | Clerk type | Pages | Complaint kind | Text layer |
|---|---|---|---|---|---|
| C1 | 2025-017183-CA-01 | RPMF-Commercial (CA070) | 140 | Commercial loan, 2 guarantors, 8 exhibits (Note, Mortgage, Loan Agmt, extensions...) — $2.98M | Body pp.1–10 readable; exhibits scanned (one typed agreement pp.86–91) |
| C2 | 2025-017324-CA-01 | RPMF-Commercial | 42 | Securitization-trust investor loan, $885,500 note, LLC borrower | Body pp.1–7 readable; exhibits (pp.8–42) scanned |
| C3 | 2025-017326-CA-01 | RPMF-Commercial | 62 | Same template (same law firm), $204,700 note on a single condo unit held by an LLC | Body pp.1–7 readable; exhibits scanned |
| N1 | 2025-017063-CA-01 | RPMF-Non-Homestead (CA076) | 21 | Hard-money lender vs. LLC borrower + 2 guarantors, $300,000 | **Text layer present but scrambled** (font-encoding cipher, e.g. "Miami-Dade County" comes out as symbols) — needs OCR |
| N2 | 2025-017282-CA-01 | RPMF-Non-Homestead | 30 | Servicer foreclosing a residential loan, $351,980.83 principal | **No text layer at all** (pure scan) — needs OCR |

### 12.1 What the Clerk's case type does and does not tell us
- "Commercial" and "Non-Homestead" are the **filer's choice at filing**, not a property-type finding. Commercial includes a $204,700 single-condo loan (C3) and a $885,500 investor loan (C2); non-homestead includes a servicer's ordinary residential mortgage (N2, where one defendant "may claim homestead rights") and a hard-money business loan (N1).
- So the Clerk type is a good **first filter** (≈19 filings in the week of 1–7 Sep 2025: 14 non-homestead, 5 commercial), and the existing economic filter (principal ≥ $500,000, no right to reinstate) must still be applied from the PDF. Three of these five fall under $500k.

### 12.2 Anatomy of a Miami-Dade foreclosure complaint (consistent across all five)
1. **E-filing stamp** — `Filing # 230595253 E-Filed 09/01/2025 12:32:27 PM` on every page. This is the source of Date Filed (and agrees with the Clerk list).
2. **Caption** — court, `CASE NO.:` (blank at filing in N1/N2/C2/C3), plaintiff (often a trust "not in its individual capacity but solely as owner trustee", or a servicer), defendants (borrower, guarantors, associations, "unknown tenant/spouse").
3. **Title** — varies: "Verified Complaint for Foreclosure", "...to Foreclose Mortgage and for Other Relief", "...for Foreclosure of Mortgage". Same filing type, different wording; do not classify by title.
4. **Body**, in this order: parties/jurisdiction → the Note (date, original principal, original lender, holder) → the Mortgage (date, recording book/page) → the property (legal description in C1/C2/C3/N1; **absent in N2**) → guaranty (C1, N1) → default (missed payment date, maturity) → acceleration → amount owed ("principal sum of $X plus interest from…") → junior lienholders/tenants → fees. Counts: foreclosure; often also a count on the Note and on the guaranty (C1, C2, N1).
5. **Verification** page (signed), then the **attorney signature block**: firm, bar number, phone, primary and secondary service emails.
6. **Exhibits** (the bulk of the pages): Note, Mortgage (often "Composite Exhibit A"), guaranty, assignments, modification/extension agreements, notice of default. Almost always **scanned images**.

### 12.3 Where each field actually lives
| Field | Body | Exhibits | Other |
|---|---|---|---|
| Date Filed | e-filing stamp | | Clerk list |
| Plaintiff, defendants, title, court | caption | | Clerk list (names) |
| Attorney name, firm, phone, emails | signature block (end of body) | | Clerk docket "Email Notice" entry |
| Original loan amount, loan date | ¶ on the Note (all five) | Note | |
| **Note rate, default rate** | **not in the body** (C1: no) | Note ("Default Rate…20%", "10.00% per annum" in an extension) | |
| Maturity date | sometimes (C1 ¶16 latest extension) | Note (original maturity; C1: July 1, 2024) | |
| Guarantor | defined in body (C1, N1) | Guaranty | |
| Default reason / date | body ¶ — **may give several dates, even conflicting ones** (C2: payment due 1 Mar 2025 in the mortgage count, 1 Dec 2024 in the note count) | | |
| Unpaid balance | body "principal sum owed" (all five) | | |
| Legal description | body in C1/C2/C3/N1; **missing in N2** | Mortgage | |
| **Property street address** | **inconsistent** (§12.4) | Note + Mortgage "Property Address" | |
| Right to reinstate, Fannie/Freddie, SBA | rarely stated | Note/Mortgage terms; absence = No | |
| Lien priority (# and source) | "subject, subordinate and inferior to the lien of Plaintiff" paragraph (all five) | | |

### 12.4 Property address — what each complaint actually does (the owner's concern)
The address must be the property **this complaint is foreclosing**, taken from the complaint document itself (body or its attached exhibits), never from another filing, another case, the borrower's name or outside data.
| Case | In the body | In the complaint's Note/Mortgage exhibits |
|---|---|---|
| C1 | Title block only, typed "(36 **N.W.** 65th Street, Miami, FL 33138)" | **"36 NE 65th Street, Miami, Florida 33138"** in the Note (p.17), Allonge (p.23), Mortgage (pp.25–29, "commonly known as"), Loan Agreement (p.54) |
| C2 | Legal description only (¶2) | "1459 Northwest 2nd Street, Miami, Florida 33125" in the Mortgage (pp.8, 14, 15) |
| C3 | Condo unit legal description only (¶2) | "1100 SOUTH MIAMI AVENUE, Miami, FL 33130" ("Property Address", p.19) |
| N1 | Legal description + "which has the address 8788 West 35th Court, Hialeah, FL 33018" (¶11) | (not read) |
| N2 | **Nothing — no address and no legal description** | Note p.6 "3038 SW 7TH ST, MIAMI, FLORIDA 33135 [Property Address]"; Mortgage p.13 "which currently has the address of 3038 SW 7TH ST"; one Note page prints the same property as "3038 7th St SW" |

**Conclusions:**
1. In 3 of 5 complaints the body has **no street address at all**; it only appears in the Note/Mortgage exhibits, which are scanned. In N2 the body has not even a legal description. An extractor that reads only the body text will return a blank address for these — which matches the 234 `NA` addresses in the old sheet.
2. **This explains the NW/NE difference in C1.** The title block (typed by the attorney) says N.W.; all four loan documents the complaint attaches say NE. The old collector's "NE" agrees with the exhibits. The N.W. is a typo in the complaint's own title block.
3. The same property can be printed in different word orders ("3038 SW 7TH ST" vs "3038 7th St SW"; "Northwest 2nd Street" vs "NW 2nd St"). Compare addresses after normalising, never as raw strings.

**Address rule (supersedes the earlier proposal):**
1. `property_address` = the "Property Address" of the **Mortgage exhibit attached to this complaint** (the instrument being foreclosed); if the Mortgage page cannot be read, the Note exhibit's Property Address.
2. If the body states an address and it disagrees after normalisation, keep the body text in `property_address_body`, set `address_conflict = true`, and still use the exhibit address as `property_address`.
3. If the complaint has no readable address anywhere, `property_address` = NULL with a reason code (never guess, never fill from PropertyRadar, the Property Appraiser, or other filings). The legal description is stored separately and is the fallback for a later, clearly labelled, lookup.
4. Always store `address_source` (body / mortgage exhibit p.N / note exhibit p.N).

### 12.5 Consequences for the extraction pipeline (confirmed by the five samples)
- **OCR is mandatory.** Three text-layer states occurred in five files: readable body + scanned exhibits (C1–C3), scrambled text layer (N1), no text layer (N2). Detect per page (readable-word ratio) and OCR any page that fails; do not trust a text layer because it exists.
- **Page selection, not a page cap.** Locate: caption/title, the body pages, the signature block, then the first pages of the Note and Mortgage (their pages start with "Exhibit A/B", "SECURED NOTE", "MORTGAGE"). C1 shows what a 50-page cap loses (its default-rate page was p.19 but the 10% rate confirmation is on p.80 and the Loan Agreement on p.52+).
- **Two-stage extraction:** body fields from the body; rate/default-rate/maturity/address/legal description from the exhibits; keep the page number of each value as the source (the old sheet already does this for lien priority).
- **Rules to write down:** Default Date when the complaint gives several dates (C2); which maturity (original vs latest extension); "unpaid balance" = principal only vs principal + deferred (N2 has $351,980.83 plus $44,771.54 deferred principal).
- **Case type from the Clerk list** can be cross-checked against the complaint's own counts ("foreclosure of non-homestead property" appears verbatim in N1).

### 12.6 Mechanics of fetching (for the collector build)
- Search API used by the site (observed): `POST /ocs/api/CaseInfo/PostSearchByFiledDate` with `{"filingDateFrom":"2025-09-01T00:00:00.000Z","filingDateTo":"2025-09-07T00:00:00.000Z","caseType":"27185","section":0}` (27185 commercial, 27187 non-homestead). **A single-day range (From = To) returns zero; use To = the next day.**
- The case page then calls `PostSearchByCaseID?caseID=…` and `GetSingleCaseResult`; the docket icon calls `GetSDocumentByEvent?qs=…`, which yields `CaseInfo/image?imagePath=…` returning the PDF bytes (`application/pdf`, 3–16 MB observed). Needs the signed-in session cookie.
- Docket order is stable: DIN 1 Civil Cover Sheet – Claim Amount; DIN 2 Complaint; DIN 4 Certificate of Possession of Note; DIN 5/6 Lis Pendens (with Official Records book/page). The Complaint is the earliest docket entry named "Complaint".
- Viewing is free with the account; "Order Certified Copies" is the paid path and was not used.

## 13. Owner decisions (2 Nov 2026)
1. **Address rule approved** (§12.4): the Mortgage exhibit attached to the complaint is authoritative; the Note exhibit is the fallback; a differing body address is stored separately with `address_conflict = true`; NULL with a reason code when nothing is readable; never filled from outside data.
2. **Case-type approach approved:** the Clerk case type (RPMF-Commercial 27185, RPMF-Non-Homestead 27187) is the first filter; the PDF-derived criteria (no right to reinstate, principal >= $500,000) are applied afterwards and computed in code, never stored as a label.
3. Still open before build: Default Date rule when a complaint gives several dates; original vs extended maturity; whether "unpaid balance" includes deferred principal; cost per image view; PropertyRadar key and cost.
