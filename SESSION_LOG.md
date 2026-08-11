# AMO Dashboard — Session Log

Read this at the start of a session before re-deriving context. Most recent entry first. Keep entries dense (facts, not narrative) — this file exists to cut future token spend, so prune/compact old entries rather than letting it grow unbounded.

---

## 2026-08-11 — SQLite WAL files UNTRACKED. Droplet git status is finally clean.

Open since 2026-07-16 and the direct cause of today's silent deploy failure. Done properly, with
the procedure rehearsed first.

### Why it needed care
`miami_dade_amo.db-wal` on the droplet was **72MB** — transactions not yet folded into the main
database. A careless `git rm` letting git delete that file would have discarded them. The main DB
is live: PM2 serving, crons writing.

### Rehearsed in a scratch repo before touching production
Built a throwaway origin + two clones reproducing the exact setup (WAL tracked from before the
gitignore rule, one clone with it locally modified like the droplet):

- **Naive pull** → aborted exactly as production did, *including the misleading
  `Updating <old>..<new>` line printing LAST, after the error.* Reproduced the trap precisely.
- **`git rm --cached` on the droplet FIRST, then pull** → fast-forwards cleanly, working tree
  clean, and **the live WAL file on disk untouched**.

### Applied
1. Local: `git rm --cached` both files → commit → push (`cc108bd`). Index only; working files kept.
2. Droplet: **`git rm --cached` first**, then `git pull --ff-only`.

Verified after: `PRAGMA integrity_check` = ok, `assignments` 113,393 / `aom_events_clean` 51,799
unchanged, app serving, **WAL still 72,602,672 bytes — byte-for-byte untouched**, files no longer
tracked, and `git pull` reports "Already up to date".

No downtime. PM2 never stopped; no checkpoint needed, because the procedure never lets git touch
the file.

### Also: `.gitignore` generalised
`collector/*.log` (was three individual entries) and `ecosystem.config.cjs` (lives on the droplet
and holds the dashboard password — must never be committed).

**The droplet's `git status` is now completely clean — 0 changes.** That is the real win: a noisy
status is how a genuine problem hides, and today it hid a blocked deploy for hours.

---

## 2026-08-11 — Deal Intelligence RETIRED (page + endpoints). Plus a deploy that silently failed.

User decision: not in use, retire it. Removed **both sides together** — deleting the page alone
would have left 8 orphaned endpoints still needing county-correctness forever.

### Removed
- `client/src/pages/DealIntelligence.tsx` (1,211 lines)
- A contiguous **461-line block** in `routes.ts`: `SPECIAL_SERVICERS`, `specialSvcPlaceholders`,
  `diStmts`, `shiftOneYearBack`, `parseDateRange`, `diCountsForPeriod`, and all 8 endpoints.
- Two stale `clearCacheByPrefix('/api/deal-intelligence')` calls in the merge cache-busting helpers.

**Checked before deleting:** none of those symbols were referenced outside the block.
`TARGETS_MATCH` sits right after it and looks similar but is **shared with the reporting
endpoints** — it stays. 40 endpoints → 32.

Verified: tsc clean, 30 endpoints healthy × 3 scopes, every page still renders, retired endpoints
now fall through to the SPA catch-all and serve no data.

### 🚨 The deploy silently failed the first time — read this before trusting a deploy again
`git pull --ff-only` on the droplet printed `Updating d31d02a..9a2932d` and **aborted**:

    error: Your local changes to the following files would be overwritten by merge:
        miami_dade_amo.db-shm
        miami_dade_amo.db-wal

**Cause, and it was mine:** `git add -u` in the retirement commit swept in the deletion of those
two tracked WAL files. SESSION_LOG has flagged them since 2026-07-16 as deliberately untouched
*precisely because they interact with `git pull` against the live production DB.* The droplet's
copies are live and constantly modified, so an incoming deletion makes the pull abort.

**Why I did not notice:** the deploy command ended with `git pull ... | tail -2`, and git prints
the reassuring `Updating <old>..<new>` line AFTER the error. The last two lines looked like
success. Production kept serving Deal Intelligence data from the old bundle while every subsequent
check appeared fine.

**Two lasting lessons:**
1. **Never `git add -u` in this repo** — stage files explicitly. The tracked WAL files will be
   swept in and will break the next droplet pull.
2. **Verify a deploy by its effect, not its output.** `git log --oneline -1` on the droplet, or
   grepping `dist/index.cjs`, is the check. The commit that finally proved it: bundle
   occurrences of `deal-intelligence` went 8 → 0.

Fixed by restoring both files in `302b808`, after which the pull fast-forwarded normally.

**Still open (pre-existing):** those WAL files remain tracked. Untracking them properly
(`git rm --cached` + gitignore) has to handle the droplet side too, or it reproduces this exact
failure. Deliberate, separate change.

---

## 2026-08-11 — DealIntelligence: facts gathered, DECISION STILL OPEN (do not act without the user)

User asked to discuss before retiring. Nothing changed in code. Facts, so the next session does not
re-derive them:

### Current state
- **Not routed** — absent from `client/src/App.tsx` and from the `Sidebar.tsx` nav. A user cannot
  reach it; `#/deal-intelligence` falls through to NotFound.
- **Not shipped** — `App.tsx` never imports it, so Vite tree-shakes all 1,211 lines out of the
  bundle. Zero cost to end users, zero page weight.
- **8 live server endpoints** it alone consumes: `summary`, `seller-pressure`, `pe-competitive`,
  `special-servicers`, `bank-to-pe`, `monthly`, `recent-bank-to-pe`, `deal-detail/:cfn`. Nothing
  else in the client references them.
- **History:** added in `197e947` ("Deal Intelligence tab for distressed CRE PE sourcing"), then
  un-routed by `3b1674a` ("add Reporting tab, remove Market Relationships"). It was **deliberately
  replaced**, not abandoned by accident.

### The real cost — maintenance drag on an unverifiable page
It has been dragged through **every** cross-cutting change of the Broward work: per-county document
links (`715c003`), cross-county entity labelling (`c6868dc`), county scoping of four of its
endpoints, and the copy sweep (`d31d02a`). Three of the last six commits touched it.

**The sharp version of the problem: those fixes are UNVERIFIED.** Because the page cannot be
opened, none of its county behaviour was checked in a browser — unlike every other page, which was.
It is currently the worst of both worlds: paying full maintenance cost, delivering no user value,
and with no way to notice if a change broke it.

### The decision is a product question, not a technical one
**Does distressed-CRE-PE sourcing still matter as a use case?** Its analysis (seller pressure,
PE competitive map, bank→PE deal log) overlaps Private Credit and Reporting but is not identical —
it is framed around sourcing rather than reporting.

- **If yes → ROUTE IT** (two lines: an `App.tsx` route and a `Sidebar.tsx` nav entry), then verify
  its county behaviour in the browser like every other page. Keeping it unrouted is the one option
  with no upside.
- **If no → retire both sides** — delete the page and its 8 endpoints together. Deleting the page
  alone would leave 8 orphaned endpoints that still need county-correctness forever.

**Do not half-do it.** The current state is the failure mode.

---

## 2026-08-11 (last) — Full county audit across the tool. Found and fixed a real leak.

Swept **every endpoint × all three scopes** and compared counts. Most were correct. One was not.

### 🚨 `/api/private-credit` was not scoped — Broward showed Miami-Dade's data
It returned an identical **4,081 for Miami-Dade, Broward AND All**. It reads `aom_events_clean`,
so it is document-level and should scope. Broward was displaying 4,081 Miami-Dade transactions
under its own heading. Now: **4,067 / 14 / 4,081**.

**Why the earlier audit missed it:** that audit classified routes by scanning each route *body* for
table names. `privateCreditTotal` / `privateCreditRows` / `privateCreditTopGrantees` are defined in
the shared `stmts` block at the top of the file, so the route body mentions neither table. **Any
future audit of this kind has to follow the prepared statements, not just the route bodies.**

Pagination there moved from positional `?` to named `:limit`/`:offset` — better-sqlite3 refuses to
mix the two styles and the county predicate is named.

### Legitimately unscoped, confirmed not bugs
`/api/entity-nodes`, `/api/entities`, `/api/targets`, `/api/top-assignors`,
`/api/reporting/participants` — all read the entity tables, which carry no county by design. They
are labelled "not filtered by county" in the UI (option 2, 2026-08-08).

### Hardcoded county copy removed — 0 remaining
Two kinds, treated differently:
- **Headers that ASSERT a county** → dynamic: the Reporting subtitle and **both printed
  `EntityReport` titles**. A printed report asserting the wrong county is the worst version of this
  bug, because it leaves the building.
- **Descriptive tooltip copy** → county-neutral ("Miami-Dade Clerk" → "county Clerk"), since it
  describes concepts true of both counties.

19 replacements across `EntityDetailPanel`, `Entities`, `Assignments`, `CleanEvents`,
`MarketRelationships`, plus 8 in `CleanEvents`/`DealIntelligence`. Verified 0 stray mentions on
every page under Broward — the only remaining "Miami-Dade" in the DOM is the county selector's own
`<option>`, which is correct.

### Verified
All 37 endpoints healthy × 3 scopes; tsc clean; Private Credit under Broward renders 14 real
Broward rows with Broward instrument numbers and Broward-specific acquirers.

---

## 2026-08-11 (later still) — Forward-path hardening. Silent cron failure was the real risk.

User's direction: stop trying to recover Broward history, make the forward path as good as
possible. Audited what could quietly undermine it.

### 🚨 The finding — cron failures are completely silent
No `MAILTO` in the crontab and **no mail transport installed** on the droplet. If
`run_broward_daily.sh` starts failing, nothing tells anyone. Combined with the feed's ~10-day
retention, a job that stops on a Monday costs images permanently by the following week.

### Built
`/api/stats` returns `collection_health`; the Overview shows a red banner when no images have been
harvested for **over 48 hours**.

**The signal is `MAX(harvested_at)` from `broward_images`, NOT the newest filing date.** Broward
publishes ~3 business days behind, so the newest `rec_date` is always several days old even when
the pipeline is perfectly healthy — it would be useless as liveness. `harvested_at` measures OUR
job, not the county's schedule. 48h = one missed run is a blip, two is a pattern, and it leaves a
week of headroom before the feed drops anything.

`server/db.ts` now declares `broward_images` defensively. It is created by the Python harvester, so
without that the new prepared statement throws on a database the harvester has never touched and
takes the whole app down at boot.

Verified both states against the production snapshot: 3 hours → healthy, simulated 5-day outage →
banner. Live reading after deploy: `hours_since=21, stale=False`.

**Still not solved:** the banner only helps someone who opens the dashboard. Real alerting
(email/webhook/uptime ping) is not configured.

### Also checked
Broward facility detection runs on every extracted document (589 of 589 have `facility_type` set)
but has found **0 real facilities**. Miami-Dade's rate (445 of 70,834, ~0.6%) predicts ~3–4 at this
sample size, so this is plausible rather than broken — worth re-checking as the count grows.

---

## 2026-08-11 (later) — Coverage gaps now surfaced. Broward's 6-month hole is visible.

### The finding
Broward's reported range is `2023-01-03 → 2026-08-05`, which reads as continuous. It is not —
**Jan–Jun 2026 is entirely absent** (~7,000–8,000 filings):

    2025-11    984
    2025-12  1,080
    2026-07    416   ← nothing in between
    2026-08    173

This is not unenriched data; those filings are not in the database at all. On the monthly chart it
renders as a flat zero, indistinguishable from the market stopping. That is the failure mode worth
preventing: a silent hole produces a confident wrong answer.

