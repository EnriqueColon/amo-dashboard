# AMO Dashboard — Session Log

Read this at the start of a session before re-deriving context. Most recent entry first. Keep entries dense (facts, not narrative) — this file exists to cut future token spend, so prune/compact old entries rather than letting it grow unbounded.

---

## 2026-07-20 (later session) — Credit Facilities tab DEPLOYED + reworked into relationship-grouped view

**Status: fully deployed and live in production.** Deploy revealed key operational fact: **Node server is PM2-managed, app name `amo-dashboard`** (see CLAUDE.md — deploy is `git pull` → `npm run build` → `pm2 restart amo-dashboard`). Discovered because a manual `kill` of the Node PID was instantly auto-restarted by PM2's daemon; there is no systemd unit or cron for the server.

### Deploy events
- `normalize.py` re-run on droplet: first attempt (plain foreground SSH) was **killed by a dropped SSH session ~23 min in, before any table writes** — restarted with `nohup ... & disown`, completed clean in that same hour. Result: `aom_events_clean` 49,886 rows; **`credit_facility_events` 82 rows, all with `rec_book`/`rec_page`** (backfill grew it from ~60 while deploy was pending). Any long-running one-off on the droplet needs nohup+disown.
- `normalize.py` progress can't be watched via row counts mid-run — it builds all inserts in Python memory and commits once at the end (table shows 0 the whole time). Process liveness (`ps`, CPU time climbing) is the only real signal.

### Tab reworked: flat filing list → relationship-grouped view (user request)
User's reaction to v1 (flat chronological filings): repeated lender↔borrower rows bury the story; "we want to see the relationship between the two." Rebuilt (commits `d8cc28b`, `396b5ac`, `18718a3`):
- **Table is now one row per lender↔borrower pair** (grouped `UPPER()` case-insensitively): lender, borrower, type badge, facility size (compact, full on hover), filing count, first→last activity range. Default sort: filings DESC, amount DESC.
- Row expands to **filing history** (new `GET /api/credit-facility-events/facilities` grouped + `GET /api/credit-facility-events/filings?lender=&borrower=` per-pair, keys are the UPPER'd names): per filing — date, CFN, doc type, recorded parties, **property address + underlying mortgage principal** (LEFT JOIN `pdf_extractions` for `loan_amount`/`property_address`), evidence quote, county-portal link. Agreement name/date/agent/credit-limit shown once in expansion header.
- **Key data insight surfaced during review:** `facility_amount` is the facility's *credit limit* quoted in boilerplate on every filing — NOT a per-transaction amount, must never be summed per row (v1's per-filing Amount column repeating $102.5M read as 6 separate transactions — replaced with underlying mortgage principal, the closest public proxy for per-transaction activity; actual draw amounts are never in county records).
- Old flat `GET /api/credit-facility-events` list endpoint still exists (unused by the UI now).

### Accuracy fixes after user reviewed production (commit `bbe5771` — pushed; **needs deploy**: user last deployed through `18718a3`, so `0e7287c` docs + `bbe5771` are pending a `git pull && npm run build && pm2 restart amo-dashboard`)
- **Banesco↔Winston Ban case study (user asked "are these duplicated?"):** 3 filings all showed Mortgage $20,000,000 = the facility's credit limit. Not duplicate records (distinct CFNs/dates/doc types; one direction reversed — bank→borrower vs borrower→bank). Root cause: when a blanket collateral assignment states no per-loan principal, the extractor stores the facility's credit limit as `loan_amount` (Property "—" on those rows is the tell). **Fix in `/api/credit-facility-events/filings`: `loan_amount` is nulled when it equals `facility_amount` AND `facility_amount_type = 'credit_limit'`.** The `note_principal` case (e.g. Bradesco: facility size taken FROM the note, so amounts legitimately coincide) is deliberately exempt — do NOT "simplify" the guard to plain equality.
- **`total_volume` chart stat deduped case-sensitively** — casing variants of the same facility double-counted its amount. Now dedupes on `DISTINCT UPPER(lender), UPPER(borrower), amount`.
- `facility_amount_type` values seen in DB: `credit_limit`, `note_principal`.

