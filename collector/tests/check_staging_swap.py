"""
Guardrail: a rebuild never shows the dashboard an empty table.

Until 21 Oct 2026 normalize.py DROPped each live derived table at the start of
its ~2-hour rebuild and refilled it as it went, so every reader saw zeros from
~08:45 to ~11:00 UTC. The owner opened the Reporting tab into that window on
15 Oct. The rebuild now builds every derived table as a TEMP table under its
own name and swap_in() moves the finished set into `main` in one short
transaction.

These checks use two connections on a scratch database — one building, one
reading, the way the server reads while the nightly job runs — and assert:
  1. while the build is in progress the reader still sees the OLD rows, every
     time it looks;
  2. after swap_in() the reader sees exactly the NEW rows, with the new schema
     (a column added in the build arrives in main) and the indexes the build
     created;
  3. the temp twins are gone afterwards, and the swap is all-or-nothing — a
     build that is missing one of the staged tables leaves main untouched.

Run:  collector/.venv/bin/python3 collector/tests/check_staging_swap.py
"""
import os
import sqlite3
import sys
import tempfile

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


def main() -> int:
    path = os.path.join(tempfile.mkdtemp(prefix='swap_test_'), 'test.db')
    os.environ['AMO_DB_PATH'] = path
    sys.modules.pop('normalize', None)
    sys.path.insert(0, COLLECTOR)
    import normalize

    # Live tables with "yesterday's" data and an index, as the server would see them.
    live = sqlite3.connect(path)
    live.execute('PRAGMA journal_mode=WAL')
    live.executescript("""
        CREATE TABLE aom_events_clean (cfn TEXT PRIMARY KEY, assignor_canon TEXT, txn_type TEXT);
        CREATE INDEX idx_clean_assignor ON aom_events_clean(assignor_canon);
        CREATE TABLE entity_nodes (entity TEXT PRIMARY KEY, total_vol INTEGER);
        INSERT INTO aom_events_clean VALUES ('OLD1','ACME BANK','MARKET_TRANSFER'),('OLD2','ACME BANK','ORIGINATION');
        INSERT INTO entity_nodes VALUES ('ACME BANK', 2);
    """)
    live.commit()
    live.close()

    builder = sqlite3.connect(path, timeout=30)
    builder.execute('PRAGMA journal_mode=WAL')
    reader = sqlite3.connect(path, timeout=30)
    rows = lambda c, t: c.execute(f'SELECT COUNT(*) FROM main."{t}"').fetchone()[0]  # noqa: E731

    print('1. during the build the reader keeps seeing the old rows')
    builder.executescript("""
        DROP TABLE IF EXISTS temp.aom_events_clean;
        CREATE TEMP TABLE aom_events_clean (cfn TEXT PRIMARY KEY, assignor_canon TEXT, txn_type TEXT, county TEXT);
        CREATE INDEX IF NOT EXISTS idx_clean_assignor ON aom_events_clean(assignor_canon);
        CREATE INDEX IF NOT EXISTS idx_clean_county ON aom_events_clean(county);
        DROP TABLE IF EXISTS temp.entity_nodes;
        CREATE TEMP TABLE entity_nodes (entity TEXT PRIMARY KEY, total_vol INTEGER);
    """)
    check('  reader: old clean rows still there after the build created its temp tables', rows(reader, 'aom_events_clean'), 2)
    # Unqualified names inside the build resolve to the temp copies.
    builder.execute("INSERT INTO aom_events_clean VALUES ('NEW1','ACME BANK','MARKET_TRANSFER','MIAMI-DADE')")
    builder.execute("INSERT INTO aom_events_clean VALUES ('NEW2','BETA TRUST','ORIGINATION','BROWARD')")
    builder.execute("INSERT INTO aom_events_clean VALUES ('NEW3','BETA TRUST','ORIGINATION','BROWARD')")
    builder.execute("INSERT INTO entity_nodes SELECT assignor_canon, COUNT(*) FROM aom_events_clean GROUP BY 1")
    builder.commit()
    check('  builder: unqualified name is the temp copy (3 new rows)', builder.execute('SELECT COUNT(*) FROM aom_events_clean').fetchone()[0], 3)
    check('  builder: main. is still the old table (2 rows)', rows(builder, 'aom_events_clean'), 2)
    check('  reader: still old rows mid-build', rows(reader, 'aom_events_clean'), 2)
    check('  reader: still old entity_nodes mid-build', reader.execute("SELECT total_vol FROM entity_nodes WHERE entity='ACME BANK'").fetchone()[0], 2)

    print('2. after swap_in the reader sees exactly the new rows, schema and indexes')
    moved = normalize.swap_in(builder, ('aom_events_clean', 'entity_nodes'))
    check('  swap reports the rows moved', moved, {'aom_events_clean': 3, 'entity_nodes': 2})
    check('  reader: new clean rows', sorted(r[0] for r in reader.execute('SELECT cfn FROM aom_events_clean')), ['NEW1', 'NEW2', 'NEW3'])
    check('  reader: new column arrived in main', 'county' in [c[1] for c in reader.execute('PRAGMA table_info(aom_events_clean)')], True)
    check('  reader: entity_nodes rebuilt', dict(reader.execute('SELECT entity, total_vol FROM entity_nodes')), {'ACME BANK': 1, 'BETA TRUST': 2})
    idx = {r[0] for r in reader.execute("SELECT name FROM main.sqlite_master WHERE type='index' AND tbl_name='aom_events_clean'")}
    check('  reader: both indexes exist in main', {'idx_clean_assignor', 'idx_clean_county'} <= idx, True)

    print('3. temp twins are gone, and a missing staged table aborts without touching main')
    check('  no temp tables left', builder.execute("SELECT COUNT(*) FROM temp.sqlite_master WHERE type='table'").fetchone()[0], 0)
    try:
        normalize.swap_in(builder, ('aom_events_clean',))   # no temp copy exists now
        check('  swap without a temp table raises', False, True)
    except RuntimeError:
        check('  swap without a temp table raises', True, True)
    check('  main untouched by the failed swap', rows(reader, 'aom_events_clean'), 3)

    reader.close()
    builder.close()
    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
