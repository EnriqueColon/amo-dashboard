#!/bin/bash
# Facility/warehouse-credit-line extraction backfill — one "tick" of the
# automatic build/submit/poll/ingest state machine in batch_extract_facility.py.
# Meant to be invoked periodically by cron, not run by hand.
#
# Cron entry (crontab -e), every 20 minutes:
#   */20 * * * * /opt/amo-dashboard/collector/run_facility_tick.sh >> /opt/amo-dashboard/collector/batch/tick.log 2>&1
#
# Each tick: polls any in-flight OpenAI Batch API jobs, ingests ones that
# finished, and tops back up to 2 concurrent batches of 500 documents each
# (newest recorded first) as long as the backlog isn't drained. State is
# tracked in the batch_jobs / batch_job_documents tables in miami_dade_amo.db,
# so it's safe to let this run untouched — it resumes correctly between ticks
# and after any restart.
#
# No --since flag: backfills all collected history (assignments start
# 2023-01-03). A --since date was used temporarily in July 2026 to prioritize
# the most recent ~6 months ahead of a deadline; that window is fully
# processed, so the tick now works backward through the rest of history
# (newest first). Re-adding --since YYYY-MM-DD re-scopes it any time —
# no other state needs to change.

set -u
cd /opt/amo-dashboard/collector
source /opt/amo-dashboard/.env

# ── Stand aside while a main extraction backfill is running ──────────────────
# Both jobs download from the same Miami-Dade clerk endpoint and OCR on the same
# 4 cores. On 2026-08-15, with the 50k repair backfill holding the portal, this
# tick failed 10 out of 10 documents with read timeouts — burning CPU and
# connections to accomplish nothing, and slowing the backfill while doing it.
#
# The tick was paused in crontab that day, which worked but created the worse
# problem: a disabled cron nobody remembers to re-enable. This check is the
# durable version — the cron entry stays live, and the tick simply yields for as
# long as a backfill is running, then resumes on its own with no human step.
#
# Deliberately narrow: it matches the main extractor only. A tick skipped here
# costs nothing, because the state machine is resume-safe by design and the next
# tick is 20 minutes away.
if pgrep -f "[e]xtract_pdfs.py" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) main extraction backfill is running — skipping this tick"
    exit 0
fi

# --max-concurrent 4 sized for the 4 vCPU / 8GB droplet (resized 2026-07-21);
# OCR workers auto-scale to os.cpu_count() capped at 4. On a smaller box,
# drop this back to 2.
# -u: unbuffered stdout so tick.log updates live (same lesson as normalize.py —
# without it, output only appears in buffered bursts and a healthy quiet run
# looks stalled).
.venv/bin/python3 -u batch_extract_facility.py --tick --max-concurrent 4
