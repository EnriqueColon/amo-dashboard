"""
Add the `county` dimension to the core tables.

Idempotent: safe to re-run. Every existing row predates multi-county support and
is therefore Miami-Dade, so the backfill is an unconditional UPDATE of NULLs.

Why this does NOT rebuild the UNIQUE constraint on assignments.cfn
------------------------------------------------------------------
The "correct" model is UNIQUE(county, cfn), but changing a UNIQUE constraint in
SQLite means recreating the table and re-pointing every index — a destructive
operation on the 70k-row production table that just absorbed the entity
normalization refactor. It buys nothing here, because the two counties' key
formats are provably disjoint:

    Miami-Dade CFN     2026R521735    always contains 'R'
    Broward instrument 121018052      always pure digits

So a global UNIQUE(cfn) cannot collide across counties. That claim is an
invariant, not a hope — `collector/tests/check_county_isolation.py` asserts it,
and broward_collect.py refuses to insert a CFN that already exists under a
different county rather than letting INSERT OR IGNORE swallow it silently.

If a third county is ever added whose keys are not disjoint, THAT is the moment
to do the table rebuild — not now.

Usage:
    AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 collector/migrate_add_county.py
    collector/.venv/bin/python3 collector/migrate_add_county.py --check   # report only
"""

import argparse
import os
import sqlite3
import sys

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

DEFAULT_COUNTY = 'MIAMI-DADE'

# Tables that carry a per-document county. collection_log is included so a
# Broward run cannot be mistaken for a Miami-Dade window when resuming.
COUNTY_TABLES = [
    'assignments',
    'pdf_extractions',
    'aom_events_clean',
    'credit_facility_events',
    'collection_log',
]

# (table, index name, columns) — speeds up every county-filtered query the
# server will start issuing once the UI gains a county selector.
COUNTY_INDEXES = [
    ('assignments',            'idx_assignments_county_cfn',   '(county, cfn)'),
    ('assignments',            'idx_assignments_county_date',  '(county, rec_date)'),
    ('pdf_extractions',        'idx_pdfx_county',              '(county)'),
    ('aom_events_clean',       'idx_aom_clean_county_date',    '(county, rec_date)'),
    ('credit_facility_events', 'idx_cfe_county',               '(county)'),
]


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in conn.execute(f'PRAGMA table_info({table})'))


def migrate(conn: sqlite3.Connection) -> None:
    for table in COUNTY_TABLES:
        if not table_exists(conn, table):
            print(f'  [skip]  {table} — table does not exist in this DB')
            continue

        if has_column(conn, table, 'county'):
            print(f'  [ok]    {table}.county already present')
        else:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN county TEXT')
            print(f'  [added] {table}.county')

        changed = conn.execute(
            f"UPDATE {table} SET county = ? WHERE county IS NULL", (DEFAULT_COUNTY,)
        ).rowcount
        if changed:
            print(f'          backfilled {changed:,} row(s) → {DEFAULT_COUNTY}')

    for table, name, cols in COUNTY_INDEXES:
        if table_exists(conn, table):
            conn.execute(f'CREATE INDEX IF NOT EXISTS {name} ON {table} {cols}')
    print('  [ok]    county indexes present')


def report(conn: sqlite3.Connection) -> None:
    print(f'\nCounty distribution in {DB_PATH}:')
    for table in COUNTY_TABLES:
        if not table_exists(conn, table):
            continue
        if not has_column(conn, table, 'county'):
            print(f'  {table:<24} (no county column)')
            continue
        rows = conn.execute(
            f'SELECT COALESCE(county, "(null)") c, COUNT(*) n '
            f'FROM {table} GROUP BY c ORDER BY n DESC'
        ).fetchall()
        summary = ', '.join(f'{c}={n:,}' for c, n in rows) or '(empty)'
        print(f'  {table:<24} {summary}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true',
                    help='report current state without modifying anything')
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        print(f'ERROR: database not found: {DB_PATH}', file=sys.stderr)
        return 1

    print(f'Database: {DB_PATH}')
    conn = sqlite3.connect(DB_PATH)
    try:
        if args.check:
            report(conn)
            return 0
        migrate(conn)
        conn.commit()
        report(conn)
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
