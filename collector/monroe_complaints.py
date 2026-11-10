"""Monroe County foreclosure complaints: find the cases, download the complaint.

Monroe's Clerk court-records site (cr.monroe-clerk.com) needs no sign-in. A search by case type and file
date fills a session; the result list, each case's parties and docket come back as JSON from the site's
own grid endpoints, and each public docket document is a PDF. Cases land in `foreclosure_cases`
(county 'MONROE', case_id 'MO:<Clerk CaseId>') and the shared reader/extractor (complaints_reader,
complaints_extract, complaints_address) read them like any other county's complaint.

Scope (same rule as Duval): Commercial Foreclosure and Non-Homestead Residential Foreclosure. Monroe files
most new cases under the generic types with no claim band ("Commercial Foreclosure", "Non-Homestead
Residential Foreclosure"); those cannot be ruled out on the band, so their complaints are read. The
"$250,000 or More" band is read too; the lower bands are stored (`below_band_threshold`, never fetched)
unless --include-lower-band is given. The docket's "Claim Amount at Filing" entry is kept in metadata, and
a range with a ceiling under $250,000 ("$50,001 - $75,000") rules the case out before the complaint is
downloaded; "Over $100,000.00" does not, so that complaint is read.

Only documents the docket marks public (security group PUB) are downloaded. Anything else (view on
request, pending redaction, sealed) is `complaint_not_public` and retried weekly for RETRY_WEEKS weeks;
this collector never requests a release. No CAPTCHA is shown anywhere on this route; if one ever appears,
or the site answers 403/429, the run stops (exit 3) and nothing solves it.

Usage:
  python monroe_complaints.py --days 10 --extract
  python monroe_complaints.py --from 2026-10-01 --to 2026-11-10 --search-only
Env: AMO_DB_PATH, COMPLAINTS_DIR, OPENAI_API_KEY (--extract).
See docs/MONROE_COMPLAINTS.md.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402

COUNTY = "MONROE"
ID_PREFIX = "MO:"
PDF_DIR = Path(os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"))
BASE = "https://cr.monroe-clerk.com"
UA = "amo-dashboard collector (court records research)"

# The Clerk's CaseTypes codes (from the Circuit Civil search form). Lower bands are searched only so they
# are stored as below_band_threshold; Homestead Residential and the retired "DO NOT USE" types are out of scope.
CASE_TYPES = ["24611", "20593", "20592", "20591", "27096",           # Commercial: generic, $250k+, lower bands
              "24613", "20599", "20598", "20597", "27097"]           # Non-Homestead Residential: same
WINDOW_DAYS = 7          # search window; the site caps a search at 500 results
PAGE_SIZE = 100
CASE_PAUSE = 2.0         # seconds between case loads
SEARCH_PAUSE = 2.0
IMAGE_PAUSE = 2.5
RETRY_WEEKS = 8
EASTERN = ZoneInfo("America/New_York")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class BlockedError(RuntimeError):
    """The site answered with a CAPTCHA, 403 or 429. The run stops; nothing works around it."""


class MonroeSession:
    def __init__(self):
        import requests
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA

    def _check(self, r):
        html = "html" in (r.headers.get("content-type") or "")
        if r.status_code in (403, 429) or (html and re.search(rb"recaptcha|hcaptcha|turnstile|captcha", r.content[:200000], re.I)):
            raise BlockedError(f"{r.request.method} {r.url.split('?')[0]} -> HTTP {r.status_code}"
                               + (" with a CAPTCHA" if r.status_code not in (403, 429) else ""))
        r.raise_for_status()
        return r

    def _grid(self, path: str, page: int = 1) -> dict:
        r = self._check(self.s.post(BASE + path, data={"sort": "", "page": page, "pageSize": PAGE_SIZE, "group": "", "filter": ""},
                                    headers={"X-Requested-With": "XMLHttpRequest"}, timeout=60))
        return r.json()

    def search(self, d_from: date, d_to: date) -> list[dict]:
        """Every case of CASE_TYPES filed d_from..d_to (inclusive), as the site's result-grid rows."""
        page = self._check(self.s.get(BASE + "/Attorney/SearchCriteria", params={"caseType": "CV"}, timeout=60)).text
        tok = re.search(r'name="__RequestVerificationToken" type="hidden" value="([^"]+)"', page)
        if not tok:
            raise RuntimeError("search form has no anti-forgery token; the site layout changed")
        form = [("__RequestVerificationToken", tok.group(1)), ("CaseTypeGroup", "CV")]
        form += [("CaseTypes", c) for c in CASE_TYPES]
        form += [("DateFrom", f"{d_from.month}/{d_from.day}/{d_from.year}"), ("DateTo", f"{d_to.month}/{d_to.day}/{d_to.year}"),
                 ("CaseNumber", ""), ("LastName", ""), ("FirstName", ""), ("MiddleName", ""), ("BusinessName", "")]
        self._check(self.s.post(BASE + "/Attorney/SearchCriteria", data=form, timeout=60))
        rows, pg = [], 1
        while True:
            d = self._grid("/Attorney/ReadCaseList", pg)
            rows += d.get("Data") or []
            if len(rows) >= (d.get("Total") or 0) or not d.get("Data"):
                return rows
            pg += 1
            time.sleep(SEARCH_PAUSE)

    def case(self, enc_id: str) -> dict:
        """Parties and docket of one case. enc_id is the search row's EncryptCaseId (stable across sessions)."""
        r = self._check(self.s.post(BASE + "/Attorney/SessionStartTimeEncrypted", data={"UserId": enc_id, "viewname": "CaseDetails"},
                                    headers={"X-Requested-With": "XMLHttpRequest"}, timeout=60))
        q = r.url.split("?", 1)[1] if "?" in r.url and "Render_CaseDetails" in r.url else None
        if not q:
            raise RuntimeError(f"case {enc_id}: no case-details redirect")
        return {"header_html": r.text,
                "parties": self._grid("/Attorney/ReadPartyListDetails?" + q).get("Data") or [],
                "docket": self._grid("/Attorney/ReadDocketDetails?" + q).get("Data") or []}

    def pdf(self, version_string: str) -> bytes:
        """The document as a PDF. Scanned filings stored as TIFF open in the site's HTML5 viewer instead; those
        are taken through the viewer's own Download control and wrapped into a PDF (see tiff_to_pdf)."""
        self._check(self.s.get(BASE + "/DocView/EncryptDate?requestString=" + quote(version_string, safe=""),
                               headers={"X-Requested-With": "XMLHttpRequest"}, timeout=60))
        r = self._check(self.s.get(BASE + "/DocView/Doc", timeout=180))
        if r.content.startswith(b"%PDF"):
            return r.content
        m = re.search(r"'(DocumentViewer\.axd/docs/[0-9a-f-]+)'", r.text or "")
        if not m:
            raise RuntimeError(f"document response is not a PDF ({r.headers.get('content-type')}, {len(r.content)} bytes)")
        doc = BASE + "/DocView/" + m.group(1)
        self._check(self.s.get(doc + "/info", timeout=60))
        t = self._check(self.s.get(doc + "/download", timeout=180))
        try:
            self.s.get(doc + "/dispose", timeout=30)
        except Exception:
            pass
        if t.content[:4] not in (b"II*\x00", b"MM\x00*"):
            raise RuntimeError(f"viewer download is not a TIFF ({t.headers.get('content-type')}, {len(t.content)} bytes)")
        return tiff_to_pdf(t.content)


