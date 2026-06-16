"""
Database helpers for the AMO collector.
"""
import sqlite3
import os

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


def insert_records(records: list) -> int:
    if not records:
        return 0
    conn = get_conn()
    inserted = 0
    for r in records:
        try:
            conn.execute("""
                INSERT OR IGNORE INTO assignments
                    (cfn, raw_cfn, rec_date, doc_type, grantor, grantee,
                     address, legal_desc, rec_book, rec_page, misc_ref)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (
                r.get('cfn'), r.get('raw_cfn'), r.get('rec_date'), r.get('doc_type'),
                r.get('grantor'), r.get('grantee'), r.get('address'),
                r.get('legal_desc'), r.get('rec_book'), r.get('rec_page'), r.get('misc_ref'),
            ))
            if conn.execute('SELECT changes()').fetchone()[0]:
                inserted += 1
        except Exception as e:
            print(f"  [WARN] insert failed for CFN {r.get('cfn')}: {e}")
    conn.commit()
    conn.close()
    return inserted


def log_collection(date_from: str, date_to: str, records_found: int,
                   status: str, doc_type: str):
    conn = get_conn()
    conn.execute("""
        INSERT INTO collection_log (date_from, date_to, records_found, status, doc_type)
        VALUES (?, ?, ?, ?, ?)
    """, (date_from, date_to, records_found, status, doc_type))
    conn.commit()
    conn.close()


def already_collected(date_from: str, date_to: str, doc_type: str) -> bool:
    conn = get_conn()
    row = conn.execute("""
        SELECT 1 FROM collection_log
        WHERE date_from=? AND date_to=? AND status='OK'
          AND COALESCE(doc_type, 'ASSIGNMENT OF MORTGAGE - AMO') = ?
        LIMIT 1
    """, (date_from, date_to, doc_type)).fetchone()
    conn.close()
    return row is not None
