"""
New York State / NYC Collector (`new_york_collect.py`)
------------------------------------------------------
Supports two New York collection streams:

  1. NYC ACRIS Open Data API (`--acris`):
     Pulls recorded Assignments of Mortgage (`ASST`), Mortgages (`MTGE`), and
     Agreements/Modifications (`AGMT`) across New York City boroughs from the
     official NYC Open Data Socrata API (no login, no captcha):
       • Master (`bnx9-e6tj`): document_id, crfn, doc_type, recorded_datetime,
         document_amt, recorded_borough
       • Parties (`636b-3b5g`): party_type ('1' = Grantor/Assignor/Borrower,
         '2' = Grantee/Assignee/Lender, '3' = Other), name, address
       • Legals (`8h5j-fqxa`): borough, block, lot (`BBL`), street_number,
         street_name, unit

     Borough codes:
       1 = NEW-YORK (Manhattan / New York County)
       2 = BRONX (Bronx County)
       3 = KINGS (Brooklyn / Kings County)
       4 = QUEENS (Queens County)
       5 = RICHMOND (Staten Island / Richmond County)

  2. New York Foreclosure Complaints Ingestion (`--ingest-dir` / `--extract`):
     Ingests New York Supreme Court foreclosure Complaint PDFs placed in
     `COMPLAINTS_DIR` (`complaints_pdfs/`, e.g. `NY_650123-2026_Complaint.pdf` or
     `KINGS_501234-2026.pdf`) into `foreclosure_cases` (`county='NEW-YORK'` /
     `'KINGS'` / etc.) and runs them through the shared `complaints_reader.py` +
     `complaints_extract.py` (`gpt-5.5`) + `complaints_address.py` pipeline to
     extract the Unpaid Principal Balance, Right to Reinstate clause, Default
     Date, and Property Address.
     (Note: NYSCEF prohibits automated bot scraping in its Terms of Use; this
     module never scrapes NYSCEF.)

Usage:
  python new_york_collect.py --acris --boroughs 1 --limit 25
  python new_york_collect.py --ingest-dir complaints_pdfs --extract
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402
import complaints_extract  # noqa: E402
import proxy_config  # noqa: E402

ACRIS_MASTER_URL = "https://data.cityofnewyork.us/resource/bnx9-e6tj.json"
ACRIS_PARTIES_URL = "https://data.cityofnewyork.us/resource/636b-3b5g.json"
ACRIS_LEGALS_URL = "https://data.cityofnewyork.us/resource/8h5j-fqxa.json"
HTTP_TIMEOUT = 60

BOROUGH_MAP = {
    "1": "NEW-YORK",
    "2": "BRONX",
    "3": "KINGS",
    "4": "QUEENS",
    "5": "RICHMOND",
}

NY_COUNTIES = {
    "NEW-YORK": "New York County (Manhattan)",
    "KINGS": "Kings County (Brooklyn)",
    "QUEENS": "Queens County",
    "BRONX": "Bronx County",
    "RICHMOND": "Richmond County (Staten Island)",
    "NASSAU": "Nassau County",
    "SUFFOLK": "Suffolk County",
    "WESTCHESTER": "Westchester County",
}

# Match NY index numbers in PDF filenames, e.g. NY_850123-2026.pdf, KINGS_501234_2026.pdf
NY_PDF_RE = re.compile(
    r"^(NEW[-_]?YORK|NY|KINGS|QUEENS|BRONX|RICHMOND|NASSAU|SUFFOLK|WESTCHESTER)[-_](\d{5,7}[-_/]\d{4})",
    re.I,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("new_york_collect")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_county_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(complaints_collect.SCHEMA)
    cols = {
        r[1]
        for r in conn.execute("PRAGMA table_info(foreclosure_cases)").fetchall()
    }
    if "county" not in cols:
        conn.execute(
            "ALTER TABLE foreclosure_cases ADD COLUMN county TEXT NOT NULL DEFAULT 'MIAMI-DADE'"
        )
    if "metadata_json" not in cols:
        conn.execute(
            "ALTER TABLE foreclosure_cases ADD COLUMN metadata_json TEXT"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_fc_county ON foreclosure_cases(county)"
    )
    conn.commit()


def fetch_acris_records(
    boroughs: List[str] = ["1"],
    doc_types: List[str] = ["ASST", "MTGE", "AGMT"],
    since_date: Optional[str] = None,
    limit: int = 25,
    session: Optional[requests.Session] = None,
) -> List[Dict[str, Any]]:
    """
    Fetches joined Master + Parties + Legals records from NYC ACRIS Open Data.
    """
    s = session or requests.Session()
    proxy_config.apply_to_requests_session(s, session_key="nyc_acris")

    b_clause = ",".join(f"'{b}'" for b in boroughs)
    dt_clause = ",".join(f"'{d}'" for d in doc_types)
    where = f"recorded_borough in ({b_clause}) AND doc_type in ({dt_clause})"
    if since_date:
        where += f" AND recorded_datetime >= '{since_date}T00:00:00.000'"

    r = s.get(
        ACRIS_MASTER_URL,
        params={
            "$where": where,
            "$order": "recorded_datetime DESC",
            "$limit": limit,
        },
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    masters = r.json()
    if not masters:
        return []

    doc_ids = [m["document_id"] for m in masters if m.get("document_id")]
    id_list = ",".join(f"'{d}'" for d in doc_ids)

    p_resp = s.get(
        ACRIS_PARTIES_URL,
        params={"$where": f"document_id in ({id_list})", "$limit": 5000},
        timeout=HTTP_TIMEOUT,
    )
    p_resp.raise_for_status()
    parties_by_doc: Dict[str, Dict[str, List[str]]] = {}
    for p in p_resp.json():
        did = p.get("document_id")
        name = (p.get("name") or "").strip()
        ptype = str(p.get("party_type") or "")
        if not did or not name:
            continue
        slot = parties_by_doc.setdefault(did, {"party1": [], "party2": [], "party3": []})
        key = "party1" if ptype == "1" else "party2" if ptype == "2" else "party3"
        if name not in slot[key]:
            slot[key].append(name)

    l_resp = s.get(
        ACRIS_LEGALS_URL,
        params={"$where": f"document_id in ({id_list})", "$limit": 5000},
        timeout=HTTP_TIMEOUT,
    )
    l_resp.raise_for_status()
    legals_by_doc: Dict[str, List[Dict[str, str]]] = {}
    for l in l_resp.json():
        did = l.get("document_id")
        if not did:
            continue
        b = str(l.get("borough") or "")
        blk = str(l.get("block") or "")
        lot = str(l.get("lot") or "")
        bbl = f"{b}-{blk.zfill(5)}-{lot.zfill(4)}" if (b and blk and lot) else ""
        st_num = (l.get("street_number") or "").strip()
        st_name = (l.get("street_name") or "").strip()
        unit = (l.get("unit") or "").strip()
        addr = " ".join(x for x in (st_num, st_name, f"Unit {unit}" if unit else "") if x).strip()
        legals_by_doc.setdefault(did, []).append({"bbl": bbl, "address": addr})

    results: List[Dict[str, Any]] = []
    for m in masters:
        did = m["document_id"]
        b_code = str(m.get("recorded_borough") or "1")
        county = BOROUGH_MAP.get(b_code, "NEW-YORK")
        p_info = parties_by_doc.get(did, {"party1": [], "party2": [], "party3": []})
        l_info = legals_by_doc.get(did, [])
        addrs = [x["address"] for x in l_info if x.get("address")]
        bbls = [x["bbl"] for x in l_info if x.get("bbl")]
        results.append(
            {
                "document_id": did,
                "crfn": m.get("crfn"),
                "county": county,
                "doc_type": m.get("doc_type"),
                "recorded_date": (m.get("recorded_datetime") or "")[:10],
                "doc_date": (m.get("document_date") or "")[:10],
                "document_amt": float(m.get("document_amt") or 0.0),
                "grantors_assignors": p_info["party1"],
                "grantees_assignees": p_info["party2"],
                "other_parties": p_info["party3"],
                "addresses": addrs,
                "bbls": bbls,
            }
        )
    return results


def attach_ny_complaint_pdfs(
    conn: sqlite3.Connection, pdf_dir: Path
) -> int:
    """
    Scans `pdf_dir` for New York Supreme Court foreclosure Complaint PDFs named
    e.g. `NY_850123-2026_Complaint.pdf` or `KINGS_501234-2026.pdf`, registers
    them in `foreclosure_cases` under the appropriate NY county (`NEW-YORK`,
    `KINGS`, etc.), and marks `complaint_status='downloaded'` so `--extract`
    reads them with `gpt-5.5`.
    """
    ensure_county_schema(conn)
    if not pdf_dir.is_dir():
        return 0

    attached = 0
    for pdf_file in sorted(pdf_dir.glob("*.pdf")):
        m = NY_PDF_RE.search(pdf_file.stem)
        if not m:
            continue
        raw_county, raw_index = m.group(1).upper(), m.group(2).replace("_", "/")
        if "/" not in raw_index and "-" in raw_index:
            parts = raw_index.split("-", 1)
            index_no = f"{parts[0]}/{parts[1]}"
        else:
            index_no = raw_index

        county = "NEW-YORK" if raw_county in ("NY", "NEW_YORK", "NEW-YORK") else raw_county
        case_id = f"NY:{county}:{index_no}"

        data = pdf_file.read_bytes()
        if not data.startswith(b"%PDF"):
            continue
        sha = hashlib.sha256(data).hexdigest()

        existing = conn.execute(
            "SELECT complaint_status, complaint_pdf FROM foreclosure_cases WHERE case_id=?",
            (case_id,),
        ).fetchone()
        if existing and existing["complaint_status"] == "downloaded" and existing["complaint_pdf"] == str(pdf_file):
            continue

        conn.execute(
            """INSERT INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date,
                case_style, case_status, first_seen, complaint_status,
                complaint_pdf, complaint_sha256, attempts, last_attempt, county)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)
               ON CONFLICT(case_id) DO UPDATE SET
                 complaint_status='downloaded',
                 complaint_pdf=excluded.complaint_pdf,
                 complaint_sha256=excluded.complaint_sha256,
                 last_attempt=excluded.last_attempt""",
            (
                case_id,
                index_no,
                f"{county}-FC",
                "NY Commercial / Non-Homestead Mortgage Foreclosure",
                now_iso()[:10],
                None,
                "Open",
                now_iso(),
                "downloaded",
                str(pdf_file),
                sha,
                now_iso(),
                county,
            ),
        )
        attached += 1
    conn.commit()
    return attached


def main() -> None:
    ap = argparse.ArgumentParser(description="New York State / NYC ACRIS & Complaints Collector")
    ap.add_argument("--acris", action="store_true", help="Pull recorded Assignments & Mortgages from NYC ACRIS Open Data")
    ap.add_argument("--boroughs", default="1", help="Comma-separated NYC borough codes (1=Manhattan/NY County, 2=Bronx, 3=Brooklyn, 4=Queens, 5=Staten Island)")
    ap.add_argument("--doc-types", default="ASST,MTGE,AGMT", help="Comma-separated ACRIS doc types (default: ASST,MTGE,AGMT)")
    ap.add_argument("--since", default=None, help="Optional YYYY-MM-DD start date for ACRIS")
    ap.add_argument("--limit", type=int, default=15, help="Max ACRIS records to fetch")
    ap.add_argument("--ingest-dir", default=os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"),
                    help="Directory to scan for NY Complaint PDFs (e.g. NY_850123-2026.pdf)")
    ap.add_argument("--extract", action="store_true", help="Run complaints_extract on downloaded NY complaints")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    args = ap.parse_args()

    if args.acris:
        b_list = [b.strip() for b in args.boroughs.split(",") if b.strip()]
        dt_list = [d.strip().upper() for d in args.doc_types.split(",") if d.strip()]
        rows = fetch_acris_records(boroughs=b_list, doc_types=dt_list, since_date=args.since, limit=args.limit)
        log.info(f"Fetched {len(rows)} NYC ACRIS records (boroughs={b_list}, doc_types={dt_list}):")
        for r in rows:
            p1 = "; ".join(r["grantors_assignors"][:2]) or "—"
            p2 = "; ".join(r["grantees_assignees"][:2]) or "—"
            addr = "; ".join(r["addresses"][:2]) or "—"
            bbl = "; ".join(r["bbls"][:2]) or "—"
            print(
                f"  {r['document_id']} | {r['county']} | {r['doc_type']} | {r['recorded_date']} | "
                f"${r['document_amt']:,.0f} | {p1} -> {p2} | {addr} ({bbl})"
            )

    conn = complaints_collect.connect()
    ensure_county_schema(conn)
    attached = attach_ny_complaint_pdfs(conn, Path(args.ingest_dir))
    if attached:
        log.info(f"Attached {attached} New York Complaint PDF(s) from {args.ingest_dir}")

    if args.extract:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set")
        ex = complaints_extract.process_pending(conn, args.model, key, limit=args.limit, budget_usd=args.budget)
        log.info(f"NY extraction results: {ex}")


if __name__ == "__main__":
    main()
