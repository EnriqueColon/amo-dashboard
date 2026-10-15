"""
Guardrail: a single day over the portal's 500-row cap is collected COMPLETELY.

The Miami-Dade portal returns at most 500 index rows per search, with no total
and no paging, and the collector cannot split a date range below one day. For
three years a busy day was stored truncated and logged CAPPED — 23 such days,
plus three only a fresh-session re-check exposed — and nothing read that log.

collect_day_partitioned() gets past the cap by searching the day once per
first-party name prefix and taking the union. These checks drive it with a
fake portal (no browser, no network) that behaves like the real one — rows per
party, a hard 500-row ceiling, prefix matching on the first party — and assert:

  1. a day of 700 documents whose single-letter 'B' partition is itself over
     the cap is recovered in full, via two-letter sub-partitions, and the day
     is logged OK;
  2. a day where a TWO-letter partition is still over the cap keeps what it
     can and is logged CAPPED, not OK, so it stays visible and retry-eligible;
  3. a day that is not capped at all takes the ordinary path, untouched.

Run:  collector/.venv/bin/python3 collector/tests/check_cap_partition.py
"""
import asyncio
import os
import random
import sqlite3
import sys
import tempfile
from datetime import date

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures: list[str] = []

def shim_playwright() -> None:
    """collect_live imports playwright at import time; these checks never use it."""
    try:
        import playwright.async_api  # noqa: F401
    except ImportError:
        import types
        pw = types.ModuleType('playwright')
        api = types.ModuleType('playwright.async_api')
        api.async_playwright = None
        api.Page = object
        pw.async_api = api
        sys.modules['playwright'] = pw
        sys.modules['playwright.async_api'] = api



def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


def fresh_db() -> str:
    path = os.path.join(tempfile.mkdtemp(prefix='cap_test_'), 'test.db')
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cfn TEXT UNIQUE, raw_cfn TEXT, rec_date TEXT, doc_type TEXT,
            grantor TEXT, grantee TEXT, address TEXT, legal_desc TEXT,
            rec_book TEXT, rec_page TEXT, misc_ref TEXT, raw_json TEXT, county TEXT);
        CREATE TABLE collection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_from TEXT, date_to TEXT, records_found INTEGER, status TEXT,
            collected_at TEXT DEFAULT (datetime('now')), doc_type TEXT, county TEXT);
    """)
    conn.commit()
    conn.close()
    return path


class FakePortal:
    """Rows per party, capped at 500, prefix-filtered on the FIRST party."""

    CAP = 500

    def __init__(self, docs: list[tuple[str, str, str]]):
        # (cfn, first_party, second_party): one row per document here. The
        # real portal also emits a row per additional party, which only makes
        # buckets larger; what these checks exercise is the cap arithmetic and
        # the recursion, and one row per document keeps that exact.
        self.docs = docs
        self.searches: list[str | None] = []

    async def do_search(self, page, doc_type, df, dt, name_prefix=None):
        self.searches.append(name_prefix)
        rows = []
        for cfn, first, second in self.docs:
            if name_prefix and not first.startswith(name_prefix):
                continue
            rows.append({'cfn': cfn, 'raw_cfn': cfn, 'rec_date': df.isoformat(),
                         'doc_type': doc_type, 'grantor': first, 'grantee': second,
                         'address': '', 'legal_desc': '', 'rec_book': '1',
                         'rec_page': '1', 'misc_ref': ''})
        if not rows:
            return [], 'EMPTY'
        if len(rows) >= self.CAP:
            return rows[:self.CAP], 'CAPPED'
        return rows, 'OK'


def make_docs(spec: dict[str, int], seed: int = 1) -> list[tuple[str, str, str]]:
    """spec: {first-party prefix: number of documents}."""
    rnd = random.Random(seed)
    docs, n = [], 0
    for prefix, count in spec.items():
        for _ in range(count):
            n += 1
            first = prefix + ''.join(rnd.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ') for _ in range(5))
            docs.append((f'2026R{n:06d}', first, 'ZZZ LENDER LLC'))
    return docs


def run_day(docs, db_path: str):
    os.environ['AMO_DB_PATH'] = db_path
    for mod in ('collect_live', 'database'):
        sys.modules.pop(mod, None)
    sys.path.insert(0, COLLECTOR)
    shim_playwright()
    import collect_live as cl
    portal = FakePortal(docs)
    cl.do_search = portal.do_search
    day = date(2026, 2, 3)
    inserted = asyncio.run(cl.collect_range(None, 'ASSIGNMENT OF MORTGAGE - AMO', day, day))
    conn = sqlite3.connect(db_path)
    try:
        held = conn.execute('SELECT COUNT(*) FROM assignments').fetchone()[0]
        status = conn.execute(
            "SELECT status FROM collection_log ORDER BY id DESC LIMIT 1").fetchone()[0]
    finally:
        conn.close()
    return inserted, held, status, portal


def main() -> int:
    print('1. a day of 700 documents, with the B partition itself over the cap')
    # 'B' alone holds 520 documents → over the cap at one letter; each
    # two-letter bucket is under it, so the day is fully recoverable.
    docs = make_docs({'BA': 200, 'BB': 200, 'BC': 120, 'C': 60, 'M': 60, 'W': 60})
    inserted, held, status, portal = run_day(docs, fresh_db())
    check('  every document recovered', held, 700)
    check('  inserted count matches', inserted, 700)
    check('  day logged OK', status, 'OK')
    check('  recursed into two-letter B partitions', 'BA' in portal.searches and 'BB' in portal.searches, True)
    check('  did not recurse where one letter sufficed', 'CA' in portal.searches, False)

    print('2. a partition still over the cap at the deepest prefix is logged CAPPED, not OK')
    # 520 documents whose first party shares the three-letter prefix BAA: the
    # recursion bottoms out at MAX_PREFIX_LEN with the bucket still capped.
    docs = make_docs({'BAA': 520, 'C': 50})
    inserted, held, status, portal = run_day(docs, fresh_db())
    check('  kept what the capped partition returned (500 of 520) plus the rest', held, 550)
    check('  day logged CAPPED so it stays retry-eligible', status, 'CAPPED')
    check('  recursed all the way to three letters', 'BAA' in portal.searches, True)

    print('3. an ordinary day is untouched by any of this')
    docs = make_docs({'A': 40, 'B': 40, 'C': 40})
    inserted, held, status, portal = run_day(docs, fresh_db())
    check('  all documents held', held, 120)
    check('  logged OK', status, 'OK')
    check('  exactly one search, no partitioning', portal.searches, [None])

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
