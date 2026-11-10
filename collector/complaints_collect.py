"""Stages 1-2 of the Clerk-complaints pipeline: find cases, download the complaint.

Stage 1 searches the Miami-Dade Clerk OCS by File Date for the two circuit-civil types
the owner wants (RPMF-Commercial 27185, RPMF-Non-Homestead 27187) and stores EVERY case in
`foreclosure_cases`, whether or not a document exists. Stage 2 takes the earliest
"Complaint" docket entry (docketCode COMPCV) of each case that has no PDF yet and saves it.
A case whose Complaint entry has no attached document gets `complaint_not_public` and is
retried weekly for RETRY_WEEKS weeks (rule 6). See
docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md sections 9, 12, 17, 18.

Usage:
  python complaints_collect.py --from 2025-09-01 --to 2025-09-08     # search a range, then fetch
  python complaints_collect.py --days 10                              # the last 10 days
  python complaints_collect.py --fetch-only | --search-only
Env: AMO_DB_PATH, COMPLAINTS_DIR, CLERK_OCS_USER, CLERK_OCS_PASS.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

import clerk_session

DB_PATH = os.environ.get("AMO_DB_PATH", "miami_dade_amo.db")
PDF_DIR = Path(os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"))
CASE_TYPES = {"27185": "RPMF-Commercial", "27187": "RPMF-Non-Homestead"}
WINDOW_DAYS = 7          # search windows; From and To must be different days (same day returns 0)
RETRY_WEEKS = 8          # how long a complaint with no public document is retried
IMAGE_PAUSE = 2.5        # seconds between document downloads; faster pacing lost files
CAP_WARNING = 500        # results at or above this in one window may be truncated
B = clerk_session.BASE

SCHEMA = """
CREATE TABLE IF NOT EXISTS foreclosure_cases (
    case_id         TEXT PRIMARY KEY,          -- Clerk's internal caseID
    case_number     TEXT UNIQUE NOT NULL,      -- e.g. 2025-017183-CA-01
    case_type_code  TEXT NOT NULL,             -- 27185 / 27187
    case_type       TEXT NOT NULL,
    filing_date     TEXT,
    case_style      TEXT,
    case_status     TEXT,
    first_seen      TEXT NOT NULL,
    -- pending | downloaded | complaint_not_public | no_complaint_entry
    complaint_status TEXT NOT NULL DEFAULT 'pending',
    complaint_din   INTEGER,
    complaint_pdf   TEXT,
    complaint_sha256 TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt    TEXT,
    note            TEXT
);
-- One row per run of this script: what it searched, found, fetched, extracted and spent. The Collection Log
-- tab reads it to show freshness and to flag a run that failed or did not happen.
CREATE TABLE IF NOT EXISTS foreclosure_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at       TEXT NOT NULL,
    finished_at      TEXT,
    window_from      TEXT,
    window_to        TEXT,
    cases_found      INTEGER,        -- every case the Clerk returned for the window (both types)
    new_cases        INTEGER,
    downloaded       INTEGER,
    not_public       INTEGER,
    fetch_errors     INTEGER,
    extracted        INTEGER,
    extract_failed   INTEGER,
    extract_waiting  INTEGER,
    stopped_for_budget INTEGER,
    spent_today_usd  REAL,
    status           TEXT,           -- ok | error
    error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_fc_status ON foreclosure_cases(complaint_status);