### Built
- `/api/stats` returns `coverage_gaps` — runs of whole months with no filings between a county's
  first and last. **Whole months only**, so weekends, holidays and quiet days never trigger it.
- Computed per county, filtered to the selected scope. On ALL every gap is reported and labelled,
  because an aggregate range can be continuous while one county has a hole in the middle.
- Dashboard banner in **red, not amber** — deliberately distinct from the "indexed but not
  extracted" notice, because missing data and pending data are different problems.
- `findCoverageGaps()` uses `Map.forEach` rather than `for..of`: the build targets a TS lib without
  `downlevelIteration`, so iterating a Map directly does not compile.

### Verified live
    MIAMI-DADE   gaps=none
    BROWARD      gaps=2026-01..2026-06 (6mo)
    ALL          gaps=BROWARD 2026-01..2026-06 (6mo)

---

## 2026-08-11 — History scraper INVESTIGATED and REJECTED. Forward-only, with daily extraction.

### The portal is Cloudflare-gated — a scraper is not viable
Measured, not assumed:

| client | result |
|---|---|
| bare `curl` | 403 |
| `curl` + browser user agent | 403 |
| `curl` + full browser headers | 403, Cloudflare block page |
| from the droplet (datacenter IP) | 403, Cloudflare block page |

Only a real browser that executes the JS challenge gets through. **An earlier estimate of ~20
hours for a 2025-only scrape was wrong** — it assumed a scriptable request loop, which does not
exist here. The only route would be a full browser passing the challenge from a datacenter IP,
issuing sustained automated traffic for 13,674 documents, i.e. actively defeating the bot
protection. Not built, deliberately.

Also mapped, for the record: images ARE keyed by an internal `docId` obtainable from the results
grid (instrument `120246627` → docId `55949519`), but the viewer reads
`window.opener.$('#RsltsGrid').data('tGrid')`, so direct navigation to `/Details/` is inert. Every
document needs a real browser with the opener chain: search → grid → popup → image.

### Decision — forward-only enrichment, bulk order later
User's call: accept forward-only for now, and phone 954-831-4000 for a historical bulk image order
at a later date. **History is not missing, only unenriched** — all 42,559 Broward filings from
2023-01-03 are indexed and live (parties, dates, doc types, instruments). What 2023–2025 lacks is
what comes from reading documents: entity classification, transaction types, facilities, amounts.

### Gap found and closed while confirming this
The daily script harvested images but **never extracted them** — extraction only ran in
`run_weekly.sh` (Friday 06:00), so a Monday document waited up to six days, plus a night for
normalize. Tolerable when history was the plan; not when the forward path IS the enrichment story.

`run_broward_daily.sh` now runs `extract_pdfs.py --county BROWARD --limit 300 --budget 1.00` after
harvesting, and **sources `/opt/amo-dashboard/.env`** — cron starts with a bare environment, so
without that `OPENAI_API_KEY` is absent and extraction would silently skip. Scoped to BROWARD so it
can never consume the Miami-Dade budget. ~$0.03/day.

Verified under `env -i`: index → images → extraction → retention report, exit 0. Broward
extractions **589 of 658 images**; the 69-image gap is exactly the orphaned 2026-07-21 batch,
harvested before its index rows were ingested, so those have no `assignments` row to extract
against.

### Steady state
    daily 12:30 UTC  index + images + extraction   (run_broward_daily.sh)
    nightly 08:30    normalize + cache bust        (~80 min at current scale)
    weekly Fri 06:00 Miami-Dade extraction         (run_weekly.sh)

Broward's analysed window grows ~55 documents/day on its own.

---

## 2026-08-10 — 🎉 BROWARD IS LIVE. Flip deployed, normalize run, cache cleared, verified.

The expansion is functionally complete: Broward now flows index → images → extraction →
normalization → dashboard, county-scoped end to end.

### Live production, after `pm2 restart`
| scope | filings | clean | entities | market transfers | range |
|---|---|---|---|---|---|
| Miami-Dade | 70,834 | 51,425 | 20,320 | 24,360 | 2023-01-03 → 2026-08-06 |
| **Broward** | **42,559** | **374** | **157** | **280** | 2023-01-03 → 2026-08-05 |
| All | 113,393 | 51,799 | 20,367 | 24,640 | 2023-01-03 → 2026-08-06 |

**Miami-Dade `clean` is 51,425 — identical to the pre-flip baseline.** Every figure matched the
rehearsal exactly. County isolation guardrail green; all 37 endpoints healthy × 3 scopes. Real
Broward rows render, e.g. `121023599  2026-08-04  MERS → PLANET HOME LENDING`.

### Timing — correcting a stale figure
The log has long claimed "~15 minutes" for a full `normalize.py` run. **The real figure at current
scale is ~80 minutes on the droplet** (113,396 raw rows). Local, same code and data, took 19m46s —
the droplet runs roughly 2.3× slower on this single-threaded Python loop. Plan maintenance windows
against 80 minutes, not 15.

### Do NOT restart PM2 mid-run
`aom_events_clean` reads **0 rows** for the entire build — the table is dropped up front and every
insert is committed once at the end. Restarting during that window would clear the 7-day cache and
immediately re-cache the empty state, leaving Clean Transactions, Reporting and Deal Intelligence
showing zeros for up to a week. This is why `run_nightly_normalize.sh` restarts *after* normalize
and skips the restart entirely if it fails.

---

## 2026-08-10 — county-column bug FIXED; NORMALIZE_COUNTIES flipped to include Broward.

### The fix
`aom_events_clean` and `credit_facility_events` now DECLARE `county` in their CREATE and populate
it. In `aom_events_clean`'s source query the column is appended **LAST** on purpose — those rows
are unpacked by positional index (`entries[0][8]` etc.), so inserting it earlier would silently
shift every one. `credit_facility_events` also picked up the county scope filter its sibling
already had.

`check_county_isolation.py` now **fails** when either rebuilt table lacks the column instead of
skipping. This trap has caught three separate writers (`log_collection`, `save()` in
`extract_pdfs`, both rebuild statements), so it is asserted rather than trusted.

### Rehearsal on a fresh production snapshot — the fix works
- `county` present on both rebuilt tables
- `aom_events_clean`: **374 BROWARD + 51,425 MIAMI-DADE** — Miami-Dade unchanged, and 374 exactly
  matches the Broward LOAN_TRANSFER extraction count
- **0** rows mislabelled; county isolation guardrail green

### The flip
`NORMALIZE_COUNTIES` default is now `('MIAMI-DADE', 'BROWARD')`, still env-overridable so a future
county can be rehearsed the same way. Deployed with a pre-flip backup at
`/opt/amo-dashboard/backup_pre_broward_normalize.db` (131MB, integrity-checked). Pre-flip baseline:
`51,425 clean / 20,320 nodes / 445 facility`. Ran manually rather than waiting for the 08:30 UTC
cron, so it landed under supervision.

### Two traps hit again this session — both already documented, both still caught me
1. **`pgrep -f "normalize.py"` matches the watcher's own command line.** SESSION_LOG has warned
   about this since 2026-08-06. Use `ps -eo pid,cmd | grep "[n]ormalize.py" | grep -v "bash -c"`.
   (The bracket form *does* work with pgrep; the failure was reading its result as authoritative.)
2. **`ps -eo cmd` is not valid on macOS** — it errors with "keyword not found", and a
   `|| echo "not running"` fallback then reports the process as dead. It was very much alive at
   98% CPU. On macOS use `ps aux | grep`. I asserted normalize had finished when it had not.

Also: a long silent stretch during `Building aom_events_clean...` is **normal**, not a hang — all
inserts are built in Python memory and committed once at the end.

### Feed status
Broward publishes ~3 business days behind. `2026-08-05` (50 documents) appeared after the 12:30 UTC
cron and was harvested manually; the next cron would have caught it well inside the 10-day window.
Index now **42,559**, images **658**.

---

## 2026-08-08 — Drift rehearsal WITH extractions. Result good, but found a BLOCKER.

Ran `normalize.py` with `NORMALIZE_COUNTIES="MIAMI-DADE,BROWARD"` against a fresh production
snapshot (70,834 MD + 42,509 Broward assignments, 539 Broward extractions of which 374
LOAN_TRANSFER).

### 🚨 BLOCKER — `normalize.py` DROPS the county column from `aom_events_clean`
After the run, `PRAGMA table_info(aom_events_clean)` has **no county column**. normalize.py
recreates the table and its CREATE does not include it.

**Why this is dangerous rather than merely broken:** `server/db.ts`'s defensive migration re-adds
the column on the next startup and backfills `WHERE county IS NULL` to `'MIAMI-DADE'`. So all 374
Broward rows would be silently relabelled Miami-Dade, and every county-scoped endpoint would serve
Broward data under a Miami-Dade filter — with no error anywhere. This is the third instance of the
same trap (`log_collection`, `pdf_extractions.save`, now here).

**Fix before flipping `NORMALIZE_COUNTIES`:** add `county` to the `aom_events_clean` CREATE and
carry `a.county` through the INSERT. Same check needed for `credit_facility_events`.

### The drift itself is small and sensible
| | before | after | delta |
|---|---|---|---|
| `aom_events_clean` | 51,425 | 51,799 | **+374 — exactly the Broward LOAN_TRANSFER count** |
| `entity_nodes` | 20,320 | 20,367 | +47 new entities |
| `entity_classifications` | 22,408 | 22,455 | +47 new |
| existing entities, volume changed | — | — | **110 of 20,320 (0.5%)** |
| existing entities, type changed | — | — | **1** |

Biggest movers are exactly the cross-county names expected: MERS +178, US BANK +86,
NEWREZ/SHELLPOINT +30, LAKEVIEW +23, WILMINGTON SAVINGS +22. **This is the intended behaviour** —
it is why those panels carry the "not filtered by county" label.

The single reclassification is an improvement: `WILMINGTON TRUST NATIONAL ASSN` went
`OTHER → TRUST`. Broward evidence gave the classifier enough signal to type it correctly.

**Conclusion: widening is safe once the county-column bug is fixed.** 0.5% volume movement and one
corrected classification is a far smaller blast radius than feared.

### Method note — a wrong number I nearly reported
The first cut of this diff claimed "20,320 existing entities changed". That was a bad `join`/`awk`
field mapping: `join -t'|' -j1` emits `key|base2..base5|new2..new5`, so base `total_vol` is `$3`
and new `total_vol` is `$7` — comparing `$3 != $6` compares a volume against a type and matches
everything. Correct answer is 110.

---

## 2026-08-08 — Endpoint scoping DEPLOYED. All document endpoints county-aware in production.

`git pull` → `npm run build` → `pm2 restart`. Verified byte-identical to the pre-deploy baseline
(`70,834 / 51,425 / 20,320` Miami-Dade; Broward `42,509 / 0 / 0`; ALL `113,343`) and all 37
endpoints healthy across all three scopes. No data change — code only.

### Gotcha: the shell cwd drifts to the PARENT directory
A backgrounded `cd collector && …` silently failed with `no such file or directory: collector`
because the session cwd had reset to `/Users/enrique/Downloads/amo-dashboard-source`, one level
above the repo. The task reported **exit 0 from the wrapper** and produced no log, so it looked
like it had run. **Use absolute paths in backgrounded commands, and confirm the log file exists
before trusting a "done".** The parent directory also holds a 0-byte `prod_snapshot.db` decoy that
has bitten a `cp` earlier in this workstream.

---

## 2026-08-08 — Endpoint scoping: document tables scoped; entity tables labelled (option 2).

### The split that decided the approach
Auditing the 25 unscoped endpoints showed they are **not one problem but two**:

- **Document-level** (`aom_events_clean`, `credit_facility_events`) — scopeable with a query change.
- **Entity-level** (`entity_nodes`, `entity_relationships`) — **NOT scopeable at all.** They are
  keyed by entity, not document: `normalize.py` collapses every filing for a company into one row,
  leaving no county to filter on. Making them county-aware is a pipeline change.

13 endpoints fall in the second group, including `/api/entity/:name`, `/api/entity-nodes`,
`/api/network-graph`, `/api/reporting/entity-report`, `/api/reporting/participants`,
`/api/targets`, `/api/aliases` and four deal-intelligence routes.

### User decision: option 2 — keep entity tables cross-county, and say so
Rebuilding them per county was rejected because it would undercut the cross-county entity
resolution that motivated the whole expansion (the same lenders trade in both counties, and seeing
them as one entity is the point).

- `ENTITY_SCOPE_ALL` marks such payloads; `/api/network-stats` returns `entity_scope`.
- `client/src/components/CrossCountyNote.tsx` renders "not filtered by county" beside the affected
  panel headings — **only when a specific county is selected**; on All Counties it would be noise.
  Verified: 0 notes on ALL, 3 on Miami-Dade, 3 on Broward.
- Applied to Dashboard's three ranking panels, Entities, Deal Intelligence (Seller Pressure,
  Special Servicer Watch, PE Competitive Map) and Reporting's Participant Activity.

**Reversed an earlier decision:** `/api/network-stats` had been blanking rankings when the scope
had no processed rows. With an explicit label that is worse — it hides real data and implies the
county has no entity activity, when the truth is the table does not model counties at all. The
rankings now always return, labelled.

### Document-table endpoints scoped
`clean-events`, all five `credit-facility-events/*`, `reporting`. `countyFilter()` added as the
positional counterpart to `countyPredicate()` — better-sqlite3 refuses to mix named and positional
parameters, and most of these queries are assembled as strings with `?`. The credit-facility chart
takes county into its **shared date-clause list** rather than per branch, so every chart type
inherits it and a new one cannot forget it.

Verified: `/api/clean-events?county=BROWARD` returned **5** rows against a single Broward row
before, **1** after. All key endpoints 200 across all three scopes; tsc clean.

### All document-level endpoints are now scoped (final seven done)
`/api/entity/:name/sub-entities`, `/api/deal-intelligence/{bank-to-pe,recent-bank-to-pe,
seller-pressure,pe-competitive}`, `/api/reporting/{export,chart}`.

**A trap in two of them:** `seller-pressure` and `pe-competitive` each had a fast path reading
`entity_nodes` (used when no date filter) and a dynamic path reading `aom_events_clean`. Scoping
only the dynamic path would have made the same panel answer county-scoped WITH a date filter and
cross-county WITHOUT one. Both now fall through to the dynamic path whenever a county is selected,
so behaviour no longer depends on an unrelated filter.

Verified per scope (Miami-Dade / Broward, with one synthetic Broward row):
bank-to-pe 738/1, recent-bank-to-pe 10/1, pe-competitive 20/1, reporting/chart 43/1,
reporting/export 714/1, sub-entities 100 buyer_subs/0. seller-pressure returns 25/0 — the 0 is its
own `HAVING total_vol >= 3` threshold, not a scoping failure. All 37 endpoints healthy × 3 scopes.

### Broward extraction complete
`{'OK': 489, 'DOWNLOAD_ERROR': 0, 'OCR_ERROR': 0, 'LLM_ERROR': 0}` for **$0.2554** (2.0M in /
134k out tokens). Categories: 339 LOAN_TRANSFER, 89 COLLATERAL, 39 RENTS_LEASES, 22 OTHER. With
the earlier 50, **539 Broward documents are extracted — every harvested one.**

**So `NORMALIZE_COUNTIES` is now the only remaining gate.** Roughly 339 Broward loan transfers
will enter `aom_events_clean` when it flips. Re-run the drift rehearsal first: this time
extractions exist, so `entity_nodes` volumes WILL change for entities trading in both counties —
which is intended, and is why those panels are labelled "not filtered by county".

---

## 2026-08-08 (later still) — Per-county document links DONE. And a scope gap found: 25 endpoints.

### Broward has no document deep link — confirmed, not assumed
Four GET patterns against `SearchTypeInstrumentNumber` were tested; **none prefill**. Broward
images are addressed by an internal AcclaimWeb `docId` that appears only as a checkbox value in
search results, the image endpoint needs session state, and the site is Cloudflare-fronted. So
there is nothing honest to link to.

**Why this matters more than it sounds:** a Miami-Dade book/page URL built from a Broward row
does not 404 — it resolves to a real but UNRELATED Miami-Dade document. In the UI and especially
in an exported CSV that is indistinguishable from working evidence.

### Built
- `client/src/lib/doc-url.ts` — `documentUrl()` returns a URL or **null**; `noDocumentUrlReason()`
  explains why not.
- `client/src/components/DocLink.tsx` — renders an anchor when a URL exists, otherwise plain text
  with the reason as a title. Keeps `onClick` in both branches (several call sites rely on
  `stopPropagation` to avoid toggling an expandable row).
- All **7 client sites** converted (`EntityDetailPanel`, `Reporting` ×2, `PrivateCredit`,
  `CreditFacilities` ×2, `CleanEvents` ×2, `DealIntelligence`); the two local helpers
  (`Reporting.docUrl`, `CreditFacilities.portalUrl`) are gone. `grep getdocumentimage` over
  `client/` now returns nothing.
- `server/routes.ts` CSV export `docLink()` is county-aware — Broward rows export blank.
- `county` added to **10 row-returning SELECTs** so the client can decide per row.
- `Reporting.tsx` had a hardcoded `County: Miami-Dade` line — now reflects the row.

Verified: 50 Miami-Dade links still render with correct book/page URLs; a synthetic Broward row
produced **zero** links and zero malformed URLs.

### THE FINDING — the county filter does not reach the analysis pages
Injecting one Broward row and requesting `/api/clean-events?county=BROWARD` returned **5 rows**.
Audit of every route touching the derived tables:

    read aom_events_clean / credit_facility_events : 28
    county-scoped                                  : 3
    UNSCOPED                                       : 25

Including `/api/clean-events`, all five `/api/credit-facility-events/*`, all six
`/api/deal-intelligence/*`, all five `/api/reporting/*`, `/api/entity/:name`, `/api/entity-nodes`,
`/api/targets`, `/api/aliases`.

This is harmless **today** only because Broward cannot reach those tables. **It stops being
harmless the moment `NORMALIZE_COUNTIES` includes Broward** — every analysis page would then
silently mix counties regardless of what the selector says.

**Sequencing consequence: scope those 25 endpoints BEFORE flipping `NORMALIZE_COUNTIES`.** Doing
it the other way round ships a dashboard that quietly lies about what it is showing.

### Also this session
- `NORMALIZE_COUNTIES` is now env-overridable (`NORMALIZE_COUNTIES="MIAMI-DADE,BROWARD"` or
  `"ALL"`), so the widening can be rehearsed and rolled out without a code edit. Default unchanged.
- **Drift rehearsal passed**: with all 42,509 Broward assignments in scope, a full `normalize.py`
  run left `entity_classifications` (22,287) and `entity_nodes` (20,195) **byte-identical**, and
  `aom_events_clean` at 51,093. Proves Broward names in the signal sweep do not move Miami-Dade
  classifications. **Does not** prove what happens once Broward extractions exist — that changes
  `entity_nodes` volumes for entities trading in both counties, and needs re-running then.

---

## 2026-08-08 (later) — Broward extraction path BUILT + DEPLOYED. 50 documents extracted. Not surfaced yet.

### What changed (`9493ff0`)
Broward was invisible to `extract_pdfs.py`: `pending_documents()` required a non-empty
`rec_book`/`rec_page` and Broward e-recorded documents have neither. The precondition is now
per-county — Miami-Dade still needs book/page (it fetches from the clerk live), Broward needs a
`broward_images` row meaning its pages are already harvested.

- `fetch_document_text()` is the single seam that knows where a county's page images come from.
  Broward skips both the download and the `pdftoppm` rasterize, running tesseract straight on the
  county's ~300 DPI TIFFs. The politeness delay is skipped too — no remote endpoint involved.
- `save()` writes `county` **explicitly**; without it the migrations relabel Broward extractions
  as Miami-Dade — the same trap that already caught `log_collection()`.
- **Both LLM prompts untouched, deliberately.** `FACILITY_SYSTEM_PROMPT` cannot change without
  re-running `verify_integration.py` at 21/21, and Broward's folio comes from the index anyway.
- `--county` flag added to scope a run.

### Result: 50 documents, 0 errors, $0.025
`{'OK': 50, 'DOWNLOAD_ERROR': 0, 'OCR_ERROR': 0, 'LLM_ERROR': 0}`. Categories on the first
batch: 20 LOAN_TRANSFER, 4 COLLATERAL, 1 RENTS_LEASES. All rows tagged `county='BROWARD'`, none
untagged.

### Quality is ON PAR with Miami-Dade — an earlier reading of this was wrong
Comparing Broward against Miami-Dade's *entire* extraction set showed 3× the OCR text and 0% vs
70% null assignors. **That comparison was invalid** — Miami-Dade's full set includes `OTHER`,
`RENTS_LEASES` and failed rows where names are never extracted. Like-for-like on `LOAN_TRANSFER`:

| | Broward | Miami-Dade |
|---|---|---|
| documents | 35 | 13,842 |
| avg OCR chars | 3,190 | 3,263 |
| null assignor | 0.0% | 0.0% |
| null address | 34.3% | 37.5% |

