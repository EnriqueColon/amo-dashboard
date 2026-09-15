"""
Re-check the COLLATERAL verdict on Assignment-of-Mortgage filings.
------------------------------------------------------------------
The model put 11,366 AMO filings — 21% of all AMO — in COLLATERAL. Reading 32 of
them by hand found 20/20 of the suspect group to be outright transfers
("forever without recourse", "grant, bargain, sell, assign, transfer and set
over"), with no pledge language at all and assignees that are trustees,
servicers, GSEs and HUD. Nobody pledges collateral to HUD.

Those rows are therefore excluded from aom_events_clean by normalize.py's
loan-transfer filter, which is why roughly one loan sale in five is missing from
the Reporting tab.

Writes commit in batches of 100 as it goes, so progress survives an interruption
and a re-run resumes — the selection keys on doc_category still being COLLATERAL.

**No LLM calls.** The decision is `extract_pdfs.reclassify_collateral`, a pure
function of the document text — but the OCR text was never stored, so each
document has to be fetched and scanned again. That is the whole cost: bandwidth
and CPU, no API spend. The evidence quote IS stored this time, so a future audit
of this field needs no re-read.

    # report what would change, touch nothing
    AMO_DB_PATH=... python3 collector/reclassify_doc_category.py --limit 200

    # apply
    AMO_DB_PATH=... python3 collector/reclassify_doc_category.py --apply --workers 8
"""
import argparse
import os
import sqlite3
import sys
import tempfile
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pdfs import (  # noqa: E402
    get_conn, ensure_schema, download_pdf, ocr_pdf, reclassify_collateral,
    _cat_text_eligible,
)

_print_lock = threading.Lock()


ALL_DOC_TYPES = ('ASSIGNMENT OF MORTGAGE - AMO', 'ASSIGNMENT - ASG', 'AST')


def targets(conn, limit, since, doc_types=ALL_DOC_TYPES):
    """Candidate rows. Eligibility itself is decided in Python, not here.

    The SQL deliberately casts wider than the rule and lets examine() reject
    rows, rather than mirroring `_cat_text_eligible` into a WHERE clause where
    the two copies would drift apart. Rejection happens before the download, so
    the wider net costs nothing.
    """
    date_clause = f"AND a.rec_date >= '{since}'" if since else ''
    holes = ','.join('?' * len(doc_types))
    return conn.execute(f"""
        SELECT a.cfn, a.rec_book, a.rec_page, a.doc_type, px.doc_title
        FROM pdf_extractions px JOIN assignments a ON a.cfn = px.cfn
        WHERE px.doc_category = 'COLLATERAL'
          AND a.doc_type IN ({holes})
          AND px.raw_json IS NOT NULL
          AND a.rec_book IS NOT NULL AND a.rec_book != ''
          AND a.rec_page IS NOT NULL AND a.rec_page != ''
          {date_clause}
        ORDER BY a.rec_date DESC
        LIMIT ?
    """, (*doc_types, limit)).fetchall()


