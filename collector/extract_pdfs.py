"""
PDF Extraction Pipeline
-----------------------
Downloads the recorded document image for each assignment from the Miami-Dade
Clerk, OCRs the first pages, and uses OpenAI (gpt-5-nano) to extract structured data:

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

Model is configurable via OPENAI_MODEL (default: gpt-5-nano; see
model_request_params for what each family accepts).
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
# gpt-4.1-nano read every document from the start of the project. OpenAI
# retired it on 23 Oct 2026: every Chat Completions call returned 404
# model_not_found from the 24 Oct runs on, and nothing reached the dashboard
# for three days. gpt-5-nano is the same tier (cheaper on input, same on
# output); gpt-5.4-nano is the next step up. Both were checked against four
# real documents on 26 Oct 2026 and matched the old model on doc_category,
# parties, property address and loan amount.
OPENAI_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-5-nano')

OPENAI_URL  = 'https://api.openai.com/v1/chat/completions'

# 4096, not 1024: a multi-parcel commercial assignment lists dozens of folio
# numbers (Hillsborough 2026152506, 31 parcels, $7.5M) and the model was cut
# off mid-list at 1,024 tokens, which parsed as an "Unterminated string"
# LLM_ERROR — 7% of a Hillsborough re-read on 15 Oct 2026, and precisely the
# CRE documents the product is for. Output on nano is cheap; a truncated
# answer is not.
MAX_OUTPUT_TOKENS = 4096


def model_request_params(model: str) -> dict:
    """The sampling parameters this model accepts — they differ by family.

    The GPT-5 family is a reasoning family: it takes max_completion_tokens
    (max_tokens is rejected as an unsupported parameter) and the cap counts
    reasoning tokens too, so the effort is pinned to the lowest setting the
    model offers — extraction wants a transcription, not deliberation.
    gpt-5-nano rejects any temperature but its default and knows 'minimal';
    gpt-5.4 accepts temperature 0 and an effort of 'none'. The 4.1 family
    keeps the original shape, so OPENAI_MODEL=gpt-4.1-mini still works.
    Verified against the live API on 26 Oct 2026.
    """
    m = model.lower()
    if m.startswith('gpt-5.4'):
        return {'max_completion_tokens': MAX_OUTPUT_TOKENS,
                'reasoning_effort': 'none', 'temperature': 0}
    if m.startswith('gpt-5'):
        return {'max_completion_tokens': MAX_OUTPUT_TOKENS,
                'reasoning_effort': 'minimal'}
    return {'max_tokens': MAX_OUTPUT_TOKENS, 'temperature': 0}

DOC_IMAGE_URL = ('https://onlineservices.miamidadeclerk.gov/officialrecords/'
                 'api/DocumentImage/getdocumentimage')

# Broward document images are harvested from the county's SFTP feed by
# broward_images.py and land as <instrument>/<page>.tif. There is nothing to
# download at extraction time — see fetch_document_text().
BROWARD_IMAGE_DIR = os.environ.get(
    'BROWARD_IMAGE_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'broward_images'))

# Hillsborough serves each document as a PDF from its public portal, keyed by
# an opaque ID that only a search returns — so a fetch is search-then-download.
HILLSBOROUGH_API = os.environ.get('HILLSBOROUGH_API_URL', 'https://publicaccess.hillsclerk.com')

DEFAULT_COUNTY = 'MIAMI-DADE'

MAX_OCR_PAGES = 3        # first pages carry the operative language
OCR_DPI       = 200
MAX_LLM_CHARS = 14000    # ~3.5k tokens of OCR text per request
REQUEST_DELAY = 0.6      # polite delay between clerk downloads (seconds)

# LLM budget cap: script stops gracefully once estimated spend reaches this.
# Tracked from actual token usage returned by the OpenAI API.
BUDGET_USD    = float(os.environ.get('OPENAI_BUDGET_USD', '5.0'))
# USD per 1M tokens by model family (prefix match, first hit wins). An unknown
# model falls back to the dearest row, so --budget stops a run early rather
# than late. Keep this in step with OPENAI_MODEL above: the budget is only as
# honest as these two numbers.
_PRICES = (
    ('gpt-5.4-nano', 0.20, 1.25),
    ('gpt-5-nano',   0.05, 0.40),
    ('gpt-4.1-nano', 0.10, 0.40),
)


def model_prices(model: str) -> tuple[float, float]:
    """(input, output) USD per 1M tokens for this model."""
    m = model.lower()
    for prefix, price_in, price_out in _PRICES:
        if m.startswith(prefix):
            return price_in, price_out
    return max(p[1] for p in _PRICES), max(p[2] for p in _PRICES)


PRICE_INPUT_PER_M, PRICE_OUTPUT_PER_M = model_prices(OPENAI_MODEL)

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
- folio_parcel: the county folio or parcel identification number for the property, ONLY if one is actually printed in the text. Look for labels like "Folio No.", "Folio #", "Folio Number", "Parcel ID", "Parcel No.", "RE#", "Property ID", "Tax ID", or a bare identifier in the legal description block or an "Exhibit A" section. A Miami-Dade folio is 13 digits written in four dash-separated groups of 2, 4, 3 and 4 digits; other counties print their own parcel-ID formats. Copy the identifier exactly as it appears, without the label. NEVER invent, guess, complete or illustrate a folio number: if no folio or parcel number is printed in the text, return null.
- sponsor_address: the mailing address or business address of the assignee (buyer/lender) if stated in the document body (NOT the property address). Often appears after the assignee's name in the opening recital or in the signature block. Return as a string, else null.
- signatory_officer: The name and title of the person who signed this document ON BEHALF OF THE ASSIGNOR (the transferring party). Look in the signature block for a line like "By: ___" or "Name: ___" or "Title: ___" directly under the assignor's name. DO NOT return the notary's name — the notary appears in a separate "State of ___, County of ___" acknowledgment block and is not the signatory. DO NOT return the assignee's signer. Prefer the printed/typed name under the signature line over any handwritten scrawl. Return "Name, Title" as a single string (e.g. "Jane Smith, Vice President"), or null if not legible.

Rules:
- DEFAULT FOR ASSIGNMENTS: a document that conveys the mortgage outright is LOAN_TRANSFER. The \
giveaway wording is "forever", "without recourse", "grant, bargain, sell, assign, transfer and set \
over", "all right, title and interest". Assignments to a trustee, servicer, GSE or to the Secretary \
of Housing and Urban Development are LOAN_TRANSFER.
- Do NOT answer COLLATERAL merely because the document mentions "security", "securing", or a \
"Security Instrument". EVERY mortgage assignment contains those words, because a mortgage IS a \
security instrument. COLLATERAL requires the assignor to be PLEDGING something it still owns, as \
security for ITS OWN debt — look for "collateral assignment", "collaterally assign", "as collateral \
security", or "for better securing the repayment of the Loan" where the assignee is the assignor's \
lender. If that language is absent, it is NOT COLLATERAL.
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
sentence is short and mentions it only in passing. Note that this example settles only \
has_facility_language; the facility_type happens to be a warehouse one here because the agreement \
is named "Warehouse Agreement", NOT because warehouse is a default.

CHOOSING facility_type. Decide this INDEPENDENTLY of the examples above — they \
illustrate detection, not type. Pick by who the borrower is and what the agreement actually says:

"warehouse_or_revolving_credit_facility" — the borrower is ITSELF a lending business \
(a mortgage originator, lender or fund) borrowing against mortgages or notes it holds. \
Hallmarks: "warehouse", "warehousing", "Pledged Loans", "borrowing base", "Master Repurchase \
Agreement", or an explicitly REVOLVING loan to a lender.

"syndicated_credit_agreement" — MULTIPLE lenders act together through an agent. \
Hallmarks: a party acting "as Administrative Agent" or "as Collateral Agent" FOR THE LENDERS, \
"the Lenders", "Lead Arranger", or a "Credit Agreement" naming an agent bank. If an agent acts \
for a group of lenders, choose this over warehouse even when the word "revolving" appears.

"consumer_or_business_line_of_credit" — a SINGLE lender extends a line of credit to an \
individual or to an operating business that is NOT in the lending trade. \
Hallmarks: "Home Equity Line of Credit", "HELOC", "Equity Reserve", "Commercial Line of Credit", \
or a line of credit to a named natural person or an operating company (a restaurant, a contractor, \
a property owner).

"none" — use whenever has_facility_language is false.

Three rules that override everything else, because these mistakes are common:
1. If the text describes the credit as "NON-REVOLVING" (e.g. "Commercial Non-Revolving Line of \
Credit"), it is NOT "warehouse_or_revolving_credit_facility". A non-revolving line to an operating \
business is "consumer_or_business_line_of_credit".
2. If the ONLY agreement named is a generic security instrument — "Mortgage", "Security \
Instrument", "Deed of Trust", "Note", "Assignment" — that is standard conveyancing boilerplate, \
NOT a facility. Set has_facility_language=false and facility_type="none".
3. A bare "Construction Loan Agreement", "Loan Agreement" or "Loan and Security Agreement" with no \
revolving/warehouse/agent language and no lending-business borrower is a single term loan, not a \
facility. Set has_facility_language=false and facility_type="none".

Do not default to "warehouse_or_revolving_credit_facility". It is the right answer only when the \
borrower is a lending business, and it is genuinely the minority of line-of-credit documents \
recorded against residential property.

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
    conn = sqlite3.connect(DB, timeout=120)
    conn.execute('PRAGMA journal_mode=WAL')
    # 120s rather than python's 5s default. normalize.py rebuilds the derived
    # tables and commits the whole thing in one transaction at the end of an
    # ~80-minute run; a writer that gives up after 5 seconds during that commit
    # raises "database is locked". That is survivable for a 200-document cron
    # run and fatal for a multi-day backfill, so the wait is generous.
    conn.execute('PRAGMA busy_timeout=120000')
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
                # Why the COLLATERAL verdict was kept or overturned. Facility
                # extraction has had an evidence quote from the start and it is
                # what made that bug auditable from stored data alone;
                # doc_category had none, so correcting it cost a full re-OCR of
                # 11,366 documents. This column means the next audit is free.
                'doc_category_evidence TEXT',
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
                      county: str | None = None,
                      doc_types: list[str] | None = None) -> list:
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
        # A retry pass covers everything a normal pass does PLUS the error
        # rows. Without the raw_json term it covered less: the facility Batch
        # tick rewrites an LLM_ERROR row as OK (status is kept once OK) with no
        # main fields, and a retry pass then skipped exactly the documents the
        # failed run had been trying to read (Miami-Dade 23 Oct 2026, 100 rows).
        status_clause = ("(px.cfn IS NULL OR px.status != 'OK' "
                         "OR (px.status = 'OK' AND px.raw_json IS NULL))")
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
    #   Hillsborough — fetched live from the clerk by instrument number, which
    #                every row has; most carry no book/page at all.
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
    hillsborough_available = "OR COALESCE(a.county, 'MIAMI-DADE') = 'HILLSBOROUGH'"
    availability = f"AND ({miami_dade_available} {broward_available} {hillsborough_available})"
    params: list = []
    county_clause = ""
    if county:
        county_clause = "AND COALESCE(a.county, 'MIAMI-DADE') = ?"
        params.append(county)
    if doc_types:
        county_clause += f" AND a.doc_type IN ({','.join('?' * len(doc_types))})"
        params.extend(doc_types)

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


def download_hillsborough_pdf(instrument: str, dest: str) -> bool:
    found = requests.post(
        f'{HILLSBOROUGH_API}/Public/ORIUtilities/DocumentSearch/api/Search',
        json={'Instrument': [int(instrument)]}, timeout=60,
    )
    if found.status_code != 200:
        return False
    rows = [r for r in found.json().get('ResultList') or []
            if str(r.get('Instrument')) == instrument and r.get('ID')]
    if not rows:
        return False
    resp = requests.get(
        f'{HILLSBOROUGH_API}/Public/ORIUtilities/OverlayWatermark/api/Watermark/'
        + requests.utils.quote(rows[0]['ID'], safe=''),
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
    if county == 'HILLSBOROUGH':
        if not download_hillsborough_pdf(cfn, pdf_path):
            raise FileNotFoundError(f'clerk returned no PDF for instrument {cfn}')
        return ocr_pdf(pdf_path, workdir)
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
        # max_completion_tokens / max_tokens, temperature and reasoning_effort
        # depend on the model family — see model_request_params. The Batch API
        # path (batch_extract_facility.py) sends this exact body, so it follows
        # any model change automatically.
        **model_request_params(OPENAI_MODEL),
        'response_format': {'type': 'json_object'},
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user',   'content': ocr_text[:MAX_LLM_CHARS]},
        ],
    }


# ── Folio numbers the model made up ──────────────────────────────────────────
# Until 26 Oct 2026 the prompt showed "01-3124-020-0340" as a format example,
# and the model copied it into documents that print no folio at all: 10,134
# production rows held it verbatim, ~15,500 held it or a near-variant (digits
# regrouped, first pair changed, "-020-0340" kept), 861 held a mask such as
# "XX-XXXX-XXX-XXXX", and the OCR text of sampled documents contained no folio.
# The example is gone from the prompt; this is the belt to that suspender, and
# clean_folio_echo.py applies the same rule to the rows already stored.
_FOLIO_EXAMPLE_DIGITS = '0131240200340'
_FOLIO_PLACEHOLDER_WORDS = {
    'null', 'none', 'n/a', 'na', 'unknown', 'not found', 'not present', 'not stated',
    'not available', 'not provided', 'not legible', 'not applicable', 'not listed',
}


def folio_placeholder_reason(val) -> str | None:
    """Why a folio_parcel value is an echo of the prompt, or None if it may be real."""
    if not isinstance(val, str):
        return None
    s = val.strip()
    if not s:
        return None
    low = s.lower()
    if low in _FOLIO_PLACEHOLDER_WORDS or low.startswith('not '):
        return 'placeholder word'
    # A mask: only digits, X's and separators, with at least one X.
    if 'x' in low and re.fullmatch(r'[0-9xX\-\s.,/]+', s):
        return 'X mask'
    digits = re.sub(r'[-\s.,/]', '', s)
    if not digits.isdigit():
        return None
    # The example itself, however it was re-grouped ("01-31-24-02-03-40"
    # and "01-31-24-02-0-340" are the example with one zero dropped).
    if digits in (_FOLIO_EXAMPLE_DIGITS, '013124020340'):
        return 'prompt example'
    # The example with its first pair changed ("11-31-24-020-0340"), or
    # mangled to 12 digits ("01-3244-02-0340"). No county here has a 12-digit
    # folio starting 01: Miami-Dade's are 13 digits, Broward's start 4 or 5,
    # Hillsborough's are alphanumeric.
    if digits.endswith('0200340') or (
            len(digits) == 12 and digits.startswith('01') and digits.endswith('020340')):
        return 'prompt example variant'
    # "11-11-11-11-111-1111", "48-48-48-…": a one- or two-digit pattern
    # repeated is never a folio.
    if len(digits) >= 6 and re.fullmatch(r'(\d{1,2})\1{2,}', digits):
        return 'repeated digits'
    return None


def folio_is_placeholder(val) -> bool:
    """True when a folio_parcel value echoes the prompt instead of the document."""
    return folio_placeholder_reason(val) is not None


def postprocess_extraction(data: dict) -> dict:
    """Validate/coerce a raw parsed doc_category-extraction JSON response.

    Shared by the real-time path (llm_extract, below) and any future batch
    path for these fields, so they can never drift apart on rules.
    """
    if data.get('doc_category') not in VALID_CATEGORIES:
        data['doc_category'] = 'OTHER'

    if folio_is_placeholder(data.get('folio_parcel')):
        data['folio_parcel'] = None

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


# ── Facility type: decided in code, not by the model ──────────────────────────
# The model extracts the agreement name accurately and judges the CATEGORY
# badly. Before 2026-09-12 it put 623 of 625 production rows in
# warehouse_or_revolving_credit_facility, with 2 in any other bucket and zero
# syndicated — including documents whose own agreement name read "Commercial
# NON-Revolving Line of Credit" and 101 whose only named agreement was
# "Security Instrument" or "Mortgage", i.e. ordinary conveyancing boilerplate.
#
# Adding explicit type rules to FACILITY_SYSTEM_PROMPT helped but fixed only 6
# of 16 sampled failures: gpt-4.1-nano does not reliably apply a rule list that
# long. So the judgement moved here, where it is deterministic, free, and
# testable offline against the fields already in the database.
# collector/tests/check_facility_type.py asserts these rules with no API calls.
_FAC_GENERIC = re.compile(
    r'^\s*(the\s+)?('
    r'mortgage( note| and note)?|security instrument|deed of trust|note|'
    r'promissory note|assignment( of mortgage)?|loan documents?|'
    r'security agreement|operator security agreement'
    r')\s*$', re.I)
_FAC_NON_REVOLVING = re.compile(r'non[-\s]?revolving', re.I)
# The spelling is deliberately OCR-tolerant. "Warchouse Mortgage Loan and
# Security Agreement" is a real production value — tesseract reads the 'e' as a
# 'c' — and a strict r'warehous' drops that document to none, which would also
# fail the 21/21 integration gate that covers it.
_FAC_WAREHOUSE = re.compile(
    r'wa?r[ec]h[o0][uv]s|pledged loans|master repurchase|borrowing base|repurchase agreement',
    re.I)
# The agent PHRASE, not the facility_agent_name field — that field holds values
# like the bare word "Agent" and property-company names, and trusting it put 33
# documents in the syndicated bucket where only 11 belong.
_FAC_SYNDICATED = re.compile(
    r'administrative agent|collateral agent|as agent for|the lenders|lead arranger|syndicat', re.I)
_FAC_CONSUMER = re.compile(
    r'home equity|heloc|equity reserve|line of credit|line-of-credit|personal line', re.I)
_FAC_TERM_ONLY = re.compile(
    r'^\s*(construction loan agreement|loan agreement|loan and security agreement|'
    r'business loan agreement|term loan agreement)\s*$', re.I)


def classify_facility_type(agreement_name: str | None,
                           evidence_quote: str | None) -> tuple[str, str]:
    """Return (facility_type, reason). Pure function of two extracted strings."""
    name = (agreement_name or '').strip()
    blob = ' '.join(x for x in (agreement_name, evidence_quote) if x)

    if name and _FAC_GENERIC.match(name):
        return 'none', 'generic instrument'
    if _FAC_NON_REVOLVING.search(blob):
        # Explicitly non-revolving cannot be the revolving bucket. Reroute to a
        # line of credit only if it actually is one — a "Construction Loan
        # Agreement" that says non-revolving is a term loan, not a line.
        if _FAC_CONSUMER.search(blob):
            return 'consumer_or_business_line_of_credit', 'non-revolving line'
        return 'none', 'non-revolving term loan'
    if _FAC_WAREHOUSE.search(blob):
        return 'warehouse_or_revolving_credit_facility', 'warehouse language'
    if _FAC_SYNDICATED.search(blob):
        return 'syndicated_credit_agreement', 'agent for lenders'
    if _FAC_CONSUMER.search(blob):
        return 'consumer_or_business_line_of_credit', 'line of credit'
    if name and _FAC_TERM_ONLY.match(name):
        return 'none', 'single term loan'
    return 'none', 'no facility marker'


# ── Document category: the COLLATERAL verdict is checked against the text ─────
# The model put 11,366 ASSIGNMENT OF MORTGAGE filings in COLLATERAL — 21% of all
# AMO — and reading 32 of them by hand found 20/20 of the suspect group to be
# outright transfers: "forever without recourse", "grant, bargain, sell, assign,
# transfer and set over", "all right, title and interest". None contained any
# pledge language. Their assignees are trustees, servicers, GSEs and HUD, and
# nobody pledges collateral to HUD.
#
# Cause is the same shape as the facility_type bug. The prompt defines COLLATERAL
# as a pledge "(no outright transfer)" — the deciding clause is a trailing
# parenthetical — and offers no positive anchor for a plain assignment. Meanwhile
# EVERY mortgage assignment is saturated with "security" and "securing", because
# a mortgage IS a security instrument, so the model reaches for COLLATERAL on
# ambient vocabulary.
#
# This rule is deliberately narrow: it only ever OVERTURNS a COLLATERAL verdict
# the document does not support, and never invents one. Validated 32/32 against
# documents read by hand, including leaving all 6 genuine collateral assignments
# alone. See collector/tests/check_doc_category.py.
_CAT_PLEDGE = re.compile(
    r'collateral\s*(?:re-?)?\s*assign'
    r'|collaterally\s+assign'
    r'|as\s+collateral\s+security'
    r'|for\s+(?:better\s+)?securing\s+the\s+(?:re)?payment'
    r'|as\s+security\s+for\s+the\s+(?:payment|performance|obligations)\s+of\s+(?:the\s+)?assignor'
    r'|pledge[sd]?\s+(?:and\s+assigns?\s+)?(?:to|unto)\b',
    re.I)

# Rents and leases are the OTHER half of the wrong-bucket problem: 6,043 rows
# across ASG/AST/AMO sat in COLLATERAL while being ordinary property-level
# security instruments. Six were fetched and read on 2026-09-15 and every one
# said the same thing — "grants a continuing security interest in ... the Rents",
# "THIS ASSIGNMENT IS GIVEN TO SECURE (1) PAYMENT OF THE INDEBTEDNESS" — between
# a property owner and its own lender.
#
# The deciding question is WHAT IS BEING ASSIGNED, and the recorded title states
# it. "Collateral" in a title describes the manner of the assignment, not the
# asset: a landlord collaterally assigning tenant leases is the same economic
# event as one plainly assigning rents, and neither is a loan changing hands nor
# a loan pledged to a warehouse lender. Both belong in RENTS_LEASES.
#
# A title regex rather than a list of known titles, because the population is 365
# distinct spellings of the same few instruments, many of them OCR damage —
# "COLEATERAL", "COELATERAL", "ASSIGNMENT OF-RENTS", "COLLATERALASSIGNMENT".
_CAT_RENTS_TITLE = re.compile(
    r'\b(RENTS?|LEASES?|LESSOR|LESSEE|TENANT|RENTALS?|PROFITS)\b', re.I)

# A condo association pledging its assessment receivables and lien rights to a
# bank, securing its own borrowing. The asset is not rents, and the assignor
# still owns it — this is what COLLATERAL is supposed to mean, so it is held
# before the rents test, which its titles would otherwise catch on "LIEN".
_CAT_ASSESSMENTS = re.compile(r'ASSESSMENT|LIEN\s+RIGHT', re.I)

# Title names a debt instrument. Then the title alone cannot settle the bucket —
# a mortgage assignment that also sweeps in rents is still a mortgage assignment
# — so these fall through to the text test below.
_CAT_DEBT_TITLE = re.compile(
    r'\b(MORTGAGES?|NOTES?|DEED\s+OF\s+TRUST|LOANS?|HELOCS?|SECURITY\s+INSTRUMENTS?)\b', re.I)

# A UCC financing statement genuinely IS a collateral record. Its text would not
# match the pledge patterns above and two of its titles do mention leases, so
# without this exclusion it would lose rows out of a bucket where all 20,522
# belong. Asserted by check_doc_category.py. Miami-Dade files FST, Hillsborough FIN.
_CAT_UCC_DOC_TYPES = ('FINANCING STATEMENT UCC - FST', 'FIN')

# Deliberately NOT _CAT_RENTS_TITLE. This one is matched against the whole OCR
# body, where a bare \bLEASES?\b would fire on almost every commercial mortgage
# assignment ever recorded — they routinely recite the leases they sweep in —
# and would stop genuine transfers from being corrected. Only the instrument
# name, as a phrase, counts as body evidence.
_CAT_RENTS_BODY = re.compile(r'assignment\s+of\s+(?:leases?\s+and\s+)?rents?\b'
                             r'|assignment\s+of\s+leases?\b', re.I)

_CAT_AMO_DOC_TYPE = 'ASSIGNMENT OF MORTGAGE - AMO'
# Miami-Dade ASG, Broward AST, Hillsborough ASG / ASGT (assignment with taxes).
_CAT_GENERIC_DOC_TYPES = ('ASSIGNMENT - ASG', 'AST', 'ASG', 'ASGT', 'ASINT')


def _cat_text_eligible(doc_type: str | None, doc_title: str | None) -> bool:
    """Whether the pledge-vs-transfer text test may run on this filing.

    It matters because that test's fallback verdict is LOAN_TRANSFER — absence
    of pledge language is read as an outright conveyance. That inference is only
    sound once the subject is known to be a debt instrument. The AMO doc type
    guarantees it outright; the generic ASG/AST types do not, since they also
    carry permits, development rights and contract assignments, and defaulting
    those to LOAN_TRANSFER would put non-loans into the Reporting tab's default
    view. For those, the title has to name the debt instrument first.
    """
    dt = doc_type or ''
    if dt == _CAT_AMO_DOC_TYPE:
        return True
    if dt in _CAT_GENERIC_DOC_TYPES:
        return bool(_CAT_DEBT_TITLE.search(doc_title or ''))
    return False


def reclassify_rents_by_title(doc_type: str | None, doc_title: str | None,
                              model_category: str | None
                              ) -> tuple[str | None, str | None]:
    """Route a COLLATERAL verdict by what the title says is being assigned.

    Pure function of two stored columns — no OCR text, no download, no LLM — so
    this one is a seconds-long backfill rather than an hours-long re-read.
    Returns (category, evidence); leaves the verdict alone when the title does
    not settle it.
    """
    if model_category != 'COLLATERAL':
        return model_category, None
    if (doc_type or '') in _CAT_UCC_DOC_TYPES:
        return model_category, None

    title = (doc_title or '').strip()
    if not title:
        return model_category, None
    if _CAT_ASSESSMENTS.search(title):
        return 'COLLATERAL', f'title pledges assessments / lien rights: {title[:200]}'
    if _CAT_DEBT_TITLE.search(title):
        return model_category, None
    if _CAT_RENTS_TITLE.search(title):
        return 'RENTS_LEASES', f'title assigns rents / leases: {title[:200]}'
    return model_category, None


def reclassify_collateral(doc_type: str | None, doc_title: str | None,
                          ocr_text: str | None, model_category: str | None
                          ) -> tuple[str | None, str | None]:
    """Return (category, evidence). Only corrects an unsupported COLLATERAL."""
    if model_category != 'COLLATERAL':
        return model_category, None

    # What the title says is being assigned settles most of these outright.
    cat, quote = reclassify_rents_by_title(doc_type, doc_title, model_category)
    if cat != 'COLLATERAL' or quote:
        return cat, quote

    if not _cat_text_eligible(doc_type, doc_title):
        return model_category, None

    blob = f'{doc_title or ""}\n{ocr_text or ""}'
    m = _CAT_PLEDGE.search(blob)
    if m:
        return 'COLLATERAL', _cat_quote(blob, m)
    if _CAT_RENTS_BODY.search(blob):
        # Title named a debt instrument but the body is about rents — a mixed
        # instrument. Not evidenced as a pledge and not safely a transfer, so
        # the model's verdict stands rather than being guessed at.
        return model_category, None
    return 'LOAN_TRANSFER', None


def _cat_quote(text: str, m) -> str:
    start = max(0, m.start() - 90)
    end = min(len(text), m.end() + 150)
    return ' '.join(text[start:end].split())[:300]


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

    # The model's own facility_type is discarded in favour of the rules above.
    # It is kept only to the extent that a model verdict of "none" still means
    # none — the rules decide which KIND of facility, never whether to invent
    # one where the model saw nothing.
    if data['facility_type'] != 'none':
        decided, reason = classify_facility_type(
            raw.get('facility_agreement_name'), raw.get('evidence_quote'))
        data['facility_type'] = decided
        data['facility_type_reason'] = reason

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


class OpenAIUnavailable(RuntimeError):
    """OpenAI is refusing every request, not just this document.

    Raised for a 429 whose body says insufficient_quota, for a 400/404 that
    rejects the model or the request shape itself (a retired model fails every
    document identically — see _openai_post), and for a 429 or 5xx that is
    still failing after the retries in _openai_post. The loops must
    STOP the run and leave the document unrecorded. A per-document LLM_ERROR
    row is exactly the wrong outcome here: on 15 Oct 2026 the account ran out
    of credits at ~05:50 UTC and the Hillsborough backlog carried on for four
    hours writing 4,773 LLM_ERROR rows at ~1,100 an hour — each one counted as
    "read" by the Overview card and the weekly-email gate, and none would be
    retried without --retry-errors. Downloads and OCR were fine the whole
    time, so the card blamed the clerk.
    """


_TRANSIENT_RETRIES = 4
_MAX_CONSECUTIVE_LLM_ERRORS = 25


def _openai_post(body: dict) -> dict:
    """One chat completion, with the distinction the loops need.

    A genuine per-document problem (a 400, unparseable JSON back) propagates
    as before and becomes LLM_ERROR. An account-level refusal becomes
    OpenAIUnavailable. Rate-limit 429s and 5xx are retried with backoff first,
    honouring Retry-After, because those clear on their own; a quota 429 aborts
    at once, because it never does.
    """
    last = None
    for attempt in range(_TRANSIENT_RETRIES + 1):
        resp = requests.post(
            OPENAI_URL,
            headers={'Authorization': f'Bearer {OPENAI_KEY}',
                     'Content-Type': 'application/json'},
            json=body,
            timeout=90,
        )
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            try:
                err = resp.json().get('error', {}) or {}
            except ValueError:
                err = {}
            if err.get('type') == 'insufficient_quota':
                raise OpenAIUnavailable(
                    f"OpenAI: {err.get('message') or 'insufficient quota'} "
                    f"(code={err.get('code')})")
            last = f"429 {err.get('message') or resp.text[:120]}"
        elif resp.status_code >= 500:
            last = f'{resp.status_code} {resp.text[:120]}'
        elif resp.status_code in (400, 404):
            try:
                err = resp.json().get('error', {}) or {}
            except ValueError:
                err = {}
            # A model the API no longer serves, or a parameter it refuses, fails
            # every document the same way — it is our configuration that is
            # wrong, not the document. When OpenAI retired gpt-4.1-nano on
            # 23 Oct 2026 each run wrote 25 LLM_ERROR rows and then tripped the
            # consecutive-failure stop, three times a day for three days, and
            # the facility Batch tick flipped the rows back to OK behind it.
            # Abort instead, naming the model, so the cron log says why.
            if (err.get('code') in ('model_not_found', 'unsupported_parameter',
                                    'unsupported_value')
                    or err.get('param') == 'model'):
                raise OpenAIUnavailable(
                    f"OpenAI rejects every request for model {body.get('model')!r}: "
                    f"{err.get('message') or resp.text[:200]} "
                    f"(HTTP {resp.status_code}, code={err.get('code')})")
            resp.raise_for_status()
        else:
            resp.raise_for_status()
        if attempt < _TRANSIENT_RETRIES:
            try:
                delay = float(resp.headers.get('Retry-After') or 0)
            except ValueError:
                delay = 0.0
            time.sleep(max(delay, 2.0 * (2 ** attempt)))
    raise OpenAIUnavailable(
        f'OpenAI still failing after {_TRANSIENT_RETRIES} retries: {last}')


def _completion_text(body: dict) -> str:
    """The model's answer, or a clear error if it was cut off.

    A truncated JSON object fails to parse with "Unterminated string at
    char N", which says nothing about why. finish_reason does: 'length' means
    the output cap, and the note should say so.
    """
    choice = body['choices'][0]
    if choice.get('finish_reason') == 'length':
        used = (body.get('usage') or {}).get('completion_tokens')
        raise ValueError(f'model output truncated at the {MAX_OUTPUT_TOKENS}-token '
                         f'output cap ({used} tokens)')
    return choice['message']['content']


def _parse_answer(body: dict, which: str) -> dict:
    """json.loads with a diagnosis attached when it fails.

    "Unterminated string starting at: line 7 column 3" says nothing about why
    the answer was cut short. Four Hillsborough documents failed that way on
    the first gpt-5-nano retry pass (26 Oct 2026) and one of them parsed fine
    on a re-run, so the cause is intermittent and only the response itself can
    show it: the finish reason, the token counts, and the tail of the text.
    """
    content = _completion_text(body)
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        choice = body['choices'][0]
        usage = body.get('usage') or {}
        raise ValueError(
            f'{which} answer is not JSON ({e}); finish_reason='
            f'{choice.get("finish_reason")!r}, completion_tokens='
            f'{usage.get("completion_tokens")}, {len(content)} chars, '
            f'tail={content[-120:]!r}') from e


def llm_extract(ocr_text: str) -> dict | None:
    body = _openai_post(chat_completion_body(ocr_text, SYSTEM_PROMPT))
    _track_spend(body.get('usage', {}))
    return postprocess_extraction(_parse_answer(body, 'extraction'))


def llm_extract_facility(ocr_text: str) -> dict | None:
    body = _openai_post(chat_completion_body(ocr_text, FACILITY_SYSTEM_PROMPT))
    _track_spend(body.get('usage', {}))
    return postprocess_facility(_parse_answer(body, 'facility'))


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
             facility_confidence, doc_category_evidence,
             ocr_chars, model, extracted_at, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
        ON CONFLICT(cfn) DO UPDATE SET
            county=excluded.county,
            status=excluded.status, doc_category=excluded.doc_category,
            doc_category_evidence=excluded.doc_category_evidence,
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
        d.get('facility_confidence'), d.get('doc_category_evidence'),
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


_DOC_TYPE_CACHE: dict = {}
_DOC_TYPE_LOCK = threading.Lock()


def _doc_type_for(cfn: str) -> str | None:
    """The county's doc type for a CFN, cached — workers call this per document."""
    with _DOC_TYPE_LOCK:
        if cfn in _DOC_TYPE_CACHE:
            return _DOC_TYPE_CACHE[cfn]
    conn = get_conn()
    try:
        row = conn.execute('SELECT doc_type FROM assignments WHERE cfn = ?', (cfn,)).fetchone()
    finally:
        conn.close()
    val = row[0] if row else None
    with _DOC_TYPE_LOCK:
        _DOC_TYPE_CACHE[cfn] = val
    return val


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
        except OpenAIUnavailable as e:
            # Not this document's fault. ABORT tells the loop to stop the run
            # and record nothing, so the document stays pending.
            return (cfn, rec_book, rec_page, doc_county, 'ABORT', None, len(text), str(e))
        except Exception as e:
            return (cfn, rec_book, rec_page, doc_county, 'LLM_ERROR', None, len(text),
                    f'LLM failed: {e}')

        # The OCR text is only in hand HERE — it is not stored — so the
        # collateral check has to happen before this function returns. doc_type
        # comes from the county index rather than the model.
        cat, quote = reclassify_collateral(
            _doc_type_for(cfn), data.get('doc_title'), text, data.get('doc_category'))
        data['doc_category'] = cat
        if quote:
            data['doc_category_evidence'] = quote

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
    consecutive_llm_errors = 0
    started = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(process_one, cfn, rb, rp, c)
                   for cfn, rb, rp, _rec_date, c in docs]
        for fut in futures:
            cfn, rb, rp, dc, status, data, ocr_chars, note = fut.result()
            if status == 'ABORT':
                _stop_run(note, futures, counts)
            if note:
                print(f'  {cfn} ({dc}) {note}', flush=True)

            # A single failed write must never end a run that has hours of work
            # behind it. The realistic cause is lock contention with
            # normalize.py's end-of-run commit, which clears on its own; if it
            # still fails after three tries, skip this document and carry on —
            # it stays unextracted and the next pass picks it up, which is a far
            # better outcome than losing the remaining tens of thousands.
            for attempt in range(3):
                try:
                    save(conn, cfn, rb, rp, status, data, ocr_chars, county=dc)
                    break
                except Exception as e:
                    if attempt == 2:
                        print(f'  {cfn} SAVE FAILED after 3 tries, skipping: {e}',
                              flush=True)
                        status = 'LLM_ERROR'   # counted as a failure, not an OK
                        data = None
                    else:
                        time.sleep(5 * (attempt + 1))

            counts[status] += 1
            if data:
                cat = data.get('doc_category')
                categories[cat] = categories.get(cat, 0) + 1

            # A run of LLM failures with nothing succeeding in between is an
            # outage of some kind, whatever the status code. Stop before it
            # eats the queue; the rows already written are picked up by
            # --retry-errors.
            consecutive_llm_errors = consecutive_llm_errors + 1 if status == 'LLM_ERROR' else 0
            if consecutive_llm_errors >= _MAX_CONSECUTIVE_LLM_ERRORS:
                _stop_run(f'{consecutive_llm_errors} LLM failures in a row — '
                          'OpenAI is not answering usefully', futures, counts)

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


