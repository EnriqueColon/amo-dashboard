# AMO Tracker — Mortgage Assignment Intelligence Dashboard

> **Status:** Live in production · **Owner:** Enrique C. · **Last reviewed:** 7 Oct 2026
> **Production URL:** `http://165.22.35.75:5000` (single shared password)
> **Repository:** `amo-dashboard` (`origin/main`)

---

## 1. At a glance

| | |
|---|---|
| **What it is** | A private dashboard that tracks every mortgage **assignment** recorded in the Miami-Dade and Broward county Official Records, and turns those filings into a picture of who is buying, selling and financing mortgage debt in South Florida. |
| **Who uses it** | Internal — one analyst/deal team. Single shared password, no user accounts. |
| **Counties live** | Miami-Dade (full), Broward (live since 10 Aug 2026) |
| **History depth** | 3 Jan 2023 → present |
| **Data volume** | 150,336 recorded filings, 10,431 resolved entities, 56,484 confirmed loan transfers (22 Sep 2026 — see §7.2) |
| **Refresh cadence** | Broward daily, Miami-Dade weekly, derived tables rebuilt nightly |
| **Stack** | React + Vite (client) · Express + SQLite (server) · Python (collector) |
| **Hosting** | Single DigitalOcean droplet, PM2-managed Node process |

---

## 2. What the tool does (plain English)

Every time a mortgage changes hands, the new holder records an **Assignment of Mortgage (AMO)** with
the county. Those filings are public, but they are published one document at a time, with no search,
no structure and no notion of which company is which. Individually they are noise. In bulk they are a
near-complete map of who is trading mortgage debt in a market.

AMO Tracker does four things with that raw stream:

1. **Collects** every assignment filed in Miami-Dade and Broward since January 2023, automatically,
   on a schedule.
2. **Reads the actual documents** — it downloads the recorded image, OCRs it, and uses an LLM to pull
   out what the index does not carry: who really assigned to whom, the parent company behind a shell,
   the property address, the loan amount, and whether the document describes a **credit facility**
   (a warehouse line, revolver or syndicated agreement) rather than a plain sale.
3. **Resolves entities** — it decides that `U S BANK TRUST NATIONAL ASSN`, `US BANK TRUST NATIONAL
   ASSN` and `US BANK TRUST N.A.` are one company, classifies each company as a bank, servicer,
   private-credit fund, GSE, trust or MERS, and builds a network of who trades with whom.
4. **Presents** the result as filterable tables, charts, entity profiles, a watchlist and CSV
   exports, cross-referenced against **FDIC bank financials** so a counterparty's balance sheet sits
   next to its filing activity.

### Questions it is built to answer

- Which lenders are **selling down** mortgage exposure right now, and to whom?
- Which **private-credit funds** are accumulating South Florida mortgage paper?
- Which banks are financing which non-bank lenders through **warehouse credit facilities**, and at
  what stated limits?
- Is a given firm on my **target list** newly active, and on which deals?
- For a bank counterparty — what does its **CRE concentration, NPL ratio and capital** look like
  (FDIC), alongside what it is actually doing in the records?

### What it is *not*

- Not a title search or lien-position tool. It tracks the *transfer* of mortgages, not ownership of
  property.
- Not a real-time feed. Counties publish on a lag (Broward runs ~3 business days behind), and the
  dashboard rebuilds derived tables nightly.
- Not a system of record. The county is the system of record; this is a derived analytical copy.

---

## 3. Key concepts and glossary

Understanding five terms makes the whole dashboard readable.

| Term | Meaning |
|---|---|
| **CFN / instrument number** | The county's unique id for a recorded document. Miami-Dade CFNs always contain an `R` (`2026R521735`); Broward instrument numbers are always pure digits (`121018052`). This disjointness is what lets both counties share one key space. |
| **Raw assignment** | A row exactly as the county indexed it — grantor, grantee, date, book/page. Unfiltered, includes documents that are not mortgage transfers at all. |
| **Clean transaction** | A raw filing that the PDF extractor confirmed is a genuine **LOAN_TRANSFER**, with names taken from the document body rather than the index. This is the analytical dataset. |
| **Canonical entity** | One company, after typo correction, suffix stripping, OCR-damage repair and analyst-approved merges. Charts and profiles are keyed on this, not on the raw string. |
| **Credit facility event** | A filing whose text describes an institutional lending relationship (warehouse line, revolver, syndicated credit agreement) rather than a one-off sale. Surfaced on its own tab. |

### Document categories (assigned by the extractor)

`LOAN_TRANSFER` · `RENTS_LEASES` · `COLLATERAL` · `OTHER`
Only `LOAN_TRANSFER` reaches the clean transaction tables.

**"Assignment of collateral" is a category, not a document type.** The county has no such filing
type — those documents are recorded as ordinary `ASG`/`AMO` filings and the extractor identifies
them by reading the PDF. **19,123 documents currently carry `COLLATERAL`.**

### Which document types we collect (audited 8–9 Sep 2026 against the live portal)

The Miami-Dade clerk offers **79** document types. Exactly **three** are assignments, and we
request all three:

| Type | Code | Status |
|---|---|---|
| Assignment of Mortgage | `AMO` | Collected — the core dataset |
| Assignment | `ASG` | Collected — generic bucket, PDF classification sorts it |
| Assignment of Interest | `AIT` | Requested, but the county returns **nothing** for it (see below) |
| Financing Statement UCC | `FST` | **Added 9 Sep 2026** — not an assignment; see below |

So no assignment category was ever missing. Broward folds every assignment into a single code
(`AST`), already verified as its only assignment code among the 65 present in its feed.

**AIT returns nothing, and never has.** The county answers every AIT search with "no results" — the
same answer it gives for a day the courthouse was closed. Zero AIT documents have been collected
since the type was added on 16 Jun 2026. It is **kept in the collector deliberately**, at the
owner's decision, so that collection begins automatically if the county ever starts using it.

**FST (UCC financing statements) is not an assignment** — a UCC-1 records a *new* security interest
rather than transferring a mortgage. It is collected for the lending relationships it exposes
(secured party ↔ debtor, present on **99%** of filings) at roughly **42 filings/day**, comparable
to ASG. Its composition is mixed: genuine commercial lending (City National Bank of Florida, Popular
Bank, U.S. Century, BankUnited, Banesco, Bayview) alongside a large volume of consumer solar and
home-improvement finance (ISPC, GoodLeap, Solar Mosaic — over a quarter of the bucket). **It is
deliberately excluded from the Reporting tab and from entity classification** so it cannot move the
assignment numbers the dashboard already reports; the underlying data is still collected and stored.

### Entity types

`BANK` · `SERVICER` · `PRIVATE_CREDIT` · `GSE` · `MERS` · `TRUST` · `OTHER`

Assigned by a cascade, highest confidence first:
**manual override → FDIC institution match → legal-suffix signal → behavioural pattern → regex rules → LLM fallback → `OTHER`.**

### Transaction types

| `txn_type` | Meaning |
|---|---|
| `SELF_ASSIGN` | Both sides resolve to the same company — an internal re-titling, not a market event. |
| `MERS_RELEASE` | MERS on **either** side — the registry handing over, or taking, the placeholder interest it holds as nominee. Record-keeping, not a trade. (Until 18 Sep 2026 MERS was typed `BANK`, so ~2,900 of these counted as market transfers.) |
| `MARKET_TRANSFER` | Institution → institution. **The real signal**: debt actually changing hands between market participants. |
| `ORIGINATION` | Non-institution → institution. Paper entering the institutional market. |
| `INSTITUTIONAL_OUT` | Institution → non-institution. Paper leaving it. |
| `PRIVATE` | Neither side is an institution. |

### Direction — which way did the loan move?

Miami-Dade's county index sometimes lists the two parties of an assignment **backwards** — about
7,500 loan transfers (13.6%), found 17 Sep 2026. Since 18 Sep 2026 (weekend rebuild) the rule is:
**the document decides the direction, the index keeps the spelling.** The AI reading of each document
names its assignor and assignee; where that is the exact or near reverse of the index, the row is
flipped. An independent text check on the stored document text (`document_text`, kept since the
18 Sep re-read) can overrule a flip; rows where the two disagree are kept as the index has them and
listed in `direction_decisions` with `needs_review = 1`. Broward's index is not affected. Code and
evidence: `collector/document_direction.py`.

### County scope — an important nuance

The county selector filters **document-level** data (filings, clean transactions, facilities,
reporting, collection log).

It does **not** filter **entity-level** panels (Top Acquirers, Top Sellers, Most Connected, entity
profiles). Those tables are keyed by company, not by document — a lender that trades in both counties
is deliberately one entity, because cross-county entity resolution is a core purpose of the tool.
Panels in this category carry an on-screen label saying so; they are never silently presented as if
they respected the selector.

---

## 4. How to use the tool

### 4.1 Getting in

1. Open the production URL.
2. Enter the shared password (`AMO_PASSWORD`). The session cookie lasts **7 days**.
3. There are no roles or per-user accounts — everyone who logs in sees everything.

> **Not sure what a filter means? Hover over it.** Since 17 Sep 2026 every filter and view button —
> *Loan transfers*, *Collateral*, *Mortgage (AMO)*, *Warehouse / Revolving*, *Market Transfer* and the
> rest — shows a plain-English definition on hover. Column headers with an ⓘ icon work the same way.
> The definitions are kept in one place, so a term means the same thing on every page.
>
> One honest caveat those definitions call out: on the **UCC Filings** page, *Collateral* and *Other*
> are not yet a reliable split — both contain the same mix of original filings, amendments,
> continuations and terminations.

### 4.1a The weekly email — "AMO Market Monitor"

Goes to the named recipients **Monday at 07:00 Eastern**, reading the data Friday's collection run
left behind.

Since 21 Sep 2026 it is a **roll-up over three horizons** — the last 15 days, the last 30 days and the
last 360 days — each compared with the period of equal length immediately before it. The owner asked
for this on 19 Sep so the recipients can see how the current fortnight sits against the month and the
year, rather than reading a fortnight in isolation.

What it covers, in order: a plain-English "Pulse" paragraph; three headline cards (transfers, change
vs the prior period, stated dollar volume, transfers per business day, active sellers); a 52-week
trend chart; pace per business day; the most active sellers and buyers with a momentum multiplier
against each firm's own 360-day norm; firms heating up and cooling off; the top seller→buyer
relationships; the largest loans of the last 30 days; and the most recently filed lending
relationships. The last 30 days of transfers and every lending relationship are attached as CSVs.

A **"What kind of activity" section** — the share of transfers by transaction type in each window,
as a stacked bar plus a percentage table — sat between the pace chart and the sellers table until
**2 Oct 2026, when the owner had it removed**. Nothing else in the email breaks transfers down by
`txn_type`, so the whole block went: the palette, both builders and the per-window counts. The
column is still read for the `SELF_ASSIGN` filter and still rides along in the attached CSV.

**Miami-Dade and Broward are held apart throughout.** The headline cards, the transaction mix, the
sellers and buyers tables and the top relationships each carry their own county breakdown, and the
pace chart draws a separate block per county. This is shown as a colour-coded line under each row
rather than as `M-D`/`BRW` columns: the tables already carry three window columns, and six numeric
columns wrap in Outlook and on phones.

Two rules keep the comparisons honest:

- **Each county's windows end on its own latest recorded date.** Miami-Dade is collected weekly and
  Broward daily, so a shared end date would leave several empty days at the end of Miami-Dade's
  window and read as a slowdown that never happened.
- **A "vs prior" change counts only counties with complete data in both periods.** Broward loan
  transfers begin 22 Jul 2026, so it is excluded from the 30- and 360-day comparisons — which are
  labelled "Miami-Dade only" — rather than manufacturing growth out of a coverage change. The
  360-day comparison stays Miami-Dade-only until roughly July 2027.

It hides Wilmington Savings, MERS, Fannie Mae and Freddie Mac, exactly as the Reporting tab does.

**And since 2 Oct 2026 it also hides five large firms that the dashboard still shows** — Wells Fargo,
JPMorgan Chase, Freedom Mortgage, Bank of America and Rocket Mortgage — at the owner's request, so
the recipients see the market they compete in rather than the market's biggest names. **This is the
one place the email and the Reporting tab deliberately disagree**, and it is a reversal of the 17 Sep
decision to share one list precisely so they could not. Expect "the email says 440 and the dashboard
says 526" to be asked; it is not a bug. The email states the five firms in its own footer so a
recipient is never comparing numbers without being told. Measured on 2 Oct, this removes **19.5% of
the 15-day rows, 36.0% of the 30-day rows and 24.6% of the 360-day rows**.

The list lives in `server/email/exclusions.ts`, separate from `server/reporting/exclusions.ts` on
purpose — consolidating them "for consistency" would silently rewrite the dashboard. Two tables need
two matching rules: loan transfers match exactly on canonical names (safe only because `normalize.py`
folds every variant into one spelling), while `credit_facility_events` keys are **not** brand-collapsed
(production holds both `JPMORGAN CHASE BANK NA` and `JPMORGAN CHASE BANK NATIONAL ASSOCIATION`), so
those are matched by squashing to letters and digits and testing containment. The Lending
Relationships tab's own query is untouched; the email filters its result. `npm run check` runs
`script/check-email-exclusions.ts`, which fails if a name variant ever escapes the exact match or if
one of the five leaks into the reporting list.

Charts are built from table cells with background colours, never SVG or images, because Outlook
desktop renders HTML with the Word engine and often blocks images.

**Status 2 Oct 2026 — LIVE. `REPORT_EMAIL_ENABLED=1` is set, and the next send is Monday 5 Oct
07:00 ET to `andres@` and `david@`.** The owner opened the gate deliberately after reviewing the
template. `.env` was backed up to `.env.before_email_enable.20261002T143231Z` first; removing the
variable (or setting it to anything but `1`) switches the send off again with no code change.

Earlier notes claiming the droplet "still holds the previous 15-day template" were wrong and reasoned
from the unbuilt `dist/` rather than from what cron executes — the scripts run from source via `tsx`,
so the roll-up has been the live template since 22 Sep.

**Confirmed delivered: Monday 5 Oct 2026, 11:00:01 UTC = 07:00:01 EDT**, to `andres@` and `david@`,
in 8 seconds — the roll-up's first send to a real recipient. The second cron firing exited on the
hour guard as designed, so they received one email. Subject: *"AMO Market Monitor — Oct 5: 407
transfers in 15 days (+7%)"*, Miami-Dade through 1 Oct, Broward through 28 Sep. Before that, the last
real send was 21 Sep, to the same two people, using the old 15-day template.

**Schedule moved to Monday 07:00 Eastern on 2 Oct 2026**, at the owner's request. The send used to be
step 5 of `run_weekly.sh`, which tied the send day to the Friday collection day; it is now
`collector/send_weekly_email.sh` on its own cron entry (§6.5). Monday deliberately follows Friday's
collection: Miami-Dade is collected only in that weekly run, so a Monday report reads Miami-Dade
through Friday and Broward through Sunday — which costs nothing, because each county's windows end on
its own latest recorded date.

The old 15-day builder remains at `server/email/report.ts`, unused, until the roll-up has sent
cleanly a few times.

### 4.2 The county selector

Top of the left sidebar, above the navigation. Three options: **Miami-Dade**, **Broward**, **All
Counties**. It is global — it applies to every page and persists across navigation.

> Changing the county **clears the client-side query cache** and refetches. A brief loading state is
> expected and correct.
>
> A derived figure showing `—` rather than `0` means *"this county has no processed documents for
> this metric yet"*, which is not the same as *"there was no activity"*.

### 4.3 The pages

Navigation is grouped into **Analysis** and **Data**.

#### Overview (`/overview`)
Headline counts (total filings, unique entities, market transfers, self-assigns,
private-credit activity), date coverage, monthly assignment volume chart, and the Top Acquirers / Top
Sellers / Most Connected leaderboards.
*Go here to see whether the data is current — the date range and last-collected date are the fastest health check.*
Until 7 Oct 2026 this was the landing page at `/`; `/` now redirects to Ask the Data (owner's
request), and Overview is the second entry in the sidebar.

#### Ask the Data (`/ask`) — the landing page since 7 Oct 2026; in **Beta** (badge on the tab and the page header)
The Beta badge is the owner's marker that the page is live for evaluation, not yet a
supported part of the tool (it first shipped as "TESTING/NOTDEPLOYED", renamed the same day). Drop it
(`badge` field in `client/src/components/Sidebar.tsx`, header span in `pages/Chat.tsx`) once the
first round of real questions has been reviewed. A chat box. Type a question in plain English — *"who were the top acquirers in 2025 and how does that
compare to 2024?"*, *"which banks provide warehouse lines, and to whom?"*, *"what does CFN 2025R123456
say?"* — and a language model (OpenAI **GPT-6 Astra** by default) answers from this database, the way
ChatGPT would, with the figures streamed in as it writes.

**How it stays honest.** The model never sees the database directly and cannot invent numbers from
memory: it is given ten named lookups (entity search, entity profile, rankings, monthly volume,
individual filings, lending relationships, facility filings, stored document text, dataset coverage,
and a guarded read-only SQL query) and must call them. Every lookup it ran is shown above the answer
in a collapsible **"N lookups"** strip, with the arguments, row counts, timings and — for SQL — the
exact query, so a figure can always be traced. Its instructions carry the data traps documented on
this page (never sum `facility_amount`, entity figures are cross-county, Broward is index-only,
missing amounts are unknown not zero, collection gaps are not market stops), and it is told to state
the county and date window it used. The active **county selector** is passed in as its default scope.

Expect it to be wrong sometimes — the page says so under the box. Open the lookups and check the
underlying page before relying on a number. The conversation lives in the browser tab only; **New
chat** clears it. Nothing is written to the database, and the OpenAI key never reaches the browser
(§5.5 login gate applies to `/api/chat` like every other route).

#### UCC Filings (`/ucc`)
Secured lending, and a **separate page from Reporting on purpose**. A UCC financing statement
records a lender taking a security interest against a borrower — it is not a loan changing hands, so
the parties read **borrower → lender**, the opposite direction to an assignment. Folding the two
together would have listed property owners among the sellers of loans.

32,759 filings, 2023 to present, Miami-Dade. **84% carry a property address** (27,420), which is what
makes the page useful: it ties a named lender to a specific property. Only 7% carry an amount, and
that is structural rather than a gap — a UCC form describes what secures a debt, not its size.

**One caveat is stated on the page itself.** The county's index does not list the two parties in a
consistent order: the lender is listed first on roughly a third of filings. Where the document has
been read, the roles come from the form itself and are reliable (90% of filings). The rest are
marked with an amber warning and their direction may be reversed; the **Roles from document** filter
narrows to the confirmed ones.

**Consumer lending is hidden by default.** Solar and home-improvement financiers (GoodLeap, ISPC,
Aqua Finance, Sunnova, Solar Mosaic, Palmetto/Lightreach, Service Finance), plus filing agents and
utilities that are not lenders at all (Lien Solutions, Florida City Gas, FPL), account for **38% of
all filings** — 32,759 drops to 20,305 — and none of it is commercial real estate.
Also excluded at the owner's request: Cross River Bank (which files here through Sunlight Financial
and Marlette Servicing, i.e. consumer origination), Climate First Bank (solar-focused) and Florida
Housing Finance Corporation (a state agency, not a market participant). One toggle brings
them back; nothing is deleted. The match runs against **both** parties rather than just the lender,
because the county's party order is unreliable and 2,293 of these filings record the finance company
as the borrower.

