"""
Null out folio_parcel values the model copied from the prompt.

Until 26 Oct 2026 the extraction prompt showed "01-3124-020-0340" as a format
example and the model wrote it — or a near-variant, or an "XX-XXXX-XXX-XXXX"
mask — into documents that print no folio at all. 10,134 production rows held
the example verbatim and ~15,500 held it or a variant, out of 95,041 non-null
folios. The prompt no longer carries an example and postprocess_extraction
drops these values on the way in; this script applies the same rule
(extract_pdfs.folio_placeholder_reason) to the rows already stored.

pdf_extractions is the source of truth — normalize.py rebuilds aom_events_clean
from it nightly — but aom_events_clean is cleaned too so the dashboard stops
showing the echo before the next rebuild.

Usage (dry run prints counts and changes nothing):
    AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db python3 clean_folio_echo.py
    AMO_DB_PATH=... python3 clean_folio_echo.py --apply
"""
import argparse
import os
import sqlite3
from collections import Counter

from extract_pdfs import folio_placeholder_reason

DB = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

# (table, key column) — both tables carry folio_parcel; the clean table has no
# natural key, so it is addressed by rowid.
TABLES = (('pdf_extractions', 'cfn'), ('aom_events_clean', 'rowid'))


def scan(conn: sqlite3.Connection, table: str, key: str):
    """(key, reason) for every row whose folio_parcel is a placeholder."""
    hits = []
    for k, folio in conn.execute(
            f'SELECT {key}, folio_parcel FROM {table} WHERE folio_parcel IS NOT NULL'):
        reason = folio_placeholder_reason(folio)
        if reason:
            hits.append((k, reason))
    return hits


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true', help='write the NULLs (default: dry run)')
    args = p.parse_args()

    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA busy_timeout = 60000')
    for table, key in TABLES:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                            (table,)).fetchone():
            print(f'{table}: not present, skipped')
            continue
        total = conn.execute(f'SELECT COUNT(*) FROM {table} WHERE folio_parcel IS NOT NULL').fetchone()[0]
        hits = scan(conn, table, key)
        print(f'{table}: {total:,} non-null folios, {len(hits):,} placeholders')
        for reason, n in Counter(r for _, r in hits).most_common():
            print(f'    {n:>7,}  {reason}')
        if not args.apply or not hits:
            continue
        with conn:
            conn.executemany(
                f'UPDATE {table} SET folio_parcel = NULL WHERE {key} = ? AND folio_parcel IS NOT NULL',
                [(k,) for k, _ in hits])
        after = conn.execute(f'SELECT COUNT(*) FROM {table} WHERE folio_parcel IS NOT NULL').fetchone()[0]
        left = len(scan(conn, table, key))
        print(f'    applied: {total:,} -> {after:,} non-null folios; {left} placeholders remain')
    if not args.apply:
        print('dry run — nothing changed (re-run with --apply)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
