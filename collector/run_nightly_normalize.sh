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

# Two rebuilds at once empty and refill the same tables under each other.
# "[n]ormalize" keeps pgrep from matching its own command line.
#
# But a skipped rebuild must NOT mean a skipped restart. On Fri 16 Oct 2026
# the weekly run (06:00) was still rebuilding at 08:30 — it took 4h48m with a
# document backlog sharing the CPU — so this job exited, and because only this
# job clears the 7-day API cache, the dashboard served pre-rebuild data all
# morning. So: wait for the other rebuild to finish, then restart to publish
# its result, and skip only the redundant second rebuild.
if pgrep -f "[n]ormalize.py" >/dev/null; then
    echo "=== nightly normalize: another rebuild is running ($(date -u +%FT%TZ)) — waiting for it ==="
    while pgrep -f "[n]ormalize.py" >/dev/null; do sleep 60; done
    echo "=== other rebuild finished ($(date -u +%FT%TZ)); restarting to clear the cache, skipping the second rebuild ==="
    pm2 restart amo-dashboard
    exit 0
fi

echo "=== nightly normalize starting: $(date -u +%FT%TZ) ==="
.venv/bin/python3 -u normalize.py
status=$?
if [ $status -ne 0 ]; then
    echo "normalize.py FAILED (exit $status) — skipping cache bust so the app keeps serving last good data"
    exit $status
fi

pm2 restart amo-dashboard
echo "=== nightly normalize done: $(date -u +%FT%TZ) ==="
