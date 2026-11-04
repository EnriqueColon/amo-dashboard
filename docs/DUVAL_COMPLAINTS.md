# Duval County Foreclosure Complaints — Collector

**Status:** built, tested offline, and run live by the owner (4 Nov 2026: sign-in, search of 20 cases, 2 complaints downloaded and checked) · **NOT deployed, NOT scheduled**
**Code:** `collector/duval_session.py`, `collector/duval_complaints.py`, `collector/run_duval_complaints_daily.sh`, `collector/tests/check_duval_complaints.py` (+ fixtures)

## In plain English

- Duval's Clerk publishes court cases on **CORE** (`core.duvalclerk.com`). A signed-in user can search Circuit Civil cases by case type and file date, open a case, and view each filed document as a PDF.
- The collector does what the Miami-Dade one does: **find** the Commercial and Non-Homestead Residential foreclosures, **download** the complaint, then hand it to the shared reader and extractor, so the same fields (the old sheet's columns, the nine approved rules) come out.
- **Only the "$250,000 or More" claim band is downloaded and read.** Only that band can hold $500,000 of unpaid principal. **Owner decision (4 Nov 2026):** cases in the lower bands are still brought in and listed, and the Complaints tab states plainly that they do not qualify ("the Clerk filed this case in a claim band under $250,000"); they are not downloaded or read. This is the Clerk's filing band, not a reading of the complaint. (`--include-lower-band` still exists to download them if that ever changes.) The same wording now applies to Hillsborough's lower-band cases.
- Cases are stored with `county = 'DUVAL'` and case id `DU:<Clerk caseID>`. Miami-Dade and Hillsborough rows are untouched.

## What was found on the site (4 Nov 2026)

| Item | Finding |
|---|---|
| Search | Circuit Civil (`CA`) + case type + File Date range (`MM/DD/YYYY-MM/DD/YYYY`). Commercial Foreclosure = codes 488,489,490; Non-Homestead Residential = 494,495,496 (the $250,000+ band is 495). 25 cases a page, paged by `CaseSearchUpdate`. One week of the two types is about 20 cases. |
| Case page | Header (division, status, file date, judge), parties with addresses, the plaintiff's attorney with Florida Bar number, fees, and the full docket with page counts. Foreclosure cases are moved to division `FC-x`, so the division changes after filing. |
| Complaint | A docket line starting `COMPLAINT` (wording varies: `COMPLAINT (VERIFIED)`, `COMPLAINT FOR COMMERCIAL MORTGAGE FORECLOSURE`, …). 30 to 86 pages in the cases seen. |
| Document | The case page gives each image cell either a direct link or a click handler (`beginImageJob(caseID, docketID, …)`); the collector's own session received the click-handler form (found 4 Nov 2026, first live fetch), so the collector builds the document URL from the IDs. Either way the file is a plain PDF at `/court/case/<caseID>/docket/<docID>/content.pdf` with the session cookie. **The pages are scanned images** (only the Clerk's header stamp is text), so OCR is mandatory. OCR on 3 pages of a real complaint read the loan amount, unpaid principal, mortgage recording and property address correctly. |
| Case number | Search shows it masked (`2026-CA-007589-AXXX`); the case page shows `16-2026-CA-007589-AXXX-MA`. The collector stores the search form and keeps the full one in `metadata_json`. The case-number box on the site rejects the masked form, so cases are opened by Clerk case id, not by number. |
| Release speed | The complaints seen (filed 29 Oct, 30 Oct, 2 Nov) were all "Ready to view" one to three days after filing. |

## VOR — "View on Request" (the rule that limits speed)

Most Duval documents are VOR: a Clerk employee redacts and releases each one by hand before its first public viewing (Florida AOSC24-65). The case page shows which are released: an image link with `VOR, Ready to view` or `Public access`. A complaint with no link is **not released yet**.

- The collector **never requests a release.** A Public Access login cannot, and a request is an account action.
- An unreleased complaint is stored as `complaint_not_public` with the Clerk's wording in `note`, and retried weekly for 8 weeks (same as Miami-Dade).
- **Unverified:** what an unreleased image looks like in the HTML. The code treats any complaint line without a PDF link as unreleased; this has not been seen on a real case yet.
- Registered users (a signed Registration Agreement to View Records Online) can request releases. That is the owner's decision; see below.

