"""
Hillsborough County Official Records collector — public feed + public API
-------------------------------------------------------------------------
Hillsborough needs no browser automation, no login and no captcha. Two public
sources, both read-only:

  Daily index feed (HTTPS directory listing)
      https://publicrec.hillsclerk.com/OfficialRecords/DailyIndexes/
      D<YYYYMMDD><NN>id.29   documents recorded (or corrected) that day
      P<YYYYMMDD><NN>id.29   their parties
      M<YYYYMMDD><NN>d.29    local doc code → FACC statewide code
      Retention is about two months; the county publishes ~6 days behind.
      Layout: readme.txt in the same directory.

  Search API behind the public portal (publicaccess.hillsclerk.com)
      POST /Public/ORIUtilities/DocumentSearch/api/Search
      {"DocType": ["(ASG) ASSIGNMENT"], "RecordDateBegin": "MM/DD/YYYY",
       "RecordDateEnd": "MM/DD/YYYY"}   or   {"Instrument": [2026384158]}
      Reaches back to 1964, so it is the history source.

THE TRAP: the API caps a search at 6,000 rows, and a search over the cap does
not return 6,000 rows — it returns ZERO, with "Truncated": 6000. Read naively
that is an empty quarter. fetch_window() treats Truncated as "split the range"
and refuses to record a window as collected while it is set.

Record layouts (1-based):

    D  1 action  2 county(29)  3 instrument  4 doc code  5 description
       6 legal  7 book type  8 book  9 page  10 filler  11 pages
       12 MM/DD/YYYY  13 HH:MM  14 consideration
    P  1 action  2 county  3 instrument  4 sequence  5 FRM|TO  6 name

The action field reads e.g. DDA / DPA: the SECOND character is the record type
(D document, P party) and the last is add/delete. A trailing 'D' is a delete;
those are logged, not applied. A day's file also re-sends older documents that
were corrected that day, so rec_date is not always the file's date.

FRM is the direct party (grantor/assignor) and TO the reverse party
(grantee/assignee), matching the Miami-Dade and Broward column shape. Like
Broward, a side routinely lists several names and the homeowner usually appears
among the TO parties; the document read in extract_pdfs.py decides who the real
assignor and assignee are, exactly as it already does for the other counties.
The index truncates names at 40 characters (DEUTSCHE BANK NATIONAL TRUST
COMPANY TRU), another reason the document text is the authority.

The API returns each side's parties ALPHABETICALLY, the feed in the county's
own sequence. So the feed is preferred wherever both cover a day, and grantor /
grantee taken from the API are "a party on that side", not "the first party".

Instrument numbers are YYYY + 6 digits, pure numeric — disjoint from Broward's
9-digit sequence and from Miami-Dade's 'R' CFNs, which is what keeps the global
UNIQUE(cfn) on `assignments` safe. HILLSBOROUGH_CFN_RE enforces it here and
collector/tests/check_county_isolation.py asserts it on the database.

Usage:
    python hillsborough_collect.py --history --start 2023-01-01 --end 2026-08-31
    python hillsborough_collect.py --daily
    python hillsborough_collect.py --list
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests

sys.path.insert(0, os.path.dirname(__file__))
from database import get_conn, init_db, log_collection  # noqa: E402

COUNTY = 'HILLSBOROUGH'

FEED_BASE = os.environ.get(
    'HILLSBOROUGH_FEED_URL',
    'https://publicrec.hillsclerk.com/OfficialRecords/DailyIndexes/')
API_BASE = os.environ.get(
    'HILLSBOROUGH_API_URL', 'https://publicaccess.hillsclerk.com')
SEARCH_URL = f'{API_BASE}/Public/ORIUtilities/DocumentSearch/api/Search'

# Local code → the label the search API expects. ASGT maps to ASG in the
# county's own FACC table; FIN is a UCC financing statement and, like
# Miami-Dade's FST, is collected for its lending relationships but kept out of
# the assignment tables by normalize.NON_ASSIGNMENT_DOC_TYPES.
DOC_TYPES = {
    'ASG': '(ASG) ASSIGNMENT',
    'ASGT': '(ASGT) ASSIGNMENT/TAXES',
    # Added 15 Oct 2026. The county's code table (the daily M-file) lists three
    # assignment codes, and this one was never collected: ~23 a quarter, ~350
    # since 2023. Miami-Dade's equivalent (AIT) returns nothing; Hillsborough's
    # does not. Generic like ASG — reaches the analytics only once read.
    'ASINT': '(ASINT) ASSIGNMENT OF INTEREST',
    'FIN': '(FIN) FINANCING STATEMENT',
}

HILLSBOROUGH_CFN_RE = re.compile(r'^20\d{8}$')

API_ROW_CAP = 6000
API_DELAY = 0.5          # seconds between API calls — a public service, be polite
HTTP_TIMEOUT = 120

FEED_FILE_RE = re.compile(r'^([DPM])(\d{8})(\d{2})i?d\.29$')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-8s %(message)s',
    datefmt='%H:%M:%S',
    handlers=[logging.StreamHandler(),
              logging.FileHandler(os.path.join(os.path.dirname(__file__),
                                               'hillsborough_collector.log'))],
)
log = logging.getLogger('hillsborough')

session = requests.Session()
session.headers['User-Agent'] = 'amo-dashboard collector (official records research)'


# ── Search API ───────────────────────────────────────────────────────────────

def api_search(payload: dict) -> dict:
    resp = session.post(SEARCH_URL, json=payload, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    time.sleep(API_DELAY)
    if data.get('ErrorMessage') == 'No results found':
        data['ResultList'] = []
    elif data.get('ErrorMessage'):
        raise RuntimeError(f'search API error: {data["ErrorMessage"]}')
    return data


def lookup_instruments(instruments: list[int]) -> list[dict]:
    """Rows for specific instrument numbers (used by extract_pdfs for images)."""
    return api_search({'Instrument': instruments}).get('ResultList') or []


def mdy(d: date) -> str:
    return d.strftime('%m/%d/%Y')


def fetch_window(code: str, start: date, end: date) -> list[dict]:
    """Every row of one doc type recorded in [start, end], splitting on the cap."""
    data = api_search({'DocType': [DOC_TYPES[code]],
                       'RecordDateBegin': mdy(start), 'RecordDateEnd': mdy(end)})
    rows = data.get('ResultList') or []
    truncated = data.get('Truncated')
    if truncated:
        if start == end:
            # One day over 6,000 of a single type has never happened (the
            # busiest quarter on record is ~2,800); refuse rather than guess.
            raise RuntimeError(f'{code} {start}: one day exceeds the {API_ROW_CAP:,}-row cap')
        mid = start + (end - start) // 2
        log.info(f'  {code} {start} → {end} over the cap, splitting at {mid}')
        return fetch_window(code, start, mid) + fetch_window(code, mid + timedelta(days=1), end)
    return rows


def api_row_to_record(row: dict) -> dict | None:
    instrument = str(row.get('Instrument') or '').strip()
    if not HILLSBOROUGH_CFN_RE.match(instrument):
        log.warning(f'  skipping unexpected instrument {instrument!r}')
        return None
    m = re.match(r'^\(([A-Z0-9]+)\)', row.get('DocType') or '')
    code = m.group(1) if m else (row.get('DocType') or '').strip()
    # RecordDate is the local recording timestamp written as if it were UTC.
    recorded = datetime.fromtimestamp(row['RecordDate'], tz=timezone.utc)
    grantors = [n.strip().upper() for n in row.get('PartiesOne') or [] if n and n.strip()]
    grantees = [n.strip().upper() for n in row.get('PartiesTwo') or [] if n and n.strip()]
    return {
        'cfn': instrument,
        'rec_date': recorded.strftime('%Y-%m-%d'),
        'doc_type': code,
        'grantors': grantors,
        'grantees': grantees,
        'legal_desc': (row.get('Legal') or '').strip(),
        'rec_book': (row.get('BookNum') or '') or '',
        'rec_page': (row.get('PageNum') or '') or '',
        'book_type': row.get('BookType') or '',
        'page_count': row.get('PageCount'),
        'consideration': row.get('SalesPrice'),
        'rec_time': recorded.strftime('%H:%M'),
        'source': 'hillsborough_api',
    }


# ── Daily feed ───────────────────────────────────────────────────────────────

def list_feed() -> dict[str, dict[str, str]]:
    """{recording date YYYY-MM-DD: {'D': filename, 'P': filename}} on the server."""
    resp = session.get(FEED_BASE, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    out: dict[str, dict[str, str]] = {}
    for name in re.findall(r'HREF="[^"]*/([^"/]+)"', resp.text, flags=re.I):
        m = FEED_FILE_RE.match(name)
        if not m:
            continue
        kind, ymd, seq = m.groups()
        if kind not in ('D', 'P'):
            continue
        day = f'{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}'
        # More than one export a day is possible ("normally 01"); keep the last.
        slot = out.setdefault(day, {})
        if name > slot.get(kind, ''):
            slot[kind] = name
    return out


def read_feed_file(name: str) -> str:
    resp = session.get(FEED_BASE + name, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.content.decode('cp1252', errors='replace')


def parse_feed_docs(text: str, codes: set[str]) -> tuple[dict[str, dict], int]:
    docs: dict[str, dict] = {}
    deletes = 0
    for line in text.splitlines():
        f = line.rstrip('\r\n').split('|')
        if len(f) < 13 or f[0][1:2] != 'D':
            continue
        if f[0].endswith('D'):
            deletes += 1
            continue
        code = f[3].strip()
        if code not in codes:
            continue
        instrument = f[2].strip()
        if not HILLSBOROUGH_CFN_RE.match(instrument):
            log.warning(f'  skipping unexpected instrument {instrument!r}')
            continue
        try:
            rec_date = datetime.strptime(f[11].strip(), '%m/%d/%Y').strftime('%Y-%m-%d')
        except ValueError:
            continue
        docs[instrument] = {
            'cfn': instrument,
            'rec_date': rec_date,
            'doc_type': code,
            'legal_desc': f[5].strip(),
            'book_type': f[6].strip(),
            'rec_book': f[7].strip(),
            'rec_page': f[8].strip(),
            'page_count': f[10].strip(),
            'rec_time': f[12].strip(),
            'consideration': f[13].strip() if len(f) > 13 else '',
            'source': 'hillsborough_feed',
        }
    return docs, deletes


def parse_feed_parties(text: str, wanted: set[str]) -> dict[str, dict[str, list]]:
    staged: dict[str, dict[str, list]] = {}
    for line in text.splitlines():
        f = line.rstrip('\r\n').split('|')
        if len(f) < 6 or f[0][1:2] != 'P' or f[0].endswith('D'):
            continue
        instrument = f[2].strip()
        if instrument not in wanted:
            continue
        name = f[5].strip().upper()
        if not name:
            continue
        try:
            seq = int(f[3])
        except ValueError:
            seq = 0
        side = {'FRM': 'grantors', 'TO': 'grantees'}.get(f[4].strip().upper())
        if side:
            staged.setdefault(instrument, {'grantors': [], 'grantees': []})[side].append((seq, name))
    return {
        k: {side: [n for _, n in sorted(v[side])] for side in ('grantors', 'grantees')}
        for k, v in staged.items()
    }


# ── Insert ───────────────────────────────────────────────────────────────────

def insert_records(records: list[dict]) -> tuple[int, int]:
    """Insert rows, refusing any CFN already held by another county.

    Returns (inserted, collisions). INSERT OR IGNORE alone would hide a
    cross-county key collision as an ordinary duplicate — see broward_collect.

    A feed row for a document already collected replaces its index fields: the
    feed carries the county's corrections and its own party order, where an API
    row's parties are alphabetical.
    """
    if not records:
        return 0, 0
    conn = get_conn()
    inserted = collisions = 0
    try:
        for r in records:
            existing = conn.execute(
                'SELECT county FROM assignments WHERE cfn = ?', (r['cfn'],)
            ).fetchone()
            grantors, grantees = r.get('grantors') or [], r.get('grantees') or []
            raw = {k: r.get(k) for k in ('book_type', 'page_count', 'consideration',
                                         'rec_time', 'source')}
            raw.update({'grantors': grantors, 'grantees': grantees})
            if existing is not None:
                if (existing['county'] or 'MIAMI-DADE') != COUNTY:
                    collisions += 1
                    log.error(f'  KEY COLLISION: CFN {r["cfn"]} already exists under '
                              f'county {existing["county"]!r} — refusing to overwrite')
                elif r.get('source') == 'hillsborough_feed' and (grantors or grantees):
                    conn.execute(
                        'UPDATE assignments SET rec_date = ?, doc_type = ?, grantor = ?, '
                        'grantee = ?, legal_desc = ?, raw_json = ? WHERE cfn = ?',
                        (r['rec_date'], r['doc_type'], grantors[0] if grantors else None,
                         grantees[0] if grantees else None, r.get('legal_desc', ''),
                         json.dumps(raw), r['cfn']))
                continue
            conn.execute(
                """
                INSERT INTO assignments
                    (cfn, raw_cfn, rec_date, doc_type, grantor, grantee,
                     address, legal_desc, rec_book, rec_page, misc_ref,
                     raw_json, county)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (r['cfn'], r['cfn'], r['rec_date'], r['doc_type'],
                 grantors[0] if grantors else None,
                 grantees[0] if grantees else None,
                 '',                      # the index carries no street address
                 r.get('legal_desc', ''),
                 r.get('rec_book', ''), r.get('rec_page', ''), '',
                 json.dumps(raw), COUNTY),
            )
            inserted += 1
        conn.commit()
    finally:
        conn.close()
    return inserted, collisions


