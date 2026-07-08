#!/bin/bash
# ASG Historical Backfill — collects ASSIGNMENT - ASG documents for the period
# the original backfill missed (Jan 2023 → May 10, 2026), then extracts PDFs
# (capped at $5 LLM spend), classifies them, and rebuilds the clean tables.
#
# Schedule for the weekend with:
#   echo "/opt/amo-dashboard/collector/run_asg_backfill.sh" | at 2:00 AM Saturday
# or run directly:
#   nohup /opt/amo-dashboard/collector/run_asg_backfill.sh > /tmp/asg_backfill.log 2>&1 &

set -u
cd /opt/amo-dashboard/collector
source /opt/amo-dashboard/.env

PY=.venv/bin/python3
echo "════════════════════════════════════════════════════"
echo " ASG Backfill started: $(date)"
echo "════════════════════════════════════════════════════"

echo ""
echo "── Step 1/4: Collect ASG filings 2023-01-01 → 2026-05-10 ──"
$PY collect_live.py --start 2023-01-01 --end 2026-05-10 --doc-types "ASSIGNMENT - ASG"
echo "Collection finished: $(date)"

echo ""
echo "── Step 2/4: Extract PDFs (budget cap \$5) ──"
$PY -u extract_pdfs.py --limit 50000 --budget 5.0
echo "Extraction finished: $(date)"

echo ""
echo "── Step 3/4: Normalize ──"
$PY -u normalize.py
echo "Normalize finished: $(date)"

echo ""
echo "── Step 4/4: Enrich entities ──"
$PY -u enrich_entities.py
echo "Enrichment finished: $(date)"

echo ""
echo "════════════════════════════════════════════════════"
echo " ASG Backfill complete: $(date)"
echo "════════════════════════════════════════════════════"
