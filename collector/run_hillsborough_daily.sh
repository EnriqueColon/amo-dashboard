#!/bin/bash
# Hillsborough daily pull: index → extraction (nightly normalize surfaces it).
#
# Cron entry (crontab -e):
#   45 13 * * * /opt/amo-dashboard/collector/run_hillsborough_daily.sh >> /opt/amo-dashboard/collector/hillsborough_daily.log 2>&1
#
# Two index sources, run in this order:
#
#   1. The search API (--history) over the last 14 days. It is live — a
#      document recorded this morning is searchable this afternoon — so this is
#      what keeps Hillsborough current. Windows younger than 30 days are logged
#      PARTIAL and re-read on every run, so late-indexed filings are picked up.
#   2. The daily index feed (--daily). It runs ~6 days behind and keeps ~2
#      months, but it lists parties in filing order (FRM/TO) where the API sorts
#      them alphabetically, and it re-sends documents the clerk corrected. Rows
#      it carries overwrite the API's version of the same instrument.
#
# Unlike Broward, nothing here is time-critical: document images are fetched on
# demand from the clerk's public site at extraction time, and the search API
# covers 2023 onward at least. A missed day is recovered by the next run.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# OPENAI_API_KEY for extraction; cron starts with a bare environment.
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${HILLSBOROUGH_LOCK:-/tmp/hillsborough_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== hillsborough daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== hillsborough daily starting: $(date -u +%FT%TZ) ==="
status=0

"$VENV/bin/python3" -u hillsborough_collect.py --history \
    --start "$(date -u -d '14 days ago' +%F)" --end "$(date -u +%F)"
api_status=$?
[ $api_status -ne 0 ] && echo "hillsborough_collect.py --history FAILED (exit $api_status)" && status=1

"$VENV/bin/python3" -u hillsborough_collect.py --daily
feed_status=$?
[ $feed_status -ne 0 ] && echo "hillsborough_collect.py --daily FAILED (exit $feed_status)" && status=1

# Scoped to HILLSBOROUGH so it can never eat the Miami-Dade budget. A normal
# day is ~80 documents (assignments + UCCs); the cap clears a catch-up in one go.
# A one-off backlog run reads newest first too, so running both would read the
# same documents twice.
if pgrep -f "extract_pdfs.py --county HILLSBOROUGH" >/dev/null; then
    echo "a Hillsborough extraction is already running — skipping extraction"
elif [ -n "${OPENAI_API_KEY:-}" ]; then
    "$VENV/bin/python3" -u extract_pdfs.py --county HILLSBOROUGH --limit 300 --budget 1.00
    extract_status=$?
    [ $extract_status -ne 0 ] && echo "extract_pdfs.py FAILED (exit $extract_status)" && status=1
else
    echo "OPENAI_API_KEY not set — skipping extraction"
fi

echo "=== hillsborough daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