def _stop_run(reason: str, futures: list | None, counts: dict) -> None:
    """Stop the whole run because OpenAI is unavailable, recording nothing more.

    Exit 2 so the cron wrappers log it as a failure. Documents not yet saved
    stay pending and the next run picks them up — which is the point.
    """
    print(f'\n⛔ STOPPING THE RUN: {reason}', flush=True)
    print('   Nothing was recorded for the document that hit this, nor for any '
          'still queued — they stay pending for the next run.', flush=True)
    print(f'   Before stopping: {counts}', flush=True)
    for f in futures or []:
        f.cancel()
    raise SystemExit(2)


def run(limit: int, retry_errors: bool, since: str | None = None, redo: bool = False,
        county: str | None = None, workers: int = 1, doc_types: list[str] | None = None):
    if not OPENAI_KEY:
        raise SystemExit('OPENAI_API_KEY is not set')

    conn = get_conn()
    ensure_schema(conn)
    docs = pending_documents(conn, limit, retry_errors, since=since, redo=redo,
                             county=county, doc_types=doc_types)
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
    consecutive_llm_errors = 0

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
                consecutive_llm_errors = 0
                cat = data.get('doc_category')
                categories[cat] = categories.get(cat, 0) + 1
            except OpenAIUnavailable as e:
                _stop_run(str(e), None, counts)
            except Exception as e:
                print(f'  [{i}] {cfn} LLM failed: {e}')
                save(conn, cfn, rec_book, rec_page, 'LLM_ERROR', ocr_chars=len(text),
                     county=doc_county)
                counts['LLM_ERROR'] += 1
                consecutive_llm_errors += 1
                if consecutive_llm_errors >= _MAX_CONSECUTIVE_LLM_ERRORS:
                    _stop_run(f'{consecutive_llm_errors} LLM failures in a row — '
                              'OpenAI is not answering usefully', None, counts)

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
    p.add_argument('--doc-types', type=str, default=None,
                   help="comma-separated doc_type values to restrict to, exactly as "
                        "stored, e.g. 'ASG,ASGT' (default: all)")
    args = p.parse_args()
    if args.budget is not None:
        BUDGET_USD = args.budget
    run(args.limit, args.retry_errors, since=args.since, redo=args.redo,
        county=args.county.upper() if args.county else None,
        workers=max(1, args.workers),
        doc_types=[t.strip() for t in args.doc_types.split(',') if t.strip()] if args.doc_types else None)
