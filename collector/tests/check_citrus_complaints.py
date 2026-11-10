"""Offline checks for the Citrus collector (no network).

Fixtures are inline: the column names and value shapes are those of the Citrus Clerk's Bulk Data Export CSVs
(export_Case / export_Party / export_Docket) and of the signed-in case page's docket table (captured 10 Nov 2026);
party names are made up. Also checks that the Miami-Dade fetch stage never picks up another county's pending rows.

  collector/.venv/bin/python3 collector/tests/check_citrus_complaints.py
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
import citrus_complaints as cc  # noqa: E402

failures: list[str] = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def case(ucn, nbr, ctype, status="OPEN"):
    return {"UniformCaseNumber": ucn, "CaseNumber": nbr, "CourtType": "CA", "CourtTypeLong": "CIRCUIT CIVIL",
            "CaseType": ctype, "FileDate": " 2026-11-04 12:10:38", "DispositionDate": "", "CourtTypeCategory": "CIVIL",
            "Judge": "JUDGE, ONE A", "CaseStatus": status, "Disposition": ""}


def party(ucn, desc, last, first="", middle="", suffix="", kind="PRIMARY", addr="", linked="", bar=""):
    return {"UniformCaseNumber": ucn, "Description": desc, "PartyType": kind, "LastName": last, "FirstName": first,
            "MiddleName": middle, "SuffixName": suffix, "Race": "", "DOB": "", "Gender": "", "DLNo": "",
            "ActiveAddress": addr, "LinkedParty": linked, "BarNumber": bar}


def dk(ucn, day, text):
    return {"UniformCaseNumber": ucn, "DocketDate": f" {day} 00:00:00", "dockettext": text}


U1, U2, U3, U4, U5 = (f"092026CA00090{i}XXXAIN" for i in range(1, 6))
DATA = {
    "Case": [case(U1, "2026 CA 000901 A", "NON-HOMESTEAD FC>250,000"),
             case(U2, "2026 CA 000902 A", "COMML MTG FORECL >250,000"),
             case(U3, "2026 CA 000903 A", "NON-HOMESTEAD FC >50 <249"),
             case(U4, "2026 CA 000904 A", "HOMESTEAD FC >250,000"),
             case(U5, "2026 CA 000905 A", "AUTO NEGLIGENCE")],
    "Party": [party(U1, "Plaintiff", "FIRST LENDING BANK NA", addr="PO BOX 1, TAMPA, FL 33601"),
              party(U1, "Attorney", "COUNSEL", "PAT", "Q", "ESQ", linked="FIRST LENDING BANK NA", bar="123456"),
              party(U1, "Affiliated Attorney", "HELPER", "SAM", bar="654321"),
              party(U1, "Attorney", "DEFENSE", "DANA", linked="DOE, JANE", bar="111111"),
              party(U1, "Defendant", "DOE", "JANE", "M", addr="1 MAIN ST, INVERNESS, FL 34450"),
              party(U1, "Defendant", "DOE", "JANIE", kind="AKA"),
              party(U1, "Defendant", "UNKNOWN TENANT IN POSSESSION #1", addr="9 OAK RD, INVERNESS, FL 34450"),
              party(U2, "Plaintiff", "COMMERCE BANK"),
              party(U2, "Defendant", "ACME HOLDINGS LLC")],
    "Docket": [dk(U1, "2026-11-04", "CIVIL COVER SHEET"),
               dk(U1, "2026-11-04", "VERIFIED COMPLAINT TO FORECLOSE MORTGAGE"),
               dk(U1, "2026-11-20", "AMENDED COMPLAINT"),
               dk(U1, "2026-11-21", "MOTION FOR EXTENSION OF TIME TO RESPOND TO COMPLAINT"),
               dk(U2, "2026-11-04", "COMPLAINT")],
}

# --- parsing
check(cc.band_of("NON-HOMESTEAD FC>250,000") == ("CI-NH-3", True), "non-homestead top band")
check(cc.band_of("COMML MTG FORECL >250,000") == ("CI-COM-3", True), "commercial top band")
check(cc.band_of("COMML MTG FORECL 50 - 249") == ("CI-COM-LOW", False), "commercial lower band")
check(cc.band_of("NON-HOMESTEAD FC <50,000") == ("CI-NH-LOW", False), "non-homestead lowest band")
check(cc.band_of("HOMESTEAD FC >250,000")[0] == "CI-OTHER", "homestead out of scope")
check(cc.band_of("REAL PROPERTY >250000")[0] == "CI-OTHER", "other real property out of scope")
check(cc.iso(" 2026-11-03 16:07:40") == "2026-11-03" and cc.iso("") is None, "dates")
pp = cc.parse_parties([p for p in DATA["Party"] if p["UniformCaseNumber"] == U1])
check(pp["plaintiffs"] == ["FIRST LENDING BANK NA"], f"plaintiffs {pp['plaintiffs']}")
check(pp["defendants"] == ["DOE, JANE M", "UNKNOWN TENANT IN POSSESSION #1"], f"defendants (AKA skipped) {pp['defendants']}")
check(pp["attorneys"] == ["COUNSEL, PAT Q ESQ"] and pp["attorney_bars"] == ["123456"], f"plaintiff attorney only {pp['attorneys']}")
check({"role": "defendant", "name": "UNKNOWN TENANT IN POSSESSION #1", "address": "9 OAK RD, INVERNESS, FL 34450"} in pp["party_addresses"], "addresses kept")
comp = cc.pick_complaint([d for d in DATA["Docket"] if d["UniformCaseNumber"] == U1])
check(comp and comp["dockettext"] == "VERIFIED COMPLAINT TO FORECLOSE MORTGAGE", f"complaint entry {comp}")
check(cc.case_style(pp) == "FIRST LENDING BANK NA v. DOE, JANE M (+1)", f"style {cc.case_style(pp)}")
tenant_first = dict(pp, defendants=["UNKNOWN TENANT 2", "DOE, JANE M"])
check(cc.case_style(tenant_first) == "FIRST LENDING BANK NA v. DOE, JANE M (+1)", "style names a real defendant before unknown tenants")

# --- store
tmp = tempfile.mkdtemp()
db = sqlite3.connect(os.path.join(tmp, "t.db"))
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE foreclosure_cases (case_id TEXT PRIMARY KEY, case_number TEXT UNIQUE NOT NULL, case_type_code TEXT NOT NULL,
              case_type TEXT, filing_date TEXT, case_style TEXT, case_status TEXT, first_seen TEXT NOT NULL,
              complaint_status TEXT NOT NULL DEFAULT 'pending', complaint_din INTEGER, complaint_pdf TEXT, complaint_sha256 TEXT,
              attempts INTEGER NOT NULL DEFAULT 0, last_attempt TEXT, note TEXT)""")
