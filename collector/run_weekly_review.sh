#!/bin/bash
# Friday completeness review — every county, day by day.
#
# Cron entry (crontab -e), 17:00 UTC = 13:00 Eastern on Friday — AFTER the
# day's Miami-Dade (12:30), Hillsborough (13:45) and Broward (15:30) pulls.
# At 11:00 it ran before Hillsborough's daily re-pull and flagged that county's
# newest days short every week (16 Oct 2026: three "gaps" that the 13:45 run
# closed two hours later).
#   0 17 * * 5 /opt/amo-dashboard/collector/run_weekly_review.sh >> /opt/amo-dashboard/collector/weekly_review.log 2>&1
#
# ── Why a weekly review on top of the per-run check ──────────────────────────
# The Miami-Dade daily job already reconciles the last few days after every
# pull. That catches a collection run that quietly came back short. It does not
# catch the slower failure: a county that keeps adding documents to a recording
# date for a week or more, or a feed that goes stale in a way no single run
# notices.
#
# So once a week this walks a wider window, every county, one day at a time,
# and prints a verdict per county/day/document type. REVIEW_DAYS is 14 by
# default so it overlaps the 14-day re-collection horizon in database.py: every
# day inside the window that a collector would still re-fetch is also a day
# this review has checked.
#
# Broward is additionally reconciled against its YEARLY exports when
# REVIEW_BROWARD_YEARS is set, which is the authoritative per-day check for a
# completed calendar year and costs one file read per year. Off by default —
# it re-reads ~50MB per year and belongs in a deliberate sweep, not a weekly
# job.
#
# Exit status is 1 if any day came back short, so the log line is unambiguous.
# Findings also land in the `index_coverage` table:
#   SELECT * FROM index_coverage WHERE status <> 'OK' ORDER BY rec_date DESC;

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"
REVIEW_DAYS="${REVIEW_DAYS:-14}"

# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${REVIEW_LOCK:-/tmp/weekly_review.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== weekly review SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== weekly review starting: $(date -u +%FT%TZ) — ${REVIEW_DAYS} days, all counties ==="
status=0

if [ -n "${REVIEW_BROWARD_YEARS:-}" ]; then
    "$VENV/bin/python3" -u reconcile_counties.py --county BROWARD --broward-years \
        --start "$(date -u -d "${REVIEW_DAYS} days ago" +%F)" --end "$(date -u +%F)"
    [ $? -ne 0 ] && status=1
fi

# --repair: a Miami-Dade day found short is re-collected on the spot (with
# --force, so a months-old OK log cannot skip it — late postings are the usual
# cause) and asked again before its verdict is recorded. The review then
# reports only what it could NOT fix.
"$VENV/bin/python3" -u reconcile_counties.py --all --days "$REVIEW_DAYS" --repair
review_status=$?
if [ $review_status -ne 0 ]; then
    echo "WEEKLY REVIEW FOUND GAPS (exit $review_status) — see index_coverage"
    status=1
fi

echo "=== weekly review done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
