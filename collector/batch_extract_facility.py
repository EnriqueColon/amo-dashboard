"""
Bulk historical backfill of facility_* fields via OpenAI's Batch API.
------------------------------------------------------------------------
extract_pdfs.py already extracts the facility_* fields (see its
FACILITY_SYSTEM_PROMPT) one document at a time, in real time — that's fine
for ongoing forward collection, but too slow for the full historical
backlog (tens of thousands of documents). This script does the same
download/OCR work, but submits the LLM step as OpenAI Batch API jobs
instead of thousands of individual synchronous calls: ~24h turnaround
regardless of volume, at roughly half the per-token price of the real-time
endpoint.

Imports schema/prompt/post-processing directly from extract_pdfs.py so the
two pipelines can never drift apart on rules.

System dependencies: same as extract_pdfs.py (poppler-utils, tesseract-ocr)

RECOMMENDED usage — automatic, via cron (newest documents first, several
batches kept in flight at once so a slow 24h job on one chunk doesn't stall
the rest):
    */20 * * * *  cd /opt/amo-dashboard && collector/.venv/bin/python3 \
        collector/batch_extract_facility.py --tick >> collector/batch/tick.log 2>&1

Each --tick invocation: polls any in-flight batch jobs (ingesting ones that
finished), then tops back up to --max-concurrent by building + submitting
new chunks (of --chunk-size documents each, newest rec_date first) as long
as pending documents remain. State is tracked in the local `batch_jobs`
table so it's safe to run repeatedly / resume after interruption. A simple
lock file prevents two --tick invocations from overlapping if one runs long.

Manual / debugging usage (four separate stages, run by hand):
    python3 batch_extract_facility.py --build   --limit 5000 --input batch/input_1.jsonl
    python3 batch_extract_facility.py --submit  --input batch/input_1.jsonl
    python3 batch_extract_facility.py --poll    --batch-id batch_abc123 --output batch/output_1.jsonl
    python3 batch_extract_facility.py --ingest  --output batch/output_1.jsonl

--build downloads + OCRs documents with a small thread pool. OCR (tesseract)
is CPU-bound, not I/O-bound, so the worker count should track CPU cores, not
network concurrency — too many workers on a small box causes them to starve
each other and individual tesseract calls to time out (seen in practice on a
1-vCPU droplet: 8 workers -> ~8% of documents failing on 120s timeouts).
Default is derived from os.cpu_count(); override with --workers or the
DOWNLOAD_WORKERS env var if needed.
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pdfs import (  # noqa: E402
    DB, OPENAI_MODEL, MAX_OCR_PAGES, OCR_DPI, DOC_IMAGE_URL, FACILITY_SYSTEM_PROMPT,
    chat_completion_body, ensure_schema, postprocess_facility, save_facility,
)

OPENAI_KEY = os.environ.get('OPENAI_API_KEY', '')
OPENAI_FILES_URL = 'https://api.openai.com/v1/files'
OPENAI_BATCHES_URL = 'https://api.openai.com/v1/batches'

# OCR is CPU-bound: default worker count tracks CPU cores (capped at 4) rather
# than a fixed number, so it scales down automatically on small droplets
# instead of thrashing a single core. Override via --workers or this env var.
DEFAULT_DOWNLOAD_WORKERS = int(os.environ.get('DOWNLOAD_WORKERS', min(4, (os.cpu_count() or 1) + 1)))
# Smaller chunk than before (was 3000) so a single --tick's build phase
# finishes in a reasonable time even on modest hardware, instead of one
# invocation silently running for hours.
DEFAULT_CHUNK_SIZE = 500
DEFAULT_MAX_CONCURRENT = 2
# pdftoppm/tesseract subprocess timeout — generous margin over the few
# seconds this normally takes, so transient CPU contention doesn't spuriously
# fail a document outright.
OCR_SUBPROCESS_TIMEOUT = 180
BATCH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'batch')
LOCK_PATH = os.path.join(BATCH_DIR, 'tick.lock')


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def ensure_batch_schema(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS batch_jobs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id     TEXT,
            input_path   TEXT,
            output_path  TEXT,
            doc_count    INTEGER,
            status       TEXT,  -- 'building' | 'submitted' | 'ingested' | 'failed' | 'empty'
            ok_count     INTEGER,
            error_count  INTEGER,
            created_at   TEXT DEFAULT (datetime('now')),
            completed_at TEXT
        );
        -- Which CFNs each job claimed, so an in-flight (not-yet-ingested) job's
        -- documents aren't re-selected into a second chunk before the first
        -- one finishes (facility_type stays NULL until ingest, so without this
        -- the plain pending-documents query alone can't tell "in flight" apart
        -- from "not started").
        CREATE TABLE IF NOT EXISTS batch_job_documents (
            job_id  INTEGER,
            cfn     TEXT,
            PRIMARY KEY (job_id, cfn)
        );
    """)
    conn.commit()


