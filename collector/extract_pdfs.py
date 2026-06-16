"""
PDF Extraction Pipeline
-----------------------
Downloads the recorded document image for each assignment from the Miami-Dade
Clerk, OCRs the first pages, and uses OpenAI (gpt-4.1-nano) to extract structured data:

  - doc_category        LOAN_TRANSFER | RENTS_LEASES | COLLATERAL | OTHER
                        (used to keep only true loan/mortgage transfers in the
                         Clean Transactions tab)
  - assignor / assignee names as written in the document
  - parent company / acting-through entity for each side, when mentioned
  - property street address, when stated
  - original loan amount and real consideration amount, when stated

Results are cached in the `pdf_extractions` table (keyed by CFN) and survive
normalize.py rebuilds. normalize.py joins this table into aom_events_clean.

System dependencies:  poppler-utils (pdftoppm), tesseract-ocr
    Ubuntu:  apt-get install -y poppler-utils tesseract-ocr
    macOS:   brew install poppler tesseract

Usage:
    AMO_DB_PATH=... OPENAI_API_KEY=... python3 extract_pdfs.py --limit 500
    python3 extract_pdfs.py --limit 200 --retry-errors   # re-attempt failures

Model is configurable via OPENAI_MODEL (default: gpt-4.1-nano).
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import time

import requests

DB          = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')
OPENAI_KEY  = os.environ.get('OPENAI_API_KEY', '')
OPENAI_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4.1-nano')

OPENAI_URL  = 'https://api.openai.com/v1/chat/completions'

DOC_IMAGE_URL = ('https://onlineservices.miamidadeclerk.gov/officialrecords/'
                 'api/DocumentImage/getdocumentimage')

MAX_OCR_PAGES = 3        # first pages carry the operative language
OCR_DPI       = 200
MAX_LLM_CHARS = 14000    # ~3.5k tokens of OCR text per request
REQUEST_DELAY = 0.6      # polite delay between clerk downloads (seconds)

VALID_CATEGORIES = {'LOAN_TRANSFER', 'RENTS_LEASES', 'COLLATERAL', 'OTHER'}

SYSTEM_PROMPT = """You extract structured data from OCR text of recorded county documents (Miami-Dade official records). The documents are assignments and similar instruments.

Return a JSON object with exactly these fields:
- doc_category: one of
    "LOAN_TRANSFER"  - assignment/transfer of a mortgage, deed of trust, promissory note, loan, or HELOC (the debt instrument itself changes hands)
    "RENTS_LEASES"   - assignment of rents and/or leases
    "COLLATERAL"     - collateral assignment / pledge of a mortgage or other asset as security for the assignor's own borrowing (no outright transfer)
    "OTHER"          - anything else (assignment of judgment, contract, bid, development rights, etc.)
- doc_title: the document's own title as printed (e.g. "ASSIGNMENT OF MORTGAGE"), or null
- assignor_name: the party transferring the interest, clean entity name only (no addresses, no trailing legal boilerplate), or null
- assignor_parent: a parent or related company for the assignor IF the document names one, e.g. "X, a subsidiary of Y", "X as successor by merger to Y", "X formerly known as Y", "X by its attorney-in-fact Y", "X acting through Y". Return just the related entity's name, else null.
- assignee_name: the party receiving the interest, clean entity name only, or null
- assignee_parent: same rule as assignor_parent but for the assignee, else null
- property_address: the street address of the encumbered property if stated (street, city, state, zip as available - NOT the parties' corporate addresses), else null
- loan_amount: the original loan / mortgage / note principal amount in dollars if stated, as a number, else null
- consideration_amount: the actual consideration paid for the assignment if a genuine amount is stated, as a number. IGNORE nominal recitals like "$10.00 and other good and valuable consideration" - those are null.

Rules:
- A document titled "Assignment of Mortgage" that also assigns rents/leases ancillary to the mortgage is LOAN_TRANSFER.
- A document assigning ONLY rents and leases is RENTS_LEASES even if it references a mortgage.
- A "collateral assignment of mortgage" given as security is COLLATERAL.
- OCR text is noisy; fix obvious OCR errors in names.
- Respond with only the JSON object."""


# ── DB ────────────────────────────────────────────────────────────────────────

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def ensure_schema(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS pdf_extractions (
            cfn                  TEXT PRIMARY KEY,
            rec_book             TEXT,
            rec_page             TEXT,
            status               TEXT,           -- OK | DOWNLOAD_ERROR | OCR_ERROR | LLM_ERROR
            doc_category         TEXT,           -- LOAN_TRANSFER | RENTS_LEASES | COLLATERAL | OTHER
            doc_title            TEXT,
            assignor_name        TEXT,
            assignor_parent      TEXT,
            assignee_name        TEXT,
            assignee_parent      TEXT,
            property_address     TEXT,
            loan_amount          REAL,
            consideration_amount REAL,
            ocr_chars            INTEGER,
            model                TEXT,
            extracted_at         TEXT DEFAULT (datetime('now')),
            raw_json             TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pdfx_category ON pdf_extractions(doc_category);
        CREATE INDEX IF NOT EXISTS idx_pdfx_status   ON pdf_extractions(status);
    """)
    conn.commit()


