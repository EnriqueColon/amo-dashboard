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
  - facility_*          whether the document describes an institutional
                        credit-facility relationship (warehouse line of
                        credit, revolving facility, syndicated credit
                        agreement), plus lender/agent/borrower/agreement
                        date/amount/evidence quote when it does. This is a
                        SEPARATE LLM call (see FACILITY_SYSTEM_PROMPT) from
                        the doc_category extraction above — combining them
                        into one call was tried and measurably hurt facility
                        detection accuracy. normalize.py surfaces documents
                        with real facility language into their own
                        `credit_facility_events` table.

Results are cached in the `pdf_extractions` table (keyed by CFN) and survive
normalize.py rebuilds. normalize.py joins this table into aom_events_clean
and (for facility_* fields) credit_facility_events.

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
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

DB          = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')
OPENAI_KEY  = os.environ.get('OPENAI_API_KEY', '')
OPENAI_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4.1-nano')

OPENAI_URL  = 'https://api.openai.com/v1/chat/completions'

DOC_IMAGE_URL = ('https://onlineservices.miamidadeclerk.gov/officialrecords/'
                 'api/DocumentImage/getdocumentimage')

# Broward document images are harvested from the county's SFTP feed by
# broward_images.py and land as <instrument>/<page>.tif. There is nothing to
# download at extraction time — see fetch_document_text().
BROWARD_IMAGE_DIR = os.environ.get(
    'BROWARD_IMAGE_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'broward_images'))

DEFAULT_COUNTY = 'MIAMI-DADE'

MAX_OCR_PAGES = 3        # first pages carry the operative language
OCR_DPI       = 200
MAX_LLM_CHARS = 14000    # ~3.5k tokens of OCR text per request
REQUEST_DELAY = 0.6      # polite delay between clerk downloads (seconds)

# LLM budget cap: script stops gracefully once estimated spend reaches this.
# Tracked from actual token usage returned by the OpenAI API.
BUDGET_USD    = float(os.environ.get('OPENAI_BUDGET_USD', '5.0'))
# gpt-4.1-nano pricing (USD per 1M tokens)
PRICE_INPUT_PER_M  = 0.10
PRICE_OUTPUT_PER_M = 0.40

_spend = {'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0.0}
_spend_lock = threading.Lock()

VALID_CATEGORIES = {'LOAN_TRANSFER', 'RENTS_LEASES', 'COLLATERAL', 'OTHER'}
VALID_FACILITY_TYPES = {'warehouse_or_revolving_credit_facility', 'syndicated_credit_agreement',
                        'consumer_or_business_line_of_credit', 'none'}

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
- loan_amount: the original loan / mortgage / note principal amount in dollars if stated, as a number, else null. ALWAYS search carefully for this - look for phrases like "in the original principal amount of", "principal balance of", "in the principal sum of", "given to secure a note in the amount of", "face amount", or a dollar figure next to the mortgage/note recording reference.
- consideration_amount: the actual consideration paid for the assignment if a genuine amount is stated, as a number. IGNORE nominal recitals like "$10.00 and other good and valuable consideration" - those are null.
- folio_parcel: the Miami-Dade folio or parcel number for the property. Look for labels like "Folio No.", "Folio #", "Parcel ID", "RE#", "Property ID", or a bare number formatted as XX-XXXX-XXX-XXXX (13 digits with dashes). Also check the legal description block and any "Exhibit A" section. Return only the number string (e.g. "01-3124-020-0340"), not the label. If not present, return null.
- sponsor_address: the mailing address or business address of the assignee (buyer/lender) if stated in the document body (NOT the property address). Often appears after the assignee's name in the opening recital or in the signature block. Return as a string, else null.
- signatory_officer: The name and title of the person who signed this document ON BEHALF OF THE ASSIGNOR (the transferring party). Look in the signature block for a line like "By: ___" or "Name: ___" or "Title: ___" directly under the assignor's name. DO NOT return the notary's name — the notary appears in a separate "State of ___, County of ___" acknowledgment block and is not the signatory. DO NOT return the assignee's signer. Prefer the printed/typed name under the signature line over any handwritten scrawl. Return "Name, Title" as a single string (e.g. "Jane Smith, Vice President"), or null if not legible.

Rules:
- A document titled "Assignment of Mortgage" that also assigns rents/leases ancillary to the mortgage is LOAN_TRANSFER.
- A document assigning ONLY rents and leases is RENTS_LEASES even if it references a mortgage.
- A "collateral assignment of mortgage" given as security is COLLATERAL.
- OCR text is noisy; fix obvious OCR errors in names.
- Respond with only the JSON object."""

# Deliberately a SEPARATE LLM call/prompt from SYSTEM_PROMPT above — combining
# facility detection into the same call as doc_category extraction was tried
# and measurably degraded accuracy (the model stopped reliably applying the
# facility rules once they were one section of a longer, multi-task prompt).
# This prompt is proven via a 189-document pilot (collector/research/) before
# being wired into the real pipeline: 10/13 on a known-positive cluster, 0/6
# on known-negatives, 0/135 false positives on a random baseline.
# NOTE: this text is used VERBATIM as tested — same field names as the pilot
# (has_facility_language, lender_or_bank_name, agent_name,
# borrower_or_assignor_name, amount, amount_type, evidence_quote, confidence).
# Renaming these to our facility_*-prefixed DB columns happens only in
# postprocess_facility() below, in code, not by asking the model for
# different field names — an earlier attempt to rename fields *and* drop
# has_facility_language when integrating this prompt caused the model to
# stop reliably detecting facility language at all (all 21 known-labeled
# test documents came back negative). Do not "clean up" this prompt without
# re-running verify_integration.py against the known-labeled CFNs first.
FACILITY_SYSTEM_PROMPT = """You are analyzing OCR'd text from a Miami-Dade County recorded document \
(a mortgage assignment or UCC financing statement). Determine whether the document contains \
language describing an institutional credit facility relationship (a warehouse line of credit, \
revolving credit facility, syndicated credit agreement, or similar) between a lender/bank and a \
borrower — NOT just a one-off mortgage loan being sold or assigned.

ONLY set has_facility_language to true if the text contains an explicit, NAMED credit-facility \
construct or explicit facility terminology, such as:
- a named agreement like "Warehouse Agreement", "Warehousing Loan and Security Agreement", \
"Credit Agreement", "Master Repurchase Agreement", "Loan and Security Agreement" governing an \
ongoing lending relationship (not just the single mortgage/note being assigned), OR
- explicit phrases like "revolving credit loan", "revolving line of credit", "Pledged Loans", \
or a party acting "as Administrative Agent" / "as Collateral Agent" for a facility.

DO NOT set has_facility_language to true merely because the document:
- states a dollar amount and/or origination date for the single mortgage/note being assigned \
(e.g. "for $540,000.00 dated 2/20/2007") — that is just standard assignment boilerplate, not \
facility language.
- is a correction/scrivener's-error instrument fixing a clerical mistake in a prior filing.
- mentions a generic loan-type label like "construction mortgage loan" or "commercial loan" \
with no explicit named agreement or facility terminology attached.
- contains a party name that happens to include a word like "warehouse", "credit", or "revolving" \
(e.g. "XYZ Warehouse LLC") without any prose describing an actual facility.

IMPORTANT: a reference to a named facility agreement DOES qualify even if it is brief, \
parenthetical, or appears only inside an exception/carve-out clause — it does not need a full \
"WHEREAS" recital or elaboration to count. For example, the sentence "...has granted, bargained, \
sold, assigned, transferred and set over to Assignee, without recourse, representation or \
warranty, expressed or implied, except as may otherwise be expressly set forth in that certain \
(Warehouse Agreement) dated March 29, 2016 and that certain mortgage given by..." DOES qualify as \
has_facility_language=true (facility_type="warehouse_or_revolving_credit_facility", \
facility_agreement_name="Warehouse Agreement", facility_agreement_date="March 29, 2016") — the \
parenthetical "(Warehouse Agreement)" is itself a named facility agreement, even though the \
sentence is short and mentions it only in passing.

Respond with a JSON object with exactly these fields:
{
  "has_facility_language": true/false,
  "facility_type": one of "warehouse_or_revolving_credit_facility", "syndicated_credit_agreement", "consumer_or_business_line_of_credit", "none",
  "facility_agreement_name": the name of the referenced agreement if any (e.g. "Warehousing Loan and Security Agreement", "Credit Agreement"), or null,
  "facility_agreement_date": the date of that agreement if stated, or null,
  "lender_or_bank_name": the lender/bank name, or null,
  "agent_name": an administrative/collateral agent name if distinct from the lender, or null,
  "borrower_or_assignor_name": the borrower/assignor name, or null,
  "amount": a numeric dollar amount if a credit limit, note principal, or loan amount is stated, or null,
  "amount_type": one of "credit_limit", "note_principal", "loan_amount", null,
  "evidence_quote": a short VERBATIM quote (under 300 characters), copied exactly character-for-character from the input text, that contains the specific facility terminology that justifies has_facility_language=true. Must be null if has_facility_language is false. Do not paraphrase or summarize — copy the exact substring.,
  "confidence": one of "high", "medium", "low"
}

Return ONLY the JSON object, no other text."""


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
            status               TEXT,
            doc_category         TEXT,
            doc_title            TEXT,
            assignor_name        TEXT,
            assignor_parent      TEXT,
            assignee_name        TEXT,
            assignee_parent      TEXT,
            property_address     TEXT,
            loan_amount          REAL,
            consideration_amount REAL,
            folio_parcel         TEXT,
            sponsor_address      TEXT,
            signatory_officer    TEXT,
            ocr_chars            INTEGER,
            model                TEXT,
            extracted_at         TEXT DEFAULT (datetime('now')),
            raw_json             TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pdfx_category ON pdf_extractions(doc_category);
        CREATE INDEX IF NOT EXISTS idx_pdfx_status   ON pdf_extractions(status);
    """)
    # Migrate existing tables that predate the new columns
    for col in ('folio_parcel TEXT', 'sponsor_address TEXT', 'signatory_officer TEXT',
                'facility_type TEXT', 'facility_agreement_name TEXT', 'facility_agreement_date TEXT',
                'facility_lender_name TEXT', 'facility_agent_name TEXT', 'facility_borrower_name TEXT',
                'facility_amount REAL', 'facility_amount_type TEXT',
                'facility_evidence_quote TEXT', 'facility_confidence TEXT',
                # Multi-county. save() always writes this explicitly; the column
                # has to exist even on a database created fresh by this script.
                'county TEXT'):
        try:
            conn.execute(f'ALTER TABLE pdf_extractions ADD COLUMN {col}')
        except Exception:
            pass
    conn.commit()


def has_county_column(conn: sqlite3.Connection) -> bool:
    return any(r[1] == 'county' for r in conn.execute('PRAGMA table_info(assignments)'))


def pending_documents(conn: sqlite3.Connection, limit: int, retry_errors: bool,
                      since: str | None = None, redo: bool = False,
                      county: str | None = None) -> list:
    """CFNs from assignments that need (re-)extraction, newest first.

    --redo targets already-extracted OK rows that are missing the new fields
    (folio_parcel, sponsor_address, signatory_officer, or the facility_* fields).
    This lets us cheaply backfill new columns without re-extracting docs that
    already have them.
    """
    if redo:
        status_clause = ("px.status = 'OK' AND "
                         "(px.folio_parcel IS NULL AND px.sponsor_address IS NULL "
                         "AND px.signatory_officer IS NULL "
                         "AND px.facility_type IS NULL)")
    elif retry_errors:
        status_clause = "(px.cfn IS NULL OR px.status != 'OK')"
    else:
        # "No row yet" is NOT the same as "never extracted", and treating them as
        # the same silently lost 50,042 Miami-Dade documents between 22 Jul and
        # 15 Aug 2026.
        #
        # batch_extract_facility.py writes a pdf_extractions row as soon as it
        # has a FACILITY verdict, with status='OK' and none of the main fields.
        # The old clause here was `px.cfn IS NULL`, so the moment the facility
        # backfill reached a document first, that document became invisible to
        # this extractor permanently — no property address, folio, loan amount,
        # signatory, doc_category or document-derived parties, ever. The rows
        # looked complete from every angle: status OK, no error, nothing in any
        # log. The only visible symptom was empty columns in the UI.
        #
        # raw_json is the honest test. This extractor always stores the model's
        # response; the facility path never does. Verified on production: of
        # 22,115 rows with raw_json, 22,115 have doc_category and OCR text; of
        # 50,042 without it, none do.
        #
        # Error rows are deliberately still excluded — they also lack raw_json,
        # and picking them up here would silently turn every run into a retry of
        # documents the clerk genuinely cannot serve. That stays behind
        # --retry-errors, as before.
        status_clause = "(px.cfn IS NULL OR (px.status = 'OK' AND px.raw_json IS NULL))"

    date_clause = f"AND a.rec_date >= '{since}'" if since else ""
    join_type   = "INNER" if redo else "LEFT"

    if not has_county_column(conn):
        # Database predates multi-county support — original behaviour verbatim.
        return [(*row, DEFAULT_COUNTY) for row in conn.execute(f"""
            SELECT a.cfn, a.rec_book, a.rec_page, a.rec_date
            FROM assignments a
            {join_type} JOIN pdf_extractions px ON px.cfn = a.cfn
            WHERE {status_clause}
              AND a.rec_book IS NOT NULL AND a.rec_book != ''
              AND a.rec_page IS NOT NULL AND a.rec_page != ''
              {date_clause}
            GROUP BY a.cfn
            ORDER BY a.rec_date DESC
            LIMIT ?
        """, (limit,)).fetchall()]

    # Each county has its own precondition for being extractable:
    #
    #   Miami-Dade — the document is fetched live from the clerk by book/page,
    #                so both must be present.
    #   Broward    — nothing is fetched at extraction time; the images must
    #                already have been harvested from the SFTP feed, which is
    #                what a broward_images row records. Broward e-recorded
    #                documents have NO book/page at all, so the Miami-Dade
    #                condition would exclude every one of them — that is exactly
    #                why Broward was invisible to this script until now.
    miami_dade_available = """
          (COALESCE(a.county, 'MIAMI-DADE') = 'MIAMI-DADE'
             AND a.rec_book IS NOT NULL AND a.rec_book != ''
             AND a.rec_page IS NOT NULL AND a.rec_page != '')
    """
    has_images_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='broward_images'"
    ).fetchone() is not None
    broward_available = """
          OR (COALESCE(a.county, 'MIAMI-DADE') = 'BROWARD'
             AND EXISTS (SELECT 1 FROM broward_images bi WHERE bi.cfn = a.cfn))
    """ if has_images_table else ""
    availability = f"AND ({miami_dade_available} {broward_available})"
    params: list = []
    county_clause = ""
    if county:
        county_clause = "AND COALESCE(a.county, 'MIAMI-DADE') = ?"
        params.append(county)

    params.append(limit)
    return conn.execute(f"""
        SELECT a.cfn, a.rec_book, a.rec_page, a.rec_date,
               COALESCE(a.county, 'MIAMI-DADE') AS county
        FROM assignments a
        {join_type} JOIN pdf_extractions px ON px.cfn = a.cfn
        WHERE {status_clause}
          {availability}
          {county_clause}
          {date_clause}
        GROUP BY a.cfn
        ORDER BY a.rec_date DESC
        LIMIT ?
    """, params).fetchall()


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