# Statuses whose claimed CFNs should NOT be picked up by another chunk yet.
_ACTIVE_JOB_STATUSES = ('building', 'submitted')


def pending_documents(conn: sqlite3.Connection, limit: int, since: str | None = None) -> list:
    """CFNs missing facility_type entirely, and not already claimed by an
    in-flight batch job. Newest rec_date first, so repeated chunks naturally
    work backward from the present. `since` (YYYY-MM-DD) optionally scopes
    this to only documents recorded on/after that date, for a faster
    partial backfill (e.g. "just the last 6 months") ahead of a deadline —
    re-run without `since` later to pick up the rest of history."""
    date_clause = "AND a.rec_date >= ?" if since else ""
    params = (*_ACTIVE_JOB_STATUSES, *([since] if since else []), limit)
    return conn.execute(f"""
        SELECT a.cfn, a.rec_book, a.rec_page
        FROM assignments a
        LEFT JOIN pdf_extractions px ON px.cfn = a.cfn
        WHERE (px.cfn IS NULL OR px.facility_type IS NULL)
          AND a.rec_book IS NOT NULL AND a.rec_book != ''
          AND a.rec_page IS NOT NULL AND a.rec_page != ''
          AND a.cfn NOT IN (
              SELECT bjd.cfn FROM batch_job_documents bjd
              JOIN batch_jobs bj ON bj.id = bjd.job_id
              WHERE bj.status IN ({','.join('?' for _ in _ACTIVE_JOB_STATUSES)})
          )
          {date_clause}
        GROUP BY a.cfn
        ORDER BY a.rec_date DESC
        LIMIT ?
    """, params).fetchall()


def pending_count(conn: sqlite3.Connection, since: str | None = None) -> int:
    date_clause = "AND a.rec_date >= ?" if since else ""
    params = (*_ACTIVE_JOB_STATUSES, *([since] if since else []))
    return conn.execute(f"""
        SELECT COUNT(*) FROM (
            SELECT a.cfn
            FROM assignments a
            LEFT JOIN pdf_extractions px ON px.cfn = a.cfn
            WHERE (px.cfn IS NULL OR px.facility_type IS NULL)
              AND a.rec_book IS NOT NULL AND a.rec_book != ''
              AND a.rec_page IS NOT NULL AND a.rec_page != ''
              AND a.cfn NOT IN (
                  SELECT bjd.cfn FROM batch_job_documents bjd
                  JOIN batch_jobs bj ON bj.id = bjd.job_id
                  WHERE bj.status IN ({','.join('?' for _ in _ACTIVE_JOB_STATUSES)})
              )
              {date_clause}
            GROUP BY a.cfn
        )
    """, params).fetchone()[0]