def tiff_to_pdf(data: bytes) -> bytes:
    """Multi-page TIFF -> PDF with tesseract (already required by complaints_reader). The PDF carries the scan
    plus tesseract's text layer, so the reader takes the text layer and does not OCR the pages a second time."""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d) / "doc.tiff", Path(d) / "doc"
        src.write_bytes(data)
        subprocess.run(["tesseract", str(src), str(out), "pdf"], check=True, capture_output=True, timeout=1800)
        return (Path(d) / "doc.pdf").read_bytes()


# --------------------------------------------------------------------------- parsing
def ms_date(v: str | None) -> str | None:
    """'/Date(1793941200000)/' (midnight Eastern) -> '2026-11-06'."""
    m = re.search(r"\((-?\d+)", v or "")
    return datetime.fromtimestamp(int(m.group(1)) / 1000, EASTERN).date().isoformat() if m else None


def band_of(case_type: str) -> tuple[str, bool]:
    """('MO-COM-U', True) for the band-less 'Commercial Foreclosure'. True = could hold >= $500k, so read it."""
    low = " ".join((case_type or "").lower().split())
    kind = "COM" if low.startswith("commercial foreclosure") else "NH" if low.startswith("non-homestead residential foreclosure") else None
    if not kind:
        return "MO-OTHER", False
    if "250,000 or more" in low:
        return f"MO-{kind}-3", True
    if "$" in low:
        return f"MO-{kind}-LOW", False
    return f"MO-{kind}-U", True


