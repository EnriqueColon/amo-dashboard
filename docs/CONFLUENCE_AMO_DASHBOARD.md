# AMO Tracker — Mortgage Assignment Intelligence Dashboard

> **Status:** Live in production · **Owner:** Enrique C. · **Last reviewed:** 11 Aug 2026
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
| **Data volume** | ~113,000 recorded filings, ~20,400 resolved entities |
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
- **Export to CSV** for the current filter set.
- **Entity report:** a per-company written summary of activity.

#### Targets (`/targets`)
Your watchlist of market participants. Search the canonical entity list, add a firm, and the page
tracks its filing activity. Each row links straight through to that firm's filings in Reporting.
Seeded in bulk from `collector/targets_seed.csv`.

#### FDIC Data Analytics (`/market-analytics`)
Bank fundamentals pulled live from the FDIC API, proxied through the server. CRE concentration,
construction/multifamily/non-residential loan mix, NPL and noncurrent ratios, ROA/ROE, efficiency,
capital. Includes a **cohort summary** and a **target screening list** — used to spot banks under
balance-sheet pressure whose filing behaviour is worth watching.

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
| `30 12 * * *` | `run_broward_daily.sh` (`BROWARD_INGEST_INDEX=1`) | Broward index → images → retention report. **Time-critical.** |
| `0 6 * * 5` | `run_weekly.sh` | Miami-Dade: collect last 10 days → extract PDFs → normalize → enrich. |

#### Two things about these jobs that must not be forgotten

**1. Broward images are on an unforgiving clock.**
The SFTP feed retains only ~10 days of daily image zips. The yearly exports are **index only**. A day
whose images age out is **permanently unrecoverable** from the free channel — recovering it
afterwards means scraping the AcclaimWeb portal one document at a time, behind a disclaimer gate,
session state and Cloudflare bot management. Treat any `PENDING` day in the retention report as an
active incident. The ~10-day window means several consecutive failures are still recoverable; a
fortnight of silence is not.

**2. Never restart PM2 while `normalize.py` is running.**
`aom_events_clean` is dropped at the start of the run and reads **zero rows** until a single commit at
the very end. Restarting inside that window clears the 7-day cache and immediately re-caches the
*empty* state — leaving Clean Transactions, Reporting and Lending Relationships showing zeros for up
to a week. This is exactly why `run_nightly_normalize.sh` restarts only *after* a successful run.
A long silent stretch during `Building aom_events_clean...` is normal, not a hang.

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
| `diff_name_systems.py`, `show_merge_proposals.py` | Diagnostics for reviewing name-matching decisions |

`check_county_isolation.py` exists because the same bug has now been caught **three separate times**:
a writer that forgot to carry the `county` column. It is asserted rather than trusted for that reason.

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

**`client/src/pages/DealIntelligence.tsx` is not routed** in `App.tsx`, though its
`/api/deal-intelligence/*` endpoints are live and maintained. Treat it as dormant — either wire it
back into the nav or retire both sides; do not assume it is reachable.

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

## 7. Current status — as of 11 Aug 2026

### 7.1 Overall

🟢 **Live and healthy.** Both counties flow end to end: index → images → extraction → normalization →
dashboard, county-scoped throughout. The Broward expansion, the major workstream since 6 Aug 2026,
completed on 10 Aug 2026.

### 7.2 Production data

| Scope | Filings | Clean transactions | Entities | Market transfers | Date range |
|---|---|---|---|---|---|
| Miami-Dade | 70,834 | 51,425 | 20,320 | 24,360 | 3 Jan 2023 → 6 Aug 2026 |
| **Broward** | **42,559** | **374** | **157** | **280** | 3 Jan 2023 → 5 Aug 2026 |
| **All** | **113,393** | **51,799** | **20,367** | **24,640** | 3 Jan 2023 → 6 Aug 2026 |

