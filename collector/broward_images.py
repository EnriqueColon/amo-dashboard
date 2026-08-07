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
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from database import get_conn  # noqa: E402

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

def harvest_day(sftp, rec_date: str, zip_name: str, force: bool = False) -> tuple[int, int]:
    """Pull every assignment image for one day. Returns (documents, bytes)."""
    wanted = wanted_instruments(rec_date)
    if not wanted:
        log.warning(f'  {rec_date}: no Broward assignments in the index — run '
                    f'broward_collect.py --daily first, then re-run this')
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


def show_status(sftp) -> None:
    zips = available_zips(sftp)
    if not zips:
        log.warning('no img.zip files on the feed')
        return

    log.info(f'Feed retains {len(zips)} day(s): {zips[0][0]} → {zips[-1][0]}')
    log.info('')
    log.info('  date         indexed  harvested  status')

    at_risk = 0
    for rec_date, _ in zips:
        wanted = wanted_instruments(rec_date)
        have = already_harvested(rec_date)
        if not wanted:
            state = 'INDEX MISSING'
        elif have >= wanted:
            state = 'complete'
        else:
            state = f'{len(wanted - have)} PENDING'
            at_risk += len(wanted - have)
        log.info(f'  {rec_date}   {len(wanted):>6}   {len(have):>8}  {state}')

    log.info('')
    if at_risk:
        log.warning(f'{at_risk} document(s) still unharvested. Images age out of '
                    f'this feed after ~10 days and are then portal-scrape only.')
    else:
        log.info('✅ every day currently on the feed has been harvested')


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
    args = ap.parse_args()

    if not (args.all or args.date or args.status):
        ap.error('nothing to do — pass --all, --date or --status')

    os.makedirs(IMAGE_DIR, exist_ok=True)
    ensure_schema()

    log.info(f'Connecting to {FTP_USER}@{FTP_HOST}:{FTP_PORT}')
    client, sftp = connect()
    try:
        if args.status:
            show_status(sftp)
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
            d, b = harvest_day(sftp, rec_date, zips[rec_date], args.force)
            docs += d
            total += b
        log.info(f'✅ harvested {docs} document(s), {total / 1e6:.1f}MB → {IMAGE_DIR}')
    finally:
        sftp.close()
        client.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
