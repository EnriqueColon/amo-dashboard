#!/bin/bash
# Re-collect every Miami-Dade day that hit the portal's 500-row cap.
#
# collect_live.py now partitions a capped day by first-party name prefix (see
# collect_day_partitioned), so re-running a single day that was stored
# truncated recovers it. This walks every day collection_log recorded as
# CAPPED with no later OK for the same window — 26 as of 15 Oct 2026 — one
# day at a time, about 4–5 minutes each (46 searches a day).
#
# It yields the portal to a reconciliation sweep rather than sharing one login
# with it, and the daily Miami-Dade job defers to a running collect_live.py,
# so this is safe to start at any time:
#   nohup /opt/amo-dashboard/collector/recollect_capped_days.sh > /opt/amo-dashboard/collector/recollect_capped.log 2>&1 &
set -u
cd /opt/amo-dashboard/collector
export AMO_DB_PATH="${AMO_DB_PATH:-/opt/amo-dashboard/miami_dade_amo.db}"
set -a; . /opt/amo-dashboard/.env; set +a
V=.venv/bin/python3

days=$(sqlite3 "$AMO_DB_PATH" "
    SELECT DISTINCT c.date_from FROM collection_log c
     WHERE COALESCE(c.county,'MIAMI-DADE')='MIAMI-DADE' AND c.status='CAPPED'
       AND c.date_from = c.date_to
       AND NOT EXISTS (SELECT 1 FROM collection_log o
                        WHERE COALESCE(o.county,'MIAMI-DADE')='MIAMI-DADE' AND o.status='OK'
                          AND o.doc_type = c.doc_type
                          AND o.date_from = c.date_from AND o.date_to = c.date_to)
     ORDER BY 1")
n=$(echo "$days" | grep -c . || true)
echo "=== RECOLLECT CAPPED DAYS START $(date -u +%FT%TZ) — $n day(s) ==="
i=0
for d in $days; do
    i=$((i + 1))
    while pgrep -f '[r]econcile_counties.py.*MIAMI-DADE' >/dev/null; do sleep 60; done
    echo "--- [$i/$n] $d ---"
    $V -u collect_live.py --start "$d" --end "$d"
done
echo "=== RECOLLECT CAPPED DAYS DONE $(date -u +%FT%TZ) ==="
sqlite3 "$AMO_DB_PATH" "SELECT status, COUNT(*) FROM collection_log
    WHERE COALESCE(county,'MIAMI-DADE')='MIAMI-DADE' AND date_from=date_to AND status IN ('CAPPED','OK')
      AND date_from IN ($(echo "$days" | sed "s/.*/'&'/" | paste -sd, -)) GROUP BY 1"
