# Rollback — Broward County expansion (ACTIVE workstream)

**Nothing here has touched production.** All of it was rehearsed against a copy of
`prod_snapshot.db`. This section is the live tracking doc for the Broward work; the
entity-normalization section below is retained but that change is already deployed.

## Current state

| Piece | Status | Touches prod? |
|---|---|---|
| `collector/broward_collect.py` | built, rehearsed | no — new file |
| `collector/migrate_add_county.py` | built, rehearsed | **yes when run** — schema change |
| `collector/tests/check_county_isolation.py` | built, green | no — new file |
| `collector/broward_images.py` | built, rehearsed (553 docs) | no — new file + new table |
| `collector/run_broward_daily.sh` | built, not installed | no until cron is added |
| county-aware server (`routes.ts`, `db.ts`) | **DEPLOYED 2026-08-07** | yes — live |
| `normalize.py` county scoping | **DEPLOYED 2026-08-07** | yes — live |
| client county selector | **not started** | no |

## Reverting the county-aware server

The whole change is gated behind one constant. `DEFAULT_SCOPE` in `server/routes.ts` is
`'MIAMI-DADE'`, and the client sends no `county` parameter, so every response is identical to the
pre-change server. **Verified**: on a two-county database (70,355 Miami-Dade + 13,674 Broward),
`/api/stats` returned the exact Miami-Dade baseline, and a full `normalize.py` run left
`aom_events_clean`, `entity_classifications` and `entity_nodes` byte-identical.

To revert, `git revert` the commit, `npm run build`, `pm2 restart amo-dashboard`. Nothing needs
undoing in the data: the county column is additive and `normalize.py`'s scoping only ever removes
Broward rows from consideration, so re-running the old code rebuilds the same tables.

Pre-deploy backup: `/opt/amo-dashboard/backup_pre_county.db` (92MB, integrity-checked, taken
2026-08-07). Keep it until the county work has settled. Deploy-day verification: `/api/stats` on
the default scope returned the pre-deploy baseline `70,834 | 28,644 | 13,512` exactly, and the DB
counts were unchanged.

**Careful with PM2 here:** `ecosystem.config.cjs` on the droplet has drifted from the running
process — the file's `AMO_PASSWORD` differs from the one PM2 actually holds. `pm2 restart` keeps
the running env, but a `pm2 delete` + fresh start would adopt the file's value and silently change
the dashboard password.

**The one-way door is `NORMALIZE_COUNTIES` in `collector/normalize.py`.** Widening it to include
Broward lets Broward names into the entity-classification signal sweep, which can change
`assignor_type`/`assignee_type` on existing Miami-Dade rows. That is a data change, not a code
change — reverting the constant afterwards requires a further `normalize.py` run to undo it.

## Phase 1 is DEPLOYED (2026-08-07)

Live on the droplet: `paramiko` installed, code pulled, 553 documents harvested to
`/opt/amo-dashboard/collector/broward_images`, cron at `30 12 * * *`. No `npm run build` and no
`pm2 restart` were needed — the change is collector-only.

Post-deploy verification: `assignments` holds **0** Broward-format (pure-numeric) CFNs, the
`county` column is still absent, and the app is online. The count moving 70,355 → 70,834 is
ordinary Miami-Dade collection through 2026-08-06.

**To back it out completely:**

    ssh root@165.22.35.75
    crontab -e                                    # delete the run_broward_daily.sh line
    sqlite3 /opt/amo-dashboard/miami_dade_amo.db "DROP TABLE broward_images;"
    rm -rf /opt/amo-dashboard/collector/broward_images

Think before that last line — see the warning under "Reverting the image harvester" below.
Nothing the dashboard reads is involved, so no rebuild or restart is required either way.

## Phase 1 deploy (harvester only) — what it can and cannot touch

`run_broward_daily.sh` defaults to `--from-feed`, which reads the work list from the feed's own
index file rather than the database. Deploying it therefore needs **no migration and no Broward
rows in any table the dashboard reads**.

Verified by running it against a pristine copy of production (no `county` column, no Broward
data). Afterwards:

- schema diff = exactly one new table, `broward_images`, plus its index
- `COUNT(*)`, date range, and distinct grantor/grantee counts on `assignments`: **identical**
- row counts on `pdf_extractions`, `aom_events_clean`, `credit_facility_events`, `entity_nodes`,
  `entity_aliases`, `collection_log`: **all identical**

