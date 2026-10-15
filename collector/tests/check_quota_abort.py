"""
Guardrail: an OpenAI outage must STOP an extraction run, not mark documents failed.

What happened on 15 Oct 2026: the account ran out of credits at ~05:50 UTC and
extract_pdfs.py kept going for four hours, writing an LLM_ERROR row for every
document at ~1,100 an hour — 4,773 Hillsborough documents in all. Each row
counted as "read" on the Overview card and in the weekly-email gate, none would
be retried without --retry-errors, and the card blamed the clerk because the
downloads and OCR were fine.

These checks reproduce that with a fake OpenAI and assert:
  1. a 429 insufficient_quota stops the run (exit 2) with NO row written, in
     both the single-worker loop and the thread pool;
  2. a rate-limit 429 is retried and, if it never clears, also stops the run
     with no row written;
  3. a genuine per-document failure (bad JSON back) still becomes LLM_ERROR —
     the outage path must not swallow real document problems.

Run:  collector/.venv/bin/python3 collector/tests/check_quota_abort.py
"""
import json
import os
import sqlite3
import sys
import tempfile

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


class FakeResponse:
    def __init__(self, status: int, body: dict | str, headers: dict | None = None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if isinstance(self._body, str):
            raise ValueError('not json')
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')


QUOTA_429 = FakeResponse(429, {'error': {
    'message': 'You have no credits remaining.', 'type': 'insufficient_quota',
    'code': 'credit_balance_exhausted'}})
RATE_429 = FakeResponse(429, {'error': {
    'message': 'Rate limit reached', 'type': 'rate_limit_exceeded'}}, {'Retry-After': '0'})
GOOD_200 = FakeResponse(200, {
    'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
    'choices': [{'message': {'content': json.dumps({
        'doc_category': 'LOAN_TRANSFER', 'assignor_name': 'A', 'assignee_name': 'B',
        'has_facility_language': False})}}]})
BAD_JSON_200 = FakeResponse(200, {
    'usage': {'prompt_tokens': 1, 'completion_tokens': 1},
    'choices': [{'message': {'content': 'this is not json'}}]})


def fresh_db(n_docs: int) -> str:
    path = os.path.join(tempfile.mkdtemp(prefix='quota_test_'), 'test.db')
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cfn TEXT UNIQUE, raw_cfn TEXT, rec_date TEXT, doc_type TEXT,
            grantor TEXT, grantee TEXT, address TEXT, legal_desc TEXT,
            rec_book TEXT, rec_page TEXT, misc_ref TEXT, raw_json TEXT, county TEXT
        );
    """)
    for i in range(n_docs):
        conn.execute(
            "INSERT INTO assignments (cfn, rec_date, doc_type, rec_book, rec_page, county) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (f'2026R9{i:05d}', '2026-10-01', 'ASSIGNMENT OF MORTGAGE - AMO',
             '35000', str(100 + i), 'MIAMI-DADE'))
    conn.commit()
    conn.close()
    return path


def load_module(db_path: str):
    os.environ['AMO_DB_PATH'] = db_path
    os.environ['OPENAI_API_KEY'] = 'test-key-not-real'
    for mod in ('extract_pdfs', 'database'):
        sys.modules.pop(mod, None)
    sys.path.insert(0, COLLECTOR)
    import extract_pdfs as ep
    ep.fetch_document_text = lambda *a, **k: 'x' * 300   # no clerk, no OCR
    ep.time.sleep = lambda *_a, **_k: None                 # no backoff waits
    return ep


def rows(db_path: str) -> list[tuple]:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(
            'SELECT cfn, status FROM pdf_extractions ORDER BY cfn').fetchall()
    finally:
        conn.close()


def run_with(ep, responses, workers: int, limit: int = 5) -> int | None:
    """Run extraction against a scripted sequence of OpenAI responses.

    Returns the SystemExit code, or None if the run returned normally.
    """
    seq = list(responses)

    def fake_post(*_a, **_k):
        return seq.pop(0) if len(seq) > 1 else seq[0]

    ep.requests.post = fake_post
    try:
        ep.run(limit, False, county='MIAMI-DADE', workers=workers)
    except SystemExit as e:
        return e.code
    return None


def main() -> int:
    print('1. insufficient_quota stops the run with nothing written')
    for workers in (1, 2):
        db = fresh_db(5)
        ep = load_module(db)
        code = run_with(ep, [QUOTA_429], workers)
        check(f'  workers={workers}: exit code 2', code, 2)
        check(f'  workers={workers}: no pdf_extractions rows', rows(db), [])

    print('2. a rate-limit 429 that never clears is retried, then stops the run')
    db = fresh_db(3)
    ep = load_module(db)
    calls = {'n': 0}
    orig_post = ep.requests.post

    def counting_post(*a, **k):
        calls['n'] += 1
        return RATE_429
    ep.requests.post = counting_post
    try:
        ep.run(3, False, county='MIAMI-DADE', workers=1)
        code = None
    except SystemExit as e:
        code = e.code
    check('  exit code 2', code, 2)
    check('  retried before giving up', calls['n'] > 1, True)
    check('  no pdf_extractions rows', rows(db), [])
    ep.requests.post = orig_post

    print('3. a per-document failure is still LLM_ERROR, and the run continues')
    db = fresh_db(2)
    ep = load_module(db)
    # doc 1: bad JSON on the first call → LLM_ERROR; doc 2: good → OK
    code = run_with(ep, [BAD_JSON_200, GOOD_200, GOOD_200, GOOD_200], workers=1, limit=2)
    check('  run completes normally', code, None)
    statuses = sorted(s for _, s in rows(db))
    check('  one LLM_ERROR and one OK', statuses, ['LLM_ERROR', 'OK'])

    print('4. the happy path still works end to end')
    db = fresh_db(2)
    ep = load_module(db)
    code = run_with(ep, [GOOD_200], workers=2, limit=2)
    check('  run completes normally', code, None)
    check('  both documents OK', [s for _, s in rows(db)], ['OK', 'OK'])

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