def examine(row):
    """Fetch, OCR and decide. Returns (cfn, new_category, evidence, error)."""
    cfn, book, page, doc_type, title = row
    # Checked before the download: most ASG rows are rents assignments or
    # permit assignments the text test must not touch, and fetching them would
    # be the bulk of the run's cost for no decision.
    if not _cat_text_eligible(doc_type, title):
        return cfn, None, None, 'not eligible'
    try:
        with tempfile.TemporaryDirectory() as wd:
            pdf = os.path.join(wd, 'd.pdf')
            if not download_pdf(book, page, pdf):
                return cfn, None, None, 'download failed'
            text = ocr_pdf(pdf, wd)
        if not text or len(text) < 200:
            return cfn, None, None, 'no usable OCR text'
        cat, quote = reclassify_collateral(doc_type, title, text, 'COLLATERAL')
        return cfn, cat, quote, None
    except Exception as e:                                  # noqa: BLE001
        return cfn, None, None, f'{type(e).__name__}: {e}'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='write; otherwise report only')
    ap.add_argument('--limit', type=int, default=50000)
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--since', type=str, default=None,
                    help='only filings recorded on/after this date (YYYY-MM-DD)')
    ap.add_argument('--doc-types', type=str, default=','.join(ALL_DOC_TYPES),
                    help='comma-separated county doc types to re-read. Scoping this '
                         'matters: the AMO rows were settled by the 2026-09-15 run and '
                         'the rule on that path has not changed since, so including '
                         'them again buys nothing and costs an hour of downloads.')
    args = ap.parse_args()

    doc_types = tuple(t.strip() for t in args.doc_types.split(',') if t.strip())

    conn = get_conn()
    ensure_schema(conn)
    rows = targets(conn, args.limit, args.since, doc_types)
    print(f'documents to re-read: {len(rows)}   workers: {args.workers}   '
          f'apply: {args.apply}', flush=True)

    t0 = time.time()
    tally = Counter()
    pending: list = []
    written = 0
    done = 0

    def flush():
        """Commit what has been decided so far.

        Deliberately incremental. The first version accumulated all 11,366
        updates in memory and wrote once at the end, which meant the database
        showed no progress for six hours and a crash at hour five would have
        thrown the whole run away — while the docstring claimed the job was
        resumable. It is only resumable if the rows are actually written, since
        the selection keys on doc_category still being COLLATERAL.
        """
        nonlocal pending, written
        if not (args.apply and pending):
            pending = []
            return
        conn.executemany(
            'UPDATE pdf_extractions SET doc_category = ?, doc_category_evidence = ? '
            'WHERE cfn = ?', pending)
        conn.commit()
        written += len(pending)
        pending = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for cfn, cat, quote, err in pool.map(examine, rows):
            done += 1
            if err == 'not eligible':
                # Skipped without a download — not a failure, and counting it as
                # one would make a healthy run look broken.
                tally['skipped (ineligible)'] += 1
            elif err:
                tally['error'] += 1
            elif cat == 'LOAN_TRANSFER':
                tally['-> LOAN_TRANSFER'] += 1
                pending.append((cat, quote, cfn))
            elif cat == 'COLLATERAL':
                tally['stays COLLATERAL'] += 1
                pending.append((cat, quote, cfn))
            else:
                tally[f'stays {cat}'] += 1

            if len(pending) >= 100:
                flush()

            if done % 200 == 0:
                rate = done / max(time.time() - t0, 1) * 3600
                left = (len(rows) - done) / max(rate, 1)
                with _print_lock:
                    print(f'  [{done}/{len(rows)}] {dict(tally)} '
                          f'{rate:.0f}/hr eta={left:.1f}h written={written}', flush=True)
    flush()

    print(f'\nfinished re-reading in {(time.time()-t0)/60:.1f} min')
    for k, v in tally.most_common():
        print(f'   {k:<20} {v}')

    if not args.apply:
        print('\nDRY RUN — nothing written. Re-run with --apply.')
        conn.close()
        return 0

    # Rows were committed in batches of 100 as the run progressed; an errored
    # document keeps whatever it had rather than being guessed at.
    print(f'\napplied {written} rows')
    holes = ','.join('?' * len(doc_types))
    for dt, cat, n in conn.execute(f"""
        SELECT a.doc_type, px.doc_category, COUNT(*) FROM pdf_extractions px
        JOIN assignments a ON a.cfn = px.cfn
        WHERE a.doc_type IN ({holes}) AND px.raw_json IS NOT NULL
        GROUP BY 1, 2 ORDER BY 1, 3 DESC""", doc_types):
        print(f'   {dt:<32} {cat or "(none)":<16} {n}')
    conn.close()
    print('\nNOTE: run normalize.py to rebuild aom_events_clean, then '
          'pm2 restart amo-dashboard to clear the response cache.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
