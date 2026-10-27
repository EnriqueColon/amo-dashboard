"""SQLite storage for the Bank Stress Ranking — its own file, never the AOM database.

Path resolution (same rule as server/bank-stress.ts):
  1. AMO_BANK_STRESS_DB_PATH if set
  2. else `bank_stress.db` next to AMO_DB_PATH if that is set
  3. else `bank_stress.db` in the repository root (two levels above this file)
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from .fdic_fields import FAILURE_FIELDS, FINANCIAL_FIELDS, INSTITUTION_FIELDS

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
CONFIG_PATH = HERE / "config.json"


def db_path() -> Path:
    explicit = os.environ.get("AMO_BANK_STRESS_DB_PATH")
    if explicit:
        return Path(explicit)
    amo = os.environ.get("AMO_DB_PATH")
    if amo:
        return Path(amo).resolve().parent / "bank_stress.db"
    return REPO_ROOT / "bank_stress.db"


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or db_path()
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    init_schema(conn)
    return conn


def _columns(fields: list[tuple[str, str, str, str]]) -> str:
    return ",\n  ".join(f"{code} {sql_type}" for code, _basis, sql_type, _title in fields)


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(f"""
    CREATE TABLE IF NOT EXISTS fdic_financials_raw (
      {_columns(FINANCIAL_FIELDS)},
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (CERT, REPDTE)
    );
    CREATE INDEX IF NOT EXISTS idx_fin_raw_repdte ON fdic_financials_raw(REPDTE);

    CREATE TABLE IF NOT EXISTS fdic_institutions (
      {_columns(INSTITUTION_FIELDS)},
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (CERT)
    );

    CREATE TABLE IF NOT EXISTS fdic_failures (
      {_columns(FAILURE_FIELDS)},
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (CERT, FAILDATE)
    );

    CREATE TABLE IF NOT EXISTS pull_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      repdte TEXT,
      rows INTEGER,
      expected_total INTEGER,
      ok INTEGER NOT NULL,
      detail TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      seconds REAL
    );

    -- Written by scoring.py: one row per completed compute, newest wins.
    CREATE TABLE IF NOT EXISTS bank_stress_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL,
      quarters_json TEXT NOT NULL,
      latest_quarter TEXT NOT NULL,
      config_json TEXT NOT NULL,
      definitions_json TEXT NOT NULL,
      banks_scored INTEGER,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS bank_scores (
      cert INTEGER NOT NULL,
      repdte TEXT NOT NULL,
      name TEXT,
      state TEXT,
      assets_k REAL,
      peer_band TEXT,
      hc_owned INTEGER,
      excluded_reason TEXT,
      condition REAL,
      deterioration REAL,
      cre_exposure REAL,
      composite REAL,
      completeness REAL,
      rank INTEGER,
      rank_in_band INTEGER,
      cohort_size INTEGER,
      band_size INTEGER,
      flag_count INTEGER,
      flags_json TEXT,
      watch_flags_json TEXT,
      tier TEXT,
      cre_seller_signal INTEGER,
      top_drivers_json TEXT,
      components_json TEXT,
      PRIMARY KEY (cert, repdte)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_repdte_rank ON bank_scores(repdte, rank);

    CREATE TABLE IF NOT EXISTS backtest_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL,
      cert INTEGER,
      name TEXT,
      faildate TEXT,
      lag_quarters INTEGER,
      repdte TEXT,
      composite REAL,
      composite_pctile REAL,
      peer_band TEXT,
      in_top_decile INTEGER,
      in_top_quintile INTEGER,
      note TEXT
    );

    -- Validation hook: FDIC certificate ↔ the canonical name the AOM pipeline
    -- uses for the same bank (seeded from fdic_institution_cache by the cron
    -- wrapper when the main database is reachable). Join bank_scores to
    -- aom_events_clean.assignor_canon through this table.
    CREATE TABLE IF NOT EXISTS bank_entity_link (
      cert INTEGER NOT NULL,
      canonical_name TEXT NOT NULL,
      source TEXT,
      linked_at TEXT,
      PRIMARY KEY (cert, canonical_name)
    );
    """)
    conn.commit()
    _add_missing_columns(conn, "fdic_financials_raw", FINANCIAL_FIELDS)
    _add_missing_columns(conn, "fdic_institutions", INSTITUTION_FIELDS)


def _add_missing_columns(conn: sqlite3.Connection, table: str, fields: list[tuple[str, str, str, str]]) -> None:
    """A field added to the catalogue after the table was created is appended as a
    column (ADD COLUMN is metadata-only in SQLite). Values arrive on the next pull;
    until then the column is NULL, which the field assertion does not see — it
    checks the API response, not the table — so a pull is required after a change."""
    have = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    added = []
    for code, _basis, sql_type, _title in fields:
        if code not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {code} {sql_type}")
            added.append(code)
    if added:
        conn.commit()
        print(f"[db] {table}: added columns {', '.join(added)} — run a pull to fill them")
