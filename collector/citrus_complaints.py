"""Citrus County foreclosure cases from the Clerk's official Bulk Data Export.

The Citrus Clerk publishes a self-service export of court filings (apps.citrusclerk.org/BulkDataExport/): pick
"Filings", a file-date range, the information to include (Case, Case Party, Case Docket) and a court type, and
the page returns a ZIP of CSVs. No sign-in, no CAPTCHA, no robots.txt on that host. The page is a Laravel
Livewire form, so the collector does what the browser does: load the page, then post the form's state to the
page's own `livewire/update` endpoint; the ZIP comes back base64-encoded in the response.

Cases land in `foreclosure_cases` (county 'CITRUS', case_id 'CI:<Uniform Case Number>'), with plaintiffs,
defendants, plaintiff attorneys, judge, party addresses and the complaint's docket entry in metadata.

Scope (same rule as Duval, Monroe and Leon): commercial and non-homestead residential mortgage foreclosures.
Citrus case types carry the claim band: ">250,000" is the top band and is kept `pending`; the lower bands are
stored `below_band_threshold`. Homestead foreclosures and other real-property actions are out of scope.

No complaint document is fetched. The export holds no images, and the Clerk's case search
(scorss.citrusclerk.org) makes anonymous users complete a CAPTCHA on every search ("Registered users can login to
avoid the captcha requirements"). Reading Citrus complaints needs a registered account, set up by the owner; until
then top-band rows stay `pending` with the parties filled in. If the export ever answers with a CAPTCHA, 403 or
429, the run stops (exit 3) and nothing works around it.

Usage:
  python citrus_complaints.py --days 14
  python citrus_complaints.py --from 2026-01-01 --to 2026-11-10
Env: AMO_DB_PATH. See docs/CITRUS_COMPLAINTS.md.
"""
import argparse
import base64
import csv
import html
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402

COUNTY = "CITRUS"
ID_PREFIX = "CI:"
BASE = "https://apps.citrusclerk.org/BulkDataExport/"
UA = "amo-dashboard collector (court records research)"
WINDOW_DAYS = 7          # one export per week of filings; Circuit Civil runs ~20 cases a week
EXPORT_CAP = 1000        # an export returns at most 1,000 cases (a one-year pull came back with exactly 1,000)
EXPORT_PAUSE = 10.0      # seconds between exports (the Clerk's main site asks crawlers for 10 s)
NO_DOC_NOTE = ("Complaint not fetched: the Citrus Clerk's case search needs a registered account "
               "(anonymous searches have a CAPTCHA)")
CAPTCHA_RE = re.compile(rb"g-recaptcha|data-sitekey|grecaptcha\.(?:execute|render)|h-captcha|hcaptcha\.com|cf-turnstile|turnstile/v0", re.I)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class BlockedError(RuntimeError):
    """The site answered with a CAPTCHA, 403 or 429. The run stops; nothing works around it."""


class CitrusExport:
    def __init__(self):
        self.s = None

    def _new_session(self):
        import requests
        if self.s is not None:
            self.s.close()
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA

    def _check(self, r):
        if r.status_code in (403, 429) or ("html" in (r.headers.get("content-type") or "")
                                           and CAPTCHA_RE.search(re.sub(rb"<!--[\s\S]*?-->", b"", r.content[:400000]))):
            raise BlockedError(f"{r.request.method} {r.url.split('?')[0]} -> HTTP {r.status_code}"
                               + (" with a CAPTCHA" if r.status_code not in (403, 429) else ""))
        r.raise_for_status()
        return r

    def export(self, d_from: date, d_to: date) -> dict[str, list[dict]]:
        """Circuit Civil filings d_from..d_to (inclusive) as {'Case': [...], 'Party': [...], 'Docket': [...]}.
        Each export starts a fresh session: the server drops idle keep-alive connections between exports.
        A dropped connection or an HTTP 500 is retried once after 30 s; a CAPTCHA, 403 or 429 is never retried.
        The export answers 500 for a window with no filings (it lags new filings by a few days), so a second 500
        returns None: the caller counts the window as empty, and the daily run's overlap covers it again."""
        import requests
        for attempt in (1, 2):
            try:
                return self._export(d_from, d_to)
            except requests.ConnectionError as e:
                if attempt == 2:
                    raise
                print(f"  connection dropped ({e.__class__.__name__}); retrying once in 30 s")
            except requests.HTTPError as e:
                if e.response is None or e.response.status_code != 500:
                    raise
                if attempt == 2:
                    return None
                print("  export answered HTTP 500; retrying once in 30 s")
            time.sleep(30)

    def _export(self, d_from: date, d_to: date) -> dict[str, list[dict]]:
        self._new_session()
        page = self._check(self.s.get(BASE, timeout=60)).text
        snap = re.search(r'wire:snapshot="([^"]+)"', page)
        csrf = re.search(r'data-csrf="([^"]+)"', page)
        if not snap or not csrf:
            raise RuntimeError("export page has no Livewire snapshot or CSRF token; the site layout changed")
        snapshot = html.unescape(snap.group(1))

        def update(snapshot, updates, calls=()):
            body = {"_token": csrf.group(1), "components": [{
                "snapshot": snapshot, "updates": updates,
                "calls": [{"path": "", "method": m, "params": []} for m in calls]}]}
            r = self._check(self.s.post(BASE + "livewire/update", json=body, timeout=300,
                                        headers={"X-Livewire": "true", "Referer": BASE}))
            return r.json()["components"][0]

        c = update(snapshot, {"form.time_frame": "custom"})
        c = update(c["snapshot"], {"form.filings_or_dispositions": "FileDate",
                                   "form.start_date": d_from.isoformat(), "form.end_date": d_to.isoformat(),
                                   "form.export_information": ["Case", "Party", "Docket"],
                                   "form.selected_court_types": ["CA"]}, ["submitForm"])
        dl = (c.get("effects") or {}).get("download")
        if not dl:
            errors = json.loads(c["snapshot"]).get("memo", {}).get("errors")
            if errors:
                raise RuntimeError(f"export refused: {errors}")
            return {"Case": [], "Party": [], "Docket": []}
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(dl["content"])))
        return {kind: read_csv(z, f"export_{kind}.csv") for kind in ("Case", "Party", "Docket")}


