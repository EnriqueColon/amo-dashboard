# New York State — Foreclosure Complaints — Scope

**Status:** scoped 6 Nov 2026 · **nothing built; NYSCEF must NOT be automated** · alternatives below

## Finding in one paragraph

New York's public court e-filing site (NYSCEF) is easy for a person to search by county, case type and filing date, but its Terms of Use **prohibit automated access and data mining**, and its search forms carry an **hCaptcha**. We cannot build a collector on it. NYC's ACRIS open data is a permitted, free API, but it has **no notice of pendency (lis pendens) and no complaints**; it does carry mortgages and assignments of mortgage.

## Evidence (6 Nov 2026)

| Source | What it is | Result |
|---|---|---|
| **NYSCEF** (`iapps.courts.state.ny.us/nyscef/CaseSearch`) | Case search by case number, name, county, case type (e.g. "Real Property - Mortgage Foreclosure - Residential / Commercial"), filing dates; a "New Cases" tab | **hCaptcha** elements on the search page (several `h-captcha` widgets). Terms of Use (`termsOfUse.htm`): *"This site may not be accessed by any automated program ("bot") for the purpose of extracting data for any use."* and *"Data may not be mined or sold, or used in any pay-for-use application."* It also may not be linked to directly. Only the case-search form and the Terms were read; **no search was run and nothing was downloaded.** |
| **NYC ACRIS open data** (NYC Open Data, Socrata: Master `bnx9-e6tj`, Parties `636b-3b5g`, Legals `8h5j-fqxa`, References `uqqa-hym2`, document codes `7isb-wh4c`) | Recorded real-property documents in the five boroughs, public JSON API, no login | Works from a plain GET (latest `ASST` recorded date seen: 30 Sep 2026, i.e. a lag of several weeks; not measured further). 126 document types: mortgage (`MTGE`), assignment of mortgage (`ASST`), satisfaction (`SAT`), judgment (`JUDG`), court order (`CTOR`), liens, UCC, etc. **No notice of pendency / lis pendens code.** Notices of pendency are filed with the county clerk, not in ACRIS. |
| **Trellis** | Court-data service | Lists New York counties (the old sheet's Kings and New York rows came from elsewhere); NY not tested. PDFs need a subscription; unattended use needs its Enterprise API (price and terms unknown). |

## Options

1. **Do not use NYSCEF programmatically.** Ask the Unified Court System (Office of Court Administration) whether a licensed data feed or written permission for automated access exists; until then, a person may look cases up by hand only.
2. **NYC assignments of mortgage from ACRIS.** This is the tool's original product (assignments of mortgage) for NYC, from a permitted open API. It is not complaints; it is a different, larger project (new county in the core pipeline, volume and cost to size).
3. **Trellis** for NY complaints, if its Enterprise API price and terms are acceptable (test Kings and New York first).
4. **County clerk lis pendens** (Nassau, Suffolk, Westchester, the NYC clerks): each has its own portal and rules; not researched.

## Do not do

Automate NYSCEF, solve its hCaptcha, or use data taken from it in this tool. Nothing in this repo does.
