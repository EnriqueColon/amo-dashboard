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
# --since scopes this to only the last ~6 months of documents, for a much
# faster partial backfill ahead of a deadline. Once you no longer need that
# time pressure, remove the --since flag entirely (or push the date further
# back) to let it continue backfilling the rest of history — no other state
# needs to change, it just picks up more documents as pending on the next tick.

set -u
cd /opt/amo-dashboard/collector
source /opt/amo-dashboard/.env

.venv/bin/python3 batch_extract_facility.py --tick --since 2026-01-16
