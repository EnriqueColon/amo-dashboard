#!/bin/bash
# Broward daily pull.
#
# THIS IS TIME-CRITICAL. Broward's SFTP feed retains only ~10 days of daily
# files. Anything missed here cannot be recovered from the feed: the yearly
# exports are index-only, so a missed day's IMAGES leave the free channel
# forever and can afterwards only be scraped from the portal one document at a
# time. The index self-heals when the yearly export publishes (up to ~14 months
# later); the images never do.
#
# Cron entry (crontab -e), 12:30 UTC = 8:30 AM Eastern. Broward uploads each
# day's file after its QA pass — observed landing between 10:27 and 11:01 UTC —
# so this runs comfortably after that, and the ~10-day retention means even
# several consecutive failures are recoverable:
#   30 12 * * * /opt/amo-dashboard/collector/run_broward_daily.sh >> /opt/amo-dashboard/collector/broward_daily.log 2>&1
#
# Cost per run is trivial: ~8MB and well under two minutes for a typical day,
# because the harvester reads the zip's central directory and then pulls only
# the assignment byte ranges (~2% of a ~450MB zip).
#
# ── PHASE 1 (current): images only, zero production surface area ─────────────
# `--from-feed` reads the work list from the feed's own index file rather than
# the assignments table, so this runs WITHOUT the county migration and WITHOUT
# putting Broward rows into tables the dashboard reads. Verified against a
# pristine copy of production: the only schema change is the new broward_images
# table, and every dashboard statistic is byte-identical.
#
# This exists because `assignments` is read directly by the Dashboard stat cards
# and the Assignments page (server/routes.ts:15-18, 193, 234). Ingesting the
# Broward index before the server is county-aware would jump the document count
# from 70,355 to ~112,878 and mix Broward rows into the Assignments table with
# no way to tell them apart. The retention clock should not be held hostage to
# that work, hence the split.
#
# ── PHASE 2: once the server is county-aware ─────────────────────────────────
# Set BROWARD_INGEST_INDEX=1 to also ingest the index, and drop --from-feed so
# the work list comes from the database (which by then is the source of truth).

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
BROWARD_INGEST_INDEX="${BROWARD_INGEST_INDEX:-0}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

cd "$COLLECTOR_DIR" || exit 1

echo "=== broward daily starting: $(date -u +%FT%TZ) ==="

index_status=0
FEED_FLAG="--from-feed"

if [ "$BROWARD_INGEST_INDEX" = "1" ]; then
    # Idempotent — already-collected days are skipped, so the overlapping
    # window costs nothing and covers a day that landed late or a failed run.
    "$VENV/bin/python3" -u broward_collect.py --daily
    index_status=$?
    [ $index_status -ne 0 ] && echo "broward_collect.py FAILED (exit $index_status)"
    # The database is now authoritative for what exists; stop guessing from the feed.
    FEED_FLAG=""
fi

# Images. Runs even if the index step errored part-way: whatever did land is
# worth harvesting against, and the retention clock does not pause for us.
"$VENV/bin/python3" -u broward_images.py --all $FEED_FLAG
image_status=$?
[ $image_status -ne 0 ] && echo "broward_images.py FAILED (exit $image_status)"

# Always print the retention report. This is the thing to eyeball in the log:
# any day showing PENDING is on a clock, and any day that scrolls off the top
# without reaching 'complete' has been permanently lost to the free feed.
"$VENV/bin/python3" -u broward_images.py --status $FEED_FLAG

echo "=== broward daily done: $(date -u +%FT%TZ) ==="

# Non-zero if either step failed, so cron mail / monitoring notices.
[ $index_status -eq 0 ] && [ $image_status -eq 0 ]
