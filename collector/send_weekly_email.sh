#!/bin/bash
# The AMO Market Monitor email — Mondays, 07:00 Eastern.
#
# Cron:
#   0 11,12 * * 1 /opt/amo-dashboard/collector/send_weekly_email.sh >> /opt/amo-dashboard/collector/email.log 2>&1
#
# TWO firings, ONE send. The droplet clock is Etc/UTC with no DST, so no single
# UTC hour is 07:00 Eastern all year: 11:00 UTC is 07:00 EDT in summer, 12:00 UTC
# is 07:00 EST in winter. CRON_TZ=America/New_York would be the tidier fix, but
# this box's cron (3.0pl1-184ubuntu2) ships no man page and its binary contains
# no CRON_TZ string, so support is unverified — and a scheduling feature that
# silently does not work would move the send by an hour without anyone noticing.
# Instead cron fires at both candidate hours and the Eastern-hour guard below
# lets exactly one through. tzdata is installed (America/New_York present).
#
# Why this is its own script and not step 5 of run_weekly.sh (where it lived
# until 2 Oct 2026): the owner wants the report to land Monday morning, and
# run_weekly.sh runs Friday 06:00 UTC. Sending from inside the collection run
# tied the send day to the collection day. They are now independent — Friday
# still collects and rebuilds, Monday only sends.
#
# Monday is deliberately AFTER Friday's collection: Miami-Dade is collected only
# in that weekly run, so a Monday report reads Miami-Dade through Friday and
# Broward (collected daily) through Sunday. That is not a gap in the numbers —
# each county's windows end on its own latest recorded date, so neither county
# gets credited with empty days it was simply not collected for.
#
# Sends nothing unless REPORT_EMAIL_ENABLED=1 is set in /opt/amo-dashboard/.env.
# The owner approves the content before that gate is opened.
#
# DRY_RUN=1 runs the whole path — gate, normalize wait, env, tsx — in the send
# script's preview mode, which writes HTML/CSV locally and mails no one. Use it
# to test this wrapper without putting a report in front of a recipient.
# FORCE=1 skips the Eastern-hour guard, for running it by hand off-schedule.

set -u

APP_DIR=/opt/amo-dashboard
SEND_HOUR_ET=07
say() { echo "$(date -u +%FT%TZ) [weekly-email] $*"; }

say "start (Eastern $(TZ=America/New_York date '+%F %H:%M %Z'))"

# See the two-firings note above: cron wakes this script twice on Monday and
# only the 07:00 Eastern one is a real send.
if [ "${FORCE:-}" != "1" ] && [ "${DRY_RUN:-}" != "1" ]; then
    now_et=$(TZ=America/New_York date +%H)
    if [ "$now_et" != "$SEND_HOUR_ET" ]; then
        say "not the send hour (Eastern ${now_et}:00, want ${SEND_HOUR_ET}:00) — exiting"
        exit 0
    fi
fi

if [ "${REPORT_EMAIL_ENABLED:-}" != "1" ]; then
    # Read the gate out of .env too: cron hands this script no environment, so
    # the value almost always comes from the file rather than the caller.
    if [ -f "$APP_DIR/.env" ] && grep -qE '^[[:space:]]*(export[[:space:]]+)?REPORT_EMAIL_ENABLED=1[[:space:]]*$' "$APP_DIR/.env"; then
        :
    else
        say "SKIPPED: REPORT_EMAIL_ENABLED is not 1 — nothing sent"
        exit 0
    fi
fi

# normalize.py empties aom_events_clean and refills it in place over roughly 90
# minutes. The nightly rebuild starts 08:30 UTC and has been finishing by about
# 10:00, so a 07:00 ET send (11:00 UTC in summer, 12:00 in winter) normally
# clears it — but wait rather than assume, because a report built mid-rebuild
# reads zero transfers. "[n]ormalize" so pgrep never matches this line itself.
waited=0
while pgrep -f "[n]ormalize\.py" >/dev/null && [ "$waited" -lt 10800 ]; do
    sleep 60; waited=$((waited + 60))
done
if [ "$waited" -gt 0 ]; then say "waited ${waited}s for a running normalize.py"; fi

cd "$APP_DIR" || { say "FAILED: $APP_DIR is missing"; exit 1; }

# GRAPH_* in .env are plain KEY=value lines, not `export` lines like the rest of
# the file — without set -a node never sees the Graph credentials and the send
# fails on authentication.
set -a; . ./.env; set +a

if [ "${DRY_RUN:-}" = "1" ]; then
    say "DRY RUN — preview only, nothing will be sent"
    /usr/bin/npx tsx server/scripts/sendWeeklyReport.ts 2>&1 | grep -v "npm notice"
    rc=${PIPESTATUS[0]}
else
    /usr/bin/npx tsx server/scripts/sendWeeklyReport.ts --send 2>&1 | grep -v "npm notice"
    rc=${PIPESTATUS[0]}
fi

# sendWeeklyReport exits 2 when it refuses a 0-row report, 1 on a real failure.
# Both are worth seeing in the log as a distinct line, since cron mail is off.
if [ "$rc" -eq 0 ]; then
    say "done"
elif [ "$rc" -eq 2 ]; then
    say "NOT SENT: the report came back empty (table most likely mid-rebuild)"
else
    say "FAILED: sendWeeklyReport exited $rc"
fi
exit "$rc"
