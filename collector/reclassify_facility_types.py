"""
Recompute facility_type on existing rows — no API calls, no downloads, no OCR.
------------------------------------------------------------------------------
classify_facility_type() is a pure function of facility_agreement_name and
facility_evidence_quote, and every row that has a facility verdict already has
both stored. So correcting the 2026-09-12 mislabelling is arithmetic over
columns we hold, not a re-extraction: it costs nothing and takes seconds.

What this does NOT do: recover false negatives. A document the model read as
'none' has no stored agreement name, so nothing here can reconsider it. That
would need a full re-extraction of every document and is a separate decision.

    # see what would change, touch nothing
    AMO_DB_PATH=... python3 collector/reclassify_facility_types.py

    # apply
    AMO_DB_PATH=... python3 collector/reclassify_facility_types.py --apply
"""
import argparse
import os
import sqlite3
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pdfs import classify_facility_type  # noqa: E402

DB = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true',
                    help='write the new types; without it, only report')
    args = ap.parse_args()

    t0 = time.time()
    conn = sqlite3.connect(DB, timeout=120)
    conn.execute('PRAGMA busy_timeout=120000')

    rows = conn.execute("""
        SELECT cfn, facility_type, facility_agreement_name, facility_evidence_quote
        FROM pdf_extractions
        WHERE facility_type IS NOT NULL AND facility_type != 'none'
    """).fetchall()

    updates, before, after, moves = [], Counter(), Counter(), Counter()
    for cfn, old, name, evidence in rows:
        new, _reason = classify_facility_type(name, evidence)
        before[old] += 1
        after[new] += 1
        if new != old:
            updates.append((new, cfn))
            moves[(old, new)] += 1

    print(f'rows examined: {len(rows)}   changing: {len(updates)}')
    print('\nbefore:')
    for k, v in before.most_common():
        print(f'   {k:<42} {v}')
    print('\nafter:')
    for k, v in after.most_common():
        print(f'   {k:<42} {v}')
    print('\nmoves:')
    for (old, new), v in moves.most_common():
        print(f'   {v:>4}  {old} -> {new}')

    if not args.apply:
        print(f'\nDRY RUN — nothing written. Re-run with --apply. ({time.time()-t0:.1f}s)')
        conn.close()
        return 0

    # A row demoted to 'none' must also lose its evidence quote, matching what
    # postprocess_facility() does, or the row would claim a facility it no
    # longer has a verdict for.
    conn.executemany(
        'UPDATE pdf_extractions SET facility_type = ? WHERE cfn = ?', updates)
    conn.execute("""
        UPDATE pdf_extractions SET facility_evidence_quote = NULL
        WHERE facility_type = 'none' AND facility_evidence_quote IS NOT NULL
    """)
    conn.commit()

    final = conn.execute("""
        SELECT facility_type, COUNT(*) FROM pdf_extractions
        WHERE facility_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC
    """).fetchall()
    print('\napplied. facility_type now:')
    for t, n in final:
        print(f'   {t:<42} {n}')
    print(f'\ndone in {time.time()-t0:.1f}s')
    print('NOTE: run normalize.py to rebuild credit_facility_events, then '
          'pm2 restart amo-dashboard to clear the response cache.')
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
