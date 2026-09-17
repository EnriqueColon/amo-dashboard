#!/bin/bash
# Monday 21 Sep 2026 weekly email, in two gated steps.
#
#   preview  07:00 ET (11:00 UTC)  to the owner's test addresses only
#   send     09:00 ET (13:00 UTC)  to the named recipients — ONLY if the owner
#                                  approved the preview (weekend/APPROVED_EMAIL)
#
# Both refuse to run unless the weekend fixes applied cleanly
# (weekend/APPLIED_OK): the point of Monday's email is that it carries the
# corrected data, so an email built on uncorrected data is worse than none.
#
# Approve the preview:  touch /opt/amo-dashboard/collector/weekend/APPROVED_EMAIL

set -u
[ "$(date -u +%F)" = "2026-09-21" ] || exit 0     # one-off

DIR=/opt/amo-dashboard/collector/weekend
MODE="${1:-}"
PREVIEW_TO="mktinfo@safeharborcp.com,enriquec012@outlook.com"
REAL_TO="andres@safeharborcp.com,david@safeharborcp.com"

cd /opt/amo-dashboard || exit 1
set -a; . ./.env; set +a      # GRAPH_* lines lack `export`

say() { echo "$(date -u +%FT%TZ) [$MODE] $*"; }

if [ ! -f "$DIR/APPLIED_OK" ]; then
    say "NOT SENT: weekend fixes are not marked applied (weekend/APPLIED_OK missing)"
    exit 1
fi

case "$MODE" in
    preview) TO="$PREVIEW_TO" ;;
    send)
        if [ ! -f "$DIR/APPROVED_EMAIL" ]; then
            say "NOT SENT: the owner has not approved the preview (weekend/APPROVED_EMAIL missing)"
            exit 0
        fi
        TO="$REAL_TO" ;;
    *) say "usage: monday_email.sh preview|send"; exit 2 ;;
esac

export REPORT_RECIPIENTS="$TO"
# Dry run first; send only if the recipient line is exactly what this step
# intends. A wrong list stops here instead of reaching an inbox.
WANT="To:      ${TO//,/, }"
GOT=$(/usr/bin/npx tsx server/scripts/sendWeeklyReport.ts 2>&1 | grep '^To:')
if [ "$GOT" != "$WANT" ]; then
    say "NOT SENT: recipient check failed — expected [$WANT] got [$GOT]"
    exit 1
fi
say "recipients confirmed: $TO"
/usr/bin/npx tsx server/scripts/sendWeeklyReport.ts --send 2>&1 | grep -v "npm notice"
