#!/bin/bash
# Duval County foreclosure complaints (Commercial / Non-Homestead, claim band $250,000+): discover -> download -> read -> extract.
#
# NOT YET SCHEDULED. Cron entry to add once the owner approves (crontab -e), after the Miami-Dade job (11:30 UTC):
#   50 11 * * * /opt/amo-dashboard/collector/run_duval_complaints_daily.sh >> /opt/amo-dashboard/collector/duval_complaints_daily.log 2>&1
#
# Searches the last 10 days every run (a late-listed case is caught by the overlap; cases already held are skipped),
# downloads each released complaint, retries unreleased ("View on Request") complaints weekly for 8 weeks, then reads and
# extracts with the shared reader. The extraction spend cap is the same per-UTC-day COMPLAINTS_DAILY_BUDGET_USD as Miami-Dade.
# If the Clerk ever answers with a reCAPTCHA Bot Check the run stops with exit 3; nothing solves it. Check the log, do not retry in a loop.
# Needs DUVAL_CORE_USER / DUVAL_CORE_PASS and OPENAI_API_KEY in /opt/amo-dashboard/.env.
# Docs: docs/DUVAL_COMPLAINTS.md.

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

LOCKFILE="${DUVAL_COMPLAINTS_LOCK:-/tmp/duval_complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== duval complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== duval complaints daily starting: $(date -u +%FT%TZ) ==="
if [ -z "${DUVAL_CORE_USER:-}" ] || [ -z "${DUVAL_CORE_PASS:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "DUVAL_CORE_USER / DUVAL_CORE_PASS / OPENAI_API_KEY not all set — nothing done"
    exit 1
fi
export PATH="$PATH:/usr/bin"

"$VENV/bin/python3" -u duval_complaints.py --days 10 --extract
status=$?
[ $status -eq 3 ] && echo "duval_complaints.py STOPPED by a Clerk Bot Check (exit 3) — not retried"
[ $status -ne 0 ] && [ $status -ne 3 ] && echo "duval_complaints.py FAILED (exit $status)"

echo "=== duval complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