Names appear exactly as filed and are **not** merged into canonical entities. Borrowers here are
mostly property companies named after street numbers, and the merging rules used elsewhere in the
tool would combine "10820 Investments LLC" with "11140 Investments LLC".

#### Reporting (`/reporting`)
The main working surface. A filterable, searchable, paginated table of clean transactions with an
analytics header, a participant-activity breakdown and a time-series chart.
- **Four counterparties are hidden here** (since 10 Sep 2026): **MERS, Fannie Mae, Freddie Mac and
  Wilmington Savings**. They are registry and agency pass-throughs rather than market participants,
  and they crowded out the transactions this page exists to show — together they touched about
  **13% of filings** (6,317 of 48,636). Hiding them took the Miami-Dade table from 48,636 rows to
  **42,319**.
  **This is a display filter and nothing else.** Every one of those rows is still in the database,
  and the Overview, Entities, Lending Relationships and emailed report all still count them — so
  totals on this page will not match totals elsewhere, by design. The filter applies to the table,
  both exports, the participant panels and the chart, so everything on this page agrees with itself.
  It is reversible at any time; ask an engineer to edit one list in `server/routes.ts`.
  *One deliberate exception:* the **entity report** still works for these companies if you name one
  explicitly — otherwise asking for a MERS report would silently return zeros.
- **Every number on this page now counts the same rows** (fixed 10 Sep 2026). The charts and the
  Participant Activity panel had been counting **self-assignments** — filings where a firm assigns
  to itself — which the transaction table has always excluded. The charts read 39,120 against the
  table's 36,993, and the participant panels overstated individual firms badly: US Bank showed 1,724
  transfers out against a true 1,155, because a self-assignment names the same firm on both sides
  and inflated both of its columns at once.
  Two visible consequences, both intended: the **Txn Types** chart no longer shows a `SELF_ASSIGN`
  slice, because no self-assignment is in the reported set; and **Most Active** now counts the
  filtered period rather than all-time, so it responds to the date filter like everything else and
  its "first/last activity" dates describe the selected window. Self-assignments are still in the
  database and still counted on the Overview.
- **Filter by document type** (added 10 Sep 2026). Four pills under the search box — *All*,
  *Mortgage (AMO)*, *Generic (ASG)*, *Broward (AST)* — each showing how many filings it holds
  **under whatever other filters you already have set**. Pick one and the whole page follows: the
  table, both exports, the charts and the participant panels. A type with nothing in it reads `0`
  and greys out rather than disappearing, so Broward's AST visibly reads 0 while you are scoped to
  Miami-Dade instead of silently vanishing.
  This filters by **the type the county filed the document under**. To filter by what the document
  turned out to be on reading, use *Shows* below.
- **Filter by what the document is** (added 11 Sep 2026). A second row of pills — *Loan transfers*,
  *Collateral*, *Rents & leases*, *Other*, *All documents*.
  **Loan transfers is the default and is exactly what this tab has always shown**, so nothing you
  have quoted from here has changed. The others were previously invisible: assignment filings whose
  PDF turned out to record something other than a loan changing hands.
  Selecting a category changes *who appears*, not just how many. Rents & leases surfaces Greenbox
  Loans, Casa Finance and Taylor Made Lending — names that do not appear on the loan-transfer
  leaderboard at all. The whole page follows the selection: table, both exports, charts and
  participant panels.
  A filing only appears here **once we have actually read its PDF**. Around 42,000 Broward filings
  are indexed but unreadable until the bulk image order lands (§7.6), and they are deliberately kept
  out — a document nobody has read is not "other", it is unknown. They remain on Raw Assignments.
  **UCC filings are not in either list.** They are a different instrument and their party columns
  mean the opposite thing: on an assignment the first party is the institution selling the loan, on a
  UCC filing it is the borrower. Mixing them would put property owners into the seller rankings.
  They will get their own view.
- **The Class column says what the document is.** For a loan sale it reads *LoanSale*; for the other
  categories it reads *Collateral*, *Rents & leases* or *Other* in neutral grey — a statement about
  the document, not a review verdict. Anything you mark by hand overrides it. *(Corrected 14 Sep
  2026: before that, collateral and rents filings inherited a loan-transaction label and could read
  "LoanSale", which was wrong on every non-loan row.)*
- ✅ **Company names beginning with a number now keep it** (fixed 14 Sep 2026). "7190 Holdings LLC"
  reads as "7190 Holdings" rather than "Holdings". The display was the small half of that problem;
  the large half was that unrelated firms sharing the leftover word were **counted as one company** —
  "Investments" was 47 different businesses with their volumes summed. 1,752 filings across 1,113
  companies, all separated now.
  *One consequence to know:* where a filing carried a stray leading digit that was genuinely noise,
  that company may now appear twice. That is deliberate — a duplicate you can see and merge on the
  Entities page is safer than a merge that invents a company you cannot. Tell an engineer if you spot
  one and it can be merged permanently.
- ✅ **Names written letter-by-letter now merge with their company** (fixed 14 Sep 2026).
  "Capital One N A" joins Capital One, "U S Bank N A" joins US Bank, including OCR-damaged forms like
  "U S Bank TRUSY N A". The county records these abbreviations with spaces, and the name cleaner
  previously allowed a full stop between the letters but not a space — so the same institution sat in
  two places across **1,084 filings**. "U S Century Bank" is correctly left alone; it is a different
  bank.
- Search by CFN, assignor or assignee.
- **Review workflow:** mark a row reviewed/unreviewed; the marking is stored server-side and shared
  by everyone.
- **Download report** (replaced the CSV button, 20 Aug 2026): a two-sheet Excel workbook for the
  current filter set. Sheet 1 *Summary* — report parameters (scope, period, direction, filters,
  generated-at) and per-entity summary statistics (total/sold/acquired filings, net, **$ assigned
  out and $ acquired as separate columns** — each filing's underlying mortgage principal attributed
  to its assignor and assignee respectively; note this is loan principal, not price paid —
  first/last activity, top counterparty) with a totals row that ties out to the detail sheet;
  entities with zero activity stay listed, muted — that absence is often the finding. With no entities selected it shows top-sellers/top-acquirers tables instead. Sheet 2
  *Transaction Detail* — every filing, styled header, frozen pane, autofilter, CFNs hyperlinked
  to the county document image. The raw-CSV endpoint (`/api/reporting/export`) still exists for
  the per-entity mini CSV buttons and any scripted use.
- **Entity report:** a per-company written summary of activity.
- **Paste a list** (added 19 Aug 2026): for requests like "run a report on these 29 banks" — click
  *paste a list* in the entity picker, paste one name per line (slashes and parentheticals are
  understood, e.g. "U.S. Century Bank / USCB Financial"). Each line is matched against the entities
  on record: confident whole-word matches come pre-checked, loose look-alikes (e.g. "Ameris" →
  AMERISAVE MORTGAGE) stay unchecked for human review. Confirm, and all matches become report
  entities at once. Banks often exist under several recorded spellings (BANKUNITED + BANKUNITED
  N A) — select all variants to cover the institution.
- **Direction filter** (same date): with entities selected, restrict the filing tables and CSV
  export to *Sold / assigned out* (the selection as assignor) or *Acquired* (as assignee). The
  entity-report KPIs above it always show both directions, labeled in/out.

#### Targets (`/targets`)
Your watchlist of market participants. Search the canonical entity list, add a firm, and the page
tracks its filing activity. Each row links straight through to that firm's filings in Reporting.
Seeded in bulk from `collector/targets_seed.csv`.

#### FDIC Data Analytics (`/market-analytics`)

> **Re-sourced 7 Oct 2026 (deployed 16:56 UTC).** The page now reads the Market Intelligence tool
> instead of querying the FDIC API directly. See the end of this section for what changed.

Bank screening, scores and balance-sheet signals from FDIC Call Report data, **served by the Market
Intelligence tool** — the same figures as its *Market Analytics* tab, rendered in this dashboard's
layout. This app no longer computes any FDIC analytics itself; it reads the Market Analytics data API
through the server and shows what it gets. The header states the quarter the figures describe
("Data as of Q2 2026") and the line **"Source: FDIC Call Report via Market Intelligence"**.

What is on the page, top to bottom:

- **Scope selector** — United States or any state (52 state-level scopes, from the API's own list).
- **NPL & Loans** — total loans, nonaccrual dollars and ratio, CRE loans, CRE/assets, total assets
  for the scope.
- **Cohort Summary** — institutions screened and the average NPL, noncurrent, reserve-coverage and
  CRE-concentration ratios.
- **Target Screening List** — one row per bank, ranked by **Opportunity Score** by default, with
  **Earnings** and **Vulnerability** scores as sortable columns beside it. The three scores are
  **percentile ranks within the selected scope** (0–100), computed by Market Intelligence; the
  glossary (hover any underlined header) explains each. A **Signals** column shows the
  **balance-sheet signals** that fired for the bank in the latest quarter as chips — e.g. *HFS
  transfer*, *Realized sale*, *CRE charge-off spike*, *Foreclosure route*, *Modification build* —
  seven in all, defined by the source, with the plain-language meaning and the rule on
  hover. Every column from before (CRE mix, NPL, noncurrent, ROA/ROE, efficiency, capital, NI YoY) is
  still there and the **Columns** menu still chooses which show.
- **Institution drawer** (click a row) — the structural, earnings and peer-positioning panels as
  before, plus three sections from the source: an **eight-quarter Trend** with a one-line verdict
  and four trend charts (asset quality; capital; CRE exposure against the 300% / 100% interagency
  guidance lines; earnings) above the quarter table,
  **Acquisition History**, and **Balance-Sheet Actions** — the fired signals, a plain-English reading
  of what the bank did with its CRE book this quarter, a chart of the **CRE problem-asset balances**
  (nonaccrual, modifications, OREO, held-for-sale by quarter), and the nonaccrual **roll-forward** (prior
  balance → new → charge-offs → to OREO → unexplained exit → current, in dollars, eight quarters and
  the latest quarter by CRE category). A **Generate narrative** button asks the source for a written
  eight-quarter summary; it is the only thing on the page that triggers an LLM call upstream, and it
  only happens when pressed.

**Read the cohort line under the screening list.** It says how many institutions the source covers
in the scope and how many survive its screen (Florida: 85 of 92). **Nationally the screening cohort
is about 1,100 institutions** — Market Intelligence's own national screen is a large-bank screen —
while its balance-sheet *signals* cover ~4,300. Peer percentiles in the drawer are relative to
whichever cohort is loaded, not to all US banks. The page states the count it actually screened
rather than implying a complete one.

**When do the numbers change?** Only when Market Intelligence's cache refreshes — a daily job on its
side, keyed by FDIC quarter — and then within up to seven days here, because the server keeps API
responses for a week (§5.6). FDIC publishes a quarter months after it closes, so "latest" is typically
one to two quarters behind today. If a new quarter has landed upstream and this page still shows the
old one, a cache bust (§6.8) brings it forward immediately.

**If the page says "Market Intelligence unavailable"**, the source did not answer (wrong or missing
key, or the service is down). The page deliberately shows **no figures at all** in that state rather
than a stale set — every card reads `—` and the table is empty — so nothing on screen can be mistaken
for current data. The message under the heading is the upstream error; "Unauthorized" means the key
in `.env` is wrong (§6.2).

*What changed from the version that ran until 7 Oct 2026:* the old page queried the FDIC BankFind API
itself and computed ratios locally; its national screen was the ~1,113 largest banks because of
FDIC's 10,000-row response cap; the Opportunity/Earnings/Vulnerability columns were hardcoded to 0
and hidden; there were no signals, trend, acquisition or balance-sheet sections in the drawer; and
the figures refreshed whenever FDIC's API did.

#### Clean Transactions (`/clean-events`)
The verified `LOAN_TRANSFER` dataset, one row per confirmed transfer, with document-derived names,
parent companies, loan amount and consideration. Filter by assignor, assignee, type and date. Each
row links to the recorded document on the county portal. An **"Understanding this table"** panel
explains the classification inline.

#### Private Credit (`/private-credit`)
Every transaction with a `PRIVATE_CREDIT` counterparty on either side, self-assignments excluded,
plus a Top Private Credit Acquirers leaderboard. The fastest read on non-bank capital entering the
market.

#### Lending Relationships (`/credit-facilities`)
Warehouse lines, revolvers and syndicated agreements extracted from document text, grouped by
**lender ↔ borrower family** rather than by filing. Per-family drill-down, filing-activity chart, top
lenders, and CSV export of both a single relationship's history and the full filtered list.

> **Do not sum stated credit limits across a family.** A facility's limit is restated on every
> filing; adding them double-counts. The UI says so at the group level and shows limits only on the
> individual facilities inside a group.

#### Raw Assignments (`/assignments`)
The unfiltered county index, exactly as recorded — including documents the extractor classified as
non-transfers. Use it to confirm something exists, or to inspect what the filter removed.

#### Entities (`/entities`)
The canonical company list with volumes, degree and type. Two analyst actions live here:
- **Reclassify** an entity's type when the automatic cascade got it wrong.
- **Duplicate Manager** — review suggested merges of name variants, approve or dismiss them. An
  approved merge is applied immediately *and* re-applied on every subsequent rebuild.

#### Collection Log (`/collection-log`)
Every collection run: date window, records found, status. County-scoped. **This is the operational
health page** — gaps or `FAILED` rows here mean the pipeline missed a window.

### 4.4 Everyday tasks

| I want to… | Do this |
|---|---|
| See who bought the most mortgage debt this quarter | Overview → Top Acquirers, then Reporting with a date filter |
| Track a specific firm | Entities → find the canonical name → add via Targets |
| Pull a list for a memo | Reporting → filter → **Export CSV** |
| Find who finances a non-bank lender | Lending Relationships → search the borrower |
| Check a bank counterparty's health | FDIC Data Analytics → search the institution |
| Verify a specific document | Raw Assignments → search CFN → follow the document link |
| Confirm the data is current | Collection Log, plus the date range on Overview |
| Fix a wrong company name or type | Entities → Duplicate Manager / reclassify |

---

## 5. Architecture

### 5.1 Data flow

```
  MIAMI-DADE                          BROWARD
  Clerk web portal                    Public SFTP feed
  (Playwright, reCAPTCHA-free         (BCFTP.Broward.org — no scraping,
   via UI intercept)                   no login, no captcha)
        │                                    │
        │ collect_live.py                    │ broward_collect.py  (index)
        │                                    │ broward_images.py   (TIFFs, ~10-day window)
        ▼                                    ▼
  ┌──────────────────────────────────────────────────────┐
  │  assignments        — raw county index, county column │
  │  broward_images     — harvested document images       │
  │  collection_log     — what ran, when, with what result│
  └──────────────────────────────────────────────────────┘
        │
        │  extract_pdfs.py        (real-time, forward collection)
        │  batch_extract_facility.py (OpenAI Batch API, historical backlog)
        │      download → OCR (poppler + tesseract) → LLM (gpt-4.1-nano)
        ▼
  ┌──────────────────────────────────────────────────────┐
  │  pdf_extractions  — document-derived truth, cached    │
  │                     by CFN, survives every rebuild    │
  └──────────────────────────────────────────────────────┘
        │
        │  normalize.py   (canonicalize → dedupe → classify → rebuild)
        │  enrich_entities.py  (LLM fallback for unclassified names)
        ▼
  ┌──────────────────────────────────────────────────────┐
  │  aom_events_clean        entity_nodes                 │
  │  credit_facility_events  entity_relationships         │
  │  entity_classifications  entity_edges                 │
  └──────────────────────────────────────────────────────┘
        │
        │  Express + better-sqlite3  (~50 endpoints, 7-day in-memory cache)
        ▼
     React client  ─── Market Intelligence data API (proxied server-side, bearer key held on the server)
```

The FDIC Data Analytics page is the one tab whose figures do not come from the SQLite database. Since
7 Oct 2026 the server forwards `/api/mi/*` to the Market Intelligence tool's Market Analytics API,
adds the bearer key, and caches successful answers for the usual seven days; the key never reaches
the browser. (Until then the tab proxied the public FDIC BankFind API and computed ratios locally.)

### 5.2 Components

| Layer | Tech | Location |
|---|---|---|
| Client | React 18, Vite, TypeScript, Tailwind, shadcn/Radix, TanStack Query, wouter (hash routing), Recharts, D3 | `client/` |
| Server | Express 5, better-sqlite3, TypeScript, esbuild bundle | `server/` |
| Collector | Python 3, Playwright, paramiko, requests, tesseract/poppler | `collector/` |
| Database | SQLite (WAL mode), single file `miami_dade_amo.db` | droplet: `/opt/amo-dashboard/` |

**Why SQLite:** the dataset is ~100–150 MB, single-writer, read-heavy, and the whole system runs on
one box. `better-sqlite3` is synchronous and prepares all hot statements once at startup, so typical
endpoint latency is single-digit milliseconds without a separate database server to operate.

### 5.3 Repository layout

```
amo-dashboard/
├── client/src/
│   ├── pages/          one file per dashboard tab
│   ├── components/     EntityDetailPanel, DuplicateManager, InstitutionProfileDrawer, ui/
│   └── lib/            county scope, doc-url builders, metrics, query client
├── server/
│   ├── index.ts        express bootstrap, auth wiring, static vs vite
│   ├── routes.ts       ~50 API endpoints  (large — see §6.7)
│   ├── db.ts           schema + idempotent migrations, run at startup
│   ├── auth.ts         single-password HMAC cookie gate
│   ├── cache.ts        in-memory TTL response cache
│   ├── market-intelligence.ts   Market Analytics API client + /api/mi/* routes (replaced fdic.ts, 7 Oct 2026)
│   └── chat/           "Ask the Data" (7 Oct 2026): index.ts POST /api/chat SSE loop · tools.ts the
│                       ten read-only lookups · prompt.ts system prompt + schema + data traps · openai.ts
│                       streaming client for the OpenAI *Responses* API (no SDK; GPT-6 Astra refuses
│                       tools + reasoning on Chat Completions — learned from the first production call)
├── shared/
│   └── schema.ts
├── docs/
│   └── market-intelligence-meta.json   saved copy of the API's /meta — the contract this app consumes
├── script/
│   ├── build.ts               vite (client) + esbuild (server bundle)
│   └── check-metric-directions.ts   guardrail (see §6.6)
├── collector/
│   ├── collect_live.py            Miami-Dade portal collector
│   ├── broward_collect.py         Broward SFTP index collector
│   ├── broward_images.py          Broward image harvester (time-critical)
│   ├── extract_pdfs.py            OCR + LLM extraction (real-time)
│   ├── batch_extract_facility.py  OCR + LLM extraction (Batch API backlog)
│   ├── normalize.py               the rebuild — derived tables, classification
│   ├── enrich_entities.py         LLM fallback classification
│   ├── entity_names.py            shared canonical-name address book
│   ├── name_matching.py           OCR-damage merge proposals
│   ├── apply_proposals.py         record approved merges/parents
│   ├── migrate_add_county.py      multi-county schema migration
│   ├── tests/                     guardrails (see §6.6)
│   └── run_*.sh                   cron wrappers
├── tools/
│   └── droplet-mcp/    MCP server exposing droplet ops as named tools (§6.4a)
├── CLAUDE.md           operational facts for AI assistants
├── SESSION_LOG.md      dense running history — read before changing anything
└── ROLLBACK.md         revert paths for in-flight workstreams
```

### 5.4 Core tables

| Table | Rows (prod) | County column | Rebuilt by `normalize.py`? |
|---|---|---|---|
| `assignments` | ~113,400 | ✅ | ❌ source of truth |
| `pdf_extractions` | Miami-Dade bulk + 539 Broward | ✅ | ❌ cached, expensive to regenerate |
| `broward_images` | 658 | n/a | ❌ |
| `collection_log` | ~1,330 | ✅ | ❌ |
| `aom_events_clean` | ~51,800 | ✅ | ✅ **dropped and rebuilt** |
| `credit_facility_events` | ~445 | ✅ | ✅ **dropped and rebuilt** |
| `entity_nodes` | ~20,400 | ❌ by design | ✅ |
| `entity_relationships` | edge list over `entity_nodes` | ❌ by design | ✅ |
| `entity_classifications` | ~22,455 | ❌ | partly — LLM results cached |
| `entity_aliases` | analyst-managed | ❌ | ❌ **decisions, never overwritten** |
| `target_entities` | analyst-managed | ❌ | ❌ |
| `batch_jobs` / `batch_job_documents` | in-flight state | n/a | ❌ |
| `backup_runs` | one row per nightly backup | n/a | ❌ operational log, read by the Overview banner |

**The rule that matters:** `pdf_extractions`, `entity_aliases` and `target_entities` are *inputs* —
expensive extraction results and human decisions. `aom_events_clean`, `credit_facility_events`,
`entity_nodes` and `entity_relationships` are *outputs* — safe to drop, always reproducible. Never
hand-edit an output table; change the input and re-run `normalize.py`.

### 5.5 Authentication

Deliberately minimal: one shared password, gated in middleware ahead of every route including static
assets. The cookie is `base64(timestamp).HMAC-SHA256(payload, secret)`, verified with a
constant-time compare, valid 7 days. No session store, no user table.

Configured by `AMO_PASSWORD` and `AMO_SECRET`. **The defaults are weak (`amo2024`) — both must be set
in the production environment.**

### 5.6 Response cache

All expensive endpoints are cached in process memory.

- Default TTL **7 days** (matches the historical weekly refresh); stats/summary endpoints **6 hours**.
- Key = request path + sorted query string, so every county/filter/page combination caches separately.
- `POST /api/cache/bust` clears it; `GET /api/cache/stats` reports live/expired counts.
- A `pm2 restart` also clears it, because the cache is in memory.
- Market Intelligence responses (`/api/mi/*`) share the same cache and TTL under keys
  `mi:<endpoint>` + scope/band/cert. **Only `ok:true` bodies are stored** — an upstream 401/502/503 is
  never cached, so a bad key cannot leave a week-long error behind once corrected, and a working key
  cannot be masked by a cached failure.

> ⚠️ **The single most common operational mistake in this project:** changing data without clearing
> the cache. The database is correct and the dashboard still shows the old numbers — for up to a
> week. See §6.5.

---

## 6. Developer maintenance

### 6.1 Local development setup

```bash
git clone <repo> && cd amo-dashboard
npm install
```

Get a copy of the production database (there is no seed data generator):

```bash
ssh root@165.22.35.75 "sqlite3 /opt/amo-dashboard/miami_dade_amo.db \".backup /tmp/snap.db\"" && scp root@165.22.35.75:/tmp/snap.db ./prod_snapshot.db
```

```bash
AMO_DB_PATH=./prod_snapshot.db npm run dev
```

Client and API are both served on port 5000 by Vite middleware in development.

Python collector:

```bash
cd collector && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install paramiko playwright && .venv/bin/playwright install chromium
```

System dependencies for OCR: `poppler-utils` and `tesseract-ocr`
(macOS: `brew install poppler tesseract`).

> The checked-in local `miami_dade_amo.db` **lags production significantly**. Always verify actual
> row counts and date coverage before concluding something is broken.

### 6.2 Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AMO_DB_PATH` | server + every collector script | Prod: `/opt/amo-dashboard/miami_dade_amo.db` |
| `AMO_PASSWORD` | `server/auth.ts` | **Must be set** — weak default |
| `AMO_SECRET` | `server/auth.ts` | HMAC signing key; derived from password if unset |
| `PORT` | `server/index.ts` | Default `5000`; the only unfirewalled port |
| `NODE_ENV` | `server/index.ts` | `production` serves the built bundle; anything else runs Vite |
| `OPENAI_API_KEY` | `extract_pdfs.py`, `enrich_entities.py`, `batch_extract_facility.py`, **and since 7 Oct 2026 `server/chat/`** | Already in production `.env` for the collectors; **the Node server now reads it too, so it must be pushed into PM2's environment once** (§6.4). Missing → startup warning, `/api/chat` answers 503, the page shows a notice |
| `OPENAI_MODEL` | collector scripts | Default `gpt-4.1-nano` |
| `OPENAI_CHAT_MODEL` | `server/chat/openai.ts` | Model behind Ask the Data. Default **`gpt-6-astra`** ($10/M in, $50/M out). `gpt-6-sol` ($2/$10) is the cheaper fallback if usage grows |
| `OPENAI_CHAT_REASONING_EFFORT` | `server/chat/openai.ts` | `low` · `medium` (default) · `high` · `xhigh` · `max` · `none` (omits the `reasoning` parameter). Sent as `reasoning.effort` on the Responses API — Chat Completions will not accept tools + reasoning for GPT-6 models |
| `OPENAI_BASE_URL` | `server/chat/openai.ts` | Default `https://api.openai.com/v1`; an OpenAI-compatible gateway or a local mock for tests |
| `OPENAI_BUDGET_USD` | `extract_pdfs.py` | Hard spend cap per run |
| `NORMALIZE_COUNTIES` | `normalize.py` | Default `MIAMI-DADE,BROWARD`; `ALL` for every county |
| `CLERK_EMAIL` / `CLERK_PASSWORD` | `collect_live.py` | Miami-Dade portal login |
| `BROWARD_FTP_HOST/PORT/USER/PASS` | `broward_collect.py`, `broward_images.py` | Public credentials, overridable |
| `DOWNLOAD_WORKERS` | `extract_pdfs.py` | Auto-scales to `cpu_count()`, capped at 4 |
| `REPORT_SMTP_HOST` | `server/email/mailer.ts` | Default `smtp-mail.outlook.com`. **Unusable — DO blocks outbound SMTP**; see §7.4 item 9 |
| `REPORT_SMTP_PORT` | `server/email/mailer.ts` | Default `587` (STARTTLS) |
| `REPORT_SMTP_USER` | `server/email/mailer.ts`, `sendWeeklyReport.ts` | Default `mktinfo@safeharborcp.com` |
| `REPORT_SMTP_PASS` | `server/email/mailer.ts` | Outlook **app password**; installed in production but unusable while DO blocks SMTP |
| `REPORT_TRANSPORT` | `sendWeeklyReport.ts` | `graph` or `smtp`; defaults to `graph` when `GRAPH_CLIENT_ID` is set |
| `GRAPH_TENANT_ID` | `server/email/graphMailer.ts` | Azure directory (tenant) ID — **not yet set**, see §7.6 item 4 |
| `GRAPH_CLIENT_ID` | `server/email/graphMailer.ts` | Azure application (client) ID — **not yet set** |
| `GRAPH_CLIENT_SECRET` | `server/email/graphMailer.ts` | Azure client secret value — **not yet set** |
| `REPORT_RECIPIENTS` | `sendWeeklyReport.ts` | Comma-separated; default `andres@safeharborcp.com,david@safeharborcp.com` |
| `MI_BASE_URL` | `server/market-intelligence.ts` | Market Intelligence tool, `https://market-intelligence-tool-gilt.vercel.app`. **Required** for FDIC Data Analytics since 7 Oct 2026. Set in production (`.env` + PM2 env) |
| `MI_ANALYTICS_API_KEY` | `server/market-intelligence.ts` | Bearer key for its Market Analytics data API. **Required**; server-side only, never sent to the browser or written to a log. Missing → startup warning and `/api/mi/*` answers 503; wrong → the page says "Market Intelligence unavailable — Unauthorized." |

Production values live in `/opt/amo-dashboard/.env`, sourced by every cron wrapper. **The Node
process under PM2 does not read `.env`** — PM2 holds the environment it was started with, and a plain
`pm2 restart` keeps it. A variable that is new to the server (the two `MI_*` ones, for instance) has
to be pushed in once: see §6.4. `.env.example` in the repo lists every variable with a blank value.

### 6.3 Production environment

| | |
|---|---|
| Host | DigitalOcean droplet `165.22.35.75` |
| Spec | 4 vCPU / 8 GB RAM / 160 GB disk (resized 21 Jul 2026 for the full-history backfill) |
| Path | `/opt/amo-dashboard` |
| Process | PM2, app name `amo-dashboard`, running `dist/index.cjs` on port 5000 |
| Clock | UTC, no DST — all cron times below are UTC |
| Access | SSH key auth (`~/.ssh/id_ed25519`, passphrase in the macOS Keychain) |

**PM2 owns the process.** Never `kill` the Node process and relaunch it by hand — PM2 will restart it
underneath you and you will end up fighting it, or running two copies.

### 6.4 Deploy

```bash
cd /opt/amo-dashboard && git pull && npm run build && pm2 restart amo-dashboard
```

- **Build before restart.** Restarting first just relaunches the old bundle.
- **`git pull` alone changes nothing on the live site.** The server runs a compiled bundle.
- **If `package.json` changed, `npm install` before `npm run build`.** The build script deletes
  `dist/` *first*, so a build that fails on a missing dependency leaves no bundle on disk — the site
  keeps serving only because PM2 holds the old one in memory, and the next restart would take it down.
  This happened on the 7 Oct 2026 Ask the Data deploy (`react-markdown`/`remark-gfm` were new); the
  fix is simply `npm install && npm run build`, and never restart until `dist/index.cjs` exists.
- **Do not kill running Python backfills** when restarting the Node app; they are unrelated processes.
- Long one-off scripts must be started detached, or a dropped SSH session kills them:

```bash
nohup python3 -u collector/normalize.py > /tmp/normalize.log 2>&1 & disown
```

`-u` is not optional in practice — without unbuffered output, a healthy quiet run looks stalled.

**Adding a new server-side environment variable — one extra step** (this is how the two `MI_*`
variables went in on 7 Oct 2026). PM2 will not pick a new variable up from `.env` on its own:

```bash
cd /opt/amo-dashboard && git pull && npm run build
# 1. add MI_BASE_URL=… and MI_ANALYTICS_API_KEY=… to /opt/amo-dashboard/.env (cron wrappers read it)
# 2. push ONLY those two into the PM2-held environment and persist it:
export MI_BASE_URL="$(grep '^MI_BASE_URL=' .env | cut -d= -f2-)"
export MI_ANALYTICS_API_KEY="$(grep '^MI_ANALYTICS_API_KEY=' .env | cut -d= -f2-)"
pm2 restart amo-dashboard --update-env && pm2 save
# 3. verify — no "Market Intelligence is not configured" line, and login still works:
pm2 logs amo-dashboard --lines 20 --nostream
```

**Ask the Data went in this way on 7 Oct 2026 18:19 UTC** (kept here as the worked example for the
next server-side variable). The one variable the collectors already had in `.env` is written
`export OPENAI_API_KEY=…`, so a plain `grep '^OPENAI_API_KEY='` finds nothing — evaluate just that
one line instead (and `npm install` first when `package.json` changed, see above):

```bash
cd /opt/amo-dashboard && git pull && npm run build
eval "$(grep -E '^\s*(export\s+)?OPENAI_API_KEY=' .env)" && export OPENAI_API_KEY
pm2 restart amo-dashboard --update-env && pm2 save
pm2 logs amo-dashboard --lines 20 --nostream   # no "OPENAI_API_KEY not set" warning
```

Then `GET /api/chat/config` from a logged-in browser should show `configured: true` and the model.
`OPENAI_CHAT_MODEL` / `OPENAI_CHAT_REASONING_EFFORT` are optional and only need exporting if set.

Do **not** `source .env` wholesale before `--update-env`: `.env` and `ecosystem.config.cjs` are both
known to hold an `AMO_PASSWORD` that differs from the one PM2 is actually running with (§7.6), and a
wholesale push would silently change the dashboard password. Export the two variables and nothing
else. After this the figures on FDIC Data Analytics change only when Market Intelligence's own daily
cache job refreshes (keyed by FDIC quarter), and then within up to seven days here unless the response
cache is cleared (§5.6, §6.8).

### 6.4a Droplet operations as MCP tools

`tools/droplet-mcp/` is a small MCP server that exposes the droplet to an AI assistant as a fixed set
of named tools, instead of the assistant composing `ssh` commands itself. Added 22 Sep 2026. It runs
on the developer's machine and connects out over the existing SSH key; nothing is installed on the
droplet.

| Tool | Does | Writes |
|---|---|---|
| `pipeline_status` | pm2, disk, memory, crontab, and last-modified time of every collector log | no |
| `git_state` | HEAD vs `origin/main`, uncommitted files, and **`dist/index.cjs` build time against commit time** | no |
| `tail_log` | Tail a known log, optional filter | no |
| `db_query` | Read-only SQL against the production database | no |
| `restart_app` | `pm2 restart` only | yes |
| `deploy` | pull → build → restart → HTTP check. Requires `confirm:true` | yes |
| `run_collector` | Trigger one collector off-schedule, detached. Requires `confirm:true` | yes |

**Why it exists.** Two of this page's standing hazards are procedural, and both are the kind a human
or an assistant forgets under time pressure: §6.4's "build before restart", and the deploy-verification
risk in §7.5 — *production keeps running old code while the checks look fine*. `deploy` performs all
three steps as one operation so the build cannot be skipped, and `git_state` answers the question that
actually matters — **is the running bundle older than the commit?** — rather than the question `git
log` answers, which is only what was fetched. It caught exactly that state on the day it was built:
`d0d3f97` pulled on the droplet, `dist/index.cjs` still from 19 Sep.

**Guardrails.** There is no arbitrary-command tool; every remote command is built from fixed strings
plus validated enum/integer arguments. `db_query` opens SQLite with `-readonly`, so writes fail in the
engine, not in a check that could be bypassed. `deploy` and `run_collector` refuse without
`confirm:true`. None of this replaces §7.5's rule that the owner decides when to deploy — the tools
make the steps atomic and the state visible, they do not grant authority to ship.

**Setup gotcha.** MCP clients launch servers with a stripped environment, so `SSH_AUTH_SOCK` is absent
and every call fails with `Permission denied (publickey)`. The key on disk is passphrase-protected, so
`ssh -i` is not a workaround. The server recovers the agent socket at startup via `launchctl getenv
SSH_AUTH_SOCK` on macOS; on Linux, export it in the MCP client's own environment.

```bash
cd tools/droplet-mcp && npm install
claude mcp add amo-droplet --scope user -- node "$PWD/server.mjs"
node tools/droplet-mcp/smoke-test.mjs   # read-only tools + refusal checks
```

### 6.5 Scheduled jobs

All installed via `crontab -e` on the droplet.

| Schedule (UTC) | Script | What it does |
|---|---|---|
| `*/20 * * * *` | `run_facility_tick.sh` | One tick of the OpenAI Batch state machine: poll in-flight jobs, ingest finished ones, top back up to 4 concurrent batches of 500 documents. Resume-safe. |
| `30 8 * * *` | `run_nightly_normalize.sh` | Rebuild derived tables, then `pm2 restart` to clear the cache. **Skips the restart if normalize fails**, so a failure leaves the last good data serving. |
| `30 15,19,23 * * *` | `run_broward_daily.sh` (`BROWARD_INGEST_INDEX=1`) | Broward index → images → extraction → retention report + heartbeat. **Time-critical.** Runs three times a day on purpose — see "Broward's publication time moves" below. Holds a `flock` so runs cannot overlap; a skipped run exits 0. |
| `0 6 * * 5` | `run_weekly.sh` | Miami-Dade: collect last 10 days → extract PDFs → normalize → enrich. Sources `/opt/amo-dashboard/.env` itself and **aborts loudly up front if `OPENAI_API_KEY` is missing** (fix `2441222`, 23 Aug 2026 — cron provides no environment; before the fix the run half-succeeded: collection worked, extraction silently died, see §7.4). **No longer sends the email** — that moved out on 2 Oct 2026. |
| `0 11,12 * * 1` | `send_weekly_email.sh` | The "AMO Market Monitor" email (§4.1a). **Two firings, one send:** the box is Etc/UTC with no DST, so no single UTC hour is 07:00 Eastern all year — 11:00 UTC is 07:00 EDT, 12:00 UTC is 07:00 EST. The script checks the Eastern hour and lets exactly one through. `CRON_TZ` would be tidier but this cron build's support for it is unverified, and a scheduling feature that silently fails would shift the send an hour unnoticed. Waits for any running `normalize.py`, and sends nothing unless `REPORT_EMAIL_ENABLED=1`. |
| `15 3 * * *` | `run_backup.sh` | Verified snapshot of the database + Broward images → local rotation (7 kept) → DigitalOcean Spaces. Records every run in `backup_runs`; the Overview banner reads it. **Waits out a running `normalize.py` before snapshotting** (7 Oct 2026) — the derived tables are empty for ~90 minutes of a rebuild, and a snapshot taken then restores a dashboard of zeros. |

**One-off, 18–21 Sep 2026 (remove after):** `5 6 18 9 *` `collector/weekend/run_weekend.sh` (re-read →
waits for fixes → `apply_weekend_fixes.sh` → email check) and `0 13 21 9 *`
`collector/weekend/monday_email.sh` (Monday 09:00 ET send, only if both checks passed). Progress at
`/weekend` or `cat /opt/amo-dashboard/collector/weekend/STATUS`.

**Installed but gated:** the weekly emailed report is wired into cron as of 2 Oct 2026 (the
`0 11,12 * * 1` row above), but `REPORT_EMAIL_ENABLED` is unset in `.env`, so each Monday firing logs
`SKIPPED` and sends nothing. One variable stands between the schedule and a live send — see §4.1a.

#### Two things about these jobs that must not be forgotten

**1. Broward images are on an unforgiving clock.**
The SFTP feed retains only ~10 days of daily image zips. The yearly exports are **index only**. A day
whose images age out is **permanently unrecoverable** from the free channel — recovering it
afterwards means scraping the AcclaimWeb portal one document at a time, behind a disclaimer gate,
session state and Cloudflare bot management. Treat any `PENDING` day in the retention report as an
active incident. The ~10-day window means several consecutive failures are still recoverable; a
fortnight of silence is not.

**1a. Broward's publication time moves, and a single cron entry chasing it falls behind silently.**
The job originally ran once daily at 12:30 UTC against an observed landing window of 10:27–11:01 UTC.
By 24 Aug 2026 the feed's own file mtimes showed every one of the ten days then on the feed landing
between **14:27 and 15:28 UTC**, with outliers at 20:29 and 20:52. So the 12:30 run had been arriving
about two hours *before* each day's drop for at least two weeks, picking it up on the following day's
run instead — working, but spending a day of the safety margin for nothing. Hence three runs a day
(15:30 / 19:30 / 23:30 UTC) rather than a re-tuned single time. A run that finds nothing new is
almost free: the index inserts 0 rows, the harvester skips complete days, extraction reports 0
pending and spends $0.

Also remember: **Broward publishes on business days only and runs ~3 business days behind.** A
Monday with no new images is normal, not a fault — the weekend produced nothing to publish. This is
why liveness is measured per-run in `broward_runs`, not from when data last arrived (see §7.4).

**2. Never restart PM2 while `normalize.py` is running.**
`aom_events_clean` is dropped at the start of the run and reads **zero rows** until a single commit at
the very end. Restarting inside that window clears the 7-day cache and immediately re-caches the
*empty* state — leaving Clean Transactions, Reporting and Lending Relationships showing zeros for up
to a week. This is exactly why `run_nightly_normalize.sh` restarts only *after* a successful run.
A long silent stretch during `Building aom_events_clean...` is normal, not a hang.

**3. The backup runs at 03:15 for a reason.** It is the only window that collides with nothing: the
nightly normalize occupies 08:30–~09:50, the Broward pull is 12:30, the weekly Miami-Dade collect is
Friday 06:00. It does overlap the 20-minute facility tick, which is harmless — `sqlite3 .backup` uses
SQLite's online backup API, so it snapshots consistently while other processes write.

**Budget ~80 minutes for a full `normalize.py` run on the droplet** at current scale (~113k rows).
Older notes claiming "~15 minutes" are stale. The same run takes ~20 minutes locally — the droplet is
roughly 2.3× slower on this single-threaded Python loop.

### 6.6 Guardrails and tests

Run against a **snapshot**, never against live production:

```bash
AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 collector/tests/check_county_isolation.py
```

| Check | Asserts |
|---|---|
| `check_county_isolation.py` | No NULL counties; no CFN under two counties; key formats stay disjoint; derived tables agree with `assignments` about county; **rebuilt tables still declare `county`** |
| `check_canonicalize_baseline.py` | Name canonicalization output has not drifted (baseline in `canonicalize_baseline.tsv`) |
| `check_internal_commas.py` | An internal comma is punctuation, not content — `CITY NATIONAL BANK, OF FLORIDA` and `CITY NATIONAL BANK OF FLORIDA` are one entity, and `HERNANDEZ,ROLANDO` reaches the spaced spelling. Also asserts the **converse**: street-numbered property LLCs and two banks sharing a leading word stay apart. Offline. Exists because this split the bank's own lender ranking in the Credit Facilities tab and nothing was watching (23 Sep 2026) |
| `check_company_suffix.py` | Bare `COMPANY`, bare `LIMITED` and a spaced `L P` are legal suffixes, not brand content. Also asserts the **converse**, including the case that must NOT merge: `CITY NATIONAL BANK` and `CITY NATIONAL BANK OF FLORIDA` are two different real banks, because a geographic qualifier is not a legal suffix. Checks the `NWL` entity-type coupling in both directions. Offline. Exists because `\bCO\.?\b` cannot reach `COMPANY` across a word boundary, so every firm the county recorded both ways stayed split — Bank of New York Mellon Trust broke 179/178 (7 Oct 2026) |
| `check_entity_names_parity.py` | The shared address book reproduces the legacy normalize functions exactly |
| `check_backup_degraded.py` | A snapshot whose derived tables are empty is kept and uploaded, but never counts as good and never rotates a complete archive away. Runs the **real `run_backup.sh`** against a temporary database rather than restating its rules — the bug lived in the gap between what the script asserted and what it did with the result, so a test that re-stated the intended rule would have passed against the broken version. Against the pre-fix script it reproduces the 16 Sep incident exactly |
| `check_alias_scope.py` | Alias scoping rules behave — note aliases are applied **after** suffix stripping |
| `check_broward_heartbeat.py` | The Broward daily job's heartbeat separates "ran and found nothing new" (normal every weekend) from "stopped running". Stubs the SFTP layer — no network needed |
| `check_facility_type.py` | The rules deciding whether a credit facility is a warehouse line, a syndicated deal or a business line of credit. **Offline — no API key, no network, instant**, unlike the integration gate. Includes a negative control. Exists because the model used to put 623 of 625 documents in one bucket and no test was watching that field |
| `check_doc_category.py` | The rule that overturns an unsupported COLLATERAL verdict on an Assignment of Mortgage. Offline, no API key. Asserts both that it corrects the 9,604-document error AND that it never touches UCC filings or the generic-assignment rent problem, and that it can never *invent* a collateral verdict |
| `check_doc_type_scope.py` | Non-assignment doc types (`FST`) never reach `aom_events_clean` or the entity signal sweep, while `AMO`/`ASG`/legacy `NULL` rows still do. Runs on an in-memory fixture **plus a negative control** — production had zero FST rows when it was written, so a live-only check would have passed while asserting nothing |
| `check_leading_numbers.py` | A leading number is part of a company name, not junk to strip. Offline. Exists because stripping every leading non-letter turned `7190 HOLDINGS LLC` into `HOLDINGS` and collapsed **47 unrelated firms into one fictional "INVESTMENTS" entity** — 1,752 filings across 1,113 companies (14 Sep 2026). Only a leading *zero* is removed, and the test pins why magnitude was rejected as the discriminator |
| `check_party_preference.py` | Which parties get reported, and what counts as a property address. The county index lists *every* party on a filing, so the Reporting table was showing the original borrower or MERS instead of the two institutions trading the loan — 12,068 of 55,839 rows (22%). Offline (16 Sep 2026) |
| `check_extraction_completeness.py` | `status='OK'` in `pdf_extractions` actually means extracted. Exists because its absence cost **50,042 Miami-Dade documents three weeks of silent non-extraction** (22 Jul–15 Aug 2026): two jobs write that table and disagreed about what a row means, so pending work is now keyed on `raw_json IS NULL` rather than on row existence |
| `check_feed_lag.py` | The Broward publishing-lag warning counts **business** days, not calendar days — a healthy Friday feed read on Monday must not cry wolf. 13 assertions including the Monday case and the 23 Sep 2026 incident (2 Oct 2026) |
| `diff_name_systems.py`, `show_merge_proposals.py` | Diagnostics for reviewing name-matching decisions |

All fifteen are run by hand — **`npm run check` covers only the TypeScript gates below**, so a new
Python guardrail is easy to add and then forget. Four of these were missing from this table until
7 Oct 2026 for that reason. A single entry point would be worth building (§7.6 item 10).

`check_county_isolation.py` exists because the same bug has now been caught **three separate times**:
a writer that forgot to carry the `county` column. It is asserted rather than trusted for that reason.

**TypeScript-side gates** — these need no database and run in about a second:

```bash
npm run check              # tsc + the metric-direction guardrail
npm run check:metrics      # just the metric-direction guardrail
```

| Check | Asserts |
|---|---|
| `script/check-metric-directions.ts` | Every risk metric points the way it claims to: each peer threshold table's colours agree with its declared `direction`, a bank that is worst on all four metrics colours red on all four, and the CRE/capital scale gets redder as concentration rises. Includes a **negative control** — it feeds itself a deliberately inverted table and fails if it does not catch it |

**Retired with the Market Intelligence switch (7 Oct 2026): `script/check-fdic-window.ts`.**
It asserted that the FDIC query window was wide enough for the metrics computed from it, after a
real bug (24 Aug 2026) in which an 18-month window could never yield the eight quarters that
year-over-year net income needs, so **NI YoY %** was blank for every institution from the day it
shipped — nothing threw, and a column of em-dashes reads like an upstream gap. The lesson in the
risk register (§7.5) stands; the window itself no longer exists in this codebase, because the page
no longer builds FDIC queries. Any such precondition now lives in Market Intelligence, which is where
the equivalent check belongs. `peer-metrics.ts` stays, so the direction guardrail still applies — the
drawer still ranks the loaded cohort client-side, over API rows.

The metric-direction guardrail exists because of a related bug found in the sibling FDIC tool (24 Aug 2026):
**CET1 and CRE-to-capital point in opposite directions but look identical at a call site.** Higher
CET1 is safer; higher CRE-to-capital is riskier. Colour logic copy-pasted from one onto the other
inverts silently — the safest banks render as the most stressed and a "most exposed" ranking returns
the least exposed. Nothing throws and every number on screen is individually correct; only the
colours and the ordering lie. AMO was audited and found **clean**, and the direction rules are now
asserted rather than re-derived at each display site.

### 6.7 Working on the code — things to know first

**Read `SESSION_LOG.md` before changing anything.** It is a dense, dated, most-recent-first record of
what was tried, what broke and why decisions were made. It exists specifically so context does not
have to be re-derived. Append a concise dated entry after any substantive change. `ROLLBACK.md` holds
the revert path for whatever is currently in flight.

**`server/routes.ts` is ~2,200 lines and holds ~50 endpoints.** All hot statements are prepared once
at startup inside `registerRoutes`. If you add a query over a document table, it must be
county-scoped — use `countyPredicate()` for named parameters or `countyFilter()` for positional ones.
better-sqlite3 refuses to mix named and positional parameters in one statement, which is why both
helpers exist.

**The `@shared/*` path alias works in the client but NOT in the server bundle.** It is declared in
`tsconfig.json` and `vite.config.ts`, so an aliased import inside `server/` typechecks cleanly and
then fails `npm run build` — `script/build.ts` bundles the server with esbuild, which is given no
alias configuration. Server code must import shared modules **relatively** (`../shared/…`). Worth confirming any new
shared import actually landed in the bundle rather than trusting `tsc`.

**`/api/mi/*` is a pass-through, not a place to compute.** `server/market-intelligence.ts` forwards
five Market Intelligence endpoints 1:1, caches only `ok:true` bodies, and returns upstream status and
error text unchanged. Do not add scoring, screening or signal logic on either side of it — the whole
point of the switch was one source of numbers. The contract this app relies on is the saved
`docs/market-intelligence-meta.json` (`contractVersion`, scopes, asset bands, signal definitions);
if the upstream `contractVersion` changes, re-save that file and diff it before touching the UI.
Signal labels and meanings are read from `meta.signals` at runtime, never hardcoded.

**`aom_events_clean` rows are unpacked positionally** in `normalize.py` (`entries[0][8]` and
similar). The `county` column is appended **last** in the source query on purpose. Inserting a column
anywhere earlier silently shifts every field. This is the highest-risk edit in the codebase.

**Schema migrations are idempotent and run at server startup** (`server/db.ts`) and are mirrored in
`collector/migrate_add_county.py`, so whichever side deploys first self-heals. The migration backfills
`county = 'MIAMI-DADE' WHERE county IS NULL` — correct for pre-migration rows, and dangerous if a new
writer forgets the column, because its rows get silently relabelled Miami-Dade with no error anywhere.
Queries additionally `COALESCE` onto `'MIAMI-DADE'` rather than trusting the backfill.

**`assignments.cfn` is globally UNIQUE, not `UNIQUE(county, cfn)`.** This is safe only because
Miami-Dade CFNs always contain `R` and Broward instruments are always digits. **Adding a third county
whose key format is not disjoint is the moment to do the real table rebuild** — not before.

**Document links are per-county.** Miami-Dade links by book/page; Broward e-recorded documents have
no book/page at all and link by instrument number. Use the builders in `client/src/lib/doc-url.ts` —
hand-rolling a link produces a wrong document silently.

**`entity_nodes` and `entity_relationships` genuinely cannot be county-scoped.** They are keyed by
entity. Making them county-aware would mean building them per county, which would defeat the
cross-county entity resolution the tool exists to provide. The correct fix for a scope complaint is a
clearer label, not a filter.

**The LLM provider is OpenAI (`gpt-4.1-nano`)**, not Claude/Anthropic. Any `.cursor` rule claiming
otherwise is stale.

**Deal Intelligence was retired on 11 Aug 2026.** The page and its eight
`/api/deal-intelligence/*` endpoints were removed together — it had been unrouted and unreachable
for months while still being maintained through every cross-cutting change. The implementation is
in git history (added `197e947`, unrouted `3b1674a`, removed `9a2932d`) if distressed-sourcing ever
comes back as a use case.

### 6.8 Runbooks

#### Re-run the rebuild by hand

```bash
cd /opt/amo-dashboard/collector && source /opt/amo-dashboard/.env && nohup .venv/bin/python3 -u normalize.py > /tmp/normalize.log 2>&1 & disown
```

Wait for completion (~80 min), confirm success in the log, **then**:

```bash
pm2 restart amo-dashboard
```

Or, without a restart, `POST /api/cache/bust` from a logged-in session.

#### Check whether normalize is still running

```bash
ps -eo pid,cmd | grep "[n]ormalize.py" | grep -v "bash -c"
```

Two traps here, both of which have caused a wrong "it's finished" call:
- `pgrep -f "normalize.py"` **matches the watcher's own command line**. Do not trust its result.
- `ps -eo cmd` is **not valid on macOS** — it errors, and a `|| echo "not running"` fallback then
  reports a very-much-alive process as dead. On macOS use `ps aux | grep`.

#### Add a new county

1. Write the collector; add rows to `assignments` with the new `county` value.
2. Run `migrate_add_county.py` **before** the collector (it fails fast with instructions if the
   column is missing).
3. **Verify key disjointness** against existing CFNs. If keys can collide, rebuild the UNIQUE
   constraint as `UNIQUE(county, cfn)` first.
4. Build the extraction path, harvest images, extract documents.
5. **Rehearse on a production snapshot** with `NORMALIZE_COUNTIES` widened, and diff
   `entity_classifications` + `entity_nodes` before/after. New names enter the classification signal
   sweep and can move existing entities' types.
6. Only then flip `NORMALIZE_COUNTIES` in production, with a backup taken first.
7. Add the county to `COUNTY_OPTIONS` and the document-link builder.

This is the exact sequence Broward followed; each step exists because skipping it caused a specific
problem.

#### Re-label credit facilities after a classification change

`facility_type` — whether a credit facility is a warehouse line, a syndicated deal or a business
line of credit — is decided in code from the agreement name the extractor reads off the document
(`classify_facility_type` in `collector/extract_pdfs.py`). If those rules change, existing rows keep
their old labels until they are recomputed.

**This costs nothing and takes under a second.** Every row with a facility verdict already stores the
agreement name and the evidence quote, and the rules are a pure function of those two fields, so
nothing is downloaded, OCR'd or sent to the model:

```bash
# report what would change, write nothing
AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db \
  collector/.venv/bin/python3 collector/reclassify_facility_types.py

# apply
AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db \
  collector/.venv/bin/python3 collector/reclassify_facility_types.py --apply
```

Then rebuild the derived table and clear the cache, or the Lending Relationships tab keeps showing
the old grouping for up to seven days:

```bash
nohup collector/.venv/bin/python3 -u collector/normalize.py > /tmp/norm.log 2>&1 &
disown          # ~60-85 minutes
pm2 restart amo-dashboard
```

**What this cannot do:** recover false negatives. A document the extractor already read as *not* a
facility stores no agreement name, so nothing here can reconsider it — that needs re-extracting
every document, which is a day and roughly $25.

#### Apply approved entity merges

```bash
AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 collector/apply_proposals.py
```

Dry-run by default. Add `--write --merges auto,high,medium --families high` to commit.
`CONFLICT`-tier proposals are **never** applied — that tier is the engine reporting the two names are
probably *different* entities. Every decision is a row in `entity_aliases`, so any approval is
reversible by deleting its row and re-running `normalize.py`.

#### Rollback

`ROLLBACK.md` is the authority. Two backups currently retained on the droplet:

| File | Taken at |
|---|---|
| `backup_pre_broward_normalize.db` (131 MB) | Before the Broward `NORMALIZE_COUNTIES` flip — `51,425 clean / 20,320 nodes / 445 facility` |
| `backup_pre_entity_norm.db` (91 MB) | Before the entity-normalization refactor |

To back out Broward from the analytics without deleting any data: set
`NORMALIZE_COUNTIES="MIAMI-DADE"`, re-run `normalize.py`, restart PM2. The rebuild drops Broward rows
from the derived tables on its own — no manual `DELETE`.

#### Restore from a nightly backup

The nightly job (§6.5) writes verified, gzipped snapshots to `/opt/amo-dashboard/backups/` and, once
credentials are configured, to DigitalOcean Spaces. **A backup nobody has restored is a hypothesis,
not a backup** — so this procedure is written to be followed literally, and the restore is verified
before anything live is touched.

```bash
# 1. Get an archive. Locally:
ls -lt /opt/amo-dashboard/backups/          # or: rclone ls "$BACKUP_REMOTE/db/"
# From Spaces:
rclone copy "$BACKUP_REMOTE/db/amo-YYYYMMDD-HHMMSS.db.gz" /tmp/

# 2. Decompress to a SCRATCH path — never straight over the live database.
gunzip -c /tmp/amo-YYYYMMDD-HHMMSS.db.gz > /tmp/restore_check.db

# 3. Verify BEFORE trusting it.
sqlite3 /tmp/restore_check.db "PRAGMA integrity_check;"          # must print: ok
sqlite3 /tmp/restore_check.db "SELECT county, COUNT(*) FROM assignments GROUP BY county;"
sqlite3 /tmp/restore_check.db "SELECT COUNT(*) FROM aom_events_clean;"
```

Only if those numbers look right, swap it in:

```bash
pm2 stop amo-dashboard                                     # stop writers first
sqlite3 /opt/amo-dashboard/miami_dade_amo.db ".backup /opt/amo-dashboard/pre_restore.db"
mv /tmp/restore_check.db /opt/amo-dashboard/miami_dade_amo.db
rm -f /opt/amo-dashboard/miami_dade_amo.db-wal /opt/amo-dashboard/miami_dade_amo.db-shm
pm2 start amo-dashboard
```

- **Delete the `-wal`/`-shm` sidecars.** They belong to the *replaced* database. Leaving them beside a
  different file is how a good restore turns into a corrupt one.
- **Take `pre_restore.db` even when the live database looks broken.** A restore that turns out to be
  the wrong archive is recoverable; one that overwrote the only copy of the current state is not.
- Broward images restore separately — they are files, not database rows:
  `rclone copy "$BACKUP_REMOTE/broward_images/" /opt/amo-dashboard/collector/broward_images/`

#### Before any production data change

1. `sqlite3 miami_dade_amo.db ".backup /opt/amo-dashboard/backup_<what>.db"`, then integrity-check it.
2. Capture a baseline of the numbers you expect to be unchanged.
3. Rehearse the change on a snapshot.
4. Apply, re-check the baseline, clear the cache.

> **Cache poisoning warning:** a pre-flight API check taken *before* a data change caches the
> pre-change payload — for 7 days. Verify **after** the change, or bust the cache in between.

### 6.9 Cost

LLM spend is small and capped. Extraction runs at roughly **$0.00024/document** on `gpt-4.1-nano`;
the Batch API halves that again. The full ~44k-document historical facility backfill was estimated at
**$5–11 total**. `extract_pdfs.py` accepts a hard `--budget` cap per run, and `run_asg_backfill.sh`
uses `--budget 5.0`.

**Ask the Data is the one place a strong, expensive model is used** — `gpt-6-astra` at $10/M input and
$50/M output. A question costs roughly 10–20k prompt tokens (an ~8k-token system prompt plus the tool
results, re-sent on every tool round) and 0.5–2k output tokens, so **about $0.15–0.30 per question**, more
for multi-step analyses. Each answer's footer shows its model, rounds and total tokens, and every
request is logged as `[chat] gpt-6-astra rounds=N tokens=…` in the PM2 log, so spend is auditable.
If usage grows, `OPENAI_CHAT_MODEL=gpt-6-sol` is a fifth of the price; there is no per-request budget
cap yet (§7.4).

The only other recurring cost is the droplet.

### 6.10 Keeping this page current

This page is maintained **as part of closing every working session**, not on an ad-hoc basis. The
routine is two files:

1. Append a dated entry to `SESSION_LOG.md`.
2. Update this page — whichever sections the work affected, **always** re-checking §7 *Current
   status* (production numbers, component table, known gaps, risk register), and bumping the
   *Last reviewed* date in the header.
3. Commit and push both.

The convention is written into `CLAUDE.md` and `.cursor/rules/amo-session-handoff.mdc`, so any
assistant working on the repo picks it up. Claude Code additionally enforces it with a hook:

| File | Role |
|---|---|
| `.claude/hooks/session-doc-reminder.sh` | `SessionStart` records the starting HEAD; `Stop` blocks the end of a session that changed repo files without touching this page |
| `.claude/settings.json` | Wires both events to that script |

The hook fires **at most once per session** (marker file under `$TMPDIR/amo-doc-reminder/`), stays
silent when nothing substantive changed, and ignores SQLite artifacts and the session log. It is a
backstop, not the mechanism — the page is a deliverable in its own right.

Test it by hand:

```bash
echo '{"session_id":"test"}' | amo-dashboard/.claude/hooks/session-doc-reminder.sh Stop
```

To disable it, remove the `hooks` block from `.claude/settings.json`.

### 6.11 Git workflow

Single `main` branch, pushed to `origin/main`. Every agreed change is committed and pushed once
confirmed. Commit messages are written as statements of what changed and why
(`"Keep county on the tables normalize.py rebuilds"`), not as ticket references.

---

## 7. Current status — as of 7 Oct 2026

### 7.1 Overall

🟢 **Live, healthy, and delivering.** Checked end to end on 7 Oct 2026: both counties flowing,
151,824 filings indexed (Miami-Dade through 1 Oct, Broward through 30 Sep), Broward's feed lag back
to a normal 4 business days with every available day harvested, eight consecutive successful
off-box backups, and the weekly email delivered to real recipients for the first time on Mon 5 Oct.

**Deployed 7 Oct 2026 16:56 UTC: FDIC Data Analytics re-sourced to Market Intelligence.** The page
keeps its layout and gains real Opportunity/Earnings/Vulnerability scores, balance-sheet signals, and
trend/acquisition/roll-forward sections in the drawer; the app no longer computes FDIC analytics
itself. Verified live on the droplet after the restart (login, `/api/mi/meta` for quarter 20260630,
Florida screening 85 rows). One verification target missed: the national screening response is
1.47 MB uncompressed (§7.4 item −9). A follow-up the same afternoon (`4e0f5f4`, live 17:33 UTC)
added trend charts to the bank drawer — four small multiples over the eight quarters plus a CRE
problem-asset balance chart. Production closed the day at `a20c840`, in step with `origin/main`.

**Four items were closed or corrected on 7 Oct 2026, and two of them turned out to be stale
documentation rather than open work:**
- **Name variants (code).** `canonicalize()` was treating bare `COMPANY` and `LIMITED` as brand
  content, permanently splitting every firm the county recorded both ways — Bank of New York Mellon
  Trust broke 179/178. 119 canonical names merged (§7.4 item −7a).
- **Backups (code).** A snapshot taken during a rebuild could retire a good archive in its favour.
  Closed, and the fix deliberately does **not** suppress the backup itself (§7.5).
- **Facility type over-labelling (docs).** Fixed in code on 12 Sep and the recompute has since been
  applied in production; the page still described it as pending (§7.4 item 7).
- **Off-box backups and the Azure app (docs).** Both had been done for weeks while §7.6 still
  listed them as needing the owner. The page had been contradicting itself.

**Also cleaned up on the droplet:** four expired one-off cron entries whose own comments said
"REMOVE AFTER" — date-pinned to September with no year, so they would have re-fired in Sept 2027 —
and a cron comment still claiming the weekly email was gated off. `dist/index.cjs` had also been
18 days behind `HEAD`; harmless at the time because every commit since the last build touched only
the email path, but it is the exact shape of the "deploy silently fails" risk, so it was rebuilt.

#### Earlier context (18–21 Sep 2026)

**18–21 Sep 2026: the QC audit's fixes are being applied over the weekend.** A read-only audit of the
whole tool (17 Sep) and the owner's review of it produced six confirmed fixes
(`docs/qc/QC_FIX_LIST_2026-09-17.md`): (1) Miami-Dade rows shown in reverse direction, (2) homeowners
still shown as the seller on ~7,700 rows, (3) MERS counted as a bank, (4) companies split across
several spellings, (5) lenders typed "Other", (6) a handful of documents never read. All six are
permanent code; they go live in **one rebuild on Saturday evening** after every Miami-Dade loan
document is re-read and its text stored. **Follow it at `/weekend`** (same login). Dry-run effect on
production data: 7,520 rows re-oriented, homeowner sellers 7,697 → 64, MERS out of the seller
rankings. The Monday 21 Sep email sends automatically only if the rebuild and an end-to-end email
check both pass.

🟢 **Live and healthy.** Both counties flow end to end: index → images → extraction → normalization →
dashboard, county-scoped throughout. The Broward expansion, the major workstream since 6 Aug 2026,
completed on 10 Aug 2026.

**The week of 8–11 Sep 2026 answered the "are we pulling everything?" question and acted on it.**
The clerk offers 79 document types; exactly three are assignments and we collect all three, so no
assignment category was ever missing. Along the way:
- A **three-month silent collection failure** was found and fixed. Assignment of Interest filings had
  returned nothing since 16 June while logging what looked like network timeouts.
- **UCC financing statements** were added as a new source — 32,759 filings, 2023 to present, 84%
  carrying a property address — and given their own page.
- The **Reporting tab now filters by document type and by what a document actually is**, and every
  number on that page counts the same rows, which had not previously been true.

**On 15 Sep 2026 the document classifier was corrected twice**, in both directions. 9,604 ordinary
loan sales had been filed as "collateral" and were missing from Reporting entirely; they are back.
Then 6,040 rent assignments that had been filed the same way were moved to the Rents & leases view,
which is what they are. The net effect is that **each of the Reporting tab's views now contains what
its name says** — see the two boxed notes in §7.2 before comparing against any earlier report.

### 7.2 Production data

| Scope | Filings indexed | Loan transfers | Other assignments | Entities |
|---|---|---|---|---|
| Miami-Dade | 106,158 | 54,974 | — | — |
| **Broward** | **44,178** | **1,510** | — | — |
| **All** | **150,336** | **56,484** | **18,939** | **10,431** |

Market transfers: **30,218**. Documents read end to end: **108,316**.

*Counts re-queried against production 22 Sep 2026. Definitions, so the next reviewer can reproduce
them: filings = `assignments` (by `county`); loan transfers = `aom_events_clean`; other assignments =
`aom_events_nonloan`; market transfers = `aom_events_clean WHERE txn_type='MARKET_TRANSFER'`;
documents read = `pdf_extractions WHERE status='OK'`; entities = the Overview's own
`statsUniqueEntities` query — distinct `assignor_canon` ∪ `assignee_canon` over `aom_events_clean`.*

> **The entity count fell from 21,517 to 10,431 because it was being counted wrong before. Settled
> 22 Sep 2026** against the backup series; full reasoning in §7.4 item −6. In short: thousands of
> **homeowners** were being recorded as the assigning party where the document itself named a
> lender or MERS, and OCR spelling variants of the same institution were each counted as a separate
> entity. Two deliberate fixes (16 Sep "party fix", 19 Sep weekend QC fixes) corrected both. No rows
> were lost — `aom_events_clean` grew over the same window — and no canonical name was blanked.
> **10,431 is the trustworthy figure; 21,517 should not be cited again.**
>
> **Expect ~10,398 after the next deploy.** The comma fix in §7.4 item −7 merges 33 entities that
> were duplicated by punctuation alone. Same cause as the OCR-variant merging described above, so
> the figure is moving for the same reason and in the same direction — it is not a new discrepancy.
> The drop lands on the first nightly `normalize.py` run after the code ships, not before.

**Loan transfers rose from 46,081 to 55,704 on 15 Sep 2026 — see the note below. This is a
correction, not new data.**

**"Other assignments" is new as of 11 Sep 2026** — collateral assignments and assignments of rents
and leases, which were collected and read but previously had nowhere to appear. They live in their
own table and are reachable from the Reporting tab's *Shows* filter. They are **not** counted in
loan transfers, so no figure above double-counts and nothing published earlier has changed meaning.

> ### The **Collateral** filter was mostly not collateral — corrected 15 Sep 2026
>
> **If you used the Reporting tab's *Collateral* view before 15 Sep 2026, re-run it.** It was
> showing roughly five times more rows than it should have, and most of them were the wrong kind of
> document.
>
> **What that filter is for.** A *collateral assignment* is a lender pledging loans it already owns
> to **its own** lender — a mortgage company posting its loan book against a warehouse line, for
> example. That is a competitive signal: it shows who is financing whom, and at what scale.
>
> **What was actually in it.** 6,040 filings that are something quite different and far more
> ordinary: a landlord assigning the rent from its tenants to the bank that just financed the
> building. Nobody is buying or pledging a loan; it is routine paperwork filed alongside almost
> every commercial mortgage. They outnumbered the real collateral pledges about four to one, so the
> signal the filter exists to show was buried in them.
>
> **Why they were mislabelled.** Many are titled *"Collateral Assignment of Leases and Rents"*. The
> word "collateral" there describes *how* the assignment works, not *what* is being assigned — and
> what is being assigned is rent, not a loan. The classifier had been reading the word and not the
> distinction.
>
> **What changed.** Those 6,040 filings moved to the **Rents & leases** view, where they belong and
> where they were always visible under that filter's proper heading. Nothing was deleted and nothing
> left the tool. One group was deliberately **kept** in Collateral: 437 filings where a condominium
> association pledges its assessment income to a bank to secure its own borrowing — that genuinely
> is an owner pledging an asset for a loan.
>
> **What this does not affect.** **Loan transfers are unchanged by this correction**, because these
> documents were never counted as loan sales. The **UCC Filings** page is unchanged — all 20,522 of
> its collateral records are correctly labelled, and are excluded from this correction by design.
>
> | Reporting → *Shows* | Before | After |
> |---|---|---|
> | Collateral | ~9,761 | ~3,721 |
> | Rents & leases | ~6,111 | ~12,151 |
> | UCC Filings page | 20,522 | 20,522 (unchanged) |
>
> This is the second half of the same problem as the loan-transfer correction described below: the
> Collateral bucket had become a catch-all. Both halves are now settled by rules in code, with the
> reasoning recorded in `collector/tests/check_doc_category.py`, rather than left to the document
> reader's judgement.

> ### Dollar volume counted big loans several times — corrected 17 Sep 2026
>
> **"$ Volume" figures fell on 17 Sep 2026, and the lower numbers are the right ones.** The figure is
> now labelled **"$ Volume (est.)"**.
>
> **What was wrong.** A large loan is recorded once per step, and every record repeats the full
> amount. A portfolio loan is filed against each building it covers; a loan that is packaged and sold
> on is filed again at each hand-off. The tool added every record together, so one $2.95B loan filed
> 10 times counted as $29.5B.
>
> **What changed.** For loans of $1 million and up, the same exact amount on the same firm within a
> month now counts once. Smaller loans are not merged, because identical round amounts between the
> same lender and buyer are common and usually genuinely separate loans.
>
> | | Before | After |
> |---|---|---|
> | Whole market | $150.9B | $86.7B |
> | Wells Fargo | $16.7B | $9.7B |
> | Goldman Sachs | $15.0B | $10.7B |
> | Bank of America | $4.9B | $4.9B (no repeated loans — unchanged, as expected) |
>
> **Why "est."** Some repeats name different properties, which is also exactly what a single portfolio
> loan looks like, so a small number of distinct same-sized loans may be merged. Treat the figure as a
> sound estimate of scale, not an exact sum. Transaction counts are unaffected.

> ### The Assignor column was showing the borrower — corrected 16 Sep 2026
>
> **Top-seller rankings changed on 16 Sep 2026. The new figures are the correct ones.** If you have a
> screenshot or export from before that date, re-run it.
>
> **What was wrong.** The Reporting table's *Assignor* and *Assignee* columns came from the county
> clerk's index. That index lists **every party named on a filing** — which, for a mortgage
> assignment, routinely includes the original homeowner alongside the two institutions actually
> trading the loan. The table had no way to tell which was which, so about **one row in five showed a
> homeowner's name where the document names a bank.**
>
> A real example from the top of the page: the table read **"SOSA JAIME → FREEDOM MORTGAGE"**. The
> document itself reads **"WELLS FARGO BANK, NA → FREEDOM MORTGAGE CORPORATION"**. Sosa Jaime is the
> homeowner — not a party to the sale at all.
>
> **What changed.** Where the index gives a person's name and the document names an institution, the
> table now reports the institution. **4,821 seller rows and 656 buyer rows** were corrected, and
> those transactions are now credited to the bank or servicer that actually sold the loan.
>
> **Practical effect: top-seller counts went UP** for the institutions that had been losing credit to
> homeowner names — Goldman Sachs, Fannie Mae, Nationstar, US Bank and others. Nothing was added or
> removed; existing transactions were re-attributed to the right party.
>
> **Deliberately narrow.** The rule only fires where the index name carries no company marker at all.
> Where both sides already name an institution it changes nothing, because the clerk's typing is
> cleaner than the scanned document's text and swapping would have introduced scanning errors into
> company names. Two earlier, broader versions were tested against the full database and rejected for
> exactly that reason.
>
> **This did not affect the charts, the Lending Relationships page, or the totals** — those were
> already reading the document's own parties. Only the table's display was wrong, and the correct
> names were always visible by expanding a row.

> ### The Property column: prose removed, legal descriptions kept — 16 Sep 2026
>
> **1,519 rows** in the *Property* column held sentences rather than addresses — *"AS DESCRIBED IN
> SAID MORTGAGE"*, *"not explicitly stated"*, *"not specified"* — plus bare county names and, in some
> cases, **the borrower's own name**. Those are now blank. A blank is honest, and the text versions
> were also breaking the property filter and the CSV export.
>
> **Legal descriptions were kept.** *"Lot 13, Block 2, of LYNWOOD, according to the Plat thereof…"*
> and condominium unit numbers are not street addresses but they identify a parcel precisely — often
> more precisely than an address. An earlier version of this cleanup discarded them and was corrected
> before release.
>
> **Still open:** the *Loan Amount* column is populated for **57%** of loan transfers (50% for 2026).
> Closing that gap requires re-reading the source documents and is scheduled separately — see §7.4.

Miami-Dade's filing count grew from 71,366 to 105,598 because **UCC financing statements
(32,759) were added on 9–10 Sep 2026**. Those are secured-lending records, not assignments, and are
deliberately excluded from every column but the first — see the UCC Filings page in §4.3.

> ### ⚠️ Read this before comparing against any earlier report
>
> **SUPERSEDED 15 Sep 2026 — the correction described below overshot, and the figures it produced
> were too LOW.** The August re-read moved 11,366 Assignment-of-Mortgage filings into "collateral",
> and 9,604 of those were ordinary loan sales that should never have moved. They say *"forever
> without recourse"* and *"grant, bargain, sell, assign, transfer and set over"*, and their
> counterparties are trustees, servicers, GSEs and HUD. The extractor had been answering on the
> words "security" and "securing", which appear in every mortgage assignment because a mortgage IS a
> security instrument. Loan transfers are now **55,704**. Anything quoted between 17 Aug and
> 15 Sep 2026 understated transfer activity by roughly a fifth.
>
> The original note follows, because the reasoning in it still holds for the documents that
> genuinely did not belong:
>
> **Clean transactions fell from ~51,800 to 44,585 on 17 Aug 2026, and the smaller number is the
> correct one.** This is not data loss — it is the removal of documents that never belonged.
>
> `normalize.py` counts a filing as a clean transaction when its document category is
> `LOAN_TRANSFER` **or is unknown**. Because 50,042 Miami-Dade documents had never been read
> (§7.4 item 0), their category was unknown, so they were all counted as mortgage transfers by
> default. Now that every one has been read, Miami-Dade divides as **LOAN_TRANSFER 44,025 ·
> COLLATERAL 18,480 · RENTS_LEASES 5,816 · OTHER 3,028** — and only the first is a mortgage trade.
>
> **Practical effect: every clean-transaction, entity and market-transfer figure this tool reported
> before 17 Aug 2026 was overstated**, because collateral assignments and assignments of leases and
> rents were being counted as mortgage sales. Any analysis, screenshot or exported CSV from before
> that date should be re-run rather than compared directly.

Verified after the flip: Miami-Dade's clean count is **identical** to the pre-flip baseline — Broward
added rows without disturbing existing data. County isolation guardrail green; all 37 checked
endpoints healthy across all three county scopes.

### 7.3 Component status

| Component | Status |
|---|---|
| Miami-Dade collection (weekly cron) | 🟢 Live — ran clean unattended on 11 Sep 2026, all four document types, whole collection phase 2m 13s |
| AIT (Assignment of Interest) collection | 🟢 **Resolved 11 Sep 2026** — never a timeout. The county rejects the search and returns no results, exactly as it does for a day with no filings, and has done so since the type was added on 16 Jun. Now resolves in about a second and records `EMPTY` rather than a false error. **Kept active on purpose**, so collection begins by itself if the county ever starts using it |
| UCC financing statements (weekly cron) | 🟢 **New 9–11 Sep 2026** — 32,759 filings collected and read, 2023 to present. Now part of the weekly run |
| Broward index + images + extraction (daily cron) | 🟡 Live — 43,795 index rows, but **41,970 have no image and cannot be read** until the bulk image order lands (§7.6) |
| PDF extraction — Miami-Dade | 🟢 Live — 107,402 documents read end to end |
| PDF extraction — Broward | 🟡 Live **daily**, coverage still thin — blocked on images, not on the extractor |
| Reporting tab filters (type + category) | 🟢 **Deployed 10–11 Sep 2026** — and every panel on the page now counts the same rows |
| Facility batch backfill (20-min tick) | 🟢 Live |
| Nightly normalize + cache bust | 🟢 Live — **but see §7.4: it discards the company types Friday's AI step assigns**, so counts swing Thu↔Fri. Skips itself if another rebuild is running (18 Sep 2026) |
| Direction of transfer (Miami-Dade) | 🟡 **Fix built 18 Sep 2026, applied in the 19 Sep rebuild** — `document_direction.py`; review list in `direction_decisions` (no screen yet) |
| Stored document text (`document_text`) | 🟡 **Filling 18–19 Sep 2026** — every Miami-Dade loan transfer re-read and kept (~1.7 KB/doc compressed); future audits need no re-download |
| Weekend progress page (`/weekend`) | 🟢 Deployed 18 Sep 2026 — read-only view of the weekend run |
| Broward county feed lag | 🟢 **Recovered — 4 business days as of 7 Oct 2026**, back inside the county's normal 3–6 range, with every one of the ten days on the feed harvested. The lag had roughly doubled around 23 Sep and held Broward at 25 Sep for over a week. **That was never a harvest failure:** every day was taken within hours of appearing, verified by listing the feed's own file timestamps (25 Sep data was published 1 Oct). The defect was that nothing said so — the daily job reported `status=ok` and "every day on the feed has been harvested", both true, while the figures aged. Now measured and warned above 5 business days (`collector/broward_images.py`), pinned by `collector/tests/check_feed_lag.py`, with a self-clearing notice in the weekly email. **Lesson: a single snapshot of a sliding window cannot distinguish "stopped" from "slow" — read the source's own timestamps.** Getting Broward nearer real-time would need portal scraping — not built |
| Weekly emailed report ("AMO Market Monitor") | 🟢 **LIVE and delivering. First real send Mon 5 Oct 2026, 07:00 EDT** — 407 transfers in 15 days, to `andres@` + `david@`. Every design decision held: 11:00 UTC landed on 07:00 EDT to the second, the two-firings/one-send hour guard admitted exactly one, and the 8-second runtime meant the `normalize.py` wait never engaged. Runs from source via `tsx` on its own cron entry (§6.5), so `dist/` is irrelevant to it. Template per the owner's 2 Oct request: no transaction-mix section, five large firms hidden from the email only (§4.1a). **Unproven in one direction:** the late-records notice has never fired in production — Broward has stayed at or under the 5-business-day threshold — so its only render was a pinned-date test |
| County-aware server + client selector | 🟢 Deployed |
| Per-county document links | 🟢 Deployed |
| Endpoint county scoping | 🟢 Deployed — all document endpoints |
| Coverage-gap detection + banner | 🟢 Deployed 11 Aug 2026 |
| Collection-health warning (Broward) | 🟢 Reworked **and deployed** 24 Aug 2026 — per-run heartbeat (`broward_runs`) replaced the last-new-data metric, which false-alarmed every Monday. Split into "job stopped" vs "images at risk". Cron now polls at 15:30/19:30/23:30 UTC |
| County audit — all pages/endpoints | 🟢 Complete 11 Aug 2026 |
| Repo hygiene — WAL files untracked | 🟢 Resolved 11 Aug 2026 — droplet `git status` clean |
| Entity normalization / duplicate manager | 🟢 Deployed 6 Aug 2026 |
| FDIC analytics | 🟢 **Re-sourced to Market Intelligence — deployed 7 Oct 2026 16:56 UTC** (`dfd42f8`); **trend charts added to the bank drawer 17:33 UTC** (`4e0f5f4`), owner-confirmed. The page reads the Market Intelligence tool's Market Analytics API via `/api/mi/*` instead of querying FDIC itself: real Opportunity/Earnings/Vulnerability percentile scores (previously hardcoded `0` and hidden), balance-sheet signal chips, and trend / acquisition / roll-forward sections in the drawer; `server/fdic.ts`, the FDIC window and its guardrail are removed. Verified locally: Florida top-3 by Opportunity matches the API in order (35430, 24156, 59278); CERT 35541 chips equal `behavior.latest.fired`; a wrong key shows "Market Intelligence unavailable" and no figures; National loads signals in seven sub-1 MB band calls. Verified live after restart: `/api/mi/meta` `ok:true`, quarter 20260630, same Florida top-3. **Miss:** national screening is one 1.47 MB uncompressed response (no band parameter upstream, no gzip here) — §7.4 item −9. Figures now move only when Market Intelligence's daily job refreshes (+ up to 7 days of local cache) |
| Deal Intelligence page | ⚫ **Retired 11 Aug 2026** — page and its 8 endpoints removed together |
| Automated backups | 🟢 **Live off-box 17 Aug 2026** — nightly verified snapshot → DigitalOcean Spaces (`amo-dashboard-backups-ec`, NYC3). Re-verified 7 Oct 2026: eight consecutive `status=ok` runs, ~148MB per archive. **Hardened 7 Oct 2026** — waits out a running `normalize.py`, asserts the derived tables separately, and records a `degraded` status that cannot count as good or rotate a complete archive away (§7.5). Only one restore has ever been performed (17 Aug); another drill is the open item, not a credential |
| Entity naming / name variants | 🟡 **Legal-suffix class closed 7 Oct 2026** — bare `COMPANY`, `LIMITED` and spaced `L P` now strip, merging 119 canonical names that no amount of suffix stripping could previously reunite (Bank of New York Mellon Trust had broken 179/178). Pinned by `check_company_suffix.py`. **Still split:** geographic qualifiers (correctly — see §7.6 item 9), state abbreviations, OCR digit-for-letter, and a bare trailing `&` |
| Droplet MCP tools (`tools/droplet-mcp/`) | 🟢 **New 22 Sep 2026** — seven named tools over SSH (§6.4a). Developer-machine only; nothing installed on the droplet, no new credential, no change to how production runs. Smoke-tested against live: read-only tools returned, `db_query` write rejected by SQLite, both guarded tools refused without `confirm` |
| Ask the Data (`/ask`, `POST /api/chat`) | 🟡 **DEPLOYED 7 Oct 2026 18:19 UTC as a trial** (`cb76b6d`; tab labelled "TESTING/NOTDEPLOYED" at the owner's request, renamed to a **Beta** badge 18:45 UTC) — chat over the database with GPT-6 Astra and ten read-only lookups (§4.3). `OPENAI_API_KEY` pushed into PM2's env (`--update-env`, `MI_*` confirmed intact), no startup warning, route 401 unauthenticated, backfill processes untouched. Verified before deploy against the 21 Sep production snapshot: all ten tools return correct shapes, the SQL guard rejects writes / multi-statements / PRAGMA, and the full streaming loop ran end to end in the browser against a mock of OpenAI's streaming protocol. **First real question failed** — `gpt-6-astra` rejects function tools with reasoning on `/v1/chat/completions` ("use /v1/responses or set reasoning_effort to 'none'"); rather than drop reasoning, the client was moved to the Responses API with `previous_response_id` chaining and **redeployed 18:27 UTC (`59af9a5`)**. **Made the landing page 18:38 UTC (`5451898`)** — `/` redirects here, Overview moved to `/overview`. A successful real answer is still the next thing to observe; the `[chat]` PM2 log line per request gives rounds and tokens. Deploy hiccup: build failed once because `npm install` was skipped (§6.4) |

### 7.4 Known gaps and open items

**−10. DEPLOYED 7 Oct 2026 18:19 UTC as a labelled trial — Ask the Data has not met the real model yet, and has no spend
cap.** Everything up to the OpenAI call is verified (§7.3); what is not is how `gpt-6-astra` actually
behaves on the prompt — which tools it reaches for, whether it respects the data traps, how many
rounds a typical question takes and therefore what it costs. First deploy should be followed by a
dozen real questions with the lookups strip open, and the system prompt (`server/chat/prompt.ts`)
tuned from what is seen. There is no per-request or daily budget cap; the only brakes are the
8-round limit per question, the 200-row cap per lookup, the 60k-character cap per tool result, and
the login gate. Add a cap before opening the page to more than the current handful of users.
Known limits by design: conversation history is browser-only (a reload forgets it); `run_sql` has
no statement timeout (better-sqlite3 is synchronous), so a pathological query can hold the single
Node process for its duration — acceptable for an internal tool, not for a public one.

**−9. DEPLOYED 7 Oct 2026 16:56 UTC — FDIC Data Analytics switched to Market Intelligence; one
verification target was missed and two decisions remain open.**

Commit `dfd42f8` (see §4.3 for the page, §6.4 for the env-var step, `ROLLBACK.md` for the revert;
known-good anchor `82111ff`). Four of the five acceptance checks passed exactly — Florida's top three
by Opportunity are the API's top three in order (CERTs 35430, 24156, 59278), CERT 35541's
Balance-Sheet Actions chips are precisely `behavior.latest.fired` (`hfsTransfer`, `realizedSale`), a
wrong key produces "Market Intelligence unavailable" with no figures, and the build passes. The fifth
asked that the national view load with **no single response over 1 MB**: the seven per-band signal
calls comply (largest 898 KB), but **`/api/mi/screening?scope=National` is 1.47 MB by itself.** That
endpoint has no band or paging parameter upstream, so it cannot be split from this side, and the
Express app sends JSON uncompressed. Two honest fixes, neither applied without a decision: add
`compression` middleware here (roughly 5× smaller, but it changes every response the server sends,
not just this page), or ask for a band parameter on the upstream screening endpoint.

Also open from the same work: `/api/mi/visuals` and `/api/mi/cohort-watch` are proxied but not
rendered, because this page's layout has no component for them — rendering them would be new UI,
not a port, and the brief was to keep this app's layout. The drawer's **Generate narrative** button
triggers an OpenAI call on the Market Intelligence side; whether that cost belongs in this tool is
the owner's call. And now that it is live, the page's figures move only when Market Intelligence's daily
cache job refreshes — plus up to seven days of this server's own response cache — so "the numbers
have not changed" is expected most weeks, not a fault.

**−7a. CLOSED 7 Oct 2026 — bare `COMPANY` and `LIMITED` were treated as brand content, splitting
firms permanently.** `canonicalize()` already stripped `CORPORATION`, `INCORPORATED`, `LTD`, `CO`
and `LP`. It did not strip bare `COMPANY` or bare `LIMITED`, and `\bCO\.?\b` cannot reach `COMPANY`
across a word boundary — so every firm the county recorded both ways stayed two entities, with no
path for suffix stripping to ever reunite them.

The scale was not marginal. **Bank of New York Mellon Trust broke 179/178** — a near-even split of
one institution. Northern Trust 179/88, MCLP Asset 486/130, FDIC 622/14, Forethought Life Insurance
129/13, MetLife 111/25. Measured across all **45,262** distinct recorded names: **120 collision
groups, 119 canonical names merged away, 88 of them with real filings behind them**, and every one
of those 88 was read and confirmed to be a single real company before the change was committed.

Three couplings had to move with it, each of which fails silently:
- **`LIMITED PARTNERSHIP` and `LIMITED LIABILITY` must be stripped as whole phrases, ahead of bare
  `LIMITED`.** Word-by-word stripping leaves a dangling `... PARTNERSHIP` or the nonsense
  `A FLORIDA LIABILITY`, which splits a firm a *second* way instead of merging it. Ordering is what
  gathers all seven Cardinal Financial spellings into one.
- **A spaced `L P`.** `\bLP\b` needs the letters joined and `\bL\.P\.\b` needs the period, so the
  spelling the index also uses fell through both.
- **`ENTITY_TYPE_PATTERNS` match the *canonical* name.** `NWL COMPANY` was listed under `TRUST`,
  so dropping `COMPANY` would have quietly dropped **106 filings** to `OTHER`. Re-anchored to
  `^NWL$` rather than `\bNWL\b`, because production also holds NWL Credit Holdings, NWL Credit
  Investors I and II, and NWL 7600 Fisher Island Lender — separate entities, and not trusts.

Like the 23 Sep comma fix, this can only merge names that were **already identical apart from the
dropped word**, so the blast radius is exactly enumerable and it cannot fabricate an entity the way
the old leading-digit strip did. Pinned by `collector/tests/check_company_suffix.py`, which asserts
the converse too — including the case that must *not* merge. The email's five excluded firms were
checked in both directions and are unaffected.

**What this does not fix is §7.6 item 9**, and the owner's own example is the reason: `CITY NATIONAL
BANK` and `CITY NATIONAL BANK OF FLORIDA` stay apart deliberately, because a geographic qualifier is
not a legal suffix and City National Bank of Los Angeles is a different real bank.

**−8. NEW 23 Sep 2026 — two credit-facility rows name the LLM's hedging instead of a lender.**
`credit_facility_events.lender_brand` contains, literally, `IMPLIED AS THE LENDER IN THE FACILITY,
BUT NOT EXPLICITLY NAMED IN THE AGREEMENT TITLE` and `IMPLIED, BUT NOT EXPLICITLY NAMED IN THE
EXCERPT`. The extractor's uncertainty language reached the name column, so each behaves as a
one-off lender: they are what drop the Atlantis and NWL 2016 Evergreen borrower relationships below
100% exclusivity in any per-borrower ranking. Only 2 rows of 370, so headline counts are unaffected,
but any "how many lenders does this borrower use" figure is wrong by one for those two.
**Not fixed** — the cause is in `FACILITY_SYSTEM_PROMPT`, which cannot be edited without re-running
`collector/research/scripts/verify_integration.py` at 21/21 first (§6.7). A server-side guard that
rejects a `lender_brand` containing a sentence would be the cheaper interim fix.

**−7. ✅ FIXED 23 Sep 2026, CODE ON THE DROPLET, REBUILD SCHEDULED 01:00 UTC 24 Sep (9 PM Eastern
23 Sep) — an internal comma split entities in two.** `canonicalize()` stripped only trailing punctuation, so `CITY NATIONAL BANK, OF FLORIDA`
never met `CITY NATIONAL BANK OF FLORIDA` and the bank's own ranking in the Credit Facilities tab
was split across two rows. Measured across all 26,208 canonical entities before committing:
**32 groups, 33 entities merged away, zero false merges** — person names recorded
`SURNAME,FIRSTNAME`, commas before legal suffixes (`NEXBANK, SSB`), trust series designators.
Guarded by the new `check_internal_commas.py` (§6.6), which was verified to fail against a pre-fix
copy of the module.

**Deployed as a `git pull` only — no `npm run build`, no `pm2 restart`.** Deliberate: the fix is
Python in `collector/`, the Node bundle does not contain it, and `dist/index.cjs` was (and is) older
than HEAD because the 15/30/360 email roll-up is being held unbuilt (§4.1a). A full deploy would
have built and shipped that roll-up as a side effect. Verified after the pull that `dist/index.cjs`
still carries its 19 Sep timestamp.

**A one-off cron entry applies it at 01:00 UTC 24 Sep** (= 9 PM Eastern, 23 Sep; the droplet clock
is UTC with no DST) by re-running the ordinary `run_nightly_normalize.sh`, rather than waiting for
the 08:30 nightly. Marked `REMOVE AFTER` in the crontab; the previous crontab is saved at
`collector/crontab.before_comma_fix.*`. The rebuild takes ~90 min (last four nightlies: 86–97 min),
so it finishes ~02:30 and clears the 03:15 backup. The script's own `pgrep` guard prevents it
colliding with the 08:30 run, and the script restarts PM2 only on success, so a failure leaves the
dashboard serving the last good data.

`check_entity_names_parity.py` — the one check that needs the database and could not run locally —
**was run on the droplet after the pull and PASSES**, so the two name systems are still in parity.

**−6. RESOLVED 22 Sep 2026 — the entity count fell from 21,517 to 10,431 because the old number was
inflated.** Checked against the full backup series (seven nightly snapshots plus the manual
pre-change ones). The count did not drift and nothing was lost; it fell in **two steps, each caused
by a deliberate fix that was working as intended.**

| Snapshot | Unique entities | |
|---|---|---|
| 15 Sep 22:59 `backup_pre_rents_fix` | **21,517** | ← exactly the figure this page published |
| 16 Sep 03:04 `backup_pre_party_fix` | 21,603 | |
| 17 Sep nightly | **16,896** | ← **drop 1: −4,707** (party fix) |
| 18–19 Sep nightlies | 16,906 → 16,987 | normal growth |
| 19 Sep 19:36 `pre_weekend_fixes` | 16,994 | |
| 20 Sep nightly onward | **10,428** | ← **drop 2: −6,566** (weekend QC fixes) |

**Drop 1 (16→17 Sep) — the party fix.** Corrected which side of the document each party sits on, and
party name order: `MAE FANNIE` → `FANNIE MAE`, and reassignments such as `CITIBANK` → `US BANK` where
the assignor had been read off the wrong field.

**Drop 2 (19→20 Sep) — the weekend QC fixes.** Of 7,186 entity names that disappeared, **4,116 were
individual people** whose rows now correctly name the institution on the document — 4,892 rows moved
to `MERS` alone. Worked example, CFN `2024R673026`: the entity was `GIL ISABEL E`; the document's own
`pdf_assignor` reads *MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC.* The pipeline had been taking the
county index party — **the homeowner** — instead of the assignor named on the instrument. The
remainder are OCR and spelling variants of one institution being merged: `STATE FARM LIFE INSURANCE
COMPAMY` → `...COMPANY`, `FIRST-CITIZENS` → `FIRST CITIZENS`, `IRBC3LLC` → `IRBC3`.

**Why this is a correction and not data loss:** `aom_events_clean` *grew* across the window
(55,935 → 56,484); zero canonical names are NULL or empty in either snapshot, so nothing collapsed
into a blank bucket; and 623 genuinely new entity names appeared over the same period.

**What it means for anything published earlier:** an entity count quoted before 20 Sep 2026 counted
thousands of homeowners as if they were lending institutions. **21,517 was never a count of
institutions.** 10,431 is.

**−6a. NEW 22 Sep 2026 — one retained backup is unusable, and the verifier did not notice.**
`amo-20260916-031501.db.gz` contains **`aom_events_clean` = 0 rows**. It was taken at 03:15 while a
manual normalize was mid-run — `backup_pre_party_fix.db` is stamped 03:04 the same morning — which is
precisely the empty window §6.5 warns about for PM2 restarts. The snapshot is integrity-checked and
row-count-asserted before it may rotate an older one away (§7.5), but the assertion evidently keys on
a table that was still full, so this one passed. Restoring it would bring back a dashboard showing
zeros for Clean Transactions, Reporting and Lending Relationships. **Fix:** assert non-zero
`aom_events_clean` in `run_backup.sh`, and have it refuse to run while a normalize lock is held.

**−6b. NEW 22 Sep 2026 — the canonicaliser mangles `N.A.`** It strips the letters and leaves the
punctuation: `BANKUNITED, . F/K/A BANKUNITED`, `BNY MELLON, . S/B/M MELLON TRUST OF NEW ENGLAND`,
`CMG MORTGAGE, . DBA CMG HOME LOANS`. **37 distinct names, 61 rows** — cosmetic, low volume, but
user-visible in entity lists.

**−5. NEW 18 Sep 2026 — the nightly rebuild throws away the weekly AI company types.** Friday's
`enrich_entities.py` types companies with an LLM (e.g. Northern Trust → BANK); every nightly
`normalize.py` re-derives types without it, so they revert to OTHER until the next Friday. That is why
market transfers read 31,095 on Thursday 17 Sep and 38,312 on Friday 18 Sep with no code change.
Next step: have normalize keep `confidence_source = 'llm'` types, then re-check the mix. Until then,
compare numbers only within the same side of Friday.

**−4. NEW 18 Sep 2026 — open items from the QC review** (full list and evidence in
`docs/qc/QC_FIX_LIST_2026-09-17.md`, section 3): the 23 truncated (CAPPED) collection days need a
narrower-than-a-day search; show the real lender behind "MERS as nominee for X" using the stored
text; a screen for the direction review list; stop the lending-relationship reader retrying the same
14 documents every 20 minutes; "Collateral" still holds some non-loan pledges; the UCC Collateral/Other
filter does not separate anything; login returns 500 on an empty request; Freddie Mac is split by the
spelling "FEDERAL HOME LOAN MTG" (now typed GSE, not yet merged).

**−3. ✅ FIXED 24 Aug 2026, deployed since — the FDIC "NI YoY %" column had never worked, and the
national screen is narrower than it looks.** *(Superseded by the Market Intelligence switch, item −9: the query window, its guardrail and the FDIC response cap all leave this codebase
with the switch. Kept for the record — the lesson is in §7.5.)*

Two findings in the FDIC tab, from auditing a sibling tool's bug report against this codebase.

**The bug we had.** Year-over-year net income compares the newest four quarters against the four
behind them, so it needs **eight quarters** of history. The query window was **18 months, which
returns five.** The condition could never be met, so the field was `null` for every institution in
every region from the day it shipped and the **NI YoY %** column rendered `—` in the screening table,
the institution drawer and the comparison table. Nothing errored; a column of em-dashes reads exactly
like an upstream FDIC gap. Window is now **27 months**, sized to survive the worst case (just after a
quarter close, given FDIC's publication lag) and asserted by `script/check-fdic-window.ts`. Verified
against live FDIC data, both scopes: **0 → 990 of 1,215 institutions nationally (81%)** and **81 of 91
in Florida (89%)**.

The fix was coupled and would have backfired if done halfway: FDIC returns one row per institution
**per quarter** against a hard 10,000-row ceiling, sorted largest-first, so widening the window alone
would have dropped the national cohort from ~1,000 institutions to ~561 and raised the asset floor
from $1.07B to $2.23B — paying for the metric with half the screen. The row limit moved at the same
time.

**The gap we are keeping, deliberately.** Even at the maximum page size the national view covers
**~1,113 of ~4,450 FDIC-reporting institutions**, everything above roughly **$0.95B** in assets.
Community banks under $1B — precisely the CRE-concentrated cohort this tool exists to surface — are
**invisible on the national screen**, and peer percentiles are relative to whatever cohort is loaded.
State-scoped views are unaffected (Florida returns all 91). This was measured and accepted rather
than fixed: full coverage means paging ~40,600 rows, about 20 seconds and ~15 MB, past the data-cache
ceiling. The proper fix is the planned cached data layer. In the meantime **the tab states the cohort
it actually screened** instead of implying a complete one — the honest disclosure is the deliverable
here, not a partial fix.

**−2. ✅ RESOLVED 24 Aug 2026 — the "Broward collection may have stopped" alarm was crying wolf every
Monday. The job was healthy; the banner was measuring the wrong thing.**

Reported as an incident ("no images harvested in 2 days … those images cannot be recovered"). It was
a false alarm, and nothing was lost — every day that has aged off the feed reached `complete`.

**Why it fired.** The banner keyed on `MAX(broward_images.harvested_at)`, i.e. when new data last
*arrived*, and treated >48h as a stoppage. But Broward publishes **business days only, ~3 business
days behind**, so a weekend guarantees more than 48 hours with no new rows while the job runs
perfectly. Saturday's harvest was the last one; Sunday and Monday's runs correctly found nothing new;
the clock crossed 48h and went red. **Structurally guaranteed to fire every Monday.**

**The real defect underneath.** Broward's publication time had drifted from ~10:30 UTC to ~14:28 UTC
while the cron still ran at 12:30 UTC, so the harvester had been running about two hours *ahead* of
each day's drop for two weeks and collecting it a day late. Recoverable, but it burned a day of the
ten-day margin and it is what let the weekend gap reach 48h in the first place.

**Fixes.**
- Schedule is now **three runs a day** (15:30 / 19:30 / 23:30 UTC) instead of one, so publication-time
  drift stops mattering. `flock` added, since a hung SFTP read could otherwise pile up runs.
- New **`broward_runs` heartbeat** table, written by every run with its status and the pending-day
  picture. Liveness now measures *the job*, not the county's publishing calendar.
- The Overview shows **two separate banners** for two different responses:
  *the job has not run / last run failed* (nothing lost yet, ~10 business days of slack) versus
  *N images are on the feed unharvested* — the only condition here that becomes permanent, and the
  one that was never surfaced before.
- Guardrail `collector/tests/check_broward_heartbeat.py` asserts a quiet run reads healthy.

**The lesson, which generalises:** an alarm that fires predictably on a healthy system is worse than
no alarm, because it teaches the reader to dismiss the one that matters. "No new data" and "not
running" are different questions whenever the upstream source has its own schedule.

**−1. 🚨 NEW 23 Aug 2026 — the weekly extract step ran keyless for two weeks (fixed; catch-up run).**
User spotted blank amounts/property on every Reporting row recorded after ~15 Aug. Cause:
`run_weekly.sh` never sourced `/opt/amo-dashboard/.env`, and cron provides no environment — so the
14 Aug and 21 Aug runs collected documents, then `extract_pdfs.py` died on
`OPENAI_API_KEY is not set` and `set -e` skipped extract/normalize/enrich. It hid because (a) the
15–17 Aug repair backfill fixed everything recorded *earlier*, and (b) the facility tick kept
stamping new documents `status='OK'` (facility-fields-only, no `raw_json`), so the table looked
extracted while 0 of 206 recent clean rows had a loan amount. **Fix `2441222`:** the script now
sources `.env` and aborts loudly up front if the key is missing — a skipped week is obvious, a
half-run hid for two weeks. Recovery: manual `extract_pdfs.py --limit 1500 --workers 8` catch-up
(pending selection keys on `raw_json IS NULL`, so it claims exactly the missed documents), then the
nightly normalize + cache bust surfaces the fields. Same detection path as item 0: **the only
visible symptom was the Reporting page**, again. In the same cron log, the AIT collection timeouts
(component table above) were found — separate issue, still open.

**0. 🚨 70% of Miami-Dade was never fully extracted — found and being repaired 15 Aug 2026.**
The single largest data problem found to date, and it was invisible from every angle except the UI.

**What happened.** Two jobs write to `pdf_extractions`. The facility backfill
(`batch_extract_facility.py`) writes a row as soon as it has a *facility* verdict — marked
`status='OK'` but with none of the main fields. The main extractor picked its work by asking
"does this document have a row yet?", so every document the facility backfill reached first became
**permanently invisible** to it. From 22 Jul 2026 (when the full-history facility backfill started)
this cost **50,042 of 71,366 Miami-Dade documents** their property address, folio, loan amount,
signatory, document category and document-derived parties. Broward is unaffected.

**Why it went unnoticed for three weeks.** Every affected row reads `status = 'OK'`. There was no
error, no failed job, no log line and no banner — the pipeline believed it had succeeded 50,042
times. The only visible symptom anywhere was the empty Property / Folio / Loan Amt / Signatory
columns on the Reporting page, which is exactly how it was found.

**The fix.** Pending work is now selected on `raw_json IS NULL` — the main extractor always stores
the model response and the facility path never does, so it is an exact test (verified on production:
22,115 rows with `raw_json` all have OCR text and a category; 50,042 without have neither). This also
makes the weekly job self-healing if it ever happens again.

**The repair.** A 49,845-document re-extraction is running since 15 Aug 2026 19:38 UTC at **8
workers, ~1,450 docs/hour**, ~$25 in LLM spend, **expected complete Mon 17 Aug ~06:30 UTC**.
Progress: `collector/main_backfill.log`. Until it completes, document-derived fields remain absent
for the affected documents and any analysis resting on them is understated.

The worker count was set by measurement, not by reading CPU: at 4 workers `top` showed 94.5% user /
0.1% idle, which looks saturated, yet 8 workers proved **59% faster** (879 → 1,397 docs/hour) with
zero fetch failures — most of each document is network wait, so more in-flight work keeps OCR fed.
**Size this pool by measuring throughput, never by CPU percentage.**

**The backfilled data only becomes visible after a normalize.** Extraction fills `pdf_extractions`;
the dashboard reads `aom_events_clean`, which only `normalize.py` rebuilds. The scheduled Monday
08:30 UTC nightly run lands ~2 hours after the backfill finishes and picks it all up automatically,
including the PM2 restart that clears the cache — no manual step. Budget **2–2.5 hours** for that
run rather than the usual 85 minutes, since it will be working through ~72k extracted Miami-Dade
documents instead of ~22k.

**Expect the dashboard's numbers to move noticeably afterwards.** 50k documents will contribute
document-derived party names for the first time, so entity counts, rankings and classifications will
all shift — new names entering the classification sweep can move existing entities' types (§6.8,
"Add a new county", makes the same point). That is the repair working, not a new fault.

**The general lesson, worth keeping:** *"has a row" is not "has been done."* Two writers shared one
table with no shared definition of done, and the cheaper job's bookkeeping silently satisfied the
expensive job's precondition. Any future writer to `pdf_extractions` must be checked against this.

**1. Broward analytical coverage is thin — 589 of 42,559 documents (~1.4%). Largest gap in the product.**
The index is complete; the *documents* are not. Only harvested images can be extracted, and the
harvester has only run since 7 Aug 2026, so 2023–2025 is **index-only**: filings, parties, dates and
instrument numbers are all searchable, but nothing derived from reading the documents (entity
classification, transaction types, facilities, loan amounts) exists for that period.

**A history scraper was investigated on 11 Aug 2026 and rejected.** The portal returns **403 to
every non-browser client** — plain `curl`, `curl` with a browser user agent, `curl` with full
browser headers, and from the droplet's datacenter IP — all served Cloudflare's block page. Only a
real browser executing the JS challenge gets through. Images are keyed by an internal `docId`
obtainable from the results grid, but the viewer reads
`window.opener.$('#RsltsGrid').data('tGrid')`, so direct navigation to `/Details/` is inert and each
document needs a full browser with the opener chain. Scraping 13,674 documents that way means
sustained automated traffic from a datacenter IP against active bot protection — i.e. deliberately
defeating it. **Not built, by decision.**

**Agreed path:** stay forward-only for now, and place a **bulk historical image order with Broward
RTT (954-831-4000)** when convenient — the sanctioned channel for exactly this. Meanwhile Broward's
analysed window grows ~55 documents/day on its own, and extraction now runs **daily** rather than
waiting for the Friday weekly job.

**2. The 2026 Broward index gap: Jan–Jun 2026 entirely missing (~7,000–8,000 assignments).**
🔴 **Now surfaced in the UI.** As of 11 Aug 2026 `/api/stats` returns `coverage_gaps` and the
Overview shows a red banner naming the missing period whenever the selected scope has one. This was
added because Broward's range reads `2023-01-03 → 2026-08-05`, which looks continuous — on a
monthly chart the hole is indistinguishable from the market going quiet, which is how a silent gap
becomes a confident wrong conclusion. Miami-Dade correctly reports no gap; All Counties reports
Broward's, labelled, rather than hiding it in the aggregate. Detection counts only whole empty
months, so weekends and holidays never trigger it.

The underlying gap is still open:
Unreachable from the SFTP feed — yearly exports stop at the last completed year (CY2025 published
17 Feb 2026), and the daily feed retains only ~10 days. Three options, **undecided**:
scrape AcclaimWeb for that window · request a one-off bulk export from Broward RTT (they invite this,
954-831-4000) · wait for CY2026 to publish (~Feb 2027) and backfill then. The index self-heals when
CY2026 lands; **the images for that window never will.**

**3. Cron failures on the droplet are silent** — no `MAILTO` configured for cron itself. A mail
transport now exists for the weekly report (item 9, `server/email/mailer.ts`) but is not wired to
alerting. Mitigated
11 Aug 2026: the Overview now shows a red banner when Broward images have not been harvested for
over 48 hours, using `MAX(harvested_at)` as the liveness signal. This matters because Broward's
feed drops each day after ~10, so a job that quietly stops costs images permanently. Proper
alerting (email/webhook) is still not configured — the banner only helps someone who opens the
dashboard.

**4. Broward facility detection has found 0 real facilities** in 589 extracted documents. Not
necessarily wrong — Miami-Dade's rate (445 in 70,834, ~0.6%) predicts ~3–4 at this sample size — but
worth re-checking once Broward's extracted count grows.

**5. 69 orphaned Broward images** from 21 Jul 2026 — that day aged off the feed before its index rows
were ingested, so the images have no `assignments` row and will never be picked up.

**6. ~~Residual Miami-Dade-specific copy~~ — RESOLVED 11 Aug 2026.** All hardcoded county copy is
gone: assertive headers (Reporting subtitle, both printed EntityReport titles) are now dynamic, and
descriptive tooltips are county-neutral. The only "Miami-Dade" left in the DOM is the county
selector's own option.

**7. ~~Two facility rows flagged for manual sanity check~~ — CHECKED 15 Aug 2026. One is wrong, one is
fine.**

- `2026R268269` is a **confirmed false positive.** It is an SBA 504 debenture — a single $449,560 term
  loan on one property, assigned Florida First Capital → JPMorgan Chase — classified as
  `warehouse_or_revolving_credit_facility` with `facility_confidence = high`. A 504 debenture is the
  opposite of a revolving facility. The likely trigger is the evidence quote's "504 **Renewal** Note".
- `2026R277453` is **real, with two field-level defects.** Tower 36 Owner LLC → Cirrus Real Estate
  Funding LLC, an Assignment of Leases and Rents securing a loan with a stated *maximum principal
  amount* — that structure is a genuine facility. But `facility_lender_name` is **empty**, because the
  document refers to the lender only by the defined term "Lender" (this is the "grantor extracted as
  the literal string `Lender`" note); the real lender is the grantee. And `facility_amount` is
  **$34,400,000 while its own evidence quote says $30,000,000** — the quote describes the *existing*
  loan, not the amount recorded.

**How big is the class?** Small, and not systemic: of 445 facility rows, 11 have
`amount_type = loan_amount` under $2M (the shape of the 504 false positive) and 3 name SBA/504
instruments. 19 rows have no lender name. Worth a targeted prompt fix, not a re-extraction.

**The transferable lesson:** `facility_confidence = high` is the extractor's confidence in its own
reading, not in the classification. Both rows carry it. Any future audit should key on *incoherence
between fields* — a "revolving facility" with a fixed `loan_amount`, an amount that contradicts its
own evidence quote — rather than on the confidence column.

**UPDATE 14 Sep 2026 — the classification half of this is fixed, and it was far larger than two
rows.** `facility_type` was decided by the model, and it put **623 of 625 documents** in
`warehouse_or_revolving_credit_facility`, 2 in any other category, and **none at all** in
`syndicated_credit_agreement`. Documents whose own agreement name read "Commercial *Non-Revolving*
Line of Credit" came back as revolving, and 101 whose only named agreement was "Security Instrument"
or "Mortgage" — ordinary conveyancing paperwork — came back as credit facilities.

The decision now happens in code rather than in the prompt, because adding explicit rules to the
prompt fixed only 6 of 16 sampled cases: the model is reliable at reading the agreement *name* off
the document and unreliable at judging the *category*. `2026R268269`, the SBA 504 debenture named
above, is correctly resolved to "not a facility" by the new rules. Recomputing every existing row
gives **warehouse 300 · not a facility 261 · business line of credit 53 · syndicated 11**.

This had survived since the feature shipped because the verification gate compared only "facility"
against "not a facility" and never checked which type was chosen — *a field no test asserts is a
field nothing protects*. `collector/tests/check_facility_type.py` now guards the rules offline.

✅ **The recompute has been run.** Verified against production 7 Oct 2026: `credit_facility_events`
holds **warehouse 304 · business line of credit 67 · syndicated 11**, against 623-of-625 warehouse
and *zero* syndicated before the fix, and the distribution is spread across all four years rather
than only recent ones — so old rows were relabelled, not just new ones. The 243 documents whose only
named agreement was conveyancing boilerplate have left the facility dataset (625 → 382 rows). The
original complaint is resolved at the row level too: every remaining Amerant warehouse row is to an
LLC under an agreement literally named "Mortgage Warehouse Line of Credit and Security Agreement",
and the consumer HELOCs now sit in their own bucket. **The field-level defects described above
(empty lender name, amount contradicting its own quote) are NOT fixed.**

**8a. ✅ RESOLVED — backups reach off-box storage nightly.** `run_backup.sh` runs at 03:15, takes an
online-API snapshot, integrity-checks it, asserts it is non-empty, gzips it, keeps the last 7
locally and uploads to `spaces:amo-dashboard-backups-ec`. Verified 7 Oct 2026: the eight most recent
`backup_runs` rows all read `status=ok` with that remote, ~148MB per archive. This item and §7.6
item 3 both described it as dormant long after the Space existed — the risk register row has said
"Resolved 17 Aug 2026" since then, and the two disagreed.

Two things still true and worth keeping. First, a snapshot whose **derived** tables are empty is now
recorded as `degraded` rather than `ok`: it is still kept and uploaded, because the raw tables are
the irreplaceable part and the derived ones rebuild in one `normalize.py` run, but it may not count
as good or rotate a complete archive away (7 Oct 2026 — see §7.5 and `check_backup_degraded.py`).
Second, for reference, the environment this needs in `/opt/amo-dashboard/.env`:

```
BACKUP_REMOTE=spaces:<bucket-name>
RCLONE_CONFIG_SPACES_TYPE=s3
RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
RCLONE_CONFIG_SPACES_ENDPOINT=<region>.digitaloceanspaces.com
RCLONE_CONFIG_SPACES_ACCESS_KEY_ID=<key>
RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY=<secret>
```

Configuring rclone through environment variables rather than `rclone.conf` is deliberate: `.env` is
already gitignored, so the credential exists in exactly one place. `rclone` must also be installed
(`apt-get install -y rclone`) — until it is, the job reports `local_only` rather than failing.

**Still genuinely open in this area:** nothing has been restored from the bucket since the one test
on 17 Aug 2026. A backup nobody has restored is a hypothesis.

**8b. ~~`DealIntelligence.tsx` is unrouted~~ — RESOLVED 11 Aug 2026: retired.**
The page and its 8 endpoints were removed together (deleting the page alone would have left
orphaned endpoints still needing county-correctness). 40 endpoints → 32. Implementation remains
in git history (added `197e947`, unrouted `3b1674a`, removed `9a2932d`) if the distressed-sourcing
use case ever returns.

**9. Weekly emailed report — built and preview-tested 19 Aug 2026, NOT yet live.** New capability:
`server/scripts/sendWeeklyReport.ts` builds a rolling 15-day report as an inline HTML email — the
Reporting page's transaction table (CFNs linked to county document images, capped at the 50 most
recent inline) with a per-day filing-volume bar chart, and a Lending Relationships snapshot (top 10
most active lender↔borrower pairs, same grouped query as the tab via the shared
`server/lending/facilities.ts`) with a filings-per-relationship bar chart. Charts are email-safe
nested-table bars (no JS/SVG — Outlook desktop renders with the Word engine), every bar
direct-labeled. Full row-level data for both datasets is attached as CSVs. No third-party email
vendor — sends over SMTP through the existing `mktinfo@safeharborcp.com` Outlook/Office 365 mailbox
via `nodemailer` (`server/email/mailer.ts`, `server/email/report.ts`). Recipients today:
`andres@safeharborcp.com`, `david@safeharborcp.com` (§6.2, `REPORT_RECIPIENTS`).

The script defaults to **preview mode** — writes the HTML + both CSVs to
`server/scripts/output/` (gitignored) and sends nothing — and only sends for real with an explicit
`--send` flag, so it cannot fire accidentally.

**Status 1 Sep 2026 — content approved, code deployed, app password installed, and the SMTP path is
nonetheless dead.** DigitalOcean blocks outbound SMTP account-wide from this droplet: ports 587 and
465 time out to every `smtp-mail.outlook.com` address (re-verified 1 Sep), while `ufw` is inactive,
`iptables` OUTPUT is ACCEPT, and 443 egress works — so it is DO's anti-spam policy, not droplet
config. `nodemailer`'s `transport.verify()` simply hangs.

**The shipped answer is Microsoft Graph over HTTPS 443** (`server/email/graphMailer.ts`, commit
`e853307`), which sidesteps the port block while still sending from the same Microsoft mailbox — no
third-party vendor, consistent with the original decision. `nc -zv graph.microsoft.com 443` succeeds
from the droplet. Auth is the app-only client-credentials flow. The transport auto-selects Graph
when `GRAPH_CLIENT_ID` is set and falls back to SMTP otherwise; `REPORT_TRANSPORT=graph|smtp` forces
either. The SMTP path is retained in case DO ever lifts the block. A **`--check`** flag acquires a
token and reads the sending mailbox **without sending anything**, so the Azure setup can be
validated before mail reaches a real recipient.

**Now blocking on:** Azure app registration values (§7.6 item 4) — `GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` in `/opt/amo-dashboard/.env`, with **application-level**
(not delegated) `Mail.Send` admin-consented. After that: `--check`, one `--send` to the owner's own
address, then the real recipients, then cron wiring next to `run_weekly.sh` (§6.5).

Note the report content itself is confirmed real — a 1 Sep droplet preview off live data returned
607 clean events / 222 relationships for the 17 Aug–1 Sep window, and that window's extraction is
healthy (640 rows, 57% carrying loan amounts).

### 7.5 Risk register

| Risk | Impact | Mitigation in place |
|---|---|---|
| Broward image feed missed for >10 days | **Permanent, unrecoverable data loss** | Cron polls three times daily (15:30/19:30/23:30 UTC) so a moving publication time cannot outrun it; `flock` prevents overlap; ~10-day buffer. The Overview keys on the **per-run heartbeat** in `broward_runs` — red for "job stopped or failed", separately red for "images pending on the feed". Reworked 24 Aug 2026; the previous 48h-since-last-harvest rule false-alarmed every Monday |
| An alarm that fires on a healthy system | The reader learns to dismiss it, so the **real** alert is ignored too | Liveness is measured from the job's own recorded runs, never inferred from when upstream data last arrived — upstream sources have their own calendars (Broward publishes business days only, ~3 days behind). "Never run" is deliberately **not** treated as a stoppage |
| A derived metric's input window cannot satisfy its own precondition | The field is `null` **forever**, renders as `—`, and is indistinguishable from missing upstream data. Cost AMO a permanently blank NI YoY column; cost the sibling tool a silently redistributed score weight | Until 7 Oct 2026: `script/check-fdic-window.ts` asserted the window yields enough published quarters, with 18mo and 24mo as negative controls. **Since the Market Intelligence switch (7 Oct 2026) the window and the check have left this codebase** — the metric is computed upstream, where the equivalent precondition now has to be asserted. What this app keeps is the display-side rule: a source that does not answer shows *no* figures rather than dashes that could pass for data |
| The analytics source and this page disagree | An analyst quotes a score or a signal that the Market Intelligence tool itself does not show | `/api/mi/*` is a 1:1 pass-through with no computation on this side; only `ok:true` responses are cached; the page's columns are the API's fields under the API's names. Verified by sorting the raw API rows and comparing the top three to the page (§7.4 item −9). The remaining gap is time, not logic: this server caches for 7 days, so after an upstream refresh the two can differ for up to a week until a cache bust |
| A deploy silently fails | Production keeps running old code while checks look fine | `git pull` prints `Updating <old>..<new>` AFTER an abort — **verify by effect** (`git log --oneline -1` on the droplet, or grep `dist/index.cjs`), not by output. Bit us 11 Aug 2026. **Improved 22 Sep 2026:** `git_state` (§6.4a) reports the `dist/index.cjs` build time against the commit time, so a pulled-but-not-built box is visible in one call instead of being inferred; `deploy` performs pull + build + restart as one operation so the build cannot be skipped |
| A published figure is stale or measured differently from what the tool shows | A non-developer quotes a number outward that the dashboard contradicts | **Partly open.** §7.2 now records the exact query behind each figure so the next reviewer can reproduce them, and `db_query` (§6.4a) makes re-checking cheap. But nothing *asserts* the page and the Overview agree — the 21,517 → 10,431 entity discrepancy (§7.4 item −6) was found by hand, and only because the figures were being re-derived for this review |
| PM2 restarted mid-normalize | Dashboard shows zeros for up to 7 days | Nightly wrapper restarts only on success; documented in `ROLLBACK.md` and here |
| A new writer forgets the `county` column | Rows **silently relabelled Miami-Dade**, no error anywhere | `check_county_isolation.py` asserts it — has already caught this three times |
| Two jobs writing `pdf_extractions` disagree on what "done" means | **50,042 documents silently never extracted**, every row reading `status='OK'` — happened 22 Jul–15 Aug 2026 | Pending work is now keyed on `raw_json IS NULL`, not row existence. **No automated check yet** — a guardrail asserting "every `status='OK'` row has `raw_json`" would have caught this on day one |
| Miami-Dade portal changes its markup | Collection stops | Failures surface in `collection_log` and the Collection Log page |
| Data changed without clearing the cache | Stale dashboard for up to 7 days | Nightly restart; `POST /api/cache/bust` |
| Single droplet, single SQLite file | Total loss on host failure | **Resolved 17 Aug 2026** — nightly verified snapshot to DigitalOcean Spaces (different failure domain from the droplet), 7 archives retained locally, all Broward images mirrored. Restore tested from the bucket copy, counts matched live exactly |
| Backups run but silently stop working | False confidence — the failure is only discovered when a restore is attempted | Every run records status in `backup_runs`. The Overview shows **red** when the job is absent, errored, or has not run in 48h, and **amber** when it is working but not reaching off-box storage. Snapshots are integrity-checked and row-count-asserted before they may rotate an older one away |
| A backup is taken while `normalize.py` is mid-run | The snapshot restores a dashboard showing **zeros**, and passes verification, so the failure is invisible until a restore is attempted | **Closed 7 Oct 2026.** `run_backup.sh` now waits out a running rebuild before snapshotting (the same `pgrep` gate the nightly normalize and the weekly email use), and gives `aom_events_clean` its own assertion — the old one keyed on `assignments`, which stays full throughout. An empty derived table is recorded as a new `degraded` status that bars the run from counting as good and **skips rotation entirely**. Deliberately *not* the fix proposed here previously ("refuse to run"): refusing would suppress the nightly Broward image copy too, and those images are the one unrecoverable thing in the system. `check_backup_degraded.py` runs the real script and, against the pre-fix version, reproduces the incident |
| A headline figure counts the wrong thing and nobody notices | Numbers go outward that overstate the dataset — the entity count included thousands of homeowners as if they were lenders, for an unknown period before 20 Sep 2026 | **Partly open.** Fixed at source by the 16 and 19 Sep party fixes (§7.4 item −6), and §7.2 now records the query behind each published figure. But nothing asserts that a figure still measures what its label claims; this one was caught only because the whole table was re-derived by hand |
| Weak default password | Unauthorised access | `AMO_PASSWORD`/`AMO_SECRET` must be set in the production `.env` |
| A search returns more results than the county will serve | **Documents silently missing on the busiest days.** The portal caps a search at ~500 index rows. The collector splits a date range into smaller chunks until it fits, but it cannot split below a single day — so on 23 days between 11 Jan 2023 and 3 Feb 2026 it stored what it was given and moved on. Those days hold 109–145 documents each against a daily average of 59, consistent with truncation | **Open.** The affected days are recorded as `CAPPED` in `collection_log`, so they are identifiable. Recovering them needs a narrower search axis than date — party name or book range |
| A collection window fails and is never retried | A one-off failure becomes permanent data loss | **Partly open.** Failed windows *are* retried, but `run_weekly.sh` only looks back 10 days, so a window that fails ages out of retry range within roughly one run. Windows the county reports as genuinely empty stay retry-eligible indefinitely by design |
| A document type is added to the collector without gating the analytical tables | Non-assignment filings silently inflate the Reporting tab and can flip entity types on existing companies | `normalize.NON_ASSIGNMENT_DOC_TYPES` gates both the clean-events build and the raw-name signal sweep; `check_doc_type_scope.py` asserts it, negative control included |

### 7.6 Recommended next steps

**Needing the owner, not an engineer:**

1. 🔴 **Revoke the leaked GitHub PAT.** It sits in plaintext in the `origin` remote URL in
   `.git/config`, on this Mac and the droplet, and **the repo is public**. It was never committed,
   so GitHub's secret scanning never saw it and nothing will auto-revoke it. Open since
   4 Aug 2026 — the oldest item here and the only one with security consequences.
   Revoke → check the account security log → move to an SSH remote / read-only deploy key.
2. 📞 **Place the Broward bulk image order** — 954-831-4000. Document type `AST`, 2023-01-01 →
   2025-12-31, ~41,900 documents, TIFF as the daily FTP feed already delivers so it drops straight
   into the existing pipeline. Would also close the Jan–Jun 2026 index gap if requested together.

3. ✅ **DONE — the DigitalOcean Space exists and the backup job uses it.** Verified 7 Oct 2026: the
   eight most recent runs all recorded `status=ok` against `spaces:amo-dashboard-backups-ec`. This
   item and §7.4 item 8a had both stayed on the list long after the Space was created, while the
   risk register recorded it as resolved on 17 Aug 2026 — the page disagreed with itself for seven
   weeks. What remains is not a credential but a drill: **restore from the bucket again**, since
   the only restore ever performed was the one on 17 Aug.
4. ✅ **DONE — the Azure app is registered and the weekly email is live.** The Graph transport sent
   its first report to real recipients on **Monday 5 Oct 2026 at 07:00 EDT** and has been verified
   end to end (§4.1a). DigitalOcean's outbound SMTP block is now moot — Graph was the answer, not
   a workaround.
   **One piece of hardening still outstanding:** app-only `Mail.Send` permits send-as for *every*
   mailbox in the tenant. Scope it to the one sender with an Exchange `ApplicationAccessPolicy`.
   That needs an M365 administrator and is the only remaining action in this item.

**Engineering:**

4a. **Owner-set priorities from 1 Sep 2026 — all three now closed, as of 11 Sep 2026.**
   (i) ✅ **Document coverage: ANSWERED.** The clerk offers 79 types, exactly three are assignments,
   and we request all three (see §3). Nothing was missing. The AIT failure was diagnosed — the county
   returns no results for that type and never has — and fixed so it no longer stalls each run. UCC
   financing statements (`FST`) were added as a new source of lending relationships.
   (ii) ✅ **Classification: answered, and now closed.** "Assignments of collateral" was never a
   missing document type — 19,123 documents already carry `COLLATERAL`. The facility *type*
   over-labelling that was still open here is **fixed and applied in production** (§7.4 item 7,
   verified 7 Oct 2026): the decision moved from the prompt into a deterministic rule in code on
   12 Sep 2026, and the recompute has since relabelled every existing row. No prompt change was
   needed, so the `verify_integration.py` 21/21 gate was never put at risk — which is why the fix
   went into code in the first place: adding rules to the prompt had fixed only 6 of 16 sampled
   cases.
   (iii) ✅ **DONE 10 Sep 2026 — Wilmington Savings, MERS, Fannie Mae and Freddie Mac are hidden
   from the Reporting tab.** Display filter only; every row stays in the database and every other
   page still counts them. See §4.3 for what this changes on screen.

4b. ✅ **DONE 10 Sep 2026 — the UCC extraction backfill ran to completion.** 32,709 of 32,743
   documents read, **zero download failures**, 34 failures in total (0.1%), **$19.80** against a $35
   ceiling — within twenty cents of the estimate. 84% carry a property address. Note for any future
   bulk run: `extract_pdfs.py` defaults to a **$5 budget cap**, so a large job must pass `--budget`
   explicitly or it stops a quarter of the way through.

5. **Real cron-failure alerting.** The dashboard now warns when Broward collection stalls *and* when
   backups stop succeeding, but both only help someone who opens it. There is still no `MAILTO` and
   no uptime ping on the droplet. A mail transport now exists (`server/email/mailer.ts`, built for
   the weekly report, item 9 in §7.4) — it is scoped to that report only today, but the same Outlook
   SMTP path could carry cron-failure alerts later without a new vendor.
6. **Confirm `AMO_PASSWORD` and `AMO_SECRET`** are set in the production environment.
   ✅ **Verified 15 Aug 2026** — both are present in the live PM2 environment. Two caveats stand:
   `ecosystem.config.cjs` has drifted from the env PM2 actually holds, so a `pm2 delete` + fresh
   start would silently change the dashboard password; and the password in use is short and
   guessable, which matters because the gate is a single shared password with no lockout.
7. ✅ **Both flagged facility rows checked 15 Aug 2026** — see §7.4 item 7. One confirmed false
   positive, one real with two bad fields. Worth a targeted extractor-prompt fix keyed on
   field incoherence rather than confidence. Broward facility detection is **still 0 in 589
   documents**; recheck as the extracted count grows.
8. **Clean up the four ad-hoc `backup_pre_*.db` files** on the droplet (~420MB). They predate the
   automated job and are unrotated. Keep `backup_pre_broward_normalize.db` — `ROLLBACK.md` and §6.8
   both name it as the Broward rollback point — and copy the rest to Spaces before deleting.
9. **Truncated and abbreviated name variants that the suffix rules cannot reach.** The 7 Oct 2026
   change closed the legal-suffix class (§7.4 item −7a), and the 23 Sep comma fix closed another,
   but three kinds remain, each needing a different mechanism rather than a wider rule:
   · **geographic qualifiers** — `CITY NATIONAL BANK` vs `CITY NATIONAL BANK OF FLORIDA`. These are
     two different real banks, so this one is *correct as it stands* and must not be "fixed"; the
     owner's original example is the trap, not the bug. Only a human can say which rows are which.
   · **state abbreviations and OCR digits** — `CITY NATIONAL BANK OF FLA` (1 filing) and
     `CITY NATIONAL BANK 0F FLORIDA` (1 filing, digit zero for the letter O). Small, mechanical,
     and safely fixable; not bundled into the suffix change so that change carried one source of
     variation.
   · **a bare trailing `&`** — `JAMES B NUTTER &` is a real canonical name. Stripping it would also
     turn the OCR truncations `EVOLVE &`, `GROVE &` and `UNIVERSAL &` into bare generic words, and
     `UNIVERSAL` is exactly the kind of word that absorbs unrelated firms. Needs the "confirmed
     landing" treatment (only strip when the shortened name already exists) rather than a blanket
     rule.
   Separately, `canonicalize()` strips a bare `II`/`III` as if it were a suffix, which merges
   `ARVE INVESTMENTS II` into `ARVE INVESTMENTS` while leaving `NWL CREDIT INVESTORS I` and `II`
   apart. That is long-standing behaviour, pinned by the baseline, and a roman-numeral problem
   rather than a suffix one — worth a deliberate decision, not a drive-by change.
10. **Give the Python guardrails a single entry point.** There are fifteen `collector/tests/check_*.py`
   and they are run by hand from the table in §6.6; `npm run check` covers only the four TypeScript
   gates. Four of the fifteen had never been added to that table, found on 7 Oct 2026 by diffing the
   directory against the page. The checks are the main defence against the silent-correctness bugs
   this project keeps finding, so the one that is easiest to forget to run is the weak link.
11. **Restore from the bucket again.** The only restore ever performed was 17 Aug 2026 (§7.4 item 8a).

---

## 8. Reference

### Key endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/stats` | Headline counts, date coverage, transaction breakdown |
| `GET /api/monthly-volume` | Monthly time series |
| `GET /api/assignments` | Raw county index, paginated |
| `GET /api/clean-events` | Verified loan transfers |
| `GET /api/credit-facility-events/*` | Facilities, families, filings, chart |
| `GET /api/entity/:name` | Entity profile |
| `PATCH /api/entity/:name/type` | Reclassify an entity |
| `GET /api/entity-nodes` | Canonical entity list |
| `GET /api/aliases/suggestions` · `POST /api/aliases/merge` | Duplicate manager |
| `GET /api/reporting` · `/export` · `/chart` · `/participants` | Reporting tab + CSV |
| `PATCH /api/reporting/:cfn/review` | Review workflow |
| `GET /api/targets` · `POST` · `DELETE` | Watchlist |
| `GET /api/mi/meta` · `/api/mi/screening?scope=` · `/api/mi/visuals?scope=` · `/api/mi/cohort-watch?scope=` · `/api/mi/behavior-signals?scope=&band=` · `/api/mi/institution/:cert[?include=narrative]` | Market Intelligence pass-through (since 7 Oct 2026; replaced `GET /api/fdic/financials`) — 1:1 with its Market Analytics data API, bearer key added server-side, `ok:true` cached 7 days, 503 when unconfigured |
| `GET /api/collection-log` | Pipeline health |
| `POST /api/chat` · `GET /api/chat/config` | Ask the Data (7 Oct 2026). Body `{messages:[{role,content}], county}`; answers as Server-Sent Events (`tool`, `tool_done`, `delta`, `done`, `error`). Never cached. `config` reports whether a key is set and which model answers |
| `POST /api/cache/bust` · `GET /api/cache/stats` | Cache control |

Most read endpoints accept `?county=MIAMI-DADE|BROWARD` (omit for all counties; the server defaults
to Miami-Dade when no parameter is sent, and the client always sends one explicitly so the displayed
scope and the applied scope cannot drift).

### Data sources

| Source | Access | Notes |
|---|---|---|
| Miami-Dade Clerk Official Records | Web portal, automated via Playwright | Login required; 499-record server cap per query, handled by recursive chunk splitting |
| Broward County Records, Taxes & Treasury | Public SFTP `BCFTP.Broward.org:22` (`crpublic`/`crpublic`) | No login, no captcha, no scraping. Yearly exports 1978→last completed year (index only) + daily files with images (~10-day retention) |
| Market Intelligence tool — Market Analytics data API | `https://market-intelligence-tool-gilt.vercel.app/api/analytics/v1/*`, bearer key, contract saved at `docs/market-intelligence-meta.json` | FDIC Call Report screening, scores, balance-sheet signals and per-institution trend/history (since 7 Oct 2026; replaced the direct FDIC BankFind proxy). Refreshes on its own daily job, keyed by FDIC quarter |
| OpenAI | `gpt-4.1-nano`, Chat Completions + Batch API | Document extraction and entity classification fallback |

### Internal documents

| File | Purpose |
|---|---|
| `SESSION_LOG.md` | Dense running history of every substantive change — **read first** |
| `ROLLBACK.md` | Revert paths for in-flight workstreams |
| `CLAUDE.md` | Operational facts, mirrored for Cursor at `.cursor/rules/amo-session-handoff.mdc` |