### Later same day: quote collapse + name-variant merge (commits `46744f2`, `101e518` — **pending deploy + one normalize.py re-run on droplet**)
- `46744f2`: filing-history rows are single lines; evidence quote hidden until the filing row is clicked (chevron next to portal link signals it). User found always-visible quotes "convoluted".
- `101e518`: **facility name-variant merging.** `normalize.py` gained `clean_facility_name()` (display: strip "Assignee ("/"Assignee:" role prefixes, hyphen→space, IIL→III OCR fix, `_FAC_ALIASES` exact-match table — currently GIDY→City National, BGI FINANCIAL LEC→LLC — add entries as production surfaces more) + `facility_name_key()` (aggressive punctuation-free UPPER grouping key) → new `lender_key`/`borrower_key` columns on `credit_facility_events`. Routes group/match on keys with `COALESCE(key, UPPER(name))` fallback so the tab keeps working before the re-run; `server/db.ts` has defensive ALTERs. Also: `facility_amount <= 1000` → NULL (the "$10 and other good and valuable consideration" deed recital, never a real facility) and role-only names (literal "Lender") → NULL. Verified locally: 4 relationship rows → 2, all 10 City National↔BGI filings under one row.
- **Deploy needs:** `git pull && npm run build && pm2 restart amo-dashboard` **then** re-run normalize on the droplet (`cd /opt/amo-dashboard/collector && source /opt/amo-dashboard/.env && nohup .venv/bin/python3 normalize.py > normalize.log 2>&1 &` + `disown`). Expected effect on prod's 66 rows: Vaster's 4 variants → 1 (10 filings), Amerant/Atlantis 3 → 1 (5 filings), "$10" facilities (U.S. Century ×2, Ocean Bank) lose junk amounts, "Lender"/GIDY rows merge or blank.
- **DONE (same evening):** normalize re-ran on droplet → `credit_facility_events: 86 rows (62 distinct lender/borrower pairs)`. **Gotcha discovered: the dashboard kept showing pre-rebuild data after the rebuild** — `server/cache.ts` caches API responses in-memory for 7 DAYS; a data rebuild does not invalidate it. Fix: `pm2 restart amo-dashboard` after any normalize run (or `POST /api/cache/bust`, auth-gated). Now documented in CLAUDE.md. Also: normalize's log is empty mid-run because Python buffers stdout to files — use `python3 -u` for live logs; process liveness via `ps` is the real signal.

### Open items / data-quality observations for next session
1. Possible same-deal rows that name-cleaning can't safely merge (need human judgment or smarter matching): AXOS ↔ "222 NORTH MIAMI LLC" vs AXOS ↔ "SCALE 3 222 NE LENDER LLC" (both $280M, Jan 26); City National ↔ "PAM" ($100M) vs ↔ "PRECEDENT ASSET MANAGEMENT- 4C, LLC"; the two lender-less rows ("— ↔ 222 NORTH MIAMI LLC", "— ↔ 50 NORTH MIAMI LLC").
2. Prior flags still open: `2026R268269` (possible false positive), `2026R277453` (lender was literal "Lender" — now blanked by cleaning, underlying extraction still unfixed).
3. Bigger extraction fix deferred: teach `FACILITY_SYSTEM_PROMPT` to distinguish facility credit limit from underlying loan principal instead of the server-side guard — touches the validated prompt, so it requires re-running `collector/research/scripts/verify_integration.py` at 21/21 first.
4. Widening/removing `--since 2026-01-16` in `run_facility_tick.sh` and a recurring `normalize.py` schedule remain undecided. User: "we still got some work to do" — more dashboard work expected next session.

---

## 2026-07-16 → 2026-07-20 — Warehouse/credit-facility feature: research → pipeline → production backfill → dashboard tab

**Status as of last message: production backfill is running (cron, on droplet), real results confirmed (~60 hits so far in a 6-month window). New "Credit Facilities" dashboard tab is built and verified locally but NOT YET DEPLOYED — deploy steps below.**

### The finding that drove everything
Literal "warehouse line of credit" wording essentially never appears in Miami-Dade recorded documents — real language varies every time ("Warehousing Loan and Security Agreement", a bare parenthetical "(Warehouse Agreement)", "Credit Agreement" + "as Agent for the Lenders", UCC "as Administrative Agent" chains). Keyword search reliably fails; only an LLM reading full document text catches it, and even then imperfectly (same exact facility phrased near-identically across two filings — one caught, one missed, in later testing). Confirmed via a real user-supplied example (`Collateral Assignment of Mortgage`, CFN `2024R432043`, BGI Financial LLC / City National Bank of Florida) → led to finding 13 related documents for that relationship, then a second (Bradesco Bank / Eastern Financial Mortgage Corp).

