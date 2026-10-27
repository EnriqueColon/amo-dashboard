#!/bin/bash
# Bank Stress Ranking — weekly refresh from the FDIC BankFind API.
#
# Cron entry (crontab -e):
#   0 3 * * 0 /opt/amo-dashboard/collector/run_bank_stress.sh >> /opt/amo-dashboard/collector/bank_stress.log 2>&1
#
# Sunday 03:00 UTC: nothing else runs then (nightly normalize is 08:30, the
# county pulls 12:30–22:30, the weekly email Monday 11:00). The FDIC publishes
# a quarter ~60 days after it closes; until then the run re-pulls the same
# quarters (restatements included) and recomputes — about one minute in all.
#
# Writes only /opt/amo-dashboard/bank_stress.db. Never touches
# miami_dade_amo.db (the `link` step opens it read-only to copy the
# cert ↔ canonical-name map, and skips if it cannot). No PM2 restart is
# needed: the server keys its cache on the compute timestamp.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${BANK_STRESS_LOCK:-/tmp/bank_stress.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== bank stress SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== bank stress starting: $(date -u +%FT%TZ) ==="
"$VENV/bin/python3" -u -m bank_stress.cli all
status=$?
if [ $status -ne 0 ]; then
    echo "bank_stress FAILED (exit $status)"
fi
echo "=== bank stress done — exit $status: $(date -u +%FT%TZ) ==="
exit $status