def ocr_images(paths: list[str]) -> str:
    """OCR page images directly.

    Broward ships the county's own quality-assured G4 TIFFs at ~300 DPI, so
    there is nothing to rasterize — the pdftoppm step the Miami-Dade path needs
    is skipped entirely, and the input is higher resolution than the 200 DPI
    that path re-renders at.
    """
    text_parts = []
    for path in paths:
        out = subprocess.run(
            ['tesseract', path, '-'],
            capture_output=True, timeout=120,
            # Same OpenMP guard as ocr_pdf below — see that comment.
            env={**os.environ, 'OMP_THREAD_LIMIT': '1'},
        )
        text_parts.append(out.stdout.decode('utf-8', errors='replace'))
    return '\n'.join(text_parts).strip()


def broward_page_images(cfn: str) -> list[str]:
    """Harvested page images for one Broward instrument, in page order."""
    doc_dir = os.path.join(BROWARD_IMAGE_DIR, cfn)
    if not os.path.isdir(doc_dir):
        return []
    pages = sorted(f for f in os.listdir(doc_dir)
                   if f.lower().endswith(('.tif', '.tiff', '.png', '.jpg')))
    # Match the Miami-Dade path: the operative language is on the first pages,
    # and OCR cost scales with page count.
    return [os.path.join(doc_dir, f) for f in pages[:MAX_OCR_PAGES]]


