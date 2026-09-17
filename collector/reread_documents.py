"""
Re-read Miami-Dade documents and KEEP the text.
-----------------------------------------------
The pipeline has always OCR'd each recorded document, pulled out the fields it
wanted, and thrown the text away. So every later question about what a
document actually says — is this a transfer or a pledge, who is the assignor —
has cost a fresh download and OCR of every document involved: six hours for the
collateral correction, and an estimated 27-36 for the direction check.

This job does the download and OCR once more and stores the result, compressed,
in `document_text`. It deliberately does NOTHING else: no classification, no
direction verdict, no change to any table the dashboard reads. Rules that
interpret the text (collector/document_direction.py) run against the stored
copy in minutes, and can be corrected and re-run without touching the county
portal again.

Written for the 2026-09 direction re-read, when 7-15% of Miami-Dade loan
transfers were found shown in the reverse direction to what their documents
say (see SESSION_LOG.md 2026-09-17).

Safe to run alongside everything else:
  - reads source tables (pdf_extractions, assignments), never the derived
    aom_events_* tables, which normalize.py empties while it rebuilds — a job
    that selected its work from those mid-rebuild would find nothing and exit
    believing it had finished
  - writes only document_text, committing every 50 documents, so an
    interruption loses at most 50 and a re-run resumes where it stopped
  - run_facility_tick.sh yields while this is running (same cores, same portal)
  - stops cleanly, after flushing, if collector/weekend/STOP exists

    # how much is left, change nothing
    AMO_DB_PATH=... python3 collector/reread_documents.py --dry-run

    # small trial
    AMO_DB_PATH=... python3 collector/reread_documents.py --limit 50

    # the full run
    AMO_DB_PATH=... python3 -u collector/reread_documents.py --workers 8
"""
import argparse
import os
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pdfs import get_conn, download_pdf, ocr_pdf  # noqa: E402

STOP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weekend', 'STOP')
MIN_TEXT_CHARS = 200
_print_lock = threading.Lock()


