"""Offline checks for the Citrus bulk-export collector (no network).

Fixtures are inline: the column names and value shapes are those of the Citrus Clerk's Bulk Data Export CSVs
(export_Case / export_Party / export_Docket, captured 10 Nov 2026); party names are made up. Also checks that the
Miami-Dade fetch stage never picks up another county's pending rows.

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
check(r1["complaint_status"] == "pending" and r1["note"] == cc.NO_DOC_NOTE, "top band pending, no-document note")
check(rows["CI:" + U3]["complaint_status"] == "below_band_threshold", "lower band stored below threshold")
check(r1["filing_date"] == "2026-11-04" and r1["case_number"] == "2026 CA 000901 A" and r1["case_type_code"] == "CI-NH-3", "row fields")
m1 = json.loads(r1["metadata_json"])
check(m1["complaint"]["description"] == "VERIFIED COMPLAINT TO FORECLOSE MORTGAGE" and m1["judge"] == "JUDGE, ONE A", f"meta {m1}")
check(cc.store_export(db, DATA) == (3, 0), "re-export adds nothing")
closed = dict(DATA, Case=[dict(c, CaseStatus="CLOSED") if c["UniformCaseNumber"] == U1 else c for c in DATA["Case"]])
cc.store_export(db, closed)
check(db.execute("SELECT case_status FROM foreclosure_cases WHERE case_id=?", ("CI:" + U1,)).fetchone()[0] == "CLOSED", "status refreshed")

# --- the Miami-Dade fetch stage leaves other counties' pending rows alone
due = [r["case_id"] for r in complaints_collect.due_for_fetch(db)]
check(due == ["999"], f"Miami-Dade due_for_fetch picks only Miami-Dade rows: {due}")

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: citrus_complaints offline checks passed")