def fetch_document_text(county: str, cfn: str, rec_book: str, rec_page: str,
                        workdir: str) -> str:
    """Get OCR text for one document, however that county supplies its images.

    Raises FileNotFoundError when a Broward document has no harvested images —
    the caller records that as DOWNLOAD_ERROR, since it is the same class of
    problem as a failed clerk fetch: the source material is not available.
    """
    if county == 'BROWARD':
        paths = broward_page_images(cfn)
        if not paths:
            raise FileNotFoundError(
                f'no harvested images for {cfn} under {BROWARD_IMAGE_DIR}')
        return ocr_images(paths)

    pdf_path = os.path.join(workdir, 'doc.pdf')
    if not download_pdf(rec_book, rec_page, pdf_path):
        raise FileNotFoundError(f'clerk returned no PDF for book {rec_book}/{rec_page}')
    return ocr_pdf(pdf_path, workdir)


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
            # single OpenMP thread per process — parallelism comes from the
            # worker pool, not tesseract's internal threads (see
            # batch_extract_facility.download_and_ocr for the full story)
            env={**os.environ, 'OMP_THREAD_LIMIT': '1'},
        )
        text_parts.append(out.stdout.decode('utf-8', errors='replace'))
    return '\n'.join(text_parts).strip()


# ── LLM extraction ────────────────────────────────────────────────────────────
# Two independent calls, deliberately kept separate (see note above
# FACILITY_SYSTEM_PROMPT for why): one for doc_category/assignor/etc., one for
# facility_*. Both share the same request-body shape and spend tracking.