def clean(s: str | None) -> str:
    return " ".join((s or "").split())


def parse_parties(rows: list[dict]) -> dict:
    out = {"plaintiffs": [], "defendants": [], "attorneys": [], "attorney_phones": []}
    for p in rows:
        name, role, atty = clean(p.get("FullName")), clean(p.get("PartyConnDesc")).upper(), clean(p.get("AttorneyFullName"))
        if role == "PLAINTIFF" and name and name not in out["plaintiffs"]:
            out["plaintiffs"].append(name)
        elif role == "DEFENDANT" and name and name not in out["defendants"]:
            out["defendants"].append(name)
        if role == "PLAINTIFF" and atty and atty not in out["attorneys"]:
            out["attorneys"].append(atty)
            if p.get("AttyWorkPhone"):
                out["attorney_phones"].append(clean(p["AttyWorkPhone"]))
    return out


def parse_header(html: str) -> dict:
    """Case Type / Date Filed / Location / UCN / Judge / Status from the case-details window."""
    text = clean(re.sub(r"<[^>]+>", " ", re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html or "")))
    out = {}
    for key, label in [("case_type", "Case Type"), ("file_date", "Date Filed"), ("location", "Location"),
                       ("ucn", "UCN"), ("judge", "Judge"), ("status", "Status")]:
        m = re.search(rf"{label}:\s*(.*?)\s+(?:Date Filed|Location|UCN|Judge|Status|Citation Number|Appear By Date|Parties):", text)
        out[key] = m.group(1).strip() if m and m.group(1).strip() else None
    if out.get("file_date"):
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", out["file_date"])
        out["file_date"] = f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None
    return out


def pick_complaint(docket: list[dict]) -> dict | None:
    """Earliest 'Complaint' entry that has pages (an amended complaint is a later, separately coded entry)."""
    comps = [d for d in docket
             if (d.get("EventTypeCode") == "CAC" or re.match(r"\s*(verified\s+)?complaint\b", d.get("EventTypeDesc") or "", re.I))
             and not re.search(r"amended", d.get("EventTypeDesc") or "", re.I)]
    with_pages = [d for d in comps if d.get("DocPageCount")]
    comps = with_pages or comps
    comps.sort(key=lambda d: (ms_date(d.get("EventDate")) or "9999", d.get("EventId") or 0))
    return comps[0] if comps else None


def claim_entry(docket: list[dict]) -> str | None:
    for d in docket:
        if (d.get("EventTypeCode") or "").startswith("CLAIM"):
            return clean(d.get("EventTypeDesc"))
    return None


def claim_ceiling(text: str | None) -> int | None:
    """Upper bound of the docket's claim range: '$50,001 - $75,000' -> 75000; 'Over $100,000.00' -> None (no ceiling)."""
    if not text or re.search(r"\b(over|more|greater|above)\b", text, re.I):
        return None
    amounts = [int(float(a.replace(",", ""))) for a in re.findall(r"\$\s*([\d,]+(?:\.\d+)?)", text)]
    return max(amounts) if amounts else None


