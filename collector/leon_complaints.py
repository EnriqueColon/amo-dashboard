"""Leon County foreclosure complaints: find the cases, download the complaint.

Leon's Clerk court-records search (lforms.leonclerk.com/search_courts) needs no sign-in. The search is by
party name, so each date window is searched once per vowel (name "contains" A, E, I, O, U, Y, plaintiffs
only), limited to the foreclosure case types below; the union is every case filed in the window. Each case's
full view lists the parties, the action and the docket, and each docket entry with a viewable image opens as
a PDF. Cases land in `foreclosure_cases` (county 'LEON', case_id 'LE:<Clerk caseid>') and the shared
reader/extractor (complaints_reader, complaints_extract, complaints_address) read them like any other county's.

Scope (same rule as Duval and Monroe): Commercial and Non-Homestead Residential foreclosure. Leon files every
case under a claim band; the "$250,000 or more" band is read, the lower bands are stored
(`below_band_threshold`, never fetched) unless --include-lower-band is given. Homestead Residential, County
Civil and the legacy band-less "MORTGAGE FORECLOSURE" codes are not searched.

A complaint whose docket entry has no image link ("Non-Viewable images ... Requiring Clerk Assistance") is
`complaint_not_public` and retried weekly for RETRY_WEEKS weeks; this collector never orders a copy. The
Clerk's notice asks that requests be made "in a reasonable manner": every request is paced. No CAPTCHA is shown
on this route; if one ever appears, or the site answers 403/429, the run stops (exit 3) and nothing solves it.

The Clerk's network refuses the droplet's address (connect timeout / 403, 10 Nov 2026). At the owner's instruction,
having accepted the risk, the session goes through the IPRoyal proxy when it is configured in .env (proxy_config);
--direct skips it. The User-Agent still names the collector, and the pacing and stop rules are unchanged.

Usage:
  python leon_complaints.py --days 10 --extract
  python leon_complaints.py --from 2026-10-01 --to 2026-11-10 --search-only
Env: AMO_DB_PATH, COMPLAINTS_DIR, OPENAI_API_KEY (--extract).
See docs/LEON_COMPLAINTS.md.
"""
import argparse
import hashlib
import html as htmllib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402

COUNTY = "LEON"
ID_PREFIX = "LE:"
PDF_DIR = Path(os.environ.get("COMPLAINTS_DIR", "complaints_pdfs"))
BASE = "https://lforms.leonclerk.com/search_courts/"
UA = "amo-dashboard collector (court records research)"

# The Clerk's Circuit Civil CaseType codes (from the search form). Lower bands are searched only so they are stored.
CASE_TYPES = ["MTFCC1", "MTFCC2", "MTFCC3",              # Commercial: $50k or less, $50k-$250k, $250k+
              "MTFCNHR1", "MTFCNHR2", "MTFCNHR3"]        # Non-Homestead Residential: same
NAME_LETTERS = "AEIOUY"
WINDOW_DAYS = 7          # the site caps a search at 250 result rows
RESULT_CAP = 250
SEARCH_PAUSE = 2.0       # seconds between requests
CASE_PAUSE = 2.0
IMAGE_PAUSE = 2.5
RETRY_WEEKS = 8


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class BlockedError(RuntimeError):
    """The site answered with a CAPTCHA, 403 or 429. The run stops; nothing works around it."""


# Result and case pages load Google's recaptcha/api.js but render no widget, and the search form's
# recaptcha_result field is commented out; only a live widget or challenge call counts.
CAPTCHA_RE = re.compile(rb"g-recaptcha|data-sitekey|grecaptcha\.(?:execute|render)|h-captcha|hcaptcha\.com|cf-turnstile", re.I)


