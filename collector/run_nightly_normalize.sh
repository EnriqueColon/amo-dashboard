#!/bin/bash
# Nightly rebuild of the derived tables (aom_events_clean, credit_facility_events)
# from pdf_extractions, followed by a PM2 restart to clear the 7-day in-memory
# API cache (server/cache.ts) — without the restart the dashboard keeps serving
# pre-rebuild data. Meant for cron, not by hand.
#
# Cron entry (crontab -e), 08:30 UTC = 4:30 AM Eastern (droplet clock is UTC,
# no DST — installed 2026-07-21; runs after the overnight backfill work):
#   30 8 * * * /opt/amo-dashboard/collector/run_nightly_normalize.sh >> /opt/amo-dashboard/collector/batch/normalize_nightly.log 2>&1
#
# Safe to run while the facility tick is active — normalize reads
# pdf_extractions and rebuilds its own tables in one end-of-run commit.
# If the log ever shows "pm2: command not found", cron's PATH is missing the
# npm global bin — replace `pm2` below with the full path from `which pm2`.

set -u
cd /opt/amo-dashboard/collector
source /opt/amo-dashboard/.env

echo "=== nightly normalize starting: $(date -u +%FT%TZ) ==="
.venv/bin/python3 -u normalize.py
status=$?
if [ $status -ne 0 ]; then
    echo "normalize.py FAILED (exit $status) — skipping cache bust so the app keeps serving last good data"
    exit $status
fi

pm2 restart amo-dashboard
echo "=== nightly normalize done: $(date -u +%FT%TZ) ==="