def chat_completion_body(ocr_text: str, system_prompt: str) -> dict:
    """The request body shape shared by the real-time and Batch API paths."""
    return {
        'model': OPENAI_MODEL,
        'max_tokens': 1024,
        'temperature': 0,
        'response_format': {'type': 'json_object'},
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user',   'content': ocr_text[:MAX_LLM_CHARS]},
        ],
    }


def postprocess_extraction(data: dict) -> dict:
    """Validate/coerce a raw parsed doc_category-extraction JSON response.

    Shared by the real-time path (llm_extract, below) and any future batch
    path for these fields, so they can never drift apart on rules.
    """
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
                       'assignee_name', 'assignee_parent', 'property_address',
                       'folio_parcel', 'sponsor_address'):
        val = data.get(text_field)
        data[text_field] = val.strip() if isinstance(val, str) and val.strip() else None

    officer = data.get('signatory_officer')
    if isinstance(officer, str):
        officer = officer.strip()
        data['signatory_officer'] = officer if officer else None
    else:
        data['signatory_officer'] = None

    return data


def postprocess_facility(raw: dict) -> dict:
    """Validate/coerce a raw parsed facility-extraction JSON response.

    Shared by the real-time path (llm_extract_facility, below) and
    batch_extract_facility.py's Batch API ingest path, so they can never
    drift apart on rules.

    Renames the model's raw field names (has_facility_language,
    lender_or_bank_name, agent_name, borrower_or_assignor_name, amount,
    amount_type, evidence_quote, confidence — matching FACILITY_SYSTEM_PROMPT
    exactly as tested) into our facility_*-prefixed DB columns. This mapping
    happens here, in code, rather than by asking the model to use different
    field names directly in its response.
    """
    data = {
        'facility_type':             raw.get('facility_type'),
        'facility_agreement_name':   raw.get('facility_agreement_name'),
        'facility_agreement_date':   raw.get('facility_agreement_date'),
        'facility_lender_name':      raw.get('lender_or_bank_name'),
        'facility_agent_name':       raw.get('agent_name'),
        'facility_borrower_name':    raw.get('borrower_or_assignor_name'),
        'facility_amount':           raw.get('amount'),
        'facility_amount_type':      raw.get('amount_type'),
        'facility_evidence_quote':   raw.get('evidence_quote'),
        'facility_confidence':       raw.get('confidence'),
    }

    if data['facility_type'] not in VALID_FACILITY_TYPES:
        data['facility_type'] = 'none'

    val = data['facility_amount']
    if isinstance(val, str):
        cleaned = re.sub(r'[^0-9.]', '', val)
        data['facility_amount'] = float(cleaned) if cleaned else None
    elif not isinstance(val, (int, float)):
        data['facility_amount'] = None

    for text_field in ('facility_agreement_name', 'facility_agreement_date',
                       'facility_lender_name', 'facility_agent_name',
                       'facility_borrower_name', 'facility_amount_type',
                       'facility_evidence_quote'):
        val = data.get(text_field)
        data[text_field] = val.strip() if isinstance(val, str) and val.strip() else None

    if data['facility_type'] == 'none':
        data['facility_evidence_quote'] = None

    if data.get('facility_confidence') not in ('high', 'medium', 'low'):
        data['facility_confidence'] = None

    return data