class LeonSession:
    def __init__(self, use_proxy: bool = True):
        import requests
        import proxy_config
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self._started = False
        self.route = proxy_config.apply_to_requests_session(self.s, session_key="leon_courts", enabled=use_proxy) or "direct connection"

    def _check(self, r):
        body = r.content[:200000]
        html = "html" in (r.headers.get("content-type") or "") and b"%PDF" not in body[:2048]
        if r.status_code in (403, 429) or (html and CAPTCHA_RE.search(re.sub(rb"<!--[\s\S]*?-->", b"", body))):
            raise BlockedError(f"{r.request.method} {r.url.split('?')[0]} -> HTTP {r.status_code}"
                               + (" with a CAPTCHA" if r.status_code not in (403, 429) else ""))
        r.raise_for_status()
        return r

    def _start(self):
        if not self._started:
            self._check(self.s.get(BASE + "search_by_name.asp", timeout=60))
            self._started = True

    def search(self, d_from: date, d_to: date, letter: str) -> str:
        """Result-table HTML: plaintiffs whose name contains `letter`, CASE_TYPES, filed d_from..d_to (inclusive)."""
        self._start()
        form = [("case_search_type", "civil"), ("search_method", "name"), ("idnt.last_name", ""), ("idnt.first_name", ""),
                ("idnt.company_name", letter), ("wildCard", "contain"),
                ("begin_date", d_from.isoformat()), ("end_date", d_to.isoformat()), ("CourtType", "CA")]
        form += [("CaseType", c) for c in CASE_TYPES]
        form += [("pty.pty_cd", "PLTF"), ("real_case.stat_cd", ""), ("template", "main_search_judge"), ("action", "Search")]
        return self._check(self.s.post(BASE + "process.asp", data=form, headers={"Referer": BASE + "search_by_name.asp"},
                                       timeout=90)).text

    def case(self, caseid: str) -> str:
        self._start()
        return self._check(self.s.get(BASE + "process.asp", params={"report": "full_view", "caseid": caseid, "jiscaseid": ""},
                                      headers={"Referer": BASE + "process.asp"}, timeout=60)).text

    def pdf(self, caseid: str, dktid: str) -> bytes:
        """The docket image. The server answers application/pdf with a short HTML preamble before %PDF, and only
        when the request names the case page as its Referer."""
        self._start()
        referer = f"{BASE}process.asp?report=full_view&caseid={caseid}&jiscaseid="
        r = self._check(self.s.get(BASE + "image_orders.asp",
                                   params={"caseid": caseid, "jiscaseid": "", "defseq": "", "chargeseq": "", "dktid": dktid,
                                           "dktsource": "BM", "sexual_case": ""},
                                   headers={"Referer": referer}, timeout=240))
        i = r.content.find(b"%PDF", 0, 65536)
        if i < 0:
            raise RuntimeError(f"document response is not a PDF ({r.headers.get('content-type')}, {len(r.content)} bytes)")
        return r.content[i:]


# --------------------------------------------------------------------------- parsing
def clean(s: str | None) -> str:
    s = htmllib.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return " ".join(s.replace("\xa0", " ").split())


def party_name(s: str | None) -> str:
    """'UNKNOWN TENANT 1&nbsp;,    ' -> 'UNKNOWN TENANT 1'; 'DOE&nbsp;, JANE' -> 'DOE, JANE'."""
    return clean(s).replace(" ,", ",").strip(" ,")


def us_date(s: str | None) -> str | None:
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s or "")
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def band_of(action: str) -> tuple[str, bool]:
    """('LE-COM-3', True) for Commercial $250,000+. True = could hold >= $500k, so read it."""
    low = " ".join((action or "").upper().split())
    kind = "COM" if "FORECLOSURE COMMERCIAL" in low else "NH" if "NON-HOMESTEAD RESIDENTIAL" in low else None
    if not kind:
        return "LE-OTHER", False
    if "250,000 OR MORE" in low:
        return f"LE-{kind}-3", True
    return f"LE-{kind}-LOW", False


def _cells(tr: str) -> list[str]:
    return re.findall(r"<td[^>]*>([\s\S]*?)</td>", tr)


def parse_search(html: str) -> tuple[dict[str, dict], int]:
    """Search-result HTML -> ({caseid: case}, result rows). One row per matching party, so cases repeat."""
    out: dict[str, dict] = {}
    n = 0
    t = re.search(r'id="searchresultstable"[\s\S]*?</table>', html or "")
    for tr in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", t.group(0) if t else ""):
        m = re.search(r"caseid=(\d+)[^>]*>([^<]+)</a>", tr)
        c = _cells(tr)
        if not m or len(c) < 9:
            continue
        n += 1
        case = out.setdefault(m.group(1), {"caseid": m.group(1), "case_number": clean(m.group(2)), "action": clean(c[3]),
                                           "file_date": us_date(c[4]), "judge": clean(c[5]) or None,
                                           "status": clean(c[6]) or None, "plaintiffs": []})
        name = party_name(c[0])
        if clean(c[2]).upper() == "PLAINTIFF" and name and name not in case["plaintiffs"]:
            case["plaintiffs"].append(name)
    return out, n


def _table(html: str, tid: str) -> list[list[str]]:
    t = re.search(rf'<table id="{tid}"[\s\S]*?</table>', html or "")
    rows = re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", t.group(0) if t else "")
    return [c for c in (_cells(r) for r in rows) if c]


