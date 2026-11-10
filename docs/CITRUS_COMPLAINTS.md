# Citrus County (FL) Foreclosure Cases — Runbook

**Status:** built 10 Nov 2026 · cases, parties and claim bands from the Clerk's official Bulk Data Export; complaints downloaded through the owner's registered account on the Clerk's court records site and read with the shared reader.

## Source

The Citrus Clerk publishes a self-service **Bulk Data Export** at `apps.citrusclerk.org/BulkDataExport/`: filings or dispositions by date range and court type, with Case, Case Party, Case Charge and Case Docket CSVs, returned as a ZIP. It is offered for exactly this kind of use.

- No sign-in, no CAPTCHA, no disclaimer, no `robots.txt` on `apps.citrusclerk.org` (checked 10 Nov 2026). The Clerk's main site asks crawlers for a 10-second delay; the collector waits 10 s between exports.
- The page is a Laravel Livewire form. The collector loads it and posts the form state to the page's own `livewire/update` endpoint, as the browser does; the ZIP comes back base64-encoded in the JSON response.
- An export returns at most **1,000 cases** (a one-year pull came back with exactly 1,000). The collector exports one week at a time (Circuit Civil runs about 10 to 30 cases a week).
- The export **lags new filings by a few days** (on 10 Nov the newest filing was 6 Nov) and answers **HTTP 500 for a window with no filings**. The collector retries a 500 once after 30 s, then counts the window as empty; the daily 14-day overlap picks those days up later. If every window of a multi-week run answers 500, it exits 2.

## Scope

Same rule as Duval, Monroe and Leon: commercial and non-homestead residential mortgage foreclosures. Citrus case types carry the claim band:

| Case type | Stored as | Status |
|---|---|---|
| `COMML MTG FORECL >250,000` | `CI-COM-3` | `pending` |
| `NON-HOMESTEAD FC>250,000` | `CI-NH-3` | `pending` |
| `COMML MTG FORECL 50 - 249`, `... <50` | `CI-COM-LOW` | `below_band_threshold`, or `pending` with `--include-lower-band` |
| `NON-HOMESTEAD FC >50 <249`, `NON-HOMESTEAD FC <50,000` | `CI-NH-LOW` | as above |
| `HOMESTEAD FC ...`, `REAL PROPERTY ...`, everything else | not stored | |

The daily job passes `--include-lower-band`, as Monroe and Leon do, so every band is downloaded and read.

Volume (Nov 2025 to Nov 2026 export): about 24 non-homestead and 7 commercial cases a year in the top band, about 90 in the lower bands.

## What is stored

`foreclosure_cases` rows with `county='CITRUS'`, `case_id='CI:<Uniform Case Number>'` (e.g. `CI:092026CA000830XXXAIN`), `case_number` as the Clerk prints it (`2026 CA 000830 A`), file date, case type, status, and a case title that names the first real defendant (not "Unknown Tenant"). `metadata_json` holds plaintiffs, defendants (primary names only; AKA rows skipped), plaintiff attorneys with bar numbers, judge, disposition, the complaint's docket entry and date, and each party's address. Party addresses are kept but **not shown as the property address**: the tab's address comes only from a reading of the complaint. Known rows get their status, title and parties refreshed on every run.

## Complaint documents: registered account

The export holds no images. The Clerk's case search (`scorss.citrusclerk.org`, "Secured Courts Online Record Search System") says: *"Anonymous users are required to complete the Captcha requirements for each search request. Registered users can login to avoid the captcha requirements."* We do not solve or bypass CAPTCHAs; the owner registered an account instead, which is the route the Clerk offers. Its login is `CITRUS_SCORSS_USER` / `CITRUS_SCORSS_PASS` in `/opt/amo-dashboard/.env`, set by the owner (10 Nov 2026), never by an assistant. No `robots.txt` (404, checked 10 Nov 2026); the terms are a liability disclaimer, and fees apply only to view-on-request and non-imaged copies, which the collector never requests.

For each case due, the collector signs in once per run, searches the case by number (`2026CA612`), parses the docket on the case page, picks the earliest original Complaint (never an amended one), and downloads it from `/viewimage` only when the image is marked `SHOW` (free, as on the screen). Others are stored as `complaint_not_public`; a case with no complaint entry yet as `no_complaint_entry`. Both are retried weekly for 8 weeks. Files land in `COMPLAINTS_DIR` as `CI_2026-CA-000612-A_D5.pdf`. 3 s between case searches and between downloads.

- If the case page ever shows the signed-out text ("Welcome Guest" / "Anonymous users are required to complete the Captcha"), or the site answers 403 or 429, the run stops with **exit 3**.
- A refused sign-in stops the run with **exit 4** and is not retried (repeat failures can lock the account). Check the account in a browser.
- Without the two variables the run stores the index only and notes the pending rows.

Live test (10 Nov 2026, scratch DB): 3 of 3 complaints downloaded (29 to 34 pages, 6 to 7 MB each, mostly with a text layer).

## Running

```
collector/.venv/bin/python3 -u collector/citrus_complaints.py --days 14 --include-lower-band --extract
collector/.venv/bin/python3 -u collector/citrus_complaints.py --from 2026-08-01 --to 2026-11-10 --search-only
collector/.venv/bin/python3 -u collector/citrus_complaints.py --fetch-only --limit 3
collector/.venv/bin/python3 collector/tests/check_citrus_complaints.py      # offline
```

Cron (droplet): `50 12 * * * /opt/amo-dashboard/collector/run_citrus_complaints_daily.sh >> /opt/amo-dashboard/collector/citrus_complaints_daily.log 2>&1`. The wrapper sources `/opt/amo-dashboard/.env` (account and `OPENAI_API_KEY`); extraction shares `COMPLAINTS_DAILY_BUDGET_USD` with the other counties. No proxy. Exit 2 = every export window answered 500; 3 = CAPTCHA / signed-out page / 403 / 429; 4 = sign-in refused.

## Also fixed with this county

The Miami-Dade fetch stage (`complaints_collect.due_for_fetch`) selected every county's `pending` rows. Citrus top-band rows stay `pending` indefinitely, so the Miami-Dade run would have looked them up on the Miami-Dade Clerk's system daily and overwritten their notes with errors (the 12 hidden Hillsborough rows were next in line). It now selects Miami-Dade rows only; `check_citrus_complaints.py` asserts it.
