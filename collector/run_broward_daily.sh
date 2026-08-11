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
# ── What this does now ───────────────────────────────────────────────────────
# index → images → extraction → (nightly normalize surfaces it). Broward is
# fully live, so this is the whole forward pipeline in one script.
#
# BROWARD_INGEST_INDEX=1 in the crontab makes it ingest the index too and take
# the work list from the database; without it the script falls back to
# --from-feed, reading the day's own index file and touching nothing else.
#
# HISTORY IS DELIBERATELY NOT COVERED HERE. 2023–2025 is index-only: the county
# portal is Cloudflare-gated (403 to every non-browser client, including from
# the droplet) and the sanctioned route for historical images is a bulk order by
# phone, 954-831-4000. So this forward path IS the enrichment story — which is
# why extraction runs here daily rather than waiting for the Friday weekly job.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
BROWARD_INGEST_INDEX="${BROWARD_INGEST_INDEX:-0}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# OPENAI_API_KEY for the extraction step below. Sourced rather than assumed:
# cron starts with a bare environment, so without this the key is absent and
# extraction silently skips.
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

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

# Extract what was just harvested.
#
# Without this the forward path is only as fast as run_weekly.sh (Friday 06:00),
# so a document harvested on Monday waits up to six days before it is readable
# and another night before normalize surfaces it. Since Broward history is
# index-only by decision (the portal is Cloudflare-gated and the bulk-image
# route is a phone call), the forward path IS the enrichment story — it should
# not lag by most of a week.
#
# Scoped to BROWARD so it can never eat the Miami-Dade budget, and capped well
# above a normal day (~55 documents) so a catch-up after a failed run still
# clears in one go. Typical cost is ~$0.03/day.
extract_status=0
if [ -n "${OPENAI_API_KEY:-}" ]; then
    "$VENV/bin/python3" -u extract_pdfs.py --county BROWARD --limit 300 --budget 1.00
    extract_status=$?
    [ $extract_status -ne 0 ] && echo "extract_pdfs.py FAILED (exit $extract_status)"
else
    echo "OPENAI_API_KEY not set — skipping extraction (images are still harvested)"
fi

# Always print the retention report. This is the thing to eyeball in the log:
# any day showing PENDING is on a clock, and any day that scrolls off the top
# without reaching 'complete' has been permanently lost to the free feed.
"$VENV/bin/python3" -u broward_images.py --status $FEED_FLAG

echo "=== broward daily done: $(date -u +%FT%TZ) ==="

# Non-zero if any step failed, so cron mail / monitoring notices.
[ $index_status -eq 0 ] && [ $image_status -eq 0 ] && [ $extract_status -eq 0 ]
