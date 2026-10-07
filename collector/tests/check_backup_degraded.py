"""
Verify run_backup.sh refuses to let a derived-table-empty snapshot count as
good, or rotate a good archive away.
----------------------------------------------------------------------------
normalize.py empties aom_events_clean and refills it in place, leaving it at 0
rows for roughly 90 minutes of every run. A snapshot taken in that window is a
structurally perfect SQLite file that restores a dashboard showing zeros, and
the script's row-count assertion keyed only on `assignments` — which stays full
the whole time — so it passed. Confirmed live 2026-09-22:
amo-20260916-031501.db.gz, one of the seven archives then retained, holds
aom_events_clean = 0. Seven such nights would leave nothing restorable.

This runs the REAL script against a temporary database rather than
reimplementing its logic, because every part of the bug lived in the gap
between what the script asserted and what it actually did with the result. A
test that re-stated the intended rule would have passed against the broken
version too.

Three cases, and the third is the one that matters:

  1. populated  -> status=ok, and rotation retires the oldest archive.
  2. empty      -> status=degraded, archive KEPT, rotation SKIPPED.
  3. empty      -> the pre-existing archives are all still on disk afterwards.

Case 2 deliberately asserts the archive is kept. Refusing to back up at all was
the first-cut fix and is worse than the bug: a crashed normalize nobody noticed
for a week would suppress seven nights of Broward image copies, and those cannot
be re-harvested once the SFTP feed rolls past its ten-day window.

  collector/.venv/bin/python3 collector/tests/check_backup_degraded.py

Needs sqlite3, gzip and bash on PATH. No production database, no network —
BACKUP_REMOTE is left unset so the script takes its local_only path.
"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
SCRIPT = os.path.join(COLLECTOR, 'run_backup.sh')


def make_db(path: str, clean_rows: int) -> None:
    """A minimal database with the two tables the script asserts on."""
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE assignments (cfn TEXT, rec_date TEXT, county TEXT)')
    conn.execute('CREATE TABLE aom_events_clean (cfn TEXT, rec_date TEXT)')
    conn.executemany('INSERT INTO assignments VALUES (?, ?, ?)',
                     [(f'2026R{i}', '2026-10-01', 'MIAMI-DADE') for i in range(50)])
    conn.executemany('INSERT INTO aom_events_clean VALUES (?, ?)',
                     [(f'2026R{i}', '2026-10-01') for i in range(clean_rows)])
    conn.commit()
    conn.close()


def run_backup(workdir: str, clean_rows: int, preexisting: int = 0, keep: int = 3):
    """Run the real script in an isolated tree. Returns (rc, stdout, status)."""
    app = os.path.join(workdir, 'app')
    backups = os.path.join(app, 'backups')
    os.makedirs(backups)
    db = os.path.join(app, 'test.db')
    make_db(db, clean_rows)

    # Archives older than this run, so rotation has something to retire.
    for i in range(preexisting):
        with open(os.path.join(backups, f'amo-2026010{i}-000000.db.gz'), 'wb') as f:
            f.write(b'older archive')

    env = dict(os.environ)
    env.update(APP_DIR=app, AMO_DB_PATH=db, BACKUP_DIR=backups,
               IMAGES_DIR=os.path.join(app, 'no-images'), KEEP_LOCAL=str(keep))
    # An inherited BACKUP_REMOTE would make this test try to reach a real bucket.
    env.pop('BACKUP_REMOTE', None)

    proc = subprocess.run(['bash', SCRIPT], env=env, capture_output=True, text=True)

    status = None
    conn = sqlite3.connect(db)
    try:
        row = conn.execute('SELECT status, detail FROM backup_runs '
                           'ORDER BY id DESC LIMIT 1').fetchone()
        status = row[0] if row else None
        detail = row[1] if row else None
    except sqlite3.Error:
        detail = None
    finally:
        conn.close()

    archives = sorted(f for f in os.listdir(backups) if f.endswith('.db.gz'))
    return proc, status, detail, archives


def main() -> int:
    failures = []
    checks = 0

    if not shutil.which('sqlite3'):
        print('SKIPPED: sqlite3 is not on PATH')
        return 0

    # ── 1. Populated derived table: healthy, and rotation happens ───────────
    work = tempfile.mkdtemp()
    try:
        proc, status, detail, archives = run_backup(work, clean_rows=50,
                                                    preexisting=3, keep=3)
        checks += 1
        if status != 'local_only':
            # local_only, not ok, because BACKUP_REMOTE is unset by design here.
            failures.append(f'populated run recorded status={status!r}, '
                            'expected local_only (no remote configured)')
        checks += 1
        if len(archives) != 3:
            failures.append(f'populated run left {len(archives)} archives, '
                            f'expected rotation down to 3: {archives}')
        checks += 1
        if 'skipping rotation' in proc.stdout:
            failures.append('populated run skipped rotation')
    finally:
        shutil.rmtree(work, ignore_errors=True)

    # ── 2 and 3. Empty derived table: degraded, kept, nothing rotated ───────
    work = tempfile.mkdtemp()
    try:
        proc, status, detail, archives = run_backup(work, clean_rows=0,
                                                    preexisting=3, keep=3)
        checks += 1
        if status != 'degraded':
            failures.append(f'empty-derived run recorded status={status!r}, '
                            'expected degraded')
        checks += 1
        if not (detail or '').startswith('aom_events_clean is empty'):
            failures.append(f'empty-derived run detail does not name the cause: {detail!r}')
        checks += 1
        # The new archive plus all three originals — nothing retired.
        if len(archives) != 4:
            failures.append(f'empty-derived run left {len(archives)} archives, '
                            f'expected 4 (3 kept + 1 new): {archives}')
        checks += 1
        if not any(a.startswith('amo-2026010') for a in archives) or \
                sum(1 for a in archives if a.startswith('amo-2026010')) != 3:
            failures.append('empty-derived run did not preserve all three '
                            f'pre-existing archives: {archives}')
        checks += 1
        # Keeping the snapshot is the point — the images and raw tables ride
        # with it, and those are what cannot be reproduced.
        if not any(a.startswith('amo-2026') and a not in
                   ('amo-20260100-000000.db.gz', 'amo-20260101-000000.db.gz',
                    'amo-20260102-000000.db.gz') for a in archives):
            failures.append('empty-derived run discarded its own snapshot; it '
                            'must be kept so the raw tables and images are backed up')
        checks += 1
        if proc.returncode == 0:
            failures.append('empty-derived run exited 0 — cron would log it as a success')
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f'  · {checks} assertions over 2 real runs of run_backup.sh')
    print('  · no production database and no network needed')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ a derived-table-empty snapshot is kept, flagged, and never rotates a good one away')
    return 0


if __name__ == '__main__':
    sys.exit(main())
