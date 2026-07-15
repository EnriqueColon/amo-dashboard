"""
Bulk historical backfill of facility_* fields via OpenAI's Batch API.
------------------------------------------------------------------------
extract_pdfs.py already extracts the facility_* fields (see its
SYSTEM_PROMPT) one document at a time, in real time — that's fine for
ongoing forward collection, but too slow for the full historical backlog
(tens of thousands of documents). This script does the same download/OCR
work, but submits the LLM step as one OpenAI Batch API job instead of
thousands of individual synchronous calls: ~24h turnaround regardless of
volume, at roughly half the per-token price of the real-time endpoint.

Imports schema/prompt/post-processing directly from extract_pdfs.py so the
two pipelines can never drift apart on rules.

System dependencies: same as extract_pdfs.py (poppler-utils, tesseract-ocr)

Usage (four separate stages, run in order):
    python3 batch_extract_facility.py --build   --limit 5000 --input batch/input_1.jsonl
    python3 batch_extract_facility.py --submit  --input batch/input_1.jsonl
    python3 batch_extract_facility.py --poll     --batch-id batch_abc123
    python3 batch_extract_facility.py --ingest   --output batch/output_1.jsonl

--build downloads + OCRs documents with a small thread pool (default 8
workers) — deliberately modest concurrency, to stay considerate of the
Clerk's public document server.
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

DOWNLOAD_WORKERS = 8


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def pending_documents(conn: sqlite3.Connection, limit: int) -> list:
    """CFNs missing facility_type entirely, whether or not they've been through
    extract_pdfs.py's other fields yet — this backfills facility_* specifically."""
    return conn.execute("""
        SELECT a.cfn, a.rec_book, a.rec_page
        FROM assignments a
        LEFT JOIN pdf_extractions px ON px.cfn = a.cfn
        WHERE (px.cfn IS NULL OR px.facility_type IS NULL)
          AND a.rec_book IS NOT NULL AND a.rec_book != ''
          AND a.rec_page IS NOT NULL AND a.rec_page != ''
        GROUP BY a.cfn
        ORDER BY a.rec_date DESC
        LIMIT ?
    """, (limit,)).fetchall()


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
            check=True, capture_output=True, timeout=120,
        )
        pages = sorted(f for f in os.listdir(workdir) if f.startswith('pg') and f.endswith('.png'))
        text_parts = []
        for page in pages:
            out = subprocess.run(['tesseract', os.path.join(workdir, page), '-'],
                                 capture_output=True, timeout=120)
            text_parts.append(out.stdout.decode('utf-8', errors='replace'))
        text = '\n'.join(text_parts).strip()
        return cfn, (text if len(text) >= 80 else None)


def cmd_build(limit: int, input_path: str):
    conn = get_conn()
    ensure_schema(conn)
    docs = pending_documents(conn, limit)
    print(f'Pending documents: {len(docs)} (limit {limit})')

    os.makedirs(os.path.dirname(os.path.abspath(input_path)) or '.', exist_ok=True)
    ok, failed = 0, 0
    with open(input_path, 'w') as out_f, ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
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
            if i % 100 == 0 or i == len(docs):
                print(f'  [{i}/{len(docs)}] ok={ok} failed={failed}', flush=True)

    print(f'Done. {ok} requests written to {input_path}, {failed} download/OCR failures.')
    conn.close()


def cmd_submit(input_path: str):
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
    print(f'Uploaded {input_path} -> file_id={file_id}')

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
    batch_id = batch.json()['id']
    print(f'Created batch job -> batch_id={batch_id}')
    print(f'Poll with: python3 batch_extract_facility.py --poll --batch-id {batch_id}')


def cmd_poll(batch_id: str, output_path: str):
    if not OPENAI_KEY:
        sys.exit('OPENAI_API_KEY is not set')

    resp = requests.get(
        f'{OPENAI_BATCHES_URL}/{batch_id}',
        headers={'Authorization': f'Bearer {OPENAI_KEY}'},
        timeout=60,
    )
    resp.raise_for_status()
    body = resp.json()
    status = body['status']
    counts = body.get('request_counts', {})
    print(f'Batch {batch_id}: status={status} counts={counts}')

    if status != 'completed':
        print('Not finished yet. Re-run --poll later (job runs within a 24h window).')
        return

    output_file_id = body['output_file_id']
    content = requests.get(
        f'{OPENAI_FILES_URL}/{output_file_id}/content',
        headers={'Authorization': f'Bearer {OPENAI_KEY}'},
        timeout=120,
    )
    content.raise_for_status()
    with open(output_path, 'wb') as f:
        f.write(content.content)
    print(f'Downloaded results -> {output_path}. Ingest with: '
          f'python3 batch_extract_facility.py --ingest --output {output_path}')


def cmd_ingest(output_path: str):
    conn = get_conn()
    ensure_schema(conn)

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

    print(f'Done. {ok} ingested OK, {errors} errors.')
    conn.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--build', action='store_true')
    p.add_argument('--submit', action='store_true')
    p.add_argument('--poll', action='store_true')
    p.add_argument('--ingest', action='store_true')
    p.add_argument('--limit', type=int, default=5000)
    p.add_argument('--input', type=str, default='batch/input.jsonl')
    p.add_argument('--output', type=str, default='batch/output.jsonl')
    p.add_argument('--batch-id', type=str, default=None)
    args = p.parse_args()

    if args.build:
        cmd_build(args.limit, args.input)
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
