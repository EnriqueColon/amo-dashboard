# Rollback — entity-normalization refactor

Live tracking document for the shared-address-book work (started 2026-08-04).
Update the ledger as each change lands. Delete this file once the refactor is
deployed, verified in production, and no longer a rollback candidate.

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
