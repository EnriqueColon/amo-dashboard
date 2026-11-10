#!/bin/bash
# Citrus County foreclosure complaints (Commercial / Non-Homestead, every claim band): export -> download -> read -> extract.
#
# Cron entry (after the Leon job, 12:30 UTC):
#   50 12 * * * /opt/amo-dashboard/collector/run_citrus_complaints_daily.sh >> /opt/amo-dashboard/collector/citrus_complaints_daily.log 2>&1
#
# Exports the last 14 days of Circuit Civil filings every run from the Clerk's official Bulk Data Export (it lags new
# filings by a few days and answers HTTP 500 for a window with none yet; the overlap catches them later). Then signs in
# to the Clerk's court records site with the registered account (CITRUS_SCORSS_USER / CITRUS_SCORSS_PASS, added by the
# owner) — registered users are not shown the CAPTCHA — downloads each viewable complaint, retries the rest weekly for
# 8 weeks, and reads and extracts with the shared reader under the same per-UTC-day COMPLAINTS_DAILY_BUDGET_USD.
# Without the account variables the run stores the index only. A CAPTCHA, 403 or 429 stops the run with exit 3, and a
# refused sign-in with exit 4; neither is retried or worked around.
# Needs OPENAI_API_KEY in /opt/amo-dashboard/.env. Docs: docs/CITRUS_COMPLAINTS.md.

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

LOCKFILE="${CITRUS_COMPLAINTS_LOCK:-/tmp/citrus_complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== citrus complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== citrus complaints daily starting: $(date -u +%FT%TZ) ==="
if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — nothing done"
    exit 1
fi
export PATH="$PATH:/usr/bin"

"$VENV/bin/python3" -u citrus_complaints.py --days 14 --include-lower-band --extract
status=$?
[ $status -eq 3 ] && echo "citrus_complaints.py STOPPED: the site refused or showed a CAPTCHA (exit 3) — not retried"
[ $status -eq 4 ] && echo "citrus_complaints.py STOPPED: the registered sign-in was refused (exit 4) — not retried"
[ $status -ne 0 ] && [ $status -ne 3 ] && [ $status -ne 4 ] && echo "citrus_complaints.py FAILED (exit $status)"

echo "=== citrus complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
