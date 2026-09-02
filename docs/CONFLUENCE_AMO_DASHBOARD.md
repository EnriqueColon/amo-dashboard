# AMO Tracker — Mortgage Assignment Intelligence Dashboard

> **Status:** Live in production · **Owner:** Enrique C. · **Last reviewed:** 1 Sep 2026
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
| **Data volume** | ~114,100 recorded filings, ~18,000 resolved entities, 44,585 confirmed loan transfers |
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

### Entity types

`BANK` · `SERVICER` · `PRIVATE_CREDIT` · `GSE` · `MERS` · `TRUST` · `OTHER`

Assigned by a cascade, highest confidence first:
**manual override → FDIC institution match → legal-suffix signal → behavioural pattern → regex rules → LLM fallback → `OTHER`.**

### Transaction types

| `txn_type` | Meaning |
|---|---|
| `SELF_ASSIGN` | Both sides resolve to the same company — an internal re-titling, not a market event. |
| `MERS_RELEASE` | MERS assigning as nominee — a housekeeping release, not a trade. |
| `MARKET_TRANSFER` | Institution → institution. **The real signal**: debt actually changing hands between market participants. |
| `ORIGINATION` | Non-institution → institution. Paper entering the institutional market. |
| `INSTITUTIONAL_OUT` | Institution → non-institution. Paper leaving it. |
| `PRIVATE` | Neither side is an institution. |

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

#### Overview (`/`)
The landing page. Headline counts (total filings, unique entities, market transfers, self-assigns,
private-credit activity), date coverage, monthly assignment volume chart, and the Top Acquirers / Top
Sellers / Most Connected leaderboards.
*Start here to see whether the data is current — the date range and last-collected date are the fastest health check.*

#### Reporting (`/reporting`)
The main working surface. A filterable, searchable, paginated table of clean transactions with an
analytics header, a participant-activity breakdown and a time-series chart.
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
Bank fundamentals pulled live from the FDIC API, proxied through the server. CRE concentration,
construction/multifamily/non-residential loan mix, NPL and noncurrent ratios, ROA/ROE, efficiency,
capital. Includes a **cohort summary** and a **target screening list** — used to spot banks under
balance-sheet pressure whose filing behaviour is worth watching.

**Read the cohort line under the screening list.** When a state is selected, the screen covers every
FDIC-reporting institution in that state (Florida: all 91). **Nationally it does not** — FDIC caps a
response at 10,000 rows and returns them largest-first, so the national view is the ~1,113 biggest
institutions, all above roughly $0.95B in assets, out of ~4,450 that file. Community banks under $1B
are therefore **absent from the national screen**, and the peer percentiles in the institution drawer
are relative to whichever cohort is loaded, not to all US banks. The tab states this rather than
implying a complete screen; the fix is the planned cached data layer, not a bigger page request.

Peer and trend figures need **eight quarters** of history (a trailing-twelve-month figure against the
one before it), and FDIC publishes a quarter months after it closes — as of Aug 2026 the newest data
available was Q1 2026. That is why the query reaches back 27 months.

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
     React client  ─── FDIC API (proxied server-side)
