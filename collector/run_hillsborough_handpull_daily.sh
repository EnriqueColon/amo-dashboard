#!/bin/bash
# Hillsborough complaints, HAND-PULL TEST (owner, 16 Nov 2026: 3-day trial before deciding to integrate).
#
# The Clerk's document site (HOVER) blocks programs, so a person downloads each complaint by hand.
# This job does everything else:
#   1. reads the Clerk's free daily case file (last 3 days, overlapping so nothing is missed) and stores
#      Commercial / Non-Homestead mortgage foreclosures; the $250,000-or-more band waits as "pending"
#      on the dashboard's #/hillsborough-test page ("To download");
#   2. reads any complaint uploaded there that the instant read missed (the server reads each upload
#      straight away; this is the backstop).
# It never contacts HOVER. No proxy (proxy_config default). Spend cap: COMPLAINTS_DAILY_BUDGET_USD, as the
# other counties.
#
# Cron (13:00 UTC = 8:00 AM EST):
#   0 13 * * * /opt/amo-dashboard/collector/run_hillsborough_handpull_daily.sh >> /opt/amo-dashboard/collector/hillsborough_handpull.log 2>&1
# To stop the test: remove that cron line. hillsborough_complaints.py --fetch-or stays unscheduled.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
export COMPLAINTS_DIR="${COMPLAINTS_DIR:-/opt/amo-dashboard/complaints_pdfs}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

set -a
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env
set +a

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="/tmp/hillsborough_handpull.lock"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== hillsborough hand-pull SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== hillsborough hand-pull starting: $(date -u +%FT%TZ) ==="
"$VENV/bin/python3" -u hillsborough_complaints.py --daily --days 3 --ingest-dir "$COMPLAINTS_DIR" --extract
status=$?
[ $status -ne 0 ] && echo "hillsborough_complaints.py FAILED (exit $status)"
echo "=== hillsborough hand-pull done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
