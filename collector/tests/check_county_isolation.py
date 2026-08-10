"""
Verify the two counties never contaminate each other.
------------------------------------------------------
Broward shares the `assignments` table with Miami-Dade and relies on a global
UNIQUE(cfn) that is only safe because the two key formats are disjoint:

    Miami-Dade CFN     2026R521735    always contains 'R'
    Broward instrument 121018052      always pure digits

migrate_add_county.py leans on that invariant instead of rebuilding the UNIQUE
constraint on a 70k-row production table. This asserts the invariant actually
holds, so the shortcut stays honest.

Checks, all against the live DB:
  1. every row carries a county (no NULLs left behind by the migration)
  2. no CFN appears under two counties
  3. Broward CFNs are pure digits; Miami-Dade CFNs are not
  4. derived tables never reference a CFN whose county disagrees with
     `assignments` — catches a normalize.py run that dropped the county through

  AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
      collector/tests/check_county_isolation.py
"""
import os
import re
import sqlite3
import sys

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

BROWARD_RE = re.compile(r'^\d+$')

COUNTY_TABLES = ['assignments', 'pdf_extractions',
                 'aom_events_clean', 'credit_facility_events']

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def table_exists(conn, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def has_county(conn, table: str) -> bool:
    return any(r[1] == 'county' for r in conn.execute(f'PRAGMA table_info({table})'))


def check_derived_tables_keep_county(conn) -> None:
    """The rebuilt tables must DECLARE county themselves.

    `normalize.py` drops and recreates `aom_events_clean` and
    `credit_facility_events` on every run, so a county column added by a
    migration does not survive. That is not a benign loss: `server/db.ts`
    re-adds the column on the next startup and backfills NULL to 'MIAMI-DADE',
    silently relabelling every Broward row and serving it under a Miami-Dade
    filter with no error anywhere.

    This has now bitten three separate writers (log_collection, save() in
    extract_pdfs, and both rebuild statements), so it is asserted rather than
    trusted.
    """
    for table in ('aom_events_clean', 'credit_facility_events'):
        if not table_exists(conn, table):
            continue
        if not has_county(conn, table):
            fail(f'{table}: county column MISSING — normalize.py recreated the '
                 f'table without it; Broward rows will be relabelled MIAMI-DADE '
                 f'by the next server start')


def check_no_nulls(conn) -> None:
    for table in COUNTY_TABLES:
        if not table_exists(conn, table) or not has_county(conn, table):
            continue
        n = conn.execute(
            f'SELECT COUNT(*) FROM {table} WHERE county IS NULL OR county = ""'
        ).fetchone()[0]
        if n:
            fail(f'{table}: {n:,} row(s) with no county — migration incomplete')


def check_no_cross_county_cfn(conn) -> None:
    rows = conn.execute(
        'SELECT cfn, COUNT(DISTINCT county) c FROM assignments '
        'GROUP BY cfn HAVING c > 1 LIMIT 5'
    ).fetchall()
    if rows:
        fail('assignments: CFN(s) claimed by more than one county: '
             + ', '.join(r[0] for r in rows))


def check_key_formats(conn) -> None:
    if not has_county(conn, 'assignments'):
        return
    counties = [r[0] for r in conn.execute(
        'SELECT DISTINCT county FROM assignments WHERE county IS NOT NULL')]

    for county in counties:
        sample = conn.execute(
            'SELECT cfn FROM assignments WHERE county = ? LIMIT 20000', (county,)
        ).fetchall()
        if not sample:
            continue
        numeric = sum(1 for (c,) in sample if BROWARD_RE.match(c or ''))

        if county == 'BROWARD' and numeric != len(sample):
            fail(f'BROWARD: {len(sample) - numeric} of {len(sample)} sampled CFNs '
                 f'are not pure digits — the disjointness invariant is broken')
        elif county == 'MIAMI-DADE' and numeric:
            fail(f'MIAMI-DADE: {numeric} of {len(sample)} sampled CFNs are pure '
                 f'digits — they could collide with Broward instrument numbers')
        else:
            notes.append(f'{county}: {len(sample):,} CFN(s) sampled, format consistent')


def check_derived_agreement(conn) -> None:
    """A derived row must agree with assignments about which county it is from."""
    for table in ('pdf_extractions', 'aom_events_clean', 'credit_facility_events'):
        if not table_exists(conn, table) or not has_county(conn, table):
            continue
        n = conn.execute(
            f'SELECT COUNT(*) FROM {table} t JOIN assignments a ON a.cfn = t.cfn '
            f'WHERE COALESCE(t.county, "") <> COALESCE(a.county, "")'
        ).fetchone()[0]
        if n:
            fail(f'{table}: {n:,} row(s) disagree with assignments.county')


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f'ERROR: database not found: {DB_PATH}', file=sys.stderr)
        return 1

    print(f'County isolation check — {DB_PATH}')
    conn = sqlite3.connect(DB_PATH)
    try:
        if not has_county(conn, 'assignments'):
            print('  SKIP: assignments.county does not exist yet — run '
                  'collector/migrate_add_county.py first')
            return 0

        counts = conn.execute(
            'SELECT COALESCE(county, "(null)"), COUNT(*) FROM assignments '
            'GROUP BY 1 ORDER BY 2 DESC'
        ).fetchall()
        for county, n in counts:
            print(f'  {county:<14} {n:,} assignment(s)')

        check_derived_tables_keep_county(conn)
        check_no_nulls(conn)
        check_no_cross_county_cfn(conn)
        check_key_formats(conn)
        check_derived_agreement(conn)
    finally:
        conn.close()

    for note in notes:
        print(f'  ok: {note}')

    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1

    print('\n✅ county isolation intact')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