def _track_spend(usage: dict):
    in_tok  = usage.get('prompt_tokens', 0)
    out_tok = usage.get('completion_tokens', 0)
    # Locked because --workers runs several documents at once and `+=` on a dict
    # value is read-modify-write, not atomic. An undercounted total here would
    # under-report spend against --budget, which is the one counter that is
    # supposed to be able to stop the run.
    with _spend_lock:
        _spend['input_tokens']  += in_tok
        _spend['output_tokens'] += out_tok
        _spend['cost_usd'] += (in_tok  * PRICE_INPUT_PER_M  / 1_000_000
                               + out_tok * PRICE_OUTPUT_PER_M / 1_000_000)


def llm_extract(ocr_text: str) -> dict | None:
    resp = requests.post(
        OPENAI_URL,
        headers={'Authorization': f'Bearer {OPENAI_KEY}',
                 'Content-Type': 'application/json'},
        json=chat_completion_body(ocr_text, SYSTEM_PROMPT),
        timeout=90,
    )
    resp.raise_for_status()
    body = resp.json()
    _track_spend(body.get('usage', {}))
    data = json.loads(body['choices'][0]['message']['content'])
    return postprocess_extraction(data)


def llm_extract_facility(ocr_text: str) -> dict | None:
    resp = requests.post(
        OPENAI_URL,
        headers={'Authorization': f'Bearer {OPENAI_KEY}',
                 'Content-Type': 'application/json'},
        json=chat_completion_body(ocr_text, FACILITY_SYSTEM_PROMPT),
        timeout=90,
    )
    resp.raise_for_status()
    body = resp.json()
    _track_spend(body.get('usage', {}))
    data = json.loads(body['choices'][0]['message']['content'])
    return postprocess_facility(data)


