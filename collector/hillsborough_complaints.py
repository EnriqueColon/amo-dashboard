"""
Hillsborough County Foreclosure Complaints Collector (`hillsborough_complaints.py`)
-----------------------------------------------------------------------------------
Fully automated, hands-free pipeline that discovers Hillsborough Circuit Civil
mortgage foreclosure cases (Commercial and NonHomestead) and enriches them with
the recorded Lis Pendens (`LP`), Court Papers (`CP`), and Mortgage (`MTG`) PDFs
from Hillsborough Official Records — requiring no paid FTP subscription, no
bot-wall scraping, and no manual clicking:

  1. Free Case Discovery (Stage A):
     Reads the Clerk's public daily civil filing CSVs:
       https://publicrec.hillsclerk.com/Civil/dailyfilings/CivilFiling_YYYYMMDD.csv
     Pre-filters to Commercial and NonHomestead Mortgage Foreclosures, tracking
     the Clerk's value band (`-3- $250,000 or More` is the primary candidate band
     for >= $500,000 principal).

  2. Automated Official Records Document Assembly (`fetch_official_records_packet`):
     For each pending candidate case, queries Hillsborough's public Official
     Records Search API (`publicaccess.hillsclerk.com/Public/ORIUtilities/DocumentSearch/api/Search`)
     by `{"PartyName": [defendant/plaintiff]}`:
       • Downloads the case's recorded Lis Pendens (`(LP) LIS PENDENS`), which
         carries the case number, plaintiff attorney block (name, firm, email,
         phone), legal description, property address, and often the exact
         Mortgage instrument number.
       • Checks for any recorded Court Paper (`(CP) COURT PAPER`) such as a
         Voluntary Dismissal & Release of Lis Pendens.
       • Downloads the matching recorded Mortgage (`(MTG) MORTGAGE`) PDF(s),
         which carry the Clerk's statutory Florida Intangible Tax stamp
         (`INT. TAX PD (F.S. 199)` = 0.2% of note principal) and Documentary
         Stamp Tax (`DOC TAX PD (F.S. 201.08)` = 0.35% of note principal) on
         Page 1, plus the full Mortgage text, Note amount, Maturity Date,
         Property Address, Right to Reinstate clause, and all recorded Riders.
     Combines the Lis Pendens + Court Papers + Mortgage PDFs into a single
     case packet PDF under `COMPLAINTS_DIR` (`complaints_pdfs/`) so
     `complaints_reader.py` + `complaints_extract.py` + `complaints_address.py`
     can extract all 41 fields automatically.

  3. Full Complaint PDF Override (`attach_local_complaint_pdfs`):
     If a full court Complaint PDF is also dropped in `COMPLAINTS_DIR` or
     supplied via `extract_from_page_text_payload`, it takes precedence.

Usage:
  python hillsborough_complaints.py --daily --fetch-or --extract
  python hillsborough_complaints.py --csv path/to/CivilFiling_20261030.csv
"""

import argparse
import csv
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402
import complaints_extract  # noqa: E402
import extract_pdfs  # noqa: E402

COUNTY = "HILLSBOROUGH"
DAILY_FILINGS_BASE = os.environ.get(
    "HILLSBOROUGH_CIVIL_DAILY_URL",
    "https://publicrec.hillsclerk.com/Civil/dailyfilings/",
)
OR_SEARCH_URL = (
    os.environ.get("HILLSBOROUGH_API_URL", "https://publicaccess.hillsclerk.com")
    + "/Public/ORIUtilities/DocumentSearch/api/Search"
)
HTTP_TIMEOUT = 90

# Case types in scope: Commercial & NonHomestead Circuit Civil Mortgage Foreclosures
TARGET_CASE_TYPES = {
    "Mortgage Foreclosure - Commercial -1- $50,000 or Less": ("HC-COM-1", False),
    "Mortgage Foreclosure - Commercial -2- $50,001 - $249,999": ("HC-COM-2", False),
    "Mortgage Foreclosure - Commercial -3- $250,000 or More": ("HC-COM-3", True),
    "Mortgage Foreclosure - NonHomestead -1- $50,000 or Less": ("HC-NH-1", False),
    "Mortgage Foreclosure - NonHomestead -2- $50,001 - $249,999": ("HC-NH-2", False),
    "Mortgage Foreclosure - NonHomestead -3- $250,000 or More": ("HC-NH-3", True),
}