def pending_documents(conn: sqlite3.Connection, limit: int, retry_errors: bool,
                      since: str | None = None) -> list:
    """CFNs from assignments that have no (successful) extraction yet, newest first."""
    status_clause = "px.cfn IS NULL" if not retry_errors else \
                    "(px.cfn IS NULL OR px.status != 'OK')"
    date_clause = f"AND a.rec_date >= '{since}'" if since else ""
    return conn.execute(f"""
        SELECT a.cfn, a.rec_book, a.rec_page, a.rec_date
        FROM assignments a
        LEFT JOIN pdf_extractions px ON px.cfn = a.cfn
        WHERE {status_clause}
          AND a.rec_book IS NOT NULL AND a.rec_book != ''
          AND a.rec_page IS NOT NULL AND a.rec_page != ''
          {date_clause}
        GROUP BY a.cfn
        ORDER BY a.rec_date DESC
        LIMIT ?
    """, (limit,)).fetchall()


# ── Download + OCR ────────────────────────────────────────────────────────────

def download_pdf(rec_book: str, rec_page: str, dest: str) -> bool:
    resp = requests.get(
        DOC_IMAGE_URL,
        params={'redact': 'false', 'sBook': rec_book, 'sBookType': 'O ', 'sPage': rec_page},
        timeout=60,
    )
    if resp.status_code != 200 or 'pdf' not in resp.headers.get('Content-Type', ''):
        return False
    with open(dest, 'wb') as f:
        f.write(resp.content)
    return True


def ocr_pdf(pdf_path: str, workdir: str) -> str:
    """Rasterize first pages with pdftoppm and OCR them with tesseract."""
    prefix = os.path.join(workdir, 'pg')
    subprocess.run(
        ['pdftoppm', '-r', str(OCR_DPI), '-png',
         '-f', '1', '-l', str(MAX_OCR_PAGES), pdf_path, prefix],
        check=True, capture_output=True, timeout=120,
    )
    pages = sorted(f for f in os.listdir(workdir) if f.startswith('pg') and f.endswith('.png'))
    text_parts = []
    for page in pages:
        out = subprocess.run(
            ['tesseract', os.path.join(workdir, page), '-'],
            capture_output=True, timeout=120,
        )
        text_parts.append(out.stdout.decode('utf-8', errors='replace'))
    return '\n'.join(text_parts).strip()


# ── LLM extraction ────────────────────────────────────────────────────────────

def llm_extract(ocr_text: str) -> dict | None:
    resp = requests.post(
        OPENAI_URL,
        headers={'Authorization': f'Bearer {OPENAI_KEY}',
                 'Content-Type': 'application/json'},
        json={
            'model': OPENAI_MODEL,
            'max_tokens': 1024,
            'temperature': 0,
            'response_format': {'type': 'json_object'},
            'messages': [
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user',   'content': ocr_text[:MAX_LLM_CHARS]},
            ],
        },
        timeout=90,
    )
    resp.raise_for_status()
    data = json.loads(resp.json()['choices'][0]['message']['content'])

    if data.get('doc_category') not in VALID_CATEGORIES:
        data['doc_category'] = 'OTHER'

    for amount_field in ('loan_amount', 'consideration_amount'):
        val = data.get(amount_field)
        if isinstance(val, str):
            cleaned = re.sub(r'[^0-9.]', '', val)
            data[amount_field] = float(cleaned) if cleaned else None
        elif not isinstance(val, (int, float)):
            data[amount_field] = None

    for text_field in ('doc_title', 'assignor_name', 'assignor_parent',
                       'assignee_name', 'assignee_parent', 'property_address'):
        val = data.get(text_field)
        data[text_field] = val.strip() if isinstance(val, str) and val.strip() else None

    return data


