#!/bin/bash
# Weekend of 18-21 Sep 2026 — the owner's sequence (agreed Thu 17 Sep):
#
#   Thu 17:00 ET  QC audit runs; the owner receives the results and fix list
#   P0  GATE: nothing below starts until the owner confirms (weekend/APPROVED_FIXES)
#   P1  wait for Friday's weekly collection to finish (the new week's filings)
#   P2  re-read every Miami-Dade loan-transfer document and store the text
#   P3  GATE: wait until the confirmed fixes are built, tested and deployed
#       (weekend/READY_FIXES, created only once weekend/apply_weekend_fixes.sh
#       exists and its tests pass)
#   P4  apply every confirmed fix in ONE rebuild → weekend/APPLIED_OK
#       On failure the dashboard keeps its last good data.
#   P5  check the email end to end on the corrected data, including a real
#       send to the owner's test addresses → weekend/EMAIL_CHECK_OK
#   Mon 09:00 ET  monday_email.sh sends to the named recipients, only if
#       APPLIED_OK and EMAIL_CHECK_OK both exist.
#
# Launched by cron Fri 06:05 UTC (02:05 ET); it waits at P0/P1 as needed.
# Check progress:  cat /opt/amo-dashboard/collector/weekend/STATUS
# History:         cat /opt/amo-dashboard/collector/weekend/STATUS.log
# Stop re-read:    touch /opt/amo-dashboard/collector/weekend/STOP

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

# ── P0 owner confirmation ───────────────────────────────────────────────────
until [ -f "$DIR/APPROVED_FIXES" ]; do
    status "P0 waiting for the owner to confirm the QC fix list (weekend/APPROVED_FIXES) — nothing has started"
    sleep 900
done
status "P0 owner confirmed the fix list"

# ── P1 weekly collection ────────────────────────────────────────────────────
status "P1 waiting for Friday's weekly collection to finish"
until [ "$(date -u +%Y%m%d%H%M)" -ge 202609180605 ] && ! pgrep -f "[r]un_weekly.sh" >/dev/null; do
    sleep 300
done
if grep -q "^Completed: Fri Sep 18" "$C/cron.log"; then
    status "P1 weekly collection completed"
else
    status "P1 WARNING: weekly collection did not log 'Completed' — continuing with what was collected; check cron.log"
fi

# ── P2 re-read ──────────────────────────────────────────────────────────────
while pgrep -f "[r]eread_documents.py" >/dev/null; do
    status "P2 an earlier re-read is still running — waiting ($(stored))"
    sleep 900
done
status "P2 re-reading loan-transfer documents (stored so far: $(stored))"
cd "$C" && $PY -u reread_documents.py --workers 8 >> "$DIR/reread.log" 2>&1
status "P2 first pass finished (stored: $(stored))"
$PY -u reread_documents.py --workers 4 --retry-failed >> "$DIR/reread.log" 2>&1
status "P2 retry pass finished (stored: $(stored))"

# ── P3 fix code ready ───────────────────────────────────────────────────────
until [ -f "$DIR/READY_FIXES" ] && [ -x "$DIR/apply_weekend_fixes.sh" ]; do
    status "P3 re-read done — waiting for the confirmed fixes to be built and tested (weekend/READY_FIXES)"
    sleep 1800
done

# ── P4 apply ────────────────────────────────────────────────────────────────
# normalize.py empties the reporting tables while it runs; never overlap it.
while pgrep -f "[n]ormalize.py" >/dev/null; do sleep 60; done
status "P4 applying the confirmed fixes"
if "$DIR/apply_weekend_fixes.sh" >> "$DIR/apply.log" 2>&1; then
    touch "$DIR/APPLIED_OK"
    status "P4 APPLIED OK"
else
    status "P4 APPLY FAILED — see weekend/apply.log; dashboard keeps its last good data; Monday email will not send"
    exit 1
fi

# ── P5 email check ──────────────────────────────────────────────────────────
status "P5 checking the email on the corrected data"
if "$DIR/check_email.sh" >> "$DIR/email.log" 2>&1; then
    touch "$DIR/EMAIL_CHECK_OK"
    status "P5 EMAIL CHECK OK — Monday 09:00 ET send is armed"
else
    status "P5 EMAIL CHECK FAILED — see weekend/email.log; Monday email will not send"
    exit 1
fi

# Crontab (UTC; day/month fields fire once, year guards stop a repeat). Remove after 21 Sep.
#   5 6 18 9 *  /opt/amo-dashboard/collector/weekend/run_weekend.sh >> /opt/amo-dashboard/collector/weekend/weekend.log 2>&1
#   0 13 21 9 * /opt/amo-dashboard/collector/weekend/monday_email.sh >> /opt/amo-dashboard/collector/weekend/email.log 2>&1
