# St. Johns County (FL) Foreclosure Complaints — Scope

**Status:** scoped 5 Nov 2026 · **nothing built, nothing deployed** · blocked on a record-access route (both Clerk search tools are CAPTCHA-gated)

## Finding in one paragraph

St. Johns publishes case data on two Clerk systems, and **both put a CAPTCHA on every search**. We do not solve or bypass CAPTCHAs, so neither can run as an unattended job today. A registered (logged-in) account may skip the CAPTCHA, and the Clerk may offer a data feed; both are unconfirmed and need the Clerk's answer.

## What was checked (5 Nov 2026)

| System | What it is | Gate | Evidence |
|---|---|---|---|
| **Court Records** (`apps.stjohnsclerk.com/Benchmark`, Catalis "Benchmark", v2.9.46.0) | Case search and docket (search by name, case number, date opened, court type) | **hCaptcha** ("I am human") on the search form; separate login for registered users | Seen on the form. "Register for an Account" points to the Court Records Registration Agreement. |
| **Official Records** (`apps.stjohnsclerk.com/Landmark`, "Landmark Web" 1.5.93.0) | Recorded documents (mortgages, lis pendens), searchable by name, document type, book/page, case number, record date, legal, parcel | **Google reCAPTCHA** on every one of the 11 search sections (name, book/page, documents, consideration, case number, instrument number, parcel, record date, legal, advanced legal, quick search). A disclaimer (accuracy and liability notice, no mention of automation) must also be accepted. | DOM check of the search page after the disclaimer was accepted in the browser pane. **An earlier statement in the session that this route had no CAPTCHA was wrong**: that check ran before the search form had loaded. |
| **Trellis** | Court-data service | Subscription for PDFs; unattended use needs its Enterprise API (price and terms unknown) | Lists St. Johns Circuit Civil cases with real clerk case numbers (`CA26-1797`), current to 3 Nov 2026; county flagged `has_documents`. For `CA26-1797` it returned the text of the filing-fee form "Value of Real Property or Mortgage Foreclosure Claim", which states **"$381,955.76 Principal due on the note"**. PDF download needs a subscription. |

Volume: Trellis showed about 65 foreclosure-related cases (liens included) from 15 Oct to 4 Nov 2026, roughly 20 a week.

## Registration

- The Court Records Registration Agreement (`stjohnsclerk.com/courts/court-records-registration-agreement/`): general users sign and date the form (no notarization); attorneys of record and parties must have it notarized. Cites Florida AOSC19-20. **It says nothing about cost, automated access, bulk download or account sharing.**
- Contact for questions: Clerk (904) 819-3600; Recording Division Recording@stjohnsclerk.com; records@stjohnsclerk.com; helpdesk@stjohnsclerk.com.

## Routes, in the order to try

1. **Ask the Clerk** (draft the letter like `HILLSBOROUGH_CLERK_REQUEST_DRAFT.md`): (a) is an unattended, registered account allowed, and does a logged-in session skip the CAPTCHA, on Court Records and on Official Records; (b) is there a bulk or daily export of the Official Records index (lis pendens) and of new civil filings, as Broward (SFTP) and Palm Beach (FTP) offer.
2. **Register** a Court Records and an Official Records account (owner signs; assistants do not handle the password) and test whether logged-in sessions show the CAPTCHA. If not, build it like Duval; if yes, stop.
3. **Trellis** for case discovery and the filing-fee-form principal (Enterprise API price and terms needed).

## Do not do

Solve, bypass, or script around either CAPTCHA, or use a third-party solver. Nothing in this repo does.

## Idea that applies to every county

The statewide "Value of Real Property or Mortgage Foreclosure Claim" form (s. 28.241 F.S.) is filed with each complaint and states the principal due on the note. In Duval it is a public-access document (no VOR release wait). If it is public in a county, it gives an early principal reading without the complaint. Before relying on it, compare it with the complaint principal on the Duval cases already read (10 cases).
