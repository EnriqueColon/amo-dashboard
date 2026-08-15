#!/bin/bash
# Nightly off-box backup of the database and the Broward document images.
#
# Cron entry (crontab -e), 03:15 UTC — deliberately in the one quiet window:
# nightly normalize runs 08:30 and takes ~80 minutes, the Broward daily pull is
# 12:30, the weekly Miami-Dade collect is Friday 06:00. 03:15 collides with
# nothing but the 20-minute facility tick, which is harmless here (see below).
#   15 3 * * * /opt/amo-dashboard/collector/run_backup.sh >> /opt/amo-dashboard/collector/backup.log 2>&1
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Everything irreplaceable in this product lives on one droplet: months of OCR
# and LLM extraction that cost real money to reproduce, and Broward images that
# CANNOT be reproduced at all once the SFTP feed rolls past its ~10-day window.
# Until now the only backups were the four `backup_pre_*.db` files taken by hand
# before risky changes — same disk, same host, no schedule.
#
# ── The one rule that matters ────────────────────────────────────────────────
# NEVER `cp` a live SQLite database. The app is serving and the crons are
# writing, so a byte copy can catch a torn page or miss the 70MB WAL entirely
# and restore to a corrupt file. `sqlite3 .backup` uses the online backup API,
# which takes a consistent snapshot INCLUDING uncommitted WAL content while
# writers carry on. That is why the facility tick overlapping this is fine.
#
# ── Failure policy ───────────────────────────────────────────────────────────
# A backup that silently stops is worse than no backup, because it buys false
# confidence. So: every run records itself in the `backup_runs` table, the
# snapshot is integrity-checked and row-count-asserted BEFORE it is allowed to
# rotate anything away, and /api/stats surfaces staleness on the Overview page
# the same way Broward collection health does. A run that cannot reach the
# remote still keeps a good local snapshot and reports `local_only` rather than
# pretending to have succeeded.

set -u

APP_DIR="${APP_DIR:-/opt/amo-dashboard}"
DB="${AMO_DB_PATH:-$APP_DIR/miami_dade_amo.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
IMAGES_DIR="${IMAGES_DIR:-$APP_DIR/collector/broward_images}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"

# BACKUP_REMOTE and the RCLONE_CONFIG_SPACES_* credentials live in .env, which
# is gitignored. Configuring rclone entirely through environment variables means
# there is no rclone.conf holding a second copy of the secret.
# shellcheck disable=SC1091
[ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

STAMP=$(date -u +%Y%m%d-%H%M%S)
STARTED=$(date -u +%FT%TZ)
SNAP="$BACKUP_DIR/amo-$STAMP.db"
mkdir -p "$BACKUP_DIR" || exit 1

echo "=== backup starting: $STARTED ==="

# The status row is written to the LIVE database, never to the snapshot, and
# only after the snapshot has been taken — so a backup never contains a record
# claiming it succeeded.
#
# busy_timeout is not optional here. This runs against a database the facility
# tick and the app are both using, and without it the INSERT loses a lock race
# and returns "database is locked" — which is the worst possible failure, since
# a backup that WORKED then reports as missing and the Overview raises a false
# alarm. Caught exactly that way in testing against a live writer. Errors are
# printed rather than swallowed for the same reason.
record() {
    sqlite3 "$DB" "
      PRAGMA busy_timeout = 30000;
      CREATE TABLE IF NOT EXISTS backup_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at    TEXT,
        finished_at   TEXT,
        status        TEXT,
        db_bytes      INTEGER,
        archive_bytes INTEGER,
        assignments   INTEGER,
        remote        TEXT,
        detail        TEXT
      );
      INSERT INTO backup_runs (started_at, finished_at, status, db_bytes, archive_bytes, assignments, remote, detail)
      VALUES ('$STARTED', '$(date -u +%FT%TZ)', '$1', ${2:-0}, ${3:-0}, ${4:-0}, '${BACKUP_REMOTE//\'/}', '$(echo "${5:-}" | tr -d "'")');
    " >/dev/null || echo "WARNING: could not record this run in backup_runs — the Overview will report the backup as stale"
}

fail() {
    echo "BACKUP FAILED: $1"
    record failed 0 0 0 "$1"
    exit 1
}

# ── 1. Consistent snapshot ───────────────────────────────────────────────────
# busy_timeout for the same reason as in record() — the online backup API
# restarts if a writer commits mid-copy, and on a busy database it needs to be
# allowed to wait rather than giving up on the first contended page.
# stdout is discarded because PRAGMA echoes its value; stderr is kept, since
# that is where sqlite3 reports an actual failure.
sqlite3 -cmd "PRAGMA busy_timeout = 60000;" "$DB" ".backup '$SNAP'" >/dev/null || fail "sqlite3 .backup returned $?"
[ -s "$SNAP" ] || fail "snapshot is empty or missing"

# ── 2. Take the snapshot out of WAL mode ─────────────────────────────────────
# The snapshot inherits journal_mode=WAL from the live database, so every read
# below re-creates `$SNAP-shm` and `$SNAP-wal` beside it. Two problems, one
# cosmetic and one not:
#   · gzip archives ONLY `$SNAP`. Shipping a WAL-mode database without its
#     sidecars is the exact mistake this script exists to prevent, even though
#     `.backup` output is already checkpointed and the sidecars are empty.
#   · the sidecars are never cleaned up — the rotation glob matches `*.db.gz`
#     and cannot see them, so they accumulate one pair per run forever. Found
#     by testing rotation: 3 archives kept, 10 orphaned sidecars left behind.
# DELETE mode ends both. The restored file behaves identically; SQLite switches
# it back to WAL when the app opens it.
sqlite3 "$SNAP" "PRAGMA journal_mode=DELETE;" >/dev/null 2>&1

# ── 3. Verify BEFORE trusting it ─────────────────────────────────────────────
# Two independent checks. integrity_check catches structural damage; the row
# count catches the subtler disaster — a snapshot that is a perfectly valid
# SQLite file containing nothing, which is exactly what a botched restore
# procedure produces and exactly what integrity_check happily calls "ok".
integrity=$(sqlite3 "$SNAP" "PRAGMA integrity_check;" 2>&1 | head -1)
[ "$integrity" = "ok" ] || { rm -f "$SNAP" "$SNAP-shm" "$SNAP-wal"; fail "integrity_check said: $integrity"; }

rows=$(sqlite3 "$SNAP" "SELECT COUNT(*) FROM assignments;" 2>/dev/null)
case "$rows" in
    ''|*[!0-9]*) rm -f "$SNAP" "$SNAP-shm" "$SNAP-wal"; fail "could not read assignments count from snapshot" ;;