def ensure_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS document_text (
            cfn       TEXT PRIMARY KEY,
            county    TEXT,
            status    TEXT NOT NULL,     -- OK | DOWNLOAD_FAILED | UNREADABLE | ERROR
            text_z    BLOB,              -- zlib-compressed UTF-8 OCR text; NULL unless OK
            chars     INTEGER,
            detail    TEXT,
            ocr_at    TEXT NOT NULL
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_doctext_status ON document_text(status)")
    conn.commit()


def read_text(conn, cfn: str) -> str | None:
    """Stored OCR text for a filing, or None. The one supported way to read it."""
    row = conn.execute("SELECT text_z FROM document_text WHERE cfn = ? AND status = 'OK'",
                       (cfn,)).fetchone()
    return zlib.decompress(row[0]).decode('utf-8') if row and row[0] else None


def targets(conn, scope: str, retry_failed: bool, limit: int | None):
    # Loan transfers first: they are what the direction fix and the Reporting
    # tab depend on. 'all-read' extends to every read Miami-Dade document.
    category = "AND px.doc_category = 'LOAN_TRANSFER'" if scope == 'loan-transfers' else ''
    done = ("AND a.cfn NOT IN (SELECT cfn FROM document_text WHERE status = 'OK')" if retry_failed
            else "AND a.cfn NOT IN (SELECT cfn FROM document_text)")
    sql = f"""
        SELECT a.cfn, MAX(a.rec_book), MAX(a.rec_page), MAX(a.rec_date)
        FROM assignments a
        JOIN pdf_extractions px ON px.cfn = a.cfn AND px.status = 'OK'
        WHERE COALESCE(a.county, 'MIAMI-DADE') = 'MIAMI-DADE'
          AND a.doc_type != 'FINANCING STATEMENT UCC - FST'
          AND a.rec_book IS NOT NULL AND a.rec_book != ''
          AND a.rec_page IS NOT NULL AND a.rec_page != ''
          {category}
          {done}
        GROUP BY a.cfn
        ORDER BY MAX(a.rec_date) DESC
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql).fetchall()


# Yield to the weekly collection. Both jobs hit the same clerk endpoint and OCR
# on the same 4 cores, and the weekly run is the one with a deadline: it brings
# in the week's new filings. The check lives in fetch() — inside the workers —
# because ThreadPoolExecutor.map queues every task up front, so pausing only the
# consuming loop would leave eight threads downloading straight through the
# weekly run. "[r]un_weekly" keeps pgrep from matching its own command line.
_busy_lock = threading.Lock()
_busy_cache = {'at': 0.0, 'busy': False}


def _weekly_running() -> bool:
    with _busy_lock:
        if time.time() - _busy_cache['at'] > 30:
            _busy_cache['busy'] = subprocess.run(
                ['pgrep', '-f', '[r]un_weekly.sh'], capture_output=True).returncode == 0
            _busy_cache['at'] = time.time()
        return _busy_cache['busy']


def _wait_for_weekly():
    announced = False
    while _weekly_running():
        if not announced:
            with _print_lock:
                print(f'  weekly collection is running — pausing ({datetime.now(timezone.utc):%H:%M}Z)',
                      flush=True)
            announced = True
        time.sleep(60)
    if announced:
        with _print_lock:
            print(f'  weekly collection finished — resuming ({datetime.now(timezone.utc):%H:%M}Z)', flush=True)


def fetch(row):
    cfn, book, page, _ = row
    _wait_for_weekly()
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    try:
        with tempfile.TemporaryDirectory() as wd:
            pdf = os.path.join(wd, 'd.pdf')
            if not download_pdf(book, page, pdf):
                return (cfn, 'DOWNLOAD_FAILED', None, None, f'book {book} page {page}', now)
            text = ocr_pdf(pdf, wd) or ''
    except Exception as e:                                           # noqa: BLE001
        return (cfn, 'ERROR', None, None, f'{type(e).__name__}: {e}'[:300], now)
    text = text.strip()
    if len(text) < MIN_TEXT_CHARS:
        return (cfn, 'UNREADABLE', None, len(text), None, now)
    return (cfn, 'OK', zlib.compress(text.encode('utf-8'), 6), len(text), None, now)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--scope', choices=['loan-transfers', 'all-read'], default='loan-transfers')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--retry-failed', action='store_true',
                    help='also retry documents that previously failed to download or read')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    conn = get_conn()
    ensure_schema(conn)
    rows = targets(conn, args.scope, args.retry_failed, args.limit)
    have = dict(conn.execute("SELECT status, COUNT(*) FROM document_text GROUP BY 1").fetchall())
    print(f'scope={args.scope}  to read: {len(rows)}  already stored: {have}  workers: {args.workers}',
          flush=True)
    if args.dry_run or not rows:
        conn.close()
        return 0

    t0 = time.time()
    tally = Counter()
    pending, done = [], 0

    def flush():
        nonlocal pending
        if pending:
            conn.executemany(
                "INSERT OR REPLACE INTO document_text (cfn, county, status, text_z, chars, detail, ocr_at) "
                "VALUES (?, 'MIAMI-DADE', ?, ?, ?, ?, ?)", pending)
            conn.commit()
            pending = []

    stopped = False
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for rec in pool.map(fetch, rows):
            pending.append(rec)
            tally[rec[1]] += 1
            done += 1
            if len(pending) >= 50:
                flush()
                if os.path.exists(STOP_FILE):
                    stopped = True
                    break
            if done % 200 == 0:
                rate = done / max(time.time() - t0, 1) * 3600
                eta = (len(rows) - done) / max(rate, 1)
                with _print_lock:
                    print(f'  [{done}/{len(rows)}] {dict(tally)}  {rate:.0f}/hr  eta {eta:.1f}h  '
                          f'{datetime.now(timezone.utc):%H:%M}Z', flush=True)
        if stopped:
            pool.shutdown(wait=False, cancel_futures=True)
    flush()

    print(f'\n{"STOPPED by STOP file" if stopped else "finished"} after {(time.time()-t0)/3600:.2f}h: '
          f'{dict(tally)}', flush=True)
    for s, n in conn.execute("SELECT status, COUNT(*) FROM document_text GROUP BY 1"):
        print(f'   stored {s:<16} {n}')
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
