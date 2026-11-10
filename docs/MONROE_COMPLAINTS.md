# Monroe County Foreclosure Complaints — Collector

**Status:** LIVE (10 Nov 2026). Deployed; first one-week pull done on the droplet (3 cases: 2 read, neither qualifies; 1 not yet public); daily job scheduled at 12:10 UTC.
**Code:** `collector/monroe_complaints.py`, `collector/run_monroe_complaints_daily.sh`, `collector/tests/check_monroe_complaints.py`

## In plain English

- Monroe's Clerk publishes court cases at `cr.monroe-clerk.com`. **No sign-in is needed.** Anyone can search Circuit Civil cases by case type and file date, open a case (parties, attorney and phone, docket), and view each public document.
- The collector does what the Duval one does: **find** the Commercial and Non-Homestead Residential foreclosures, **download** the complaint, and hand it to the shared reader and extractor, so the same fields come out.
- **Claim bands work differently here.** Monroe files most new foreclosures under types with no claim band ("Commercial Foreclosure", "Non-Homestead Residential Foreclosure"). Those can't be ruled out on the band, so their complaints are read. The "$250,000 or More" types are read too. The lower-band types are listed as not qualifying and never downloaded, as in Duval.
- **The docket's "Claim Amount at Filing" entry is used as a second filter.** If it gives a range that tops out under $250,000 (e.g. "$50,001 - $75,000"), the case is listed as not qualifying and the complaint is not downloaded. "Over $100,000.00" doesn't rule a case out, so that complaint is read.
- Cases are stored with `county = 'MONROE'` and case id `MO:<Clerk CaseId>`. Other counties' rows are untouched.

## What was found on the site (10 Nov 2026)

| Item | Finding |
|---|---|
| Terms | The court-records site has no Terms page. The Clerk's main site shows a disclaimer (Accept/Decline) before its link to civil records; it only disclaims accuracy and liability and has no limit on automated or commercial use. The court-records site itself does not ask for it. The Accept button is the owner's to click, not an assistant's. |
| robots.txt | `User-agent: * Allow: /`, with `Content-Signal: search=yes, ai-train=no, use=reference`; named AI crawlers are blocked. The collector is not a crawler for AI training. It identifies itself as `amo-dashboard collector (court records research)`. |
| CAPTCHA | None on any page this route uses. A Cloudflare analytics script is loaded but never challenged. |
| Search | GET `/Attorney/SearchCriteria?caseType=CV` (anti-forgery token), POST the same with `CaseTypeGroup=CV`, repeated `CaseTypes`, `DateFrom`/`DateTo` as M/D/YYYY. The criteria sit in the session; results come as JSON from POST `/Attorney/ReadCaseList` (Kendo grid: `page`, `pageSize`). The site caps a search at 500 results, so the collector searches a week at a time. |
| Case types | Commercial: `24611` generic, `20593` $250k+, `20592`/`20591`/`27096` lower. Non-Homestead Residential: `24613` generic, `20599` $250k+, `20598`/`20597`/`27097` lower. Homestead and the retired "DO NOT USE" types are out of scope. |
| Case | POST `/Attorney/SessionStartTimeEncrypted` (`UserId=<EncryptCaseId>`, `viewname=CaseDetails`) redirects to `Render_CaseDetails?caseId=…&caseIdenc=…` (header: type, date filed, location, UCN, judge, status). Parties and docket come as JSON from `ReadPartyListDetails` / `ReadDocketDetails` with the same query. The encrypted id works in a new session, so it is stored for weekly retries. |
| Complaint | Docket code `CAC` "Complaint". Some cases also carry a second `CAC` with no pages that shares its document with the claim-amount entry; the collector takes the one with pages. 20 to 68 pages in the cases seen. |
| Document | Each docket entry has a security group: `PUB` is public; `VOR` (view on request), `VORP`/`PUBO` (pending redaction) and `SEA`/`SEC` (sealed) are not. For a public entry: GET `/DocView/EncryptDate?requestString=<DocumentVersionString>`, then GET `/DocView/Doc` returns the PDF. **Older scanned filings are TIFFs:** `/DocView/Doc` then returns the site's HTML5 viewer, and the collector takes the file through the viewer's own Download control (`DocumentViewer.axd/docs/<id>/download`) and converts it to a PDF with tesseract, which gives it a text layer. |
| Release speed | Complaints were public on or a day after filing; the 9 Nov filing was still pending redaction on 10 Nov. |
| Volume | 10 in-scope cases filed 1 Oct to 10 Nov 2026 (58 foreclosures of all kinds since June). |

## Running it

```bash
# find cases for a range, no downloads (scratch DB shown; use the real one only on the droplet)
AMO_DB_PATH=/tmp/monroe.db collector/.venv/bin/python3 collector/monroe_complaints.py --from 2026-10-01 --to 2026-11-10 --search-only

# the daily job (what cron would run): last 10 days, download, read, extract
collector/run_monroe_complaints_daily.sh
```

No credentials. Needs `OPENAI_API_KEY` (already in the droplet `.env`) and tesseract (already installed for the shared reader). Cron line, once approved: `10 12 * * *`, after Duval's 11:50 UTC.

## Verified, and not

- **Verified live (10 Nov 2026, laptop, plain HTTP, scratch database):** a search from 1 Oct to 10 Nov found all 10 cases the site lists. The results were 8 complaints downloaded, 1 ruled out on its claim amount, and 1 not yet public. One of the 8 was a TIFF filing, converted to PDF. Party, attorney, phone, UCN and claim-amount data were filled for every case. The shared reader was run on two of them: a 54-page PDF (51 pages OCR'd, "principal sum of $800,000") and the converted 28-page TIFF (read from its text layer, original principal $576,000).
- **Verified offline (`check_monroe_complaints.py`):** band rules, the claim ceiling, party/header parsing, which docket entry is the complaint, storage next to a Miami-Dade-schema table, re-run idempotence, and each fetch outcome.
- **Verified on the droplet (10 Nov 2026, first pull, 3 Nov to 10 Nov):** 3 cases found; 2 complaints downloaded and extracted for $1.18 (26-CA-001307-K unpaid principal $421,971.37, 26-CA-001305-P $331,600; both below $500,000 and both with a right-to-reinstate clause, so neither qualifies); 26-CA-001317-P not yet public. The site did not refuse the droplet's address.
- **Not verified:** behavior over many consecutive days; extraction accuracy checked against the PDFs by a person.

## Permission

Florida's court-records standards (AOSC24-65) say automated programs need the Clerk's authorization and are meant for the case index. The owner chose on 10 Nov 2026 to build the counties whose sites allow collection and to deal with Clerk authorization separately. No written authorization from the Monroe Clerk is on record.
