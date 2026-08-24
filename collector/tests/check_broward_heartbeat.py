"""Guardrail: the Broward daily job's heartbeat must distinguish
"ran and found nothing new" from "stopped running".

This is the test that the 2026-08-24 false alarm needed. The Overview used to
infer liveness from MAX(broward_images.harvested_at) — when data last ARRIVED.
Broward publishes on business days only and ~3 business days behind, so a
perfectly healthy job goes quiet for the whole weekend and that metric crossed
its 48h threshold every Monday. The banner fired, nothing was wrong, and the
next real outage would have been dismissed as the usual noise.

So the two cases below are the whole point:

    test_quiet_run_is_healthy    nothing pending, no new data → status ok,
                                 docs_pending 0. Must NOT look like a fault.
    test_pending_day_is_at_risk  a day on the feed is unharvested → docs_pending
                                 counts it and names the oldest, which is the
                                 only condition here that becomes permanent.

Runs with no network and no real feed: the SFTP layer is stubbed, because what
is under test is the bookkeeping, not paramiko.

    collector/.venv/bin/python3 collector/tests/check_broward_heartbeat.py
"""

import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f'{label}: got {got!r}, want {want!r}')
        print(f'  FAIL  {label}: got {got!r}, want {want!r}')
    else:
        print(f'  ok    {label} = {got!r}')


def load_module(db_path):
    """Import broward_images against a scratch database.

    AMO_DB_PATH is read at import time by database.py, so it has to be set
    before the import and the module cache has to be clear between cases.
    """
    os.environ['AMO_DB_PATH'] = db_path
    os.environ['BROWARD_IMAGE_DIR'] = os.path.join(tempfile.gettempdir(),
                                                   'broward_hb_test_images')
    for mod in ('broward_images', 'database', 'broward_collect'):
        sys.modules.pop(mod, None)
    sys.path.insert(0, COLLECTOR)
    import broward_images
    return broward_images


FEED = [('2026-08-17', '08-17-2026img.zip'),
        ('2026-08-18', '08-18-2026img.zip'),
        ('2026-08-19', '08-19-2026img.zip')]


def run_case(label, harvested):
    """harvested: {rec_date: set(cfns)} already on our disk."""
    print(f'\n{label}')
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, 'scratch.db')
        bi = load_module(db)
        bi.ensure_schema()

        # The feed says each of the three days holds two assignments.
        wanted = {d: {f'{d}-a', f'{d}-b'} for d, _ in FEED}
        bi.available_zips = lambda _sftp: list(FEED)
        bi.resolve_wanted = lambda _s, rec_date, _ff, _dt: wanted[rec_date]
        bi.already_harvested = lambda rec_date: harvested.get(rec_date, set())

        summary = bi.show_status(sftp=None, from_feed=True)
        bi.record_run('ok', '2026-08-24T15:30:00Z', '', summary)

        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM broward_runs').fetchone()
        conn.close()
        return summary, row


def test_quiet_run_is_healthy():
    """Every day complete — the normal weekend state. Must read as healthy."""
    harvested = {d: {f'{d}-a', f'{d}-b'} for d, _ in FEED}
    summary, row = run_case('A quiet run (everything already harvested)', harvested)

    check('summary.docs_pending', summary['docs_pending'], 0)
    check('summary.days_pending', summary['days_pending'], 0)
    check('summary.oldest_pending', summary['oldest_pending'], None)
    check('summary.days_on_feed', summary['days_on_feed'], 3)
    check('summary.feed_first', summary['feed_first'], '2026-08-17')
    check('summary.feed_last', summary['feed_last'], '2026-08-19')

    # The heartbeat row is what the Overview reads. A quiet run must land here
    # as status=ok with nothing pending — this row existing at all is what
    # proves the job is alive on a day it had no work to do.
    check('row written', row is not None, True)
    check('row.status', row['status'], 'ok')
    check('row.docs_pending', row['docs_pending'], 0)
    check('row.started_at', row['started_at'], '2026-08-24T15:30:00Z')
    check('row.finished_at is set', row['finished_at'] is not None, True)
    check('row.detail', row['detail'], None)


def test_pending_day_is_at_risk():
    """One day partly harvested, one untouched — the condition that goes
    permanent when the feed rolls. Must be counted and located."""
    harvested = {
        '2026-08-17': {'2026-08-17-a', '2026-08-17-b'},   # complete
        '2026-08-18': {'2026-08-18-a'},                   # 1 of 2 → pending
        # 2026-08-19 absent entirely                      → 2 pending
    }
    summary, row = run_case('A run with unharvested days on the feed', harvested)

    check('summary.docs_pending', summary['docs_pending'], 3)
    check('summary.days_pending', summary['days_pending'], 2)
    # Oldest, not newest: it is the one closest to aging out of the window.
    check('summary.oldest_pending', summary['oldest_pending'], '2026-08-18')
    check('row.docs_pending', row['docs_pending'], 3)
    check('row.days_pending', row['days_pending'], 2)
    check('row.oldest_pending', row['oldest_pending'], '2026-08-18')


def test_failed_run_records_detail():
    """A failed run must still leave a row, carrying why. A run that failed and
    a run that never happened need different responses, so they cannot look
    the same in the table."""
    print('\nA failed run')
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, 'scratch.db')
        bi = load_module(db)
        bi.ensure_schema()
        bi.record_run('failed', '2026-08-24T15:30:00Z',
                      'broward_images exit 1', None)
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM broward_runs').fetchone()
        conn.close()

    check('row.status', row['status'], 'failed')
    check('row.detail', row['detail'], 'broward_images exit 1')
    # No summary available (the feed read is what failed) — the columns must be
    # NULL rather than a misleading 0, which would read as "nothing pending".
    check('row.docs_pending', row['docs_pending'], None)
    check('row.days_on_feed', row['days_on_feed'], None)


if __name__ == '__main__':
    test_quiet_run_is_healthy()
    test_pending_day_is_at_risk()
    test_failed_run_records_detail()

    print()
    if failures:
        print(f'FAILED — {len(failures)} check(s):')
        for f in failures:
            print(f'  · {f}')
        raise SystemExit(1)
    print('✅ broward heartbeat guardrail green')