def download_and_ocr(cfn, rec_book, rec_page):
    with tempfile.TemporaryDirectory() as workdir:
        pdf_path = os.path.join(workdir, 'doc.pdf')
        resp = requests.get(
            DOC_IMAGE_URL,
            params={'redact': 'false', 'sBook': rec_book, 'sBookType': 'O ', 'sPage': rec_page},
            timeout=60,
        )
        if resp.status_code != 200 or 'pdf' not in resp.headers.get('Content-Type', ''):
            return cfn, None
        with open(pdf_path, 'wb') as f:
            f.write(resp.content)

        subprocess.run(
            ['pdftoppm', '-r', str(OCR_DPI), '-png', '-f', '1', '-l', str(MAX_OCR_PAGES), pdf_path,
             os.path.join(workdir, 'pg')],
            check=True, capture_output=True, timeout=OCR_SUBPROCESS_TIMEOUT,
        )
        pages = sorted(f for f in os.listdir(workdir) if f.startswith('pg') and f.endswith('.png'))
        text_parts = []
        for page in pages:
            # OMP_THREAD_LIMIT=1: tesseract otherwise spawns ~4 OpenMP threads
            # per process; with 4 parallel download workers that's 16 compute
            # threads on 4 cores, and every call stalls past the timeout
            # (seen 2026-07-21: 100% of a chunk timing out at 180s). One
            # thread per process × one process per core is the fast layout.
            out = subprocess.run(['tesseract', os.path.join(workdir, page), '-'],
                                 capture_output=True, timeout=OCR_SUBPROCESS_TIMEOUT,
                                 env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
            text_parts.append(out.stdout.decode('utf-8', errors='replace'))
        text = '\n'.join(text_parts).strip()
        return cfn, (text if len(text) >= 80 else None)


def build_input_file(conn: sqlite3.Connection, limit: int, input_path: str, job_id=None,
                     workers: int = DEFAULT_DOWNLOAD_WORKERS, since: str | None = None) -> int:
    """Download+OCR the next `limit` pending documents (newest first) and
    write one Batch API request per document to input_path. Returns count
    of requests written.

    If job_id is given, claims the selected CFNs into batch_job_documents
    IMMEDIATELY (before the slow download/OCR work) so a later chunk built
    before this one finishes can't select the same documents again — the
    facility_type column alone can't distinguish "in flight" from "not
    started yet" since it's only set once a batch is ingested."""
    docs = pending_documents(conn, limit, since=since)
    print(f'Pending documents this chunk: {len(docs)} (limit {limit})')
    if not docs:
        return 0

    if job_id is not None:
        conn.executemany(
            "INSERT OR IGNORE INTO batch_job_documents (job_id, cfn) VALUES (?, ?)",
            [(job_id, cfn) for cfn, _, _ in docs],
        )
        conn.commit()

    os.makedirs(os.path.dirname(os.path.abspath(input_path)) or '.', exist_ok=True)
    ok, failed = 0, 0
    with open(input_path, 'w') as out_f, ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download_and_ocr, cfn, rb, rp): cfn for cfn, rb, rp in docs}
        for i, fut in enumerate(as_completed(futures), 1):
            cfn = futures[fut]
            try:
                cfn, text = fut.result()
            except Exception as e:
                print(f'  [{i}/{len(docs)}] {cfn} download/OCR error: {e}')
                failed += 1
                continue
            if text is None:
                failed += 1
                continue
            request_obj = {
                'custom_id': cfn,
                'method': 'POST',
                'url': '/v1/chat/completions',
                'body': chat_completion_body(text, FACILITY_SYSTEM_PROMPT),
            }
            out_f.write(json.dumps(request_obj) + '\n')
            ok += 1
            if i % 250 == 0 or i == len(docs):
                print(f'  [{i}/{len(docs)}] ok={ok} failed={failed}', flush=True)

    print(f'Done. {ok} requests written to {input_path}, {failed} download/OCR failures.')
    return ok


def submit_batch_file(input_path: str) -> str:
    if not OPENAI_KEY:
        sys.exit('OPENAI_API_KEY is not set')

    with open(input_path, 'rb') as f:
        upload = requests.post(
            OPENAI_FILES_URL,
            headers={'Authorization': f'Bearer {OPENAI_KEY}'},
            files={'file': (os.path.basename(input_path), f)},
            data={'purpose': 'batch'},
            timeout=120,
        )
    upload.raise_for_status()
    file_id = upload.json()['id']

    batch = requests.post(
        OPENAI_BATCHES_URL,
        headers={'Authorization': f'Bearer {OPENAI_KEY}', 'Content-Type': 'application/json'},
        json={
            'input_file_id': file_id,
            'endpoint': '/v1/chat/completions',
            'completion_window': '24h',
        },
        timeout=60,
    )
    batch.raise_for_status()
    return batch.json()['id']