```

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
│   └── fdic.ts         FDIC API proxy + transformation
├── shared/
│   └── fdic-window.ts  the FDIC quarter window — one contract, server + client
├── script/
│   ├── build.ts               vite (client) + esbuild (server bundle)
│   ├── check-metric-directions.ts   guardrail (see §6.6)
│   └── check-fdic-window.ts         guardrail (see §6.6)
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
| `OPENAI_API_KEY` | `extract_pdfs.py`, `enrich_entities.py`, `batch_extract_facility.py` | |
| `OPENAI_MODEL` | same | Default `gpt-4.1-nano` |
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

Production values live in `/opt/amo-dashboard/.env`, sourced by every cron wrapper.

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
- **Do not kill running Python backfills** when restarting the Node app; they are unrelated processes.
- Long one-off scripts must be started detached, or a dropped SSH session kills them:

```bash
nohup python3 -u collector/normalize.py > /tmp/normalize.log 2>&1 & disown
```

`-u` is not optional in practice — without unbuffered output, a healthy quiet run looks stalled.

### 6.5 Scheduled jobs

All installed via `crontab -e` on the droplet.

| Schedule (UTC) | Script | What it does |
|---|---|---|
| `*/20 * * * *` | `run_facility_tick.sh` | One tick of the OpenAI Batch state machine: poll in-flight jobs, ingest finished ones, top back up to 4 concurrent batches of 500 documents. Resume-safe. |
| `30 8 * * *` | `run_nightly_normalize.sh` | Rebuild derived tables, then `pm2 restart` to clear the cache. **Skips the restart if normalize fails**, so a failure leaves the last good data serving. |
| `30 15,19,23 * * *` | `run_broward_daily.sh` (`BROWARD_INGEST_INDEX=1`) | Broward index → images → extraction → retention report + heartbeat. **Time-critical.** Runs three times a day on purpose — see "Broward's publication time moves" below. Holds a `flock` so runs cannot overlap; a skipped run exits 0. |
| `0 6 * * 5` | `run_weekly.sh` | Miami-Dade: collect last 10 days → extract PDFs → normalize → enrich. Sources `/opt/amo-dashboard/.env` itself and **aborts loudly up front if `OPENAI_API_KEY` is missing** (fix `2441222`, 23 Aug 2026 — cron provides no environment; before the fix the run half-succeeded: collection worked, extraction silently died, see §7.4). |
| `15 3 * * *` | `run_backup.sh` | Verified snapshot of the database + Broward images → local rotation (7 kept) → DigitalOcean Spaces. Records every run in `backup_runs`; the Overview banner reads it. |

**Not yet installed:** a weekly emailed report (`server/scripts/sendWeeklyReport.ts`), planned to run
right after `run_weekly.sh` on the same Friday 06:00 UTC slot. Built and preview-tested locally as of
19 Aug 2026 but not yet wired into cron — see §7.4 item 9.

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
| `check_entity_names_parity.py` | The shared address book reproduces the legacy normalize functions exactly |
| `check_alias_scope.py` | Alias scoping rules behave — note aliases are applied **after** suffix stripping |
| `check_broward_heartbeat.py` | The Broward daily job's heartbeat separates "ran and found nothing new" (normal every weekend) from "stopped running". Stubs the SFTP layer — no network needed |
| `diff_name_systems.py`, `show_merge_proposals.py` | Diagnostics for reviewing name-matching decisions |

`check_county_isolation.py` exists because the same bug has now been caught **three separate times**:
a writer that forgot to carry the `county` column. It is asserted rather than trusted for that reason.

**TypeScript-side gates** — these need no database and run in about a second:

```bash
npm run check              # tsc + both guardrails below
npm run check:metrics      # just the metric-direction guardrail
npm run check:fdic-window  # just the FDIC window guardrail
```

| Check | Asserts |
|---|---|
| `script/check-metric-directions.ts` | Every risk metric points the way it claims to: each peer threshold table's colours agree with its declared `direction`, a bank that is worst on all four metrics colours red on all four, and the CRE/capital scale gets redder as concentration rises. Includes a **negative control** — it feeds itself a deliberately inverted table and fails if it does not catch it |
| `script/check-fdic-window.ts` | The FDIC query window is wide enough for the metrics computed from it — the 27-month window must yield at least 8 **published** quarters, simulated across 24 dates spanning a year so the result does not depend on today. Models FDIC's publication lag explicitly. **Negative controls: both 18 and 24 months must still fail** |

The window guardrail exists because of a second bug in the same family, and AMO **did** have this one
(24 Aug 2026). Year-over-year metrics compare the newest four quarters against the four behind them,
so they need eight — but the query window was 18 months, which returns five. The precondition was
unsatisfiable, so `netIncomeYoYPct` was `null` for every institution in every region from the day it
shipped, and the **NI YoY %** column rendered `—` everywhere. Nothing threw, and a column of
em-dashes is indistinguishable from an upstream FDIC gap, which is why it lasted.

Two things make it worth a permanent check. First, the fix is coupled: FDIC returns one row per
institution **per quarter** and caps a response at 10,000 rows sorted by assets descending, so
widening the window to 27 months without also raising the row limit would have cut the national
cohort from ~1,000 institutions to ~561 and pushed the asset floor from $1.07B to $2.23B — buying the
metric by quietly shrinking the screen. Second, the obvious width is wrong: `8 × 3 = 24` months
returns only seven quarters when today falls just after a quarter close, so the guardrail rejects 24
as well as 18. The window now lives in **`shared/fdic-window.ts`** as a contract imported by both the
server that builds the query and the client that slices quarters out of it.

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
alias configuration. Server code must import shared modules **relatively** (`../shared/…`), as
`server/fdic.ts` does. Worth confirming any new shared import actually landed in the bundle rather
than trusting `tsc`.

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

## 7. Current status — as of 24 Aug 2026

### 7.1 Overall

🟢 **Live and healthy.** Both counties flow end to end: index → images → extraction → normalization →
dashboard, county-scoped throughout. The Broward expansion, the major workstream since 6 Aug 2026,
completed on 10 Aug 2026.

### 7.2 Production data

| Scope | Filings | Clean transactions | Entities | Market transfers |
|---|---|---|---|---|
| Miami-Dade | 71,366 | 44,034 | 17,938 | 20,076 |
| **Broward** | **42,761** | **551** | **219** | **406** |
| **All** | **114,127** | **44,585** | **18,021** | **20,482** |

> ### ⚠️ Read this before comparing against any earlier report
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
| Miami-Dade collection (weekly cron) | 🟢 Live — but its **extract step ran keyless and silently did nothing on 14 & 21 Aug** (see §7.4 item −1); fixed 23 Aug, catch-up extraction run |
| AIT (Assignment of Interest) collection | 🔴 **Broken** — every AIT chunk timed out in both the 14 & 21 Aug weekly runs; 0 AIT rows collected since at least 14 Aug. AMO + ASG unaffected. Not yet investigated |
| Broward index + images + extraction (daily cron) | 🟢 Live — 42,559 index rows, 658 images, 589 extracted |
| PDF extraction — Miami-Dade | 🟢 Live — **repair backfill complete 17 Aug 2026**, 49,838 documents re-read |
| PDF extraction — Broward | 🟡 Live **daily**, but coverage thin — 589 of 42,559 documents |
| Facility batch backfill (20-min tick) | 🟢 Live |
| Nightly normalize + cache bust | 🟢 Live |
| County-aware server + client selector | 🟢 Deployed |
| Per-county document links | 🟢 Deployed |
| Endpoint county scoping | 🟢 Deployed — all document endpoints |
| Coverage-gap detection + banner | 🟢 Deployed 11 Aug 2026 |
| Collection-health warning (Broward) | 🟢 Reworked **and deployed** 24 Aug 2026 — per-run heartbeat (`broward_runs`) replaced the last-new-data metric, which false-alarmed every Monday. Split into "job stopped" vs "images at risk". Cron now polls at 15:30/19:30/23:30 UTC |
| County audit — all pages/endpoints | 🟢 Complete 11 Aug 2026 |
| Repo hygiene — WAL files untracked | 🟢 Resolved 11 Aug 2026 — droplet `git status` clean |
| Entity normalization / duplicate manager | 🟢 Deployed 6 Aug 2026 |
| FDIC analytics | 🟡 Live, **one fix pending deploy** (24 Aug 2026). Audited for the CET1/CRE direction inversion found in the sibling tool — **clean**; peer-ranking logic consolidated into `client/src/lib/peer-metrics.ts` behind a direction guardrail. A **real** bug was found and fixed: the 18-month query window could not satisfy the 8-quarter year-over-year comparison, so **NI YoY % was blank for every institution since it shipped** — window now 27 months and row limit raised together, verified live (0 → 990 of 1,215 national). National coverage remains asset-truncated by design (~1,113 of ~4,450; the tab now says so). Composite opportunity/earnings/vulnerability scores are still hardcoded to `0` and unused — AMO has no composite ranking |
| Deal Intelligence page | ⚫ **Retired 11 Aug 2026** — page and its 8 endpoints removed together |
| Automated backups | 🟢 **Live off-box 17 Aug 2026** — nightly verified snapshot → DigitalOcean Spaces (`amo-dashboard-backups-ec`, NYC3). Restore verified from the bucket copy |

### 7.4 Known gaps and open items

**−3. ✅ FIXED 24 Aug 2026 (pending deploy) — the FDIC "NI YoY %" column had never worked, and the
national screen is narrower than it looks.**

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

**8a. Backups are taken and verified, but not yet off-box.** As of 15 Aug 2026 `run_backup.sh` runs
nightly at 03:15, takes an online-API snapshot, integrity-checks it, asserts it is non-empty, gzips
it and keeps the last 7 locally. The DigitalOcean Spaces upload is written and tested, but
**dormant until a Space and access key exist** — the job reports `local_only` and the Overview shows
an amber banner while that is true. Local-only backups do not address the actual risk, which is loss
of the host. To activate, add to `/opt/amo-dashboard/.env`:

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
| A derived metric's input window cannot satisfy its own precondition | The field is `null` **forever**, renders as `—`, and is indistinguishable from missing upstream data. Cost AMO a permanently blank NI YoY column; cost the sibling tool a silently redistributed score weight | `script/check-fdic-window.ts` asserts the window yields enough published quarters, with 18mo and 24mo as negative controls. The window is a single shared constant (`shared/fdic-window.ts`) imported by both the query builder and its consumer, so the two cannot drift |
| A deploy silently fails | Production keeps running old code while checks look fine | `git pull` prints `Updating <old>..<new>` AFTER an abort — **verify by effect** (`git log --oneline -1` on the droplet, or grep `dist/index.cjs`), not by output. Bit us 11 Aug 2026 |
| PM2 restarted mid-normalize | Dashboard shows zeros for up to 7 days | Nightly wrapper restarts only on success; documented in `ROLLBACK.md` and here |
| A new writer forgets the `county` column | Rows **silently relabelled Miami-Dade**, no error anywhere | `check_county_isolation.py` asserts it — has already caught this three times |
| Two jobs writing `pdf_extractions` disagree on what "done" means | **50,042 documents silently never extracted**, every row reading `status='OK'` — happened 22 Jul–15 Aug 2026 | Pending work is now keyed on `raw_json IS NULL`, not row existence. **No automated check yet** — a guardrail asserting "every `status='OK'` row has `raw_json`" would have caught this on day one |
| Miami-Dade portal changes its markup | Collection stops | Failures surface in `collection_log` and the Collection Log page |
| Data changed without clearing the cache | Stale dashboard for up to 7 days | Nightly restart; `POST /api/cache/bust` |
| Single droplet, single SQLite file | Total loss on host failure | **Resolved 17 Aug 2026** — nightly verified snapshot to DigitalOcean Spaces (different failure domain from the droplet), 7 archives retained locally, all Broward images mirrored. Restore tested from the bucket copy, counts matched live exactly |
| Backups run but silently stop working | False confidence — the failure is only discovered when a restore is attempted | Every run records status in `backup_runs`. The Overview shows **red** when the job is absent, errored, or has not run in 48h, and **amber** when it is working but not reaching off-box storage. Snapshots are integrity-checked and row-count-asserted before they may rotate an older one away |
| Weak default password | Unauthorised access | `AMO_PASSWORD`/`AMO_SECRET` must be set in the production `.env` |

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

3. 🔑 **Create a DigitalOcean Space and give the key to the backup job.** The nightly job is built,
   tested and running as of 15 Aug 2026 — but it is copying to the same disk it is protecting until
   this is done, which does not address the risk it exists for. Create a Space, generate a Spaces
   access key, and add the six lines in §7.4 item 8a to `/opt/amo-dashboard/.env`. ~$5/month.
   The amber banner on the Overview clears once the first upload succeeds.
4. 📧 **Register an Azure app so the weekly emailed report can send** (§7.4 item 9). The app
   password was installed and the content approved, but DigitalOcean blocks outbound SMTP from the
   droplet, so that path cannot work regardless. The Graph transport is built and deployed; it needs
   an app registration on the `safeharborcp.com` tenant: Azure portal → App registrations → New
   registration; from **Overview** take the Directory (tenant) ID and Application (client) ID; from
   **Certificates & secrets** create a client secret and take its *value*; under **API permissions**
   add Microsoft Graph → **Application permissions** → `Mail.Send` (plus `User.Read.All` for the
   `--check` mailbox probe) and click **Grant admin consent**. Requires an M365 administrator.
   Add all three to `/opt/amo-dashboard/.env` as `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
   `GRAPH_CLIENT_SECRET` — never pass secrets through chat.
   **Recommended hardening:** app-only `Mail.Send` permits send-as for *every* mailbox in the
   tenant; scope it to the one sender with an Exchange `ApplicationAccessPolicy`.
   *Parallel option, if preferred:* a DigitalOcean support ticket asking them to lift the SMTP block
   (framed as one authenticated internal report per week) would revive the simpler SMTP path.

