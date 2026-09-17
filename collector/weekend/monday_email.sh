#!/bin/bash
# Monday 21 Sep 2026, 09:00 ET: the weekly email to the named recipients.
#
# Sends automatically, as the owner asked, but only if the weekend's two
# checkpoints both passed:
#   weekend/APPLIED_OK      the confirmed fixes applied cleanly
#   weekend/EMAIL_CHECK_OK  the email was built and test-sent on corrected data
# Without both, it logs why and sends nothing — an email on uncorrected data is
# worse than a late one.

set -u
[ "$(date -u +%F)" = "2026-09-21" ] || exit 0     # one-off

DIR=/opt/amo-dashboard/collector/weekend
TO="andres@safeharborcp.com,david@safeharborcp.com"
say() { echo "$(date -u +%FT%TZ) [monday-send] $*"; }

for f in APPLIED_OK EMAIL_CHECK_OK; do
    [ -f "$DIR/$f" ] || { say "NOT SENT: weekend/$f is missing"; exit 1; }
done

cd /opt/amo-dashboard || exit 1
set -a; . ./.env; set +a      # GRAPH_* lines lack `export`
export REPORT_RECIPIENTS="$TO"

# Dry run first; send only if the recipient line is exactly the intended list.
WANT="To:      ${TO//,/, }"
GOT=$(/usr/bin/npx tsx server/scripts/sendWeeklyReport.ts 2>&1 | grep '^To:')
[ "$GOT" = "$WANT" ] || { say "NOT SENT: recipient check failed — expected [$WANT] got [$GOT]"; exit 1; }
say "recipients confirmed: $TO"
/usr/bin/npx tsx server/scripts/sendWeeklyReport.ts --send 2>&1 | grep -v "npm notice"
