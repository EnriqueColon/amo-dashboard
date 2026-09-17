#!/bin/bash
# Whole-tool QC audit — read-only. Scheduled Thu 17 Sep 2026 17:00 ET (21:00 UTC)
# at the owner's request, ahead of the weekend fix run. Also runnable by hand:
#   /opt/amo-dashboard/collector/qc/run_qc.sh --now [--sample-scale 0.2]
#
# Writes everything to collector/qc/out/<UTC timestamp>/ and links it as
# collector/qc/out/latest. REPORT.md is the combined result; DONE marks
# completion (the scheduled review task waits for it).

set -u
if [ "${1:-}" != "--now" ]; then
    [ "$(date -u +%F)" = "2026-09-17" ] || exit 0     # one-off schedule
else
    shift
fi
SCALE_ARGS=("$@")

APP=/opt/amo-dashboard
C=$APP/collector
PY=$C/.venv/bin/python3
OUT=$C/qc/out/$(date -u +%Y%m%dT%H%MZ)
mkdir -p "$OUT"
ln -sfn "$OUT" "$C/qc/out/latest"
LOG="$OUT/run.log"
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
export AMO_DB_PATH=$APP/miami_dade_amo.db

say "QC started"
# Never audit a half-built table: normalize.py empties the reporting tables while it runs.
while pgrep -f "[n]ormalize.py" >/dev/null; do say "waiting for normalize.py to finish"; sleep 60; done

# 1. Guardrail tests ---------------------------------------------------------
say "1/5 guardrail tests"
{
  echo "## H. Guardrail tests"; echo
  cd "$C"
  for t in tests/check_*.py; do
      if timeout 300 $PY "$t" > "$OUT/test_$(basename "$t").log" 2>&1; then r=OK; else r=FAIL; fi
      echo "- **[$r] $(basename "$t")** — $(tail -1 "$OUT/test_$(basename "$t").log")"
  done
  cd "$APP"
  for t in script/check-*.ts; do
      if timeout 300 /usr/bin/npx tsx "$t" > "$OUT/test_$(basename "$t").log" 2>&1; then r=OK; else r=FAIL; fi
      echo "- **[$r] $(basename "$t")** — $(grep -v 'npm notice' "$OUT/test_$(basename "$t").log" | tail -1)"
  done
  if timeout 600 node_modules/.bin/tsc --noEmit > "$OUT/test_tsc.log" 2>&1; then r=OK; else r=FAIL; fi
  echo "- **[$r] TypeScript type check** — $(grep -c 'error TS' "$OUT/test_tsc.log") errors"
  echo
} > "$OUT/qc_tests.md" 2>&1

# 2. Data, accuracy against documents, operations ----------------------------
say "2/5 data and document accuracy audit"
cd "$C" && timeout 5400 $PY -u qc/qc_audit.py "$OUT" "${SCALE_ARGS[@]}" >> "$LOG" 2>&1 || say "qc_audit.py exited non-zero"

# 3. Dashboard endpoints on a copy of the database ---------------------------
say "3/5 dashboard endpoints (on a database copy)"
COPY=/tmp/qc_copy.db
rm -f "$COPY" "$COPY"-wal "$COPY"-shm
sqlite3 "$AMO_DB_PATH" "VACUUM INTO '$COPY'"
cd "$APP" && AMO_DB_PATH=$COPY timeout 1800 /usr/bin/npx tsx collector/qc/qc_routes.ts "$OUT" >> "$LOG" 2>&1 || say "qc_routes.ts exited non-zero"
say "   database copy integrity: $(sqlite3 "$COPY" 'PRAGMA quick_check;' | head -1)"
echo "- **[INFO] database integrity (quick_check on copy)** — $(sqlite3 "$COPY" 'PRAGMA quick_check;' | head -1)" >> "$OUT/qc_routes.md"
rm -f "$COPY" "$COPY"-wal "$COPY"-shm

# 4. Email — build and verify, never send ------------------------------------
say "4/5 email (build and verify only — nothing is sent)"
{
  echo "## J. Weekly email (not sent)"; echo
  cd "$APP"
  set -a; . ./.env; set +a
  CHK=$(/usr/bin/npx tsx server/scripts/sendWeeklyReport.ts --check 2>&1 | grep -v 'npm notice')
  echo "$CHK" | grep -q "credentials work" && r=OK || r=FAIL
  echo "- **[$r] Microsoft Graph credentials and mailbox** — $(echo "$CHK" | tail -2 | head -1)"
  PRE=$(REPORT_RECIPIENTS=qc-dry-run@invalid.example /usr/bin/npx tsx server/scripts/sendWeeklyReport.ts 2>&1)
  ROWS=$(echo "$PRE" | sed -n 's/^Clean AMO events: *\([0-9]*\) rows/\1/p')
  HTML=$(ls -t server/scripts/output/report-preview-*.html | head -1)
  CSV=$(ls -t server/scripts/output/clean-events-*.csv | head -1)
  [ "${ROWS:-0}" -gt 0 ] && r=OK || r=FAIL
  echo "- **[$r] report builds** — ${ROWS:-0} transfers in the 15-day window"
  grep -q ">Miami-Dade<" "$HTML" && grep -q ">Broward<" "$HTML" && r=OK || r=FAIL
  echo "- **[$r] both counties in the coverage line**"
  grep -qiE '(^|,)"?(WILMINGTON SAVINGS|MERS|FANNIE MAE|FREDDIE MAC)"?(,|$)' "$CSV" && r=FAIL || r=OK
  echo "- **[$r] hidden companies absent from the email**"
  echo "- **[INFO] Friday send switch (REPORT_EMAIL_ENABLED)** — ${REPORT_EMAIL_ENABLED:-off}"
  crontab -l | grep -q "weekend/monday_email.sh" && r=OK || r=FAIL
  echo "- **[$r] Monday 09:00 ET send scheduled** — $(crontab -l | grep 'weekend/monday_email.sh' | cut -c1-40)"
  echo
} > "$OUT/qc_email.md" 2>&1

# 5. Combine --------------------------------------------------------------------
say "5/5 combining report"
{
  echo "# AMO Dashboard — QC audit"
  echo
  echo "Run $(date -u '+%Y-%m-%d %H:%M UTC') · read-only · database $(stat -c %y "$AMO_DB_PATH" | cut -c1-16)"
  echo
  cat "$OUT"/qc_*.md | grep -hoE '\*\*\[(FAIL|WARN|OK|INFO)\]' | sort | uniq -c | sed 's/\*\*\[/ /; s/\]//' | tr '\n' ' '
  echo; echo
  sed '1,/^FAIL/d' "$OUT/qc_data.md" 2>/dev/null || true
  cat "$OUT/qc_routes.md" 2>/dev/null
  echo
  cat "$OUT/qc_email.md" "$OUT/qc_tests.md" 2>/dev/null
} > "$OUT/REPORT.md"
touch "$OUT/DONE"
say "QC finished — $OUT/REPORT.md"