### Pilot → validated prompt
189-document pilot (`collector/research/scripts/extract_facility_pilot_v3.py`, gitignored/local-only) landed on a prompt scoring 10/13 known-positives, 0/6 known-negatives, 0/135 false positives on a random baseline. Repeated-grantor/grantee-pair heuristic alone has poor precision (1 real hit / 7 tested) — not used as a gate in the real pipeline. LLM cost is trivial (~$0.00024/doc measured), so the real pipeline scans every document rather than pre-filtering.

### Pipeline integration (`extract_pdfs.py`, `batch_extract_facility.py`, `normalize.py`)
- **Critical lesson (re-learn before touching this again):** merging facility detection into the existing `doc_category` LLM call broke detection completely (0/13, was 10/13 standalone) — root cause was dropping the `has_facility_language` boolean field and renaming JSON keys, an untested deviation from the validated prompt. **Facility detection is a second, fully separate LLM call** (`llm_extract_facility()` / `FACILITY_SYSTEM_PROMPT` in `extract_pdfs.py`), using the *exact* verbatim pilot prompt/field names — renaming into `facility_*`-prefixed DB columns happens only in `postprocess_facility()`, in code. **Do not edit `FACILITY_SYSTEM_PROMPT` or merge the two calls without re-running `collector/research/scripts/verify_integration.py` against the 21 known-labeled CFNs first (must score 21/21).**
- `pdf_extractions` gained 10 `facility_*` columns. `save_facility()` does a partial UPDATE so the batch path never clobbers doc_category/etc.
- `normalize.py` builds `credit_facility_events` (separate table, independent of `aom_events_clean`'s loan-transfer-only filter — confirmed zero impact on that filter). **Schema: `cfn, rec_date, doc_type, grantor, grantee, rec_book, rec_page, facility_type, facility_agreement_name, facility_agreement_date, facility_lender_name, facility_agent_name, facility_borrower_name, facility_amount, facility_amount_type, facility_evidence_quote, facility_confidence`** — note `rec_book`/`rec_page` were missing in the first version and had to be added (see "dashboard tab" section below).
- `batch_extract_facility.py` — bulk backfill via OpenAI's Batch API. Has manual 4-stage CLI (`--build`/`--submit`/`--poll`/`--ingest`) and automatic **`--tick`** mode (cron-driven): polls in-flight jobs, ingests finished ones, tops back up to `--max-concurrent` by submitting new chunks (newest `rec_date` first). State in `batch_jobs` + `batch_job_documents` tables (the latter exists to stop an in-flight chunk's CFNs from being re-selected into a second chunk before the first is ingested — was a real bug, same 5 CFNs got submitted 3x before the fix). Lock file prevents overlapping cron runs; stale `building` jobs >1h auto-fail so their CFNs free up.
- **Production droplet is a 1-vCPU/1GB box** — the original `DOWNLOAD_WORKERS=8` caused massive CPU contention (tesseract timeouts, ~8% failure rate) in the first real cron run. Fixed: worker count now derives from `os.cpu_count()` (capped at 4, override via `--workers`/`DOWNLOAD_WORKERS` env), chunk size reduced 3000→500, OCR subprocess timeout 120s→180s. **If this ever moves to a bigger box, these defaults can go back up.**
- **`--since YYYY-MM-DD` flag** added to scope a backfill to a recent date range (e.g. for a deadline) without touching any data/state — just filters which documents count as "pending." Currently **`run_facility_tick.sh` passes `--since 2026-01-16`** (~6 months back) because of a presentation deadline. **To resume full history, just delete that flag from `collector/run_facility_tick.sh`, commit, push, `git pull` on the droplet — no other state needs to change.**

