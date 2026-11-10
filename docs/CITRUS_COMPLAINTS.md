# Citrus County (FL) Foreclosure Cases — Runbook

**Status:** built 10 Nov 2026 · **index only**: cases, parties and claim bands from the Clerk's official Bulk Data Export; no complaint is downloaded or read (needs a registered account, see below).

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
| `COMML MTG FORECL 50 - 249`, `... <50` | `CI-COM-LOW` | `below_band_threshold` |
| `NON-HOMESTEAD FC >50 <249`, `NON-HOMESTEAD FC <50,000` | `CI-NH-LOW` | `below_band_threshold` |
| `HOMESTEAD FC ...`, `REAL PROPERTY ...`, everything else | not stored | |

Volume (Nov 2025 to Nov 2026 export): about 24 non-homestead and 7 commercial cases a year in the top band, about 90 in the lower bands.

## What is stored

`foreclosure_cases` rows with `county='CITRUS'`, `case_id='CI:<Uniform Case Number>'` (e.g. `CI:092026CA000830XXXAIN`), `case_number` as the Clerk prints it (`2026 CA 000830 A`), file date, case type, status, and a case title that names the first real defendant (not "Unknown Tenant"). `metadata_json` holds plaintiffs, defendants (primary names only; AKA rows skipped), plaintiff attorneys with bar numbers, judge, disposition, the complaint's docket entry and date, and each party's address. Party addresses are kept but **not shown as the property address**: the tab's address comes only from a reading of the complaint. Known rows get their status, title and parties refreshed on every run.

## Complaint documents: not yet

The export holds no images. The Clerk's case search (`scorss.citrusclerk.org`, "Secured Courts Online Record Search System") says: *"Anonymous users are required to complete the Captcha requirements for each search request. Registered users can login to avoid the captcha requirements."* It runs a Cloudflare Turnstile. We do not solve or bypass CAPTCHAs, so complaint reading needs **a registered account, set up by the owner** (credentials in `/opt/amo-dashboard/.env`, typed by the owner, never by an assistant). Whether registered users see document images for free (the site also has an eCertify shopping cart) is not yet known. Until then the top-band rows stay `pending` and the Complaints tab shows them as "awaiting the complaint document".

## Running

```
collector/.venv/bin/python3 -u collector/citrus_complaints.py --days 14
collector/.venv/bin/python3 -u collector/citrus_complaints.py --from 2026-08-01 --to 2026-11-10
collector/.venv/bin/python3 collector/tests/check_citrus_complaints.py      # offline
```

Cron (droplet): `50 12 * * * /opt/amo-dashboard/collector/run_citrus_complaints_daily.sh >> /opt/amo-dashboard/collector/citrus_complaints_daily.log 2>&1`. No API key and no proxy needed. Exit 3 = CAPTCHA / 403 / 429 (stopped, not retried).

## Also fixed with this county

The Miami-Dade fetch stage (`complaints_collect.due_for_fetch`) selected every county's `pending` rows. Citrus top-band rows stay `pending` indefinitely, so the Miami-Dade run would have looked them up on the Miami-Dade Clerk's system daily and overwritten their notes with errors (the 12 hidden Hillsborough rows were next in line). It now selects Miami-Dade rows only; `check_citrus_complaints.py` asserts it.