# Match case numbers like 26-CA-011777 or 2026-CA-011777
HC_CASE_RE = re.compile(r"(\d{2,4}-CA-\d{5,7})", re.I)

# Florida statutory documentary stamp & intangible tax header on Hillsborough Mortgages:
#   INT. TAX PD (F.S. 199) $1047.20, DOC TAX PD (F.S. 201.08) $1832.60
#   Intangible tax is exactly 2 mills ($0.002 per $1.00 of new note principal).
INT_TAX_RE = re.compile(r"INT\.?\s*TAX\s*PD[^$\d]{0,25}\$?\s*([\d,]+\.\d{2})", re.I)
DOC_TAX_RE = re.compile(r"DOC\.?\s*TAX\s*PD[^$\d]{0,25}\$?\s*([\d,]+\.\d{2})", re.I)

_GENERIC_PARTY_PREFIXES = (
    "UNKNOWN ",
    "THE UNKNOWN ",
    "UNITED STATES",
    "STATE OF FLORIDA",
    "CITY OF TAMPA",
    "HILLSBOROUGH COUNTY",
    "CLERK OF THE COURT",
    "FLORIDA HOUSING FINANCE",
    "MORTGAGE ELECTRONIC REGISTRATION",
    "MERS",
    "DEPARTMENT OF ",
)
_GENERIC_PARTY_WORDS = (
    "HOMEOWNERS ASSOCIATION",
    "HOMEOWNERS' ASSOCIATION",
    "COMMUNITY ASSOCIATION",
    "CONDOMINIUM ASSOCIATION",
    "PROPERTY OWNERS ASSOCIATION",
    "MASTER ASSOCIATION",
    "CLUBHOUSE",
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hillsborough_complaints")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_county_schema(conn: sqlite3.Connection) -> None:
    """
    Ensures `foreclosure_cases` and `foreclosure_runs` exist and adds the `county`
    and `metadata_json` columns if migrating from the Miami-Dade-only schema.
    (The shared implementation lives in complaints_collect; every county uses it.)
    """
    complaints_collect.ensure_county_schema(conn)


def match_target_case_type(desc: str) -> Optional[Tuple[str, str, bool]]:
    """
    Returns (case_type_code, normalized_desc, is_band3_candidate) if `desc` is a
    Hillsborough Commercial or NonHomestead Mortgage Foreclosure, else None.
    """
    clean = " ".join((desc or "").strip().split())
    if clean in TARGET_CASE_TYPES:
        code, is_cand = TARGET_CASE_TYPES[clean]
        return code, clean, is_cand

    low = clean.lower()
    if "mortgage foreclosure" not in low:
        return None
    if "homestead" in low and "nonhomestead" not in low and "non-homestead" not in low:
        return None  # Exclude owner-occupied Homestead foreclosures
    if low.startswith("cc "):
        return None  # Exclude County Civil (<=$50k)

    is_comm = "commercial" in low
    is_nh = "nonhomestead" in low or "non-homestead" in low
    if not (is_comm or is_nh):
        return None

    prefix = "HC-COM" if is_comm else "HC-NH"
    if "-3-" in low or "250,000" in low:
        return f"{prefix}-3", clean, True
    if "-2-" in low or "50,001" in low or "50,000 - 249,999" in low or "50,000 - $249,999" in low:
        return f"{prefix}-2", clean, False
    if "-1-" in low:
        return f"{prefix}-1", clean, False
    return f"{prefix}-3", clean, True


def parse_daily_csv_text(csv_text: str) -> List[Dict[str, Any]]:
    """
    Parses a Hillsborough `CivilFiling_YYYYMMDD.csv` file (which has one row per
    party) and groups rows by `CaseNumber` into structured foreclosure case records.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    by_case: Dict[str, Dict[str, Any]] = {}

    for raw_row in reader:
        # Handle slight header-name variations across Clerk exports (ignore None overflow key if unquoted comma)
        row = {
            (k or "").strip(): (v.strip() if isinstance(v, str) else " ".join(v).strip())
            for k, v in raw_row.items()
            if k is not None
        }
        case_type_desc = (
            row.get("CaseTypeDescription")
            or row.get("Case Type Description")
            or row.get("CaseType")
            or ""
        )
        matched = match_target_case_type(case_type_desc)
        if not matched:
            continue

        code, norm_desc, is_band3 = matched
        case_num = (
            row.get("CaseNumber")
            or row.get("Case Number")
            or row.get("CaseNbr")
            or ""
        ).upper()
        if not case_num:
            continue

        filing_raw = (
            row.get("FilingDate")
            or row.get("Filing Date")
            or row.get("FileDate")
            or ""
        )
        filing_iso = complaints_collect.iso_date(filing_raw)
        title = row.get("Title") or row.get("CaseStyle") or row.get("Style") or ""

        entry = by_case.setdefault(
            case_num,
            {
                "case_id": f"HC:{case_num}",
                "case_number": case_num,
                "case_type_code": code,
                "case_type": norm_desc,
                "filing_date": filing_iso,
                "case_style": title,
                "is_band3_candidate": is_band3,
                "plaintiffs": [],
                "defendants": [],
                "party_addresses": [],
                "attorneys": [],
            },
        )

        # Party details
        ptype = (row.get("PartyType") or row.get("Party Type") or "").upper()
        first = row.get("FirstName") or row.get("First Name") or ""
        mid = row.get("MiddleName") or row.get("Middle Name") or ""
        last_or_co = (
            row.get("LastName/CompanyName")
            or row.get("LastName")
            or row.get("CompanyName")
            or row.get("Name")
            or ""
        )
        full_name = " ".join(x for x in (first, mid, last_or_co) if x).strip()
        if full_name:
            if "PLAIN" in ptype or "PETIT" in ptype:
                if full_name not in entry["plaintiffs"]:
                    entry["plaintiffs"].append(full_name)
            elif "DEF" in ptype or "RESP" in ptype:
                if full_name not in entry["defendants"]:
                    entry["defendants"].append(full_name)

        paddr = row.get("PartyAddress") or row.get("Address") or ""
        if paddr and paddr not in entry["party_addresses"]:
            entry["party_addresses"].append(paddr)

        atty = row.get("Attorney") or row.get("AttorneyName") or ""
        if atty and atty not in entry["attorneys"]:
            entry["attorneys"].append(atty)

        if not entry["case_style"] and (entry["plaintiffs"] or entry["defendants"]):
            p_str = entry["plaintiffs"][0] if entry["plaintiffs"] else "UNKNOWN"
            d_str = entry["defendants"][0] if entry["defendants"] else "UNKNOWN"
            entry["case_style"] = f"{p_str} VS {d_str}"

    return list(by_case.values())


def store_discovered_cases(
    conn: sqlite3.Connection, cases: List[Dict[str, Any]], band3_only: bool = False
) -> Tuple[int, int]:
    """
    Inserts discovered Hillsborough foreclosure cases into `foreclosure_cases` with
    `county='HILLSBOROUGH'`. Returns `(total_in_scope, newly_inserted)`.
    """
    ensure_county_schema(conn)
    found = new = 0
    for c in cases:
        if band3_only and not c.get("is_band3_candidate", True):
            continue
        found += 1
        meta = {
            "plaintiffs": c.get("plaintiffs", []),
            "defendants": c.get("defendants", []),
            "party_addresses": c.get("party_addresses", []),
            "attorneys": c.get("attorneys", []),
            "is_band3_candidate": c.get("is_band3_candidate", True),
        }
        is_b3 = c.get("is_band3_candidate", True)
        status = "pending" if is_b3 else "below_band_threshold"
        note_text = (
            None
            if is_b3
            else "Band 1/2 (<$250k claim band) — below $500k threshold"
        )
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date,
                case_style, case_status, first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                c["case_id"],
                c["case_number"],
                c["case_type_code"],
                c["case_type"],
                c["filing_date"],
                c["case_style"],
                "Open",
                now_iso(),
                status,
                note_text,
                COUNTY,
                json.dumps(meta),
            ),
        )
        new += cur.rowcount
    conn.commit()
    return found, new


def list_daily_csv_urls(session: Optional[requests.Session] = None) -> List[Tuple[str, str]]:
    """
    Lists `(YYYY-MM-DD, url)` for every `CivilFiling_YYYYMMDD.csv` on the Clerk's
    public directory.
    """
    s = session or requests.Session()
    resp = s.get(DAILY_FILINGS_BASE, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    out: List[Tuple[str, str]] = []
    for fname in re.findall(r'href="[^"]*?(CivilFiling_(\d{8})\.csv)"', resp.text, flags=re.I):
        name, ymd = fname[0], fname[1]
        day_iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
        url = DAILY_FILINGS_BASE.rstrip("/") + "/" + name
        out.append((day_iso, url))
    out.sort()
    return out


# ── Official Records Automated Lookup (LP + CP + MTG) ────────────────────────

def parse_statutory_loan_amount(page1_text: str) -> Optional[float]:
    """
    Computes the statutory note principal from the Hillsborough Clerk's recording
    stamp on Page 1 of a Mortgage:
      • `INT. TAX PD (F.S. 199)` = $0.002 per $1.00 of note principal (exact to the cent).
      • `DOC TAX PD (F.S. 201.08)` = $0.35 per $100 (or fraction thereof).
    """
    m_int = INT_TAX_RE.search(page1_text or "")
    if m_int:
        try:
            tax = float(m_int.group(1).replace(",", ""))
            if tax > 0:
                return round(tax / 0.002, 2)
        except ValueError:
            pass
    m_doc = DOC_TAX_RE.search(page1_text or "")
    if m_doc:
        try:
            tax = float(m_doc.group(1).replace(",", ""))
            if tax > 0:
                return round((tax / 0.35) * 100.0, 2)
        except ValueError:
            pass
    return None


def _is_primary_borrower_candidate(name: str) -> bool:
    u = " ".join((name or "").upper().split())
    if not u or len(u) < 4:
        return False
    if any(u.startswith(p) for p in _GENERIC_PARTY_PREFIXES):
        return False
    if any(w in u for w in _GENERIC_PARTY_WORDS):
        return False
    return True


def _search_name_variants(raw_name: str) -> List[str]:
    """
    Hillsborough Official Records indexes entities as `SM BUILDERS LLC` and natural
    persons as `LASTNAME FIRSTNAME`. Produces 1-2 clean search strings for `PartyName`.
    """
    clean = re.sub(r"\b(A/K/A|AKA|F/K/A|FKA|INDIVIDUALLY)\b.*", "", raw_name, flags=re.I)
    clean = re.sub(r"[.,;()\"']", " ", clean).upper()
    clean = " ".join(clean.split())
    if not clean:
        return []

    corp_words = {"LLC", "INC", "CORP", "CORPORATION", "COMPANY", "TRUST", "BANK", "LP", "LTD", "HOLDINGS", "GROUP", "PROPERTIES", "INVESTMENTS", "BUILDERS", "REALTY", "CONSULTANTS", "SERVICES"}
    toks = clean.split()
    if any(t in corp_words for t in toks):
        # Strip trailing legal suffix for broader prefix match in OR search
        core = [t for t in toks if t not in {"LLC", "INC", "CORP", "CORPORATION", "LP", "LTD", "A", "FLORIDA", "DELAWARE", "WYOMING", "LIMITED", "LIABILITY"}]
        variants = [" ".join(core[:4]) if core else clean]
        if clean not in variants:
            variants.append(clean)
        return variants

    # Natural person: CSV has "First Middle Last" -> OR indexes "LAST FIRST"
    if len(toks) >= 2:
        last_first = f"{toks[-1]} {toks[0]}"
        two_last_first = f"{toks[-2]} {toks[-1]} {toks[0]}" if len(toks) >= 3 else last_first
        out = [last_first]
        if two_last_first != last_first:
            out.append(two_last_first)
        return out
    return [clean]


def search_or_by_party(party_query: str, session: Optional[requests.Session] = None) -> List[Dict[str, Any]]:
    s = session or requests.Session()
    resp = s.post(OR_SEARCH_URL, json={"PartyName": [party_query]}, timeout=60)
    if resp.status_code != 200:
        return []
    return resp.json().get("ResultList") or []


def combine_pdfs(pdf_paths: List[Path], dest_path: Path) -> bool:
    """
    Combines multiple PDFs (`LP` + `CP` + `MTG`) into a single PDF at `dest_path`.
    Uses `pdfunite` (poppler) if available, otherwise copies the primary PDF.
    """
    valid = [p for p in pdf_paths if p.exists() and p.stat().st_size > 0]
    if not valid:
        return False
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if len(valid) == 1 or not shutil.which("pdfunite"):
        shutil.copyfile(valid[-1], dest_path)
        return True
    try:
        subprocess.run(
            ["pdfunite", *[str(p) for p in valid], str(dest_path)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        return dest_path.exists() and dest_path.stat().st_size > 0
    except Exception:
        shutil.copyfile(valid[-1], dest_path)
        return True


def fetch_official_records_packet_for_case(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    pdf_dir: Path,
    session: Optional[requests.Session] = None,
) -> str:
    """
    Queries Hillsborough Official Records for a pending foreclosure case's Lis Pendens,
    Court Papers, and recorded Mortgage(s), downloads the PDFs, and saves a combined
    packet PDF so `complaints_extract.py` can read it automatically.
    """
    import complaints_reader

    s = session or requests.Session()
    meta = json.loads(row["metadata_json"] or "{}")
    defendants = [d for d in (meta.get("defendants") or []) if _is_primary_borrower_candidate(d)]
    if not defendants:
        return "no_borrower_candidate"

    or_rows_by_inst: Dict[str, Dict[str, Any]] = {}
    for d_name in defendants[:3]:
        for query in _search_name_variants(d_name):
            for item in search_or_by_party(query, s):
                inst = str(item.get("Instrument") or "").strip()
                if inst:
                    or_rows_by_inst[inst] = item
            time.sleep(0.3)
            if or_rows_by_inst:
                break

    if not or_rows_by_inst:
        return "or_not_found"

    all_or = sorted(
        or_rows_by_inst.values(),
        key=lambda x: int(x.get("Instrument") or 0),
        reverse=True,
    )

    lps = [r for r in all_or if "(LP)" in (r.get("DocType") or "")]
    cps = [r for r in all_or if "(CP)" in (r.get("DocType") or "")]
    mtgs = [r for r in all_or if "(MTG" in (r.get("DocType") or "")]
    sats = {
        str(r.get("Instrument"))
        for r in all_or
        if "(SAT)" in (r.get("DocType") or "") or "(REL)" in (r.get("DocType") or "")
    }

    with tempfile.TemporaryDirectory(prefix="hc_or_") as tmp:
        tmp_path = Path(tmp)
        packet_parts: List[Path] = []
        referenced_mtg_insts: List[str] = []

        # 1. Download latest Lis Pendens (if recorded yet) and check for explicit Mortgage instrument reference
        if lps:
            lp_inst = str(lps[0]["Instrument"])
            lp_pdf = tmp_path / f"LP_{lp_inst}.pdf"
            if extract_pdfs.download_hillsborough_pdf(lp_inst, str(lp_pdf)):
                packet_parts.append(lp_pdf)
                try:
                    lp_read = complaints_reader.read_complaint(lp_pdf)
                    lp_txt = "\n".join(p["text"] for p in lp_read["pages"])
                    for m_inst in re.findall(r"\b(20\d{8}|19\d{8})\b", lp_txt):
                        if m_inst != lp_inst and m_inst not in referenced_mtg_insts:
                            referenced_mtg_insts.append(m_inst)
                except Exception:
                    pass

        # 2. Download any recent Court Paper (e.g., Voluntary Dismissal) recorded after or alongside LP
        if cps and lps and int(cps[0]["Instrument"]) >= int(lps[0]["Instrument"]):
            cp_inst = str(cps[0]["Instrument"])
            cp_pdf = tmp_path / f"CP_{cp_inst}.pdf"
            if extract_pdfs.download_hillsborough_pdf(cp_inst, str(cp_pdf)):
                packet_parts.append(cp_pdf)

        # 3. Select the active Mortgage(s): either explicitly cited in LP or most recent Mortgage(s)
        chosen_mtg_insts: List[str] = []
        for ref_inst in referenced_mtg_insts:
            chosen_mtg_insts.append(ref_inst)

        if not chosen_mtg_insts and mtgs:
            # Take most recent mortgage (and any sibling mortgage recorded the same week for multi-unit deals like SM Builders)
            top_inst = int(mtgs[0]["Instrument"])
            for m in mtgs[:3]:
                m_inst = int(m["Instrument"])
                if abs(top_inst - m_inst) <= 5000:
                    chosen_mtg_insts.append(str(m_inst))

        if not chosen_mtg_insts:
            return "no_mortgage_in_or"

        mtg_pdfs: List[Path] = []
        statutory_principals: List[float] = []
        for m_inst in chosen_mtg_insts[:2]:
            m_pdf = tmp_path / f"MTG_{m_inst}.pdf"
            if extract_pdfs.download_hillsborough_pdf(m_inst, str(m_pdf)):
                mtg_pdfs.append(m_pdf)
                packet_parts.append(m_pdf)
                try:
                    p1 = complaints_reader.text_layer(m_pdf, 1)
                    if complaints_reader.readable_ratio(p1)[1] < 10:
                        p1 = complaints_reader.ocr_page(m_pdf, 1)
                    amt = parse_statutory_loan_amount(p1)
                    if amt:
                        statutory_principals.append(amt)
                except Exception:
                    pass

        if not mtg_pdfs:
            return "mortgage_download_failed"

        dest = pdf_dir / f"HC_{row['case_number']}_OR_PACKET.pdf"
        if not combine_pdfs(packet_parts, dest):
            return "combine_failed"

        data = dest.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        meta["or_mortgage_instruments"] = chosen_mtg_insts[:2]
        meta["or_lp_instrument"] = str(lps[0]["Instrument"]) if lps else None
        meta["statutory_principals_usd"] = statutory_principals
        meta["document_source"] = "official_records_packet"

        conn.execute(
            """UPDATE foreclosure_cases
               SET complaint_status='downloaded', complaint_pdf=?, complaint_sha256=?,
                   attempts=attempts+1, last_attempt=?, note=?, metadata_json=?
               WHERE case_id=?""",
            (
                str(dest),
                sha,
                now_iso(),
                f"Official Records packet: MTG {', '.join(chosen_mtg_insts[:2])}",
                json.dumps(meta),
                row["case_id"],
            ),
        )
        conn.commit()
        return "downloaded"


def fetch_pending_official_records(
    conn: sqlite3.Connection, pdf_dir: Path, limit: Optional[int] = None
) -> Dict[str, int]:
    """
    Automatically resolves pending Band-3 Hillsborough cases by building their
    Official Records (`LP` + `CP` + `MTG`) PDF packet.
    """
    ensure_county_schema(conn)
    rows = conn.execute(
        """SELECT * FROM foreclosure_cases
           WHERE county=? AND complaint_status='pending'
           ORDER BY filing_date DESC, case_number DESC""",
        (COUNTY,),
    ).fetchall()
    if limit:
        rows = rows[:limit]

    counts: Dict[str, int] = {}
    s = requests.Session()
    for r in rows:
        try:
            st = fetch_official_records_packet_for_case(conn, r, pdf_dir, s)
        except Exception as e:
            st = "error"
            log.warning(f"  OR fetch error on {r['case_number']}: {e}")
        counts[st] = counts.get(st, 0) + 1
    return counts


def attach_local_complaint_pdfs(
    conn: sqlite3.Connection, pdf_dir: Path
) -> int:
    """
    Matches any PDF in `pdf_dir` whose filename contains a Hillsborough case number
    (e.g. `26-CA-011777.pdf` or `HC_26-CA-011777_COMPLAINT.pdf`) to its row in
    `foreclosure_cases` and marks `complaint_status='downloaded'` so
    `complaints_extract.process_pending()` will read and extract all 41 fields.
    """
    ensure_county_schema(conn)
    if not pdf_dir.is_dir():
        return 0

    matched = 0
    for pdf_file in sorted(pdf_dir.glob("*.pdf")):
        if pdf_file.name.endswith("_OR_PACKET.pdf"):
            continue
        m = HC_CASE_RE.search(pdf_file.name)
        if not m:
            continue
        case_num = m.group(1).upper()
        short_num = re.sub(r"^20(\d{2}-CA-)", r"\1", case_num)

        row = conn.execute(
            """SELECT case_id, complaint_status, complaint_pdf FROM foreclosure_cases
               WHERE county=? AND (UPPER(case_number)=? OR UPPER(case_number)=?)""",
            (COUNTY, case_num, short_num),
        ).fetchone()
        if not row:
            continue
        if row["complaint_status"] == "downloaded" and row["complaint_pdf"] == str(pdf_file):
            continue

        data = pdf_file.read_bytes()
        if not data.startswith(b"%PDF"):
            continue
        sha = hashlib.sha256(data).hexdigest()
        conn.execute(
            """UPDATE foreclosure_cases
               SET complaint_status='downloaded', complaint_pdf=?, complaint_sha256=?,
                   attempts=attempts+1, last_attempt=?, note=NULL
               WHERE case_id=?""",
            (str(pdf_file), sha, now_iso(), row["case_id"]),
        )
        matched += 1
    conn.commit()
    return matched


def extract_from_page_text_payload(
    conn: sqlite3.Connection,
    case_id: str,
    pages_text: List[str],
    model: str,
    api_key: str,
    source_label: str = "text_payload",
) -> Dict[str, Any]:
    """
    Runs the full `complaints_extract.py` pipeline directly over page-numbered text
    and stores the result in `foreclosure_extractions`.
    """
    ensure_county_schema(conn)
    conn.executescript(complaints_extract.STORE_SCHEMA)
    read_obj = {
        "file": source_label,
        "page_count": len(pages_text),
        "ocr_pages": 0,
        "pages": [
            {"page": idx + 1, "method": "text", "words": len(txt.split()), "readable": 1.0, "text": txt}
            for idx, txt in enumerate(pages_text)
        ],
    }
    res = complaints_extract.extract(read_obj, model, api_key)
    u = res.get("_usage", {})
    conn.execute(
        "INSERT OR REPLACE INTO foreclosure_extractions VALUES (?,?,?,?,?,?,?)",
        (
            case_id,
            model,
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
            None if res["computed_meets_criteria"] is None else int(res["computed_meets_criteria"]),
            u.get("prompt_tokens") or 0,
            u.get("completion_tokens") or 0,
            json.dumps(res),
        ),
    )
    conn.execute(
        "UPDATE foreclosure_cases SET complaint_status='downloaded', last_attempt=? WHERE case_id=?",
        (now_iso(), case_id),
    )
    conn.commit()
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description="Hillsborough Foreclosure Complaints Collector")
    ap.add_argument("--daily", action="store_true", help="Fetch recent daily CivilFiling CSVs from Clerk")
    ap.add_argument("--days", type=int, default=7, help="How many recent daily CSV files to pull")
    ap.add_argument("--csv", type=str, help="Ingest a local CivilFiling_YYYYMMDD.csv file")
    ap.add_argument("--band3-only", action="store_true", help="Store only Band 3 ($250,000+) cases")
    ap.add_argument("--fetch-or", action="store_true", help="Automatically assemble LP + Mortgage PDF packets from Hillsborough Official Records")
    ap.add_argument("--limit", type=int, default=None, help="Max cases to fetch/extract in one run")
    ap.add_argument("--ingest-dir", type=str, default=os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"),
                    help="Directory to store/scan complaint PDFs")
    ap.add_argument("--extract", action="store_true", help="Run complaints_extract on downloaded packets/complaints")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    args = ap.parse_args()

    conn = complaints_collect.connect()
    ensure_county_schema(conn)
    pdf_dir = Path(args.ingest_dir)

    total_found = total_new = 0
    if args.csv:
        csv_text = Path(args.csv).read_text(encoding="cp1252", errors="replace")
        cases = parse_daily_csv_text(csv_text)
        f, n = store_discovered_cases(conn, cases, band3_only=args.band3_only)
        total_found += f
        total_new += n
        log.info(f"Local CSV {args.csv}: {f} foreclosure cases in scope ({n} new)")

    if args.daily:
        s = requests.Session()
        urls = list_daily_csv_urls(s)
        for day_iso, url in urls[-args.days:]:
            resp = s.get(url, timeout=HTTP_TIMEOUT)
            resp.raise_for_status()
            cases = parse_daily_csv_text(resp.content.decode("cp1252", errors="replace"))
            f, n = store_discovered_cases(conn, cases, band3_only=args.band3_only)
            total_found += f
            total_new += n
            log.info(f"  {day_iso}: {f} in-scope foreclosure cases ({n} new)")

    attached = attach_local_complaint_pdfs(conn, pdf_dir)
    if attached:
        log.info(f"Attached {attached} direct complaint PDF(s) from {pdf_dir}")

    if args.fetch_or:
        or_counts = fetch_pending_official_records(conn, pdf_dir, limit=args.limit)
        log.info(f"Official Records packet assembly results: {or_counts}")

    if args.extract:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set")
        ex = complaints_extract.process_pending(conn, args.model, key, limit=args.limit, budget_usd=args.budget)
        log.info(f"Extraction results: {ex}")


if __name__ == "__main__":
    main()
