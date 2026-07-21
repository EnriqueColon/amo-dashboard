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

# --max-concurrent 4 sized for the 4 vCPU / 8GB droplet (resized 2026-07-21);
# OCR workers auto-scale to os.cpu_count() capped at 4. On a smaller box,
# drop this back to 2.
.venv/bin/python3 batch_extract_facility.py --tick --max-concurrent 4
