"""
Database helpers for the AMO collector.
"""
import sqlite3
import os
from datetime import date, datetime, timedelta

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS assignments (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            cfn              TEXT UNIQUE,
            raw_cfn          TEXT,
            rec_date         TEXT,
            doc_type         TEXT,
            grantor          TEXT,
            grantee          TEXT,
            address          TEXT,
            legal_desc       TEXT,
            rec_book         TEXT,
            rec_page         TEXT,
            misc_ref         TEXT,
            raw_json         TEXT
        );
        CREATE TABLE IF NOT EXISTS collection_log (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            date_from        TEXT,
            date_to          TEXT,
            records_found    INTEGER,
            status           TEXT,
            collected_at     TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_assignments_grantor  ON assignments(grantor);
        CREATE INDEX IF NOT EXISTS idx_assignments_grantee  ON assignments(grantee);
        CREATE INDEX IF NOT EXISTS idx_assignments_rec_date ON assignments(rec_date);
    """)
    # Migration: track which document type each collection window covered.
    # Legacy rows (NULL) were all "ASSIGNMENT OF MORTGAGE - AMO".
    try:
        conn.execute("ALTER TABLE collection_log ADD COLUMN doc_type TEXT")
        conn.execute("UPDATE collection_log SET doc_type = 'ASSIGNMENT OF MORTGAGE - AMO' WHERE doc_type IS NULL")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()


def insert_records(records: list, county: str = 'MIAMI-DADE') -> int:
    """Insert Miami-Dade index rows.

    `county` is written explicitly. It used to be left NULL and repaired later
    by server/db.ts and migrate_add_county.py, which both backfill NULL →
    MIAMI-DADE. That repair works, but only on the next server start: until
    then every freshly collected row is county-less, and anything that filters
    `assignments` by county silently omits the newest documents. Writing the
    value here means the row is correct the moment it lands. The downstream
    backfills stay where they are — they still cover rows written by an older
    collector build.
    """
    if not records:
        return 0
    conn = get_conn()
    inserted = 0
    for r in records:
        try:
            conn.execute("""
                INSERT OR IGNORE INTO assignments
                    (cfn, raw_cfn, rec_date, doc_type, grantor, grantee,
                     address, legal_desc, rec_book, rec_page, misc_ref, county)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                r.get('cfn'), r.get('raw_cfn'), r.get('rec_date'), r.get('doc_type'),
                r.get('grantor'), r.get('grantee'), r.get('address'),
                r.get('legal_desc'), r.get('rec_book'), r.get('rec_page'),
                r.get('misc_ref'), county,
            ))
            if conn.execute('SELECT changes()').fetchone()[0]:
                inserted += 1
        except sqlite3.OperationalError:
            # Database predates the county column (an old copy) — fall back
            # rather than failing the collection run.
            conn.execute("""
                INSERT OR IGNORE INTO assignments
                    (cfn, raw_cfn, rec_date, doc_type, grantor, grantee,
                     address, legal_desc, rec_book, rec_page, misc_ref)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (
                r.get('cfn'), r.get('raw_cfn'), r.get('rec_date'), r.get('doc_type'),
                r.get('grantor'), r.get('grantee'), r.get('address'),
                r.get('legal_desc'), r.get('rec_book'), r.get('rec_page'),
                r.get('misc_ref'),
            ))
            if conn.execute('SELECT changes()').fetchone()[0]:
                inserted += 1
        except Exception as e:
            print(f"  [WARN] insert failed for CFN {r.get('cfn')}: {e}")
    conn.commit()
    conn.close()
    return inserted


def log_collection(date_from: str, date_to: str, records_found: int,
                   status: str, doc_type: str, county: str = 'MIAMI-DADE'):
    """Record one collection window.

    `county` must be passed explicitly by non-Miami-Dade collectors. Leaving it
    NULL is not a neutral default: both migrate_add_county.py and server/db.ts
    backfill NULL counties to MIAMI-DADE on sight, so an untagged Broward run
    would be permanently relabelled as a Miami-Dade one.
    """
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO collection_log
                (date_from, date_to, records_found, status, doc_type, county)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (date_from, date_to, records_found, status, doc_type, county))
    except sqlite3.OperationalError:
        # Database predates the county column (collector running against an old
        # copy) — fall back rather than failing the whole collection run.
        conn.execute("""
            INSERT INTO collection_log (date_from, date_to, records_found, status, doc_type)
            VALUES (?, ?, ?, ?, ?)
        """, (date_from, date_to, records_found, status, doc_type))
    conn.commit()
    conn.close()


# A window whose end date falls inside this many days of today is always
# re-collected, even if a previous run logged it OK.
#
# The county does not finish publishing a recording day on that day: documents
# are added to an already-published date for some days afterwards, and a window
# collected once was then never looked at again. A weekly run with a 10-day
# lookback hid this, because its chunk boundaries shifted each week and rarely
# repeated. On a daily schedule the boundaries repeat constantly, so without
# this horizon the second run of a window would skip it and every late-posted
# document inside it would be missed permanently.
#
# Re-collecting is cheap (INSERT OR IGNORE, and the whole Miami-Dade window
# takes about 90 seconds) and cannot duplicate a row.
RECHECK_DAYS = int(os.environ.get('AMO_RECHECK_DAYS', '14'))


def already_collected(date_from: str, date_to: str, doc_type: str,
                      recheck_days: int | None = None) -> bool:
    horizon = RECHECK_DAYS if recheck_days is None else recheck_days
    if horizon > 0:
        try:
            end = datetime.strptime(date_to, '%Y-%m-%d').date()
        except (TypeError, ValueError):
            end = None
        if end and end >= date.today() - timedelta(days=horizon):
            return False

    conn = get_conn()
    row = conn.execute("""
        SELECT 1 FROM collection_log
        WHERE date_from=? AND date_to=? AND status='OK'
          AND COALESCE(doc_type, 'ASSIGNMENT OF MORTGAGE - AMO') = ?
        LIMIT 1
    """, (date_from, date_to, doc_type)).fetchone()
    conn.close()
    return row is not None
