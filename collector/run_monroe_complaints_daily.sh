#!/bin/bash
# Monroe County foreclosure complaints (Commercial / Non-Homestead, no band or band $250,000+): discover -> download -> read -> extract.
#
# NOT YET SCHEDULED. Cron entry to add once the owner approves (crontab -e), after the Duval job (11:50 UTC):
#   10 12 * * * /opt/amo-dashboard/collector/run_monroe_complaints_daily.sh >> /opt/amo-dashboard/collector/monroe_complaints_daily.log 2>&1
#
# Searches the last 10 days every run (a late-listed case is caught by the overlap; cases already held are skipped),
# downloads each public complaint, retries non-public ones (view on request, pending redaction) weekly for 8 weeks,
# then reads and extracts with the shared reader. The extraction spend cap is the same per-UTC-day
# COMPLAINTS_DAILY_BUDGET_USD as Miami-Dade and Duval.
# No sign-in. If the site ever answers with a CAPTCHA, 403 or 429 the run stops with exit 3; nothing works around it.
# Needs OPENAI_API_KEY in /opt/amo-dashboard/.env, and tesseract (scanned filings stored as TIFF are converted with it).
# Docs: docs/MONROE_COMPLAINTS.md.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
export COMPLAINTS_DIR="${COMPLAINTS_DIR:-/opt/amo-dashboard/complaints_pdfs}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# shellcheck disable=SC1091
set -a
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env
set +a

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${MONROE_COMPLAINTS_LOCK:-/tmp/monroe_complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== monroe complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== monroe complaints daily starting: $(date -u +%FT%TZ) ==="
if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — nothing done"
    exit 1
fi
export PATH="$PATH:/usr/bin"

"$VENV/bin/python3" -u monroe_complaints.py --days 10 --include-lower-band --extract
status=$?
[ $status -eq 3 ] && echo "monroe_complaints.py STOPPED: the site refused or showed a CAPTCHA (exit 3) — not retried"
[ $status -ne 0 ] && [ $status -ne 3 ] && echo "monroe_complaints.py FAILED (exit $status)"

echo "=== monroe complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
