#!/bin/bash
# Broward complaints for Manual Complaint Intake (owner, 16 Nov 2026).
#
# Reads the county's free Official Records SFTP feed for new lis pendens, ONLY to learn which Circuit Civil
# foreclosure cases exist (case number, plaintiff, defendants); lender cases recorded on/after
# BROWARD_INTAKE_START (default 2026-11-13) are listed as "To download" on Data -> Manual Complaint Intake.
# A person downloads each COMPLAINT from the Clerk's case search; the server reads it. This job also reads
# any uploaded Broward complaint the instant read missed. It never contacts the Clerk's case search.
#
# Cron (13:10 UTC = 8:10 AM EST), after the Hillsborough list job:
#   10 13 * * * /opt/amo-dashboard/collector/run_broward_complaints_intake.sh >> /opt/amo-dashboard/collector/broward_complaints_intake.log 2>&1
# To stop: remove that cron line.

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

LOCKFILE="/tmp/broward_complaints_intake.lock"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== broward complaints intake SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== broward complaints intake starting: $(date -u +%FT%TZ) ==="
"$VENV/bin/python3" -u broward_complaints_intake.py --extract
status=$?
[ $status -ne 0 ] && echo "broward_complaints_intake.py FAILED (exit $status)"
echo "=== broward complaints intake done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
