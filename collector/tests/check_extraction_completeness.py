"""
Verify that `status='OK'` in pdf_extractions actually means extracted.
---------------------------------------------------------------------
This guardrail exists because it wasn't there on 2026-07-22, and its absence
cost 50,042 Miami-Dade documents three weeks of silent non-extraction.

Two jobs write to `pdf_extractions` and they mean different things by a row:

    extract_pdfs.py            main fields + raw_json   (reads the document)
    batch_extract_facility.py  facility_* only          (facility verdict only)

The facility path writes `status='OK'` with none of the main fields and no
raw_json. The main extractor used to select its work with `px.cfn IS NULL`, so
every document the facility backfill reached first was marked done and never
read. Nothing anywhere reported a problem: no error status, no failed job, no
log line. The only symptom was empty columns in the UI.

The invariant that makes it visible: **a row claiming OK must carry raw_json.**
The main extractor always stores the model response; the facility path never
does. Verified on production at the time of the fix — 22,115 rows with raw_json
all had OCR text and a doc_category, 50,042 without had neither, zero overlap.

Checks, all against the live DB:
  1. no `status='OK'` row is missing raw_json          (the actual bug)
  2. no `status='OK'` row has zero OCR characters      (independent symptom)
  3. every row with raw_json has a doc_category        (raw_json really is the
                                                        completeness marker)

  AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
      collector/tests/check_extraction_completeness.py

Exits non-zero on any failure, so it can gate a deploy or run from cron.

NOTE: while the 15 Aug 2026 repair backfill is still running this will report
check 1 as failing with a shrinking count — that is the repair in progress, not
a new fault. It should reach zero when the backfill completes.
"""
import os
import sqlite3
import sys

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f'FAIL  {msg}')


def ok(msg: str) -> None:
    print(f'ok    {msg}')


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f'database not found: {DB_PATH}')
        return 2

    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA busy_timeout=30000')

    # ── 1. The bug itself ────────────────────────────────────────────────────
    rows = conn.execute("""
        SELECT COALESCE(a.county, 'MIAMI-DADE') AS scope, COUNT(*) AS n
        FROM pdf_extractions p
        LEFT JOIN assignments a ON a.cfn = p.cfn
        WHERE p.status = 'OK' AND p.raw_json IS NULL
        GROUP BY scope ORDER BY n DESC
    """).fetchall()
    total = sum(n for _, n in rows)
    if total:
        breakdown = ', '.join(f'{c}={n:,}' for c, n in rows)
        fail(f'{total:,} rows claim status=OK but have no raw_json — the main '
             f'extraction never ran on them ({breakdown}). '
             f'These are invisible to any selector keyed on row existence.')
    else:
        ok('every status=OK row carries raw_json')

    # ── 2. Independent symptom ───────────────────────────────────────────────
    # Kept separate from check 1 on purpose: ocr_chars=0 is what the failure
    # LOOKS like, raw_json IS NULL is what it IS. Having both makes the next
    # occurrence diagnosable rather than merely detectable.
    n = conn.execute("""
        SELECT COUNT(*) FROM pdf_extractions
        WHERE status = 'OK' AND COALESCE(ocr_chars, 0) = 0
    """).fetchone()[0]
    if n:
        fail(f'{n:,} rows claim status=OK with zero OCR characters — either the '
             f'document was never read, or a writer is not recording ocr_chars')
    else:
        ok('every status=OK row recorded OCR characters')

    # ── 3. raw_json really is the completeness marker ────────────────────────
    n = conn.execute("""
        SELECT COUNT(*) FROM pdf_extractions
        WHERE raw_json IS NOT NULL
          AND (doc_category IS NULL OR doc_category = '')
    """).fetchone()[0]
    if n:
        fail(f'{n:,} rows have raw_json but no doc_category — raw_json can no '
             f'longer be trusted as the "main extraction ran" marker, which is '
             f'what pending_documents() selects on')
    else:
        ok('raw_json implies doc_category — safe to use as the completeness marker')

    total_rows = conn.execute('SELECT COUNT(*) FROM pdf_extractions').fetchone()[0]
    notes.append(f'{total_rows:,} extraction rows checked')

    conn.close()
    for note in notes:
        print(f'      {note}')
    if failures:
        print(f'\n{len(failures)} check(s) failed')
        return 1
    print('\nall checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
