"""
Broward document-image harvester — selective pull from the daily img.zip
------------------------------------------------------------------------
Broward's SFTP feed carries one zip of document images per business day, but it
retains only ~10 days. Images that age out cannot be recovered from the feed at
all — the yearly exports are index-only — so anything missed here has to be
scraped from the portal one document at a time. **This script is the deadline in
the Broward pipeline: it must run at least weekly, and daily is much safer.**

Why this is cheap despite a ~540MB/day zip
-------------------------------------------
Entries are named `<instrument>.<page>.tif`, keyed directly by the instrument
number we already hold in `assignments`. A zip's central directory lives at the
END of the file, so we can:

    1. read the last few MB over SFTP  → full entry list + byte offsets
    2. seek to just the entries we want → read only those byte ranges

Measured on 08-03-2026: 0.13MB pulled instead of 538MB for the assignments in
that day's file. A whole day of Broward assignments costs ~14MB.

We store the raw TIFFs rather than OCR text on purpose. The images are the
irreplaceable artifact — the same reasoning that keeps `pdf_extractions` around
rather than only its derived tables. OCR settings and LLM prompts can be
re-applied later; a day that fell out of the retention window cannot.

Usage:
    python broward_images.py --status          # what's on the feed vs harvested
    python broward_images.py --all             # harvest every available day
    python broward_images.py --date 2026-08-03
"""

import argparse
import io
import logging
import os
import re
import struct
import sys
import zlib
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from database import get_conn  # noqa: E402
from broward_collect import (  # noqa: E402
    DOC_TYPES, parse_doc_records, read_remote_text,
)

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

DAILY_DIR = 'Official_Records_Download'

IMAGE_DIR = os.environ.get(
    'BROWARD_IMAGE_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'broward_images'))

IMG_ZIP_RE = re.compile(r'^(\d{2})-(\d{2})-(\d{4})img\.zip$')
ENTRY_RE = re.compile(r'^(\d+)\.(\d+)\.(\w+)$')

# The central directory sits at the end of the file. 3MB comfortably covers
# ~10k entries; if a day ever exceeds it the tail read is retried larger.
TAIL_BYTES = 3_000_000
MAX_TAIL_BYTES = 24_000_000

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-8s %(message)s',
    datefmt='%H:%M:%S',
    handlers=[logging.StreamHandler(),
              logging.FileHandler(os.path.join(os.path.dirname(__file__),
                                               'broward_images.log'))],
)
log = logging.getLogger('broward-img')


# ── Schema ───────────────────────────────────────────────────────────────────

