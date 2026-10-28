#!/bin/bash
# Nightly off-box backup of the Market Intelligence data that lives on this
# droplet since the merge (docs/MARKET_INTEL_MERGE_SESSION.md): its local
# PostgreSQL database and the uploaded research PDFs. On Vercel these were
# durable managed services (Vercel Postgres, Vercel Blob); here they are one
# directory and one database on one disk, so they get the same treatment as
# the AMO database — a verified snapshot, shipped to the Space, rotated locally.
#
# Cron entry, 03:45 UTC — after run_backup.sh (03:15) and before anything else:
#   45 3 * * * /opt/amo-dashboard/collector/run_mi_backup.sh >> /opt/amo-dashboard/collector/mi_backup.log 2>&1
#
# Deliberately a separate script rather than a section of run_backup.sh: that
# script's status row, derived-table checks and rotation guard are all about
# the AMO SQLite database, and a failure here must not mark the AMO backup as
# failed (or the other way round). Credentials and rclone flags are shared —
# read the comments in run_backup.sh before changing them.

set -u

APP_DIR="${APP_DIR:-/opt/amo-dashboard}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
MI_DB="${MI_DB:-market_intelligence}"
MI_UPLOADS="${MI_UPLOADS:-/opt/market-intelligence-uploads}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"

# shellcheck disable=SC1091
[ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
export RCLONE_CONFIG=/dev/null
RCLONE_OPTS="--s3-no-check-bucket --s3-acl="

STAMP=$(date -u +%Y%m%d-%H%M%S)
SNAP="$BACKUP_DIR/mi-$STAMP.sql.gz"
mkdir -p "$BACKUP_DIR" || exit 1

echo "=== MI backup starting: $(date -u +%FT%TZ) ==="

fail() { echo "MI BACKUP FAILED: $1"; exit 1; }

# ── 1. Consistent dump ───────────────────────────────────────────────────────
# pg_dump takes a transaction-consistent snapshot while the app keeps writing;
# run as the postgres superuser over the local socket so no password is needed.
# --clean --if-exists makes the restore a plain `gunzip -c | psql`.
sudo -u postgres pg_dump --clean --if-exists --no-owner "$MI_DB" 2>/tmp/mi_pg_dump.err | gzip -9 > "$SNAP"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    rm -f "$SNAP"; fail "pg_dump: $(head -c 300 /tmp/mi_pg_dump.err)"
fi
rm -f /tmp/mi_pg_dump.err
[ -s "$SNAP" ] || fail "dump is empty"

# ── 2. Verify before trusting it ─────────────────────────────────────────────
# A dump that gunzips and ends with pg_dump's own trailer is complete; one cut
# off mid-stream (disk full, OOM) is not, and would restore a partial database.
gzip -t "$SNAP" || { rm -f "$SNAP"; fail "gzip integrity check failed"; }
if ! gunzip -c "$SNAP" | tail -n 5 | grep -q "PostgreSQL database dump complete"; then
    rm -f "$SNAP"; fail "dump has no completion trailer"
fi
tables=$(gunzip -c "$SNAP" | grep -c "^CREATE TABLE")
bytes=$(wc -c < "$SNAP" | tr -d ' ')
echo "dump ok — $tables tables, $bytes bytes → $(basename "$SNAP")"

# ── 3. Off-box copy ──────────────────────────────────────────────────────────
status=ok
if [ -z "$BACKUP_REMOTE" ]; then
    status=local_only; echo "WARNING: BACKUP_REMOTE not set in .env — kept locally only"
elif ! command -v rclone >/dev/null 2>&1; then
    status=local_only; echo "WARNING: rclone not installed — kept locally only"
else
    if rclone copy $RCLONE_OPTS --no-traverse "$SNAP" "$BACKUP_REMOTE/mi_db/"; then
        echo "uploaded dump → $BACKUP_REMOTE/mi_db/"
    else
        status=local_only; echo "WARNING: rclone upload of the dump failed"
    fi
    # Uploaded PDFs: copied, never synced, so a local deletion cannot propagate
    # to the only other copy (same rule as broward_images in run_backup.sh).
    if [ -d "$MI_UPLOADS" ]; then
        if rclone copy $RCLONE_OPTS "$MI_UPLOADS" "$BACKUP_REMOTE/mi_uploads/"; then
            echo "copied uploads → $BACKUP_REMOTE/mi_uploads/ ($(find "$MI_UPLOADS" -type f | wc -l) files)"
        else
            status=local_only; echo "WARNING: rclone copy of uploads failed"
        fi
    fi
fi

# ── 4. Rotate local dumps ────────────────────────────────────────────────────
ls -1t "$BACKUP_DIR"/mi-*.sql.gz 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | while read -r old; do
    echo "rotating out $(basename "$old")"; rm -f "$old"
done

echo "=== MI backup done: $(date -u +%FT%TZ) — status=$status ==="
[ "$status" = ok ]