def read_csv(z: zipfile.ZipFile, name: str) -> list[dict]:
    if name not in z.namelist():
        return []
    return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig")))


# --------------------------------------------------------------------------- parsing
def clean(s: str | None) -> str:
    return " ".join((s or "").split())


def iso(v: str | None) -> str | None:
    """' 2026-11-03 16:07:40' -> '2026-11-03'."""
    m = re.match(r"\s*(\d{4}-\d{2}-\d{2})", v or "")
    return m.group(1) if m else None


def band_of(case_type: str) -> tuple[str, bool]:
    """('CI-NH-3', True) for 'NON-HOMESTEAD FC>250,000'. True = could hold >= $500k. 'CI-OTHER' = out of scope."""
    t = re.sub(r"\s+", " ", (case_type or "").upper())
    kind = "COM" if t.startswith("COMML MTG FORECL") else "NH" if t.startswith("NON-HOMESTEAD FC") else None
    if not kind:
        return "CI-OTHER", False
    return (f"CI-{kind}-3", True) if re.search(r">\s*250", t) else (f"CI-{kind}-LOW", False)


def party_name(p: dict) -> str:
    """'KILGORE', 'MARK', 'T', '' -> 'KILGORE, MARK T'; companies have only LastName."""
    last, rest = clean(p.get("LastName")), clean(" ".join([p.get("FirstName") or "", p.get("MiddleName") or "", p.get("SuffixName") or ""]))
    return f"{last}, {rest}" if last and rest else last or rest


def parse_parties(rows: list[dict]) -> dict:
    out = {"plaintiffs": [], "defendants": [], "attorneys": [], "attorney_bars": [], "party_addresses": []}
    plaintiffs = set()
    for p in rows:
        role, kind, name = clean(p.get("Description")).upper(), clean(p.get("PartyType")).upper(), party_name(p)
        if kind != "PRIMARY" or not name:
            continue
        if role == "PLAINTIFF" and name not in out["plaintiffs"]:
            out["plaintiffs"].append(name)
            plaintiffs.add(clean(p.get("LastName")).upper())
        elif role == "DEFENDANT" and name not in out["defendants"]:
            out["defendants"].append(name)
        if role in ("PLAINTIFF", "DEFENDANT") and clean(p.get("ActiveAddress")):
            out["party_addresses"].append({"role": role.lower(), "name": name, "address": clean(p["ActiveAddress"])})
    for p in rows:
        if clean(p.get("Description")).upper() != "ATTORNEY" or clean(p.get("PartyType")).upper() != "PRIMARY":
            continue
        linked = clean(p.get("LinkedParty")).upper()
        if linked and not any(linked.startswith(x[:60]) for x in plaintiffs):
            continue
        name = party_name(p)
        if name and name not in out["attorneys"]:
            out["attorneys"].append(name)
            out["attorney_bars"].append(clean(p.get("BarNumber")) or None)
    return out


def pick_complaint(docket: list[dict]) -> dict | None:
    """Earliest docket entry that is the complaint itself (not an amended complaint or a motion about one)."""
    comps = [d for d in docket if re.match(r"\s*(verified\s+)?(mortgage\s+foreclosure\s+)?complaint\b", d.get("dockettext") or "", re.I)
             or re.match(r"\s*verified\s+mortgage\s+foreclosure\b", d.get("dockettext") or "", re.I)]
    comps = [d for d in comps if not re.search(r"\bamended\b", d.get("dockettext") or "", re.I)]
    comps.sort(key=lambda d: d.get("DocketDate") or "9999")
    return comps[0] if comps else None


def case_style(parties: dict) -> str | None:
    if not parties["plaintiffs"]:
        return None
    if not parties["defendants"]:
        return parties["plaintiffs"][0]
    named = [d for d in parties["defendants"] if not re.match(r"UNKNOWN\b", d, re.I)]
    extra = len(parties["defendants"]) - 1
    return parties["plaintiffs"][0] + " v. " + (named or parties["defendants"])[0] + (f" (+{extra})" if extra else "")


