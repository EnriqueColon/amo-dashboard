"""
Move rent and lease assignments out of COLLATERAL.
--------------------------------------------------
COLLATERAL held two unrelated errors. The first — 11,366 mortgage assignments
that were really outright transfers — was fixed by reclassify_doc_category.py,
which had to re-read every PDF because the verdict lives in the body text.

This is the second, and it is much cheaper. 6,043 filings in COLLATERAL are
ordinary property-level security instruments: a landlord assigning tenant rents
to its own lender, recorded alongside the mortgage. Six were fetched and read on
2026-09-15 and every one said the same thing —

    "Grantor hereby assigns, grants a continuing security interest in, and
     conveys to Lender all of Grantor's right, title, and interest in and to
     the Rents ... THIS ASSIGNMENT IS GIVEN TO SECURE (1) PAYMENT OF THE
     INDEBTEDNESS"

No loan changes hands and no loan is pledged, so they are RENTS_LEASES. While
they sat in COLLATERAL they outnumbered the genuine collateral pledges four to
one, which is what made that filter unusable for its actual purpose — seeing who
finances whom.

**No downloads, no OCR, no LLM.** The deciding question is what is being
assigned, and the recorded title states it, so this runs off `doc_title`, a
column already in the table. Seconds, not hours. The judgment is
`extract_pdfs.reclassify_rents_by_title`, asserted by tests/check_doc_category.py.

    # report what would change, touch nothing
    AMO_DB_PATH=... python3 collector/reclassify_rents.py

    # apply
    AMO_DB_PATH=... python3 collector/reclassify_rents.py --apply
"""
import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pdfs import get_conn, ensure_schema, reclassify_rents_by_title  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write; otherwise report only')
    ap.add_argument('--show', type=int, default=25, help='distinct titles to list')
    args = ap.parse_args()

    conn = get_conn()
    ensure_schema(conn)

    rows = conn.execute("""
        SELECT px.cfn, a.doc_type, px.doc_title
        FROM pdf_extractions px JOIN assignments a ON a.cfn = px.cfn
        WHERE px.doc_category = 'COLLATERAL' AND px.raw_json IS NOT NULL
    """).fetchall()
    print(f'COLLATERAL rows examined: {len(rows)}   apply: {args.apply}', flush=True)

    updates: list[tuple[str, str, str]] = []
    tally = Counter()
    titles = Counter()
    for cfn, doc_type, title in rows:
        cat, evidence = reclassify_rents_by_title(doc_type, title, 'COLLATERAL')
        if cat == 'RENTS_LEASES':
            tally[f'{doc_type} -> RENTS_LEASES'] += 1
            titles[title] += 1
            updates.append((cat, evidence, cfn))
        elif evidence:
            # Affirmed collateral (assessments / lien rights). The category does
            # not change, but the evidence is worth storing: it is the record of
            # why this row survived a pass that moved 6,000 of its neighbours.
            tally[f'{doc_type} affirmed COLLATERAL'] += 1
            updates.append((cat, evidence, cfn))
        else:
            tally[f'{doc_type} untouched'] += 1

    print('\nverdicts:')
    for k, n in tally.most_common():
        print(f'   {n:>7}  {k}')

    print(f'\ntop {args.show} titles moving to RENTS_LEASES '
          f'({len(titles)} distinct, {sum(titles.values())} rows):')
    for t, n in titles.most_common(args.show):
        print(f'   {n:>6}  {t}')

    if not args.apply:
        print('\nDRY RUN — nothing written. Re-run with --apply.')
        conn.close()
        return 0

    conn.executemany(
        'UPDATE pdf_extractions SET doc_category = ?, doc_category_evidence = ? '
        'WHERE cfn = ?', updates)
    conn.commit()
    print(f'\napplied {len(updates)} rows')

    # Print the resulting split, and UCC separately: all 20,522 of its filings
    # are genuine collateral records and a drop here means the doc-type
    # exclusion has been broken.
    print('\ncategory split now:')
    for dt, cat, n in conn.execute("""
        SELECT a.doc_type, px.doc_category, COUNT(*)
        FROM pdf_extractions px JOIN assignments a ON a.cfn = px.cfn
        WHERE px.raw_json IS NOT NULL AND px.doc_category IS NOT NULL
        GROUP BY 1, 2 ORDER BY 1, 3 DESC"""):
        print(f'   {n:>7}  {dt:<32} {cat}')
    conn.close()
    print('\nNOTE: run normalize.py to rebuild the event tables, then '
          'pm2 restart amo-dashboard to clear the response cache.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
