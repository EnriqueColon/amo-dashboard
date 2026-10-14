"""
Guardrails for the two database.py rules that keep Miami-Dade current.

1. already_collected() must NEVER report a recent window as done.

   The county keeps adding documents to a recording date for days afterwards.
   The old behaviour — "this exact (from, to, doc_type) was logged OK, skip it"
   — was survivable only because the weekly run's chunk boundaries shifted each
   week and rarely repeated. On a daily schedule they repeat every run, so
   without a re-check horizon the second run of a window skips it and every
   late-posted document inside it is lost permanently.

2. insert_records() must write the county.

   It used to leave the column NULL and rely on server/db.ts backfilling
   NULL → MIAMI-DADE on the next start. Until that restart, every freshly
   collected row was county-less and dropped out of county-scoped queries —
   observed on 2026-10-14, when 227 newly collected rows were invisible to
   `WHERE county = 'MIAMI-DADE'`.

Run:  collector/.venv/bin/python3 collector/tests/check_collection_horizon.py
"""
import os
import sqlite3
import sys
import tempfile
from datetime import date, timedelta

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


def fresh_db() -> str:
    path = os.path.join(tempfile.mkdtemp(prefix='horizon_test_'), 'test.db')
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cfn TEXT UNIQUE, raw_cfn TEXT, rec_date TEXT, doc_type TEXT,
            grantor TEXT, grantee TEXT, address TEXT, legal_desc TEXT,
            rec_book TEXT, rec_page TEXT, misc_ref TEXT, raw_json TEXT,
            county TEXT
        );
        CREATE TABLE collection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_from TEXT, date_to TEXT, records_found INTEGER,
            status TEXT, collected_at TEXT DEFAULT (datetime('now')),
            doc_type TEXT, county TEXT
        );
    """)
    conn.commit()
    conn.close()
    return path


def main() -> int:
    db_path = fresh_db()
    os.environ['AMO_DB_PATH'] = db_path
    for mod in ('database',):
        sys.modules.pop(mod, None)
    sys.path.insert(0, COLLECTOR)
    import database

    today = date.today()
    doc_type = 'ASSIGNMENT OF MORTGAGE - AMO'

    def log_ok(d_from: date, d_to: date) -> None:
        database.log_collection(d_from.isoformat(), d_to.isoformat(), 10, 'OK',
                                doc_type, county='MIAMI-DADE')

    print('already_collected() re-check horizon')

    # A window that ended yesterday is logged OK — and must still be re-collected.
    recent_from, recent_to = today - timedelta(days=3), today - timedelta(days=1)
    log_ok(recent_from, recent_to)
    check('a window ending yesterday is NOT treated as collected',
          database.already_collected(recent_from.isoformat(), recent_to.isoformat(), doc_type),
          False)

    # The boundary itself: exactly RECHECK_DAYS old is still inside the horizon.
    edge_to = today - timedelta(days=database.RECHECK_DAYS)
    edge_from = edge_to - timedelta(days=2)
    log_ok(edge_from, edge_to)
    check('a window ending exactly RECHECK_DAYS ago is still re-collected',
          database.already_collected(edge_from.isoformat(), edge_to.isoformat(), doc_type),
          False)

    # Old history must still be skipped, or every run re-scrapes three years.
    old_to = today - timedelta(days=database.RECHECK_DAYS + 1)
    old_from = old_to - timedelta(days=2)
    log_ok(old_from, old_to)
    check('a window older than the horizon IS treated as collected',
          database.already_collected(old_from.isoformat(), old_to.isoformat(), doc_type),
          True)

    # An old window never logged at all is obviously not collected.
    never_to = today - timedelta(days=400)
    never_from = never_to - timedelta(days=2)
    check('an unlogged old window is not treated as collected',
          database.already_collected(never_from.isoformat(), never_to.isoformat(), doc_type),
          False)

    # A malformed date must not crash the collector or silently skip work.
    check('a malformed date falls through to the log lookup, not an exception',
          database.already_collected('not-a-date', 'also-not-a-date', doc_type),
          False)

    print('insert_records() writes the county')

    database.insert_records([{
        'cfn': '2026R999001', 'raw_cfn': '2026 R 999001',
        'rec_date': today.isoformat(), 'doc_type': doc_type,
        'grantor': 'A BANK', 'grantee': 'B BANK',
        'address': '', 'legal_desc': '', 'rec_book': '1', 'rec_page': '2',
        'misc_ref': '',
    }])
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT county FROM assignments WHERE cfn='2026R999001'").fetchone()
        check('a freshly inserted row carries its county', row[0] if row else None,
              'MIAMI-DADE')
        check('it is visible to a county-scoped query',
              conn.execute("SELECT COUNT(*) FROM assignments "
                           "WHERE county='MIAMI-DADE'").fetchone()[0], 1)
    finally:
        conn.close()

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed: {", ".join(failures)}')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
