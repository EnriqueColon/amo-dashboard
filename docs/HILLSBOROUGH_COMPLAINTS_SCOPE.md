# Hillsborough County Foreclosure Complaints — Scope

**Status:** scoping only · **Written:** 3 Nov 2026 · **No code written, production untouched**
**Purpose:** hand-off for a new session. It records what was checked on 3 Nov 2026, what it means, what is still unknown, and what the owner has to decide. Read it with `docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md` (§12.4 rules, §17 approved rules, §18–§23 the build, audit and daily run).

---

## 0. In plain English

- **Finding the cases is easy and free.** The Clerk publishes a daily spreadsheet of every new Circuit Civil case, with the case type, the plaintiff and defendants (with addresses) and the attorney. Hillsborough even splits mortgage foreclosures by who owns the property (Commercial / Non-Homestead / Homestead) **and by the amount claimed**. Nothing to scrape, no login.
- **Getting the complaint document is the hard part.** Miami-Dade let our program sign in and download the PDF. Hillsborough's case-document site (HOVER) has a bot wall ("Access to this page has been denied"). We did not try to get past it and should not. The Clerk's own paid route (eCertify) is about **$8 + $1 a page per document**, and it is for certified copies.
- So the plan has two stages. **Stage A (no decision needed):** collect the case list every day. **Stage B (owner decision):** pick how to get the documents (§3). Until B is decided, the new tab can list Hillsborough cases but cannot say whether they qualify.
- Volume is small. In September 2026 there were about **84** Commercial and Non-Homestead foreclosures. Only about **46** claim $250,000 or more, which is the only band that can hold $500,000 of principal.
- Reading each complaint costs the same as Miami-Dade, about $0.27, so about $12 a month. The document route is the real cost.

---

## 1. What was checked (3 Nov 2026) — and what it showed

| Channel | What it gives | Usable by a program? | Evidence |
|---|---|---|---|
| **Daily filings file** `publicrec.hillsclerk.com/Civil/dailyfilings/CivilFiling_YYYYMMDD.csv` | Every new Circuit and County Civil case that day, one row per party: `CaseCategory, CaseTypeDescription, CaseNumber, Title, FilingDate, PartyType, FirstName, MiddleName, LastName/CompanyName, PartyAddress, Attorney`. Posted about 11 PM the same night. About 4 weeks kept online. | **Yes.** Plain HTTPS, no login, no captcha. | Fetched 30 Oct file: 978 rows. Folder listing 5 Oct–1 Nov. |
| **Monthly bulk files** `…/Civil/bulkdata/` | `Bulk Data Case File` (case, style, case type, division, filed date, judge, status), `Event File` (every docket event: code, name, date, party), `Party File`. One file per month, posted around the 10th for the previous month. **One year** kept. | **Yes.** Same. | Fetched the 10-10-2026 files (September filings). |
| **Docket events** (in the Event File) | Event codes such as `COMP` (COMPLAINT), `LIS PENDENS (RECORDABLE)`, `SUMMONS RETURNED SERVED`, `NOTICE OF VOLUNTARY DISMISSAL`. | **Yes.** Tells us a complaint was filed and when, **not** its contents. | Sep file: 4,153 COMPLAINT events, 1,961 recordable lis pendens. |
| **Undisposed and Disposed case lists** (`…/Civil/undisposed/`, `CircuitCivilDisposedCases`) | Weekly lists of open cases, and disposed cases. | Yes (status tracking). | Folder listing. |
| **HOVER** `hover.hillsclerk.com` | Case search by number, party or date; dockets; "non-confidential document images". | **No.** The home page loads, but the first search is answered with a bot-protection denial page (PerimeterX). Not bypassed. | Browser check, 3 Nov. |
| **eCertify** `hillsclerk.com/records-and-reports/ecertify` | Certified PDFs of whole documents, ordered through HOVER. | Per document, paid. | **$6 vendor + $2 statutory + $1/page**, plus 3.5% card fee; whole documents only. No bulk, API or subscription mentioned. |
| **Copies request form** ("Request Copies of Court Documents") | Documents by request; paper or electronic copies may take about 4 business days for redaction. | Manual, per request. | Circuit Civil page. |
| **Official Records** (`publicaccess.hillsclerk.com` API, already in production for assignments) | Recorded documents by instrument number, as PDF. | **Yes — already working** for our Hillsborough assignments. | `download_hillsborough_pdf()` in `collector/extract_pdfs.py`. |

Verified facts only. Unverified is listed in §7.

### The case types (September 2026 case file, about 6,900 lines; some cases span several lines)

