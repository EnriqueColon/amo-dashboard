#!/bin/bash
# Broward daily pull — index first, then document images.
#
# THIS IS TIME-CRITICAL. Broward's SFTP feed retains only ~10 days of daily
# files. Anything missed here cannot be recovered from the feed: the yearly
# exports are index-only, so a missed day's IMAGES are gone from the free
# channel forever and can afterwards only be scraped from the portal one
# document at a time. The index self-heals when the yearly export publishes
# (up to ~14 months later); the images never do.
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

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

cd "$COLLECTOR_DIR" || exit 1

echo "=== broward daily starting: $(date -u +%FT%TZ) ==="

# 1. Index for every day still on the feed. Idempotent — already-collected days
#    are skipped, so the overlapping window costs nothing and covers a day that
#    landed late or a run that failed.
"$VENV/bin/python3" -u broward_collect.py --daily
index_status=$?
if [ $index_status -ne 0 ]; then
    echo "broward_collect.py FAILED (exit $index_status)"
fi

# 2. Images for those same days. Runs even if step 1 errored part-way: whatever
#    index rows did land are worth harvesting against, and the retention clock
#    does not pause for our failures.
"$VENV/bin/python3" -u broward_images.py --all
image_status=$?
if [ $image_status -ne 0 ]; then
    echo "broward_images.py FAILED (exit $image_status)"
fi

# 3. Always print the retention report. This is the thing to eyeball in the log:
#    any day showing PENDING is on a clock, and any day that scrolls off the top
#    without reaching 'complete' has been permanently lost to the free feed.
"$VENV/bin/python3" -u broward_images.py --status

echo "=== broward daily done: $(date -u +%FT%TZ) ==="

# Non-zero if either step failed, so cron mail / monitoring notices.
[ $index_status -eq 0 ] && [ $image_status -eq 0 ]