def window_done(label: str) -> bool:
    conn = get_conn()
    try:
        return conn.execute(
            "SELECT 1 FROM collection_log WHERE doc_type = ? AND status = 'OK' "
            "AND county = ? LIMIT 1", (label, COUNTY)).fetchone() is not None
    finally:
        conn.close()


# ── Modes ────────────────────────────────────────────────────────────────────

def month_windows(start: date, end: date):
    cur = start
    while cur <= end:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        yield cur, min(nxt - timedelta(days=1), end)
        cur = nxt


def run_history(codes: set[str], start: date, end: date, force: bool) -> int:
    # A window is only marked done once it is old enough that the county will
    # not still be verifying documents into it.
    settled_before = date.today() - timedelta(days=30)
    total = 0
    for code in sorted(codes):
        for w_start, w_end in month_windows(start, end):
            label = f'{COUNTY}:{code}:{w_start}..{w_end}'
            if not force and window_done(label):
                log.info(f'  {label} already collected — skipping')
                continue
            rows = [r for r in (api_row_to_record(x) for x in fetch_window(code, w_start, w_end)) if r]
            inserted, collisions = insert_records(rows)
            total += inserted
            settled = w_end < settled_before
            status = 'ERROR' if collisions else ('OK' if settled else 'PARTIAL')
            log.info(f'  {label}: {len(rows):,} row(s), {inserted:,} new'
                     + (f', {collisions} COLLISION(S)' if collisions else '')
                     + ('' if settled else ' (recent — will be re-read next run)'))
            log_collection(w_start.isoformat(), w_end.isoformat(), len(rows), status,
                           label, county=COUNTY)
    return total