def save(conn, cfn, rec_book, rec_page, status, data=None, ocr_chars=0,
         county=DEFAULT_COUNTY):
    """Write one extraction.

    `county` is written explicitly and must be. Both migrate_add_county.py and
    server/db.ts backfill NULL counties to MIAMI-DADE on sight, so an untagged
    Broward extraction would be silently relabelled — the same trap that already
    caught log_collection().
    """
    d = data or {}
    conn.execute("""
        INSERT INTO pdf_extractions
            (cfn, county, rec_book, rec_page, status, doc_category, doc_title,
             assignor_name, assignor_parent, assignee_name, assignee_parent,
             property_address, loan_amount, consideration_amount,
             folio_parcel, sponsor_address, signatory_officer,
             facility_type, facility_agreement_name, facility_agreement_date,
             facility_lender_name, facility_agent_name, facility_borrower_name,
             facility_amount, facility_amount_type, facility_evidence_quote,
             facility_confidence,
             ocr_chars, model, extracted_at, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
        ON CONFLICT(cfn) DO UPDATE SET
            county=excluded.county,
            status=excluded.status, doc_category=excluded.doc_category,
            doc_title=excluded.doc_title,
            assignor_name=excluded.assignor_name, assignor_parent=excluded.assignor_parent,
            assignee_name=excluded.assignee_name, assignee_parent=excluded.assignee_parent,
            property_address=excluded.property_address,
            loan_amount=excluded.loan_amount,
            consideration_amount=excluded.consideration_amount,
            folio_parcel=excluded.folio_parcel,
            sponsor_address=excluded.sponsor_address,
            signatory_officer=excluded.signatory_officer,
            facility_type=excluded.facility_type,
            facility_agreement_name=excluded.facility_agreement_name,
            facility_agreement_date=excluded.facility_agreement_date,
            facility_lender_name=excluded.facility_lender_name,
            facility_agent_name=excluded.facility_agent_name,
            facility_borrower_name=excluded.facility_borrower_name,
            facility_amount=excluded.facility_amount,
            facility_amount_type=excluded.facility_amount_type,
            facility_evidence_quote=excluded.facility_evidence_quote,
            facility_confidence=excluded.facility_confidence,
            ocr_chars=excluded.ocr_chars, model=excluded.model,
            extracted_at=excluded.extracted_at, raw_json=excluded.raw_json
    """, (
        cfn, county, rec_book, rec_page, status,
        d.get('doc_category'), d.get('doc_title'),
        d.get('assignor_name'), d.get('assignor_parent'),
        d.get('assignee_name'), d.get('assignee_parent'),
        d.get('property_address'), d.get('loan_amount'), d.get('consideration_amount'),
        d.get('folio_parcel'), d.get('sponsor_address'), d.get('signatory_officer'),
        d.get('facility_type'), d.get('facility_agreement_name'), d.get('facility_agreement_date'),
        d.get('facility_lender_name'), d.get('facility_agent_name'), d.get('facility_borrower_name'),
        d.get('facility_amount'), d.get('facility_amount_type'), d.get('facility_evidence_quote'),
        d.get('facility_confidence'),
        ocr_chars, OPENAI_MODEL if data else None,
        json.dumps(d) if data else None,
    ))
    conn.commit()


def save_facility(conn, cfn, rec_book, rec_page, status, data=None, ocr_chars=0):
    """Partial-update variant used by batch_extract_facility.py's facility-only
    backfill path: only touches facility_* (+ status/ocr_chars/model/extracted_at)
    columns, so it never clobbers doc_category/assignor_name/etc. that a prior
    extract_pdfs.py run may have already populated for this CFN."""
    d = data or {}
    conn.execute("""
        INSERT INTO pdf_extractions
            (cfn, rec_book, rec_page, status,
             facility_type, facility_agreement_name, facility_agreement_date,
             facility_lender_name, facility_agent_name, facility_borrower_name,
             facility_amount, facility_amount_type, facility_evidence_quote,
             facility_confidence, ocr_chars, model, extracted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(cfn) DO UPDATE SET
            facility_type=excluded.facility_type,
            facility_agreement_name=excluded.facility_agreement_name,
            facility_agreement_date=excluded.facility_agreement_date,
            facility_lender_name=excluded.facility_lender_name,
            facility_agent_name=excluded.facility_agent_name,
            facility_borrower_name=excluded.facility_borrower_name,
            facility_amount=excluded.facility_amount,
            facility_amount_type=excluded.facility_amount_type,
            facility_evidence_quote=excluded.facility_evidence_quote,
            facility_confidence=excluded.facility_confidence,
            extracted_at=excluded.extracted_at,
            status=CASE WHEN pdf_extractions.status = 'OK' THEN pdf_extractions.status ELSE excluded.status END,
            ocr_chars=CASE WHEN excluded.ocr_chars > 0 THEN excluded.ocr_chars ELSE pdf_extractions.ocr_chars END,
            model=CASE WHEN pdf_extractions.model IS NOT NULL THEN pdf_extractions.model ELSE excluded.model END
    """, (
        cfn, rec_book, rec_page, status,
        d.get('facility_type'), d.get('facility_agreement_name'), d.get('facility_agreement_date'),
        d.get('facility_lender_name'), d.get('facility_agent_name'), d.get('facility_borrower_name'),
        d.get('facility_amount'), d.get('facility_amount_type'), d.get('facility_evidence_quote'),
        d.get('facility_confidence'), ocr_chars, OPENAI_MODEL if data else None,
    ))
    conn.commit()