| Case type | Cases | Note |
|---|---|---|
| Mortgage Foreclosure - **Commercial** -1- $50,000 or Less | 1 | |
| Mortgage Foreclosure - Commercial -2- $50,001 - $249,999 | 3 | |
| Mortgage Foreclosure - Commercial -3- **$250,000 or More** | 7 | candidate band |
| Mortgage Foreclosure - **NonHomestead** -1- $50,000 or Less | 3 | |
| Mortgage Foreclosure - NonHomestead -2- $50,001 - $249,999 | 31 | |
| Mortgage Foreclosure - NonHomestead -3- **$250,000 or More** | 39 | candidate band |
| Mortgage Foreclosure - Homestead -1/-2/-3 | 3 / 81 / 59 | out of scope (same as Miami-Dade) |
| CC Real Property/Mortgage Foreclosure and CC Enforce Lien | 43 / 6 / 2 / 59 / 4 / 2 | County Court, $50,000 and under: out of scope |

Case numbers look like `26-CA-011720` (Circuit Civil) and `26-CC-054325` (County Civil), not Miami-Dade's `2026-022271-CA-01`.

---

## 2. Stage A — what can be built now, with no decision

1. **Discovery module** (`collector/hillsborough_complaints.py`, new). Each day, read the last several days' `CivilFiling_YYYYMMDD.csv`, keep rows whose `CaseTypeDescription` is Mortgage Foreclosure Commercial or NonHomestead, store one row per case in `foreclosure_cases` with a new `county` column. Keep plaintiff, defendants, addresses and attorney from the file. For history, load the monthly Case, Party and Event files (one year back).
2. **Band filter.** Store all bands but mark band `-3- $250,000 or More` as the candidate set. Principal of $500,000 or more cannot sit in a band capped at $249,999 unless the case is mis-banded (see §6).
3. **Docket check.** From the monthly Event File, note when the `COMP` event and `LIS PENDENS` events appear (a retry signal, like Miami-Dade's "not public yet").
4. **UI.** The Complaints tab gets a county switch; Hillsborough rows show "Document not yet available" until Stage B exists. All hover reasons (`resultReason()`) need a Hillsborough branch.
5. **QC and cron.** Same daily wrapper pattern as `run_complaints_daily.sh`; coverage by filing week in the QC panel; counted against the Clerk's own daily file (the file is the source, so completeness is "every foreclosure row in every day's file").

Cost of Stage A: none beyond build time. One session.

---

## 3. Stage B — getting the complaint document (the owner's decision)

| Option | What it is | Cost (estimate) | Fits a daily run? | Risk |
|---|---|---|---|---|
| **B1 — Ask the Clerk for a bulk or standing feed** | Written request to the Clerk's Records/IT office: complaints (or all initial pleadings) for Mortgage Foreclosure Commercial and NonHomestead, as PDFs, daily or weekly, ideally SFTP, as Broward's Clerk does. Possibly a fee-exempt public-records request. | Unknown; ask. | Yes if granted | They may say no, or only offer HOVER. Slowest to answer. |
| **B2 — Official Records instead of the complaint** | The foreclosure's **recorded mortgage** and **lis pendens** are Official Records, which our Hillsborough pipeline already reads. The mortgage gives the authoritative **property address**, the **original loan amount** and the **reinstatement clause** (including riders). It does **not** give the **unpaid principal** (only the complaint does). | About the same reading cost as now | Yes, fully automatic | Cannot test the $500,000 unpaid-principal rule; only "original loan ≥ $500,000" as a screen. Linking the lis pendens to its mortgage needs reading the lis pendens first. Unverified that the recorded lis pendens contains the mortgage reference. |
| **B3 — eCertify per document** | Buy certified copies. | About **$8 + $1/page**, +3.5%. A 50-page complaint is about $60. 46 candidates a month is roughly **$2,500–5,000 a month**. | Only if the order step can be automated, and nothing says it can | Expensive; certified copies are more than we need |
| **B4 — Human downloads from HOVER** | Someone with a normal browser opens each candidate case and saves the complaint into a folder; the pipeline reads from that folder. | Staff time: about 46 cases a month, a few minutes each | Semi-manual (not "daily and unattended") | Depends on a person; but legitimate and cheap |
| **B6 — Licensed data vendor (Trellis) — FOUND 3 Nov 2026** | Trellis Law already holds Hillsborough civil dockets and the **complaint documents**, indexed the same day. Tested on case 26-CA-011777 (Freedom Mortgage, NonHomestead -3-, filed 2 Nov 2:33 PM; in Trellis by 23:25 UTC the same day): the complaint came back as a 108-page document, and its text states **"unpaid principal balance of $268,882.17"** in ¶7. A search for "Right to Reinstate" matched the same document, so the mortgage exhibit text is indexed too. 245 Hillsborough foreclosure hits since 1 Oct. | Unknown: the connector in this session is for interactive use; a daily unattended pipeline needs Trellis's Enterprise API / bulk access, which needs a quote. PDF download needs a subscription. | Yes, if the API is licensed | Cost unknown; OCR quality of scanned exhibits not yet tested against our own reader; terms of use for automated use of their data not read. A licensed vendor route, not a workaround. |
| **B5 — Browser automation of HOVER** | Drive HOVER with a scripted browser. | — | — | **Not recommended.** The portal actively blocks automation; getting past it is against the Clerk's controls. |

**Updated 3 Nov 2026:** B6 is the strongest lead because it gives the complaint (and the unpaid principal) without touching HOVER. The owner said the Clerk has no API or weekly delivery, so B1 is unlikely; B6 replaces it as the first thing to pursue. Next: get Trellis's API terms and price, then run the 3-case test in §9 against our own reader.

Original recommendation: **ask the Clerk (B1) and, while waiting, build Stage A plus B2 as a screening layer.** Treat B4 as the fallback for the short list that screens in. Do not build B5. Decision for the owner in §8.

---

## 4. Rules and extraction — what carries over

- **Same approved rules** (Miami-Dade doc §17): mortgage-foreclosure test, unpaid principal of $500,000 or more (inclusive) on any one note, no reinstatement clause (riders count: see §23 of the Miami-Dade doc), mortgage-exhibit address authoritative, one row per note/property.
- **Reading and extraction code is county-agnostic**: `complaints_reader.py` (text/OCR), `complaints_extract.py` (gpt-5.5, rules in code), `complaints_address.py` (repair by vote, with the 3 Nov fixes). Only discovery and download are county-specific.
- **Review list, hover reasons, CSV, email section, QC audit**: reuse; add a `county` filter and county in the CSV.
- **Hillsborough-specific**: the amount band is a free pre-filter; case-number format and the party-address columns differ; "CC" county cases are excluded by case type.

---

## 5. Cost and sizing

| Item | Estimate | Basis |
|---|---|---|
| Cases per month in scope (Commercial + NonHomestead, all bands) | about 84 | September 2026 file |
| Candidates (band 3, $250,000 or more) | about 46 a month, about 1.5 a day | 7 + 39 in September |
| Reading and extraction at about $0.27 each | about **$12 a month** (about $25 if all bands are read) | Miami-Dade measured cost |
| History, one year back (monthly files) | about 550 candidates → about **$150** one time, only if documents are obtainable | |
| Document route | **B1:** unknown · **B2:** none · **B3:** $2,500–5,000 a month · **B4:** staff time | §3 |
| Build | Stage A about one session; B2 about one more; B1/B4 depend on the answer | |

---

## 6. Risks

1. **Mis-banded cases.** The band is the filer's estimate of the amount claimed. A case with $500,000 or more of principal filed in band 2 would be missed. Mitigation: occasionally read a sample of band-2 cases; measure how often it happens; the docket's lis pendens and the recorded mortgage give a second view.
2. **No document, no verdict.** Until Stage B is solved, Hillsborough cannot produce a "Qualifies". The tab must say so plainly.
3. **Bot wall can change.** Anything built on a portal that actively blocks automation will break. The free bulk files are published on purpose and are the stable base.
4. **Retention.** Daily files are kept about 4 weeks; the monthly files one year. A missed week is recoverable from the next month's file, but a long outage is not. Same lesson as Broward.
5. **Posting lag.** The monthly files post around the 10th, so history is up to 6 weeks behind; the daily file is the live feed.
6. **Terms of use.** Not read. Check the Clerk's terms and the Florida Standards for Access to Electronic Court Records before storing document images (redaction applies to some documents).

---

## 7. Unverified (do not assume)

- Whether an eCertify order or a HOVER download can be done by a program with the Clerk's permission.
- Whether recorded lis pendens in Official Records carry the mortgage's book/page or instrument number, and whether our Hillsborough pipeline can pull the `LIS PENDENS` document type. (It currently filters to assignment and UCC codes.)
- The fee-exempt request route, and its turnaround.
- Whether the daily filings file includes every case filed that day, including after-hours e-filings (weekend files are small, as expected, but this was not reconciled against the monthly case file).
- How often the amount band understates the claim.

---

## 8. Decisions for the owner

1. **Document route (§3):** ask the Clerk first (B1), screen with Official Records meanwhile (B2), human fallback (B4)? Or a different order?
2. **Who contacts the Clerk**, and is a written request on company letterhead acceptable? (The draft can be prepared.)
3. **History:** back-fill one year (about $150 of reading, only once documents are available), or start from the day the feed goes live?
4. **Read band-2 cases too** (about double the cost, about $12 more a month) to catch mis-banding, or only a monthly sample?
5. **Where it shows:** the Complaints tab with a county switch (recommended), or a separate tab?

---

## 9. First steps for the new session

1. Read this document and `SESSION_LOG.md` (last entries) and the Miami-Dade doc §17 and §23.
2. Build Stage A: `collector/hillsborough_complaints.py` (discovery from the daily and monthly files), add the `county` column to `foreclosure_cases` (migration, backup first), test on September's files, check counts against the Event/Case files.
3. Get Trellis's Enterprise API terms and price (B6), and test 5 to 10 known cases: compare the complaint text Trellis returns (unpaid principal, property address, reinstatement clause incl. riders) with the PDF the owner downloads by hand from HOVER. The Clerk request (B1) is a draft in `docs/HILLSBOROUGH_CLERK_REQUEST_DRAFT.md` if still wanted.
4. Prototype B2 on three known cases: find each case's recorded mortgage and lis pendens in Official Records, read the mortgage, and compare with the complaint the owner downloads from HOVER by hand. This shows how good the screening is.
5. Do **not** schedule anything or push to production until the owner has chosen the document route.

**Starter prompt for the new chat:** "Read `docs/HILLSBOROUGH_COMPLAINTS_SCOPE.md` and `SESSION_LOG.md`. Build Stage A of Hillsborough foreclosure-complaint discovery locally (daily filings and monthly bulk files, county column, band filter), test it on the September 2026 files, and draft the request to the Clerk for the document feed. No production changes until I choose the document route."

---

## 10. Trellis coverage test — other Florida counties (3 Nov 2026)

Tested through the Trellis connector in the Claude session (interactive use, not an unattended API). One recent mortgage foreclosure per county, complaint text requested.

| County | Foreclosure-related cases since 1 Oct (Miami-Dade since 26 Oct) | Newest case in Trellis | Complaint returned? | Notes |
|---|---|---|---|---|
| Hillsborough | 245 | filed 2 Nov, in Trellis same day | **Yes**, 108 pages, unpaid principal in the text ($268,882.17) | Real clerk case numbers |
| Palm Beach | 365 | 2 Nov | **Yes**, 69 pages (First Internet Bank of Indiana) | Case id shown as `TCN-1075806`, not the clerk's number; some text garbled |
| Duval | 335 | 2 Nov | **Yes**, 66 pages (Athene Annuity, commercial, guaranty and leases) | `TCN-` id; some text garbled |
| Orange | 248 | 2 Nov | **Yes**, 36 pages (Lakeview Loan Servicing); principal figure legible ($266,263.28) | Real case number (`2026-CA-011662-O`); some text garbled |
| Monroe | 20 (includes liens and code enforcement) | 2 Nov | **Yes**, 25 pages (First National Bank of America v. Trinity Without Borders) | `TCN-` id; heavily garbled opening paragraphs |
| Miami-Dade | 162 | 2 Nov | not tested | Includes our own `2026-022267-CA-01` (the MEG construction case), so Trellis agrees with the Clerk's case numbers there |

Trellis lists 58 Florida counties with documents (Alachua through Washington, including Broward, Collier, Lee, Pinellas, Polk, Sarasota, Seminole, Volusia and the rest). Only the five counties above were tested; the "has documents" flag does not prove complaints are held for every county.

**What this means**
- A single licensed source could cover Hillsborough, Palm Beach, Duval, Orange and Monroe, and probably more. It would also work as a **cross-check for Miami-Dade**.
- Documents are labelled "unofficial" copies received from the courts' e-filing feeds. Text comes from OCR; in several complaints the first paragraphs are garbled, though figures further down (principal) were legible. We must not trust their text blindly: the safe design is to download the **PDF** and read it with our own reader (text, OCR, gpt-5.5, address vote). PDF download needs a Trellis subscription; unattended use needs their Enterprise API.
- Palm Beach: our own scope doc (§1–§8 of `PALM_BEACH_EXPANSION_SCOPE.md`) prices the county FTP feed at $3,600 a year and flags the portal captcha. Trellis is an alternative only if its price and terms beat that.
- Unknown: price, API terms, whether automated storage and re-reading is allowed, completeness against each Clerk's own counts, how many of each county's cases are commercial/non-homestead mortgage foreclosures (the case-type labels differ by county).

**Next:** get Trellis's API and price terms for these counties, then run the 5 to 10 case comparison in §9 per county, starting with Hillsborough.
