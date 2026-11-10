#!/bin/bash
# Citrus County foreclosure cases (Commercial / Non-Homestead) from the Clerk's official Bulk Data Export: index only.
#
# Cron entry (after the Leon job, 12:30 UTC):
#   50 12 * * * /opt/amo-dashboard/collector/run_citrus_complaints_daily.sh >> /opt/amo-dashboard/collector/citrus_complaints_daily.log 2>&1
#
# Exports the last 14 days of Circuit Civil filings every run (the export lags new filings by a few days and answers
# HTTP 500 for a window with none yet; the overlap catches them later). Stores case type and claim band, plaintiffs,
# defendants, plaintiff attorneys, judge, status and the complaint's docket entry. No complaint is downloaded or read:
# the Clerk's case search makes anonymous users complete a CAPTCHA, so complaints need a registered account first.
# No sign-in, no API key. If the export ever answers with a CAPTCHA, 403 or 429 the run stops with exit 3.
# Docs: docs/CITRUS_COMPLAINTS.md.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${CITRUS_COMPLAINTS_LOCK:-/tmp/citrus_complaints_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== citrus complaints daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== citrus complaints daily starting: $(date -u +%FT%TZ) ==="
"$VENV/bin/python3" -u citrus_complaints.py --days 14
status=$?
[ $status -eq 3 ] && echo "citrus_complaints.py STOPPED: the site refused or showed a CAPTCHA (exit 3) — not retried"
[ $status -ne 0 ] && [ $status -ne 3 ] && echo "citrus_complaints.py FAILED (exit $status)"

echo "=== citrus complaints daily done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
