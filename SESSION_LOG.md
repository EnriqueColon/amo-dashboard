# AMO Dashboard — Session Log

Read this at the start of a session before re-deriving context. Most recent entry first. Keep entries dense (facts, not narrative) — this file exists to cut future token spend, so prune/compact old entries rather than letting it grow unbounded.

---

## 2026-09-22 — Droplet exposed to Claude as MCP tools; production figures re-derived

**Context.** Owner asked what MCP is, then whether a specific droplet could be connected to Claude.
Built it. Commit `ea4d63e`, pushed.

**Built: `tools/droplet-mcp/`** — stdio MCP server, runs on the dev machine, SSHes out. Nothing
installed on the droplet, no new credential. Registered user-scope as `amo-droplet`. Seven tools:
`pipeline_status`, `git_state`, `tail_log`, `db_query` (read-only), `restart_app`, `deploy`,
`run_collector`. Full write-up is §6.4a of the Confluence page; `smoke-test.mjs` exercises it.

**Design decisions worth keeping.**
- No arbitrary-command tool. Every remote command is fixed strings + validated enum/integer args.
- `db_query` runs `sqlite3 -readonly` — writes are rejected by the engine, not by a check.
- `deploy` bundles pull + build + restart so the build step cannot be skipped (§6.4's standing
  hazard), and requires `confirm:true`. `run_collector` likewise.
- `git_state` compares `dist/index.cjs` mtime to the HEAD commit date. This is the useful question —
  `git log` only tells you what was fetched, not what is running.
- SQL goes over stdin and `tail_log`'s filter is base64'd in transit, so neither is spliced into a
  remote shell command line.

**Gotcha that cost the most time.** MCP clients spawn servers with a stripped environment, so
`SSH_AUTH_SOCK` is absent and every call failed `Permission denied (publickey)` — while the identical
`ssh` from a normal shell worked. The on-disk key is passphrase-protected, so `ssh -i` +
`IdentitiesOnly` does **not** work around it (verified: still denied). Fix is
`launchctl getenv SSH_AUTH_SOCK` at server startup on macOS. On Linux, export it in the client env.

**Found immediately by the new `git_state`:** droplet is at `d0d3f97` (pulled), but `dist/index.cjs`
dates from 19 Sep — so the 15/30/360 email was **pulled but never built**, and the live site still
sends the old 15-day template. Deploy is on hold by owner instruction, so this is intended; §7.3's
wording ("not yet pulled to the droplet") was simply wrong and is corrected.

**§7.2 production figures re-derived against live** (they had drifted; §1 "At a glance" was far
staler still, carrying 114,100/18,000/44,585). Now: filings 150,336 (M-D 106,158 / BRW 44,178), loan
transfers 56,484 (54,974 / 1,510), other assignments 18,939, market transfers 30,218, documents read
108,316. The exact query behind each figure is now recorded in §7.2 so the next reviewer can
reproduce them instead of guessing at definitions.

**Open, and the reason to read this entry:** the **entity count does not reconcile.** Overview's own
query (distinct `assignor_canon` ∪ `assignee_canon` over `aom_events_clean`) returns **10,431**;
this page last published **21,517**. Nothing reproduces 21,517 — `entity_classifications` is 25,042,
`entity_nodes` is 10,431. So either the canonicaliser merged roughly half the address book unnoticed,
or the published number was never the Overview's measure. Every *other* figure moved as a week of
collection would predict, so it is isolated to entities. Logged as §7.4 item −6 with a next step
(diff `entity_nodes` against a pre-21 Sep backup). **Do not quote an entity count outward until
settled.**

**Also noted:** the GitHub PAT in the `origin` remote URL is still live and in plaintext — already
§7.6 item 1, unchanged, flagged again to the owner this session.

---

## 2026-09-21 — Weekly email rebuilt as a 15/30/360-day roll-up, county-separated

**Context.** Owner asked (19 Sep) for the email as a roll-up over "last 15 days, last month, and the
last 360 days … with charts so they can see changes from those time frames". A complete
implementation already existed uncommitted on the dev machine as `server/email/rollupReport.ts`
(written 21 Sep 08:28, 579 lines) but was untracked, imported by nothing, and held a literal NUL byte
in source — the same defect commit `b6e7474` fixed in the old report. `sendWeeklyReport.ts` was still
calling the old 15-day `buildWeeklyReport`.

**Done this session.**
1. Fixed the NUL (`'\u0000'` escape, not a raw byte).
2. Added county separation, which the roll-up lacked and the old email had. Rendered as a
   colour-coded line under each row plus a county-stacked magnitude bar — NOT `M-D`/`BRW` columns:
   the tables already carry 15D/30D/360D, and six numeric columns wrap in Outlook and on phones.
   Covers the three headline cards (`byCounty`), transaction mix (new `mixCounty` per window),
   sellers/buyers (`c30`/`c360` in `board()`), and top pairs (`c30`). Pace chart was already
   per-county.
3. **Crash guard.** With no county rows the per-county SQL collapsed to `WHERE ()` and died on a
   SQLite syntax error — exactly the state `normalize.py` leaves the table in for ~90 min nightly.
   `buildRollupReport` now returns an empty report when `counties` is empty; `sendWeeklyReport`'s
   existing `cleanCount === 0` guard refuses to send it. Verified all three paths: empty+preview,
   empty+`--send` (blocked, exit 2), real data+preview.
4. Wired `sendWeeklyReport.ts` to `buildRollupReport`. `REPORT_START_DATE`/`REPORT_END_DATE` replaced
   by `REPORT_SEND_DATE`. Added `server/scripts/previewRollup.ts` (preview-only renderer).

**Preview against live data** (read-only: `sqlite3 .backup` copy to `/tmp`, files copied up, rendered,
pulled back, everything removed; PM2 untouched, droplet `git status` unchanged). 15d 745 transfers
(+31%), 30d 1,314 (−22%), 360d 11,504 (+15%). Broward 243 of 745 in 15d but only 674 of 11,504 in
360d — coverage began 22 Jul 2026, so the 30d and 360d comparisons correctly print "Miami-Dade only"
and will until ~Jul 2027.

**Gotchas found.**
- Local DBs at the repo root (`../miami_dade_amo.db`, `../prod_snapshot.db`) are **empty shells**; the
  real ones are inside `amo-dashboard/` (105 MB / 51 MB). Pointing `AMO_DB_PATH` at the shell is what
  surfaced the crash bug. Neither local DB has any Broward rows — county work must be previewed
  against the droplet.
- The Monday email cron (`0 13 21 9 *`) fired at 13:00 UTC on 21 Sep and sent the **old** template to
  andres@/david@. Confirmed in `collector/weekend/email.log`.

**Not deployed.** The droplet still has the previous template. `run_weekly.sh` and `monday_email.sh`
invoke the script through `tsx` from source, so a `git pull` alone changes what Friday
(`0 6 * * 5`, 06:00 UTC) sends — no `npm run build` needed for this change. Old 15-day builder left in
place at `server/email/report.ts`, unused, until the roll-up has sent cleanly a few times.

