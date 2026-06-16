#!/bin/bash
# Weekly collection + PDF extraction + normalization — runs every Friday via cron
# Cron: 0 6 * * 5 /opt/amo-dashboard/collector/run_weekly.sh >> /opt/amo-dashboard/collector/cron.log 2>&1
#
# Required env (set below or export beforehand):
#   OPENAI_API_KEY  - for extract_pdfs.py + enrich_entities.py (gpt-4.1-nano)
#   OPENAI_MODEL    - optional, defaults to gpt-4.1-nano
#   CLERK_EMAIL / CLERK_PASSWORD - clerk portal login (or a local config.py)

set -e
export AMO_DB_PATH="/opt/amo-dashboard/miami_dade_amo.db"
COLLECTOR_DIR="/opt/amo-dashboard/collector"
VENV="$COLLECTOR_DIR/.venv"

# Date range: last 10 days (overlapping window catches late-filed records)
START=$(date -d "10 days ago" +%Y-%m-%d 2>/dev/null || date -v-10d +%Y-%m-%d)
END=$(date +%Y-%m-%d)

echo "========================================"
echo "Weekly Run: $START → $END"
echo "Started: $(date)"
echo "========================================"

cd "$COLLECTOR_DIR"

# 1. Collect new records (all configured doc types: AMO, ASG, AIT)
"$VENV/bin/python3" collect_live.py --start "$START" --end "$END"

# 2. Extract data from the recorded PDFs (newest first, capped per run)
"$VENV/bin/python3" extract_pdfs.py --limit 1500

# 3. Rebuild normalized tables (applies loan-transfer filter + extracted fields)
"$VENV/bin/python3" normalize.py

# 4. LLM fallback classification for new entities
"$VENV/bin/python3" enrich_entities.py

echo "Completed: $(date)"
