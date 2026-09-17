#!/bin/bash
# P5 of the weekend run: prove the weekly email works on the corrected data
# before Monday's real send. Fails (non-zero) on the first problem.
#
#   1. Graph credentials and the sending mailbox still work
#   2. the report builds, has transfers from BOTH counties, and contains none of
#      the four names the dashboard hides
#   3. a real send to the owner's test addresses succeeds
set -u
cd /opt/amo-dashboard || exit 1
set -a; . ./.env; set +a      # GRAPH_* lines lack `export`
say() { echo "$(date -u +%FT%TZ) [email-check] $*"; }
NPX=/usr/bin/npx

say "1/3 Graph credentials"
$NPX tsx server/scripts/sendWeeklyReport.ts --check 2>&1 | grep -v "npm notice" | tee /tmp/emailcheck.out
grep -q "Graph credentials work" /tmp/emailcheck.out || { say "FAIL: Graph check"; exit 1; }

say "2/3 report content"
export REPORT_RECIPIENTS="mktinfo@safeharborcp.com,enriquec012@outlook.com"
OUT=$($NPX tsx server/scripts/sendWeeklyReport.ts 2>&1)
echo "$OUT" | grep -E "^To:|Clean AMO|Lending"
[ "$(echo "$OUT" | grep '^To:')" = "To:      mktinfo@safeharborcp.com, enriquec012@outlook.com" ] || { say "FAIL: recipients"; exit 1; }
ROWS=$(echo "$OUT" | sed -n 's/^Clean AMO events: *\([0-9]*\) rows/\1/p')
[ "${ROWS:-0}" -gt 0 ] || { say "FAIL: report has no transfers (mid-rebuild?)"; exit 1; }
HTML=$(ls -t server/scripts/output/report-preview-*.html | head -1)
grep -q ">Miami-Dade<" "$HTML" && grep -q ">Broward<" "$HTML" || { say "FAIL: a county is missing from the coverage line"; exit 1; }
CSV=$(ls -t server/scripts/output/clean-events-*.csv | head -1)
if grep -qiE '(^|,)"?(WILMINGTON SAVINGS|MERS|FANNIE MAE|FREDDIE MAC)"?(,|$)' "$CSV"; then
    say "FAIL: a hidden company appears in the CSV"; exit 1
fi
say "content ok: $ROWS transfers, both counties, hidden companies absent"

say "3/3 real send to the owner's test addresses"
$NPX tsx server/scripts/sendWeeklyReport.ts --send 2>&1 | grep -v "npm notice" | tee /tmp/emailcheck.out
grep -q "^Sent via" /tmp/emailcheck.out || { say "FAIL: send"; exit 1; }
say "PASS"