### Production state (confirmed via droplet SSH by user)
- Cron entry live: `*/20 * * * * /opt/amo-dashboard/collector/run_facility_tick.sh >> /opt/amo-dashboard/collector/batch/tick.log 2>&1`
- As of last check: 6-month backlog was ~9,300 documents, all but 2 processed (batches of ~500 running every few hours via the Batch API, ~200+ docs/hour observed real throughput).
- **~60 confirmed real hits found.** Notable recurring institutional relationships (same facility, multiple filings as loans get pledged/released):
  - City National Bank of Florida ↔ Vaster Loans III, LLC — $102.5M, 7 filings
  - Amerant Bank ↔ Atlantis Holdings AM LLC — $15M, 3 filings
  - Banesco USA ↔ Winston Ban, LLC — $20M, 3 filings
  - INTER US FINANCE, LLC ↔ BGT Real Estate Opportunity Fund Ltd. — $1.98M, 3 filings
  - Bradesco Bank ↔ Jared Larsen/JLCFI (the original hand-found 2016 facility) — 3 filings
  - Plus large one-offs: JPMorgan + 6-bank syndicate on an ESA hotel portfolio ($1.935B), Bank Hapoalim → S3 RE North Bay ($200M), WSFB Lender II → Parakeet Property Owner II ($183.8M).
  - ~9 of the 60 are Amerant Bank **consumer HELOCs** (individual homeowners) — real "revolving line of credit" language but not institutional, kept distinguishable via `facility_type = consumer_or_business_line_of_credit`.
- "Facility Size" caveat: when a facility recurs across filings, don't sum `facility_amount` per row (it's the same facility cited repeatedly, not separate loans) — the dashboard's total-volume stat already dedupes on `(lender, borrower, amount)`.

### New: "Credit Facilities" dashboard tab (built + verified locally, NOT deployed)
`client/src/pages/CreditFacilities.tsx` (new) + `GET /api/credit-facility-events` and `GET /api/credit-facility-events/chart?type=monthly|top_lenders|by_facility_type|total_volume` (new, in `server/routes.ts`, mirroring `/api/clean-events` and `/api/reporting/chart` patterns) + nav wiring in `App.tsx`/`Sidebar.tsx`. Shows summary stats, a monthly filing-activity chart, top-lenders ranking, and a filterable/paginated table with click-to-expand evidence quotes and county-portal links.

**Three real bugs found and fixed while verifying in-browser** (local dev server, `.claude/launch.json` created at the *parent* dir `/Users/enrique/Downloads/amo-dashboard-source/.claude/launch.json`, not inside `amo-dashboard/` — the preview tool looks for it at cwd, which is the parent):
1. `credit_facility_events` never had `rec_book`/`rec_page` (needed for the county-portal link) — added to both `normalize.py`'s schema/INSERT and `server/db.ts`'s defensive `CREATE TABLE IF NOT EXISTS`.
2. Top-lenders grouping was case-sensitive, splitting the same real lender into duplicate rows ("City National Bank of Florida" vs the all-caps OCR'd form) — now groups on `UPPER(facility_lender_name)`.
3. Row-expand (evidence quote) silently did nothing — a shorthand `<>...</>` fragment was used as the `.map()` return value, which can't carry a `key` prop, breaking React's reconciliation. Fixed with `<Fragment key={r.cfn}>`.

Also learned: `tsx server/index.ts` (this project's dev command) does **not** hot-reload server-side TS changes — must fully stop/restart the preview server after editing `server/*.ts`, unlike client `.tsx` changes which Vite HMRs automatically.

**Not yet deployed** — needs, on the droplet: `git pull`, `npm run build`, restart Node, **and re-run `normalize.py` once** so `credit_facility_events` picks up the new `rec_book`/`rec_page` columns (`cd collector && source /opt/amo-dashboard/.env && .venv/bin/python3 normalize.py`). Local dev DB only had 11 rows when the tab was tested (lags production, as usual) — production will show the full ~60+ and growing.

### Next steps for a future session
1. Deploy the dashboard tab (steps above).
2. Keep letting the cron backfill run; consider widening/removing `--since` in `run_facility_tick.sh` once the presentation deadline has passed, to backfill full history (~51,700 docs total, was estimated ~4-8 days at observed throughput before scoping to 6 months).
3. `normalize.py` isn't on a cron itself — needs periodic manual re-runs (or a second, less-frequent cron entry) to keep `credit_facility_events` fresh with newly-ingested batches.
4. Two rows worth a manual sanity check (flagged, not yet resolved): `2026R268269` (JPMorgan/KB7 Holdings — evidence quote reads like a routine SBA note renewal, possibly a false positive) and `2026R277453` (grantor extracted as literal string "Lender", likely an OCR gap).
5. Known lingering repo-hygiene item, deliberately not touched (risk to live production DB): `miami_dade_amo.db-shm`/`-wal` are tracked in git from before `*.db-shm`/`*.db-wal` were added to `.gitignore` — untracking them (`git rm --cached`) should be done deliberately/separately, not blindly, since it interacts with `git pull` against the live production database file.

---
