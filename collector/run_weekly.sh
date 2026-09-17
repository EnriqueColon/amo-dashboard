#!/bin/bash
# Weekly collection + PDF extraction + normalization — runs every Friday via cron
# Cron: 0 6 * * 5 /opt/amo-dashboard/collector/run_weekly.sh >> /opt/amo-dashboard/collector/cron.log 2>&1
#
# Required env (loaded from /opt/amo-dashboard/.env, same as run_facility_tick.sh):
#   OPENAI_API_KEY  - for extract_pdfs.py + enrich_entities.py (gpt-4.1-nano)
#   OPENAI_MODEL    - optional, defaults to gpt-4.1-nano
#   CLERK_EMAIL / CLERK_PASSWORD - clerk portal login (or a local config.py)

set -e
export AMO_DB_PATH="/opt/amo-dashboard/miami_dade_amo.db"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# Cron provides no environment — load droplet secrets exactly like the tick
# does. Without this, the run half-succeeds: collection works, then
# extract_pdfs.py dies on "OPENAI_API_KEY is not set" and every newly
# collected document is indexed but never read (amounts/property all blank on
# the dashboard). That exact silent half-failure ran on 2026-08-14 and
# 2026-08-21 before being caught. Fail LOUDLY up front rather than partially
# succeeding — a skipped week is obvious, a half-run hid for two weeks.
if [ -f /opt/amo-dashboard/.env ]; then
    source /opt/amo-dashboard/.env
fi
if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "FATAL: OPENAI_API_KEY missing after sourcing /opt/amo-dashboard/.env — aborting whole run"
    exit 1
fi

# Date range: last 10 days (overlapping window catches late-filed records)
START=$(date -d "10 days ago" +%Y-%m-%d 2>/dev/null || date -v-10d +%Y-%m-%d)
END=$(date +%Y-%m-%d)

echo "========================================"
echo "Weekly Run: $START → $END"
echo "Started: $(date)"
echo "========================================"

cd "$COLLECTOR_DIR"

# 1. Collect new records (all configured doc types: AMO, ASG, AIT)
"$VENV/bin/python3" collect_live.py --start "$START" --end "$END"

# 2. Extract data from the recorded PDFs (newest first, capped per run)
"$VENV/bin/python3" extract_pdfs.py --limit 1500

# 3. Rebuild normalized tables (applies loan-transfer filter + extracted fields)
"$VENV/bin/python3" normalize.py

# 4. LLM fallback classification for new entities
"$VENV/bin/python3" enrich_entities.py

# 5. Weekly email report — deliberately LAST, after collection and the rebuild,
# so both counties are current when it is built. Sent mid-week, Miami-Dade
# (collected only here) trails Broward (collected daily) by several days, and
# the report reads as though Miami-Dade went quiet.
#
# OFF until REPORT_EMAIL_ENABLED=1 is set in .env. The owner approves the first
# real send to the named recipients before it is switched on.
if [ "${REPORT_EMAIL_ENABLED:-}" = "1" ]; then
    echo "--- weekly email: $(date -u +%FT%TZ) ---"
    # Friday runs finish between 09:00 and 10:05 UTC, which overlaps the 08:30
    # nightly normalize. normalize.py empties aom_events_clean while it
    # rebuilds, so wait for any rebuild to finish (up to 3 hours) rather than
    # email a half-empty table. "[n]ormalize" so pgrep never matches this line.
    waited=0
    while pgrep -f "[n]ormalize\.py" >/dev/null && [ $waited -lt 10800 ]; do
        sleep 60; waited=$((waited + 60))
    done
    if [ $waited -gt 0 ]; then echo "waited ${waited}s for a running normalize.py"; fi
    # GRAPH_* in .env are plain KEY=value lines, not `export` lines like the
    # rest of the file — without set -a the source at the top leaves them
    # unexported and node never sees the credentials.
    (
        set -a; . /opt/amo-dashboard/.env; set +a
        cd /opt/amo-dashboard && /usr/bin/npx tsx server/scripts/sendWeeklyReport.ts --send
    ) || echo "WEEKLY EMAIL FAILED (exit $?) — collection and rebuild above still completed"
fi

echo "Completed: $(date)"