**Engineering:**

4a. **Owner-set priorities for the next working session (1 Sep 2026), not yet started.**
   (i) **Confirm full document coverage** — AMO, assignments of loans, assignments of collateral —
   starting with the fact that **AIT (Assignment of Interest) collection has been failing on
   portal timeouts since ~14 Aug 2026** (zero rows collected; AMO and ASG unaffected), then auditing
   the clerk's doc-type list against the three types we request.
   (ii) **Verify those documents classify correctly** (`doc_category`: LOAN_TRANSFER / COLLATERAL /
   RENTS_LEASES / OTHER), bearing in mind any extraction-prompt change must re-pass
   `verify_integration.py` at 21/21.
   (iii) **Exclude Wilmington Savings, MERS, Fannie Mae and Freddie Mac from the Reporting tab** as a
   display filter only — the underlying rows stay in the database. Needs a canonical-name exclusion
   list matching either side of a transaction; `entity_type` will not work, since Wilmington Savings
   is a `BANK` while the others are `GSE`/`MERS`.

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
| `GET /api/fdic/financials` | FDIC proxy |
| `GET /api/collection-log` | Pipeline health |
| `POST /api/cache/bust` · `GET /api/cache/stats` | Cache control |

Most read endpoints accept `?county=MIAMI-DADE|BROWARD` (omit for all counties; the server defaults
to Miami-Dade when no parameter is sent, and the client always sends one explicitly so the displayed
scope and the applied scope cannot drift).

### Data sources

| Source | Access | Notes |
|---|---|---|
| Miami-Dade Clerk Official Records | Web portal, automated via Playwright | Login required; 499-record server cap per query, handled by recursive chunk splitting |
| Broward County Records, Taxes & Treasury | Public SFTP `BCFTP.Broward.org:22` (`crpublic`/`crpublic`) | No login, no captcha, no scraping. Yearly exports 1978→last completed year (index only) + daily files with images (~10-day retention) |
| FDIC BankFind | Public REST API, proxied server-side | Bank financial fundamentals |
| OpenAI | `gpt-4.1-nano`, Chat Completions + Batch API | Document extraction and entity classification fallback |

### Internal documents

| File | Purpose |
|---|---|
| `SESSION_LOG.md` | Dense running history of every substantive change — **read first** |
| `ROLLBACK.md` | Revert paths for in-flight workstreams |
| `CLAUDE.md` | Operational facts, mirrored for Cursor at `.cursor/rules/amo-session-handoff.mdc` |
