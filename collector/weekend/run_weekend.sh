#!/bin/bash
# Weekend of 18-21 Sep 2026: direction re-read, then the owner-confirmed fixes.
#
# Launched once by cron at Fri 06:05 UTC (see the crontab lines at the bottom).
# Runs each phase in order and STOPS at the confirmation gate — nothing that
# changes what the dashboard or the email shows happens until the owner has
# confirmed the fix list from Thursday night's QC audit.
#
#   P1  wait for Friday's weekly collection to finish (new week's filings)
#   P2  re-read every Miami-Dade loan-transfer document and store the text
#       (resumes if already started; picks up the new filings; one retry pass)
#   P3  GATE: wait for weekend/APPROVED_FIXES — created only after the owner
#       confirms the fix list AND the fix code is deployed and tested
#   P4  apply the fixes in ONE rebuild (weekend/apply_weekend_fixes.sh), then
#       mark weekend/APPLIED_OK. On failure the dashboard keeps last good data.
#
# Check progress:   cat /opt/amo-dashboard/collector/weekend/STATUS
# Full history:     cat /opt/amo-dashboard/collector/weekend/STATUS.log
# Stop the re-read: touch /opt/amo-dashboard/collector/weekend/STOP

set -u
[ "$(date -u +%Y)" = "2026" ] || exit 0          # one-off: never fires in a later year

DIR=/opt/amo-dashboard/collector/weekend
C=/opt/amo-dashboard/collector
PY=$C/.venv/bin/python3
export AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db

exec 9>"$DIR/.lock"
flock -n 9 || { echo "$(date -u +%FT%TZ) already running — exiting"; exit 0; }

status() {
    local line="$(date -u +%FT%TZ) $*"
    echo "$line" >> "$DIR/STATUS.log"
    echo "$line" > "$DIR/STATUS"
    echo "$line"
}
stored() {
    sqlite3 "$AMO_DB_PATH" "SELECT group_concat(status || '=' || n, ' ') FROM (SELECT status, COUNT(*) n FROM document_text GROUP BY 1)" 2>/dev/null
}

# ── P1 ───────────────────────────────────────────────────────────────────────
status "P1 waiting for Friday's weekly collection to finish"
until [ "$(date -u +%Y%m%d%H%M)" -ge 202609180605 ] && ! pgrep -f "[r]un_weekly.sh" >/dev/null; do
    sleep 300
done
if grep -q "^Completed: Fri Sep 18" "$C/cron.log"; then
    status "P1 weekly collection completed"
else
    status "P1 WARNING: weekly collection did not log 'Completed' — continuing with what was collected; check cron.log"
fi

# ── P2 ───────────────────────────────────────────────────────────────────────
# If a re-read was started by hand earlier, let it finish rather than run two.
while pgrep -f "[r]eread_documents.py" >/dev/null; do
    status "P2 an earlier re-read is still running — waiting ($(stored))"
    sleep 900
done
status "P2 re-reading loan-transfer documents (stored so far: $(stored))"
cd "$C" && $PY -u reread_documents.py --workers 8 >> "$DIR/reread.log" 2>&1
status "P2 first pass finished (stored: $(stored))"
$PY -u reread_documents.py --workers 4 --retry-failed >> "$DIR/reread.log" 2>&1
status "P2 retry pass finished (stored: $(stored))"

# ── P3 ───────────────────────────────────────────────────────────────────────
until [ -f "$DIR/APPROVED_FIXES" ]; do
    status "P3 re-read done — waiting for the owner to confirm the fix list (weekend/APPROVED_FIXES)"
    sleep 1800
done
if [ ! -x "$DIR/apply_weekend_fixes.sh" ]; then
    status "P3 STOPPED: fixes approved but weekend/apply_weekend_fixes.sh is missing — nothing applied"
    exit 1
fi

# ── P4 ───────────────────────────────────────────────────────────────────────
# normalize.py empties the reporting tables while it runs; never overlap it.
while pgrep -f "[n]ormalize.py" >/dev/null; do sleep 60; done
status "P4 applying the confirmed fixes"
if "$DIR/apply_weekend_fixes.sh" >> "$DIR/apply.log" 2>&1; then
    touch "$DIR/APPLIED_OK"
    status "P4 APPLIED OK — Monday email is clear to preview"
else
    status "P4 APPLY FAILED — see weekend/apply.log; dashboard keeps its last good data; Monday email will not send"
    exit 1
fi

# Crontab (UTC; the day/month fields make each fire once, the year check above
# stops a repeat next year). Remove after the weekend.
#   5 6 18 9 *  /opt/amo-dashboard/collector/weekend/run_weekend.sh >> /opt/amo-dashboard/collector/weekend/weekend.log 2>&1
#   0 11 21 9 * /opt/amo-dashboard/collector/weekend/monday_email.sh preview >> /opt/amo-dashboard/collector/weekend/email.log 2>&1
#   0 13 21 9 * /opt/amo-dashboard/collector/weekend/monday_email.sh send >> /opt/amo-dashboard/collector/weekend/email.log 2>&1