Verified after the flip: Miami-Dade's clean count is **identical** to the pre-flip baseline — Broward
added rows without disturbing existing data. County isolation guardrail green; all 37 checked
endpoints healthy across all three county scopes.

### 7.3 Component status

| Component | Status |
|---|---|
| Miami-Dade collection (weekly cron) | 🟢 Live |
| Broward index + images + extraction (daily cron) | 🟢 Live — 42,559 index rows, 658 images, 589 extracted |
| PDF extraction — Miami-Dade | 🟢 Live |
| PDF extraction — Broward | 🟡 Live **daily**, but coverage thin — 589 of 42,559 documents |
| Facility batch backfill (20-min tick) | 🟢 Live |
| Nightly normalize + cache bust | 🟢 Live |
| County-aware server + client selector | 🟢 Deployed |
| Per-county document links | 🟢 Deployed |
| Endpoint county scoping | 🟢 Deployed — all document endpoints |
| Coverage-gap detection + banner | 🟢 Deployed 11 Aug 2026 |
| Collection-health warning (Broward) | 🟢 Deployed 11 Aug 2026 |
| County audit — all pages/endpoints | 🟢 Complete 11 Aug 2026 |
| Entity normalization / duplicate manager | 🟢 Deployed 6 Aug 2026 |
| FDIC analytics | 🟢 Live |
| Deal Intelligence page | ⚪ Dormant — endpoints live, page not routed |

### 7.4 Known gaps and open items

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

**3. Cron failures on the droplet are silent** — no `MAILTO`, no mail transport installed. Mitigated
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

**7. Two facility rows flagged for manual sanity check:** `2026R268269` (JPMorgan/KB7 Holdings — the
evidence quote reads like a routine SBA note renewal, possibly a false positive) and `2026R277453`
(grantor extracted as the literal string `"Lender"`, likely an OCR gap).

**8. `DealIntelligence.tsx` is unrouted** while its endpoints remain live and maintained — decide
whether to wire it back in or retire both sides.

### 7.5 Risk register

| Risk | Impact | Mitigation in place |
|---|---|---|
| Broward image feed missed for >10 days | **Permanent, unrecoverable data loss** | Daily cron + retention report printed every run; ~10-day buffer absorbs several consecutive failures |
| PM2 restarted mid-normalize | Dashboard shows zeros for up to 7 days | Nightly wrapper restarts only on success; documented in `ROLLBACK.md` and here |
| A new writer forgets the `county` column | Rows **silently relabelled Miami-Dade**, no error anywhere | `check_county_isolation.py` asserts it — has already caught this three times |
| Miami-Dade portal changes its markup | Collection stops | Failures surface in `collection_log` and the Collection Log page |
| Data changed without clearing the cache | Stale dashboard for up to 7 days | Nightly restart; `POST /api/cache/bust` |
| Single droplet, single SQLite file | Total loss on host failure | Manual `.backup` before every data change; **no automated off-box backup — see below** |
| Weak default password | Unauthorised access | `AMO_PASSWORD`/`AMO_SECRET` must be set in the production `.env` |

### 7.6 Recommended next steps

1. **Set up automated off-box database backups.** Backups today are taken by hand before risky
   changes. The whole dataset — including tens of thousands of dollars' worth of irreplaceable
   OCR/LLM extraction work and the Broward images that cannot be re-harvested — lives on one droplet
   with no scheduled off-host copy. This is the highest-value maintenance item on the list.
2. **Decide the Broward history strategy** — history scraper vs. bulk export request vs. wait for
   CY2026. Every day of delay is more permanently-lost image days.
3. **Confirm `AMO_PASSWORD` and `AMO_SECRET` are set** in the production environment.
4. Clean up the residual Miami-Dade copy and resolve the `DealIntelligence` page.
5. Consider adding basic uptime/cron-failure alerting — today, a silently failing cron is only
   noticed by looking at the Collection Log.

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
