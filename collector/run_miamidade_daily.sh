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
# ── Index, then a bounded read ───────────────────────────────────────────────
# Collection alone is not enough for every document type:
#
#   AMO (assignment of mortgage) reaches aom_events_clean without being read —
#       normalize admits doc_category NULL for that one specific type — so a
#       daily index pull plus the nightly normalize puts it in the tool.
#   ASG (the county's GENERIC assignment bucket) does not. It must be read
#       before it can be classified, and only ~1 in 20 turns out to be a loan
#       transfer (Jan 2023: 212 rents/leases, 53 other, 39 collateral, 17 loan
#       transfers). While extraction ran only in the Friday job, a generic
#       assignment recorded on Monday could not appear in Reporting until
#       Friday.
#
# So this job also reads, but gently: single worker and a small daily budget,
# sized for the ~190 Miami-Dade documents a business day rather than for a
# backlog. normalize and enrich stay in run_weekly.sh and the nightly job.
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
# The reconciler re-queries the portal independently of the collector, so its
# window is deliberately narrower than the collection lookback: three runs a day
# over 10 days would be ~84 extra searches daily against one clerk login, to
# re-confirm days that have not changed in a week. Recent days are the ones that
# move. Older history is swept by running reconcile_counties.py --days N by hand
# or from a weekly job.
RECONCILE_DAYS="${RECONCILE_DAYS:-4}"

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

# Read what was just collected. Scoped to MIAMI-DADE so it can never eat
# another county's budget, and --workers 1 (the default) so it stays polite
# while a backlog run holds the other cores. A day's worth is ~190 documents;
# the cap clears a long weekend in one pass.
if pgrep -f "[e]xtract_pdfs.py --county MIAMI-DADE" >/dev/null; then
    echo "a Miami-Dade extraction is already running — skipping extraction"
elif [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — skipping extraction"
else
    "$VENV/bin/python3" -u extract_pdfs.py --county MIAMI-DADE \
        --limit "${EXTRACT_LIMIT:-400}" --budget "${EXTRACT_BUDGET:-2.00}"
    extract_status=$?
    if [ $extract_status -ne 0 ]; then
        echo "extract_pdfs.py FAILED (exit $extract_status)"
        status=1
    fi
fi

# Completeness check: ask the county what it holds per day and compare. Exits
# non-zero on a gap, which is what makes a silent miss loud. Advisory here —
# the collection above already succeeded or failed on its own merits.
if [ -f "$COLLECTOR_DIR/reconcile_counties.py" ]; then
    "$VENV/bin/python3" -u reconcile_counties.py --county MIAMI-DADE --days "$RECONCILE_DAYS"
    recon_status=$?
    [ $recon_status -ne 0 ] && echo "RECONCILIATION REPORTED A GAP (exit $recon_status)"
fi

echo "=== miami-dade daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