# ── Main loop ─────────────────────────────────────────────────────────────────

def process_one(cfn: str, rec_book: str, rec_page: str, doc_county: str) -> tuple:
    """Everything slow for one document: fetch, OCR, both LLM calls.

    Touches no database and no shared state, so it is safe to run in a thread
    pool. Returns (cfn, rec_book, rec_page, doc_county, status, data, ocr_chars,
    note) for the caller to persist — writes stay on the main thread, because
    SQLite takes one writer and the pool exists to hide network and OCR latency,
    not to parallelise the database.
    """
    with tempfile.TemporaryDirectory() as workdir:
        try:
            text = fetch_document_text(doc_county, cfn, rec_book, rec_page, workdir)
        except FileNotFoundError as e:
            return (cfn, rec_book, rec_page, doc_county, 'DOWNLOAD_ERROR', None, 0,
                    f'source unavailable: {e}')
        except Exception as e:
            return (cfn, rec_book, rec_page, doc_county, 'OCR_ERROR', None, 0,
                    f'fetch/OCR failed: {e}')

        if len(text) < 80:
            return (cfn, rec_book, rec_page, doc_county, 'OCR_ERROR', None, len(text),
                    f'OCR produced only {len(text)} chars')

        try:
            data = llm_extract(text)
            data.update(llm_extract_facility(text))
        except Exception as e:
            return (cfn, rec_book, rec_page, doc_county, 'LLM_ERROR', None, len(text),
                    f'LLM failed: {e}')

        return (cfn, rec_book, rec_page, doc_county, 'OK', data, len(text), None)


def run_parallel(docs: list, conn, workers: int):
    """Same work as run()'s loop, `workers` documents at a time.

    Sized for the droplet's 4 vCPUs. Each document is ~12s of which most is
    waiting — two OpenAI round trips and a clerk download — so the pool mostly
    buys back idle time rather than competing for CPU. tesseract is already
    pinned to one thread per process (see ocr_pdf), which is what makes stacking
    them safe.
    """
    counts = {'OK': 0, 'DOWNLOAD_ERROR': 0, 'OCR_ERROR': 0, 'LLM_ERROR': 0}
    categories: dict = {}
    done = 0
    started = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(process_one, cfn, rb, rp, c)
                   for cfn, rb, rp, _rec_date, c in docs]
        for fut in futures:
            cfn, rb, rp, dc, status, data, ocr_chars, note = fut.result()
            if note:
                print(f'  {cfn} ({dc}) {note}', flush=True)
            save(conn, cfn, rb, rp, status, data, ocr_chars, county=dc)
            counts[status] += 1
            if data:
                cat = data.get('doc_category')
                categories[cat] = categories.get(cat, 0) + 1

            done += 1
            if done % 50 == 0 or done == len(docs):
                rate = done / max(time.time() - started, 1)
                remaining = (len(docs) - done) / rate if rate else 0
                print(f'  [{done}/{len(docs)}] ok={counts["OK"]} '
                      f'dl_err={counts["DOWNLOAD_ERROR"]} ocr_err={counts["OCR_ERROR"]} '
                      f'llm_err={counts["LLM_ERROR"]} '
                      f'{rate*3600:.0f}/hr eta={remaining/3600:.1f}h '
                      f'spend=${_spend["cost_usd"]:.2f}/${BUDGET_USD:.2f}', flush=True)

            # Budget is checked here, not in the workers, so the decision is made
            # in one place against a total that is already committed to the DB.
            if _spend['cost_usd'] >= BUDGET_USD:
                print(f'Budget ${BUDGET_USD:.2f} reached — cancelling remaining work.')
                for f in futures:
                    f.cancel()
                break

    return counts, categories


