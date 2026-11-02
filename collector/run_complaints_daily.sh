#!/bin/bash
# Miami-Dade foreclosure complaints (RPMF-Commercial / RPMF-Non-Homestead): discover -> download -> read -> extract.
#
# Cron entry (crontab -e):
#   30 11 * * * /opt/amo-dashboard/collector/run_complaints_daily.sh >> /opt/amo-dashboard/collector/complaints_daily.log 2>&1
#
# Runs every morning (11:30 UTC = 07:30 EDT / 06:30 EST), before the Miami-Dade ASG pull at 12:30 UTC.
# Searches the last 10 days every run (a late-listed case is picked up by the overlap; cases already held are
# skipped), downloads each new complaint, retries "complaint not public" cases weekly for 8 weeks, then extracts
# with gpt-5.5 and repairs flagged addresses. Spending is capped per UTC day (COMPLAINTS_DAILY_BUDGET_USD,
# default 15); when the cap is reached the rest waits for the next run. Nothing here is time-critical: the Clerk
# keeps complaints available, so a missed day is recovered by the next run.
# Needs CLERK_OCS_USER / CLERK_OCS_PASS and OPENAI_API_KEY in /opt/amo-dashboard/.env.
# Docs: docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md sections 18-20.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
export COMPLAINTS_DIR="${COMPLAINTS_DIR:-/opt/amo-dashboard/complaints_pdfs}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# shellcheck disable=SC1091
# set -a exports every variable the file sets; some lines there carry no "export" (the Clerk pair)
set -a
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env
set +a

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${COMPLAINTS_LOCK:-/tmp/complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== complaints daily starting: $(date -u +%FT%TZ) ==="
if [ -z "${CLERK_OCS_USER:-}" ] || [ -z "${CLERK_OCS_PASS:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "CLERK_OCS_USER / CLERK_OCS_PASS / OPENAI_API_KEY not all set — nothing done"
    exit 1
fi
export PATH="$PATH:/usr/bin"

"$VENV/bin/python3" -u complaints_collect.py --days 10 --extract
status=$?
[ $status -ne 0 ] && echo "complaints_collect.py FAILED (exit $status)"

echo "=== complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
