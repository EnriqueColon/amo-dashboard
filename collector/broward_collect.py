"""
Broward County Official Records collector — SFTP bulk-file approach
-------------------------------------------------------------------
Broward publishes its recording index as flat files on a public SFTP server, so
unlike Miami-Dade there is NO browser automation, NO reCAPTCHA and NO login
here. This module only reads those files; it never touches the web portal.

    Host: BCFTP.Broward.org:22   User/pass: crpublic / crpublic
    (published by Broward RTT at broward.org → Records → Download Index Files)

Two sources, deliberately handled by one parser because the record layout is
identical between them:

  OR_Yearly_Exports/CY<YYYY>doc-rec.txt   full calendar year, 1978 → last
                                          completed year. Index ONLY, no images.
  Official_Records_Download/<MM-DD-YYYY>doc-ver.txt
                                          one business day, rolling ~10-day
                                          retention. Accompanied by an img.zip
                                          of that day's document images.

Record layout (pipe-delimited, CRLF line endings, BOM on the yearly files) —
reverse-engineered from real files because the county's published layout PDF
404s. Field numbers are 1-based:

    1  instrument number        8  legacy page
    2  rec date YYYYMMDD        9  book type ('O' = Official Records)
    3  rec date MM/DD/YYYY     11  folio / parcel id
    4  rec time HHMMSS         12  doc stamps
    5  doc type code           14  page count
    6  consideration amount    18  'E' when e-recorded
    7  legacy book             19  case number

The companion name file (nme-rec / nme-ver) is one row PER PARTY:

    <instrument>|<name>|<D|R>|<sequence>|

'D' is the direct party and 'R' the reverse party. Verified against the portal's
own column headers: for instrument 119979096 the grid shows First Direct Name =
FUND-EX SOLUTIONS GROUP LLC and First Indirect Name = PINNACLE BANK, i.e. the
assignor and the assignee. So D → grantor and R → grantee, matching the
Miami-Dade collector's columns exactly.

Broward folds every kind of assignment into the single doc type 'AST', where
Miami-Dade splits them across AMO/ASG/AIT. That difference does not matter
downstream: extract_pdfs.py classifies the actual document and normalize.py
keeps only true loan transfers, exactly as it already does for Miami-Dade's
generic buckets.

Usage:
    python broward_collect.py --year 2025
    python broward_collect.py --year 2023 --start 2023-01-01
    python broward_collect.py --daily
    python broward_collect.py --list          # show what's on the server
"""

import argparse
import io
import json
import logging
import os
import re
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(__file__))
from database import get_conn, init_db, log_collection  # noqa: E402

try:
    import paramiko
except ImportError:  # pragma: no cover - dependency guard
    print('ERROR: paramiko is required.  collector/.venv/bin/pip install paramiko',
          file=sys.stderr)
    raise

COUNTY = 'BROWARD'

FTP_HOST = os.environ.get('BROWARD_FTP_HOST', 'BCFTP.Broward.org')
FTP_PORT = int(os.environ.get('BROWARD_FTP_PORT', '22'))
FTP_USER = os.environ.get('BROWARD_FTP_USER', 'crpublic')
FTP_PASS = os.environ.get('BROWARD_FTP_PASS', 'crpublic')

YEARLY_DIR = 'OR_Yearly_Exports'
DAILY_DIR = 'Official_Records_Download'

# 'AST' is Broward's only assignment code (verified against all 65 codes present
# in CY2025). Kept as a set so mortgages/UCCs can be added later without
# touching the parser.
DOC_TYPES = {'AST'}

# Miami-Dade CFNs always contain 'R' (2026R521735); Broward instrument numbers
# are always pure digits. init_db()'s UNIQUE(cfn) therefore cannot collide
# across counties — see collector/migrate_add_county.py for the full argument.
BROWARD_CFN_RE = re.compile(r'^\d+$')