The only prerequisite is `paramiko` in the droplet venv. To back it out entirely: remove the cron
entry, `DROP TABLE broward_images`, delete `BROWARD_IMAGE_DIR`. Nothing else is involved.

## Reverting the image harvester

`broward_images.py` only ever creates its own table and writes files under
`BROWARD_IMAGE_DIR`. It never touches `assignments`, `pdf_extractions` or anything the dashboard
reads, so removing it cannot affect the running site:

    DROP TABLE broward_images;      -- then delete BROWARD_IMAGE_DIR

**Think before deleting the images themselves.** They are only re-fetchable while their day is
still inside the ~10-day feed window. Past that, re-acquiring them means scraping the portal one
document at a time — the expensive path this whole design exists to avoid. Dropping the table
while keeping the files is the cheap, safe reset: the harvester will simply re-harvest and
overwrite.

If cron has been installed, remove the entry too, or it will re-populate both.

## Why the schema migration is low-risk

`migrate_add_county.py` only ever does `ALTER TABLE ... ADD COLUMN county TEXT`, an UPDATE of
NULLs, and `CREATE INDEX IF NOT EXISTS`. It **drops nothing, rewrites no existing column, and
recreates no table**. SQLite's ADD COLUMN is O(1) metadata-only. It is idempotent — re-running it
is a no-op.

Reverting it is therefore almost never necessary. If you must:

    -- the column is additive and unread by any deployed code, so the honest revert is
    -- simply to stop writing to it. To physically remove it (SQLite 3.35+):
    ALTER TABLE assignments            DROP COLUMN county;
    ALTER TABLE pdf_extractions        DROP COLUMN county;
    ALTER TABLE aom_events_clean       DROP COLUMN county;
    ALTER TABLE credit_facility_events DROP COLUMN county;
    ALTER TABLE collection_log         DROP COLUMN county;

**Do NOT drop the column while Broward rows are present** — it is the only thing distinguishing
them from Miami-Dade rows. Delete the data first (below), then the column.

## Removing Broward data

Broward rows are confined to `assignments` until the pipeline is wired further, so:

    DELETE FROM assignments    WHERE county = 'BROWARD';
    DELETE FROM collection_log WHERE doc_type LIKE 'BROWARD:%';

Nothing else references them. `normalize.py` is county-blind today, which means a Broward row
with no `pdf_extractions` companion is simply never picked up — **that is why index ingestion is
safe to land before the county filter exists.** It also means re-running `normalize.py` after a
Broward ingest changes nothing, so no rebuild is needed either way.

## The invariant this work depends on

`assignments.cfn` stays globally UNIQUE instead of becoming `UNIQUE(county, cfn)`, because the two
counties' key formats are disjoint:

    Miami-Dade CFN     2026R521735    always contains 'R'
    Broward instrument 121018052      always pure digits

If that ever stops being true — a third county, or a Broward format change — the shortcut is
unsafe and the table must be rebuilt with a composite key. **The guardrail below asserts it, so a
violation surfaces as a test failure and not as silently overwritten records.**

## Guardrail

    AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
        collector/tests/check_county_isolation.py

Checks: no NULL counties left by the migration; no CFN under two counties; key formats match the
disjointness claim; derived tables agree with `assignments` about county.

## Deploy prerequisites (not yet done)

- `paramiko` must be installed in the droplet venv — `collector/.venv/bin/pip install paramiko`.
- Run `migrate_add_county.py` BEFORE `broward_collect.py`; the collector fails fast with an
  instruction if the column is missing.
- Take a `sqlite3 .backup` first, as with any production data change.

---

# Rollback — entity-normalization refactor

**DEPLOYED 2026-08-06 and verified live.** Kept as the revert path while the
change is still fresh. Delete once you are confident it will not be rolled back.

Pre-deploy backup: `/opt/amo-dashboard/backup_pre_entity_norm.db` (91MB,
integrity-checked). Keep it until this file goes.

Fastest full revert: restore that backup over `miami_dade_amo.db`, then
`git checkout pre-entity-normalization`, `npm run build`, `pm2 restart`.
Reverting decisions only (keeping the code) is a DELETE on the two tables plus
a `normalize.py` re-run — see below.

