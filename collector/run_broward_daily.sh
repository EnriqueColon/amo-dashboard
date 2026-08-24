#!/bin/bash
# Broward daily pull.
#
# THIS IS TIME-CRITICAL. Broward's SFTP feed retains only ~10 days of daily
# files. Anything missed here cannot be recovered from the feed: the yearly
# exports are index-only, so a missed day's IMAGES leave the free channel
# forever and can afterwards only be scraped from the portal one document at a
# time. The index self-heals when the yearly export publishes (up to ~14 months
# later); the images never do.
#
# Cron entries (crontab -e). RUN THIS SEVERAL TIMES A DAY, not once:
#   30 15,19,23 * * * BROWARD_INGEST_INDEX=1 /opt/amo-dashboard/collector/run_broward_daily.sh >> /opt/amo-dashboard/collector/broward_daily.log 2>&1
#
# ── Why three runs and not one ───────────────────────────────────────────────
# Broward's publication time MOVES, and a single cron entry chasing it silently
# falls behind. This script originally ran at 12:30 UTC against an observed
# landing window of 10:27–11:01 UTC. By 2026-08-24 the feed's own mtimes told a
# different story — every one of the 10 files then on the feed had landed
# between 14:27 and 15:28 UTC, with two outliers at 20:29 and 20:52:
#
#   08-18 index 2026-08-21 14:28   img.zip 14:50
#   08-19 index 2026-08-24 14:28   img.zip 14:50
#
# So the 12:30 run had, for at least two weeks, been arriving ~2h BEFORE each
# day's drop and picking it up on the FOLLOWING day's run instead. That still
# worked — the retention window is ~10 business days — but it silently spent a
# day of the safety margin, and it is what made the Overview's staleness banner
# fire every Monday (Sat/Sun publish nothing, and Monday's run was too early for
# the day that had just landed).
#
# Polling a few times a day removes the guess entirely. A run that finds nothing
# new is nearly free: the index step inserts 0 rows, the harvester skips every
# already-complete day, and extraction reports 0 pending and spends $0. The
# 15:30 run catches the normal drop the same day; 19:30 and 23:30 cover a late
# QA pass or a retried upload without anyone re-tuning a cron time.
#
# Also note: Broward publishes on BUSINESS DAYS ONLY and runs ~3 business days
# behind, so "no new images today" is normal on a weekend and is NOT a fault.
# That is why liveness is recorded per-run in `broward_runs` (see the heartbeat
# at the bottom of this script) rather than inferred from when data last landed.
#
# Cost per run is trivial: ~8MB and well under two minutes for a typical day,
# because the harvester reads the zip's central directory and then pulls only
# the assignment byte ranges (~2% of a ~450MB zip).
#
# ── What this does now ───────────────────────────────────────────────────────
# index → images → extraction → (nightly normalize surfaces it). Broward is
# fully live, so this is the whole forward pipeline in one script.
#
# BROWARD_INGEST_INDEX=1 in the crontab makes it ingest the index too and take
# the work list from the database; without it the script falls back to
# --from-feed, reading the day's own index file and touching nothing else.
#
# HISTORY IS DELIBERATELY NOT COVERED HERE. 2023–2025 is index-only: the county
# portal is Cloudflare-gated (403 to every non-browser client, including from
# the droplet) and the sanctioned route for historical images is a bulk order by
# phone, 954-831-4000. So this forward path IS the enrichment story — which is
# why extraction runs here daily rather than waiting for the Friday weekly job.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
BROWARD_INGEST_INDEX="${BROWARD_INGEST_INDEX:-0}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# OPENAI_API_KEY for the extraction step below. Sourced rather than assumed:
# cron starts with a bare environment, so without this the key is absent and
# extraction silently skips.
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

