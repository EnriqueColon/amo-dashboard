# CiviTek OCRS (Pasco, Marion, Hernando FL) Foreclosure Complaints — Scope

**Status:** scoped 10 Nov 2026 · **nothing built, nothing deployed** · blocked: Cloudflare Turnstile (a CAPTCHA) on every search

## Finding in one paragraph

CiviTek's Online Court Records Search (`www.civitekflorida.com/ocrs/county/{id}/`; Pasco 51, Marion 42, Hernando 27, about 30 other small counties) would be technically ideal: a case-number lookup, full parties and docket, and free docket PDFs. But **the search form renders a Cloudflare Turnstile widget and submits its token (`cf-turnstile-response`) with every search**, both "Person Search" and "Case Search". Turnstile is a CAPTCHA, and we do not solve or bypass CAPTCHAs, so no unattended collector can run. The 10 Nov Florida survey listed these counties as "no CAPTCHA" because that check stopped at the entry page; the widget loads only on the search page, after the disclaimer.

## What was checked (10 Nov 2026, Pasco, in a real browser)

| Step | What happens | Gate |
|---|---|---|
| `ocrs/county/51/` | "Public" or "Attorney" access buttons; cites AOSC 15-18 | none |
| `disclaimer.xhtml` | Liability-only disclaimer, "I Agree". Accepted under the owner's authorization (10 Nov). Same text in all three counties. | click-through |
| `ocrs/app/search.xhtml` | JSF/PrimeFaces form. **Person Search:** last/first name or business name (at least 2 characters), file-date range, court type (CA = Circuit Civil). **Case Search:** Year, Court Type, Sequence # (e.g. 2026 / CA / 000001), optional party identifier and branch. | **Cloudflare Turnstile**: `challenges.cloudflare.com/turnstile/v0/api.js`, `turnstile.render("#cfWidget")`, `cf-turnstile-response` posted with the form. A scripted POST without the token returned the form again with no results. |
| `caseinformation.xhtml?query=<token>` | Case number (`512026CA000001CAAXES`), filed date, case type ("Circuit Civil 3-C"), description, every party with attorney and bar id, full docket | reached only through a search |
| `docketimage.pdf?query=<token>&pages=N` | Real PDF (`application/pdf`, 152 KB, `%PDF-1.4`) for each docket entry | none beyond the search |

No `robots.txt`. The PDF and case-page links are opaque tokens issued by the search, so getting to them still goes through the Turnstile-gated search.

## Routes, in the order to try

1. **Ask the Clerks** (Pasco first, largest of the three): is there a bulk or daily export of new Circuit Civil filings, or an approved unattended access method (AOSC24-65 asks for the Clerk's authorization of automated programs anyway). Draft like `HILLSBOROUGH_CLERK_REQUEST_DRAFT.md`.
2. **Attorney access** on the entry page needs a bar user id; not ours to use.
3. Revisit if CiviTek removes Turnstile.

## Do not do

Solve, script around or farm out the Turnstile challenge, or build URLs to `caseinformation.xhtml` / `docketimage.pdf` without going through the search. Nothing in this repo does.