## Bot Check (reCAPTCHA)

The portal loads Google reCAPTCHA and **can** answer any call with a "Bot Check". During this work it never did (signed in: about ten searches, four case opens, two search pages, two document downloads). The client raises `BotCheckError` if it happens, the run stops (exit 3), and **nothing solves or works around it.** Pacing is gentle on purpose (2 s between searches and case pages, 2.5 s between documents).

## Running it

```bash
# check the sign-in only (credentials stay in your shell, never in a file or the repo)
DUVAL_CORE_USER=... DUVAL_CORE_PASS=... collector/.venv/bin/python3 collector/duval_session.py

# find cases for a range, no downloads
AMO_DB_PATH=./miami_dade_amo.db ... collector/.venv/bin/python3 collector/duval_complaints.py --from 2026-10-28 --to 2026-11-03 --search-only

# the daily job (what cron would run): last 10 days, download, read, extract
collector/run_duval_complaints_daily.sh
```

Production would need `DUVAL_CORE_USER` / `DUVAL_CORE_PASS` added to `/opt/amo-dashboard/.env` by the owner (the sign-in is the owner's own CORE account), then the cron line shown in the wrapper. Assistants do not handle the password.

## Verified, and not

- **Verified live (through the signed-in browser session, 4 Nov 2026):** the search payload, paging, case-open payload, the document URL and download, the HTML structure parsed by the code, and that none of these calls raised a Bot Check.
- **Verified offline (`check_duval_complaints.py`, no network):** the search/case parsers on real captured markup, band rules, which docket line is the complaint, storage and idempotence next to a Miami-Dade-schema table, fetch outcomes (downloaded / not released / no complaint line), and that a Bot Check stops the run.
- **Verified live by the owner's own run (4 Nov 2026, their terminal, their login):** the Python sign-in; a one-week search (20 cases: 16 below the $250,000 band, 4 in band); fetch of 2 complaints (Oceanus, 35 pages; McClendon, 86 pages). Page counts matched the docket, the headers carried the right case numbers, and OCR of a page read the complaint body.
- **Two things the live run taught:** (1) the case page served to the collector's session gives each image a click handler (`beginImageJob(caseID, docketID, ...)`), not a `content.pdf` link, so the URL is built from the IDs (every released complaint was first misread as unreleased); (2) the first document request came back as a non-PDF until the collector also set the cookies the site's own page script sets after sign-in (`token`, `accessType`, `displayName`) and sent a referrer. Which of the two changes fixed it was not isolated.
- **Not verified:** what an unreleased image looks like in the HTML (every complaint seen so far was released); extraction accuracy on Duval complaints (nothing has been extracted yet; the gate below applies); behavior over many consecutive days (the Clerk could still raise a Bot Check under a daily schedule).

## Gate before Duval shows "Qualifies"

Per the owner's rule (Hillsborough scope §13), Duval stays off "Qualifies" until the extracted unpaid principal has been checked against hand-read PDFs. Plan: read 20 to 40 Duval complaints, compare, fix, then switch on.

## Not done / follow-ups

- **Collection Log tab:** `foreclosure_runs` has no county column, so this collector writes no run row (it would blur Miami-Dade's freshness checks). A county column on the run log is a small follow-up.
- **Dashboard:** Duval rows will appear in the Complaints tab with county `DUVAL`; a county filter may be wanted.
- **Hillsborough:** its `ensure_county_schema` now calls the shared one in `complaints_collect.py` (identical behaviour; its checks pass).

## Owner decisions

1. **Register the CORE account** (Registration Agreement to View Records Online) so unreleased complaints can be requested? Read the agreement's terms on automated use first.
2. **Run unattended on the droplet** with the owner's login stored in `.env`? Confirm the Clerk allows a shared account to run unattended.
3. ~~Lower claim bands~~ — decided 4 Nov 2026: list them as "does not qualify", do not download.
4. **Counties' order:** Duval before or after the Hillsborough document route?