# ── One run at a time ────────────────────────────────────────────────────────
# Needed now that this runs several times a day. A normal run is under two
# minutes, so overlap is not expected on a 4-hour spacing — but paramiko sets a
# connect timeout and no READ timeout, so a stalled ranged read against a ~400MB
# zip can hang for hours. Without a lock, that turns into a pile of processes
# competing for the same SFTP feed and the same SQLite writer.
#
# Exits 0, not 1: an overlapping invocation is a skip, not a failure, and must
# not be reported as a broken job.
LOCKFILE="${BROWARD_LOCK:-/tmp/broward_daily.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== broward daily SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

STARTED=$(date -u +%FT%TZ)
echo "=== broward daily starting: $STARTED ==="

index_status=0
FEED_FLAG="--from-feed"

if [ "$BROWARD_INGEST_INDEX" = "1" ]; then
    # Idempotent — already-collected days are skipped, so the overlapping
    # window costs nothing and covers a day that landed late or a failed run.
    "$VENV/bin/python3" -u broward_collect.py --daily
    index_status=$?
    [ $index_status -ne 0 ] && echo "broward_collect.py FAILED (exit $index_status)"
    # The database is now authoritative for what exists; stop guessing from the feed.
    FEED_FLAG=""
fi

# Images. Runs even if the index step errored part-way: whatever did land is
# worth harvesting against, and the retention clock does not pause for us.
"$VENV/bin/python3" -u broward_images.py --all $FEED_FLAG
image_status=$?
[ $image_status -ne 0 ] && echo "broward_images.py FAILED (exit $image_status)"

# Extract what was just harvested.
#
# Without this the forward path is only as fast as run_weekly.sh (Friday 06:00),
# so a document harvested on Monday waits up to six days before it is readable
# and another night before normalize surfaces it. Since Broward history is
# index-only by decision (the portal is Cloudflare-gated and the bulk-image
# route is a phone call), the forward path IS the enrichment story — it should
# not lag by most of a week.
#
# Scoped to BROWARD so it can never eat the Miami-Dade budget, and capped well
# above a normal day (~55 documents) so a catch-up after a failed run still
# clears in one go. Typical cost is ~$0.03/day.
extract_status=0
if [ -n "${OPENAI_API_KEY:-}" ]; then
    "$VENV/bin/python3" -u extract_pdfs.py --county BROWARD --limit 300 --budget 1.00
    extract_status=$?
    [ $extract_status -ne 0 ] && echo "extract_pdfs.py FAILED (exit $extract_status)"
else
    echo "OPENAI_API_KEY not set — skipping extraction (images are still harvested)"
fi

# ── Retention report + heartbeat ─────────────────────────────────────────────
# Always runs, whatever happened above. Two jobs in one pass:
#
#   1. Print the report. This is the thing to eyeball in the log: any day
#      showing PENDING is on a clock, and any day that scrolls off the top
#      without reaching 'complete' has been permanently lost to the free feed.
#   2. Record the run in `broward_runs`, which is what the Overview reads.
#
# The heartbeat exists because there is no MAILTO and no mail transport on this
# droplet, so a cron that stops is otherwise completely silent. It deliberately
# records THE RUN, not the data: Broward publishes business days only and ~3
# business days behind, so a healthy job routinely finds nothing new for two or
# three days running. Inferring liveness from when data last landed — which is
# what the Overview did until 2026-08-24 — cried wolf every Monday.
#
# The aggregate status is passed in because only this script knows whether the
# earlier steps worked; the pending counts come from the feed read itself.
detail=""
[ $index_status -ne 0 ]   && detail="broward_collect exit $index_status"
[ $image_status -ne 0 ]   && detail="${detail:+$detail; }broward_images exit $image_status"
[ $extract_status -ne 0 ] && detail="${detail:+$detail; }extract_pdfs exit $extract_status"

if [ -z "$detail" ]; then
    run_status=ok
else
    run_status=failed
fi

"$VENV/bin/python3" -u broward_images.py --status $FEED_FLAG \
    --record-run "$run_status" --run-started "$STARTED" --run-detail "$detail"

echo "=== broward daily done: $(date -u +%FT%TZ) — status=$run_status ==="

# Non-zero if any step failed, so cron mail / monitoring notices.
[ "$run_status" = ok ]
