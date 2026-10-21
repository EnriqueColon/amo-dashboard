#!/bin/bash
# Daily completeness check, every county, instrument by instrument.
#
# Cron entry (crontab -e), 16:30 UTC = 12:30 Eastern — after the day's
# Miami-Dade (12:30), Hillsborough (13:45) and first Broward (15:30) pulls:
#   30 16 * * * /opt/amo-dashboard/collector/run_daily_reconcile.sh >> /opt/amo-dashboard/collector/daily_reconcile.log 2>&1
#
# What it does: for each of the last RECONCILE_DAYS business days, ask each
# county for the instrument numbers it lists (Miami-Dade portal, Broward feed
# file, Hillsborough API), compare them to what we hold under ANY type or date,
# and record a verdict per county/day/type in `index_coverage` with the exact
# missing instruments. --repair re-collects a short day on the spot and asks
# again, so what is left is what could not be fixed. The Data QC page in the
# dashboard reads the table; the Friday review (run_weekly_review.sh) does the
# same over 14 days.
#
# Until 21 Oct 2026 Broward and Hillsborough were only checked on Fridays and
# the Miami-Dade check compared counts, not instruments.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"
RECONCILE_DAYS="${RECONCILE_DAYS:-5}"

# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${RECONCILE_LOCK:-/tmp/daily_reconcile.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== daily reconcile SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi
# Never share the clerk login with a pull or a sweep.
pat="collect_live""\.py"
while pgrep -f "$pat" >/dev/null; do sleep 60; done

echo "=== daily reconcile starting: $(date -u +%FT%TZ) — ${RECONCILE_DAYS} days, all counties ==="
"$VENV/bin/python3" -u reconcile_counties.py --all --days "$RECONCILE_DAYS" --repair --quiet
status=$?
[ $status -ne 0 ] && echo "DAILY RECONCILE FOUND GAPS IT COULD NOT REPAIR (exit $status) — see the Data QC page"
echo "=== daily reconcile done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