DAILY_FILE_RE = re.compile(r'^(\d{2})-(\d{2})-(\d{4})doc-ver\.txt$')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-8s %(message)s',
    datefmt='%H:%M:%S',
    handlers=[logging.StreamHandler(),
              logging.FileHandler(os.path.join(os.path.dirname(__file__),
                                               'broward_collector.log'))],
)
log = logging.getLogger('broward')


# ── SFTP ─────────────────────────────────────────────────────────────────────

def connect():
    """Open an SFTP session against the county's public read-only account."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(FTP_HOST, port=FTP_PORT, username=FTP_USER,
                   password=FTP_PASS, look_for_keys=False, allow_agent=False,
                   timeout=45)
    return client, client.open_sftp()


def read_remote_text(sftp, path: str) -> str:
    """Read a remote file fully into memory and decode it.

    The yearly files top out around 65MB, which is far cheaper to hold in RAM
    than to stream twice — the name file has to be indexed by instrument before
    it is usable anyway.
    """
    buf = io.BytesIO()
    sftp.getfo(path, buf)
    raw = buf.getvalue()
    # Windows-1252: the index carries the occasional smart quote / accented name
    # that would explode a strict utf-8 decode mid-file.
    return raw.decode('cp1252', errors='replace')


# ── Parsing ──────────────────────────────────────────────────────────────────

def parse_doc_records(text: str, doc_types: set[str],
                      start: str | None, end: str | None) -> dict[str, dict]:
    """Parse a doc-rec/doc-ver file, keeping only the wanted doc types + dates.

    Returns {instrument: record}.
    """
    out: dict[str, dict] = {}
    for line in text.splitlines():
        line = line.strip('\r\n﻿').strip()
        if not line:
            continue
        f = line.split('|')
        if len(f) < 14:
            continue

        doc_type = f[4].strip()
        if doc_types and doc_type not in doc_types:
            continue

        instrument = f[0].strip().lstrip('﻿')
        if not BROWARD_CFN_RE.match(instrument):
            log.warning(f'  skipping non-numeric instrument {instrument!r}')
            continue

        rec_date = parse_date(f[1].strip(), f[2].strip())
        if not rec_date:
            continue
        if start and rec_date < start:
            continue
        if end and rec_date > end:
            continue

        out[instrument] = {
            'cfn': instrument,
            'raw_cfn': instrument,
            'rec_date': rec_date,
            'doc_type': doc_type,
            'rec_book': f[6].strip(),
            'rec_page': f[7].strip(),
            'book_type': f[8].strip(),
            'folio_parcel': f[10].strip() if len(f) > 10 else '',
            'consideration': f[5].strip(),
            'page_count': f[13].strip(),
            'case_number': f[18].strip() if len(f) > 18 else '',
            'erecorded': (f[17].strip() if len(f) > 17 else '') == 'E',
            'rec_time': f[3].strip(),
        }
    return out


def parse_date(ymd: str, mdy: str) -> str | None:
    """Broward writes the date twice; prefer the unambiguous YYYYMMDD form."""
    if len(ymd) == 8 and ymd.isdigit():
        try:
            return datetime.strptime(ymd, '%Y%m%d').strftime('%Y-%m-%d')
        except ValueError:
            pass
    try:
        return datetime.strptime(mdy, '%m/%d/%Y').strftime('%Y-%m-%d')
    except ValueError:
        return None


def parse_name_records(text: str, wanted: set[str]) -> dict[str, dict]:
    """Index the name file by instrument, keeping only instruments we collected.

    Returns {instrument: {'grantors': [...], 'grantees': [...]}} with each list
    ordered by the county's own sequence number.
    """
    staged: dict[str, dict[str, list]] = {}
    for line in text.splitlines():
        line = line.strip('\r\n﻿').strip()
        if not line:
            continue
        f = line.split('|')
        if len(f) < 3:
            continue

        instrument = f[0].strip().lstrip('﻿')
        if instrument not in wanted:
            continue

        name = f[1].strip().upper()
        if not name:
            continue
        role = f[2].strip().upper()
        try:
            seq = int(f[3]) if len(f) > 3 and f[3].strip() else 0
        except ValueError:
            seq = 0

        bucket = staged.setdefault(instrument, {'grantors': [], 'grantees': []})
        # 'D' = direct party = grantor/assignor; 'R' = reverse = grantee/assignee.
        key = 'grantors' if role == 'D' else 'grantees' if role == 'R' else None
        if key:
            bucket[key].append((seq, name))

    return {
        instrument: {
            'grantors': [n for _, n in sorted(b['grantors'])],
            'grantees': [n for _, n in sorted(b['grantees'])],
        }
        for instrument, b in staged.items()
    }


# ── Insert ───────────────────────────────────────────────────────────────────

def insert_records(records: list[dict]) -> tuple[int, int]:
    """Insert Broward rows, refusing any CFN already held by another county.

    Returns (inserted, collisions). A plain INSERT OR IGNORE would hide a
    cross-county key collision as an ordinary duplicate, which is exactly the
    class of silent failure this project keeps getting bitten by — so collisions
    are detected explicitly and logged loudly.
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
            if existing is not None:
                if (existing['county'] or 'MIAMI-DADE') != COUNTY:
                    collisions += 1
                    log.error(
                        f'  KEY COLLISION: CFN {r["cfn"]} already exists under '
                        f'county {existing["county"]!r} — refusing to overwrite'
                    )
                continue  # already collected (same county) → nothing to do

            conn.execute(
                """
                INSERT INTO assignments
                    (cfn, raw_cfn, rec_date, doc_type, grantor, grantee,
                     address, legal_desc, rec_book, rec_page, misc_ref,
                     raw_json, county)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    r['cfn'], r['raw_cfn'], r['rec_date'], r['doc_type'],
                    r.get('grantor'), r.get('grantee'),
                    '',                       # Broward's index carries no street address
                    r.get('legal_desc', ''),
                    r.get('rec_book', ''), r.get('rec_page', ''),
                    r.get('case_number', ''),
                    json.dumps(r.get('raw', {})),
                    COUNTY,
                ),
            )
            inserted += 1
        conn.commit()
    finally:
        conn.close()
    return inserted, collisions


def build_rows(docs: dict[str, dict], names: dict[str, dict]) -> list[dict]:
    """Attach parties to documents and flatten into insertable rows."""
    rows = []
    for instrument, d in docs.items():
        parties = names.get(instrument, {'grantors': [], 'grantees': []})
        grantors, grantees = parties['grantors'], parties['grantees']
        rows.append({
            **d,
            # Single-value columns mirror the Miami-Dade shape; the complete
            # party list (Broward routinely names several per side) is preserved
            # in raw_json so nothing is lost.
            'grantor': grantors[0] if grantors else None,
            'grantee': grantees[0] if grantees else None,
            'raw': {
                'grantors': grantors,
                'grantees': grantees,
                'folio_parcel': d.get('folio_parcel', ''),
                'consideration': d.get('consideration', ''),
                'page_count': d.get('page_count', ''),
                'book_type': d.get('book_type', ''),
                'rec_time': d.get('rec_time', ''),
                'erecorded': d.get('erecorded', False),
                'source': 'broward_sftp',
            },
        })
    return rows


# ── Modes ────────────────────────────────────────────────────────────────────

def collect_file(sftp, doc_path: str, name_path: str, label: str,
                 doc_types: set[str], start: str | None, end: str | None) -> int:
    log.info(f'── {label} ──')
    log.info(f'  reading {doc_path}')
    docs = parse_doc_records(read_remote_text(sftp, doc_path), doc_types, start, end)
    log.info(f'  {len(docs):,} matching document(s) after doc-type/date filter')
    if not docs:
        log_collection(start or '', end or '', 0, 'OK', f'{COUNTY}:{label}',
                       county=COUNTY)
        return 0

    log.info(f'  reading {name_path}')
    names = parse_name_records(read_remote_text(sftp, name_path), set(docs))
    log.info(f'  parties resolved for {len(names):,} of {len(docs):,} document(s)')

    rows = build_rows(docs, names)
    inserted, collisions = insert_records(rows)
    log.info(f'  [DB] {inserted:,} new row(s) inserted'
             + (f' — {collisions} COLLISION(S)' if collisions else ''))

    log_collection(start or '', end or '', len(rows),
                   'ERROR' if collisions else 'OK', f'{COUNTY}:{label}',
                   county=COUNTY)
    return inserted


def run_year(sftp, year: int, doc_types: set[str],
             start: str | None, end: str | None) -> int:
    return collect_file(
        sftp,
        f'{YEARLY_DIR}/CY{year}doc-rec.txt',
        f'{YEARLY_DIR}/CY{year}nme-rec.txt',
        f'CY{year}', doc_types, start, end,
    )


def run_daily(sftp, doc_types: set[str],
              start: str | None, end: str | None) -> int:
    """Ingest every daily file currently on the server (rolling ~10 days)."""
    available = []
    for entry in sftp.listdir(DAILY_DIR):
        m = DAILY_FILE_RE.match(entry)
        if not m:
            continue
        mm, dd, yyyy = m.groups()
        available.append((f'{yyyy}-{mm}-{dd}', entry))
    available.sort()

    if not available:
        log.warning('  no daily doc-ver files found on the server')
        return 0

    log.info(f'  {len(available)} daily file(s) available: '
             f'{available[0][0]} → {available[-1][0]}')

    total = 0
    for file_date, entry in available:
        if start and file_date < start:
            continue
        if end and file_date > end:
            continue
        total += collect_file(
            sftp,
            f'{DAILY_DIR}/{entry}',
            f'{DAILY_DIR}/{entry.replace("doc-ver", "nme-ver")}',
            file_date, doc_types, None, None,
        )
    return total


def run_list(sftp) -> None:
    for directory in (YEARLY_DIR, DAILY_DIR):
        log.info(f'── {directory} ──')
        entries = sorted(sftp.listdir(directory))
        for entry in entries[-30:]:
            log.info(f'  {entry}')
        if len(entries) > 30:
            log.info(f'  … {len(entries) - 30} more')


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, action='append',
                    help='calendar year to ingest (repeatable)')
    ap.add_argument('--daily', action='store_true',
                    help='ingest the rolling daily files')
    ap.add_argument('--list', action='store_true',
                    help='list what is on the server and exit')
    ap.add_argument('--start', help='ignore records recorded before this date')
    ap.add_argument('--end', help='ignore records recorded after this date')
    ap.add_argument('--doc-types', default=None,
                    help='comma-separated Broward doc type codes '
                         f'(default: {",".join(sorted(DOC_TYPES))})')
    args = ap.parse_args()

    if not (args.year or args.daily or args.list):
        ap.error('nothing to do — pass --year, --daily or --list')

    doc_types = ({t.strip().upper() for t in args.doc_types.split(',')}
                 if args.doc_types else set(DOC_TYPES))

    init_db()
    ensure_county_column()

    log.info(f'Connecting to {FTP_USER}@{FTP_HOST}:{FTP_PORT}')
    client, sftp = connect()
    total = 0
    try:
        if args.list:
            run_list(sftp)
            return 0
        for year in args.year or []:
            total += run_year(sftp, year, doc_types, args.start, args.end)
        if args.daily:
            total += run_daily(sftp, doc_types, args.start, args.end)
    finally:
        sftp.close()
        client.close()

    log.info(f'✅ Broward collection complete — {total:,} new row(s) inserted')
    return 0


def ensure_county_column() -> None:
    """Fail fast with a clear instruction rather than a confusing SQL error."""
    conn = get_conn()
    try:
        cols = [r[1] for r in conn.execute('PRAGMA table_info(assignments)')]
    finally:
        conn.close()
    if 'county' not in cols:
        log.error('assignments.county is missing — run the migration first:')
        log.error('    collector/.venv/bin/python3 collector/migrate_add_county.py')
        raise SystemExit(2)


if __name__ == '__main__':
    raise SystemExit(main())
