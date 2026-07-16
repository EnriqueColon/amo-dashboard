#!/bin/bash
# Facility/warehouse-credit-line extraction backfill — one "tick" of the
# automatic build/submit/poll/ingest state machine in batch_extract_facility.py.
# Meant to be invoked periodically by cron, not run by hand.
#
# Cron entry (crontab -e), every 20 minutes:
#   */20 * * * * /opt/amo-dashboard/collector/run_facility_tick.sh >> /opt/amo-dashboard/collector/batch/tick.log 2>&1
#
# Each tick: polls any in-flight OpenAI Batch API jobs, ingests ones that
# finished, and tops back up to 3 concurrent batches of 3000 documents each
# (newest recorded first) as long as the backlog isn't drained. State is
# tracked in the batch_jobs / batch_job_documents tables in miami_dade_amo.db,
# so it's safe to let this run untouched — it resumes correctly between ticks
# and after any restart.

set -u
cd /opt/amo-dashboard/collector
source /opt/amo-dashboard/.env

.venv/bin/python3 batch_extract_facility.py --tick