esac
[ "$rows" -gt 0 ] || { rm -f "$SNAP" "$SNAP-shm" "$SNAP-wal"; fail "snapshot has 0 assignments"; }

# Belt and braces: if any sqlite3 version still leaves sidecars, they die here
# rather than living in the backup directory forever.
rm -f "$SNAP-shm" "$SNAP-wal"

db_bytes=$(wc -c < "$SNAP" | tr -d ' ')
echo "snapshot ok — $rows assignments, $db_bytes bytes"

# ── 4. Compress ──────────────────────────────────────────────────────────────
# gzip rather than the faster zstd on purpose: a backup is only worth what it is
# restorable with, and gzip is on every machine anyone would restore from.
gzip -9 "$SNAP" || fail "gzip returned $?"
ARCHIVE="$SNAP.gz"
archive_bytes=$(wc -c < "$ARCHIVE" | tr -d ' ')
echo "compressed → $(basename "$ARCHIVE") ($archive_bytes bytes)"

# ── 5. Off-box copy ──────────────────────────────────────────────────────────
status=ok
detail=""

if [ -z "$BACKUP_REMOTE" ]; then
    status=local_only
    detail="BACKUP_REMOTE not set in .env — snapshot kept locally only"
    echo "WARNING: $detail"
elif ! command -v rclone >/dev/null 2>&1; then
    status=local_only
    detail="rclone not installed — snapshot kept locally only"
    echo "WARNING: $detail"
else
    if rclone copy "$ARCHIVE" "$BACKUP_REMOTE/db/" --no-traverse; then
        echo "uploaded db → $BACKUP_REMOTE/db/"
    else
        status=local_only
        detail="rclone upload of the database failed"
        echo "WARNING: $detail"
    fi

    # Images are copied, never synced. `rclone sync` would mirror deletions, so
    # a local mishap on the droplet would propagate to the one copy that exists
    # of images the feed no longer serves. `copy` is append-only and, being
    # incremental, moves only the ~55 documents a normal day adds.
    if [ -d "$IMAGES_DIR" ]; then
        if rclone copy "$IMAGES_DIR" "$BACKUP_REMOTE/broward_images/"; then
            echo "synced images → $BACKUP_REMOTE/broward_images/"
        else
            status=local_only
            detail="${detail:+$detail; }rclone copy of broward_images failed"
            echo "WARNING: rclone copy of broward_images failed"
        fi
    fi
fi

# ── 6. Rotate local copies ───────────────────────────────────────────────────
# Runs last, and only over verified archives, so a bad run can never age out the
# good snapshots it failed to replace.
ls -1t "$BACKUP_DIR"/amo-*.db.gz 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | while read -r old; do
    echo "rotating out $(basename "$old")"
    rm -f "$old"
done

record "$status" "$db_bytes" "$archive_bytes" "$rows" "$detail"
echo "=== backup done: $(date -u +%FT%TZ) — status=$status ==="

[ "$status" = ok ]