CREATE INDEX IF NOT EXISTS idx_fc_filing ON foreclosure_cases(filing_date);
"""


def iso_date(v: str | None) -> str:
    """Clerk dates arrive as MM/DD/YYYY or ISO timestamps; store YYYY-MM-DD so they sort."""
    v = (v or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(v[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return v[:10]


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_county_schema(conn: sqlite3.Connection) -> None:
    """Make sure foreclosure_cases / foreclosure_runs exist and carry the multi-county columns.

    Miami-Dade created the tables with no county; every county after it adds rows with its own
    `county` ('HILLSBOROUGH', 'DUVAL', ...) and a prefixed case_id. Shared by every county collector.
    """
    conn.executescript(SCHEMA)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(foreclosure_cases)").fetchall()}
    if "county" not in cols:
        conn.execute("ALTER TABLE foreclosure_cases ADD COLUMN county TEXT NOT NULL DEFAULT 'MIAMI-DADE'")
    if "metadata_json" not in cols:
        conn.execute("ALTER TABLE foreclosure_cases ADD COLUMN metadata_json TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fc_county ON foreclosure_cases(county)")
    conn.commit()


def requeue_lower_band(conn: sqlite3.Connection, county: str) -> int:
    """With --include-lower-band, cases stored earlier as below_band_threshold are fetched and read too, so the
    Complaints tab shows their property, loan and default data. They still cannot meet the $500,000 test."""
    n = conn.execute("""UPDATE foreclosure_cases SET complaint_status='pending', note=NULL
                        WHERE county=? AND complaint_status='below_band_threshold'""", (county,)).rowcount
    conn.commit()
    return n


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


class Clerk:
    """Signed-in OCS session that signs in again if the Clerk drops it."""

    def __init__(self):
        self.s = clerk_session.login()

    def _call(self, method, path, **kw):
        for attempt in range(3):
            r = self.s.request(method, B + path, timeout=90, **kw)
            if r.status_code in (401, 403) or (r.ok and not clerk_session.is_logged_in(self.s)):
                self.s = clerk_session.login()
                continue
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            return r
        r.raise_for_status()
        return r

    def search(self, d_from: date, d_to: date, case_type: str) -> list[dict]:
        r = self._call("POST", "/ocs/api/CaseInfo/PostSearchByFiledDate", json={
            "filingDateFrom": f"{d_from}T00:00:00.000Z", "filingDateTo": f"{d_to}T00:00:00.000Z",
            "caseType": case_type, "section": 0})
        r.raise_for_status()
        qs = r.json().get("qs")
        if not qs:
            return []
        g = self._call("GET", "/ocs/api/CaseInfo/GetMultipleCaseResult", params={"qs": qs})
        g.raise_for_status()
        return g.json().get("caseListResult") or []

    def case(self, case_id: str) -> dict:
        t = self._call("POST", "/ocs/api/CaseInfo/PostSearchByCaseID", params={"caseID": case_id})
        t.raise_for_status()
        token = t.text.strip().strip('"')
        r = self._call("POST", "/ocs/api/CaseInfo/GetSingleCaseResult",
                       data=json.dumps(token), headers={"Content-Type": "application/json"})
        r.raise_for_status()
        return r.json()

    def documents(self, enc_id: str) -> list[dict]:
        r = self._call("GET", "/ocs/api/CaseInfo/GetSDocumentByEvent", params={"qs": enc_id})
        r.raise_for_status()
        return r.json() or []

    def image(self, enc_doc_info: str) -> bytes:
        r = self._call("GET", "/ocs/api/CaseInfo/image", params={"imagePath": enc_doc_info})
        r.raise_for_status()
        return r.content


# ---------------------------------------------------------------- Stage 1

def search_range(conn, clerk: Clerk, d_from: date, d_to: date) -> int:
    """Store every case filed d_from..d_to for both types; return (cases returned by the Clerk, how many were new)."""
    new = found = 0
    d = d_from
    while d < d_to:
        w_to = min(d + timedelta(days=WINDOW_DAYS), d_to)
        for code, name in CASE_TYPES.items():
            rows = clerk.search(d, w_to, code)
            if len(rows) >= CAP_WARNING:
                print(f"WARNING {name} {d}..{w_to}: {len(rows)} results, may be truncated")
            found += len(rows)
            for c in rows:
                cur = conn.execute(
                    """INSERT OR IGNORE INTO foreclosure_cases
                       (case_id, case_number, case_type_code, case_type, filing_date,
                        case_style, case_status, first_seen) VALUES (?,?,?,?,?,?,?,?)""",
                    (str(c["caseID"]), c["caseNumber"], code, name, iso_date(c.get("filingDate")),
                     c.get("caseStyle"), c.get("caseStatus"), now()))
                new += cur.rowcount
                if not cur.rowcount:  # status changes over a case's life; keep it current
                    conn.execute("UPDATE foreclosure_cases SET case_status=? WHERE case_id=?",
                                 (c.get("caseStatus"), str(c["caseID"])))
            print(f"  {name} {d}..{w_to}: {len(rows)} cases")
        conn.commit()
        d = w_to
    return found, new


# ---------------------------------------------------------------- Stage 2

def pick_complaint(case_json: dict):
    """Earliest docket entry coded COMPCV (Complaint)."""
    comps = [x for x in case_json.get("dockets") or [] if x.get("docketCode") == "COMPCV"]
    comps.sort(key=lambda x: int(x.get("docketNumber") or 10**9))
    return comps[0] if comps else None


def due_for_fetch(conn):
    cutoff_retry = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff_age = (date.today() - timedelta(weeks=RETRY_WEEKS)).isoformat()
    return conn.execute(
        """SELECT * FROM foreclosure_cases WHERE complaint_status='pending'
              OR (complaint_status IN ('complaint_not_public','no_complaint_entry')
                  AND filing_date >= ? AND (last_attempt IS NULL OR last_attempt <= ?))
           ORDER BY filing_date""", (cutoff_age, cutoff_retry)).fetchall()


def fetch_one(conn, clerk: Clerk, row) -> str:
    cj = clerk.case(row["case_id"])
    entry = pick_complaint(cj)
    status, din, path, sha, note = "no_complaint_entry", None, None, None, "no COMPCV docket entry"
    if entry:
        din = int(entry.get("docketNumber") or 0) or None
        docs = clerk.documents(entry["encID"]) if int(entry.get("numberOfDocuments") or 0) > 0 else []
        if not docs:
            status, note = "complaint_not_public", "Complaint entry has 0 documents"
        else:
            data = clerk.image(docs[0]["encDocInfo"])
            if not data.startswith(b"%PDF"):
                raise RuntimeError(f"{row['case_number']}: image response is not a PDF")
            PDF_DIR.mkdir(parents=True, exist_ok=True)
            tag = "COM" if row["case_type_code"] == "27185" else "NH"
            f = PDF_DIR / f"{tag}_{row['case_number']}_DIN{din}.pdf"
            f.write_bytes(data)
            status, path, sha, note = "downloaded", str(f), hashlib.sha256(data).hexdigest(), None
            time.sleep(IMAGE_PAUSE)
    conn.execute("""UPDATE foreclosure_cases SET complaint_status=?, complaint_din=?, complaint_pdf=?,
                    complaint_sha256=?, attempts=attempts+1, last_attempt=?, note=? WHERE case_id=?""",
                 (status, din, path, sha, now(), note, row["case_id"]))
    conn.commit()
    return status


def fetch_pending(conn, clerk: Clerk, limit: int | None = None) -> dict:
    counts: dict[str, int] = {}
    rows = due_for_fetch(conn)
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} cases due for a document fetch")
    for row in rows:
        try:
            st = fetch_one(conn, clerk, row)
        except Exception as e:  # one bad case must not stop the run; it stays pending
            st = "error"
            conn.execute("UPDATE foreclosure_cases SET attempts=attempts+1, last_attempt=?, note=? WHERE case_id=?",
                         (now(), f"error: {e}"[:300], row["case_id"]))
            conn.commit()
            print(f"  ERROR {row['case_number']}: {e}")
        counts[st] = counts.get(st, 0) + 1
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d_from")
    ap.add_argument("--to", dest="d_to")
    ap.add_argument("--days", type=int, help="search the last N days")
    ap.add_argument("--search-only", action="store_true")
    ap.add_argument("--fetch-only", action="store_true")
    ap.add_argument("--limit", type=int, help="fetch at most N documents")
    ap.add_argument("--extract", action="store_true", help="after fetching, read and extract new complaints")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")),
                    help="stop extracting for the day once estimated spend reaches this many USD")
    a = ap.parse_args()
    conn = connect()
    run = {"started_at": now(), "window_from": None, "window_to": None, "cases_found": None, "new_cases": None,
           "downloaded": None, "not_public": None, "fetch_errors": None, "extracted": None, "extract_failed": None,
           "extract_waiting": None, "stopped_for_budget": None, "spent_today_usd": None, "status": "ok", "error": None}
    try:
        clerk = Clerk()
        if not a.fetch_only:
            if a.days:
                d_to, d_from = date.today() + timedelta(days=1), date.today() - timedelta(days=a.days)
            elif a.d_from and a.d_to:
                d_from, d_to = date.fromisoformat(a.d_from), date.fromisoformat(a.d_to)
            else:
                sys.exit("give --days N or --from/--to (or --fetch-only)")
            print(f"searching {d_from}..{d_to}")
            found, new = search_range(conn, clerk, d_from, d_to)
            run.update(window_from=str(d_from), window_to=str(d_to), cases_found=found, new_cases=new)
            print(f"new cases: {new}")
        if not a.search_only:
            counts = fetch_pending(conn, clerk, a.limit)
            print("fetch results:", counts)
            run.update(downloaded=counts.get("downloaded", 0), not_public=counts.get("complaint_not_public", 0),
                       fetch_errors=counts.get("error", 0))
        if a.extract:
            import complaints_extract
            key = os.environ.get("OPENAI_API_KEY")
            if not key:
                raise RuntimeError("OPENAI_API_KEY is not set")
            ex = complaints_extract.process_pending(conn, a.model, key, a.limit, a.budget)
            print("extract results:", ex)
            run.update(extracted=ex["extracted"], extract_failed=ex["failed"], extract_waiting=ex["waiting"],
                       stopped_for_budget=int(ex["stopped_for_budget"]), spent_today_usd=ex["spent_today_usd"])
    except BaseException as e:  # log the failure, then let it surface so cron mail / the wrapper's exit code see it
        run.update(status="error", error=f"{type(e).__name__}: {e}"[:300])
        raise
    finally:
        run["finished_at"] = now()
        cols = ",".join(run)
        conn.execute(f"INSERT INTO foreclosure_runs ({cols}) VALUES ({','.join('?' * len(run))})", list(run.values()))
        conn.commit()
    for r in conn.execute("SELECT complaint_status, COUNT(*) n FROM foreclosure_cases GROUP BY 1"):
        print(f"  {r['complaint_status']}: {r['n']}")


if __name__ == "__main__":
    main()