## Known-good anchor

    git tag pre-entity-normalization   →   c5bfe89

Everything at or before that tag predates any behavior change. The two commits
inside it (`d5f6d16`, `c5bfe89`) add test tooling only — no pipeline, server, or
client code was touched.

**Unverified:** which commit production is actually running. SESSION_LOG records
the user confirming a deploy through `375088c`, with later commits pending.
Confirm before deploying, so the rollback target is a real state and not a guess.

## Why rollback is safe

`normalize.py` writes only to derived tables:

    aom_events_clean, credit_facility_events, entity_classifications,
    entity_nodes, entity_relationships, fdic_institution_cache

It never writes to `assignments` or `pdf_extractions` (verified 2026-08-04 by
grepping every INSERT/UPDATE/DELETE/DROP target). Those hold the raw collected
records and the LLM extractions — the expensive, irreplaceable data.

**Consequence: no rollback scenario can lose data.** Every table this refactor
affects is rebuildable from raw source by re-running `normalize.py`. The cost of
a bad deploy is a rebuild, not a recovery.

Two things that survive a rebuild and must not be dropped:
- `entity_aliases` — user merges made from the Entities page
- `alias_suggestion_dismissals` — suggestions the user already rejected

## Guardrail

    collector/.venv/bin/python3 collector/tests/check_canonicalize_baseline.py

Green means `canonicalize()` output is unchanged across all 31,113 names, so
`aom_events_clean` and every tab built on it are provably untouched.

**v1 scope decision (2026-08-04): this check must stay green.** The known
punctuation defect (A&D Mortgage counted as three companies — see
`diff_name_systems.py`) is deliberately deferred to a separate change so that
v1 carries exactly one source of variation: facility-side regrouping.

## Change ledger

| Commit | Change | Behavior risk | Revert |
|---|---|---|---|
| `d5f6d16` | canonicalize() baseline harness | none — new files only | `git revert` |
| `c5bfe89` | name-system disagreement harness | none — new files only | `git revert` |
| `6b3f57e` | this rollback ledger | none — new file only | `git revert` |
| `7aa26a1` | `collector/entity_names.py` shared address book | none — additive, nothing imported it | `git revert` |
| _this_ | wire normalize.py to the address book; add brand-key columns | **first change that touches the pipeline** — needs a rebuild to undo | see below |

### Reverting the wiring commit

Code revert alone leaves `credit_facility_events` holding the new columns and
keys. Full undo:

    git revert <sha> && npm run build && pm2 restart amo-dashboard
    # then rebuild derived tables (see Production procedure below)

The seeded `entity_aliases` rows survive a revert. That is intentional and
harmless: nothing reads facility-scoped aliases once the wiring is gone. Remove
them only if you want a truly pristine state:

    DELETE FROM entity_aliases WHERE created_by = 'migration';

Note it uses `INSERT OR IGNORE`, so re-running never overwrites a correction you
have since edited from the dashboard.

## Rollback procedures

### Local

    git checkout pre-entity-normalization        # inspect known-good
    git revert <sha>                             # undo one landed change

Re-run the guardrail after any revert.

### Production

Reverting code is **not sufficient** — if `normalize.py` has already run with the
new logic, the derived tables hold new groupings until they are rebuilt.

    # 1. code
    cd /opt/amo-dashboard
    git revert <sha>        # or: git checkout pre-entity-normalization
    npm run build           # BEFORE restart, or PM2 relaunches the old bundle
    pm2 restart amo-dashboard

    # 2. data — only if normalize.py ran with the new logic
    cd /opt/amo-dashboard/collector
    source /opt/amo-dashboard/.env
    nohup .venv/bin/python3 -u normalize.py > normalize.log 2>&1 &
    disown

    # 3. cache — API responses are cached in-memory for 7 DAYS
    pm2 restart amo-dashboard

Step 3 is not optional. Without it the dashboard keeps serving pre-rollback data
and the rollback looks like it failed. `POST /api/cache/bust` from a logged-in
session does the same thing.

`nohup` + `disown` matter: a dropped SSH session has already killed a foreground
`normalize.py` mid-run once. It builds all inserts in memory and commits at the
end, so row counts stay flat during the run — process liveness (`ps`) is the only
real progress signal.