def is_public(entry: dict) -> bool:
    return bool(entry.get("IsDocViewable")) and entry.get("DocumentSecurityGroup") == "PUB" and bool(entry.get("DocumentVersionString"))


# --------------------------------------------------------------------------- stage 1
def store_cases(conn, rows: list[dict], include_lower: bool) -> tuple[int, int]:
    complaints_collect.ensure_county_schema(conn)
    found = new = 0
    for c in rows:
        code, candidate = band_of(c.get("CaseType"))
        if code == "MO-OTHER" or not c.get("CaseId"):
            continue
        found += 1
        in_scope = candidate or include_lower
        style = clean(c.get("Style"))
        meta = {"enc_id": c.get("EncryptCaseId"), "division": clean(c.get("Division")) or None,
                "judge": clean(c.get("JudgeName")) or None, "band_candidate": candidate,
                "plaintiffs": [clean(style.split(" vs ")[0])] if " vs " in style else [], "defendants": [], "attorneys": []}
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ID_PREFIX + str(c["CaseId"]), clean(c.get("CaseNbr")), code, clean(c.get("CaseType")), ms_date(c.get("DtFile")),
             style, clean(c.get("CaseStatus")) or None, now(), "pending" if in_scope else "below_band_threshold",
             None if in_scope else "Claim band under $250,000: below the $500,000 threshold", COUNTY, json.dumps(meta)))
        new += cur.rowcount
        if not cur.rowcount:
            conn.execute("UPDATE foreclosure_cases SET case_status=COALESCE(?, case_status) WHERE case_id=?",
                         (clean(c.get("CaseStatus")) or None, ID_PREFIX + str(c["CaseId"])))
    conn.commit()
    return found, new


def search_range(conn, site, d_from: date, d_to: date, include_lower: bool) -> tuple[int, int]:
    """Store every in-scope Monroe case filed d_from..d_to (d_to exclusive). Returns (cases found, new)."""
    found = new = 0
    d = d_from
    while d < d_to:
        w_to = min(d + timedelta(days=WINDOW_DAYS), d_to)
        rows = site.search(d, w_to - timedelta(days=1))
        if len(rows) >= 500:
            print(f"  WARNING {d}..{w_to}: 500 results, the site's cap; narrow WINDOW_DAYS")
        f, n = store_cases(conn, rows, include_lower)
        found, new = found + f, new + n
        print(f"  {d}..{w_to - timedelta(days=1)}: {f} foreclosure cases ({n} new)")
        time.sleep(SEARCH_PAUSE)
        d = w_to
    return found, new


# --------------------------------------------------------------------------- stage 2
def due_for_fetch(conn):
    cutoff_retry = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff_age = (date.today() - timedelta(weeks=RETRY_WEEKS)).isoformat()
    return conn.execute(
        """SELECT * FROM foreclosure_cases WHERE county=? AND (complaint_status='pending'
              OR (complaint_status IN ('complaint_not_public','no_complaint_entry')
                  AND COALESCE(filing_date, first_seen) >= ? AND (last_attempt IS NULL OR last_attempt <= ?)))
           ORDER BY first_seen""", (COUNTY, cutoff_age, cutoff_retry)).fetchall()