def run(limit: int, retry_errors: bool, since: str | None = None, redo: bool = False,
        county: str | None = None, workers: int = 1):
    if not OPENAI_KEY:
        raise SystemExit('OPENAI_API_KEY is not set')

    conn = get_conn()
    ensure_schema(conn)
    docs = pending_documents(conn, limit, retry_errors, since=since, redo=redo,
                             county=county)
    by_county: dict = {}
    for d in docs:
        by_county[d[4]] = by_county.get(d[4], 0) + 1
    scope = f' [{county}]' if county else ''
    breakdown = ', '.join(f'{c}={n}' for c, n in sorted(by_county.items()))
    print(f'Pending documents{scope}: {len(docs)} (limit {limit})'
          + (f' — {breakdown}' if breakdown else ''))

    if workers > 1:
        counts, categories = run_parallel(docs, conn, workers)
        print(f'\nDone. {counts}')
        print(f'LLM spend: ${_spend["cost_usd"]:.4f} '
              f'({_spend["input_tokens"]:,} in / {_spend["output_tokens"]:,} out tokens)')
        if categories:
            print(f'Categories: {categories}')
        return

    counts = {'OK': 0, 'DOWNLOAD_ERROR': 0, 'OCR_ERROR': 0, 'LLM_ERROR': 0}
    categories: dict = {}

    for i, (cfn, rec_book, rec_page, rec_date, doc_county) in enumerate(docs, 1):
        with tempfile.TemporaryDirectory() as workdir:
            # Fetch + OCR are one step now: where the page images come from is a
            # per-county detail (clerk download vs harvested TIFFs), and only
            # fetch_document_text() needs to know which.
            try:
                text = fetch_document_text(doc_county, cfn, rec_book, rec_page, workdir)
            except FileNotFoundError as e:
                print(f'  [{i}] {cfn} ({doc_county}) source unavailable: {e}')
                save(conn, cfn, rec_book, rec_page, 'DOWNLOAD_ERROR', county=doc_county)
                counts['DOWNLOAD_ERROR'] += 1
                continue
            except Exception as e:
                print(f'  [{i}] {cfn} ({doc_county}) fetch/OCR failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'OCR_ERROR', county=doc_county)
                counts['OCR_ERROR'] += 1
                continue

            if len(text) < 80:
                print(f'  [{i}] {cfn} ({doc_county}) OCR produced only {len(text)} chars')
                save(conn, cfn, rec_book, rec_page, 'OCR_ERROR', county=doc_county)
                counts['OCR_ERROR'] += 1
                continue

            try:
                data = llm_extract(text)
                data.update(llm_extract_facility(text))
                save(conn, cfn, rec_book, rec_page, 'OK', data, len(text),
                     county=doc_county)
                counts['OK'] += 1
                cat = data.get('doc_category')
                categories[cat] = categories.get(cat, 0) + 1
            except Exception as e:
                print(f'  [{i}] {cfn} LLM failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'LLM_ERROR', ocr_chars=len(text),
                     county=doc_county)
                counts['LLM_ERROR'] += 1

        if i % 25 == 0 or i == len(docs):
            print(f'  [{i}/{len(docs)}] ok={counts["OK"]} '
                  f'dl_err={counts["DOWNLOAD_ERROR"]} ocr_err={counts["OCR_ERROR"]} '
                  f'llm_err={counts["LLM_ERROR"]} '
                  f'spend=${_spend["cost_usd"]:.2f}/${BUDGET_USD:.2f}', flush=True)

        if _spend['cost_usd'] >= BUDGET_USD:
            print(f'\n⛔ BUDGET LIMIT REACHED: ${_spend["cost_usd"]:.2f} '
                  f'(cap ${BUDGET_USD:.2f}) after {i} documents. Stopping gracefully.')
            print('   Already-extracted documents are saved; re-run to continue '
                  'with a fresh budget.')
            break

        # The delay is politeness toward the clerk's download endpoint. Broward
        # images are already on local disk, so there is nothing to be polite to.
        if doc_county != 'BROWARD':
            time.sleep(REQUEST_DELAY)

    print(f'\nDone. {counts}')
    print(f'LLM spend: ${_spend["cost_usd"]:.4f} '
          f'({_spend["input_tokens"]:,} in / {_spend["output_tokens"]:,} out tokens)')
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
    p.add_argument('--redo', action='store_true',
                   help='re-extract already-OK docs that are missing the new fields '
                        '(folio_parcel, sponsor_address, signatory_officer)')
    p.add_argument('--budget', type=float, default=None,
                   help=f'max LLM spend in USD for this run (default {BUDGET_USD}, '
                        'or OPENAI_BUDGET_USD env var)')
    p.add_argument('--workers', type=int, default=1,
                   help='documents processed concurrently (default 1). '
                        'Most of a document is spent waiting on the clerk and '
                        'two OpenAI calls, so 4 on the 4-vCPU droplet is roughly '
                        '4x throughput. Left at 1 by default so the cron jobs '
                        'behave exactly as before.')
    p.add_argument('--county', type=str, default=None,
                   help="restrict to one county, e.g. 'BROWARD' or 'MIAMI-DADE' "
                        '(default: all counties, newest documents first)')
    args = p.parse_args()
    if args.budget is not None:
        BUDGET_USD = args.budget
    run(args.limit, args.retry_errors, since=args.since, redo=args.redo,
        county=args.county.upper() if args.county else None,
        workers=max(1, args.workers))
