#!/bin/bash
# Leon County foreclosure complaints (Commercial / Non-Homestead, band $250,000+): discover -> download -> read -> extract.
#
# Scheduled 10 Nov 2026 (root crontab on the droplet), after the Monroe job (12:10 UTC):
#   30 12 * * * /opt/amo-dashboard/collector/run_leon_complaints_daily.sh >> /opt/amo-dashboard/collector/leon_complaints_daily.log 2>&1
# The Clerk's network refuses the droplet's own address; the collector goes through the IPRoyal proxy configured in
# .env (owner's decision, 10 Nov 2026). Without the IPROYAL_* variables every run fails on connect.
#
# Searches the last 10 days every run (a late-listed case is caught by the overlap; cases already held are skipped),
# downloads each viewable complaint, retries non-viewable ones weekly for 8 weeks, then reads and extracts with the
# shared reader. The extraction spend cap is the same per-UTC-day COMPLAINTS_DAILY_BUDGET_USD as the other counties.
# No sign-in. If the site ever answers with a CAPTCHA, 403 or 429 the run stops with exit 3; nothing works around it.
# Needs OPENAI_API_KEY in /opt/amo-dashboard/.env, and tesseract (Leon's complaints are scans; the reader OCRs them).
# Docs: docs/LEON_COMPLAINTS.md.

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

LOCKFILE="${LEON_COMPLAINTS_LOCK:-/tmp/leon_complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== leon complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== leon complaints daily starting: $(date -u +%FT%TZ) ==="
if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — nothing done"
    exit 1
fi
export PATH="$PATH:/usr/bin"

"$VENV/bin/python3" -u leon_complaints.py --days 10 --extract
status=$?
[ $status -eq 3 ] && echo "leon_complaints.py STOPPED: the site refused or showed a CAPTCHA (exit 3) — not retried"
[ $status -ne 0 ] && [ $status -ne 3 ] && echo "leon_complaints.py FAILED (exit $status)"

echo "=== leon complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