def fetch_one(conn, site, row, include_lower: bool = False) -> str:
    meta = json.loads(row["metadata_json"] or "{}")
    if not meta.get("enc_id"):
        raise RuntimeError("no encrypted case id stored; re-run the search")
    case = site.case(meta["enc_id"])
    time.sleep(CASE_PAUSE)
    head = parse_header(case["header_html"])
    entry = pick_complaint(case["docket"])
    claim = claim_entry(case["docket"])
    ceiling = claim_ceiling(claim)
    status, din, path, sha, note = "no_complaint_entry", None, None, None, "no Complaint docket entry"
    if entry:
        din = entry.get("EventId")
        if ceiling is not None and ceiling < 250000 and not include_lower:
            status, note = "below_band_threshold", f"{claim}: below the $500,000 threshold"
        elif not is_public(entry):
            status = "complaint_not_public"
            note = f"Complaint not public yet (security group {entry.get('DocumentSecurityGroup') or 'none'})"
        else:
            data = site.pdf(entry["DocumentVersionString"])
            PDF_DIR.mkdir(parents=True, exist_ok=True)
            f = PDF_DIR / f"MO_{row['case_number']}_E{din}.pdf"
            f.write_bytes(data)
            status, path, sha, note = "downloaded", str(f), hashlib.sha256(data).hexdigest(), None
            time.sleep(IMAGE_PAUSE)
    parties = parse_parties(case["parties"])
    meta.update(parties)
    meta.update({"ucn": head.get("ucn"), "location": head.get("location"), "judge": head.get("judge") or meta.get("judge"),
                 "claim_at_filing": claim,
                 "complaint": {"event_id": din, "pages": entry.get("DocPageCount") if entry else None,
                               "description": entry.get("EventTypeDesc") if entry else None,
                               "security_group": entry.get("DocumentSecurityGroup") if entry else None}})
    style = row["case_style"]
    if parties["plaintiffs"] and parties["defendants"]:
        style = parties["plaintiffs"][0] + " v. " + parties["defendants"][0] + (f" (+{len(parties['defendants']) - 1})" if len(parties["defendants"]) > 1 else "")
    conn.execute("""UPDATE foreclosure_cases SET complaint_status=?, complaint_din=?, complaint_pdf=?, complaint_sha256=?,
                    attempts=attempts+1, last_attempt=?, note=?, filing_date=COALESCE(?, filing_date),
                    case_status=COALESCE(?, case_status), case_style=?, metadata_json=? WHERE case_id=?""",
                 (status, din, path, sha, now(), note, head.get("file_date"), head.get("status"), style, json.dumps(meta), row["case_id"]))
    conn.commit()
    return status


def fetch_pending(conn, site, limit: int | None = None, include_lower: bool = False) -> dict:
    counts: dict[str, int] = {}
    rows = due_for_fetch(conn)
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} Monroe cases due for a document fetch")
    for row in rows:
        try:
            st = fetch_one(conn, site, row, include_lower)
        except BlockedError:
            raise
        except Exception as e:
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
    ap.add_argument("--include-lower-band", action="store_true", help="also fetch claims under $250,000")
    ap.add_argument("--extract", action="store_true", help="after fetching, read and extract new complaints")
    ap.add_argument("--extract-only", action="store_true", help="read and extract already-downloaded complaints; no site access")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    a = ap.parse_args()
    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    try:
        if a.extract_only:
            a.extract, a.search_only, a.fetch_only = True, False, False
        site = None if a.extract_only else MonroeSession()
        if not a.fetch_only and not a.extract_only:
            if a.days:
                d_to, d_from = date.today() + timedelta(days=1), date.today() - timedelta(days=a.days)
            elif a.d_from and a.d_to:
                d_from, d_to = date.fromisoformat(a.d_from), date.fromisoformat(a.d_to) + timedelta(days=1)
            else:
                sys.exit("give --days N or --from/--to (or --fetch-only)")
            print(f"searching Monroe {d_from}..{d_to - timedelta(days=1)}")
            found, new = search_range(conn, site, d_from, d_to, a.include_lower_band)
            print(f"cases found {found}, new {new}")
        if not a.search_only and not a.extract_only:
            print("fetch results:", fetch_pending(conn, site, a.limit, a.include_lower_band))
        if a.extract:
            import complaints_extract
            key = os.environ.get("OPENAI_API_KEY")
            if not key:
                raise RuntimeError("OPENAI_API_KEY is not set")
            print("extract results:", complaints_extract.process_pending(conn, a.model, key, a.limit, a.budget))
    except BlockedError as e:
        print(f"STOPPED: {e}")
        sys.exit(3)
    for r in conn.execute("SELECT complaint_status, COUNT(*) n FROM foreclosure_cases WHERE county=? GROUP BY 1", (COUNTY,)):
        print(f"  {r['complaint_status']}: {r['n']}")


if __name__ == "__main__":
    main()