def parse_case(html: str) -> dict:
    """Header style, parties, action/judge and docket from a full case view."""
    out = {"style": None, "plaintiffs": [], "defendants": [], "attorneys": [], "action": None, "file_date": None,
           "status": None, "judge": None, "docket": []}
    m = re.search(r"<b>\s*\d+\s+(\d{4} CA \d+)\s*-\s*([^<]*)</b>", html or "")
    if m:
        out["style"] = clean(m.group(2)) or None
    for c in _table(html, "parties_table"):
        if len(c) < 4:
            continue
        name, role, atty = party_name(c[1]), clean(c[2]).upper(), clean(c[3])
        if role == "PLAINTIFF" and name and name not in out["plaintiffs"]:
            out["plaintiffs"].append(name)
            if atty and atty.upper() != "PRO SE" and atty not in out["attorneys"]:
                out["attorneys"].append(atty)
        elif role == "DEFENDANT" and name and name not in out["defendants"]:
            out["defendants"].append(name)
    for c in _table(html, "case_dsp_table"):
        if len(c) >= 6 and "FORECLOSURE" in clean(c[0]).upper():
            out.update(action=clean(c[0]), status=clean(c[1]) or None, file_date=us_date(c[2]), judge=clean(c[5]) or None)
            break
    t = re.search(r'<table id="dockets_ecert_table"[\s\S]*?</table>', html or "")
    for tr in re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", t.group(0) if t else ""):
        v = re.search(r'value="(\d+)\|(\d+)\|([^|"]*)\|([^|"]*)\|([^|"]*)', tr)
        if not v:
            continue
        c = _cells(tr)
        out["docket"].append({"date": us_date(c[0]) if c else None, "dktid": v.group(2), "source": v.group(3),
                              "code": v.group(4), "description": clean(v.group(5)),
                              "viewable": f"dktid={v.group(2)}" in tr and "image_orders.asp" in tr})
    return out


def pick_complaint(docket: list[dict]) -> dict | None:
    """Earliest 'Complaint' entry (MTFC* code or a COMPLAINT description); amended complaints are later entries."""
    comps = [d for d in docket
             if (d["code"].startswith("MTFC") or re.match(r"\s*(verified\s+)?complaint\b", d["description"], re.I))
             and not re.search(r"amended", d["description"], re.I)]
    viewable = [d for d in comps if d["viewable"]]
    comps = viewable or comps
    comps.sort(key=lambda d: (d["date"] or "9999", int(d["dktid"])))
    return comps[0] if comps else None


# --------------------------------------------------------------------------- stage 1
def store_cases(conn, cases: dict[str, dict], include_lower: bool) -> tuple[int, int]:
    complaints_collect.ensure_county_schema(conn)
    found = new = 0
    for cid, c in cases.items():
        code, candidate = band_of(c["action"])
        if code == "LE-OTHER":
            continue
        found += 1
        in_scope = candidate or include_lower
        meta = {"caseid": cid, "judge": c["judge"], "band_candidate": candidate,
                "plaintiffs": c["plaintiffs"], "defendants": [], "attorneys": []}
        style = (c["plaintiffs"][0] + " vs ...") if c["plaintiffs"] else None
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ID_PREFIX + cid, c["case_number"], code, c["action"], c["file_date"], style, c["status"], now(),
             "pending" if in_scope else "below_band_threshold",
             None if in_scope else "Claim band under $250,000: below the $500,000 threshold", COUNTY, json.dumps(meta)))
        new += cur.rowcount
        if not cur.rowcount:
            conn.execute("UPDATE foreclosure_cases SET case_status=COALESCE(?, case_status) WHERE case_id=?",
                         (c["status"], ID_PREFIX + cid))
    conn.commit()
    return found, new


def search_window(site, d_from: date, d_to: date) -> dict[str, dict]:
    """Union of the per-letter searches for one window (d_to inclusive)."""
    cases: dict[str, dict] = {}
    for letter in NAME_LETTERS:
        found, rows = parse_search(site.search(d_from, d_to, letter))
        if rows >= RESULT_CAP:
            print(f"  WARNING {d_from}..{d_to} '{letter}': {rows} result rows, the site's cap; narrow WINDOW_DAYS")
        for cid, c in found.items():
            have = cases.setdefault(cid, c)
            for p in c["plaintiffs"]:
                if p not in have["plaintiffs"]:
                    have["plaintiffs"].append(p)
        time.sleep(SEARCH_PAUSE)
    return cases


def search_range(conn, site, d_from: date, d_to: date, include_lower: bool) -> tuple[int, int]:
    """Store every in-scope Leon case filed d_from..d_to (d_to exclusive). Returns (cases found, new)."""
    found = new = 0
    d = d_from
    while d < d_to:
        w_to = min(d + timedelta(days=WINDOW_DAYS), d_to)
        f, n = store_cases(conn, search_window(site, d, w_to - timedelta(days=1)), include_lower)
        found, new = found + f, new + n
        print(f"  {d}..{w_to - timedelta(days=1)}: {f} foreclosure cases ({n} new)")
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