def check_batch(batch_id: str) -> dict:
    """Returns the raw batch status object from OpenAI (has .status, .request_counts,
    .output_file_id once completed)."""
    if not OPENAI_KEY:
        sys.exit('OPENAI_API_KEY is not set')
    resp = requests.get(
        f'{OPENAI_BATCHES_URL}/{batch_id}',
        headers={'Authorization': f'Bearer {OPENAI_KEY}'},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def download_batch_output(output_file_id: str, output_path: str):
    content = requests.get(
        f'{OPENAI_FILES_URL}/{output_file_id}/content',
        headers={'Authorization': f'Bearer {OPENAI_KEY}'},
        timeout=120,
    )
    content.raise_for_status()
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
    with open(output_path, 'wb') as f:
        f.write(content.content)


def ingest_output_file(conn: sqlite3.Connection, output_path: str) -> tuple:
    def rec_book_page(cfn):
        row = conn.execute(
            'SELECT rec_book, rec_page FROM assignments WHERE cfn = ?', (cfn,)
        ).fetchone()
        return row if row else (None, None)

    ok, errors = 0, 0
    with open(output_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            cfn = entry['custom_id']
            rec_book, rec_page = rec_book_page(cfn)
            response = entry.get('response')
            if response is None or response.get('status_code') != 200:
                save_facility(conn, cfn, rec_book, rec_page, 'LLM_ERROR')
                errors += 1
                continue
            try:
                content = response['body']['choices'][0]['message']['content']
                data = postprocess_facility(json.loads(content))
                save_facility(conn, cfn, rec_book, rec_page, 'OK', data)
                ok += 1
            except Exception as e:
                print(f'  {cfn} ingest error: {e}')
                save_facility(conn, cfn, rec_book, rec_page, 'LLM_ERROR')
                errors += 1
    return ok, errors


# ── Manual CLI commands (debugging) ──────────────────────────────────────

def cmd_build(limit: int, input_path: str, workers: int, since: str | None = None):
    conn = get_conn()
    ensure_schema(conn)
    build_input_file(conn, limit, input_path, workers=workers, since=since)
    conn.close()


def cmd_submit(input_path: str):
    batch_id = submit_batch_file(input_path)
    print(f'Created batch job -> batch_id={batch_id}')
    print(f'Poll with: python3 batch_extract_facility.py --poll --batch-id {batch_id} --output <path>')


def cmd_poll(batch_id: str, output_path: str):
    body = check_batch(batch_id)
    print(f'Batch {batch_id}: status={body["status"]} counts={body.get("request_counts", {})}')
    if body['status'] != 'completed':
        print('Not finished yet. Re-run --poll later (job runs within a 24h window).')
        return
    download_batch_output(body['output_file_id'], output_path)
    print(f'Downloaded results -> {output_path}. Ingest with: '
          f'python3 batch_extract_facility.py --ingest --output {output_path}')


def cmd_ingest(output_path: str):
    conn = get_conn()
    ensure_schema(conn)
    ok, errors = ingest_output_file(conn, output_path)
    conn.close()
    print(f'Done. {ok} ingested OK, {errors} errors.')


# ── Automatic mode (--tick, intended for cron) ───────────────────────────

def cmd_tick(chunk_size: int, max_concurrent: int, workers: int, since: str | None = None):
    os.makedirs(BATCH_DIR, exist_ok=True)

    # Simple lock so an overlapping cron invocation doesn't double-submit.
    try:
        lock_fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(lock_fd, str(os.getpid()).encode())
        os.close(lock_fd)
    except FileExistsError:
        print('Another --tick is already running (lock file present). Exiting.')
        return

    try:
        conn = get_conn()
        ensure_schema(conn)
        ensure_batch_schema(conn)

        # 0. Clean up jobs stuck in 'building' from a crashed prior run (over an
        # hour old with no batch_id ever assigned) — mark failed so their
        # claimed CFNs free back up for a future chunk instead of being stuck
        # forever.
        conn.execute("""
            UPDATE batch_jobs SET status='failed', completed_at=datetime('now')
            WHERE status='building' AND batch_id IS NULL
              AND created_at < datetime('now', '-1 hour')
        """)
        conn.commit()

        # 1. Check on any in-flight jobs; ingest ones that finished.
        in_flight = conn.execute(
            "SELECT id, batch_id, output_path FROM batch_jobs WHERE status = 'submitted'"
        ).fetchall()
        for job_id, batch_id, output_path in in_flight:
            try:
                body = check_batch(batch_id)
            except Exception as e:
                print(f'  job {job_id} ({batch_id}): status check failed: {e}')
                continue
            status = body['status']
            print(f'  job {job_id} ({batch_id}): status={status} counts={body.get("request_counts", {})}')
            if status in ('failed', 'expired', 'cancelled'):
                conn.execute(
                    "UPDATE batch_jobs SET status='failed', completed_at=datetime('now') WHERE id=?",
                    (job_id,))
                conn.commit()
            elif status == 'completed':
                download_batch_output(body['output_file_id'], output_path)
                ok, errors = ingest_output_file(conn, output_path)
                conn.execute("""
                    UPDATE batch_jobs
                    SET status='ingested', ok_count=?, error_count=?, completed_at=datetime('now')
                    WHERE id=?
                """, (ok, errors, job_id))
                conn.commit()
                print(f'  job {job_id}: ingested {ok} OK, {errors} errors')

        # 2. Top back up to max_concurrent, if there's still work pending.
        still_in_flight = conn.execute(
            "SELECT COUNT(*) FROM batch_jobs WHERE status = 'submitted'"
        ).fetchone()[0]
        remaining = pending_count(conn, since=since)
        scope = f' (since {since})' if since else ''
        print(f'In flight: {still_in_flight}/{max_concurrent}. Pending documents{scope}: {remaining}')

        while still_in_flight < max_concurrent and remaining > 0:
            cur = conn.execute(
                "INSERT INTO batch_jobs (status) VALUES ('building')"
            )
            conn.commit()
            job_id = cur.lastrowid
            input_path = os.path.join(BATCH_DIR, f'input_{job_id}.jsonl')
            output_path = os.path.join(BATCH_DIR, f'output_{job_id}.jsonl')

            doc_count = build_input_file(conn, chunk_size, input_path, job_id=job_id, workers=workers, since=since)
            if doc_count == 0:
                conn.execute("UPDATE batch_jobs SET status='empty' WHERE id=?", (job_id,))
                conn.commit()
                break

            batch_id = submit_batch_file(input_path)
            conn.execute("""
                UPDATE batch_jobs
                SET batch_id=?, input_path=?, output_path=?, doc_count=?, status='submitted'
                WHERE id=?
            """, (batch_id, input_path, output_path, doc_count, job_id))
            conn.commit()
            print(f'  job {job_id}: submitted batch_id={batch_id} ({doc_count} docs)')

            still_in_flight += 1
            remaining = pending_count(conn, since=since)

        conn.close()
    finally:
        os.remove(LOCK_PATH)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--tick', action='store_true',
                   help='automatic mode: poll in-flight jobs, ingest finished ones, '
                        'submit new chunks up to --max-concurrent. Intended for cron.')
    p.add_argument('--build', action='store_true')
    p.add_argument('--submit', action='store_true')
    p.add_argument('--poll', action='store_true')
    p.add_argument('--ingest', action='store_true')
    p.add_argument('--limit', type=int, default=5000)
    p.add_argument('--chunk-size', type=int, default=DEFAULT_CHUNK_SIZE,
                   help=f'documents per batch job in --tick mode (default {DEFAULT_CHUNK_SIZE})')
    p.add_argument('--max-concurrent', type=int, default=DEFAULT_MAX_CONCURRENT,
                   help=f'max batch jobs in flight at once in --tick mode (default {DEFAULT_MAX_CONCURRENT})')
    p.add_argument('--workers', type=int, default=DEFAULT_DOWNLOAD_WORKERS,
                   help=f'concurrent download/OCR threads (default {DEFAULT_DOWNLOAD_WORKERS}, '
                        'derived from CPU count — OCR is CPU-bound, keep this low on small boxes)')
    p.add_argument('--input', type=str, default='batch/input.jsonl')
    p.add_argument('--output', type=str, default='batch/output.jsonl')
    p.add_argument('--batch-id', type=str, default=None)
    p.add_argument('--since', type=str, default=None,
                   help='only process documents recorded on/after this date (YYYY-MM-DD). '
                        'Useful for a fast partial backfill (e.g. last 6 months) ahead of a '
                        'deadline; re-run without --since later to pick up the rest of history.')
    args = p.parse_args()

    if args.tick:
        cmd_tick(args.chunk_size, args.max_concurrent, args.workers, since=args.since)
    elif args.build:
        cmd_build(args.limit, args.input, args.workers, since=args.since)
    elif args.submit:
        cmd_submit(args.input)
    elif args.poll:
        if not args.batch_id:
            sys.exit('--poll requires --batch-id')
        cmd_poll(args.batch_id, args.output)
    elif args.ingest:
        cmd_ingest(args.output)
    else:
        print(__doc__)
