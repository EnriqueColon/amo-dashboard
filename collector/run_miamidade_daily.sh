#!/bin/bash
# Miami-Dade daily index pull.
#
# Cron entry (crontab -e), 12:30 UTC = 08:30 Eastern — late enough that the
# clerk has published the previous business day, early enough that the day's
# documents are in the tool before anyone looks:
#   30 12 * * * /opt/amo-dashboard/collector/run_miamidade_daily.sh >> /opt/amo-dashboard/collector/miamidade_daily.log 2>&1
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Miami-Dade was collected ONCE A WEEK (run_weekly.sh, Friday 06:00 UTC) while
# Broward ran three times a day and Hillsborough daily. The largest county was
# the stalest one: between Friday runs the tool was missing up to seven days of
# assignments, and the Friday run itself fires at 02:00 Eastern, before that
# day's recordings exist — so the real lag reached eight days.
#
# Measured on 2026-10-14: the tool held nothing after 2026-10-08. The county had
# 71 AMO documents on 10-09 and 39 on 10-13 that the tool had never seen, and a
# user looking up a document recorded on the 9th simply could not find it.
#
# The whole collection takes about 90 seconds. There was never a cost reason for
# it to be weekly.
#
# ── What it does NOT do ──────────────────────────────────────────────────────
# Index only. Extraction, normalize and enrich_entities stay in run_weekly.sh
# and the nightly normalize, so this job cannot compete with them for CPU or
# OpenAI budget. Miami-Dade AMO rows reach aom_events_clean without being read
# (normalize admits doc_category NULL for that one specific type), so a daily
# index pull plus the nightly normalize is enough for a new assignment to appear
# in the tool the next morning.
#
# ── The lookback window ──────────────────────────────────────────────────────
# LOOKBACK_DAYS of history every run, not just yesterday. The county keeps
# adding documents to a recording date for days after the fact, so a window
# collected once is not finished. database.already_collected() refuses to skip
# any window ending inside AMO_RECHECK_DAYS (14) for the same reason — without
# that, the second run of a repeated window would skip it and every late-posted
# document inside it would be lost for good.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-10}"

# CLERK_EMAIL / CLERK_PASSWORD if they are kept in .env; cron starts bare.
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${MIAMIDADE_LOCK:-/tmp/miamidade_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== miami-dade daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

# The weekly run collects the same window with the same credentials. Two
# Playwright sessions against one clerk login is a good way to get the account
# rate-limited, so defer rather than race it.
if pgrep -f "[c]ollect_live.py" >/dev/null; then
    echo "=== miami-dade daily SKIPPED $(date -u +%FT%TZ): collect_live.py already running ==="
    exit 0
fi

START="$(date -u -d "${LOOKBACK_DAYS} days ago" +%F 2>/dev/null || date -u -v-"${LOOKBACK_DAYS}"d +%F)"
END="$(date -u +%F)"

echo "=== miami-dade daily starting: $(date -u +%FT%TZ) — window ${START} → ${END} ==="
status=0

"$VENV/bin/python3" -u collect_live.py --start "$START" --end "$END"
collect_status=$?
if [ $collect_status -ne 0 ]; then
    echo "collect_live.py FAILED (exit $collect_status)"
    status=1
fi

# Completeness check: ask the county what it holds per day and compare. Exits
# non-zero on a gap, which is what makes a silent miss loud. Advisory here —
# the collection above already succeeded or failed on its own merits.
if [ -f "$COLLECTOR_DIR/reconcile_counties.py" ]; then
    "$VENV/bin/python3" -u reconcile_counties.py --county MIAMI-DADE --days "$LOOKBACK_DAYS"
    recon_status=$?
    [ $recon_status -ne 0 ] && echo "RECONCILIATION REPORTED A GAP (exit $recon_status)"
fi

echo "=== miami-dade daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