**Still open.** Entity duplicates split leaderboard rows ("CITY NATIONAL BANK OF FLORIDA" vs "CITY
NATIONAL BANK"; earlier "CAPITAL ONE" vs "CAPITAL ONE N A") — more visible in a top-8 list than in
the old email's longer tables.

---

## 2026-09-18 — QC reviewed, owner confirmed all 6 fixes; built, dry-run, weekend running

**QC review** (run `20260917T2100Z`, reviewed Fri AM — the review task ran ~16 h late, weekend job
sat at P0 from 06:05 to 13:50 UTC). Fix list `docs/qc/QC_FIX_LIST_2026-09-17.md`; owner: "confirm
all". Read 9 documents. Corrections to the QC's own verdicts: its direction text rule was wrong on
all 3 flags read; "facility tick failing" is NOT an outage (backlog done 9 Sep, new docs ingest fine,
the same 14 docs time out every 20 min, one 3,843×); AIT's 126 "error" days are the county never
returning AIT at all; 6 of 8 zero days are county closures (3 separate searches months apart found
neighbours but nothing that day). **New: ~7,700 MD rows (14%) still showed a homeowner as seller** —
the 09-16 rule only fired when the document party was a classifier-known institution; MERS (4,330)
and unknown companies (3,372: Forethought Life, FDIC...) slipped through.

**Built (commit "QC weekend fixes 1-6"), applied Saturday by `collector/weekend/apply_weekend_fixes.sh`:**
1. `collector/document_direction.py` — bucket by AI parties vs index (D1..D5), swap D3/D4 unless an
   independent text check on `document_text` says forward (→ keep + review). Text rule fixed 4 ways
   against real misreads: address blanking (Coppell "C/O NATIONSTAR"), payer recital ("received
   from ALATKA"), MERS nominee phrase, form layout "Assignor: X … Assignee: Y" bounded at the next
   label. On 6,400 re-read docs: agrees with D3 swaps 275/276, D4 270/279; false "reversed" on D1
   0.9%, D2 3.4%. Bucket ties (CITIMORTGAGE→CITIBANK fold, "TRUST … BY U.S. BANK") never swap.
   Decisions → `direction_decisions` (rebuilt each run; no UI yet).
2. `prefer_document_party(broad=True)`: index person + document names anything with an org marker
   (incl. MERS) → document. Guard: if it would make both sides one canonical, fall back to narrow.
3. MERS: step 0 of `resolve_entity_type` (behavioural rule was typing it BANK). MERS on EITHER side
   → MERS_RELEASE (to-MERS used to fall to PRIVATE in SQL / INSTITUTIONAL_OUT in Python).
4. Overrides: FaceBank, Benworth, Homebridge, Rushmore, First Citizens &/AND, Chase Home Lending
   2023-RPL1, **WILMINGTON SAVING (no S) was never matched — 404 rows**, Wilmington Trust, MAM MGMT.
   Baseline tsv updated for the same inputs only (92 expectations).
5. Types: Casa Finance, Newtek, Intl Mortgage Brokers → PRIVATE_CREDIT; FaceBank BANK; MAM SERVICER;
   National Homebuyers Fund GSE. **Side effect caught in dry run:** fix 2 removed the homeowner
   counterparties that made 133 lenders pass the behavioural BANK threshold (≥5 in-counterparties)
   → ~1,100 market transfers lost. Pinned 49 of them to their previous type
   (`_PINNED_TYPES_2026_09_18`).
6. `extract_pdfs.py --limit 20` in the apply step (4 rows the facility tick created today).

**Dry run** (local, snapshot 13:42 UTC, old code vs new on the same copy — compare like with like:
the snapshot itself carries Friday's LLM types, see below): 7,520 swapped; WF→Nationstar 1,494→1,811,
"Nationstar→WF 284" gone; homeowner sellers 7,697→64; MERS_RELEASE 4→8,239; self-assign 3,561→3,169.

**Found: nightly normalize discards Friday's LLM entity types** (Northern Trust BANK→OTHER every
night) — the real cause of the Thu 31,095 → Fri 38,312 market-transfer swing. Logged §7.4 −5.

**Ops:** `/weekend` progress page (`server/weekend.ts`, read-only, deployed `8ecb7eb`). Nightly
normalize now skips if another normalize runs. Re-read ~1,800 docs/h, ETA Sat ~4 PM ET. Apply script
dry-runs on a copy first and checks numbers before touching production; avoids 06:30–10:30 UTC.

---

## 2026-09-17 (later) — Email live on Graph; summary body; filter tooltips; direction bug found

**Email (Microsoft Graph).** Owner entered GRAPH_* on the droplet via hidden `read -s` prompt
(never through chat). Tenant ID was pasted twice (74 chars) — fixed in place without displaying it.
`.env` → `chmod 600`. `--check` passed. Email now shares Reporting's exclusion list
(`server/reporting/exclusions.ts`: Wilmington Savings, MERS, Fannie, Freddie) — 651 → 514 rows.
**Body redesigned** (owner chose): the 50 "most recent rows" were all Broward (collected daily, so
always newest) and hid Miami-Dade's 60%. Now a summary from every row — per-county coverage with each
county's own dates, top 10 seller→buyer pairs, top 8 sellers/buyers, Largest Deals (one row per loan
via `loanVolume.ts`), transaction mix — all split by county; dollars only in Largest Deals. Two tests
sent to `mktinfo@safeharborcp.com` + `enriquec012@outlook.com` only. **`run_weekly.sh` step 5** sends
last, gated by `REPORT_EMAIL_ENABLED=1` (**not set** — awaiting owner OK for andres@/david@), waits for
any `normalize.py` (Friday runs end 09:00–10:05 UTC, overlapping the 08:30 nightly rebuild), and uses
`set -a` because GRAPH_* lines lack `export`. Send script refuses a 0-row report. **Gotcha:** an Edit
wrote two literal NUL bytes for a ` ` separator — code ran, but git/grep treated report.ts as
binary. Fixed; scan for NULs after writing escape sequences. Outlook ignores CSS max-width, so long
cells are truncated in code.

**Filter tooltips.** Every filter/view button (Reporting, Clean Transactions, Lending Relationships,
UCC, Entities, Raw Assignments, entity report, county + FDIC selectors) shows a plain-English
definition via `FilterHint` + `client/src/lib/filterDefinitions.ts` (one vocabulary app-wide).
Replaced native `title`s. Coverage check: 60 options / 13 lists, 0 missing. **Not clicked through —
the app needs a login.** Finding while writing them: **UCC Collateral vs Other doesn't separate
anything** — both hold the same mix of originals/terminations/continuations; tooltip says so.

**Direction bug found (queued as tonight's #6, discuss first per owner).** Checking "Wells Fargo →
Freedom Mortgage 127" (true: 137 — 127 distinct CFNs, 6 days, every document says WF → Freedom;
recording dates, not sale dates — Jun 45, Jul 128, Aug 30, Sep 127). **3,566 Miami-Dade rows (6.8%)
are shown in reverse** where both parties are institutions — the 09-16 fix only handled
person→institution. Read 9 disputed documents (3 pairs × 3): all 9 label "(ASSIGNOR)"/"(ASSIGNEE)"
matching the extracted parties, not the county index; control 4/4 agreed. JPMorgan↔FDIC not yet read
(no 2025–26 filings). Broward unaffected. Dashboard's "Nationstar → Wells Fargo 284" top relationship
is really the reverse.

---

## 2026-09-17 — Dollar volume counted each loan once per filing; whole-tool audit

**Audit first (read-only, `health_audit.py` in scratch).** Verified: parties 99% from documents,
homeowner bug effectively 0 left; 0 duplicate CFNs; loan amount accurate where shown (20/20);
blanks genuine (40/40). **Open bugs found, not yet fixed:** MERS typed BANK so 2,758 MERS nominee
filings count as MARKET_TRANSFER and MERS ranks #2 seller (`MERS_RELEASE` fires 4 times); 23 CAPPED
days are the biggest bulk-sale days (109–145 held vs 57 normal) and are truncated; entity splits
(FaceBank ×3, Benworth 84/80, Homebridge "FINCANCIAL", First Citizens &/AND); ~32% assignor typed
OTHER incl. real banks; 2026-05-08 and 2024-05-10 possibly missing days. 135 ERROR windows are almost
all weekends/holidays — harmless. **Audit mistake caught:** the first party check ran
`_looks_like_person` on canonical names, which have "BANK, N.A." stripped — reported 52%, true figure
~0. Measure on the raw field.

**The fix.** A big loan is filed once per step with the full amount each time (portfolio loan
against every building; securitisation chain). One $2.95B loan: 10 filings, 6 party pairs, 8
properties, 2 dates. Rule in `server/reporting/loanVolume.ts`: same exact amount in the same row set
within 31 days is one loan — **≥$1M only** (below that, round residential amounts genuinely recur).
Judged inside the filtered set; per-firm totals partition by firm or the 2nd firm in a chain gets $0.
Applied to entity report (the only screen showing $), participants and monthly chart (served, not
displayed). Label now **"$ Volume (est.) · each loan counted once"**.

**Measured as the screen computes it:** market $150.9B → $86.7B (−43%); Wells Fargo $16.7B → $9.7B;
Goldman $15.0B → $10.7B; Barclays $5.5B → $1.9B; **Bank of America unchanged $4.9B** (no repeats —
negative control).

**I misreported the size first.** Told the owner Goldman showed $66.7B. It never did: that audit query
counted self-assignments and both sides of each filing. `check-loan-volume.ts` asserted against it and
**failed on first run against production**, which is how it surfaced. Corrected in `a1815b8`; the
earlier commit message `caa69a0` still carries the wrong figure. *Compute before/after the way the
screen computes it.*

**Verification that is reusable:** auth is `checkAuth` middleware in `server/index.ts`, separate from
`registerRoutes` — so the real routes can be mounted on a private 127.0.0.1 port against a
`VACUUM INTO` copy of the DB and hit end-to-end without credentials or touching production. Did that:
all three endpoints 200 and matching verified figures. Then build → restart, no DB change, no blank
window. `script/check-loan-volume.ts` (11 checks, needs real DB, skips without).

**Unrelated, pre-existing:** error log holds 84 × `Cannot destructure property 'password'` — login
POST with no body returns 500 rather than 400. Last seen 2026-09-15. Low priority.

---

## 2026-09-16 — The Assignor column was showing the homeowner, not the seller

Owner looked at his own Reporting tab and asked *"does this seem repetitive, is it giving good
information?"* The repetition was real and correct. The information was not.

**The repetition first, because it is the thing that looks broken and isn't.** 53 rows of
`WELLS FARGO → FREEDOM MORTGAGE` on 2026-09-10 are 53 distinct CFNs — a bulk servicing transfer,
each loan its own recorded document. Showing them separately is right. They *look* like duplicates
because the column that distinguishes them — property — was blank or junk. **A blank distinguishing
column makes correct data look like a bug.**

**The actual bug.** The table renders `assignor_canon`, built from the county index's grantor. The
index lists *every* party on a filing, which for an assignment routinely includes the original
borrower. Top row of his screen: `SOSA JAIME → FREEDOM MORTGAGE`. The document says
`WELLS FARGO BANK, NA → FREEDOM MORTGAGE CORPORATION`. **Sosa Jaime is the homeowner.** Sized at
~12,000 rows (22%) by a corporate-marker heuristic.

Note the expand panel was *already* showing the right parties from `pdf_assignor`/`pdf_assignee` —
the correct data was one click away the whole time, and the charts and Lending Relationships were
never affected. Only the table display was wrong.

**Three dry runs, three rejected drafts.** This is the part worth keeping:

| Draft | Dry-run verdict |
|---|---|
| Prefer the document's party everywhere | **52% of canonical names changed.** The index is clerk-typed and clean; the document is OCR'd. `FV-1 INC` → `FY-I, INC. IN TRUST FOR MORGAN STANLEY…` — the key identifier is OCR damage, and the entity fragments away from its own other filings. Also demoted `LOAN STORE` (BANK) to `THE LOAN STORE` (OTHER). |
| Fire whenever the classifier says `OTHER` | `OTHER` covers a homeowner **and** every company the classifier has no pattern for. Merged `ONITY MORTGAGE CORP` into `PHH MORTGAGE` — a change of *identity*, not a correction. |
| Fire only where the index name carries **no organisational marker at all** | 4,821 assignor + 656 assignee rows. Every sample is the real shape: `CAYEMITTE,MARIE → GOLDMAN SACHS`, `LARRAIN JUAN → FANNIE MAE`, `PAZ PEDRO C SR → US BANK`. **Shipped.** |

So: **the index wins on spelling, the document wins on which party** — and only the second was ever
broken. `_looks_like_person()` exists because `classify_canonical()` cannot tell a homeowner from an
unrecognised company; both come back `OTHER`, and conflating them is what produced drafts 1 and 2.

`assignor_type` is re-derived from the name actually reported — the index's classification described
a different string, which is how a bank ended up labelled OTHER.

**Property column — same lesson, inverted.** 1,519 rows held prose, not an address:
`AS DESCRIBED IN SAID MORTGAGE` (162), `not explicitly stated` (120), `not specified` (90), bare
counties (92), and **borrower names** — *"Said Mortgage was made by GISELE M…"* — which is a privacy
problem in a column labelled Property. Prose also silently breaks the property filter and the CSV
export.

**The first draft of that fix cleared 4,552 rows, and it was wrong**: it discarded platted legal
descriptions (`Lot 13, Block 2, of LYNWOOD, according to the Plat thereof…`) and condominium unit
numbers, which identify a parcel *more* precisely than a street address. Kept. Final rule clears
1,519 — accept anything carrying a street number, a PO box, or a lot/block/section/unit reference.

**Party HQ addresses — the first rule was wrong and was replaced after deploy.** Freedom Mortgage's
Boca Raton office sat in the Property column on 118 rows. The first attempt keyed on repetition
(*"≥15 filings sharing ≤2 buyers is a mailroom"*) and **failed in both directions**: it missed Yamato
Road, because the buyer has four spellings once the OCR variant `FREDOM MORTGAGE` is counted, and it
caught a genuine platted legal description that happened to repeat. *Repetition cannot separate a
busy property from a mailroom.*

The working rule uses `sponsor_address`, which the extractor already stores as each document's party
mailing address: **a string that three or more documents list as a party's own address is an office,
whatever column it later appears in.** Separation is clean enough that the low threshold is safe —
known offices appear as a party address **10–351 times**, the real properties in the same size band
appear **0 or 1**, and nothing sits in between. Cleared 445 rows across 54 addresses, every one an
office: suite numbers, a penthouse, and out-of-state servicing centres in Monroe LA, Meriden CT,
Marlton NJ and Detroit MI. *A Miami-Dade mortgage is not secured by a building in Michigan.*

Applied as a direct column UPDATE (commit `c126a0b`) rather than a fourth rebuild — it changes one
field and needs no re-derivation, so it cost a `pm2 restart` instead of 90 minutes of downtime.

**Also found, NOT fixed** (told the owner explicitly rather than rushing it before his meeting):
- **Loan amount is only 57% populated** (50% for 2026), and dollar figures are core to the tool's
  purpose. Needs re-reading documents; wrong amounts are worse than blank ones.
- ~130 ASG rows titled `ASSIGNMENT OF PERMITS AND AGREEMENTS` and similar are genuinely `OTHER`, not
  `COLLATERAL`.

**Operational.** `normalize.py` empties `aom_events_clean` and refills in place, so the live
Reporting tab reads **zero rows for the ~90 minutes it runs** — the owner hit exactly that and asked
if it was normal. The 7-day response cache normally hides it; an uncached filter combination goes
straight to SQLite. A follow-up task is queued to rebuild into scratch tables and swap atomically.
**Until that lands, treat every normalize run as dashboard downtime.**

Commits `75cf0bb`..`ef86231` (the `wip:` ones are dry-run iterations; `ef86231` carries the
reasoning — history not rewritten because the droplet had already pulled them).

---

## 2026-09-15 (later) — "Collateral" now means collateral: 6,040 rent assignments moved out

The second half of the same bucket. Last night's fix pulled 9,604 loan sales **out** of COLLATERAL;
this one pulls out the rent and lease assignments, which were the majority of what remained.

**What they were.** 6,040 filings that are ordinary property-level security instruments — a landlord
assigning tenant rents to its own lender, recorded alongside the mortgage. Six were fetched and read
first, and all six said the same thing:

> "Grantor hereby assigns, **grants a continuing security interest** in, and conveys to Lender all of
> Grantor's right, title, and interest in and to **the Rents** … THIS ASSIGNMENT IS GIVEN TO SECURE
> (1) PAYMENT OF THE INDEBTEDNESS"

No loan changes hands and no loan is pledged. While they sat in COLLATERAL they outnumbered the
genuine pledges **four to one**, which is what made that filter useless for its actual purpose —
seeing who finances whom.

**Not one population, four.** The sizing query alone would have produced the wrong rule. 24
documents were read across the four title shapes before anything was written:

    A  "ASSIGNMENT OF RENTS"                     1,404  → RENTS_LEASES  (plain rents pledge)
    B  "COLLATERAL ASSIGNMENT OF LEASES/RENTS"   2,138  → RENTS_LEASES  (same thing, "collateral" is
                                                                         the manner, not the asset)
    C  "…RIGHT TO COLLECT ASSESSMENTS…"            437  → stays COLLATERAL — a condo association
                                                          pledging receivables to a bank for its own
                                                          borrowing is exactly what the bucket means
    D  "ASSIGNMENT OF MORTGAGE" under ASG/AST       ~300 → LOAN_TRANSFER (6/6 sampled were outright
                                                          transfers to servicers and trustees)

**The cheap half.** The deciding question is *what is being assigned*, and the recorded title states
it — so this needed **no downloads, no OCR and no LLM**, just `doc_title`, a column already stored.
Seconds, against six hours for last night's equivalent. `reclassify_rents.py`, judgment in
`extract_pdfs.reclassify_rents_by_title`. A **regex, not a list of titles**: the population is 365
spellings of the same few instruments, much of it OCR damage — `COLEATERAL`, `COELATERAL`,
`COLLATERALASSIGNMENT`, `ASSIGNMENT OF-RENTS`. An exact-match list would have missed hundreds.

**Two traps, both asserted in `check_doc_category.py` rather than assumed:**

1. **"Collateral" in a title describes the manner, not the asset.** `COLLATERAL ASSIGNMENT OF LEASES
   AND RENTS` (828 rows) is still a rents instrument. Reading it the other way would have left the
   largest single group in place.
2. **The text test's `LOAN_TRANSFER` fallback reads absence of pledge language as a conveyance** —
   only sound once the subject is known to be a debt instrument. AMO's doc type guarantees that; the
   generic **ASG does not**, since it also carries permits, contracts and development rights.
   Extending the text test to ASG without gating it on the title naming a debt instrument would have
   filed **building permits as loan sales** into Reporting's default view. Hence
   `_cat_text_eligible()`, and negative controls for `ASSIGNMENT OF PERMITS AND AGREEMENTS`,
   `ASSIGNMENT OF AGREEMENTS AFFECTING REAL ESTATE` and a bare `ASSIGNMENT`.

**One near-miss worth keeping.** The first draft reused the new broad title regex for the *body*
test. A bare `\bLEASES?\b` against a full OCR body fires on nearly every commercial mortgage
assignment ever recorded — they routinely recite the leases they sweep in — which would have
silently stopped last night's AMO transfer correction from working on new documents. The body
pattern is now deliberately separate and narrow (`_CAT_RENTS_BODY`), with a comment saying why.

**Result (Miami-Dade + Broward, 2026-09-15 23:00 UTC):**

    ASG   COLLATERAL   7,547 → 1,671        ASG RENTS_LEASES   5,896 → 11,773
    AMO   COLLATERAL   1,842 → 1,771        AST COLLATERAL       372 →    279
    UCC   COLLATERAL  20,522 → 20,522  ← unchanged, and that is the guardrail

UCC is excluded by **doc type, before its title is read**: two of its titles do mention leases, and
all 20,522 of its filings genuinely are collateral records. `check_doc_category.py` now asserts that
with a lease-titled UCC fixture.

**Evidence is stored this time.** The 447 affirmed-collateral rows carry a `doc_category_evidence`
quote saying why they survived a pass that moved 6,000 of their neighbours. The test distinguishes a
verdict the rule **affirmed** (must cite evidence) from one it merely **declined to overturn** (must
not) — `DECLINED_TO_DECIDE`. Inventing a citation for a verdict nothing supports is how the original
bug read from the outside.

**Operational note.** The chained run's phase 2 failed first time because the droplet's checkout
predated the `--doc-types` commit — `git pull` on the droplet is a step, not an assumption, and the
phases are chained precisely so a half-written `doc_category` never reaches `normalize.py`. Rerun
launched waiting on the first chain's PID.

Commits `a09622e`, `fe6288b`.

---

## 2026-09-14 — facility_type: the model was not the right tool for the judgement

**The bug, measured:** 623 of 625 production rows read
`warehouse_or_revolving_credit_facility`, 2 read anything else, and
`syndicated_credit_agreement` had **zero** rows despite being offered. Consistent across all four
years, so not a regression — it shipped that way.

**Why the 21/21 gate never caught it.** `verify_integration.py` compared only
`ftype not in (None, 'none')` — detection, never the type. *A field no test asserts is a field
nothing protects.* The gate now asserts `facility_type` for the ten known warehouse documents.

**Root cause in the prompt:** `FACILITY_SYSTEM_PROMPT` gave ~30 lines on WHETHER a facility exists
and **zero guidance on choosing among the four types** — they appeared only in the JSON schema. Its
single worked example ended `facility_type="warehouse_or_revolving_credit_facility"`, anchoring the
model to the value listed first in the enum.

**Adding type rules to the prompt was NOT enough — 6 of 16 sampled failures fixed.** Documents whose
own name read "Commercial NON-Revolving Line of Credit" still came back revolving, and
"Security Instrument" still came back as a facility, with explicit rules for both in the prompt.
gpt-4.1-nano does not reliably apply a rule list that long.

**So the judgement moved out of the model.** `classify_facility_type(agreement_name, evidence_quote)`
in `extract_pdfs.py` is a pure function, called from the shared `postprocess_facility()` so the
real-time and Batch API paths cannot drift. The model still extracts — it is good at that, the
agreement names in production are accurate and specific — and code decides the category.
**End-to-end this fixes 15 of 16**, and the prompt improvements were kept (they cost nothing).

Distribution over all 625 existing rows, applying the rules to fields already in the DB:

    warehouse   623 -> 298      none        0 -> 263
    consumer      2 ->  53      syndicated  0 ->  11

**Two rules that only real data would have taught:**
- `facility_agent_name` is **not** trustworthy as a syndication signal — it holds the bare string
  `'Agent'` and property-company names like `'Slate Property Group'`. Requiring the agent PHRASE in
  the name or evidence took syndicated from an implausible 33 to a defensible 11.
- The warehouse pattern must be **OCR-tolerant**: `Warchouse Mortgage Loan and Security Agreement`
  is a real production value (tesseract reads the 'e' as 'c') and a strict `warehous` drops that
  document — one the 21/21 gate covers — to `none`. Pattern is now `wa?r[ec]h[o0][uv]s`.

**New: `collector/tests/check_facility_type.py`** — 23 rules asserted against real production
agreement names, **offline, no API key, no network, instant**, with a negative control that disables
the warehouse rule and requires the canonical case to stop passing. The existing integration gate
costs money and ~10 minutes; this one can run on every change.

**Verified:** `21/21` detection + `10/10` facility_type, RESULT PASS, with the classifier live.

**NOT YET APPLIED TO PRODUCTION DATA**, pending the owner's go-ahead — it moves **260 documents out
of the facility dataset**, visible on Lending Relationships.

**The correction needs NO re-extraction.** Asked how long a backfill would take, checked rather than
estimated: all 625 rows already store `facility_agreement_name` AND `facility_evidence_quote`, and
`classify_facility_type` is a pure function of exactly those two. So it is arithmetic over columns we
hold — no downloads, no OCR, no LLM calls. **`collector/reclassify_facility_types.py` (new) does it
in 0.2s for $0**, with a dry-run default. Dry run on a scratch copy: 324 of 625 rows change →
warehouse 300 · none 261 · consumer 53 · syndicated 11.

The hour in that job is `normalize.py` rebuilding `credit_facility_events` (~60–85 min, detached),
then `pm2 restart` for the 7-day response cache. Runbook is in Confluence §6.8.

*Note `batch_extract_facility.py` selects `WHERE px.facility_type IS NULL`, so it would never have
picked these rows up — a re-extraction route would have needed its own targeted query anyway.*

**What this cannot fix: false negatives.** A document already read as `none` stores no agreement
name, so nothing can reconsider it without re-extracting all 107,402 documents (~$25, ~a day). Not
warranted on current evidence. Also still open from §7 item 7: the field-level defects (empty
`facility_lender_name`, `facility_amount` contradicting its own evidence quote).

---

## 2026-09-14 (later) — owner spotted a false label on the Reporting tab

Owner, from a screenshot of the Collateral view: *"Is this an error?"* Yes — two, one of them mine.

### FIXED: the Class column asserted "LoanSale" about documents that were not loan sales
`deriveClassification()` reads `txn_type`, which is only meaningful for loan transfers. That was a
safe assumption until 2026-09-11, because the table held nothing else **by construction**. The
`Shows` filter broke it: CFN `2026R626049` is an **ASSIGNMENT OF RENTS**, `doc_category=COLLATERAL`,
`txn_type=ORIGINATION` — and the column read **LoanSale**. Scale: **13,721** collateral rows carry
`PRIVATE` and **3,399** `ORIGINATION`, so the label was wrong on every non-loan row.

A row that is not a loan transfer now states its category (`Collateral` / `Rents & leases` /
`Other`), styled neutral grey — these are facts about the document, not review verdicts, and
colouring them like verdicts would imply a judgement nobody made. A manual `classification` still
wins over everything. Verified: the mixed "All documents" view shows 36 LoanSale beside Collateral,
Rents & leases and Other on one page, each correct. **Exports were never affected** — they write the
raw `classification` column and never derived a label.

*Lesson: a derived display value carries an assumption about its input set. Widening the set is
exactly when that assumption silently becomes a lie, and it renders as confident text.*

### NOT FIXED, and worse than it looks: canonicalize() mangles and MERGES property LLCs
The same screenshot showed assignors reading `YTA`, `HOUSE`, `PRODUCE`, `HOLDINGS`,
`SE 2ND AVE 709 710`. `canonicalize()` strips leading numbers:

    7190 HOLDINGS LLC -> HOLDINGS    11440 HOUSE LLC -> HOUSE
    1347 PRODUCE LLC  -> PRODUCE     150 SE 2ND AVE 709 710 LLC -> SE 2ND AVE 709 710

**1,752 filings across 1,113 distinct companies** lose a leading number. The display damage is
cosmetic; the real harm is **merging unrelated firms**: `INVESTMENTS` is **22 different companies**
(748 / 2325 / 1051 / 3624 / 25800 / 691 INVESTMENTS LLC …) counted as one entity, `HOLDINGS` is 15.
Any entity profile or ranking for those names sums unrelated businesses.

**This PREDATES all of this week's work** — but it was effectively hidden, because loan transfers are
institution-to-institution and rarely involve property LLCs. The category filter surfaced precisely
the population where it bites. It is also the exact trap that was avoided on the UCC page
(`10820 INVESTMENTS LLC` vs `11140 INVESTMENTS LLC`) — the miss was not checking whether the same
function was already doing it to the assignment data.

**Fix needs care, not a quick patch:** don't strip a leading number when what remains is a generic
word, then rehearse on a snapshot, then a full `normalize.py`. It touches `entity_nodes`,
`entity_relationships` and every entity page.

### NOT INVESTIGATED: "ASSIGNMENT OF RENTS" categorised COLLATERAL
`2026R626049` again. Plausibly should be `RENTS_LEASES`. Same class of problem as the facility_type
bug — the model choosing among categories — and worth sampling before concluding.

---

## 2026-09-14 (later still) — canonicalize() stopped merging unrelated companies

Follow-on from the owner's screenshot. `canonicalize()` line 852 was
`re.sub(r'^[^A-Z]+', '', s)` — strip EVERY leading non-letter. Intended for OCR junk, it also ate
the street number that identifies a South Florida property company:

    7190 HOLDINGS LLC -> HOLDINGS      1347 PRODUCE LLC -> PRODUCE
    11440 HOUSE LLC   -> HOUSE         150 SE 2ND AVE 709 710 LLC -> SE 2ND AVE 709 710

**1,752 filings / 1,113 companies.** The display damage was cosmetic; the real harm was **merging**:
`INVESTMENTS` was **47 unrelated firms** counted as one entity, `HOLDINGS` 45. Predates everything
this week — loan transfers are institution-to-institution, so it stayed hidden until the category
filter surfaced the collateral population where property LLCs live.

**The first fix was wrong and the data said so.** Keeping all digits over-corrected (one trust split
across three spellings), so magnitude was tried: strip a leading number under 100 as a "sequence
prefix". Rehearsed, aggregates looked fine. Then `54 INVESTMENTS LLC` was still collapsing, and
checking why produced the counter-evidence: `10 COLEE LLC`, `11 SOUTH LLC`,
`12 WEST 29 STREET LLC`, `11 OCCAM LLC`, `1 OAK RICHLAND LLC`, `1 DOLLAR PLUS LLC` — **small leading
numbers are overwhelmingly REAL street numbers here.** That rule would have turned `11 SOUTH LLC`
into `SOUTH` and recreated the same merge for a different set of firms.

**Shipped rule: strip a leading ZERO only** — `001 FOUNDATIONAL FAMILY TRUST` (sequence number),
`0 0WELLS FARGO BANK NA` (OCR digit-fusion). Everything else stays. Plus a guard so suffix stripping
cannot leave a bare number (`1104 LLC` stays `1104 LLC`, not `1104`).

**Accepted trade-off, stated explicitly:** where a leading digit really was noise
(`1 SHARPE OPPORTUNITY TRUST` beside the bare form) the two now stay separate. *A split entity is
visible on the Entities page and mergeable by hand; a false merge fabricates a company nobody can
spot.* Be wrong in the direction a human can see.

**Rehearsed on an isolated copy** (`/tmp/rehearse_run`, production checkout never modified):

    entity_nodes  18,383 -> 18,416      US BANK 6,663 · MERS 3,177 · JPM 2,854 · WFC 2,815 unchanged
    INVESTMENTS / HOLDINGS / HOUSE / PRODUCE / SOUTH / COLEE as entities: NONE remain
    2026R622700 -> 7190 HOLDINGS · 2026R626510 -> 11440 HOUSE · 2026R628600 -> 1347 PRODUCE

`aom_events_clean` +19 and `credit_facility_events` +1 are **documents extracted since the last
production normalize**, not an effect of this change — the include decision keys on doc_type and
doc_category, never on names.

**Guardrails:** `canonicalize_baseline.tsv` regenerated (45,262 names, the project's review artifact)
and new **`collector/tests/check_leading_numbers.py`** — 22 rules offline, no DB, asserting both
directions: five different `INVESTMENTS` companies must yield five names, US Bank's spellings must
yield one. That second assertion is what the old code would have failed.

**A test I wrote was itself wrong, worth remembering:** it asserted `U.S. BANK, N.A.` should merge.
Checking the data, **zero names contain periods** — the county index stores `U S BANK N A`. An
invented input tests nothing. *Take fixtures from the data, not from intuition.*

**SEPARATE pre-existing bug found doing that, NOT fixed:** `U S BANK N A` (space between N and A)
never reaches `US BANK` — the override matches `NA` but not `N A`. Verified identical in the git
baseline, so it is not a regression. **1,084 filings**: `CAPITAL ONE N A` 140, `U S BANK N A` 77,
`BANKUNITED N A` 69, `BANK OF NEW YORK MELLON TRUST COMPANY N A` 40, `AMERANT BANK N A` 22. Same
symptom the owner spotted, different mechanism — an override-pattern gap, not leading numbers.

---

## 2026-09-14 (last) — spaced abbreviations: "U S BANK N A" now reaches US BANK

The gap found while writing the previous fix's test. `STRIP_SUFFIXES` had `r'\bN\.?A\.?\b'` —
an optional PERIOD between the letters, never a space — and the county records these letter by
letter. So `U S BANK NA` canonicalised to `US BANK` while `U S BANK N A` did not, leaving one
institution in two places. **1,084 filings**: `CAPITAL ONE N A` 140, `U S BANK N A` 77,
`BANKUNITED N A` 69, `BANK OF NEW YORK MELLON TRUST COMPANY N A` 40, `AMERANT BANK N A` 22.

Bigger than just N A once measured: **5,326** name occurrences end in ` N A`, plus `L L C` 127,
`P A` 33, `F S B` 19 — and mid-string forms like `CITIBANK N A AS TRUSTEE`,
`COMPUTERSHARE TRUST CO N A TRU`. Added `\bN\s+A\b`, `\bL\s+L\s+C\b`, `\bF\s+S\s+B\b`,
`\bP\s+A\b` as SEPARATE patterns rather than loosening the existing ones to `[\s.]?`, which would
also match the start of a two-word phrase like "N A REALTY"; separate lines stay reviewable.

**That alone was not enough.** Overrides run BEFORE suffix stripping, and the US Bank override
required a TRUST/NA/NATIONAL suffix: `U\.?\s*S\.?\s*BANK\s+NA|...`. With ` N A` present it
matched nothing, fell through, stripped to `U S BANK`, and stopped — still not `US BANK`. Loosened to
`U\.?\s*S\.?\s*BANK\b`, which the data says is safe: every `U*S*BANK*` name in production is a
US Bank variant (`N A CO`, `N TRU`, `NAL ASSN`, `NAT TRU`, `TRUSY N A` — OCR for TRUST), **`BANK`
must follow `U S` directly so `U S CENTURY BANK` is untouched**, and `\b` keeps it clear of
`U S BANKRUPTCY COURT`. Both are asserted in the test.

Effect over the 45,262-name baseline: **278 names change, distinct canonical names 37,404 → 37,291
(-113)** — merging, the opposite direction to the leading-number fix, as intended.
`US BANK` absorbs **+32** spellings, `TERRABANK` +3, `AMERANT BANK` +2, `BANKUNITED` +2.

Production still shows **58 entities ending in ` N A`**; they clear on the next `normalize.py`.

*Two fixes, opposite directions, same root complaint from one screenshot: names that should be one
were many, and names that should be many were one.*

---

## 2026-09-15 — 9,604 loan sales were filed as "collateral" and are now back

Owner pointed at one row on the Collateral view and asked *"is this an error?"* It was, and it was
21% of AMO volume.

`2026R626356` — county doc type **AMO**, title **"ASSIGNMENT OF MORTGAGE"**, Mortgage Assets
Management → **SECRETARY OF HUD**, $544,185, $10 consideration — sat in COLLATERAL, so
normalize.py's loan-transfer filter kept it out of Reporting. **11,366 AMO filings were in that
state**, of which 10,593 had titles that never mention collateral.

**32 documents were fetched and read before any code was written.** That is the step that made this
safe:

    SUSPECT   20 (title silent)   ALL outright transfers, ZERO pledge language
    PLAUSIBLE  6 (title says so)  all genuinely collateral
    CONTROL    6 (known good)     indistinguishable from the suspects

Suspects read *"does hereby assign, transfer, convey, set over, and deliver to: SECRETARY OF HOUSING
AND URBAN DEVELOPMENT, **forever without recourse**"* and *"did **grant, bargain, sell, assign,
transfer and set over**"*. Genuine ones read *"**collaterally assign**"* or *"for better **securing
the repayment of the Loan**"* to a party named **Lender**. Note *"without recourse" appears in BOTH*
and is not a discriminator on its own.

**Root cause, the third instance of one shape.** The prompt defines COLLATERAL as a pledge
*"(no outright transfer)"* — deciding clause in a trailing parenthetical, no positive anchor for a
plain assignment — while **every** mortgage assignment is saturated with "security" and "securing",
because a mortgage IS a security instrument. The model answered on ambient vocabulary.
*Same shape as facility_type and as the Class column: a categorical judgement the model is bad at,
with the discriminator buried.*

**Fix:** `reclassify_collateral()` in `extract_pdfs.py` — only ever OVERTURNS a COLLATERAL verdict
the document does not support, never invents one, never touches a non-AMO filing. Prompt improved
too, since it costs nothing.

**Result on production:**

    aom_events_clean      46,100 -> 55,704     (+9,604, +21%)
    aom_events_nonloan    28,591 -> 19,072
    AMO still COLLATERAL  11,366 ->  1,842     (genuine, each with a stored evidence quote)
    UCC COLLATERAL        20,522 -> 20,522     (unchanged — the boundary held)
    entity_nodes          18,349 -> 21,517     market transfers 21,454 -> 26,699

Newly visible top relationships: `MORTGAGE ASSETS MANAGEMENT → SECRETARY OF HOUSING AND URBAN DEV`
(271 — the owner's exact document) and `FEDERAL DEPOSIT INSURANCE → JPMORGAN CHASE` (247).

**§7.2 of Confluence is now corrected.** It had warned since August that pre-17-Aug figures were
*overstated*; that correction **overshot** and everything quoted 17 Aug → 15 Sep **understated**
transfer activity by about a fifth.

### Two process failures worth not repeating
1. **The backfill first accumulated all 11,366 updates in memory and wrote once at the end** — six
   hours with nothing in the DB, a crash at hour five losing everything, and a docstring claiming it
   was resumable when it could not be. Caught one minute in by checking whether the count had moved.
   Now commits every 100.
2. **`pkill -f` matched its own command string and killed the ssh shell instead of the target**, so
   the old process survived and the relaunch produced TWO concurrent runs — 16 downloads against the
   clerk instead of the tuned 8. *Kill long jobs by PID, never by pattern.* This bit twice today.

**`doc_category_evidence` is now stored.** Facility extraction has had an evidence quote since day
one and that is precisely what made its bug auditable from stored data; `doc_category` had none,
which is why this correction cost a 6-hour re-OCR instead of a query. **The next audit of this field
is free.**

**NOT fixed, deliberately:** the generic `ASG` type has its OWN wrong-bucket problem — **1,375
documents titled "ASSIGNMENT OF RENTS" sit in COLLATERAL**, plus 384 "ASSIGNMENT OF LEASES, RENTS
AND PROFITS". Applying this rule there would flip them to LOAN_TRANSFER and swap one error for
another. `check_doc_category.py` asserts they are left alone. Needs its own sample and its own rule.

---

## ⏭ NEXT SESSION — what is still open (as of 2026-09-11)

**Everything the owner set on 1 Sep is now closed and deployed.** Droplet at `ff75f35`, local clean,
nothing running. The week's work — coverage audit, AIT fix, UCC collection + extraction, both
Reporting filters, the UCC page — is in the dated entries below.

### Open, engineering
1. **Facility TYPE over-labelling.** Nearly everything recent reads
   `warehouse_or_revolving_credit_facility`, including obvious consumer HELOCs and a syndicated deal.
   Touches `FACILITY_SYSTEM_PROMPT` → **any prompt edit must re-pass
   `collector/research/scripts/verify_integration.py` at 21/21 first.** Longest-standing open bug.
2. **23 CAPPED days of truncated assignment history** (`collection_log`, 2023-01-11 … 2026-02-03).
   The portal caps a search at ~500 index rows and the splitter cannot go below one day. Recovery
   needs a **narrower axis than date** — party name or book range. Those days hold 109–145 documents
   against a 2024 daily average of 59, consistent with truncation.
3. **`run_weekly.sh` looks back only 10 days**, so a window that errors ages out of retry range
   within roughly one run. EMPTY windows stay retry-eligible by design; ERROR ones do not.
4. **Broward is index-only for 41,970 filings** — no image, no book/page, so unreadable and
   deliberately excluded from `aom_events_nonloan`. Blocked on the bulk image order, not on code.
5. **UCC party direction is right ~90% of the time, not 100%.** Rows whose lender was read off the
   document are flagged; the rest inherit the county's unreliable order and are marked amber. If
   this becomes a problem, the fix is a targeted extraction prompt for UCC forms (debtor / secured
   party are explicit fields on the form).
6. **Lender name variants still split** where the difference is not case, punctuation, or a known
   trailing legal phrase — e.g. `U.S, CENTURY BANK` (OCR comma). Deliberately conservative: the
   general `canonicalize()` must NOT be used here, it collapses `10820 INVESTMENTS LLC` and
   `11140 INVESTMENTS LLC` into one fictional entity.

### Open, needs the owner rather than an engineer
- 🔴 **Revoke the leaked GitHub PAT** — plaintext in `.git/config` on this Mac and the droplet, public
  repo. Open since 4 Aug, the oldest item and the only one with security consequences.
- 📧 **Azure app registration** so the weekly emailed report can send — see [[amo-email-reports]].
- 📞 **Broward bulk image order**, 954-831-4000 — unlocks item 4 above, ~41,900 documents.
- 🔑 **DigitalOcean Space + key** for the backup job, which currently copies to the disk it protects.
- ⚠️ **`.env`'s `AMO_PASSWORD` has drifted from what PM2 holds.** A `pm2 delete` + fresh start would
  silently change the dashboard password. Reconcile before anyone does that.

### Possible next pieces of work, not committed
- A **UCC entity page** (click a lender, see its filings and counterparties), mirroring the Reporting
  entity report.
- Fold UCC data into the **emailed weekly report**, once that can actually send.
- The **`doc_category` filter for Broward** — currently every Broward row is unread, so the filter is
  empty for that county.

---

## 2026-09-11 — UCC page: consumer finance hidden by default

**Owner added three more, 2026-09-11:** Cross River Bank, Climate First Bank, Florida Housing
Finance Corporation. Banks by charter but not CRE lenders here — Cross River files as
`c/o Sunlight Financial` and `c/o Marlette Servicing`, which is consumer origination. Patterns also
catch OCR variants (`and its successors and assians`, `FLORIDA HOUSING FINANCE AGENCY`).
**21,110 → 20,305 (38% of the original 32,759).**

**Grouping key improved at the same time.** `RBI MORTGAGES LLC` and `RBI MORTGAGES LLC, A FLORIDA
LIMITED LIABILITY COMPANY` were one lender counted twice — #3 with 363 and #14 with 157 instead of
**#2 with 520**. `uccNameKey` now also strips fixed trailing legal phrases
(`AND ITS SUCCESSORS AND ASSIGNS`, `A FLORIDA LIMITED LIABILITY COMPANY`, …). Verified against live
data: every key it merges has exactly two variants, all the same company, and `RBI MORTGAGES` vs
`REI MORTGAGES` correctly stay separate. Still nothing like `canonicalize()` — no leading numbers,
no corporate form stripped.

Owner, on seeing the page: *"seems to have noise. Eg solar inclusions we don't need to see those."*
Correct, and it was the noise predicted when this bucket was first sized.

`UCC_NON_CRE_PATTERNS` hides solar/home-improvement financiers and non-lender filing agents and
utilities. **32,759 → 21,110, i.e. 36%.** Hidden by DEFAULT with a visible toggle; nothing deleted.

**Patterns, not exact names** — the same lender files as `SOLAR MOSAIC LLC`, `Solar Mosaic, Inc` and
OCR-damaged `op|EPL Energy Services`. Each pattern was checked against live data for false positives:
every `%ENERGY%` hit is an FPL utility-financing entity, and
`FIFTH THIRD BANK, N.A., SUCCESSOR BY MERGER WITH DIVIDEND SOLAR FINANCE LLC` is caught while Fifth
Third's commercial arm is not.

**The first version only checked the lender column and leaked 2,293 filings** — spotted by reading
the rendered table, where `SERVICE FINANCE COMPANY → GOFF, SABRINA` and `Goodleap, LLC → —` were
plainly consumer filings with the financier in the BORROWER position. Because the party order is
unreliable, the match must run against **both** sides. *Generalisable: any party-name filter on this
dataset has to check both columns, for the same reason the column labels needed the PDF.*

Top lenders with it on, which is the point of the page:
`CITY NATIONAL BANK OF FLORIDA 731 · RBI PRIVATE LENDING 414 · RBI MORTGAGES 363 · POPULAR BANK 349 ·
U.S. CENTURY 274 · OCEAN BANK 260 · CROSS RIVER 246 · BANKUNITED 222`.

**Also confirmed here: production DB integrity is `ok`.** A local copy made with `.backup` during
concurrent writes came out malformed (`idx_pdfx_county already exists`) and briefly looked like
corruption. `VACUUM INTO` + `md5sum` on both ends is the reliable way to take a copy; the first
transfer's checksum matched but an earlier partial one did not.

### 2026-09-11 (later) — UCC Filings page, and the party-direction trap it exposed

Built `/ucc`: borrower, lender, property, collateral type, amount. Reads live from
`assignments ⋈ pdf_extractions` (32,759 rows on an indexed key is fast, always current, and avoids a
fourth derived table). Endpoints `/api/ucc`, `/api/ucc/parties`, `/api/ucc/chart`, `/api/ucc/export`.

**THE IMPORTANT FINDING — the county index does not order UCC parties consistently.** Nearly shipped
columns labelled Borrower/Lender straight off `grantor`/`grantee`, which would have been wrong on
roughly a third of rows. Caught it because a sample row read `FIRSTBANK OF PUERTO RICO → COLD STORAGE
185TH ST LLC` — a bank as the borrower. Measured, over the 21,352 filings with both sources:

    bank-like name in    first party   second party   ratio
    county index            2,851         4,256       1 : 1.5   <- noisy
    PDF extraction          1,643         6,029       1 : 3.7   <- clean

Known lender names sit in the index's `grantor` column **3,256** times against 7,268 in `grantee`.
The extractor read the form and gets it right even when the index is reversed
(`AMERANT BANK NA → HARVEST HOLDINGS LLC` in the index; `Harvest Holdings, LLC. → Amerant Bank, N.A.`
from the PDF). So: **PDF first, index as fallback, applied per side** — lender coverage is 90%,
borrower 74%, so requiring both would have thrown away good lender data.

The correction moves the headline numbers: GoodLeap 2,526 → **2,764**, ISPC 1,390 → **1,619**,
Aqua 669 → **917**, City National 499 → **731**. The index-based counts understated real lenders by
15–45%. `roles_confirmed` is returned per row, shown as an amber marker, filterable via
**Roles from document**, and exported as its own CSV column. *Same lesson as the Reporting merge
decision: check which party is which before labelling a column.*

**Names are deliberately NOT canonicalized.** `canonicalize()` strips leading numbers, so on this
dataset it collapses `10820 INVESTMENTS LLC`, `11140 INVESTMENTS LLC` and `1260 INVESTMENTS INC` into
one fictional `INVESTMENTS` — UCC borrowers are overwhelmingly property LLCs named after street
numbers. Grouping for the "most active" panels uses case+punctuation folding only
(`Amerant Bank, N.A.` = `AMERANT BANK NA`), which cannot merge unrelated firms. Distinct lenders
12,981 → 8,241 on that basis alone. Cost: `CROSS RIVER BANK` and
`Cross River Bank and its successors and assigns` stay separate, and display casing is mixed.

**Production normalize run completed** (launched detached, ~1h): `aom_events_clean` 46,051 → 46,081
(+30 from this morning's newly extracted filings, not from the change), **`aom_events_nonloan`
28,576** (COLLATERAL 19,272 · RENTS_LEASES 6,105 · OTHER 3,199) with **41,977 correctly skipped as
not yet read**. `entity_nodes` 18,383 and `credit_facility_events` 625 both **unchanged**, which was
the whole point of the sibling-table design. Guardrail green on production.

### 2026-09-11 — the `doc_category` half: sibling table + category filter

Owner set the purpose explicitly: *"who is buying loans and from who… dollar amounts… the collateral
or property… what competitors are doing, and who is lending, and selling loans to who."* That
settled the FST question — **two surfaces, not one** — on evidence, not taste:

**The same two columns mean opposite things in the two sources.** In an assignment the first party
is the institution SELLING the loan (`COMMUNITY LOAN SERVICING → NATIONSTAR`). In a UCC filing it is
the BORROWER (`JAJ COLLINS AVE LLC → VASTER LOANS`, `SUAREZ RUBEN → CORNING FCU`). Merging them puts
property owners and individuals into Top Sellers — silently, with plausible-looking numbers, while
breaking the owner's primary question. Second, dollar coverage: **assignments 26,889/46,051 (58%)
vs UCC 2,243/32,751 (7%)** — a UCC-1 describes what secures a debt, not its size, so it structurally
cannot answer "dollar amounts". UCC gets its own surface (Borrower → Lender); **not built yet.**

**Built: `aom_events_nonloan`**, a sibling of `aom_events_clean` with an identical schema, holding
assignment filings that are READ but not loan transfers. `aom_events_all` is a VIEW over both
(defined in `server/db.ts`, columns listed explicitly so a future column added to one table fails
loudly instead of shifting values). Reporting picks a source by key:
`'' → aom_events_clean` (default, unchanged) · `collateral|rents|other → aom_events_nonloan` ·
`all → aom_events_all`. Table name comes from a server-side map, never the request.

**The test run caught the design error.** First pass put 19,262 rows in the sibling table, of which
**11,780 had no `doc_category` at all** — unread documents, which under a category filter is a lie.
On production that is **41,970 rows, every one a Broward AST filing with neither a book/page nor a
harvested image** (i.e. unreadable until the bulk image order lands) — more rows than everything
classified. `normalize.py` now routes to the sibling table only when `doc_category IS NOT NULL` and
prints the skipped count. Those rows remain on Raw Assignments, which is where unprocessed index
data belongs.

**Two silent bugs fixed on the way, both found by testing rather than reading:**
1. **Review marks.** `PATCH/DELETE /api/reporting/:cfn/review` wrote only to `aom_events_clean`, so
   marking a collateral filing reviewed updated **zero rows and still returned `ok:true`** — the tick
   appeared, then vanished on refresh. Both endpoints now update both tables (a CFN is in exactly
   one). `normalize.py` also collects marks from BOTH tables before the rebuild and restores AFTER
   both are populated — restoring before the sibling insert would have dropped every non-loan mark
   on each nightly run.
2. **CSV export corrupted a record.** `escape()` quoted on `,` `"` `\n` but **not `\r`**.
   `pdf_assignee` on CFN `2025R822456` reads `CL-LM\resI PURCHASER TRUST 1`; the bare CR ended the
   record for Excel and every CSV parser, splitting one filing into two plausible-looking halves.
   The only symptom was a row count one too high — which I had previously dismissed as an
   embedded-newline artifact. It was not. Now `/[,"\n\r]/`.

**Verified through the running API against a rebuilt snapshot** (`normalize.py` run end-to-end on a
copy, never on production):

    category      api      sql      | table == monthly chart
    loans        42,319   42,319    | MATCH   (default unchanged)
    collateral    4,205    4,205    | MATCH
    rents         1,965    1,965    | MATCH
    other           726      726    | MATCH
    all          49,215   49,215    | MATCH   (= 42,319+4,205+1,965+726 exactly)

Filters compose (collateral×AMO 2,045 + collateral×ASG 2,160 = 4,205). CSV exports 4,205/1,965/726
with a single category in each. `check_doc_type_scope.py` gained four assertions on the new table: no
UCC rows, no unclassified rows, no CFN in both tables, no LOAN_TRANSFER in the sibling.

*Worth keeping: selecting a category changes WHO appears. Rents & leases surfaces Greenbox Loans,
Casa Finance, Taylor Made Lending — names absent from the loan-transfer leaderboard entirely.*

**Gotcha: a `str.replace` swapping `FROM aom_events_clean` hit `/api/clean-events` too**, which has
no `src` in scope. `tsc` caught it. Audit every swap with an endpoint-attributing `awk` afterwards,
which is how it was confirmed the remaining 14 all sit inside the five Reporting endpoints.

**Superseded note — the `doc_category` half is now BUILT.** Original sizing below kept for context.
53,263 extracted documents sit outside
`aom_events_clean` (COLLATERAL 35,360 · OTHER 11,809 · RENTS_LEASES 6,094) — more than the 45,847
inside it, so this roughly doubles what Reporting can show. **Recommended approach: a sibling table,
not a widened `aom_events_clean`.** Every other page reads that table, and widening it means finding
and patching every consumer or their numbers all move — the "Most Active" miss above is the same
failure at smaller scale. Needs a `normalize.py` change plus a full re-run (~85 min), and should wait
until the FST extraction finishes so category counts are final.

Deleting `REPORTING_EXCLUDED_ENTITIES` restores previous behaviour exactly; no `normalize.py` change,
no schema change, no rebuild needed — the 7-day response cache clears on `pm2 restart`.

---

## 2026-09-09 — Doc-type coverage answered; AIT root cause fixed; FST (UCC) collection added

**The question was "are we pulling all documents?" It is now answered against the LIVE portal, not
inferred from our own code.**

### Coverage: the clerk offers 79 doc types; exactly THREE are assignments
`ASSIGNMENT - ASG`, `ASSIGNMENT OF INTEREST - AIT`, `ASSIGNMENT OF MORTGAGE - AMO` — dumped off the
live `select#documentType`. We request all three, so **no assignment category was ever missing**.
There is no "assignment of collateral" and no "assignment of securities" doc type; those arrive
inside ASG/AMO and are identified by reading the PDF (**19,123 docs already classified
`COLLATERAL`**). Broward folds every assignment into `AST`, already verified as its only assignment
code among 65.

### AIT: the root cause was never a timeout, and it never worked at all
The portal searches in **two steps**: `POST /api/home/standardsearch` returns
`{"isValidSearch":true,"qs":"<token>"}`, then `GET /api/SearchResults/getStandardRecords?qs=` returns
rows. **For AIT step one answers `{"isValidSearch":false,"qs":null}`**, so step two is never issued
and `page.expect_response("getStandardRecords")` waited its full 45s and logged a bogus timeout
ERROR. The same `isValidSearch:false` comes back for a courthouse-closure day with no filings, so it
means **"no results", not "broken"**.

**AIT has produced ZERO rows since it was added 2026-06-16** — 55 ERROR log rows, 0 OK, 0
assignments. The previous entry's "broken since 2026-08-14" understated it by two months. Forcing it
through with `documentType=AIT` (bare code) *does* return `isValidSearch:true`, but the rows come
back as an unfiltered grab-bag — deeds, mortgages, court papers, **zero actual AIT across five sample
windows spanning 2023→2026**. That is the filter being dropped, not a workaround.

**Owner decision: KEEP AIT in `DOC_TYPES`** rather than dropping it, so collection starts
automatically if the county ever activates the type. Fixed instead by watching BOTH responses from
the moment of the click: a rejected search now returns a new **`EMPTY`** status in ~1s.
`already_collected()` still only skips `status='OK'`, so EMPTY windows stay retry-eligible **by
design** — do not "fix" that by marking them collected.

### FST (UCC financing statements) added — a bucket the same size as ASG
Measured **42.3 filings/day** over 61 real recording days (2,581 rows in the local dev DB from an
earlier exploration) ≈ 10,600/yr ≈ **~39,000 since 2023**. One-day portal comparison: AMO 86 unique
docs, ASG 47, **FST 48**.

Read 60 sample PDFs (`collector/research/fst_texts/`, unbiased most-recent sample). It is a **mix**:
real CRE lending (City National Bank of Florida 41, Popular Bank 21, U.S. Century 20, BankUnited,
Banesco, Bayview, BNY Mellon, a Wells Fargo CMBS trustee, FS CREIT) alongside heavy consumer
solar/home-improvement finance (**ISPC 359, GoodLeap 145**, Aqua, Solar Mosaic, Palmetto, Service
Finance — >25% of the bucket).

**What FST does NOT contain**, both re-checked independently rather than taken from the classifier:
- **No assignments of collateral/securities (0/60).** A keyword search matches all 60 documents only
  because the blank UCC form pre-prints "NAME of TOTAL ASSIGNEE of ASSIGNOR S/P". Form boilerplate.
- **No warehouse / pledged-mortgage-loan filings (0/60).** All 4 keyword hits were false: a condo
  named "DORAL IMPACT CENTER **WAREHOUSE** CONDOMINIUM", and "promissory notes" inside standard
  blanket-lien lists.

**An LLM triage scored 48% "relevant" — that number is NOT trustworthy and was discarded.**
Cross-checking showed it classifying the *same* secured party both ways (GoodLeap relevant 3×,
irrelevant 2×; Florida City Gas both ways; Cross River both ways). The lender-name counts above come
from the index and are solid; the percentage was not. *Lesson: cross-tab an LLM triage against a
stable key before quoting its headline number.*

**Key economic fact: the search index alone carries BOTH party names on 99% of FST filings**
(2,562/2,581; 54/54 in the live test) with no PDF, no OCR, no LLM, no cost.

### Built (all local, `tsc` + `npm run check` clean, NOT yet deployed)
- **`collect_live.py`** — `DOC_TYPES` gains FST. `do_search()` rewritten to watch both responses and
  return `EMPTY` fast; `time` imported; the deliberate no-skip-on-EMPTY choice documented at the call
  site so it is not "fixed" later.
- **`normalize.py`** — new `NON_ASSIGNMENT_DOC_TYPES` + `non_assignment_filter(alias)`, applied at
  **two** sites: the clean-events build and the raw-name signal sweep. The filter is
  `(col IS NULL OR col NOT IN (...))` — **the NULL guard is load-bearing**: `doc_type NOT IN (...)`
  is NULL for legacy pre-migration rows, which would silently drop every one of them.
- **`client/src/pages/CollectionLog.tsx`** — `EMPTY` renders as a grey `MinusCircle`, not a red X.
  AIT reports EMPTY on every run and a log full of red X's trains the reader to ignore real errors
  (same lesson as the Broward Monday false alarm).
- **`collector/tests/check_doc_type_scope.py`** — asserts FST never reaches `aom_events_clean` nor
  the signal sweep, that AMO/ASG/legacy-NULL rows survive, that aliased and unaliased filters agree,
  **plus a negative control** that empties the constant and requires the FST row to reappear.
  Production had 0 FST rows when written, so a live-only check would have passed vacuously.

**Deliberately NOT filtered: extraction.** `extract_pdfs.py` has no doc-type filter, so FST PDFs get
read and everything lands in `pdf_extractions` — the owner wants the full data. Only the
derived/analytical tables are gated. **Owner also confirmed: keep FST off the Reporting tab for
now** ("lets pull in the data in first") — folding it in later is a one-line change to
`NON_ASSIGNMENT_DOC_TYPES`.

### Verified against the live portal (scratch DB, production untouched)
    AMO   OK     361 rows → 103 docs
    ASG   OK      73 rows →  31 docs
    AIT   EMPTY    0 rows          ← ~4s, was a 45s hang logged as ERROR
    FST   OK     116 rows →  54 docs, 54/54 with BOTH party names
Whole 2-day × 4-type run: **39 seconds**. Sample FST parties: 1775 BISCAYNE DEVELOPMENT →
NATIXIS NEW YORK BRANCH, ORION HIALEAH → SYNOVUS BANK, WHITESHARK AUTO SALES → RBI PRIVATE LENDING.
Guardrail run against the dev DB's 2,581 real FST rows: none reached `aom_events_clean`.

### Runbook for the extraction backfill (NOT run — needs owner go-ahead)
Costs from this project's own measured rates ($0.000508/doc for 2 LLM calls, 1,550 docs/hr at 8
workers; re-measured $0.000241/doc for 1 call this session):
**index-only ≈ $0 / <1h · selective (~6k CRE-lender docs) ≈ $3 / ~4h · full ~39k ≈ $20 standard or
~$10 Batch API / ~25h.** `extract_pdfs.py` defaults to `BUDGET_USD=5.0`, so a full run **must** pass
`--budget` (or `OPENAI_BUDGET_USD`) or it stops a quarter of the way through. Long run → `nohup` +
`disown`, and `pm2 restart amo-dashboard` after the following `normalize.py`.

### Two gaps found along the way, both still open
1. **23 single-day windows were silently truncated** at the portal's ~500-row cap (`CAPPED`,
   2023-01-11 … 2026-02-03). `MIN_CHUNK=1` means the recursive splitter cannot go below one day, so
   those days stored what they got and nobody knows what was cut. Those days hold 109–145 unique AMO
   docs against a 2024 daily average of 58.9 — i.e. they sit at the very top of the range, which is
   consistent with truncation. A backfill needs a **narrower axis than date** (party name or book
   range). Note the ~500 cap is on *index rows*, not documents: 500 index rows collapsed to ~135
   unique CFNs.
2. **`run_weekly.sh` only looks back 10 days**, so any ERROR/CAPPED window ages out of retry range
   within roughly one run and is never revisited.

**Also: the droplet was 4 commits behind (`6effeea`)** — the FDIC trend-window fix (`09f6cf0`) and
the Graph mailer (`e853307`) are pushed but NOT live. Deploy needed independently of this work.

---

## 2026-09-01 — Email: SMTP still blocked, Graph transport built; Aug-23 extraction gap confirmed healed

**Status question from the user ("is the email ready to go?"). Answer: everything except the network path.** Content approved, code deployed, app password installed — but DO's outbound SMTP block is still in force: `nc -zv smtp-mail.outlook.com 587` times out on all 8 IPv4 addresses (IPv6 "unreachable" is just no v6 route, ignore). `nc -zv graph.microsoft.com 443` **succeeds**.

**Built + pushed `e853307`:** `server/email/graphMailer.ts` — app-only client-credentials token, `sendViaGraph`, and `verifyGraphAccess` (token + mailbox read, sends nothing). `sendWeeklyReport.ts` gained transport selection (auto → graph when `GRAPH_CLIENT_ID` set, else smtp; `REPORT_TRANSPORT` forces) and a **`--check`** flag. SMTP path untouched in case DO relents. Attachment guard under Graph's ~4MB request cap; 403 handler names the likely consent/ApplicationAccessPolicy cause. `tsc` clean; both missing-credential paths verified to produce actionable errors, not stack noise.

**Blocked ONLY on Azure app registration** (tenant/client id + secret, APPLICATION `Mail.Send` admin-consented → `/opt/amo-dashboard/.env`). Needs an M365 admin if the user isn't one. Recommend an ApplicationAccessPolicy — app-only Mail.Send otherwise grants send-as for every mailbox in the tenant. DO support ticket remains a parallel option; still unknown whether one was ever filed.

**Two things verified on live production while here:**
- Droplet preview off live data works: **607 clean events / 222 relationships** for 2026-08-17→09-01. `npx tsx` runs fine on the droplet (devDeps present).
- **The 2026-08-23 extraction gap healed.** That same window: 640 clean rows, **362 with loan_amount (57%), 380 with property (59%)** — squarely in the historical 40–60% band, so the catch-up run completed and the Friday runs have extracted properly since. No session had recorded the outcome.

**Process note:** the correct status lived in the `amo-email-reports` memory (updated 08-26), NOT in this log — the log's newest email entry was 08-19 and said "blocked on app password", which led to two wrong answers to the user before the memory was read. When a question is about a feature's readiness, read the memory file for it before answering from the log.

---

## 2026-08-24 — Broward "collection stopped" was a FALSE ALARM (banner fixed); FDIC direction audit clean; FDIC trend window was too narrow for its own metric (fixed).

Three threads. Nothing was lost in any. Threads 1–2 are **deployed** (pushed through `6effeea`, built, `pm2 restart`, crontab replaced with `30 15,19,23 * * *`). Thread 3 is **local and NOT deployed** — needs `git pull` + `npm run build` + `pm2 restart amo-dashboard` (no crontab or DB change).

### Thread 1 — the Broward alarm was measuring the wrong thing
User reported the Overview banner: "collection may have stopped — no images harvested in 2 days … last ran 2026-08-22 12:30:40". **The job never stopped.** It ran 08-23 and 08-24 at 12:30, both clean, both ending "✅ every day currently on the feed has been harvested". Every day that has aged off the feed reached `complete`; 08-05 rolled off today fully harvested.

**Why it fired.** `browardLastHarvest` = `MAX(broward_images.harvested_at)` > 48h. That measures when data last ARRIVED, and Broward publishes **business days only, ~3 business days behind**. Sat 08-22 was the last harvest; Sun+Mon runs correctly found nothing new; 51h elapsed → red. **Guaranteed to fire every Monday.** The banner's own code comment claimed "harvested_at measures OUR job, not the county's schedule" — it does the opposite.

**The real defect it was masking.** Read the feed's file mtimes directly: all 10 days then on the feed landed **14:27–15:28 UTC** (outliers 20:29, 20:52), e.g. 08-19's index at 08-24 14:28 and img.zip at 14:50. Cron ran **12:30 UTC** against a comment citing an observed window of "10:27–11:01 UTC". So for ≥2 weeks the harvester arrived ~2h BEFORE each drop and collected it on the *following* day's run — working, but spending a day of the 10-day margin and letting the weekend gap reach 48h.

**Built:**
- `run_broward_daily.sh`: schedule → **`30 15,19,23 * * *`** (three polls beat guessing a moving publication time; a no-op run is ~free — 0 index rows, harvester skips complete days, extraction 0 pending / $0). Added `flock` (paramiko sets a connect timeout but no read timeout, so a stalled ranged read on a ~400MB zip can hang for hours); a skipped run exits 0, not 1. Rewrote the stale schedule comment with the measured mtimes.
- `broward_images.py`: `show_status()` now RETURNS a summary; new `record_run()` writes **`broward_runs`** (started/finished/status/detail/feed range/days_on_feed/days_pending/docs_pending/oldest_pending) with `busy_timeout=30000` — a lost lock race would turn a good run into a false alarm, same lesson as `run_backup.sh`'s `record()`. New flags `--record-run ok|failed --run-started --run-detail`, and the record path owns its error handling so an unreachable feed still lands a row saying why.
- `server/db.ts`: defensive `CREATE TABLE broward_runs`. `server/routes.ts`: `browardLastRun`; `broward_stale` = no run in **26h** OR last run failed; **`broward_at_risk` = `docs_pending > 0`** — the only condition here that becomes permanent. Never-run is deliberately NOT stale (missing evidence ≠ alarm). `broward_last_harvest` kept as banner context only.
- `Dashboard.tsx`: two banners. "images at risk" (names the count, the oldest pending day, the feed range) ranks above "job stopped" (which now says nothing is lost yet).
- `collector/tests/check_broward_heartbeat.py` — **green**. Stubs SFTP, no network. Asserts a quiet run reads healthy (the false-alarm case), a partly-harvested feed reports `docs_pending`/`oldest_pending`, and a failed run still leaves a row with NULL counts rather than a misleading 0.

**Lesson:** an alarm that fires predictably on a healthy system is worse than none — it trains the reader to dismiss the real one. "No new data" ≠ "not running" whenever the upstream source has its own calendar.

### Thread 2 — FDIC direction-inversion audit (prompted by the same bug found in the sibling tool)
Sibling tool had CET1 logic (lower = worse, so it inverts) copy-pasted onto CRE-to-capital (higher = worse), so its map coloured the least concentrated banks as most stressed and "top banks" listed the safest. **AMO does not have this bug.** Evidence:
- Every `getCreCapitalColor` call site (4 in `MarketAnalytics.tsx`, 5 in `InstitutionProfileDrawer.tsx`) receives a CRE-to-capital ratio. The CET1 value lives on a **confusingly adjacent field** — row `capitalRatio` (= `cet1Ratio ?? leverageRatio`) vs `capitalRatios` (the CRE-to-capital set) — and is never passed to a colour scale, only rendered as text.
- All four peer threshold tables already agreed with their `direction`.
- The composite `opportunityScore`/`earningsScore`/`vulnerabilityScore` are **hardcoded to 0** and never ranked or displayed; `getScoreColor`/`getVulnerabilityFillHex` are dead code. So the "top banks ranked backwards" symptom cannot occur here — there is no composite ranking yet. **If one is ever built, that is the moment this risk becomes live.**

**Found and fixed the other two problems they described, which ARE present:**
1. **Quadratic cohort work.** `ComparisonTable`'s peer rows rebuilt the entire cohort array *inside the per-bank cell renderer* → metrics × compared-banks × cohort-size every render (a national cohort is thousands of banks, rescanned per column, for numbers identical in every column). Hoisted into one `useMemo`.
2. **The three copies had already drifted** — `ComparisonTable` was silently **missing Net Income**, which the chart and the single-bank list both show. Consolidating is what exposed it, exactly as in the sibling tool.

**Built:** new pure module **`client/src/lib/peer-metrics.ts`** (no React, so it is testable) holding the one metric set, threshold tables, `percentileRank`, `buildPeerCohort`, `peerPercentile`. All three surfaces now iterate it. New **`script/check-metric-directions.ts`** wired into **`npm run check`** (now `tsc && tsx script/...`; also `check:types` / `check:metrics`) — asserts each table's colours agree with its declared direction, that a bank worst on all four metrics colours red on all four (and best → green on all four), that the CRE/capital scale rises with concentration, and that a CET1-shaped value would land in the top red band so it must never be passed there. **Includes a negative control**: it feeds itself a deliberately inverted table in memory and fails if it does not catch it — a check only ever shown correct input has not been shown to detect anything.

**Fixture bug worth remembering:** the first end-to-end fixture gave the "healthy" bank the LOWEST net income, so it correctly scored 25th pct / "Below Average" and the test failed. Both extremes must be consistent across all four metrics or the test proves nothing about direction.

`tsc` clean; both guardrails green.

### Thread 3 — the FDIC trend window could not satisfy the metric computed from it
Sibling tool also reported: "Net Income YoY compares quarters 4–7 against 0–3, but the query window was 18 months and returned only five quarters, so the condition was unsatisfiable." **AMO had exactly this, same numbers.** `server/fdic.ts` `buildRecentQuartersFilter()` used `setMonth(-18)`; `MarketAnalytics.tsx` sliced 8 quarters and required `niPrior4.length === 4`. Verified against the live API, not by reading: an 18-month window returns **5** distinct REPDTEs (20260331…20250331). So `hasAll8` was **never true** — `netIncomeYoYPct` was null for every institution in every region since it shipped, and the "NI YoY %" column (screening table, profile drawer, comparison table) rendered `—` forever.

Unlike the sibling tool there was **no silent weight redistribution**, because AMO has no composite score to weight (see Thread 2) — the only symptom was three columns of em-dashes, which reads exactly like an upstream FDIC gap. That is why it survived.

**The trap in the obvious fix.** FDIC bills one row per institution *per quarter* and caps a response at 10,000 rows, sorted `ASSET DESC` — so the row limit silently *is* an asset floor. Measured live:

| window | limit | quarters | institutions | asset floor |
|---|---|---|---|---|
| 18mo | 5,000 | 5 | 1,000 | $1.07B (old behaviour) |
| 27mo | 5,000 | 9 | **561** | **$2.23B** (widening alone — worse) |
| 27mo | 10,000 | 9 | 1,113 | $0.95B (shipped) |

Widening the window alone would have **nearly halved the national cohort** to buy the YoY metric. Window and limit have to move together; the reasoning is written into the function's docblock so the next person doesn't re-derive it.

**Built:**
- **`shared/fdic-window.ts`** — the window is a *contract* between the server that builds the REPDTE filter and the client that slices quarters out of it, so it now lives in one place: `TTM_QUARTERS=4`, `TREND_QUARTERS=8`, `PUBLICATION_LAG_QUARTERS=1`, `TREND_WINDOW_MONTHS=(8+1)*3=27`. Both sides import it; the client's `slice(0,8)`/`slice(4,8)` magic numbers are gone.
- Server imports it **relatively**, not via `@shared` — that alias is configured in `vite.config.ts` and `tsconfig.json` but **not in the esbuild server bundle** in `script/build.ts`, so an aliased import typechecks and then breaks `npm run build`. No server file had ever imported `@shared`, so there was no convention to follow. Verified `dist/index.cjs` inlines it with no dangling require.
- Limit default `5000` → `FDIC_PAGE_SIZE` (10,000). Server now returns **`truncated`** (`raw.length >= effectiveLimit`); `MarketAnalytics` renders a cohort line under the Target Screening List stating the count and asset floor, and that peer percentiles are relative to that set. Per the user's explicit call, **pagination was NOT attempted** — full national coverage is ~40,600 rows / ~20s / ~15MB, past the data-cache ceiling; that is the cached-data-layer job.
- **`script/check-fdic-window.ts`**, wired into `npm run check` (+ `check:fdic-window`). Offline and deterministic: simulates 24 "today" values across a year and asserts the window yields ≥ `TREND_QUARTERS` *published* quarters, modelling FDIC's publication lag (asserts the model reproduces the observed "newest REPDTE on 2026-08-24 was 20260331"). **Negative controls: 18mo AND 24mo must both still fail.** 24 matters — the naive `8 × 3` returns only 7 quarters when today falls just after a quarter close, so it would silently reintroduce the bug. 36mo must pass, so the check isn't rejecting everything.

**Verified on live FDIC data, both scopes** (ran the real `fetchFDICFinancials` path, replicated the client's computation): NI YoY went from **0 institutions** to **990 / 1,215 (81%) national** and **81 / 91 (89%) Florida**, values plausible (JPMorgan −4.5%, BankUnited +16.2%). National institution count 1,215 matches the sibling tool's figure exactly, confirming the same query.

**Lesson (same shape as Thread 1):** a metric whose input window cannot satisfy its own precondition fails *silently and permanently*, and renders identically to missing upstream data. Neither a type checker nor a passing page can catch it. The window/metric relationship has to be asserted, and the assertion has to model the upstream publication lag or it will approve a width that is one quarter short.

### Not present in AMO (checked, so nobody re-checks)
- **`metricRange` min/max normalisation flattening the Opportunity Score** (the sibling's headline: 1 → 108 institutions ≥ 70). **No such code exists.** AMO has no composite scoring at all — `opportunityScore`/`earningsScore`/`vulnerabilityScore` are declared in two type defs and assigned literal `0` in exactly one place, never read, ranked, or rendered. Nothing to un-zero and nothing to normalise; the drawer shows real *measured* fields, not scores. **If a composite is ever built, this and the Thread 2 direction risk both go live at once.**
- **The map colouring inversion.** There is **no map** — no geographic dependency (only `@jridgewell/trace-mapping`, a sourcemap util) and no choropleth surface; the `Map` hits in the pages are `new Map()`. That specific symptom has nowhere to appear here.

### Open / next session
1. **DEPLOY THREAD 3:** `git pull` + `npm run build` + `pm2 restart amo-dashboard`. No crontab or schema change. Threads 1–2 are already live.
2. **08-19 was unharvested as of midday** (published 08-24 14:28, after that day's 12:30 run). On the feed until ~09-04. First run under the new schedule was **19:30 UTC**; confirm it banked 08-19 and `docs_pending` is 0. `broward_runs` was still empty at deploy time, which is expected, not a fault — never-run is deliberately not "stale".
3. Unchanged from before: leaked GitHub PAT in `.git/config` (oldest open item), the Broward bulk image order (954-831-4000), AIT collection timeouts, the 2026-08-20 Reporting/Excel work already deployed.
4. **National FDIC coverage is still truncated by design** — ~1,113 of ~4,450 institutions, floor ~$0.95B. Community banks under $1B, the CRE-concentrated cohort this tool exists to find, remain invisible nationally. State scope is unaffected (Florida returns all 91). The UI now says so instead of implying a complete screen. Real fix is the Phase 1 cached data layer.

---

## 2026-08-23 (Sun night) — INCIDENT: two weeks of documents indexed but never extracted

**User spotted it in production: every Reporting row since ~2026-08-15 had blank amounts/property.** Root cause: `run_weekly.sh` never sourced `/opt/amo-dashboard/.env` — cron gives no environment, so the last two Friday runs (08-14, 08-21) collected fine, then `extract_pdfs.py` died on `OPENAI_API_KEY is not set` and `set -e` silently skipped extract+normalize+enrich. The 08-15→08-17 repair backfill masked it by fixing everything recorded earlier. Facility tick (which DOES source .env) kept stamping new docs `status='OK'` facility-only/no-raw_json — 177 of 206 blank rows since 08-15 carry that signature, so "status=OK" looked healthy while nothing had amounts (0/206).

**Diagnosis chain that worked:** clean rows blank → px.status all OK but loan_amount 0/206 → raw_json IS NULL on 177 (two-writers trap from 08-15) → cron.log tail showed `OPENAI_API_KEY is not set` right after "Collection complete" in both weekly runs.

**Fix `2441222` (pushed, needs droplet git pull):** run_weekly.sh now sources .env like the tick, and FAILS LOUDLY up front if the key is missing instead of half-succeeding. Recovery = pull + one manual `extract_pdfs.py --limit 1500` catch-up run (pending selection keys on `raw_json IS NULL`, so it claims exactly the missed docs); nightly 08:30 normalize + cache bust surfaces the amounts.

**Separate NEW issue spotted in the same log: AIT collection is fully broken** — every ASSIGNMENT OF INTEREST chunk timed out ("Timeout 45000ms waiting for response") in both weekly runs. AMO and ASG collect fine, so it's specific to that doc type's portal query. Zero AIT rows collected since at least 08-14. Not yet investigated.

---

## ▶ CURRENT STATE — as of 2026-08-17 (read this first)

**Both counties are live end to end.** Broward went from nothing to fully integrated between
6 and 11 Aug 2026: index → images → extraction → normalization → county-scoped UI.

| Scope | Filings | Clean | Entities | Market transfers | Range |
|---|---|---|---|---|---|
| Miami-Dade | 70,834 | 51,425 | 20,320 | 24,360 | 2023-01-03 → 2026-08-06 |
| Broward | 42,559 | 374 | 157 | 280 | 2023-01-03 → 2026-08-05 |
| All | 113,393 | 51,799 | 20,367 | 24,640 | 2023-01-03 → 2026-08-06 |

**SUPERSEDED 2026-08-17 — the repair backfill completed and the clean numbers went DOWN, correctly:**

| Scope | Filings | Clean | Entities | Market transfers |
|---|---|---|---|---|
| Miami-Dade | 71,366 | **44,034** | 17,938 | 20,076 |
| Broward | 42,761 | 551 | 219 | 406 |
| All | 114,127 | **44,585** | 18,021 | 20,482 |

**Clean fell ~51,800 → 44,585 and that is the fix, not a regression.** `normalize.py:1080` includes a
document when `doc_category` is NULL — i.e. **unread documents were counted as loan transfers by
default.** Now that all 49,838 have actually been read, Miami-Dade splits
LOAN_TRANSFER 44,025 · COLLATERAL 18,480 · RENTS_LEASES 5,816 · OTHER 3,028, and only LOAN_TRANSFER
belongs in `aom_events_clean`. **Every clean/entity/market-transfer figure before 2026-08-17 was
overstated** — collateral assignments and lease assignments were being counted as mortgage trades.
Treat older reports and screenshots accordingly.

Broward images harvested **658**, extracted **589**. Everything deployed; droplet `git status` is
**clean**; `origin/main` is current.

### Crons (all live)
    nightly 03:15 UTC run_backup.sh          verified snapshot + rotation + Spaces  (NEW 08-15)
    daily 12:30 UTC   run_broward_daily.sh   index + images + extraction  (BROWARD_INGEST_INDEX=1)
    nightly 08:30     run_nightly_normalize  normalize + PM2 cache bust   (~80 min at current scale)
    weekly Fri 06:00  run_weekly.sh          Miami-Dade collect + extract
    every 20 min      run_facility_tick.sh   facility batch backfill

### ✅ COMPLETE — the 50k repair backfill (2026-08-15 19:38 → 2026-08-17 ~04:20 UTC)

    processed   49,845     OK 49,838 · OCR_ERROR 1 · LLM_ERROR 6 · DOWNLOAD_ERROR 0
    rate        1,550/hr sustained over ~32h at 8 workers
    cost        $26.58 (210.4M in / 13.8M out tokens) against a $45 cap
    categories  LOAN_TRANSFER 30,063 · COLLATERAL 13,710 · RENTS_LEASES 3,794 · OTHER 2,271

**0 download failures in 49,845 fetches** — 8 workers never provoked clerk throttling.

Monday's 08:30 UTC normalize picked it all up and took **82 minutes**, not the 2–2.5h estimated —
the estimate assumed cost scales with extracted documents; it does not, so the usual ~85 min holds.

**The headline result is that the clean numbers DROPPED**, because unread documents had been
counted as loan transfers by default (see the CURRENT STATE block above). Populated fields on
Miami-Dade clean rows now: property 27,771 · loan_amount 25,759 · signatory 43,593 · folio 20,456,
where before the repair these were effectively zero for anything recorded after 2026-07-22.

**6 documents remain unextracted and that is expected steady state, not a leftover.** The facility
tick resumed the moment the backfill exited and claimed them (all `extracted_at` 04:20–07:00 UTC
today, `facility_type='none'`). The two jobs still interleave — what changed is that this is now a
**lag rather than permanent loss**: `pending_documents` keys on `raw_json IS NULL`, so Friday's
weekly run picks them up on its own. Expect a handful of these at any given moment.

### The three decisions that shape everything
1. **Broward history is index-only, by decision.** 2023–2025 has filings/parties/dates but no
   document-derived data. The portal is Cloudflare-gated (403 to every non-browser client,
   including from the droplet), so a scraper was investigated and **rejected**. The agreed path is
   a bulk image order from Broward RTT, **954-831-4000** — user's action, when convenient.
2. **Forward-only is the strategy.** Broward's analysed window grows ~55 documents/day on its own.
3. **Entity tables are deliberately cross-county** and labelled "not filtered by county" in the UI.
   They are keyed by entity, not document, so they cannot be scoped without a pipeline change —
   and cross-county entity resolution is the point of the expansion.

### Open items — all need the USER, not the assistant
- 🔴 **Leaked GitHub PAT in `.git/config`**, this Mac and the droplet. Repo is PUBLIC. Open since
  2026-08-04, oldest item on the list. Revoke → check security log → SSH remote / deploy key.
- ✅ **Off-box backups are LIVE as of 2026-08-17.** Space `amo-dashboard-backups-ec` (NYC3, same
  region as the droplet, Restrict listing, CDN off), bucket-scoped Read/Write/Delete key, six
  `export` lines in `.env`. First run: DB 37.9MB → `db/`, 2,421 Broward images (119MB) →
  `broward_images/`, `status=ok`, Overview banner cleared. **Restore verified from the Spaces copy
  itself** — integrity ok, assignments/clean/extractions all matching live exactly.
- 📞 **Bulk image order** (above) — would also close the Jan–Jun 2026 index gap.
- 🟡 69 orphaned Broward images from 2026-07-21 (harvested before their index rows; no
  `assignments` row, so never extractable).
- 🟡 Broward facility detection has found **0** real facilities in 589 documents. Miami-Dade's rate
  predicts ~3–4 at that sample size, so plausible rather than broken — recheck as volume grows.
- ✅ The two flagged facility rows were checked 2026-08-15 — see the entry below. One is a
  confirmed false positive; the other is real with two bad fields.

### Traps that have bitten repeatedly — read before deploying
- **A bucket-scoped Spaces key makes rclone 403 on upload while reads work fine.** That looks like a
  permissions mistake in the DO panel and is not one — it is rclone probing (and trying to create)
  the bucket, and sending `x-amz-acl: private`, neither of which a least-privilege key may do.
  `--s3-no-check-bucket --s3-acl=` are both set in `run_backup.sh`. Do NOT "fix" this by switching
  to a full-access key.
- **`pdf_extractions` has two writers with different ideas of "done".** `extract_pdfs.py` (main
  fields + `raw_json`) and `batch_extract_facility.py` (facility fields only, `status='OK'`,
  no `raw_json`). Selecting pending work by "does a row exist" silently lost **50,042 documents**
  for three weeks. Key on **`raw_json IS NULL`**, never on row existence. Any new writer to this
  table must be checked against this.
- **Verify a deploy by its EFFECT, not its output.** `git pull` prints `Updating <old>..<new>`
  AFTER an abort error, so `| tail -2` looks like success. Check `git log --oneline -1` on the
  droplet, or grep the built bundle.
- **Never `git add -u` in this repo.** It sweeps files you did not intend; that is what blocked a
  deploy on 2026-08-11.
- **Never restart PM2 mid-`normalize.py`.** `aom_events_clean` reads 0 rows for the whole ~80-min
  run; a restart re-caches the empty state for 7 days.
- **Any API check taken BEFORE a data change poisons the 7-day cache.** Restart after, or
  `POST /api/cache/bust`.
- **`pgrep -f "normalize.py"` matches the watcher's own command line** → use
  `ps -eo pid,cmd | grep "[n]ormalize.py" | grep -v "bash -c"`. And **`ps -eo cmd` is invalid on
  macOS** — it errors, so a `|| echo "not running"` fallback lies. Use `ps aux | grep` locally.
- **A full `normalize.py` run is ~80 minutes**, not the ~15 this log claimed for years.
- The shell cwd drifts to the PARENT directory, which holds a 0-byte `prod_snapshot.db` decoy —
  use absolute paths in backgrounded commands.

---

## 2026-08-20 — Reporting: paste-a-list bulk entity resolver + direction filter (built, verified locally, NOT deployed)

**Trigger:** a colleague's email — "Rafael wants a report on local banks that have assigned/sold
loans this year" with a 29-bank list. Adding those one-by-one through the picker autocomplete was
the gap; email-report work is on hold meanwhile (its blockers unchanged: app password + sign-off).

**Built (commit pending this entry):**
- `POST /api/reporting/resolve-entities` (routes.ts): bulk freeform-name → canonical-entity
  matching. Splits alternatives on `/` and parentheticals; scores candidates from `entity_nodes`
  via a non-generic anchor word (LIKE, vol-ranked 60) — **STRONG** = every significant input word
  whole-word-present (client pre-checks), **weak** = ≥half whole-word or single-word substring
  (unchecked). Verified against the 29-bank list on `prod_snapshot.db`: 38 strong matches incl.
  multi-variant coverage (BANKUNITED + BANKUNITED N A; both U S CENTURY spellings; OCR variant
  "CITY NATIONAL BANK 0F FLORIDA") while AMERISAVE ("Ameris"), SILICON VALLEY BANK ("Valley
  National") and GRACE UNITED COMMUNITY CHURCH ("United Community") stayed weak/reviewable —
  the church IS all-whole-words so it lands strong; that's the known cost of the rule, users
  uncheck it. 4 names had zero recorded activity (Interamerican, Executive National, Plus
  International, Paradise Bank) — surfaced as "no match on record", not silently dropped.
- `?entity_role=assignor|assignee` on `/api/reporting` + `/api/reporting/export`
  (`entityRoleParam`/`pushEntityClause` helpers): restricts the entity filter to one transaction
  side. Verified: OCEAN BANK YTD 11 rows = 8 assignor + 3 assignee, export CSV honors it.
- Client: `BulkEntityPanel` in `EntityReport.tsx` ("paste a list" under the picker; bullets/dashes
  stripped per line; strong pre-checked, per-line chips toggle; "no match on record" flagged;
  picker cap raised 50→120 for multi-variant bank lists). `Reporting.tsx`: Direction chips
  (All / Sold-assigned out / Acquired) shown when entities selected — applies to filing tables +
  CSV export only; the entity report above already splits in/out and stays both-sides (labeled).
- Rafael's ask = paste list → confirm matches → YTD preset → Direction "Sold / assigned out" →
  Export CSV. Whole flow verified in-browser on the snapshot server (port 5051; launch.json's
  `amo-dashboard-snapshot` entry now points at `./prod_snapshot.db`, was a dead `/tmp/final2.db`).

**NOT deployed** — needs the standard `git pull && npm run build && pm2 restart amo-dashboard`
(no DB/normalize step involved). Remember the 7-day cache: restart is what busts it.

**Same day, later — "Download report" Excel workbook replaces the main CSV button (user request:
"big 4 reporting standards, two sheets").** New dep **exceljs**; `server/reporting/workbook.ts`
(`buildActivityWorkbook`) + `GET /api/reporting/export-report` (same params as `/export`, which
still exists for the per-entity mini CSV buttons). Sheet 1 *Summary*: title/meta block (scope,
period, direction, filters, generated-at) + per-entity stats table (total/sold/acquired/net/$
known/first/last/top counterparty), banded rows, double-rule totals, zero-activity entities muted
but listed; no-entity mode falls back to top-sellers/top-acquirers tables. Sheet 2 *Transaction
Detail*: all filings, navy header, frozen pane, autofilter, CFN hyperlinks (same per-county guard
as CSV — Broward gets no link), money numFmt. **Tie-out verified** on the 37-bank YTD sold-only
run: detail = 95 rows = summary Sold total = the UI KPI; the 17 Acquired attributions on a
sold-only report are intra-selection bank-to-bank sales (one filing, both sides) — footnoted in
the sheet itself.

**DEPLOYED same day (both features: resolver/direction filter + Excel report).** Droplet
`3400e94 → bc45895` (it had also been one commit behind on the backup-docs commit), `npm install`
(exceljs OK), build, `pm2 restart amo-dashboard` (also busts the 7-day cache). Verified by effect:
built bundle greps for `export-report`/`resolve-entities`/"Download report"/"paste a list", and a
live localhost:5000 login + `/api/reporting/export-report` round-trip returned a valid xlsx with
28 production detail rows (Ocean Bank + BankUnited YTD sold-only test).

**Follow-up (user question: "can we split loan amount by assigned vs received — does the
documentation actually work that way?"): YES — and the split exposed a double-count.** Each filing
has one assignor, one assignee, and (when stated) the underlying mortgage principal, so the amount
attributes exactly by side. Summary sheet's single "$ Volume (known)" became **"$ Assigned out
(known)" + "$ Acquired (known)"**; footnotes now state it's note principal (not price paid —
consideration is nominal) and a floor (many documents state no amount). Tie-out on the sold-only
test: detail loan amounts sum $156,918,254.73 = "$ Assigned out" total exactly; the old combined
figure ($158.4M) had been double-counting $1.5M of intra-selection bank-to-bank sales (same
dollars in both banks' volume). Verified locally; **pending deploy** at time of writing.

**Gotcha found while verifying: `ecosystem.config.cjs`'s `AMO_PASSWORD` does NOT match the
running process env** (login with the ecosystem value fails; `pm2 env 0`'s value — 11 chars — is
what works). PM2 restarts keep the old env ("Use --update-env" notice), so today's password
survives normal restarts, but anyone running `pm2 restart --update-env` or re-`pm2 start
ecosystem.config.cjs` would silently switch the dashboard password to the stale file value.
Flagged to user; not changed.

---

## 2026-08-19 — Emailed reports: BUILT and preview-tested locally, NOT yet deployed

Continuation of 2026-08-18 (below) — the two blockers landed: sender `mktinfo@safeharborcp.com`,
recipients `andres@safeharborcp.com` + `david@safeharborcp.com`, rolling-15-day window confirmed.
User also asked to see the email before any real send is attempted, so the script defaults to a
safe preview mode.

**Built (all local, nothing deployed, nothing sent):**
- `server/email/report.ts` — queries `aom_events_clean` and `credit_facility_events` for a given
  date range, returns an inline HTML summary (counts by txn_type/county, top assignees, top
  lender↔borrower pairs by filing count) + a CSV per dataset. Facility-pair amounts are never
  summed across filings (same rule as the dashboard's total-volume stat — a recurring facility's
  `facility_amount` is its credit limit, repeated on every filing, not a new draw).
- `server/email/mailer.ts` — nodemailer transport over Outlook SMTP (`smtp-mail.outlook.com:587`,
  STARTTLS), reads `REPORT_SMTP_USER`/`REPORT_SMTP_PASS` from env.
- `server/scripts/sendWeeklyReport.ts` — the runnable entry point (`tsx server/scripts/sendWeeklyReport.ts`).
  **Defaults to preview mode**: writes the HTML + both CSVs to `server/scripts/output/` (gitignored)
  and sends nothing. Only sends for real with an explicit `--send` flag. `REPORT_START_DATE` /
  `REPORT_END_DATE` env overrides let you regenerate a specific past window (used this session to
  preview against the dev DB, which lags today — see below).
- Added `nodemailer` + `@types/nodemailer` to `package.json`. New dep, no external paid service.
- `docs/CONFLUENCE_AMO_DASHBOARD.md` updated: new §7.4 item 9, new env vars in §6.2, a note in
  §6.5, and a new owner action in §7.6 (generate the Outlook app password + approve the preview).

**Verified locally:** `tsc --noEmit` clean. Ran the script against the local dev DB — real 15-days-
from-today window returned 0 rows (dev DB's newest `aom_events_clean` row is 2026-04-22, confirming
the known "local dev DB lags production" gotcha, not a bug). Used the date overrides to preview
against a window with real data instead (2023-01-01 → 2025-10-29, 40,119 clean rows / 11 facility
rows) — rendered correctly in-browser and the CSVs matched. Sent the preview HTML + both CSVs to the
user via `SendUserFile` for review.

**Same day, later — content reworked twice on user feedback, then charts added:**
- Body now shows the actual Reporting-page table (CFN linked to the county doc image, date, county,
  assignor/assignee + type, property, folio, loan amt, signatory, classification badge; same
  `cleanField` garbage-OCR filtering as the UI) capped at 50 most-recent rows inline, plus a
  Lending Relationships snapshot = top 10 pairs from the same grouped query as the tab.
  **Refactor:** the family-aware relationship-grouping SQL moved out of `routes.ts` into
  `server/lending/facilities.ts` (`queryGroupedFacilities`), shared by the API route and the email —
  route behavior unchanged, `tsc` clean.
- **Bug found & fixed:** the relationships CSV attachment was capped at the same top-10 as the
  inline table; it now carries the full set (237 rows on the 08-05 prod snapshot) while only the
  inline table is trimmed. Also: sender now has a display name (`"AMO Dashboard" <mktinfo@…>`).
- **Bar charts added to both sections** (user request). Email clients run no JS and Outlook desktop
  renders with the Word engine (no SVG/flexbox), so charts are nested-table horizontal bars — a
  `<td>` with background color and percentage width, value direct-labeled on every bar
  (`chartBarRow`/`barChart` in `server/email/report.ts`). Clean events → "Filings per day" (one bar
  per calendar day incl. zero weekends, via `eachDate`); relationships → "Filings per relationship"
  for the same top-10 pairs. Single hue (#2563eb) both charts — same measure (filing count).
- Preview regenerated against `prod_snapshot.db` (2026-08-05 copy; window 07-15→07-30: 765 clean
  rows, 237 relationships) after the local dev DB proved too stale (max rec_date 2026-04-22).
  **Shareable mockup published as a Claude artifact** (inbox-framed: sender/recipients/schedule/
  attachment chips around the real generated HTML) for the user to show teammates:
  https://claude.ai/code/artifact/ac603756-051b-4c64-83f8-7ffb6cf812b4

**Blocking on, before any real send or deploy:**
1. User's sign-off on the preview content/layout (artifact above is the review vehicle).
2. An Outlook **app password** for `mktinfo@safeharborcp.com` (not the account password) — user is
   generating it via account.microsoft.com → Security → Advanced security options → App passwords.

**Next session:** once the app password lands, add it to `/opt/amo-dashboard/.env` as
`REPORT_SMTP_PASS`, do one real test `--send` to the two recipients, then wire the script into
`run_weekly.sh` right after `enrich_entities.py` (or a separate line in the same Friday 06:00 cron
slot), `git pull` + no build-step change needed beyond the normal deploy (`npm run build` picks up
the new files), and confirm the first live Friday run. See [[amo-email-reports]] in memory, kept in
sync.

---

## 2026-08-18 — Emailed reports: scoped, NOT yet built (planning only, no code/deploy changes)

**Status: decisions made, waiting on two facts from the user before writing any code.** No files
in this repo were touched this session.

Trigger for the idea: Reporting page ([client/src/pages/Reporting.tsx](client/src/pages/Reporting.tsx))
already has "Print report" (`window.print()`) and "Export CSV" (`GET /api/reporting/export`), but
no way to *deliver* a report — everything requires someone to open the dashboard. User wants a
report emailed out instead.

**Decisions locked in:**
- **No third-party email vendor** (ruled out Resend/SendGrid). Sending goes over **SMTP through
  the user's own Outlook/Office 365 mailbox** via `nodemailer` (new dep, no paid service) —
  `smtp-mail.outlook.com`, app password in `/opt/amo-dashboard/.env` (same pattern as
  `OPENAI_API_KEY`).
- **Scheduled only, no manual "send" button.** Weekly, piggybacking on the existing Friday 06:00
  `run_weekly.sh` cron entry rather than adding a separate schedule.
- **Content = rolling last-15-days window**, covering **both** data sources: clean AMO events
  (`aom_events_clean`, the Reporting-page dataset) and lending relationships
  (`credit_facility_events`, the Credit Facilities / Lending Relationships tab dataset). Email body
  is an **inline HTML summary** (counts/highlights, readable without opening anything) with **CSVs
  attached** for both datasets (reuse `/api/reporting/export`-style query logic).

**Blocking on, before any code gets written:**
1. Sender Outlook address + recipient address(es) — not yet provided.
2. Confirmation that "last 15 days" means a rolling lookback from send time every Friday (assumed,
   not yet confirmed).

**Next session:** once the two facts above land, build `server/email/` (nodemailer + Outlook SMTP
config), a report-assembly script pulling the 15-day window from both tables, wire it into the
Friday cron next to `run_weekly.sh`, add the app password to the droplet `.env`, deploy, and test
with a real send before trusting the schedule. See [[amo-email-reports]] in memory for the same
facts, kept in sync.

---

## 2026-08-15 (later) — 🚨 70% of Miami-Dade was never extracted. Two jobs fighting over one table.

**Found because the user looked at the Reporting page and asked why Property / Folio / Loan Amt /
Signatory were empty on every row.** They were empty because the data does not exist.

### The bug
`batch_extract_facility.py` writes a `pdf_extractions` row the moment it has a FACILITY verdict —
`status='OK'`, `ocr_chars=0`, none of the main fields. `extract_pdfs.pending_documents()` selected
work with **`px.cfn IS NULL`**. So any document the facility backfill reached first became
**permanently invisible** to the main extractor. Not skipped-and-retried — invisible, forever.

**Damage: 50,042 of 71,366 Miami-Dade documents (70%).** No property address, folio, loan amount,
signatory, doc_category, or document-derived parties for any of them. Broward is untouched (its
facility detection has found nothing, so nothing claimed its rows).

**Started 2026-07-22** — the day the full-history facility backfill was launched. It raced ahead
through the corpus and locked the main extractor out behind it.

### Why it hid for three weeks
Every poisoned row says `status = 'OK'`. No error, no log line, nothing in the Collection Log,
nothing in any banner. **The only symptom anywhere was empty columns in the UI.** The pipeline
believed it had succeeded 50,042 times.

Two false leads worth recording so nobody re-walks them:
- `ocr_chars = 0` on all of them looks exactly like "OCR is broken". It is not — the facility path
  simply never passes `ocr_chars` to `save_facility()`. Running the full download → pdftoppm →
  tesseract chain by hand on a 13 Aug document gave **3,296 chars, clean**.
- Broward extracting ~4,000 chars/doc the same morning proves the toolchain is fine.

### The discriminator
**`raw_json IS NULL`.** The main extractor always stores the model response; the facility path never
does. On production: 22,115 rows with `raw_json` → all 22,115 have `doc_category` and OCR text;
50,042 without → none do. Zero overlap. Now the basis of `pending_documents`, which makes the weekly
job self-healing. Error rows stay excluded (they also lack `raw_json`) so a run does not become a
retry of documents the clerk cannot serve.

### The repair — running now
Measured **11.85 s/doc sequential** → ~7 days for 50k. Unacceptable, so `--workers` was added:
workers do fetch/OCR/LLM, **all DB writes stay on the main thread** (SQLite takes one writer; the
pool exists to hide latency). Measured **2.80 s/doc at 4 workers — 1,286 docs/hr, 4.2×**.

Hardened first, because a multi-day run has different failure economics than a cron run:
`busy_timeout` 5s → **120s** (normalize.py commits its whole rebuild in one transaction at the end of
an ~80-minute run; a 5s writer gets "database is locked"), and `save()` now retries 3× then skips
that one document rather than ending a run with 20+ hours behind it.

Launched 2026-08-15 19:29 UTC, `nohup` + `disown`, **PPID 1 verified**, log
`collector/main_backfill.log`. 49,972 documents, `--budget 45`. **Cost ~$25** at the measured
$0.000508/doc — note this is 2 LLM calls per document, not 1.

**Worker count was tuned by measurement, and the intuition was wrong.** At 4 workers `top` showed
94.5% user / 0.1% idle, which reads as a saturated box — the call was that more workers would only
timeshare the same 4 vCPUs. Measured instead:

    4 workers    879 docs/hr    ETA 56.7h   (Tuesday)
    8 workers  1,397 docs/hr    ETA 35.6h   (Monday ~03:00 ET)   ← running

**59% faster with zero fetch failures.** High `%us` is not the same as a saturated pipeline: most of
each document is network wait (one clerk download, two OpenAI calls), so more in-flight documents
keep tesseract fed rather than competing with it. Do not size this pool from a CPU percentage —
measure throughput.

Held at 8 rather than pushed further: the facility tick was already getting clerk read timeouts, so
the portal throttles somewhere above this, and 35.6h already clears the deadline with margin for the
two nightly normalize runs inside the window.

**The facility tick was failing 10/10** with clerk read timeouts while the backfill held the portal
— same endpoint, same 4 cores. Pausing it in crontab fixed that and created a worse problem: a
disabled cron depending on someone remembering to switch it back on. So `run_facility_tick.sh` now
**yields while `extract_pdfs.py` is running** and the cron entry is live again. All five crons
restored, no paused state anywhere. Skipping a tick is free — the batch state machine is resume-safe
and the next tick is 20 minutes out.

### The lesson
**"Has a row" is not "has been done."** Two writers shared one table with no shared notion of what
"done" meant, and the cheaper job's bookkeeping silently satisfied the expensive job's precondition.
Any future job writing to `pdf_extractions` must be checked against this.

---

## 2026-08-15 — Automated backups built (next-step #3). Facility rows checked. Env confirmed.

Worked the engineering next-steps from Confluence §7.6. **Deployed and live**: pulled, built,
restarted, `rclone` installed, cron installed, first run done by hand. The droplet's `git status` is
still clean. The one thing still missing is the **Spaces credential** — until it exists the job
reports `local_only` and the Overview shows amber.

**Production first run:** 114,127 assignments, 138MB → **29.7MB gzipped in 16 seconds**.
**Restore round-trip verified from that real archive** — `integrity_check` ok, `journal_mode` delete,
assignments 114,127 and clean 52,342 both matching live exactly, Broward 42,761 / Miami-Dade 71,366.
That restore test is the point: everything before it is a hypothesis.

### `collector/run_backup.sh` — the main deliverable
Nightly 03:15 UTC (the only window that collides with nothing — normalize owns 08:30–~09:50,
Broward 12:30, weekly Friday 06:00). Snapshot → un-WAL → verify → gzip → upload → rotate 7.

**Design points that are not obvious:**
- **`sqlite3 .backup`, never `cp`.** Online backup API, so it is consistent against the live app and
  the overlapping 20-minute facility tick. A byte copy of a WAL-mode database with a 70MB `-wal` is
  exactly the corrupt-restore trap this job exists to avoid.
- **Two independent verifications before anything rotates.** `integrity_check` catches structural
  damage; a `COUNT(*) FROM assignments` assertion catches the subtler disaster — a *valid, empty*
  SQLite file, which `integrity_check` happily calls "ok". Rotation runs last and only over
  verified archives, so a bad run can never age out the good snapshots it failed to replace.
- **`local_only` is a distinct status, not a failure.** No credentials / no rclone still produces a
  good verified local snapshot; it just says so, and the UI shows amber rather than red.
- **rclone `copy`, never `sync`, for the images.** `sync` mirrors deletions, and these are the only
  copies of images the feed no longer serves.
- **rclone configured entirely by env vars** in `.env` — no `rclone.conf`, so the credential lives
  in exactly one already-gitignored place.

### Three bugs caught by testing it, not by reading it
Built a WAL-mode fixture with a *concurrent writer* rather than testing against an idle file:
1. 🚨 **The status write lost a lock race and the error was swallowed** (`2>/dev/null`). A backup
   that WORKED would have reported as missing and raised a false alarm on the Overview. Fixed with
   `PRAGMA busy_timeout` on both the snapshot and the status write, and by no longer discarding
   stderr. This is the failure mode that would have been believed.
2. **Orphaned `-shm`/`-wal` sidecars, one pair per run, forever.** The snapshot inherits WAL mode, so
   the verification reads re-create them, gzip archives only the `.db`, and the rotation glob
   (`*.db.gz`) cannot see them. Rotation test: 3 archives kept, **10 sidecars left behind.** Fixed
   at the root by putting the snapshot into `journal_mode=DELETE` — which also makes the archive
   provably self-contained.
3. **`.gitignore` `*.db` does NOT match `*.db.gz`.** Seven untracked archives would have appeared on
   the droplet — the same `git status` noise that hid a blocked deploy for hours on 08-11.

Restore round-trip verified from a rotated archive: `integrity_check` ok, row counts match.

### Health surfacing — `backup_runs` + Overview banner
Every run writes a row; `/api/stats` returns `backup_health`; the Overview shows red when there has
been no **successful** run in 48h, amber when snapshots are fine but not reaching off-box storage.

**The states are split by what the operator has to DO, not by severity** — and getting that wrong
was the one design mistake of the session, caught by looking at the deployed result rather than the
code. First cut keyed red on "has there ever been a successful run", which meant production — where
the job snapshots, verifies and rotates perfectly but has no Space to upload to — screamed red with
the message "running but has never completed successfully". That is crying wolf every single day
over a missing credential, and a banner that is always red is a banner nobody reads.

Corrected: **red** = absent, errored, or hasn't run in 48h (someone must go fix it) · **amber** =
working but not off-box (someone must add a credential) · nothing = fine. Five states verified
against the API and in the browser: no rows · recent `local_only` · last run `failed` · `ok` but 3
days old · recent `ok`. Test rows deleted afterwards.

`backup_runs` is declared defensively in `server/db.ts`, same reasoning as `broward_images`: the
server must start against a database no backup has touched — **including a freshly restored one.**

### The two flagged facility rows — one is wrong, one is fine
- `2026R268269` **confirmed false positive.** SBA 504 debenture, a single $449,560 term loan on one
  property, classified `warehouse_or_revolving_credit_facility` at `confidence = high`. Trigger was
  probably "504 **Renewal** Note" in the evidence quote.
- `2026R277453` **real, two bad fields.** Tower 36 Owner → Cirrus Real Estate Funding, ALR securing a
  loan with a stated *maximum principal amount* — genuinely facility-shaped. But
  `facility_lender_name` is empty (the document says only "Lender"; the real lender is the grantee),
  and `facility_amount` is **$34.4M while its own evidence quote says $30M**.

Class size: of 445 rows, 11 are `loan_amount` under $2M, 3 name SBA/504, 19 have no lender. Small,
not systemic. **`facility_confidence` is confidence in the reading, not the classification** — both
bad rows carry `high`. Audit on *incoherence between fields*, not on the confidence column.

### Also
- ✅ `AMO_PASSWORD` and `AMO_SECRET` confirmed present in the live PM2 env (next-step #5). Two
  caveats stand: `ecosystem.config.cjs` has drifted from what PM2 holds, and the password in use is
  short for a single shared gate with no lockout.
- Login page still said "Miami-Dade County" — the 08-11 copy sweep covered the React app but not
  this server-rendered page. Now county-neutral. Found by looking at the screen, not by grepping.
- Broward facility detection still **0** in 589 documents.
- 4 ad-hoc `backup_pre_*.db` files (~420MB) sit unrotated on the droplet. Keep
  `backup_pre_broward_normalize.db` (ROLLBACK.md names it); the rest can go once copied off-box.

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

## 2026-08-11 — DealIntelligence: facts gathered (SUPERSEDED — it was retired later the same day)

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