# --------------------------------------------------------------------------- store
def store_export(conn, data: dict[str, list[dict]]) -> tuple[int, int]:
    """Insert new in-scope cases and refresh parties/status on known ones. Returns (in-scope cases, new)."""
    complaints_collect.ensure_county_schema(conn)
    parties: dict[str, list[dict]] = {}
    for p in data["Party"]:
        parties.setdefault(p["UniformCaseNumber"], []).append(p)
    dockets: dict[str, list[dict]] = {}
    for d in data["Docket"]:
        dockets.setdefault(d["UniformCaseNumber"], []).append(d)
    found = new = 0
    for c in data["Case"]:
        ucn = clean(c.get("UniformCaseNumber"))
        code, top = band_of(c.get("CaseType"))
        if code == "CI-OTHER" or not ucn:
            continue
        found += 1
        pp = parse_parties(parties.get(ucn, []))
        comp = pick_complaint(dockets.get(ucn, []))
        meta = {**pp, "ucn": ucn, "judge": clean(c.get("Judge")) or None, "band_candidate": top,
                "disposition": clean(c.get("Disposition")) or None, "disposition_date": iso(c.get("DispositionDate")),
                "docket_entries": len(dockets.get(ucn, [])),
                "complaint": {"docket_date": iso(comp.get("DocketDate")), "description": clean(comp.get("dockettext"))} if comp else None,
                "source": "Citrus Clerk Bulk Data Export"}
        case_id, number = ID_PREFIX + ucn, clean(c.get("CaseNumber"))
        status = "pending" if top else "below_band_threshold"
        note = NO_DOC_NOTE if top else "Claim band under $250,000: below the $500,000 threshold"
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (case_id, number, code, clean(c.get("CaseType")), iso(c.get("FileDate")), case_style(pp),
             clean(c.get("CaseStatus")) or None, now(), status, note, COUNTY, json.dumps(meta)))
        if cur.rowcount:
            new += 1
            continue
        if not conn.execute("SELECT 1 FROM foreclosure_cases WHERE case_id=?", (case_id,)).fetchone():
            print(f"  WARNING {number}: not stored, its case number collides with another county's row")
            continue
        conn.execute("""UPDATE foreclosure_cases SET case_status=COALESCE(?, case_status), case_style=COALESCE(?, case_style),
                        metadata_json=? WHERE case_id=?""",
                     (clean(c.get("CaseStatus")) or None, case_style(pp), json.dumps(meta), case_id))
    conn.commit()
    return found, new


def collect_range(conn, site: CitrusExport, d_from: date, d_to: date) -> tuple[int, int, int]:
    """Export d_from..d_to (d_to exclusive) a week at a time. Returns (in-scope cases, new, windows that answered 500)."""
    found = new = failed = 0
    d = d_from
    while d < d_to:
        w_to = min(d + timedelta(days=WINDOW_DAYS), d_to)
        data = site.export(d, w_to - timedelta(days=1))
        if data is None:
            failed += 1
            print(f"  {d}..{w_to - timedelta(days=1)}: export answered HTTP 500 twice; counted as no filings yet")
            time.sleep(EXPORT_PAUSE)
            d = w_to
            continue
        if len(data["Case"]) >= EXPORT_CAP:
            print(f"  WARNING {d}..{w_to}: {len(data['Case'])} cases, the export's cap; narrow WINDOW_DAYS")
        f, n = store_export(conn, data)
        found, new = found + f, new + n
        print(f"  {d}..{w_to - timedelta(days=1)}: {len(data['Case'])} Circuit Civil cases, {f} in-scope foreclosures ({n} new)")
        time.sleep(EXPORT_PAUSE)
        d = w_to
    return found, new, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="d_from")
    ap.add_argument("--to", dest="d_to")
    ap.add_argument("--days", type=int, help="export the last N days")
    a = ap.parse_args()
    if a.days:
        d_to, d_from = date.today() + timedelta(days=1), date.today() - timedelta(days=a.days)
    elif a.d_from and a.d_to:
        d_from, d_to = date.fromisoformat(a.d_from), date.fromisoformat(a.d_to) + timedelta(days=1)
    else:
        sys.exit("give --days N or --from/--to")
    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    try:
        print(f"exporting Citrus Circuit Civil filings {d_from}..{d_to - timedelta(days=1)}")
        found, new, failed = collect_range(conn, CitrusExport(), d_from, d_to)
        print(f"in-scope cases {found}, new {new}, windows with no export (HTTP 500) {failed}")
    except BlockedError as e:
        print(f"STOPPED: {e}")
        sys.exit(3)
    for r in conn.execute("SELECT complaint_status, COUNT(*) n FROM foreclosure_cases WHERE county=? GROUP BY 1", (COUNTY,)):
        print(f"  {r['complaint_status']}: {r['n']}")
    windows = -(-(d_to - d_from).days // WINDOW_DAYS)
    if failed and failed == windows and windows > 1:
        print("every window answered HTTP 500: the export is down or has changed")
        sys.exit(2)


if __name__ == "__main__":
    main()
