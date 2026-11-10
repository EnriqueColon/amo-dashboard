"""Duval County foreclosure complaints: find the cases, download the complaint.

Duval's Clerk portal (CORE, core.duvalclerk.com) lets a signed-in user search Circuit Civil cases by
case type and file date, open a case (parties, attorney, fees, docket) and view each docket image as a
PDF. This is the same job complaints_collect.py does for Miami-Dade, with the same downstream steps:
the complaint lands in `foreclosure_cases` (county 'DUVAL', case_id 'DU:<Clerk caseID>') and the
shared reader/extractor (complaints_reader, complaints_extract, complaints_address) read it like any
other county's complaint.

Scope (same rule as Hillsborough): Commercial Foreclosure and Non-Homestead Residential Foreclosure.
Only the "$250,000 or More" band can hold $500,000 of unpaid principal, so lower bands are stored
(`below_band_threshold`, never fetched) unless --include-lower-band is given.

VOR: most Duval documents are "viewable on request": a Clerk employee redacts and releases each one
by hand before its first public viewing. The case page shows which are released (an <a> to
content.pdf with "VOR, Ready to view" or "Public access"). A complaint with no link is not released
yet: the case is marked `complaint_not_public` and retried weekly for RETRY_WEEKS weeks. This
collector never requests a release (a Public Access login cannot, and requests are an account action).

Bot Check: if the Clerk answers any call with a reCAPTCHA the run stops (exit 3); nothing solves it.
Pacing is deliberately gentle for the same reason.

Usage:
  python duval_complaints.py --days 10 --extract
  python duval_complaints.py --from 2026-10-28 --to 2026-11-03 --search-only
Env: AMO_DB_PATH, COMPLAINTS_DIR, DUVAL_CORE_USER, DUVAL_CORE_PASS, OPENAI_API_KEY (--extract).
See docs/DUVAL_COMPLAINTS.md.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402

COUNTY = "DUVAL"
ID_PREFIX = "DU:"
PDF_DIR = Path(os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"))

# CaseType 'CA' = Circuit Civil. CaseTypeList values are the Clerk's own case-type codes (from the search
# form): Commercial Foreclosure 488,489,490; Non-Homestead Residential Foreclosure 494,495,496.
# (Homestead Residential Foreclosure 491-493 and the Mortgage/Lien tiers are out of scope.)
SEARCHES = [("COM", "488,489,490"), ("NH", "494,495,496")]
WINDOW_DAYS = 7          # search window; the site takes any range, a week keeps pages small
RETRY_WEEKS = 8          # how long an unreleased complaint is retried
CASE_PAUSE = 2.0         # seconds between case-page loads
SEARCH_PAUSE = 2.0       # seconds between search calls
IMAGE_PAUSE = 2.5        # seconds between document downloads


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- tiny HTML reader
class _Node:
    """One element. `order` keeps text and child elements in document order."""

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children: list["_Node"] = []
        self.order: list = []

    def _raw(self) -> str:
        return "".join(x if isinstance(x, str) else x._raw() for x in self.order)

    def get_text(self) -> str:
        return re.sub(r"\s+", " ", self._raw()).strip()


_VOID = {"br", "img", "input", "hr", "meta", "link"}


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("root", [], None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        n = _Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        self.cur.order.append(n)
        if tag == "br":
            self.cur.order.append(" ")
        if tag not in _VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        n = _Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        self.cur.order.append(n)
        if tag == "br":
            self.cur.order.append(" ")

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.order.append(data)


def _raw_html(node: "_Node", limit: int = 700) -> str:
    """Compact markup of a node, for notes that explain why a link was not found."""
    def ser(n):
        if isinstance(n, str):
            return re.sub(r"\s+", " ", n)
        attrs = "".join(f' {k}="{v}"' for k, v in n.attrs.items() if k in ("href", "class", "id", "title", "onclick"))
        return f"<{n.tag}{attrs}>" + "".join(ser(c) for c in n.order) + f"</{n.tag}>"
    return ser(node)[:limit]


def parse_html(html: str) -> _Node:
    b = _Builder()
    b.feed(html or "")
    b.close()
    return b.root


def walk(node):
    for c in node.children:
        yield c
        yield from walk(c)


def find_all(node, tag=None, cls=None, id_=None):
    for n in walk(node):
        if tag and n.tag != tag:
            continue
        if cls and cls not in (n.attrs.get("class") or "").split():
            continue
        if id_ and n.attrs.get("id") != id_:
            continue
        yield n


def first(node, **kw):
    return next(find_all(node, **kw), None)


# --------------------------------------------------------------------------- parsing
def iso_us(v: str | None) -> str | None:
    """'10/30/2026 6:24:43 PM' or '10/30/2026' -> '2026-10-30'."""
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", v or "")
    return f"{int(m.group(3)):04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def band_of(case_type_label: str) -> tuple[str, bool]:
    """('DU-COM-3', True) for 'Commercial Foreclosure $250,000 or More'. True = could hold >= $500k."""
    low = " ".join((case_type_label or "").lower().split())
    kind = "COM" if "commercial" in low else "NH" if "non-homestead" in low or "nonhomestead" in low else None
    if not kind:
        return "DU-OTHER", False
    if "250,000" in low and "more" in low:
        return f"DU-{kind}-3", True
    if "50,001" in low or "249,999" in low:
        return f"DU-{kind}-2", False
    return f"DU-{kind}-1", False


def parse_search_html(html: str) -> dict:
    """Search results page -> {cases: [...], pages: int, request_state: str|None}."""
    root = parse_html(html)
    cases = []
    for tb in find_all(root, tag="tbody"):
        m = re.search(r"getCaseTabByCaseId\((\d+)\)", tb.attrs.get("onclick", ""))
        if not m:
            continue
        num = first(tb, cls="searchResultItem_CaseNumber")
        ctype = first(tb, cls="searchResultItem_CaseType")
        status = first(tb, cls="searchResultItem_CaseStatus")
        parties = []
        for p in find_all(tb, cls="searchResultItem_PartyName"):
            t = p.get_text()
            pm = re.search(r"\((\w)\)\s*$", t)
            parties.append((re.sub(r"\s*\(\w\)\s*$", "", t).strip(), pm.group(1) if pm else ""))
        cases.append({"case_id": m.group(1), "case_number": num.get_text() if num else "",
                      "case_type": ctype.get_text() if ctype else "", "status": status.get_text() if status else "",
                      "parties": parties})
    text = root.get_text()
    pm = re.search(r"Page:\s*of\s*(\d+)", text)
    state = None
    for i in find_all(root, tag="input"):
        if i.attrs.get("type") == "hidden" and "RequestStateHiddenField" in i.attrs.get("name", ""):
            state = i.attrs.get("value")
    return {"cases": cases, "pages": int(pm.group(1)) if pm else 1, "request_state": state}


def parse_case_html(html: str) -> dict:
    """Case page -> header, parties, attorneys, docket lines (with the release state of each image)."""
    root = parse_html(html)
    out = {"uniform_case_number": None, "division": None, "status": None, "file_date": None,
           "judge": None, "parties": [], "attorneys": [], "dockets": []}
    num = first(root, id_="c_CaseNumberLabel")
    out["uniform_case_number"] = num.get_text() if num else None
    summary = first(root, cls="caseSummary")
    if summary:
        cells = [c.get_text() for c in find_all(summary, tag="td")]
        for i in range(0, len(cells) - 1, 2):
            k, v = cells[i], cells[i + 1]
            if k == "Division":
                out["division"] = v
            elif k == "Case Status":
                out["status"] = v
            elif k == "File Date":
                out["file_date"] = iso_us(v)
            elif k == "Judge Name":
                out["judge"] = v
    parties = first(root, id_="c_PartiesPanel")
    if parties:
        for tb in find_all(parties, tag="tbody"):
            tds = [t for t in tb.children[0].children if t.tag == "td"] if tb.children else []
            if len(tds) >= 3:
                role = tds[1].get_text().split("/")[0].strip()
                out["parties"].append({"name": tds[0].get_text(), "role": role, "address": tds[2].get_text()})
    atty = first(root, id_="c_AttorneyBlock_c_AttorneysPanel")
    if atty:
        for tb in find_all(atty, tag="tbody"):
            tds = [t for t in tb.children[0].children if t.tag == "td"] if tb.children else []
            if len(tds) >= 3:
                nm = first(tds[0], tag="span")
                bar = re.search(r"\((\d+)\)", tds[0].get_text())
                out["attorneys"].append({"name": nm.get_text() if nm else tds[0].get_text(),
                                         "bar": bar.group(1) if bar else None,
                                         "address": tds[1].get_text(), "for": tds[2].get_text()})
    docket = first(root, id_="c_DocketsPanel")
    if docket:
        for tb in find_all(docket, tag="tbody"):
            desc = first(tb, cls="docketDescription")
            if desc is None:
                continue
            tds = [t for t in tb.children[0].children if t.tag == "td"]
            line = re.match(r"\s*(\d+)", tds[0].get_text())
            # the image cell's link; prefer the documented content.pdf form, but take any link in the cell
            cell = first(tb, cls="docketImageContainer")
            links = [x for x in find_all(cell if cell is not None else tb, tag="a") if x.attrs.get("href")]
            a = next((x for x in links if "content.pdf" in x.attrs["href"].lower()), links[0] if links else None)
            href = a.attrs["href"] if a else None
            if not href:
                # Some responses give the image cell a click handler instead of a link:
                #   onclick="javascript:beginImageJob(<caseID>, <docketID>, <simCtrl>)"
                # The document itself is still /court/case/<caseID>/docket/<docketID>/content.pdf.
                for x in find_all(cell if cell is not None else tb, tag="a"):
                    jm = re.search(r"begin\w*\(\s*(\d+)\s*,\s*(\d+)", x.attrs.get("onclick", ""))
                    if jm:
                        href = f"/court/case/{jm.group(1)}/docket/{jm.group(2)}/content.pdf"
                        break
            state =" ".join(s.get_text() for s in find_all(tb, tag="span")
                             if "ImageLine" in s.attrs.get("id", "") and s.get_text())
            pages = None
            if len(tds) > 4:
                pm = re.search(r"\d+", tds[4].get_text())
                pages = int(pm.group(0)) if pm else None
            out["dockets"].append({
                "line": int(line.group(1)) if line else None, "description": desc.get_text(),
                "pages": pages, "href": href, "image_state": state or None,
                "cell_html": None if href else _raw_html(tb),
                "entered": iso_us(tds[2].get_text()) if len(tds) > 2 else None})
    return out


def pick_complaint(dockets: list[dict]) -> dict | None:
    """Earliest docket line whose description starts with COMPLAINT (an amended complaint is a later line)."""
    comps = [d for d in dockets if re.match(r"\s*COMPLAINT\b", d["description"], re.I)]
    comps.sort(key=lambda d: d["line"] if d["line"] is not None else 10**9)
    return comps[0] if comps else None


# --------------------------------------------------------------------------- stage 1
def case_style(parties: list[tuple[str, str]]) -> str:
    pl = [n for n, r in parties if r == "P"]
    df = [n for n, r in parties if r == "D"]
    s = (pl[0] if pl else "?") + " v. " + (df[0] if df else "?")
    return s + (f" (+{len(df) - 1})" if len(df) > 1 else "")


def search_range(conn, core, d_from: date, d_to: date, include_lower: bool) -> tuple[int, int]:
    """Store every Duval foreclosure case filed d_from..d_to. Returns (cases the Clerk returned, new)."""
    found = new = 0
    d = d_from
    while d < d_to:
        w_to = min(d + timedelta(days=WINDOW_DAYS), d_to)
        rng = f"{d:%m/%d/%Y}-{w_to - timedelta(days=1):%m/%d/%Y}"
        for tag, codes in SEARCHES:
            res = core.search("CA", codes, rng)
            page = parse_search_html(res.get("BodyHtml") or "")
            rows = list(page["cases"])
            for pg in range(2, page["pages"] + 1):
                time.sleep(SEARCH_PAUSE)
                nxt = parse_search_html(core.search_page(page["request_state"], pg).get("BodyHtml") or "")
                rows += nxt["cases"]
            time.sleep(SEARCH_PAUSE)
            f, n = store_cases(conn, rows, include_lower)
            found += f
            new += n
            print(f"  {tag} {rng}: {len(rows)} cases ({n} new)")
        d = w_to
    return found, new


def store_cases(conn, rows: list[dict], include_lower: bool) -> tuple[int, int]:
    complaints_collect.ensure_county_schema(conn)
    found = new = 0
    for c in rows:
        code, candidate = band_of(c["case_type"])
        if code == "DU-OTHER":
            continue
        found += 1
        in_scope = candidate or include_lower
        meta = {"parties": [{"name": n, "role": r} for n, r in c["parties"]], "band_candidate": candidate,
                "uniform_number": None}
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ID_PREFIX + c["case_id"], c["case_number"], code, c["case_type"], None, case_style(c["parties"]),
             c["status"], now(), "pending" if in_scope else "below_band_threshold",
             None if in_scope else "Claim band under $250,000: below the $500,000 threshold",
             COUNTY, json.dumps(meta)))
        new += cur.rowcount
        if not cur.rowcount:  # status changes over a case's life; keep it current
            conn.execute("UPDATE foreclosure_cases SET case_status=? WHERE case_id=?", (c["status"], ID_PREFIX + c["case_id"]))
    conn.commit()
    return found, new


def fill_details(conn, core, limit: int | None = None) -> int:
    """The search page shows no file date and cuts party names at 25 characters. For every Duval case still
    without a filing date (new cases, and the lower-band ones that are never downloaded), read the case page:
    exact file date, current status, full party names, attorney and division. One page load per case."""
    rows = conn.execute("SELECT * FROM foreclosure_cases WHERE county=? AND filing_date IS NULL ORDER BY first_seen",
                        (COUNTY,)).fetchall()
    if limit:
        rows = rows[:limit]
    done = 0
    for row in rows:
        try:
            case = parse_case_html(core.case(row["case_id"][len(ID_PREFIX):]).get("BodyHtml") or "")
        except Exception as e:
            from duval_session import BotCheckError
            if isinstance(e, BotCheckError):
                raise
            print(f"  ERROR reading case page for {row['case_number']}: {e}")
            continue
        time.sleep(CASE_PAUSE)
        if not case["file_date"]:
            continue
        letter = {"PLAINTIFF": "P", "DEFENDANT": "D"}
        style = case_style([(p["name"], letter.get(p["role"], "")) for p in case["parties"]]) if case["parties"] else row["case_style"]
        meta = json.loads(row["metadata_json"] or "{}")
        meta.update({"uniform_number": case["uniform_case_number"], "division": case["division"], "judge": case["judge"],
                     "parties": case["parties"], "attorneys": case["attorneys"]})
        conn.execute("UPDATE foreclosure_cases SET filing_date=?, case_status=COALESCE(?, case_status), case_style=?, "
                     "metadata_json=? WHERE case_id=?",
                     (case["file_date"], case["status"], style, json.dumps(meta), row["case_id"]))
        conn.commit()
        done += 1
    return done


# --------------------------------------------------------------------------- stage 2
def due_for_fetch(conn):
    cutoff_retry = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff_age = (date.today() - timedelta(weeks=RETRY_WEEKS)).isoformat()
    return conn.execute(
        """SELECT * FROM foreclosure_cases WHERE county=? AND (complaint_status='pending'
              OR (complaint_status IN ('complaint_not_public','no_complaint_entry')
                  AND COALESCE(filing_date, first_seen) >= ? AND (last_attempt IS NULL OR last_attempt <= ?)))
           ORDER BY first_seen""", (COUNTY, cutoff_age, cutoff_retry)).fetchall()


def fetch_one(conn, core, row) -> str:
    raw_id = row["case_id"][len(ID_PREFIX):]
    case = parse_case_html(core.case(raw_id).get("BodyHtml") or "")
    time.sleep(CASE_PAUSE)
    entry = pick_complaint(case["dockets"])
    status, din, path, sha, note = "no_complaint_entry", None, None, None, "no COMPLAINT docket line"
    if entry:
        din = entry["line"]
        if not entry["href"]:
            status, note = "complaint_not_public", f"Complaint not released yet ({entry['image_state'] or 'no image link'})"
            if entry["image_state"] and re.search(r"available|ready to view|public access", entry["image_state"], re.I):
                # the Clerk says it is available but we found no link: keep the raw markup so the cause is visible
                note += " | NO LINK FOUND: " + (entry.get("cell_html") or "")[:400]
                print(f"  WARNING {row['case_number']}: complaint marked available but no link found")
        else:
            data = core.pdf(entry["href"])
            if not data.startswith(b"%PDF"):  # Core.pdf already raises with the details; this is the backstop
                raise RuntimeError(f"{row['case_number']}: document response is not a PDF")
            PDF_DIR.mkdir(parents=True, exist_ok=True)
            f = PDF_DIR / f"DU_{row['case_number']}_DIN{din}.pdf"
            f.write_bytes(data)
            status, path, sha, note = "downloaded", str(f), hashlib.sha256(data).hexdigest(), None
            time.sleep(IMAGE_PAUSE)
    meta = json.loads(row["metadata_json"] or "{}")
    meta.update({"uniform_number": case["uniform_case_number"], "division": case["division"], "judge": case["judge"],
                 "parties": case["parties"], "attorneys": case["attorneys"],
                 "complaint": {"line": din, "pages": entry["pages"] if entry else None,
                               "description": entry["description"] if entry else None,
                               "image_state": entry["image_state"] if entry else None}})
    conn.execute("""UPDATE foreclosure_cases SET complaint_status=?, complaint_din=?, complaint_pdf=?,
                    complaint_sha256=?, attempts=attempts+1, last_attempt=?, note=?, filing_date=COALESCE(?, filing_date),
                    case_status=COALESCE(?, case_status), metadata_json=? WHERE case_id=?""",
                 (status, din, path, sha, now(), note, case["file_date"], case["status"], json.dumps(meta), row["case_id"]))
    conn.commit()
    return status


def fetch_pending(conn, core, limit: int | None = None) -> dict:
    counts: dict[str, int] = {}
    rows = due_for_fetch(conn)
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} Duval cases due for a document fetch")
    for row in rows:
        try:
            st = fetch_one(conn, core, row)
        except Exception as e:
            from duval_session import BotCheckError
            if isinstance(e, BotCheckError):
                raise
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
    ap.add_argument("--extract-only", action="store_true", help="read and extract already-downloaded complaints; no Clerk sign-in")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    a = ap.parse_args()
    import duval_session
    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    try:
        if a.extract_only:
            a.extract, a.search_only, a.fetch_only = True, False, False
            core = None
        else:
            core = duval_session.Core()
        if not a.fetch_only and not a.extract_only:
            if a.days:
                d_to, d_from = date.today() + timedelta(days=1), date.today() - timedelta(days=a.days)
            elif a.d_from and a.d_to:
                d_from, d_to = date.fromisoformat(a.d_from), date.fromisoformat(a.d_to) + timedelta(days=1)
            else:
                sys.exit("give --days N or --from/--to (or --fetch-only)")
            print(f"searching Duval {d_from}..{d_to - timedelta(days=1)}")
            found, new = search_range(conn, core, d_from, d_to, a.include_lower_band)
            print(f"cases found {found}, new {new}")
            print(f"case pages read for date and full names: {fill_details(conn, core)}")
        if not a.search_only and not a.extract_only:
            if a.include_lower_band:
                print(f"lower-band cases queued for reading: {complaints_collect.requeue_lower_band(conn, COUNTY)}")
            print("fetch results:", fetch_pending(conn, core, a.limit))
        if a.extract:
            import complaints_extract
            key = os.environ.get("OPENAI_API_KEY")
            if not key:
                raise RuntimeError("OPENAI_API_KEY is not set")
            print("extract results:", complaints_extract.process_pending(conn, a.model, key, a.limit, a.budget))
    except duval_session.BotCheckError as e:
        print(f"STOPPED: {e}")
        sys.exit(3)
    for r in conn.execute("SELECT complaint_status, COUNT(*) n FROM foreclosure_cases WHERE county=? GROUP BY 1", (COUNTY,)):
        print(f"  {r['complaint_status']}: {r['n']}")


if __name__ == "__main__":
    main()