def ensure_schema() -> None:
    conn = get_conn()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS broward_images (
                cfn           TEXT PRIMARY KEY,
                rec_date      TEXT,
                page_count    INTEGER,
                bytes_on_disk INTEGER,
                harvested_at  TEXT DEFAULT (datetime('now')),
                source_zip    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_broward_images_date
                ON broward_images(rec_date);
        """)
        conn.commit()
    finally:
        conn.close()


def already_harvested(rec_date: str) -> set[str]:
    conn = get_conn()
    try:
        return {r[0] for r in conn.execute(
            'SELECT cfn FROM broward_images WHERE rec_date = ?', (rec_date,))}
    finally:
        conn.close()


def wanted_instruments(rec_date: str) -> set[str]:
    """Broward assignments recorded on rec_date, per the already-ingested index."""
    conn = get_conn()
    try:
        return {r[0] for r in conn.execute(
            'SELECT cfn FROM assignments WHERE county = ? AND rec_date = ?',
            (COUNTY, rec_date))}
    finally:
        conn.close()


def wanted_from_feed(sftp, rec_date: str, doc_types: set[str]) -> set[str]:
    """Same list, read from the feed's own index file instead of the database.

    This is what makes the harvester deployable ahead of everything else. The
    day's `doc-ver.txt` already says which documents are assignments, so nothing
    has to be ingested into `assignments` first — which means no schema
    migration, no Broward rows in tables the dashboard reads, and no visible
    change to production. The retention clock is the only thing with a deadline;
    this decouples it from the work that needs care.
    """
    yyyy, mm, dd = rec_date[0:4], rec_date[5:7], rec_date[8:10]
    path = f'{DAILY_DIR}/{mm}-{dd}-{yyyy}doc-ver.txt'
    return set(parse_doc_records(read_remote_text(sftp, path), doc_types, None, None))


def resolve_wanted(sftp, rec_date: str, from_feed: bool,
                   doc_types: set[str]) -> set[str]:
    return (wanted_from_feed(sftp, rec_date, doc_types) if from_feed
            else wanted_instruments(rec_date))


def record_harvest(cfn: str, rec_date: str, pages: int,
                   nbytes: int, source: str) -> None:
    conn = get_conn()
    try:
        conn.execute(
            'INSERT OR REPLACE INTO broward_images '
            '(cfn, rec_date, page_count, bytes_on_disk, source_zip) '
            'VALUES (?,?,?,?,?)', (cfn, rec_date, pages, nbytes, source))
        conn.commit()
    finally:
        conn.close()


def record_run(status: str, started_at: str, detail: str,
               summary: dict | None) -> None:
    """Heartbeat for the daily job: 'this ran', separate from 'this found data'.

    The distinction is the whole point of this table. Liveness used to be
    inferred from MAX(broward_images.harvested_at), which measures when new data
    last ARRIVED — and Broward publishes on business days only, ~3 business days
    behind. So a healthy job over a weekend writes no rows for >48h and looked
    exactly like a job that had died. That false alarm fired every Monday, which
    is worse than no alarm: it trains the reader to dismiss the banner that is
    supposed to catch real, permanent image loss.

    busy_timeout is not optional. This writes to the live database while the app
    and the other crons are using it, and the nightly normalize commits its whole
    rebuild in one transaction. Without it the INSERT loses a lock race and the
    run reports as never having happened — turning a successful run into a false
    alarm, which is the exact failure this table exists to prevent. Same lesson
    as record() in run_backup.sh.
    """
    conn = get_conn()
    try:
        conn.execute('PRAGMA busy_timeout = 30000')
        conn.execute("""
            CREATE TABLE IF NOT EXISTS broward_runs (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at     TEXT,
                finished_at    TEXT,
                status         TEXT,
                detail         TEXT,
                feed_first     TEXT,
                feed_last      TEXT,
                days_on_feed   INTEGER,
                days_pending   INTEGER,
                docs_pending   INTEGER,
                oldest_pending TEXT
            )
        """)
        s = summary or {}
        conn.execute(
            "INSERT INTO broward_runs (started_at, finished_at, status, detail, "
            "feed_first, feed_last, days_on_feed, days_pending, docs_pending, "
            "oldest_pending) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)",
            (started_at, status, detail or None,
             s.get('feed_first'), s.get('feed_last'), s.get('days_on_feed'),
             s.get('days_pending'), s.get('docs_pending'), s.get('oldest_pending')))
        conn.commit()
        log.info(f'run recorded: status={status} '
                 f'days_pending={s.get("days_pending")} '
                 f'docs_pending={s.get("docs_pending")}')
    except Exception as exc:  # noqa: BLE001 - never fail the run over bookkeeping
        log.error(f'could not record this run in broward_runs: {exc} — '
                  f'the Overview will report Broward collection as stopped')
    finally:
        conn.close()


# ── SFTP + zip ───────────────────────────────────────────────────────────────

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(FTP_HOST, port=FTP_PORT, username=FTP_USER, password=FTP_PASS,
                   look_for_keys=False, allow_agent=False, timeout=45)
    return client, client.open_sftp()


class _TailWindow(io.RawIOBase):
    """Presents the tail of a remote file as if it were the whole file.

    zipfile only needs the central directory to build its entry list, and that
    lives at the end — so handing it a window avoids pulling ~540MB.
    """

    def __init__(self, data: bytes, offset: int):
        self.data, self.offset, self.pos = data, offset, offset

    def seek(self, target, whence=0):
        if whence == 0:
            self.pos = target
        elif whence == 1:
            self.pos += target
        else:
            self.pos = self.offset + len(self.data) + target
        return self.pos

    def tell(self):
        return self.pos

    def read(self, n=-1):
        i = self.pos - self.offset
        if i < 0:
            raise IOError('read before the fetched window')
        chunk = self.data[i:] if n < 0 else self.data[i:i + n]
        self.pos += len(chunk)
        return chunk

    def readable(self):
        return True

    def seekable(self):
        return True


def read_central_directory(sftp, path: str):
    """Return (zipfile.ZipFile, remote handle, size) reading only the tail."""
    import zipfile

    size = sftp.stat(path).st_size
    tail = TAIL_BYTES
    while True:
        handle = sftp.open(path, 'rb')
        handle.seek(max(0, size - tail))
        data = handle.read(min(tail, size))
        try:
            return zipfile.ZipFile(_TailWindow(data, max(0, size - tail))), handle, size
        except zipfile.BadZipFile:
            handle.close()
            tail *= 2
            if tail > MAX_TAIL_BYTES or tail >= size:
                raise
            log.info(f'  central directory beyond {tail // 2 // 1_000_000}MB — '
                     f'retrying with {tail // 1_000_000}MB')


def extract_entry(handle, info) -> bytes:
    """Read and decompress one zip entry via a single ranged read.

    Deliberately bypasses zipfile.open(): that issues many small reads, and each
    one is an SFTP round trip. One contiguous read per entry is dramatically
    faster over the wire.
    """
    handle.seek(info.header_offset)
    header = handle.read(30)
    if header[:4] != b'PK\x03\x04':
        raise IOError(f'bad local header for {info.filename}')
    name_len, extra_len = struct.unpack('<HH', header[26:30])
    handle.seek(info.header_offset + 30 + name_len + extra_len)
    blob = handle.read(info.compress_size)

    if info.compress_type == 0:          # stored
        return blob
    return zlib.decompress(blob, -15)    # raw deflate


# ── Harvest ──────────────────────────────────────────────────────────────────

def harvest_day(sftp, rec_date: str, zip_name: str, force: bool = False,
                from_feed: bool = False,
                doc_types: set[str] | None = None) -> tuple[int, int]:
    """Pull every assignment image for one day. Returns (documents, bytes)."""
    wanted = resolve_wanted(sftp, rec_date, from_feed, doc_types or set(DOC_TYPES))
    if not wanted:
        if from_feed:
            log.warning(f'  {rec_date}: the feed lists no assignments for this day')
        else:
            log.warning(f'  {rec_date}: no Broward assignments in the index — run '
                        f'broward_collect.py --daily first, or pass --from-feed '
                        f'to read the work list off the feed instead')
        return 0, 0

    have = set() if force else already_harvested(rec_date)
    todo = wanted - have
    if not todo:
        log.info(f'  {rec_date}: all {len(wanted)} assignment(s) already harvested')
        return 0, 0

    path = f'{DAILY_DIR}/{zip_name}'
    z, handle, size = read_central_directory(sftp, path)
    try:
        by_doc: dict[str, list] = {}
        for info in z.infolist():
            m = ENTRY_RE.match(os.path.basename(info.filename))
            if m and m.group(1) in todo:
                by_doc.setdefault(m.group(1), []).append((int(m.group(2)), info))

        missing = todo - set(by_doc)
        if missing:
            log.warning(f'  {rec_date}: {len(missing)} assignment(s) have no image '
                        f'in the zip (e.g. {sorted(missing)[:3]})')

        docs = total_bytes = 0
        for cfn, pages in sorted(by_doc.items()):
            dest_dir = os.path.join(IMAGE_DIR, cfn)
            os.makedirs(dest_dir, exist_ok=True)
            written = 0
            for page_no, info in sorted(pages):
                data = extract_entry(handle, info)
                ext = info.filename.rsplit('.', 1)[-1].lower()
                with open(os.path.join(dest_dir, f'{page_no:03d}.{ext}'), 'wb') as fh:
                    fh.write(data)
                written += len(data)
            record_harvest(cfn, rec_date, len(pages), written, zip_name)
            docs += 1
            total_bytes += written

        log.info(f'  {rec_date}: {docs} document(s), {len(by_doc)} in zip, '
                 f'{total_bytes / 1e6:.1f}MB written '
                 f'(zip is {size / 1e6:.0f}MB — pulled {total_bytes / size * 100:.1f}%)')
        return docs, total_bytes
    finally:
        handle.close()


def available_zips(sftp) -> list[tuple[str, str]]:
    out = []
    for entry in sftp.listdir(DAILY_DIR):
        m = IMG_ZIP_RE.match(entry)
        if m:
            mm, dd, yyyy = m.groups()
            out.append((f'{yyyy}-{mm}-{dd}', entry))
    return sorted(out)


def show_status(sftp, from_feed: bool = False,
                doc_types: set[str] | None = None) -> dict | None:
    """Print the retention report and return it as a summary for record_run().

    The returned numbers are the ones that actually matter for monitoring:
    `docs_pending` is images still on the feed and not yet on our disk, i.e. the
    only quantity here that can become a permanent loss. Everything else on this
    page is recoverable.
    """
    zips = available_zips(sftp)
    if not zips:
        log.warning('no img.zip files on the feed')
        return None

    log.info(f'Feed retains {len(zips)} day(s): {zips[0][0]} → {zips[-1][0]}')
    log.info('')
    log.info(f'  date        {"on feed" if from_feed else "indexed"}  harvested  status')

    at_risk = 0
    days_pending = 0
    oldest_pending = None
    for rec_date, _ in zips:
        wanted = resolve_wanted(sftp, rec_date, from_feed,
                                doc_types or set(DOC_TYPES))
        have = already_harvested(rec_date)
        if not wanted:
            state = 'NO ASSIGNMENTS' if from_feed else 'INDEX MISSING'
        elif have >= wanted:
            state = 'complete'
        else:
            state = f'{len(wanted - have)} PENDING'
            at_risk += len(wanted - have)
            days_pending += 1
            # zips is sorted, so the first pending day is the closest to aging out.
            oldest_pending = oldest_pending or rec_date
        log.info(f'  {rec_date}   {len(wanted):>6}   {len(have):>8}  {state}')

    log.info('')
    if at_risk:
        log.warning(f'{at_risk} document(s) still unharvested. Images age out of '
                    f'this feed after ~10 days and are then portal-scrape only.')
    else:
        log.info('✅ every day currently on the feed has been harvested')

    return {
        'feed_first':     zips[0][0],
        'feed_last':      zips[-1][0],
        'days_on_feed':   len(zips),
        'days_pending':   days_pending,
        'docs_pending':   at_risk,
        'oldest_pending': oldest_pending,
    }


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true',
                    help='harvest every day currently on the feed')
    ap.add_argument('--date', action='append',
                    help='harvest a specific YYYY-MM-DD (repeatable)')
    ap.add_argument('--status', action='store_true',
                    help='report feed retention vs what has been harvested')
    ap.add_argument('--force', action='store_true',
                    help='re-download documents already harvested')
    ap.add_argument('--from-feed', action='store_true',
                    help="read the work list from the feed's own index file "
                         'instead of the assignments table — lets the harvester '
                         'run before any Broward data is ingested')
    ap.add_argument('--doc-types', default=None,
                    help='comma-separated Broward doc type codes '
                         f'(default: {",".join(sorted(DOC_TYPES))})')
    # Heartbeat. Used by run_broward_daily.sh, which knows whether the earlier
    # steps succeeded; this script knows the feed picture. One row carries both,
    # so the Overview can tell "the job ran and found nothing new" (normal, every
    # weekend) apart from "the job stopped running" (permanent image loss).
    ap.add_argument('--record-run', choices=('ok', 'failed'), default=None,
                    help='record this run in broward_runs (use with --status)')
    ap.add_argument('--run-started', default=None,
                    help='ISO timestamp the overall daily job started')
    ap.add_argument('--run-detail', default='',
                    help='which step(s) failed, for the Overview to display')
    args = ap.parse_args()

    if args.record_run and not args.status:
        ap.error('--record-run requires --status: the recorded summary IS the '
                 'status report, so the two are computed in one pass')

    doc_types = ({t.strip().upper() for t in args.doc_types.split(',')}
                 if args.doc_types else set(DOC_TYPES))

    if not (args.all or args.date or args.status):
        ap.error('nothing to do — pass --all, --date or --status')

    os.makedirs(IMAGE_DIR, exist_ok=True)
    ensure_schema()

    # The status+heartbeat path owns its own error handling: a feed it cannot
    # reach is itself a reportable outcome, and losing the heartbeat to an
    # exception would make a job that ran and failed indistinguishable from one
    # that never started. Both need a row; only the detail differs.
    if args.record_run:
        started = args.run_started or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        status, detail, summary = args.record_run, args.run_detail, None
        try:
            log.info(f'Connecting to {FTP_USER}@{FTP_HOST}:{FTP_PORT}')
            client, sftp = connect()
            try:
                summary = show_status(sftp, args.from_feed, doc_types)
            finally:
                sftp.close()
                client.close()
        except Exception as exc:  # noqa: BLE001
            log.error(f'status check failed: {exc}')
            status = 'failed'
            detail = f'{detail}; feed unreachable: {exc}'.lstrip('; ')
        record_run(status, started, detail, summary)
        return 0 if status == 'ok' else 1

    log.info(f'Connecting to {FTP_USER}@{FTP_HOST}:{FTP_PORT}')
    client, sftp = connect()
    try:
        if args.status:
            show_status(sftp, args.from_feed, doc_types)
            return 0

        zips = dict(available_zips(sftp))
        targets = sorted(zips) if args.all else []
        for d in args.date or []:
            try:
                datetime.strptime(d, '%Y-%m-%d')
            except ValueError:
                log.error(f'  {d} is not a YYYY-MM-DD date')
                return 2
            if d not in zips:
                log.error(f'  {d} is not on the feed (retains {min(zips)} → {max(zips)})')
                return 2
            targets.append(d)

        docs = total = 0
        for rec_date in sorted(set(targets)):
            d, b = harvest_day(sftp, rec_date, zips[rec_date], args.force,
                               args.from_feed, doc_types)
            docs += d
            total += b
        log.info(f'✅ harvested {docs} document(s), {total / 1e6:.1f}MB → {IMAGE_DIR}')
    finally:
        sftp.close()
        client.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
