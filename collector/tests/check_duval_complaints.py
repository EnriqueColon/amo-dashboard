"""Offline checks for the Duval foreclosure-complaints collector (no network, no credentials).

Fixtures: tests/fixtures/duval_case.html is real GetCaseById markup from core.duvalclerk.com (line 5 is a
synthetic AMENDED COMPLAINT); duval_search.html follows the search-results structure the portal returns.

  collector/.venv/bin/python3 collector/tests/check_duval_complaints.py
"""
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import complaints_collect  # noqa: E402
import duval_complaints as dc  # noqa: E402
import duval_session  # noqa: E402

failures: list[str] = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


# --- search page
s = dc.parse_search_html((HERE / "fixtures/duval_search.html").read_text())
check([c["case_id"] for c in s["cases"]] == ["14486400", "14486204", "14488262"], f"search ids: {s['cases']}")
check(s["cases"][0]["case_number"] == "2026-CA-007589-AXXX", "search case number")
check(s["cases"][0]["parties"][0] == ("OCEANUS CAPITAL PARTNERS", "P"), f"plaintiff parse: {s['cases'][0]['parties']}")
check(s["cases"][2]["case_type"].startswith("Non-Homestead Residential Foreclosure $50,001"), "case type text")
check(s["pages"] == 1 and s["request_state"] == "STATE123", f"paging info: {s['pages']} {s['request_state']}")

# --- bands: only the $250,000-or-more band can hold $500k of principal
for label, code, cand in [
        ("Commercial Foreclosure $250,000 or More", "DU-COM-3", True),
        ("Commercial Foreclosure $50,001 - $249,999", "DU-COM-2", False),
        ("Commercial Foreclosure $50,000 or Less", "DU-COM-1", False),
        ("Non-Homestead Residential Foreclosure $250,000 or More", "DU-NH-3", True),
        ("Non-Homestead Residential Foreclosure $50,001 -  $249,999", "DU-NH-2", False),
        ("Non-Homestead Residential Foreclosure $0 - $50,000", "DU-NH-1", False),
        ("Homestead Residential Foreclosure", "DU-OTHER", False)]:
    check(dc.band_of(label) == (code, cand), f"band_of({label!r}) = {dc.band_of(label)}")

# --- case page
case_html = (HERE / "fixtures/duval_case.html").read_text()
c = dc.parse_case_html(case_html)
check(c["uniform_case_number"] == "16-2026-CA-007580-AXXX-MA", f"uniform number {c['uniform_case_number']}")
check((c["division"], c["status"], c["file_date"]) == ("FC-D", "OPEN", "2026-10-30"), f"header {c['division']} {c['status']} {c['file_date']}")
check(c["judge"] == "NORTON, VIRGINIA B.", "judge")
check([p["role"] for p in c["parties"]] == ["PLAINTIFF", "DEFENDANT", "DEFENDANT"], f"party roles {[p['role'] for p in c['parties']]}")
check("5053 SAWMILL POINT WAY" in c["parties"][1]["address"], "defendant address")
check(c["attorneys"][0]["bar"] == "871605" and c["attorneys"][0]["name"] == "Zamora, George Steven", f"attorney {c['attorneys']}")
check([d["line"] for d in c["dockets"]] == [1, 2, 3, 4, 5], f"docket lines {[d['line'] for d in c['dockets']]}")
check(c["dockets"][2]["href"] == "/court/case/14486204/docket/237124795/content.pdf", "complaint link")
check(c["dockets"][2]["pages"] == 30 and "VOR, Ready to view" in c["dockets"][2]["image_state"], f"complaint state {c['dockets'][2]}")
check(c["dockets"][0]["href"] is None, "line 1 (case type) has no image")

# the same docket served with a click handler instead of a link (what the Python session received live, 4 Nov 2026)
handler_html = case_html.replace(
    '<a href="/court/case/14486204/docket/237124795/content.pdf" id="c_DocketClerkGridView_c_DocketClerkGridView_ImageContainer_2" target="_blank">',
    '<a id="c_DocketClerkGridView_c_DocketClerkGridView_ImageContainer_2" onclick="javascript:beginImageJob(14486204, 237124795, 0);" style="cursor:pointer">')
