# Leon County Foreclosure Complaints — Collector

**Status:** BUILT AND DEPLOYED, BLOCKED FROM THE SERVER, NOT SCHEDULED (10 Nov 2026). Tested live from the laptop into a scratch database. The code is on the droplet (`63e0d8e`), but the Leon Clerk's network refuses the droplet's address: `lforms.leonclerk.com` and `www.leonclerk.com` time out on connect, and `cvweb.leonclerk.com` answers 403. The same pages answer the laptop normally. The first one-week pull stopped before sending a request and stored nothing. No cron is installed. The collector is not to be routed through a proxy to get around this; running it needs either the Clerk allowing the droplet's address or a run from a machine the Clerk accepts (owner's decision).
**Code:** `collector/leon_complaints.py`, `collector/run_leon_complaints_daily.sh`, `collector/tests/check_leon_complaints.py`

## In plain English

- Leon's Clerk publishes court cases at `lforms.leonclerk.com/search_courts`. **No sign-in is needed.** Anyone can search Circuit Civil cases by name, case type and file date, open a case (parties, attorney, action, docket), and open each docket document that has an image.
- The collector works like the Duval and Monroe ones: it **finds** the Commercial and Non-Homestead Residential foreclosures, **downloads** the complaint, and passes it to the shared reader and extractor, so the same fields come out.
- **The search is by name, so the collector searches once for each vowel.** It looks for plaintiffs whose name contains A, then E, I, O, U and Y, limited to the foreclosure case types, and merges the results. Over three months that found every case either way of searching (42), with no plaintiff missed.
- **Every Leon case carries a claim band**, so only the "$250,000 or more" band is read. The lower bands are listed as not qualifying and never downloaded, as in Duval.
- Leon's complaints are scans, so the shared reader OCRs every page (14 to 66 pages in the cases seen; a 66-page complaint takes about 30 seconds on the laptop).
- Cases are stored with `county = 'LEON'` and case id `LE:<Clerk caseid>`. Other counties' rows are untouched.

## What was found on the site (10 Nov 2026)

| Item | Finding |
|---|---|
| Terms | The search page shows a notice, not an Accept/Decline step: records are provided under Rule 2.420, requests must be "made in a reasonable manner", and the Clerk may charge for extensive use. Nothing limits automated or commercial use. The collector pauses 2 to 2.5 seconds between requests and makes about 12 searches plus a few case and document requests a day. |
| robots.txt | None (404). |
| CAPTCHA | None shown. The result and case pages load Google's `recaptcha/api.js` but render no widget and call nothing, and the form's `recaptcha_result` field is commented out. The collector stops (exit 3) if a widget, site key or challenge call ever appears, or on 403/429. |
| Search | GET `search_by_name.asp`, then POST `process.asp` with `case_search_type=civil`, `search_method=name`, `idnt.company_name=<letter>`, `wildCard=contain`, `begin_date`/`end_date` as YYYY-MM-DD, `CourtType=CA`, repeated `CaseType`, `pty.pty_cd=PLTF`, `template=main_search_judge`, `action=Search`, Referer set to the form. The site returns one row per matching party and caps a search at 250 rows; the collector searches a week at a time and warns at the cap. The company-name and last-name fields match the same names. |
| Case types | Commercial `MTFCC1`/`MTFCC2`/`MTFCC3`, Non-Homestead Residential `MTFCNHR1`/`MTFCNHR2`/`MTFCNHR3` (band 3 = $250,000 or more). Homestead (`MTFCHR*`), County Civil (`MTFCO*`) and the legacy band-less `MTFC`/`MTFC1-3` codes are not searched; `MTFC3` had no filings from 1 Aug to 10 Nov 2026. |
| Case | GET `process.asp?report=full_view&caseid=<N>&jiscaseid=`: header (`37 2026 CA 002258 - PLAINTIFF vs DEFENDANT`), `parties_table` (party, code, attorney), `case_dsp_table` (action with band, open date, judge), `dockets_ecert_table` (one checkbox per entry, value `caseid|dktid|BM|CODE|DESCRIPTION|…`). |
| Complaint | Docket code `MTFC3` (or another `MTFC*`), "COMPLAINT FOR MORTGAGE FORECLOSURE …". An entry with no image link is not viewable ("Non-Viewable images … Requiring Clerk Assistance"); the collector stores it as not public and retries weekly for 8 weeks. It never orders a copy. |
| Document | GET `image_orders.asp?caseid=<N>&jiscaseid=&defseq=&chargeseq=&dktid=<D>&dktsource=BM&sexual_case=`. **The request must carry the case page as its Referer**; without it the server returns only a 169-byte HTML stub. With it, the reply is `application/pdf` with that same 169-byte HTML preamble before `%PDF`; the collector cuts everything before `%PDF`. |
| Volume | 42 Commercial / Non-Homestead foreclosures filed 10 Aug to 10 Nov 2026, of which 7 are in the $250,000+ band (about 2 or 3 a month). |

## Running it

```bash
# find cases for a range, no downloads (scratch DB shown; use the real one only on the droplet)
AMO_DB_PATH=/tmp/leon.db collector/.venv/bin/python3 collector/leon_complaints.py --from 2026-10-01 --to 2026-11-10 --search-only

# the daily job (what cron would run): last 10 days, download, read, extract
collector/run_leon_complaints_daily.sh
```

No credentials. Needs `OPENAI_API_KEY` (already in the droplet `.env`) and tesseract (already installed for the shared reader). Cron line, once approved: `30 12 * * *`, after Monroe's 12:10 UTC.

## Verified, and not

- **Verified live (10 Nov 2026, laptop, plain HTTP, scratch database):** a search from 10 Aug to 10 Nov found 42 cases (7 in the $250,000+ band, 35 lower-band stored as not qualifying). All 7 complaints downloaded, and parties, attorney, judge and filing date were filled for each. The shared reader read all 7 (14 to 66 pages, all OCR); principal amounts were visible in the text, e.g. $815,000, $2,393,989.12, $645,000.
- **Verified offline (`check_leon_complaints.py`):** band rules, the CAPTCHA check ignoring the unused script, search and case parsing, the per-letter merge, which docket entry is the complaint, storage next to a Miami-Dade-schema table, re-run idempotence, and each fetch outcome.
- **Tried from the droplet (10 Nov 2026, 17:16 UTC):** refused at the network level, as above. Monroe's site answered the droplet in the same check.
- **Not verified:** extraction; behavior over many consecutive days.

## Permission

Florida's court-records standards (AOSC24-65) say automated programs need the Clerk's authorization and are meant for the case index. The owner chose on 10 Nov 2026 to build the counties whose sites allow collection and to deal with Clerk authorization separately. No written authorization from the Leon Clerk is on record.