def save(conn, cfn, rec_book, rec_page, status, data=None, ocr_chars=0):
    d = data or {}
    conn.execute("""
        INSERT INTO pdf_extractions
            (cfn, rec_book, rec_page, status, doc_category, doc_title,
             assignor_name, assignor_parent, assignee_name, assignee_parent,
             property_address, loan_amount, consideration_amount,
             ocr_chars, model, extracted_at, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
        ON CONFLICT(cfn) DO UPDATE SET
            status=excluded.status, doc_category=excluded.doc_category,
            doc_title=excluded.doc_title,
            assignor_name=excluded.assignor_name, assignor_parent=excluded.assignor_parent,
            assignee_name=excluded.assignee_name, assignee_parent=excluded.assignee_parent,
            property_address=excluded.property_address,
            loan_amount=excluded.loan_amount,
            consideration_amount=excluded.consideration_amount,
            ocr_chars=excluded.ocr_chars, model=excluded.model,
            extracted_at=excluded.extracted_at, raw_json=excluded.raw_json
    """, (
        cfn, rec_book, rec_page, status,
        d.get('doc_category'), d.get('doc_title'),
        d.get('assignor_name'), d.get('assignor_parent'),
        d.get('assignee_name'), d.get('assignee_parent'),
        d.get('property_address'), d.get('loan_amount'), d.get('consideration_amount'),
        ocr_chars, OPENAI_MODEL if data else None,
        json.dumps(d) if data else None,
    ))
    conn.commit()


# ── Main loop ─────────────────────────────────────────────────────────────────

def run(limit: int, retry_errors: bool, since: str | None = None):
    if not OPENAI_KEY:
        raise SystemExit('OPENAI_API_KEY is not set')

    conn = get_conn()
    ensure_schema(conn)
    docs = pending_documents(conn, limit, retry_errors, since=since)
    print(f'Pending documents: {len(docs)} (limit {limit})')

    counts = {'OK': 0, 'DOWNLOAD_ERROR': 0, 'OCR_ERROR': 0, 'LLM_ERROR': 0}
    categories: dict = {}

    for i, (cfn, rec_book, rec_page, rec_date) in enumerate(docs, 1):
        with tempfile.TemporaryDirectory() as workdir:
            pdf_path = os.path.join(workdir, 'doc.pdf')
            try:
                if not download_pdf(rec_book, rec_page, pdf_path):
                    save(conn, cfn, rec_book, rec_page, 'DOWNLOAD_ERROR')
                    counts['DOWNLOAD_ERROR'] += 1
                    continue
            except Exception as e:
                print(f'  [{i}] {cfn} download failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'DOWNLOAD_ERROR')
                counts['DOWNLOAD_ERROR'] += 1
                continue

            try:
                text = ocr_pdf(pdf_path, workdir)
                if len(text) < 80:
                    raise ValueError(f'OCR produced only {len(text)} chars')
            except Exception as e:
                print(f'  [{i}] {cfn} OCR failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'OCR_ERROR')
                counts['OCR_ERROR'] += 1
                continue

            try:
                data = llm_extract(text)
                save(conn, cfn, rec_book, rec_page, 'OK', data, len(text))
                counts['OK'] += 1
                cat = data.get('doc_category')
                categories[cat] = categories.get(cat, 0) + 1
            except Exception as e:
                print(f'  [{i}] {cfn} LLM failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'LLM_ERROR', ocr_chars=len(text))
                counts['LLM_ERROR'] += 1

        if i % 25 == 0 or i == len(docs):
            print(f'  [{i}/{len(docs)}] ok={counts["OK"]} '
                  f'dl_err={counts["DOWNLOAD_ERROR"]} ocr_err={counts["OCR_ERROR"]} '
                  f'llm_err={counts["LLM_ERROR"]}', flush=True)
        time.sleep(REQUEST_DELAY)

    print(f'\nDone. {counts}')
    if categories:
        print('Categories:', categories)
    conn.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--limit', type=int, default=500,
                   help='max documents to process this run (default 500)')
    p.add_argument('--retry-errors', action='store_true',
                   help='re-attempt previously failed documents')
    p.add_argument('--since', type=str, default=None,
                   help='only process documents recorded on or after this date (YYYY-MM-DD)')
    args = p.parse_args()
    run(args.limit, args.retry_errors, since=args.since)