def run_daily(codes: set[str], start: str | None, end: str | None) -> int:
    feed = list_feed()
    days = sorted(d for d, files in feed.items() if 'D' in files and 'P' in files)
    if not days:
        log.warning('  no complete D/P file pairs on the feed')
        return 0
    log.info(f'  {len(days)} day(s) on the feed: {days[0]} → {days[-1]}')
    total = 0
    for day in days:
        if (start and day < start) or (end and day > end):
            continue
        files = feed[day]
        docs, deletes = parse_feed_docs(read_feed_file(files['D']), codes)
        parties = parse_feed_parties(read_feed_file(files['P']), set(docs)) if docs else {}
        rows = [{**d, **parties.get(k, {'grantors': [], 'grantees': []})} for k, d in docs.items()]
        inserted, collisions = insert_records(rows)
        total += inserted
        log.info(f'  {day}: {len(rows):,} matching, {inserted:,} new'
                 + (f', {deletes} delete record(s) ignored' if deletes else '')
                 + (f', {collisions} COLLISION(S)' if collisions else ''))
        log_collection(day, day, len(rows), 'ERROR' if collisions else 'OK',
                       f'{COUNTY}:feed:{files["D"]}', county=COUNTY)
    return total


def ensure_county_column() -> None:
    conn = get_conn()
    try:
        cols = [r[1] for r in conn.execute('PRAGMA table_info(assignments)')]
    finally:
        conn.close()
    if 'county' not in cols:
        log.error('assignments.county is missing — run collector/migrate_add_county.py first')
        raise SystemExit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--history', action='store_true',
                    help='collect --start..--end from the search API, month by month')
    ap.add_argument('--daily', action='store_true',
                    help='ingest every day currently on the daily feed')
    ap.add_argument('--list', action='store_true', help='show what is on the feed and exit')
    ap.add_argument('--start', help='YYYY-MM-DD (history: required; daily: optional filter)')
    ap.add_argument('--end', help='YYYY-MM-DD (default: today)')
    ap.add_argument('--doc-types', default=None,
                    help=f'comma-separated codes (default: {",".join(DOC_TYPES)})')
    ap.add_argument('--force', action='store_true',
                    help='re-read history windows already logged as collected')
    args = ap.parse_args()

    if not (args.history or args.daily or args.list):
        ap.error('nothing to do — pass --history, --daily or --list')
    codes = ({c.strip().upper() for c in args.doc_types.split(',')}
             if args.doc_types else set(DOC_TYPES))
    unknown = codes - set(DOC_TYPES)
    if unknown:
        ap.error(f'unknown doc type(s): {", ".join(sorted(unknown))}')

    if args.list:
        for day, files in sorted(list_feed().items()):
            log.info(f'  {day}  {files.get("D", "-"):<20} {files.get("P", "-")}')
        return 0

    init_db()
    ensure_county_column()
    total = 0
    if args.history:
        if not args.start:
            ap.error('--history needs --start')
        end = date.fromisoformat(args.end) if args.end else date.today()
        total += run_history(codes, date.fromisoformat(args.start), end, args.force)
    if args.daily:
        total += run_daily(codes, args.start, args.end)
    log.info(f'✅ Hillsborough collection complete — {total:,} new row(s) inserted')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