def fetch_one(conn, site, row) -> str:
    meta = json.loads(row["metadata_json"] or "{}")
    cid = meta.get("caseid") or row["case_id"].removeprefix(ID_PREFIX)
    case = parse_case(site.case(cid))
    time.sleep(CASE_PAUSE)
    entry = pick_complaint(case["docket"])
    status, din, path, sha, note = "no_complaint_entry", None, None, None, "no Complaint docket entry"
    if entry:
        din = int(entry["dktid"])
        if not entry["viewable"]:
            status, note = "complaint_not_public", "Complaint not public yet (no viewable image on the docket)"
        else:
            data = site.pdf(cid, entry["dktid"])
            PDF_DIR.mkdir(parents=True, exist_ok=True)
            f = PDF_DIR / f"LE_{row['case_number'].replace(' ', '-')}_D{din}.pdf"
            f.write_bytes(data)
            status, path, sha, note = "downloaded", str(f), hashlib.sha256(data).hexdigest(), None
            time.sleep(IMAGE_PAUSE)
    meta, style = apply_case(meta, row["case_style"], case)
    meta["complaint"] = {"dktid": din, "code": entry["code"] if entry else None,
                         "description": entry["description"] if entry else None}
    conn.execute("""UPDATE foreclosure_cases SET complaint_status=?, complaint_din=?, complaint_pdf=?, complaint_sha256=?,
                    attempts=attempts+1, last_attempt=?, note=?, filing_date=COALESCE(?, filing_date),
                    case_status=COALESCE(?, case_status), case_style=?, metadata_json=? WHERE case_id=?""",
                 (status, din, path, sha, now(), note, case["file_date"], case["status"], style, json.dumps(meta), row["case_id"]))
    conn.commit()
    return status


def apply_case(meta: dict, style: str | None, case: dict) -> tuple[dict, str | None]:
    """Parties, attorney and judge from a parsed case view into the row's metadata and style."""
    for k in ("plaintiffs", "defendants", "attorneys"):
        if case[k]:
            meta[k] = case[k]
    meta["judge"] = case["judge"] or meta.get("judge")
    meta["case_loaded"] = True
    if case["plaintiffs"] and case["defendants"]:
        style = case["plaintiffs"][0] + " v. " + case["defendants"][0] + (f" (+{len(case['defendants']) - 1})" if len(case["defendants"]) > 1 else "")
    return meta, style


def enrich_lower(conn, site, limit: int | None = None) -> int:
    """Lower-band cases are never downloaded, but their case view (one request, no document) gives the
    defendants and attorney the Complaints tab shows. Loaded once per case."""
    rows = [r for r in conn.execute("SELECT * FROM foreclosure_cases WHERE county=? AND complaint_status='below_band_threshold'",
                                    (COUNTY,)).fetchall()
            if not json.loads(r["metadata_json"] or "{}").get("case_loaded")]
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} lower-band Leon cases to fill from the case view")
    done = 0
    for row in rows:
        meta = json.loads(row["metadata_json"] or "{}")
        try:
            case = parse_case(site.case(meta.get("caseid") or row["case_id"].removeprefix(ID_PREFIX)))
        except BlockedError:
            raise
        except Exception as e:
            print(f"  ERROR {row['case_number']}: {e}")
            continue
        meta, style = apply_case(meta, row["case_style"], case)
        conn.execute("UPDATE foreclosure_cases SET case_style=?, case_status=COALESCE(?, case_status), metadata_json=? WHERE case_id=?",
                     (style, case["status"], json.dumps(meta), row["case_id"]))
        conn.commit()
        done += 1
        time.sleep(CASE_PAUSE)
    return done


def fetch_pending(conn, site, limit: int | None = None) -> dict:
    counts: dict[str, int] = {}
    rows = due_for_fetch(conn)
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} Leon cases due for a document fetch")
    for row in rows:
        try:
            st = fetch_one(conn, site, row)
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
    ap.add_argument("--direct", action="store_true", help="do not use the IPRoyal proxy even if it is configured")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    a = ap.parse_args()
    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    try:
        if a.extract_only:
            a.extract, a.search_only, a.fetch_only = True, False, False
        site = None if a.extract_only else LeonSession(use_proxy=not a.direct)
        if site:
            print(f"route: {site.route}")
        if not a.fetch_only and not a.extract_only:
            if a.days:
                d_to, d_from = date.today() + timedelta(days=1), date.today() - timedelta(days=a.days)
            elif a.d_from and a.d_to:
                d_from, d_to = date.fromisoformat(a.d_from), date.fromisoformat(a.d_to) + timedelta(days=1)
            else:
                sys.exit("give --days N or --from/--to (or --fetch-only)")
            print(f"searching Leon {d_from}..{d_to - timedelta(days=1)}")
            found, new = search_range(conn, site, d_from, d_to, a.include_lower_band)
            print(f"cases found {found}, new {new}")
        if not a.search_only and not a.extract_only:
            print("fetch results:", fetch_pending(conn, site, a.limit))
            print("lower-band cases filled:", enrich_lower(conn, site))
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