db.execute("INSERT INTO foreclosure_cases (case_id, case_number, case_type_code, case_type, first_seen, filing_date) VALUES ('999','2026-000001-CA-01','27185','RPMF-Commercial','2026-01-01','2026-11-01')")
found, new = cc.store_export(db, DATA)
check((found, new) == (3, 3), f"stored {found} {new} (homestead and auto negligence skipped)")
rows = {r["case_id"]: r for r in db.execute("SELECT * FROM foreclosure_cases WHERE county='CITRUS'")}
check(set(rows) == {"CI:" + U1, "CI:" + U2, "CI:" + U3}, f"case ids {set(rows)}")
r1 = rows["CI:" + U1]
check(r1["complaint_status"] == "pending" and r1["note"] is None, "top band pending")
check(rows["CI:" + U3]["complaint_status"] == "below_band_threshold", "lower band stored below threshold")
check(r1["filing_date"] == "2026-11-04" and r1["case_number"] == "2026 CA 000901 A" and r1["case_type_code"] == "CI-NH-3", "row fields")
m1 = json.loads(r1["metadata_json"])
check(m1["complaint"]["description"] == "VERIFIED COMPLAINT TO FORECLOSE MORTGAGE" and m1["judge"] == "JUDGE, ONE A", f"meta {m1}")
check(cc.store_export(db, DATA) == (3, 0), "re-export adds nothing")
closed = dict(DATA, Case=[dict(c, CaseStatus="CLOSED") if c["UniformCaseNumber"] == U1 else c for c in DATA["Case"]])
cc.store_export(db, closed)
check(db.execute("SELECT case_status FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()[0] == "CLOSED", "status refreshed")

# --- case page docket (shape of scorss.citrusclerk.org's case page, 10 Nov 2026)
def drow(din, day, text, form_id=None, privacy="SHOW", pages=""):
    img = (f'<form id="form_{form_id}" method="post" action="/viewimage" target="_blank" class="{privacy}">'
           f'<img class="viewimage" id="{form_id}" src="/images/viewimage.png" /></form>') if form_id else ""
    return (f'<tr class="oddrow"><th class="docketnumber">{din}</th><td>{day}</td><td>{text}</td>'
            f'<td style="text-align: center">{img}</td><td style="text-align: center">{pages}</td><td></td></tr>')


PARTY_ROW = '<tr class="evenrow"><td>Plaintiff</td><td>FIRST LENDING BANK NA</td></tr>'
PAGE = ("<html>Welcome someone Logout (someone) Case Number 2026 CA 000901 A" + PARTY_ROW
        + drow(1, "11/04/2026", "CASE FILED 11/04/2026 CASE NUMBER 2026 CA 000901 A")
        + drow(4, "11/04/2026", "CIVIL COVER SHEET", 501, pages="3")
        + drow(5, "11/04/2026", "VERIFIED COMPLAINT FOR RESIDENTIAL FORECLOSURE", 502, pages="29")
        + drow(9, "11/20/2026", "AMENDED COMPLAINT", 503, pages="30") + "</html>")
docket = cc.parse_docket(PAGE)
check([d["din"] for d in docket] == [1, 4, 5, 9], f"docket rows (party rows skipped) {[d['din'] for d in docket]}")
check(docket[2] == {"din": 5, "date": "11/04/2026", "description": "VERIFIED COMPLAINT FOR RESIDENTIAL FORECLOSURE",
                    "docket_id": "502", "privacy": "SHOW", "pages": 29}, f"row fields {docket[2]}")
check(cc.pick_complaint_entry(docket)["docket_id"] == "502", "original complaint, not the amended one")


class FakeCourts:
    def __init__(self, page, data=b"%PDF-1.4 fake"):
        self.page, self.data, self.pdf_calls = page, data, []

    def case(self, number):
        return self.page

    def pdf(self, docket_id, privacy):
        self.pdf_calls.append((docket_id, privacy))
        return self.data


cc.CASE_PAUSE = cc.IMAGE_PAUSE = 0
cc.PDF_DIR = Path(tmp) / "pdfs"
fake = FakeCourts(PAGE)
row1 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()
check(cc.fetch_one(db, fake, row1) == "downloaded" and fake.pdf_calls == [("502", "SHOW")], f"complaint downloaded {fake.pdf_calls}")
r1 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()
check(Path(r1["complaint_pdf"]).name == "CI_2026-CA-000901-A_D5.pdf" and r1["complaint_sha256"] and r1["complaint_din"] == 5, f"pdf stored {r1['complaint_pdf']}")
check(json.loads(r1["metadata_json"])["complaint_doc"]["pages"] == 29, "complaint document kept in metadata")
cc.store_export(db, DATA)
m1 = json.loads(db.execute("SELECT metadata_json FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()[0])
check(m1.get("complaint_doc", {}).get("din") == 5 and m1["plaintiffs"] == ["FIRST LENDING BANK NA"], "re-export keeps the fetch stage's metadata")
check(db.execute("SELECT complaint_status FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()[0] == "downloaded", "re-export keeps the status")

hidden = PAGE.replace('class="SHOW">' + '<img class="viewimage" id="502"', 'class="VOR">' + '<img class="viewimage" id="502"')
row2 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id=?", ("CI:" + U2,)).fetchone()
f2 = FakeCourts(hidden)
check(cc.fetch_one(db, f2, row2) == "complaint_not_public" and not f2.pdf_calls, "image not marked SHOW is not downloaded")
no_comp = "<html>Logout (x) 2026 CA 000902 A" + drow(4, "11/04/2026", "CIVIL COVER SHEET", 501, pages="3") + "</html>"
check(cc.fetch_one(db, FakeCourts(no_comp), row2) == "no_complaint_entry", "no complaint entry")
check([r["case_id"] for r in cc.due_for_fetch(db)] == [], f"due: downloaded not again, just-tried waits a week {[r['case_id'] for r in cc.due_for_fetch(db)]}")
db.execute("UPDATE foreclosure_cases SET last_attempt='2026-01-01T00:00:00Z' WHERE case_id=?", ("CI:" + U2,))
check([r["case_id"] for r in cc.due_for_fetch(db)] == ["CI:" + U2], "no-complaint case retried after a week")


class Resp:
    def __init__(self, text, status=200, ctype="text/html"):
        self.text, self.status_code, self.headers, self.content, self.url = text, status, {"content-type": ctype}, text.encode(), "https://x/case"
        self.request = type("R", (), {"method": "POST", "url": self.url})()

    def raise_for_status(self):
        pass


courts = cc.CitrusCourts("u", "p")
try:
    courts._check(Resp("<html>Welcome Guest ... Anonymous users are required to complete the Captcha requirements</html>"))
    check(False, "signed-out page must stop the run")
except cc.BlockedError:
    pass
try:
    courts._check(Resp("", 429))
    check(False, "429 must stop the run")
except cc.BlockedError:
    pass
courts._check(Resp("<html>Logout (u) case page that loads turnstile for copy requests</html>"))

lower = dict(DATA, Case=[case("092026CA000999XXXAIN", "2026 CA 000999 A", "COMML MTG FORECL 50 - 249")], Party=[], Docket=[])
cc.store_export(db, lower, include_lower=True)
check(db.execute("SELECT complaint_status FROM foreclosure_cases WHERE case_id='CI:092026CA000999XXXAIN'").fetchone()[0] == "pending", "--include-lower-band stores new lower-band cases as pending")

# --- the Miami-Dade fetch stage leaves other counties' pending rows alone
due = [r["case_id"] for r in complaints_collect.due_for_fetch(db)]
check(due == ["999"], f"Miami-Dade due_for_fetch picks only Miami-Dade rows: {due}")

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: citrus_complaints offline checks passed")