The cleaner source images may still help, but **this sample does not demonstrate it** — do not
repeat the "Broward OCR is much better" claim without a like-for-like measurement. (The earlier
2026-08-07 entry's inference from a single clean sample was premature on the same point.)

One extraction defect seen, same class as Miami-Dade's: a bank's own address
(`901 Ponce De Leon Blvd, Coral Gables`) captured as `property_address`, which the prompt
explicitly excludes.

### Operational gotcha worth remembering
**A rejected Bash tool call still ran on the droplet.** Two extraction runs are visible in the
`extracted_at` timestamps, separated by a 68-second gap — the SSH command had been dispatched
before the rejection took effect. Rejecting a call that drives a remote host stops the output,
not the remote side effect.

### Also learned
Only **539 of 42,509** Broward documents are extractable — the rest have no harvested images. Also
69 images harvested for 2026-07-21 are orphaned: that day aged off the feed before its index rows
were ingested, so they have no `assignments` row and will never be picked up.

### Open / next session
1. **Decide: extract the remaining ~489 (~$0.12).** Cheap, and it is the whole harvested set.
2. **Then the one-way door: `NORMALIZE_COUNTIES`.** Until Broward is added there, none of this
   surfaces — `aom_events_clean` stays Miami-Dade-only and the UI keeps showing "—". Flipping it
   lets Broward names into the entity-classification signal sweep, which can move existing
   Miami-Dade classifications. **Measure drift on a two-county rehearsal copy first**
   (`entity_classifications` + `entity_nodes` before/after), exactly as was done on 2026-08-07.
3. Per-county document links become necessary the moment step 2 lands.
4. The 2026 index gap and the history scraper — the latter is what takes Broward from 539
   analysable documents to all 42,509.

---

## 2026-08-08 — Selector DEPLOYED and Broward index INGESTED. Broward is live in the UI.

### Deploy + ingest
Backup `/opt/amo-dashboard/backup_pre_broward_index.db` (103MB, integrity-checked) → `git pull` →
`npm run build` → `pm2 restart` → verified Miami-Dade unchanged **before** ingesting → backfill.

    broward_collect.py --year 2023 --year 2024 --year 2025 --daily --start 2023-01-01
    → 42,509 rows in ~2 minutes

### Live state
| | Miami-Dade | Broward |
|---|---|---|
| assignments | 70,834 | **42,509** |
| date range | 2023-01-03 → 2026-08-06 | **2023-01-03 → 2026-08-04** |
| aom_events_clean | 51,425 | **0** (no extractions yet) |
| collection_log | 1,315 | 13 |

Broward starts on exactly the same day as Miami-Dade, so cross-county comparisons are
apples-to-apples as intended. `/api/stats?county=ALL` → **113,343**. Derived tables hold **zero**
Broward rows; county isolation guardrail green; all 37 endpoints × 3 scopes return 200.

### Cache gotcha worth remembering
Verifying `?county=BROWARD` *before* the ingest cached a payload of zeros — and the API cache is
**7 days**. A `pm2 restart` after the ingest was required for the dashboard to show Broward at
all. Same trap as the normalize-then-cache one, in a new place: **any pre-flight API check taken
before a data change poisons the cache for a week.**

### Daily cron now does the whole pipeline
Crontab entry became `BROWARD_INGEST_INDEX=1 run_broward_daily.sh` — index, then images, then the
retention report. Verified under `env -i`: exit 0, and it picked up the newly published
2026-08-04 (55 documents) as the feed rolled and 07-21 aged out.

### Open / next session
1. **Broward extraction path** — the blocker is `pending_documents()` (`extract_pdfs.py:250`)
   requiring non-empty `rec_book`/`rec_page`, which Broward e-recorded documents do not have, plus
   an OCR path reading the harvested local TIFFs instead of `download_pdf()` + `pdftoppm`.
   **Nothing derived exists for Broward until this lands** — it is what turns 42,509 indexed rows
   into entity, facility and transaction analysis.
2. Per-county document links become necessary the moment step 1 lands (see the 2026-08-06 entry).
3. Remaining "Miami-Dade" copy in tooltips/report headers.
4. The 2026-01-01 → 2026-07-21 index gap and the history scraper.

---

## 2026-08-07 — Client county selector BUILT + verified (superseded by the deploy above)

Phase 3. A global county selector in the sidebar, defaulting to Miami-Dade.

### Wiring: two chokepoints, not twelve pages
Every page reaches the API through either `apiRequest()` or the default
`getQueryFn()` in `client/src/lib/queryClient.ts` — verified, the only raw `fetch` in the
client is `/api/fdic/financials`, which is institution-level call-report data and correctly
unscoped. So the county is appended at those two points and no page needed touching.

- `client/src/lib/county-scope.ts` — state, `withCounty()`, localStorage. **Deliberately
  import-free**: the React provider needs `queryClient`, and `queryClient` needs `withCounty`, so
  the shared state lives in a third module to break the cycle.
- `client/src/lib/county.tsx` — `CountyProvider` / `useCounty`.
- County is NOT in any queryKey (it rides on the URL), so **`queryClient.clear()` runs on every
  scope change**. `invalidateQueries()` is not enough — unmounted pages would keep the previous
  county's rows and show them again on navigation.

### Three real bugs the browser caught that the API tests did not
1. **Derived stat cards showed Miami-Dade numbers under a Broward heading.** Unique Entities,
   Market Transfers and Private Credit all read tables Broward cannot reach. The visible tell was
   Market Transfers reporting **"177% of all filings"** — Miami-Dade's 24,215 over Broward's 13,674.
2. **Monthly volume chart** did the same, drawing Miami-Dade bars under Broward.
3. **Broward collection runs were logged as Miami-Dade.** `log_collection()` never set `county`,
   and both migrations backfill NULL→MIAMI-DADE on sight, so untagged Broward runs were being
   permanently relabelled. Fixed with an explicit `county=` argument.

### How the "indexed but not extracted" state is now presented
A county with raw filings but nothing in `aom_events_clean` shows **"—"** on every derived card
plus an amber banner explaining that filings/parties/dates are complete while anything requiring
document reading is pending. A literal 0 was rejected as it reads as "no activity" — the opposite
of the truth. `/api/stats` gained `clean_total` to drive this.

`statsUniqueEntities` moved off `entity_nodes` (which has no county column, being keyed by entity)
onto the same UNION over `aom_events_clean` that `normalize.py:1275` builds it from — **verified
identical at 20,195 for Miami-Dade**, but scopeable. `/api/network-stats` returns empty rankings
rather than Miami-Dade's when the scope has no processed rows.

### Verified
- Miami-Dade unchanged end to end: `70,355 / 20,195 / 24,215 / 4,036`, chart 43 months, rankings
  populated. Broward: `13,674` filings, 0 derived, banner shown, chart empty, rankings empty.
- Raw Assignments under Broward: 13,674 records, real instrument numbers and party names.
- Collection Log scopes correctly (1,301 Miami-Dade / 10 Broward).
- **No wrong document links exist today** — the CFN on Raw Assignments is styled text, not an
  anchor (0 anchors in the table), and every page that *does* build a Miami-Dade book/page URL
  reads a derived table with no Broward rows. The per-county link builder is still required, but
  only once Broward extractions land.
- tsc clean; canonicalize baseline, alias scope and county isolation all green.

### Open / next session
1. Not deployed. Needs `npm run build` + `pm2 restart`.
2. Remaining "Miami-Dade" copy is in tooltips and report headers (`Assignments.tsx`,
   `CleanEvents.tsx`, `EntityReport.tsx`, the login page). Cosmetic, but wrong under Broward.
3. Ingesting the Broward index into production is now safe — the UI can express it.
4. Then: Broward extraction path, then the history scraper.

---

## 2026-08-07 (later still) — County-aware server DEPLOYED. Phase 2 live.

Default scope is Miami-Dade, so production output is unchanged until the UI opts in.

### Deploy
Backup `/opt/amo-dashboard/backup_pre_county.db` (92MB, integrity-checked) → `migrate_add_county.py`
→ `git pull` → **`npm run build` → `pm2 restart`** (this one needed both; the harvester deploy did
not). Migration added `county` to all five tables and backfilled 70,834 / 70,834 / 51,425 / 445 /
1,315 rows to MIAMI-DADE.

### Verified live, against the pre-deploy baseline `70,834 | 28,644 | 13,512 | 51,425 | 20,320`
- `/api/stats` default → **identical to baseline**, range `2023-01-03..2026-08-06`.
- `?county=BROWARD` → 0 (nothing ingested yet, as expected). `?county=ALL` → same as default.
- `/api/network-stats` → 200, i.e. the shared-statement bug is fixed in production.
- Post-deploy DB counts byte-identical to the baseline. County isolation guardrail green.
- Harvester unaffected: 553 images still recorded.

### Two operational findings from the deploy
1. **`ecosystem.config.cjs` has drifted from the running process.** The file's `AMO_PASSWORD` is 9
   characters; the process PM2 is actually running has an 11-character one. PM2 captured the env at
   start and has kept it across restarts, so the file is stale and misleading. **A `pm2 delete` +
   restart would silently change the dashboard password to the file's value.** Reconcile it.
2. `pm2 env 0` prints secrets in `KEY: value` form (not `KEY=value`), so redaction patterns written
   for `.env` files do not match it. The password was echoed into a session transcript this way —
   worth rotating, and worth remembering before running `pm2 env` again.

---

## 2026-08-07 — County-aware server BUILT + verified (superseded by the deploy above)

### The change is far smaller than the raw grep suggests
98 query sites touch county-able tables, but **only `assignments` and `collection_log` can
actually hold Broward rows today.** The derived tables are unreachable: `normalize.py`'s
loan-transfer filter (`normalize.py:1002`) admits a non-AMO doc type only when the PDF is
classified `LOAN_TRANSFER`, Broward's `AST` is non-AMO, and Broward has no extractions —
while `entity_nodes`/`entity_relationships` are built from `aom_events_clean` and inherit the same
barrier. So scoping went exactly where it can matter, not across all 98 sites.

**That barrier disappears the moment Broward extractions land.** Noted in the code: the entity
aggregates are pre-aggregated by `normalize.py` and cannot be filtered at query time — they would
have to be rebuilt per-county, or deliberately left cross-county (which is what the user asked
for).

### Built
- `server/routes.ts` — `DEFAULT_SCOPE` (currently `'MIAMI-DADE'`), `countyScope(req)` reading
  `?county=` (`ALL` widens), `countyPredicate()`. Applied to `/api/stats`, `/api/collection-log`,
  `/api/assignments`, `/api/search`, `/api/network-stats`.
- `server/db.ts` — defensive county migration mirroring `migrate_add_county.py`, so the server
  self-heals whichever side deploys first.
- `collector/normalize.py` — `NORMALIZE_COUNTIES` + `county_filter()`, applied to the main rebuild
  query and the raw-name signal sweep.

### The subtle one — the raw-name sweep, which has no loan-transfer filter
`normalize.py`'s suffix-signal pass reads names straight off `assignments`. A Broward name landing
there can flip the signals of a canonical entity that also trades in Miami-Dade, silently changing
`assignor_type`/`assignee_type` on existing rows. Measured: the sweep sees 41,097 names unscoped
vs 37,470 scoped; the 3,627 excluded are Broward-only and **zero of them also exist in
Miami-Dade**, so scoping provably cannot move an existing classification.

### Verified against a two-county DB (70,355 MD + 13,674 Broward)
- `/api/stats` — default `70,355 / 28,454 / 13,442`, exactly the Miami-Dade SQL baseline;
  `?county=BROWARD` `13,674`; `?county=ALL` `84,029 / 30,963 / 14,861`. All three match SQL.
- `/api/search` default returns **0** Broward-format CFNs; `?county=BROWARD` returns 100.
- **Full `normalize.py` run with Broward present → zero drift.** `aom_events_clean` 51,093 →
  51,093, zero Broward rows in it or `credit_facility_events`, and `entity_classifications`
  (22,287 rows) plus `entity_nodes` (20,195 rows) came back **byte-identical**.
- Swept all 37 GET endpoints × 3 scopes: all 200. (Two 400s are pre-existing
  missing-required-param guards on `/family` and `/entity-report`.)
- Guardrails green: canonicalize baseline, alias scope, county isolation.

### The bug only running caught — again
`/api/network-stats` **reuses `stmts.statsTotal`** and called `.get()` with no arguments → 500
`Missing named parameters`. `tsc` passed clean. It only surfaced by loading the page and reading
the console. Lesson repeated: **when a shared prepared statement gains a parameter, grep every
call site of that statement, not just the endpoint being edited.** It also silently broke the
Overview chart, which is what a 500 on one of four parallel calls looks like.

### Open / next session
1. **Not deployed.** Deploy order: `migrate_add_county.py` → `git pull` → `npm run build` →
   `pm2 restart` (this one DOES need build+restart — server code changed). Then ingest the index.
2. **Client sends no `county` param yet**, so it gets the Miami-Dade default — which is why
   production is unaffected. The county selector is the next UI piece.
3. **Branding says "Miami-Dade County"** in the sidebar, the login page and the Overview subtitle.
   Needs to become county-aware before Broward is visible.
4. Flip `DEFAULT_SCOPE` to `null` only once the UI has a selector AND Broward has extractions —
   otherwise Broward rows appear with no details and no way to filter them out.

---

## 2026-08-07 (later) — Broward image harvester DEPLOYED to production. Phase 1 live.

Images only, no county migration, no Broward rows in any table the dashboard reads. The retention
clock has stopped.

### Deploy, all six steps
1. `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` — **the agent had no identities**; key auth
   fails with `Permission denied (publickey)` until this is done each session.
2. `collector/.venv/bin/pip install paramiko` → 5.0.0.
3. `git pull --ff-only` from `b6f7f47` → collector-only changes, so **no `npm run build` and no
   `pm2 restart`** (the Node bundle is untouched — this is the rare deploy that skips both).
4. First harvest: `broward_images.py --all --from-feed` via `nohup`+`disown`, ~4 min,
   **553 documents / 77.6MB / 80MB on disk**.
5. Cron installed: `30 12 * * * run_broward_daily.sh` (4th entry alongside weekly, tick, nightly).
6. Ran the wrapper under `env -i` to imitate cron's bare environment → exit 0, idempotent
   (0 new documents, every day `complete`).

### Verified after deploy
- `assignments` **70,834** — up from the snapshot's 70,355 purely from Miami-Dade collection
  through 2026-08-06, not contamination. Explicitly confirmed: `SELECT COUNT(*) FROM assignments
  WHERE cfn GLOB '[0-9]*' AND cfn NOT GLOB '*[^0-9]*'` → **0**, i.e. no Broward-format keys.
- `county` column still absent, as intended for phase 1.
- `broward_images` = 553 rows. App online, HTTP 302 (login redirect). Disk 147G free.
- **Droplet tesseract reads the harvested TIFFs directly** — no `pdftoppm` step needed, which
  removes a dependency the Miami-Dade path has.

### Ops notes
- Droplet throughput is ~3× slower than local (4 min vs 70s for the same 553 documents) — network
  bound, not CPU. Still trivial against a daily run of ~55 documents.
- Growth is ~8MB/day ≈ 2GB/year against 147GB free.
- Watch `collector/broward_daily.log`. **Any day showing PENDING that then scrolls off the top of
  the retention window is permanently lost to the free channel.**

---

## 2026-08-07 — Broward image harvester BUILT + rehearsed. Still NOT deployed.

User chose to scrape rather than buy bulk data, reasoning that collection is recurring. Important
correction that came out of building this: **recurring collection is exactly the case that needs
NO scraping.** The SFTP feed handles ongoing pulls better than a scraper ever could. Scraping is
now scoped to history only (2023-01-01 → the retention window) plus the 2026 index gap.

### THE finding — images are keyed by instrument number, and selectively readable
Entries inside the daily `img.zip` are named **`<instrument>.<page>.tif`** — the same instrument
number already in `assignments`. No internal docId, no session, no portal. And because a zip's
central directory lives at the END of the file, the harvester can read the last few MB over SFTP
to get the full entry list plus byte offsets, then seek to only the entries it wants.

**Measured across all 10 retained days: 553 documents / 1,530 pages / 77.6MB pulled from 4.1GB of
zips — 1.8%. 70 seconds total.** A typical day is ~55 documents and ~8MB.

### OCR quality is far better than Miami-Dade's, and this matters
The county ships **quality-assured G4 bi-level TIFFs at 2550×4381 (~300 DPI)**. Miami-Dade's path
re-rasterizes a downloaded PDF via `pdftoppm` at `OCR_DPI = 200`. Sample Broward OCR came back
essentially clean — full addresses, phone numbers and book/page references intact.

**Expect the VASTER-class name mangling to be much rarer in Broward.** The entire OCR'd-LLC
correction machinery (`LEC`/`LUC`/`LLG`, "confirmed landing", the sibling-protection rules) exists
because Miami-Dade's extracted names are damaged. Do NOT assume Broward needs the same treatment
— measure first, or the correction rules will fire on names that were never broken.

### Built (pushed; nothing has touched production)
- `collector/broward_images.py` — `--status` / `--all` / `--date` / `--force`. New table
  `broward_images` (cfn, rec_date, page_count, bytes_on_disk, harvested_at, source_zip) makes it
  idempotent and resumable. Images land in `BROWARD_IMAGE_DIR` (default `collector/broward_images/`,
  gitignored) as `<instrument>/<page>.tif`.
- `collector/run_broward_daily.sh` — index then images then the retention report, for cron.

**Raw TIFFs are stored, not OCR text**, on the same principle that keeps `pdf_extractions`
around: the image is the irreplaceable artifact, OCR settings and prompts are re-appliable.

### Deliberate implementation choice
`extract_entry()` bypasses `zipfile.open()` and does one contiguous ranged read per entry, then
`zlib.decompress(blob, -15)`. `zipfile.open()` issues many small reads and each is an SFTP round
trip. Also: **never `prefetch()` a 500MB remote zip** — it drops the connection with
`MessageOrderError`; that was the first attempt and it failed.

### The retention clock, quantified
Feed retains ~10 days (currently 2026-07-21 → 2026-08-03). `--status` prints indexed vs harvested
per day and warns on anything PENDING. **A monthly cadence loses ~20 days of images every month,
permanently.** Cron is written for daily at 12:30 UTC; Broward's own uploads were observed landing
10:27–11:01 UTC.

### `--from-feed` — the harvester is deployable on its own (added same session)
Checked before recommending a deploy, and it changed the plan: **`assignments` is read directly by
the Dashboard stat cards and the Assignments page** (`server/routes.ts:15-18`, `193`, `234`).
Ingesting the Broward index before the server is county-aware would jump the live document count
from 70,355 to ~112,878, inflate distinct grantors/grantees, and mix unlabelled Broward rows into
the Assignments table.

So the harvester no longer needs the database at all: `--from-feed` reads the work list from the
day's own `doc-ver.txt`. **Verified against a pristine copy of production** — no county column, no
Broward rows — and it harvested the identical 553 documents / 77.6MB. Schema diff after the run
is exactly one new table (`broward_images` + its index); all four dashboard stat queries and every
table row count are byte-identical.

**This is the deploy order that matters: the retention clock is the only piece with a deadline,
and it is now fully decoupled from the work that needs care.** `run_broward_daily.sh` defaults to
this mode; set `BROWARD_INGEST_INDEX=1` once the server is county-aware and it switches to
ingesting the index and sourcing the work list from the DB.

### Open / next session
1. **Nothing is deployed.** Production still has no `county` column, no Broward rows, no images,
   no cron. Droplet needs `paramiko` installed first. **Phase 1 (harvester + cron, `--from-feed`)
   is safe to deploy on its own and should go first** — every day of delay permanently loses
   ~55 documents' images to the free channel.
2. **Broward documents cannot reach the extractor yet.** `pending_documents()`
   (`extract_pdfs.py:250`) requires non-empty `rec_book`/`rec_page`, and Broward e-recorded docs
   have neither — so Broward rows are silently skipped. Protective for now (they'd otherwise hit
   the Miami-Dade downloader), but it is the next thing to fix, alongside an OCR path that reads
   local TIFFs instead of `download_pdf()` + `pdftoppm`.
3. Then the history scraper (~49,000 docs, 2023-01-01 → retention window) and the 2026 index gap.
   The results grid has an **Export to CSV** button — prefer it over parsing HTML.
4. Everything from the 2026-08-06 entry below still stands: county filter, per-county document
   links, `normalize.py` county propagation.

---

## 2026-08-06 (later) — Broward County expansion started. Index ingestion BUILT + rehearsed, NOT deployed.

User directive: bring the same information in from Broward. [ROLLBACK.md](ROLLBACK.md) has a
new section for this workstream and is the live tracking doc.

### THE finding — Broward needs no scraping at all
Broward publishes its recording index as flat files on a **public SFTP server**. No Playwright,
no reCAPTCHA, no login, no rate limit. This is a categorically better source than Miami-Dade.

    Host BCFTP.Broward.org:22   user/pass crpublic/crpublic   (published by Broward RTT)
    OR_Yearly_Exports/CY<YYYY>doc-rec.txt   full calendar year, 1978 → last completed year
    Official_Records_Download/<MM-DD-YYYY>doc-ver.txt   one business day, ~10-day retention

- **Measured: 42,523 Broward assignments ingested in under 30 seconds total.** Miami-Dade's
  equivalent took days of browser automation.
- **Party data is better than Miami-Dade's.** 0 of 42,523 rows are missing a grantor or grantee.
  The name file is one row PER PARTY, so multi-party filings survive intact (one real example:
  3 grantors → 5 grantees); Miami-Dade's index gives one name per side. Full list is kept in
  `raw_json`; `grantor`/`grantee` hold the first of each to match the Miami-Dade column shape.
- **`AST` is Broward's ONLY assignment code** — verified against all 65 codes present in CY2025,
  where Miami-Dade splits across AMO/ASG/AIT. Harmless: `extract_pdfs.py` classifies the real
  document and `normalize.py` keeps only true loan transfers, exactly as it already does for
  Miami-Dade's generic buckets.
- Bonus field Miami-Dade only gets via LLM extraction: **folio/parcel is in the index directly**
  (field 11, populated on ~70k of 643k CY2025 rows).

### Record layout (reverse-engineered — the county's published layout PDF 404s)
Pipe-delimited, **CRLF line endings, BOM on the yearly files**, cp1252 not utf-8. 1-based:

    1 instrument   2 recdate YYYYMMDD   3 recdate MM/DD/YYYY   4 rectime   5 doc type
    6 consideration   7 legacy book   8 legacy page   9 book type ('O')   11 folio/parcel
    12 doc stamps   14 page count   18 'E' when e-recorded   19 case number

Name file: `<instrument>|<name>|<D|R>|<seq>|`. **D = direct = grantor/assignor, R = reverse =
grantee/assignee** — verified against the portal's own column headers for instrument 119979096
(First Direct = FUND-EX SOLUTIONS GROUP LLC, First Indirect = PINNACLE BANK).

### Built (NOT yet committed to prod DB — rehearsed on a copy of prod_snapshot.db)
- `collector/broward_collect.py` — SFTP ingest, `--year` / `--daily` / `--list`, doc-type and
  date filters. **New dependency: `paramiko`** (macOS curl has no SFTP support; the droplet venv
  needs `pip install paramiko` before this runs there).
- `collector/migrate_add_county.py` — idempotent; adds `county` to `assignments`,
  `pdf_extractions`, `aom_events_clean`, `credit_facility_events`, `collection_log`, backfills
  existing rows to `MIAMI-DADE`, adds county indexes.
- `collector/tests/check_county_isolation.py` — new guardrail. Green.

### Deliberate shortcut, with the invariant that makes it safe
`assignments.cfn` is globally UNIQUE and was NOT rebuilt to `UNIQUE(county, cfn)` — that needs a
table recreation on the 70k-row table that just absorbed the entity-normalization refactor.
Safe because the key formats are **provably disjoint**: Miami-Dade CFNs always contain `R`
(`2026R521735`), Broward instruments are always pure digits (`121018052`). The guardrail asserts
this rather than trusting it, and `broward_collect.insert_records()` refuses a cross-county CFN
explicitly instead of letting `INSERT OR IGNORE` swallow it. **A third county whose keys are not
disjoint is the moment to do the real rebuild.**

### THE GAP — 2026-01-01 → 2026-07-20 is unreachable from the FTP feed
Yearly exports stop at the last completed year (CY2025 was published 2026-02-17), and the daily
feed only retains ~10 days. So ~7 months of 2026 (~8,000 assignments) sit in neither. CY2026
will not publish until ~Feb 2027. Options, undecided: scrape AcclaimWeb for that window; ask
Broward for a one-off bulk export (954-831-4000, they invite this); or run daily from now and
backfill the hole when CY2026 lands.

### Images are the real phase-2 problem
Yearly exports are **index only**. Historical Broward PDFs would have to come from the
AcclaimWeb portal, which is Acclaim/Harris (not Miami-Dade's stack) and:
- gates everything behind an "I accept the conditions above" disclaimer (accepted this session at
  the user's explicit instruction),
- serves images from `/AcclaimWeb/Image/DocumentImage<tab>/<docId>` where `docId` is an
  **internal id** (`55269190`), not the instrument number — it appears only as a checkbox value
  in the results grid, so every document needs a search round-trip first,
- **requires session state** — hitting that URL directly returns an Acclaim error page,
- sits behind **Cloudflare bot management** (`cdn-cgi/challenge-platform` observed).

The sanctioned alternative: the daily `img.zip` (~400–540MB/day) carries that day's images with
no scraping at all. Forward-looking only. **No entity/facility extraction is possible for Broward
until this is resolved** — index data alone feeds the assignment tables, not `pdf_extractions`.

### Decisions recorded (user, this session)
1. History depth: **2023-01-01, matching Miami-Dade** — so cross-county stats are apples-to-apples.
2. Data model: **one DB, `county` column, county filter in the UI**, defaulting to All. Entity
   resolution spans both counties on purpose — the same lenders operate in both.
3. Disclaimer acceptance on the Broward portal: authorized.

### Open / next session
1. **Nothing is wired past `assignments`.** `normalize.py`, `server/routes.ts` and every client
   page are still county-blind. The county filter, and `county` propagation through the derived
   tables, are not built.
2. **Every document link in the client is a Miami-Dade book/page URL** — 8 sites (`CleanEvents`
   ×2, `CreditFacilities`, `DealIntelligence`, `PrivateCredit`, `Reporting`,
   `EntityDetailPanel`, `routes.ts:1932`). Broward e-recorded docs have **no book/page at all**;
   they link by instrument number. Needs a per-county link builder before any Broward row is
   shown, or those links silently produce wrong documents.
3. Decide the 2026 gap and the image strategy (above).
4. Name variants are already visible in Broward: `U S BANK TRUST NATIONAL ASSN` (1,701) vs
   `US BANK TRUST NATIONAL ASSN` (878). The existing address book should absorb these — but
   `check_canonicalize_baseline.py` covers Miami-Dade names only, so regenerate the baseline
   deliberately rather than letting Broward silently move it.
5. Droplet needs `paramiko` installed and a cron entry for `--daily` before Broward stays fresh.

---

## 2026-08-06 — Entity normalization DEPLOYED to production

Live and verified. Production was 21 commits behind (`d834771`); all 21 were this workstream plus the `run_weekly.sh` exec-bit fix, so nothing unrelated shipped.

### Deploy, all seven steps
1. `sqlite3 .backup` → `/opt/amo-dashboard/backup_pre_entity_norm.db` (91MB, integrity-checked). **Keep until confident.**
2. `git checkout -- collector/run_weekly.sh` — prod carried the same exec-bit change `0deb97f` applies; it would have blocked the pull.
3. `git pull --ff-only` → `b6f7f47`.
4. `npm run build` → `pm2 restart amo-dashboard`.
5. `apply_proposals.py --write --merges auto,high --families high` → **11 merges, 25 parent assignments**. The dry run against production returned identical counts to the snapshot rehearsal — that match is what confirmed the rehearsal was faithful.
6. `normalize.py` via `nohup`+`disown`, ~15 min.
7. `pm2 restart` to clear the 7-day cache. **Not optional** — without it a correct deploy looks like it failed.

### Live result (matches the rehearsal exactly)
- **231 → 224 distinct borrowers**, 237 → 229 lender/borrower pairs, 445 filings unchanged.
- Families: Vaster 5/74, Atlantis 2/27, Mathon 2/20, Eastern 4/11, Winston 5/9, Precedent 2/9, Pace 2/4, Brora 2/2.
- Vaster resolves to 4 real companies + 1 artifact: LOANS III 32f, SUB II 28f, **SUB III 7f**, MANAGEMENT 6f, `Vaster II and Vaster I` 1f.
- User confirmed the expansion works in the live UI.

### Also shipped this session
- **JS key twin deleted.** `direction`/`grantor_role`/`grantee_role` are computed in `normalize.py` and served by `/filings`; the client renders them. `nameKey`/`keysMatch`/`filingDirection`/`isThirdParty` are gone — no second implementation left to drift (it had already mislabelled directions once, `f8f19d6`).
- **Server-side family pagination.** `/facilities` groups by lender + `COALESCE(borrower_parent, borrower_key)`; new `/credit-facility-events/family` returns members on expand. Client-side grouping split families across page boundaries and reported partial counts (Vaster read "4 entities").
- Display fix: grouped query labelled rows with `MAX(facility_borrower_name)`, an arbitrary OCR-damaged extraction — correctly merged rows still read `VASTER'SUB II, LLC`. Now shows `borrower_recorded`.
- Family scoring weights by filings, not distinct names (two junk 1-filing rows were outvoting 72 filings and holding Vaster at MEDIUM). `LL` added to `LLC_OCR` as a truncation.

### Three bugs that only running it could catch — typecheck and success messages both lied
1. **Inert merges.** A full rebuild with 12 aliases and 25 parents loaded changed nothing: `borrower_key` still derived from the extracted name, so an alias on `VASTER SUB II LL` never matched. Apply reported 25 writes, rebuild reported loading them, `borrower_parent` even populated. Only the unchanged borrower count exposed it.
2. **Hooks-order crash.** `FamilyMembers` was called as a plain function inside a map; it uses a hook, so expanding a family white-screened the page. `tsc` passed clean before and after.
3. **Watcher that could never fire.** `pgrep -f "normalize.py"` matched the ssh/bash command line containing that string, so the completion poll looped forever. Use `ps -eo pid,cmd | grep "[n]ormalize.py" | grep -v "bash -c"`.

### Open / next session
1. **`Vaster II and Vaster I` is a sentence fragment stored as a borrower** — extraction defect, unrelated to normalization. Also `SHE 3`, `PAM` and similar short/junk names are worth a sweep.
2. **Old bookmarked facility links are dead** — `/filings?lender=&borrower=` keys changed. Accepted deliberately; no fallback added.
3. Not applied, deliberately: 4 CONFLICT-tier proposals (`B&B 18` vs `26`, `Precedent 4A` vs `4C`, `Metro Parc Hialeah` variants, `Winston AB` vs `BAN`), the sibling pair, and 14 LOW families (`Jose`/`David`/`Jared` are people; `Metro`/`North`/`Shore`/`Safe` are place words). Re-run `show_merge_proposals.py --db` to review.
4. **UI for approving merges/parents was never built.** Decisions still go through `collector/apply_proposals.py`. Agreed design: extend the existing "Duplicate review & merge tool" (`client/src/pages/Entities.tsx:57`, `POST /api/aliases/merge`) with both `same_as` and `belongs_to`. **User's rule: confirmed assignments never re-ask, but NEW entities matching a confirmed family are proposed again, never silently absorbed.**
5. **STILL OUTSTANDING — GitHub PAT** in `.git/config` on this Mac and the droplet. Repo is PUBLIC; never committed, so secret scanning never saw it and nothing auto-revokes it. Revoke → security log → SSH remote → read-only deploy key.
6. `.claude/launch.json` (parent dir) gained an `amo-dashboard-snapshot` entry on port 5051 pointing at `/tmp/final2.db` — a scratch file that will not survive a reboot. Repoint or delete.
7. Guardrails, run all three before touching naming: `check_canonicalize_baseline.py`, `check_alias_scope.py`, `check_entity_names_parity.py` (last needs `AMO_DB_PATH=./prod_snapshot.db`).

---

## 2026-08-05 — Matching reworked onto county-recorded names; parent layer wired. NOT deployed.

Production snapshot obtained. Continues 2026-08-04 below; [ROLLBACK.md](ROLLBACK.md) is still the live tracking doc.

### THE finding — we were matching on the wrong column
`facility_borrower_name` is LLM-extracted from OCR'd document **body text** (two lossy steps). `grantor`/`grantee` come from the county's own **typed index**. The clean name was one column over the whole time.
- **Proof, CFN `2025R173932`:** extractor produced `VASTER SUBIII, LLG`; county index recorded **`VASTER SUB III LLC`** — a real third entity, not a misread of SUB II.
- Cross-checking merges already applied to a test DB: **5 of 12 Vaster merges were WRONG**, all collapsing SUB III filings into SUB II. `VASTER SUB III` has **7 filings** and would have been erased.
- **`VASTER LOANS II` does not exist.** Every filing extracted as "II" records as "III" — the sibling-protection rule was guarding a phantom entity.
- Fix: `name_matching.resolve_recorded_name()` picks the recorded party that is not the lender and best matches the extraction (extraction used only as a HINT to choose between the two recorded parties). Below `RECORD_MATCH_MIN` both parties are third parties (affiliate co-borrower / prior holder) → keep the extracted name, never invent one. Resolution is **per filing, before aggregation** — grouping first picks one recorded name arbitrarily and destroys the SUB II/SUB III evidence.
- **Effect: auto-merges 15 → 7, review queue 14 → 8.** The entire Vaster OCR mess (`SUB IL`/`HU`/`dI`/`SUBMIT`/`SUBLII`) evaporated — it only ever existed in the extracted column. Vaster resolves to **4 real companies**: SUB II (27f), LOANS III (32f), SUB III (7f), MANAGEMENT (6f). Previously-invisible entities surfaced: EOS Loans, Atlantis, Mathon, HPL. Residual candidates are genuine typos in the county index itself (`PRECEDENT ASSET MANAGMENT`, `ATLANTIC` vs `ATLANTIS HOLDINGS`, `VASTER SUB II LL`).

### Second real bug — alias scope leak (found by rebuilding, not by assuming)
`normalize.load_aliases()` selected **every** `entity_aliases` row ignoring `scope`, so all 12 facility-scoped merges were being applied by `canonicalize()` — silently voiding the "v1 changes nothing on the entity side" guarantee the scope column exists to provide. Now filters `COALESCE(scope,'all') = 'all'`.
**The canonicalize baseline cannot catch this** — it forces `_ALIAS_MAP` empty, so it tests the rules, not the loader. New `collector/tests/check_alias_scope.py` covers the gap. Gotcha for future edits: **aliases are looked up AFTER suffix stripping**, so an `'all'`-scoped variant must be written in its post-stripping form (`GLOBAL PROBE`, not `GLOBAL PROBE CO`).

### Built (all pushed)
- `40cf7df` `collector/name_matching.py` — two-tier merge proposals (AUTO / REVIEW), never mutates. AUTO rules: punctuation→space; OCR'd LLC (LEC/LUC/LLG) corrected **only when the corrected name already exists** ("confirmed landing"); absent suffix matches any, conflicting suffixes never match. Fixture of 46 real City National rows at `collector/tests/fixtures/`.
- `acb80fe` amounts are a SET (one entity files at several amounts); `are_siblings()` — names differing only by a valid trailing numeral ≤20 are never merged. **`facility_amount` is the parent facility's credit limit quoted on every filing, so sub-entities SHARE it** — amount agreement proves "same facility", not "same entity".
- `2393ad9` parent layer. **Separate `entity_parents` table on purpose:** `entity_aliases`=`same_as` (merges rows) vs `entity_parents`=`belongs_to` (groups rows). Storing a parent as an alias would collapse sub-entities and destroy the shell detail the view exists to show. `parent_of()` never guesses.
- `a89185d` confidence fixes: lender names normalized through the address book (raw-text compare made Vaster look like a 2-lender family when all 21 filings face City National); **multi-lender no longer lowers confidence** — Winston runs one entity per bank (`WINSTON AB`→Amerant, `BAN`→Banesco, `USC`→U.S. Century); `CORPORATION`/`INCORPORATED`/`COMPANY`/`LIMITED` added to SUFFIXES.
- `5c2809a` `collector/apply_proposals.py` — dry-run by default, `--write` commits. CONFLICT tier and siblings are NEVER applied (they assert names are *different*). Review targets resolve to the healthiest surviving name per stem.
- `a7f5504` the county-recorded rework. `6417d42` parent wiring + scope fix.

### Guardrails (run all three before committing anything touching naming)
    collector/.venv/bin/python3 collector/tests/check_canonicalize_baseline.py
    collector/.venv/bin/python3 collector/tests/check_alias_scope.py
    AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 collector/tests/check_entity_names_parity.py
All green. Review the proposal list any time with `collector/tests/show_merge_proposals.py [--db]`.

### Operational facts learned
- **Production snapshot: `./prod_snapshot.db`** (gitignored, 91MB). Droplet key auth now works (`ssh-copy-id` route was blocked — no root password; installed the pubkey via the DigitalOcean **web console** instead, no reboot needed). Key is passphrase-protected → needs `ssh-add --apple-use-keychain` in the agent or non-interactive ssh/scp fails.
- **NEVER plain-`scp` the live DB:** it had a 53MB `-wal` newer than the 95MB main file; copying only the `.db` silently loses it. Use `sqlite3 <db> ".backup /tmp/snap.db"` on the droplet, then copy that.
- Production scale: `credit_facility_events` **445 rows / 241 borrower names**, `pdf_extractions` **70,355**, `assignments` **70,355** (through 2026-07-30), `entity_aliases` **0**. Full-history backfill is complete.
- **A full `normalize.py` run takes ~15 minutes** at production scale (4 vCPU droplet is comparable). Facility build is inline in `build_normalized_tables()` — no fast path for facility-only rebuilds.

### Open / next session
1. **DECISION PENDING — Vaster scored MEDIUM so it was not assigned a parent** (only HIGH families were applied). Cause: the ≥0.8 corporate-suffix threshold; 2 of its 6 members are junk (`VASTER SUB II LL` truncation, `Vaster II and Vaster I` sentence fragment) → 67%. Claude's recommendation: **exclude junk entries from the scoring denominator** rather than lowering the bar or applying MEDIUM wholesale.
2. Re-run proposals for user review against the corrected (county-recorded) list, then apply.
3. **UI work not started.** Extend the existing "Duplicate review & merge tool" (`client/src/pages/Entities.tsx:57`, `POST /api/aliases/merge`) with both actions — `same_as` and `belongs_to` — per user's "whatever is easier for the user". Nothing surfaces `borrower_parent` yet. **Three things must move in lockstep:** the JS twin `nameKey()` at `CreditFacilities.tsx:82`, the four `COALESCE(lender_key, ...)` sites in `routes.ts` (654/739/788/813), and `/filings?lender=&borrower=` URL params.
4. `Vaster II and Vaster I` is a sentence fragment stored as a borrower — an extraction defect, separate from this work.
5. **User decision recorded:** tool proposes → user confirms → confirmed assignments never re-ask, but NEW entities matching a confirmed family are proposed again, never silently absorbed.
6. **STILL OUTSTANDING from 2026-08-04:** the leaked GitHub PAT in `.git/config` (repo is PUBLIC; never committed, so secret scanning never saw it). Revoke → security log → SSH remote → read-only deploy key.

---

## 2026-08-04 — Entity-normalization refactor started (v1 built, NOT deployed; blocked on prod snapshot)

Goal chosen by user: **one shared address book every part of the app reads.** See [ROLLBACK.md](ROLLBACK.md) — it is the live tracking doc for this work (ledger + revert procedures); read it before touching any of this.

### What the code actually looked like (measured, not assumed)
- **Two normalization systems, deliberately separate** (`normalize.py:619` says so): `canonicalize()` = brand folding (strips LLC/INC/NA); `clean_facility_name()`/`facility_name_key()` = display-safe, suffixes preserved. No shared aliases, no shared rules.
- **They disagree on 6,267 clusters** across 31,113 distinct raw names (entity path → 23,699 groups, facility path → 31,094).
- **Entity path is very aggressive:** all **180 Towd Point securitization trusts** fold into one `TOWD POINT`, via a MANUAL_OVERRIDES *prefix* match (`normalize.py:251`) — overrides return before suffix stripping. This is existing live behavior, not new. Confirms brand folding must NEVER be applied to facility borrower names (SPEs differ only by suffix/number).
- **Facility path is better at punctuation, and the entity path has a real defect because of it:** `canonicalize()` never normalizes ampersands, so **A&D Mortgage (real active Miami-Dade lender) is counted as three separate entities** — `A & D MORTGAGE` / `A&D MORTGAGE` / `A D MORTGAGE`. Same defect: James B. Nutter & Company, Village Capital & Investment, Fidelity & Guaranty Life Mortgage Trust 2018-1, Inter & Co Payments. 14 clusters total; 4 are marginal OCR truncations (`EVOLVE &`, `GROVE &`, `UNIVERSAL &`, and `AD`↔`A&D` — a 2-char key, needs a real decision, not a wave-through).

### Decisions
1. **v1 is strictly non-breaking: the canonicalize baseline must stay GREEN.** The A&D punctuation fix is correct but deferred to its own reviewed change, so v1 carries exactly one source of variation (facility-side regrouping) and post-deploy attribution stays unambiguous.
2. **User wants corporate architecture AND property-shell detail preserved** — so `credit_facility_events` now stores brand keys *alongside* entity keys rather than choosing one. Verified divergence: `BGI FINANCIAL, LLC` → entity `BGI FINANCIAL LLC`, brand `BGI FINANCIAL`.
3. Migrated facility aliases are **scope='facility'** so v1 provably cannot move brand-level output. Promoting them to `'all'` rides with the A&D change.

### Built (all pushed; tag `pre-entity-normalization` = `c5bfe89` is the known-good anchor)
- `d5f6d16` `collector/tests/{gen,check}_canonicalize_baseline.py` + `canonicalize_baseline.tsv` — 31,113 inputs → 23,700 canonical names. **Needs no DB**, runs in seconds. Verified in both directions (a simulated over-merge is caught with a −48 distinct-name delta).
- `c5bfe89` `collector/tests/diff_name_systems.py` — the disagreement measurement above. Report output is gitignored (regenerable, DB-specific).
- `6b3f57e` `ROLLBACK.md`.
- `7aa26a1` **`collector/entity_names.py`** — the shared address book. Standalone (imports nothing from normalize.py). `entity_key()` keeps suffixes; brand folding stays in `canonicalize()` and is NOT reimplemented. Aliases move from code to `entity_aliases` with a new `scope` column.
- `39e1225` wiring: `clean_facility_name`/`facility_name_key` now delegate to `entity_names`; `seed_facility_aliases()` migrates the 2 hardcoded OCR fixes with `INSERT OR IGNORE` (never clobbers user edits); `credit_facility_events` gains `lender_brand`/`borrower_brand`; `server/db.ts` CREATE + defensive ALTERs updated.

### Guardrails (run both before committing anything that touches naming)
    collector/.venv/bin/python3 collector/tests/check_canonicalize_baseline.py
    AMO_DB_PATH=./miami_dade_amo.db collector/.venv/bin/python3 collector/tests/check_entity_names_parity.py
- **The parity test compares against a FROZEN copy of the pre-refactor logic**, inlined in the test file. Do NOT "simplify" it to import `normalize`'s live functions — now that they delegate, that would compare the module to itself and pass trivially.
- Current status: all green. Full `normalize.py` run against a DB copy exits clean and populates both key levels.

### Rollback safety (verified, not assumed)
`normalize.py` writes ONLY to `aom_events_clean`, `credit_facility_events`, `entity_classifications`, `entity_nodes`, `entity_relationships`, `fdic_institution_cache` — **never** `assignments` or `pdf_extractions`. Every affected table is rebuildable from raw source, so **no rollback scenario loses data**; the cost of a bad deploy is a rebuild. Full detail is also retained per-row: `aom_events_clean` keeps raw `assignor`/`assignee` next to `assignor_canon`/`assignee_canon`. Nothing about this refactor destroys shell/trust granularity.

### LATE SESSION — user pasted real production data (City National, 46 rows). Rethink required.
**v1 as built merges 0 of those 46 rows.** Tested directly. The dominant failure mode in production is **character-level OCR damage**, not punctuation/casing — so key normalization alone barely touches it.
- **`VASTER SUB II, LLC` is split across ~12 rows**: `SUB II LUC`, `SUB IL`, `SUB HU`, `SUB dI,,.`, `SUBIII LLG`, `SUBLII`, `SUBMIT`, `SUB LI`, `SUB' H,.`, `VASTER'SUB II`, `SUB II LEC`. **Every variant carrying an amount shows $95M** — the corroborating signal.
- **USER CLARIFICATION (important):** the Vaster entities are **sub-entities of one parent (Vaster)**, NOT variants of each other. `VASTER LOANS II` ($102.5M), `VASTER LOANS III` ($127.5M), `VASTER SUB II` ($95M), `VASTER MANAGEMENT` ($10M) are **separate legal entities with separate facilities** and must NOT be merged. Merging them would destroy exactly the property-shell detail the user asked to preserve.
- **Therefore three levels are needed, not two:** (1) exact entity `VASTER SUB II LLC` — what OCR breaks; (2) family — `canonicalize()` yields `VASTER LOANS` / `VASTER SUB` / `VASTER MANAGEMENT`, i.e. three families, not one; (3) **parent `VASTER` — does not exist yet.** Bug found in passing: `VASTER LOANS IH, LLC` → brand `VASTER LOANS IH`, so OCR damage prevents it from even reaching the right family.
- **Two distinct correction types that must never be conflated:** `same_as` (OCR fix — merges rows) vs `belongs_to` (parent — groups rows *without* merging, sub-entities stay individually visible).

**Signals investigated (two hypotheses killed):**
- `sponsor_address` = **2 rows**, `signatory_officer` = **7 rows** of 48,820. Scaffolded, never populated — unusable.
- `facility_agreement_name` is **generic boilerplate**, not a facility identifier ("Warehouse Mortgage Loan and Security Agreement" repeated across unrelated filings) and is itself OCR-damaged (`Warchouse`). **Weak** signal — earlier guess that it would be the strongest was wrong.
- What remains: name similarity + `facility_amount` + lender + date-range overlap. **Asymmetry:** matching amounts ⇒ same entity misread; differing amounts ⇒ normal for siblings under one parent. Amount is strong for the merge question, useless for the parent question.

**Existing infrastructure found — extend, do not reinvent:** `client/src/pages/Entities.tsx:57` already has a "Duplicate review & merge tool", backed by `GET /api/aliases`, `POST /api/aliases/merge` (records the rule AND cascades the merge, re-pointing earlier merges whose target is now itself merged), `DELETE /api/aliases/:variant`. `alias_suggestion_dismissals` exists too.

**Three safe rules proposed (measured: absorb 5 of the 46 rows — `VASTER SUB II` core, Winston, PFG Loan Funder):**
1. Punctuation → **space, not deletion** (`VASTER'SUB II` currently keys to `VASTERSUB II`, matching nothing).
2. Known OCR misreads of LLC (`LEC`/`LUC`/`LLG`/`LCC`/`IIC`), final position only, **and only applied when the corrected name already exists in the data** — a "confirmed landing" turns a guess into a verified match.
3. Absent suffix matches any suffix; **conflicting suffixes never match** (`X LLC` ≠ `X INC`). Ambiguous case (bare name could match both `X LLC` and `X INC`) — undecided.
All automatic merges to be logged as reversible entries; nothing silent.

**Open design questions — user stopped here, to discuss fresh:**
(a) Does the user define parents, or does the tool propose clusters for confirmation? (Prefix inference is unsafe in general: `BANK OF AMERICA` vs `BANK OF THE OZARKS`.)
(b) Review surface: extend the existing Entities merge tool, or a new parent-hierarchy view?
(c) Rule 3's ambiguous case: flag for review, or leave untouched?
Claude's leaning: parents curated by the user with tool-proposed candidates, reviewed in an extended version of the existing merge tool.

### Open / next session
1. **BLOCKED: production snapshot.** Local DB has only **11** `credit_facility_events` rows (prod had 86+ pre-backfill) and **46** `pdf_extractions`, so the facility side is untestable locally and the 2 migrated aliases match nothing here — those DB-backed parity checks currently pass *vacuously* (the script says so in its own output; synthetic tests cover the mechanism). Droplet is **password-auth** — user's `id_ed25519` is not installed (`Permission denied (publickey)`), though the host is in `known_hosts`. Plan: `ssh-copy-id root@165.22.35.75`, then `scp root@165.22.35.75:/opt/amo-dashboard/miami_dade_amo.db ./prod_snapshot.db`. User has the root password in their notes.
2. Then: point both harnesses at the snapshot, produce the merge/split review list, and only then wire the server + client. **Three things must move in lockstep or they break silently:** the hand-written JS twin `nameKey()` at `client/src/pages/CreditFacilities.tsx:82` (drives Pledge/Release labels and 3rd-party chips — already mislabeled once, `f8f19d6`), the four `COALESCE(lender_key, UPPER(name))` sites in `server/routes.ts` (654/739/788/813), and `/filings?lender=&borrower=` URL params (changing key format breaks bookmarks).
3. `assignor_parent`/`assignee_parent` exist on `aom_events_clean` but are populated on **9 of 48,820 rows** — a scaffolded, never-built corporate-hierarchy feature. Natural next feature now that both key levels exist; deliberately NOT bundled into this plumbing change.
4. **SECURITY, user to action 2026-08-05:** a GitHub PAT (`ghp_…`) sits in plaintext in the `origin` remote URL in `.git/config`, on this Mac and almost certainly on the droplet. Verified it was **never committed** (`git log --all -S` clean) and is not in shell history — but classic PATs are account-wide and GitHub secret scanning never saw it, so nothing auto-revokes it. **Repo is PUBLIC.** Plan: revoke → check security log → SSH remote here → read-only deploy key on droplet.
5. Housekeeping: `run_weekly.sh` exec bit had drifted again (restored, undoing a re-break of `0deb97f`). `miami_dade_amo.db-shm`/`-wal` show as deleted locally (sqlite checkpointed them on read) — **deliberately not committed**, since they are tracked from before the gitignore rule and interact with `git pull` against the live prod DB.

---

## 2026-07-22 — UX round built while backfill runs (commit `31fd48c` — NOT yet deployed)

All 7 proposed enhancements from 2026-07-20 implemented in `CreditFacilities.tsx` + small `routes.ts` changes, verified in-browser locally (login: dev default password, form_input not synthetic keypress — CDP Enter doesn't trigger implicit form submit; requestSubmit() confirmed the handler):
1. Top Lenders click-to-filter (toggle: click again clears; ring highlight on active)
2. Enter applies filters (filter grid is now a real `<form>`; Apply is type=submit)
3. Type chips show filing counts from by_facility_type (already-fetched data)
4. "Active" badge (green, emerald) on rows with a filing in last 90 days (`isRecentlyActive`, client-side)
5. Expansion summary line: "N filings · N pledges · N releases · $X in underlying mortgages" (mortgage part hidden when all loan_amounts null)
6. CSV export: toolbar button above table exports full filtered+sorted set (client fetches `limit=5000`); small "CSV" button in expansion exports that facility's filing history
7. ⓘ methodology tooltips (title-attr) on all four stat cards
Server: `/facilities` limit cap 500→5000 (export path); **top_lenders chart LIMIT 15 removed** — the cap would have silently frozen the "Distinct Lenders" stat at 15 once historical data landed (client slices its own top-8 for display).
**Deploy (after backfill, or anytime): `git pull && npm run build && pm2 restart amo-dashboard`.**
Backfill status at time of writing: ~21.6k pending of ~55k total (started 2023-01-03 inventory-wide), ~1,300/hr, ETA Thu afternoon; nightly normalize cron live at 08:30 UTC.
Known pre-existing console warning (not from this round): wouter `<a>`-in-`<a>` nesting in `Sidebar.tsx` — flagged as separate cleanup task.

---

## 2026-07-21 — Full-history backfill kicked off (to 2023-01-03) + droplet resized 4 vCPU/8GB

User decision: backfill facility extraction over ALL collected history to make Lending Relationships robust. Key facts established:
- **The `assignments` inventory already starts at exactly 2023-01-03** (52,906 docs through 2026-07-13 locally) — no re-scraping needed; document *text* is never stored, each doc is downloaded+OCR'd on the droplet at extraction time (that's the bottleneck, not OpenAI).
- Remaining backlog ≈ 43–44k docs. Estimated API cost **~$5–11 total** (gpt-4.1-nano via Batch API at 50% off; ~$0.00024/doc measured at standard pricing). Sanity anchor: the ~9.3k-doc June window should read ~$1–2.50 on the OpenAI usage dashboard; full run ≈ 4.7× that.
- **Droplet resized 2026-07-21: Basic $48/mo, 4 vCPU / 8GB / 160GB** (was 1 vCPU; panel showed the pre-resize plan as $12/mo 1 vCPU/2GB — the "1GB" previously in docs was stale). Disk-inclusive resize, so it can't be downsized later. Data survived (resize keeps disk; pipeline state is all in DB / at OpenAI anyway).
- Code pushed: `fba9a38` removed `--since 2026-01-16` from `run_facility_tick.sh` (6-month window fully processed; tick now works backward through history, newest first); follow-up commit adds `--max-concurrent 4` + CLAUDE.md/.cursor spec updates. OCR workers auto-scale to 4 via `os.cpu_count()`.
- **Expected duration ~2–3 days at 4 vCPU** (was ~9 days at 1 vCPU / ~200 docs/hr observed). Watch: chunk builds of 500 docs now run ~4 workers; chunk size deliberately left at 500.
- **CRITICAL fix found same evening (`5e23b89`): tesseract OpenMP oversubscription.** First 4-worker run on the new box failed 100% of its chunk — every doc `timed out after 180 seconds`. Cause: tesseract spawns ~4 OpenMP threads *per process*; 4 workers × 4 threads = 16 threads on 4 cores. Fix: `OMP_THREAD_LIMIT=1` in the tesseract subprocess env (both `batch_extract_facility.py` and `extract_pdfs.py`). Recovery procedure used: `pkill -f batch_extract_facility.py` + `rm collector/batch/tick.lock` (killed run's claimed docs auto-release after the 1h stale-building timeout). **Measured post-fix throughput: ~20–25 docs/min ≈ 1,300/hr** (input file growth 213KB/min, ~9KB/doc) — ~6× the 1-vCPU rate.
- `0f22834`: tick now runs `python3 -u` so tick.log streams live — before this, a *healthy* run looked stalled (buffered stdout; only error bursts and the flush=True `[250/500]` checkpoints appeared). Diagnosing progress without logs: watch the newest `collector/batch/input_NN.jsonl` grow (`ls -la`, repeat). A 0-byte input file = the chunk failed entirely.
- Two chronic stragglers keep county-read-timing-out (`2026R323533`, `2026R331200`, 60s read timeout, likely oversized scans) — harmless retry loop; bump download timeout if they still fail after the backfill.
- **Nightly normalize cron INSTALLED** (`run_nightly_normalize.sh`, crontab `30 8 * * *` = 4:30 AM Eastern; droplet clock is UTC): rebuilds derived tables then `pm2 restart` to bust the 7-day cache; on normalize failure it skips the restart so the app keeps serving last good data. Droplet crontab now has 3 entries: weekly Fri 06:00, tick every 20 min, nightly 08:30 UTC.
- Also still open from 2026-07-20: the 7 proposed UX enhancements (approved-pending discussion), facility-type over-labeling prompt fix (21/21 gate), AXOS/PAM possible dupes.

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

### UI round (commits `9824ab9` → `7c667fb` — **pending deploy**: `git pull && npm run build && pm2 restart amo-dashboard`, no normalize re-run needed)
- **Tab renamed "Credit Facilities" → "Lending Relationships"** (user choice via options; URL `/credit-facilities` kept for bookmarks). "Facility Size" column → **"Credit Limit"** (expansion meta line still says "Facility size: … (credit limit|note principal)" on purpose — it carries the amount-type qualifier).
- **Sortable columns**: all six headers toggle desc → asc → default (filings DESC, amount DESC). Server-side (`sort`/`dir` params on `/facilities`, whitelisted, `COLLATE NOCASE` on text) so correct across pagination.
- **Direction column** in filing history: labels each filing **Pledge** (collateral → bank) or **Release** (bank → collateral out). **Lender-anchored on purpose** — the bank must be a recorded party; borrower-only matches show "—" (a third party assigning TO the borrower is an acquisition, not a facility release — was briefly mislabeled, fixed in `f8f19d6`). Matching = JS twin of `facility_name_key()` + containment fallback (≥8 chars both sides, so "CITY NATIONAL BANK" matches the full name but "PAM" can't false-match).
- **"3rd party" chips + footnote**: recorded assignor/assignee matching neither lender nor borrower key gets an amber chip; when any filing in an expansion has one, a footnote under the table explains the logic (filings are tied to a facility by the agreement cited in their document text, not by recorded names — third party ≈ affiliate co-borrower or prior holder of a warehoused loan). Driven by user hitting "SRUTI LLC" in the Vaster facility and asking what it was.
- Header "Recorded Parties" → "Assignor → Assignee".
- **CFN numbers in filing history are now links** to the county Clerk document endpoint (`375088c`, same URL pattern as other tabs; external-link icon kept as secondary affordance; stopPropagation so clicking doesn't toggle the quote row). **User confirmed deployed through `375088c`.**

### Proposed next round (user said "discuss tomorrow" — 7 easy-lift UX enhancements, NOT yet approved)
1. Top Lenders list clickable → fills lender filter. 2. Enter key applies filters (form submit). 3. Type filter chips show counts (data already fetched via by_facility_type). 4. "Active" badge for facilities with a filing in last 90 days. 5. Expansion header summary line ("10 filings · 6 pledges · 2 releases · $X collateral moved" — computable from filings response). 6. Export CSV of filtered table / filing history. 7. Methodology ⓘ tooltips on stat cards (esp. volume dedupe). Deliberately excluded: linking facility names to Entities tab (different extraction pipelines, links would misfire).

**New data-quality observation (2026-07-20 evening):** in the 6-month production window every row is typed `warehouse_or_revolving_credit_facility` — including Amerant loans to named individuals (obvious HELOCs, which the older pilot data correctly tagged consumer) and the $1.94B JPMorgan ESA deal (reads syndicated). The extractor appears to be over-applying the warehouse label. Fix belongs in `FACILITY_SYSTEM_PROMPT` type definitions → requires the 21/21 `verify_integration.py` gate, same as open item below.

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

## 2026-07-22 (later) — Sidebar nested-anchor fix

Fixed the `validateDOMNesting: <a> cannot appear as a descendant of <a>` console warning that fired on every page. Cause: `Sidebar.tsx` wrapped a styled `<a>` inside wouter's `<Link>`, but wouter v3 renders its own `<a>` and forwards props. Moved `className`/`data-testid` onto `<Link>` and removed the inner anchor. Verified on local dev (port 5050): 0 nested anchors in DOM, nav routing + active-state styling intact, console clean. Committed `f89b21f`, pushed to origin/main. No other Link-wrapping-anchor patterns exist in the client.