hc = dc.parse_case_html(handler_html)
check(hc["dockets"][2]["href"] == "/court/case/14486204/docket/237124795/content.pdf", f"click-handler row -> document URL: {hc['dockets'][2]['href']}")
check(hc["dockets"][2]["cell_html"] is None, "no diagnostic markup kept when a URL was found")

# --- which docket line is the complaint
check(dc.pick_complaint(c["dockets"])["line"] == 3, "picks the original complaint, not the later amended one")
check(dc.pick_complaint([d for d in c["dockets"] if d["line"] != 3 and d["line"] != 5]) is None, "no complaint line -> None")
unreleased = [dict(d, href=None, image_state="View on Request") if d["line"] == 3 else d for d in c["dockets"]]
check(dc.pick_complaint(unreleased)["href"] is None, "unreleased complaint still found (so it is reported, not lost)")

# --- storage: Miami-Dade schema first (no county column), then Duval rows
tmp = Path(tempfile.mkdtemp())
db = sqlite3.connect(tmp / "t.db")
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE foreclosure_cases (case_id TEXT PRIMARY KEY, case_number TEXT UNIQUE NOT NULL, case_type_code TEXT NOT NULL,
  case_type TEXT NOT NULL, filing_date TEXT, case_style TEXT, case_status TEXT, first_seen TEXT NOT NULL,
  complaint_status TEXT NOT NULL DEFAULT 'pending', complaint_din INTEGER, complaint_pdf TEXT, complaint_sha256 TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, last_attempt TEXT, note TEXT)""")
db.execute("INSERT INTO foreclosure_cases (case_id, case_number, case_type_code, case_type, first_seen) VALUES ('999','2025-017183-CA-01','27185','RPMF-Commercial','2026-01-01')")
f, n = dc.store_cases(db, s["cases"], include_lower=False)
check((f, n) == (3, 3), f"first store {f},{n}")
check(dc.store_cases(db, s["cases"], include_lower=False) == (3, 0), "second store adds nothing")
rows = {r["case_id"]: r for r in db.execute("SELECT * FROM foreclosure_cases WHERE county='DUVAL'")}
check(set(rows) == {"DU:14486400", "DU:14486204", "DU:14488262"}, f"ids {set(rows)}")
check(rows["DU:14486400"]["complaint_status"] == "pending" and rows["DU:14488262"]["complaint_status"] == "below_band_threshold", "band decides pending vs below_band")
check(db.execute("SELECT county FROM foreclosure_cases WHERE case_id='999'").fetchone()[0] == "MIAMI-DADE", "Miami-Dade row keeps its county")
check(rows["DU:14486400"]["case_style"] == "OCEANUS CAPITAL PARTNERS v. SECOND HAND ROSE NURSERY (+1)", rows["DU:14486400"]["case_style"])
db.execute("DELETE FROM foreclosure_cases WHERE county='DUVAL'")
dc.store_cases(db, s["cases"], include_lower=True)
check(db.execute("SELECT COUNT(*) FROM foreclosure_cases WHERE county='DUVAL' AND complaint_status='pending'").fetchone()[0] == 3, "--include-lower-band makes all pending")

# --- fetch with a fake session
class FakeCore:
    def __init__(self, html, pdf=b"%PDF-1.4 fake", boom=None):
        self.html, self._pdf, self.boom, self.pdf_calls = html, pdf, boom, []

    def case(self, cid):
        if self.boom:
            raise self.boom
        return {"BodyHtml": self.html}

    def pdf(self, href):
        self.pdf_calls.append(href)
        return self._pdf


dc.CASE_PAUSE = dc.IMAGE_PAUSE = 0
dc.PDF_DIR = tmp / "pdfs"
db.execute("UPDATE foreclosure_cases SET complaint_status='pending'")
row = db.execute("SELECT * FROM foreclosure_cases WHERE case_id='DU:14486204'").fetchone()
fake = FakeCore(case_html)
check(dc.fetch_one(db, fake, row) == "downloaded", "released complaint downloads")
check(fake.pdf_calls == ["/court/case/14486204/docket/237124795/content.pdf"], f"fetched the right document: {fake.pdf_calls}")
r2 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id='DU:14486204'").fetchone()
check(r2["complaint_pdf"].endswith("DU_2026-CA-007580-AXXX_DIN3.pdf") and Path(r2["complaint_pdf"]).read_bytes().startswith(b"%PDF"), f"pdf saved {r2['complaint_pdf']}")
check(r2["filing_date"] == "2026-10-30" and r2["complaint_din"] == 3, f"filing date/din {r2['filing_date']} {r2['complaint_din']}")
meta = json.loads(r2["metadata_json"])
check(meta["uniform_number"] == "16-2026-CA-007580-AXXX-MA" and meta["attorneys"][0]["bar"] == "871605" and meta["division"] == "FC-D", f"metadata {list(meta)}")
row = db.execute("SELECT * FROM foreclosure_cases WHERE case_id='DU:14486400'").fetchone()
unrel_html = case_html.replace('<a href="/court/case/14486204/docket/237124795/content.pdf" id="c_DocketClerkGridView_c_DocketClerkGridView_ImageContainer_2" target="_blank">', '<a>')
check(dc.fetch_one(db, FakeCore(unrel_html), row) == "complaint_not_public", "complaint with no link -> complaint_not_public")
check(db.execute("SELECT note FROM foreclosure_cases WHERE case_id='DU:14486400'").fetchone()[0].startswith("Complaint not released yet"), "reason recorded")
check(dc.fetch_one(db, FakeCore(case_html.replace("COMPLAINT (VERIFIED MORTGAGE FORECLOSURE)", "SUMMONS").replace("AMENDED COMPLAINT", "NOTICE")), db.execute("SELECT * FROM foreclosure_cases WHERE case_id='DU:14488262'").fetchone()) == "no_complaint_entry", "no complaint line")
db.execute("UPDATE foreclosure_cases SET complaint_status='pending' WHERE case_id='DU:14486400'")
# --- dates and full names for cases the search page cannot describe
db.execute("UPDATE foreclosure_cases SET filing_date=NULL, case_style='NAVY FEDERAL CREDIT UNIO v. KATRINA PATRICE W (+1)' WHERE case_id='DU:14486204'")
check(dc.fill_details(db, FakeCore(case_html)) >= 1, "fill_details reads the case page")
r3 = db.execute("SELECT filing_date, case_style, metadata_json FROM foreclosure_cases WHERE case_id='DU:14486204'").fetchone()
check(r3["filing_date"] == "2026-10-30", f"filing date filled: {r3['filing_date']}")
check(r3["case_style"] == "NAVY FEDERAL CREDIT UNION v. KATRINA PATRICE WILLIAMS (+1)", f"full names: {r3['case_style']}")
check(json.loads(r3["metadata_json"])["division"] == "FC-D", "division kept")
db.execute("UPDATE foreclosure_cases SET filing_date=NULL WHERE case_id='DU:14486204'")
try:
    dc.fill_details(db, FakeCore("", boom=duval_session.BotCheckError("bot check")))
    check(False, "a Bot Check during fill_details must stop the run")
except duval_session.BotCheckError:
    pass

try:
    dc.fetch_pending(db, FakeCore("", boom=duval_session.BotCheckError("bot check")))
    check(False, "a Bot Check must stop the run, not be swallowed")
except duval_session.BotCheckError:
    pass

# --- the session client refuses to run without credentials (and never prints them)
for k in ("DUVAL_CORE_USER", "DUVAL_CORE_PASS"):
    os.environ.pop(k, None)
try:
    duval_session.Core()
    check(False, "Core() must not start without credentials")
except duval_session.LoginError as e:
    check("not set" in str(e), str(e))

if failures:
    print("FAIL")
    for x in failures:
        print(" -", x)
    sys.exit(1)
print("check-duval-complaints: all passed")
