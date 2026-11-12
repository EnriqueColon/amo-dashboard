#!/bin/bash
# Weekly retry of document reads that failed (every county).
#
# Cron entry (crontab -e), Saturdays 05:00 UTC = midnight Eastern in winter,
# 1 AM in summer, when no other collector or rebuild is running:
#   0 5 * * 6 /opt/amo-dashboard/collector/run_retry_failed_reads_weekly.sh >> /opt/amo-dashboard/collector/retry_failed_reads.log 2>&1
#
# Why (12 Nov 2026): a normal extraction pass reads only documents that have
# never been read. A document whose image download or OCR failed (for example
# a Clerk timeout) or whose AI read failed stays failed for good, because
# nothing scheduled ever looked at it again. On 12 Nov that was 118 Hillsborough
# documents from 2 Nov, 5 Hillsborough LLM/download errors and 1 Miami-Dade
# document from 2023; the 5 Miami-Dade timeouts from the 10 Nov catch-up were
# retried by hand the same day (5/5 read).
#
# `extract_pdfs.py --retry-errors` covers every non-OK row plus OK rows with no
# extracted data. Image download and OCR run on the droplet and cost nothing;
# only a document that now reads cleanly reaches the paid AI step, so the
# budget below caps the worst case. A document that is genuinely unreadable is
# simply tried again next week (a download plus OCR, a few seconds).
#
# The exit code reports a crash, not leftover failures: a document that is
# unreadable for good would otherwise keep this job red on the Collection Log
# for ever. The leftover count is printed at the end of every run instead.

set -u
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# OPENAI_API_KEY for extraction; cron starts with a bare environment.
# shellcheck disable=SC1091
[ -f /opt/amo-dashboard/.env ] && . /opt/amo-dashboard/.env

cd "$COLLECTOR_DIR" || exit 1

LOCKFILE="${RETRY_READS_LOCK:-/tmp/retry_failed_reads_weekly.lock}"
exec 9>"$LOCKFILE" || exit 1
if ! flock -n 9; then
    echo "=== retry failed reads SKIPPED $(date -u +%FT%TZ): another run holds $LOCKFILE ==="
    exit 0
fi

echo "=== retry failed reads starting: $(date -u +%FT%TZ) ==="
status=0

leftover() {
    sqlite3 "$AMO_DB_PATH" "SELECT a.county || ' ' || px.status || ': ' || COUNT(*)
                             FROM pdf_extractions px JOIN assignments a ON a.cfn = px.cfn
                             WHERE px.status <> 'OK' GROUP BY a.county, px.status
                             ORDER BY a.county, px.status" 2>/dev/null
}
echo "Failed reads before:"; leftover | sed 's/^/  /'

if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY not set — nothing retried"
    status=1
else
    for county in MIAMI-DADE BROWARD HILLSBOROUGH; do
        # Never alongside that county's own extraction: both would read the
        # same documents and the second writer wins.
        if pgrep -f "extract_pdfs.py --county $county" >/dev/null; then
            echo "── $county: an extraction is already running — skipped this week"
            continue
        fi
        echo "── $county ──"
        "$VENV/bin/python3" -u extract_pdfs.py --county "$county" --retry-errors \
            --limit 300 --budget 1.00 --workers 2
        rc=$?
        [ $rc -ne 0 ] && echo "extract_pdfs.py --county $county FAILED (exit $rc)" && status=1
    done
fi

echo "Failed reads after:"; leftover | sed 's/^/  /'
echo "=== retry failed reads done: $(date -u +%FT%TZ) — exit $status ==="
exit $status
