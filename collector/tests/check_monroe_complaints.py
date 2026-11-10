"""Offline checks for the Monroe foreclosure-complaints collector (no network).

Fixtures are inline: the field names and value shapes are those cr.monroe-clerk.com returns from
ReadCaseList, ReadPartyListDetails and ReadDocketDetails (captured 10 Nov 2026); party names are made up.

  collector/.venv/bin/python3 collector/tests/check_monroe_complaints.py
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
import monroe_complaints as mc  # noqa: E402

failures: list[str] = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def row(case_id, nbr, ctype, style, dt="/Date(1793941200000)/"):
    return {"RecNumber": 1, "CaseId": case_id, "CaseNbr": nbr, "DtFile": dt, "JudgeName": "Judge One",
            "Division": "Circuit Civil Key West", "Style": style, "CaseType": ctype, "CaseStatus": "Pending",
            "EncryptCaseId": f"ENC{case_id}==", "DOBDefendant": None}


SEARCH = [row(1, "26-CA-000001-K", "Non-Homestead Residential Foreclosure", "BANK ONE  vs DOE, JANE,UNKNOWN TENANT 1"),
          row(2, "26-CA-000002-P", "Commercial Foreclosure - $250,000 or More", "LENDER LLC vs ACME HOLDINGS LLC"),
          row(3, "26-CA-000003-M", "Commercial Foreclosure - $50,001 - $249,999", "SMALL BANK vs ROE, RICHARD"),
          row(4, "26-CA-000004-K", "Commercial Foreclosure", "CREDITOR INC vs SHOP LLC"),
          row(5, "26-CA-000005-K", "Homestead Residential Foreclosure", "BANK TWO vs HOME OWNER")]

PARTIES = [{"CasePartyId": 1, "FullName": " BANK ONE     ", "PartyConnDesc": "PLAINTIFF", "AttorneyFullName": "Pat Counsel", "AttyWorkPhone": "305-555-0100"},
           {"CasePartyId": 2, "FullName": "JANE DOE    ", "PartyConnDesc": "DEFENDANT", "AttorneyFullName": " ", "AttyWorkPhone": None},
           {"CasePartyId": 3, "FullName": " UNKNOWN TENANT 1    ", "PartyConnDesc": "DEFENDANT", "AttorneyFullName": " ", "AttyWorkPhone": None}]


def ev(eid, code, desc, pages, group="PUB", ver="V==", ftype="pdf", dt="/Date(1793941200000)/"):
    return {"EventId": eid, "EventTypeCode": code, "EventTypeDesc": desc, "DocPageCount": pages, "IsDocViewable": True,
            "DocumentSecurityGroup": group, "DocumentVersionString": ver, "FileType": ftype, "EventDate": dt}


DOCKET = [ev(10, "CASIGNSUM", "Signed Summons", 2, dt="/Date(1794200400000)/"),
          ev(9, "CLAIMO", "Claim Amount at Filing Over $100,000.00", None, ver="SHARED=="),
          ev(8, "CAC", "Complaint", 29, ver="COMPLAINT=="),
          ev(7, "CACCS", "Civil Cover Sheet", 3),
          ev(6, "CAC", "Complaint", None, ver="SHARED==")]

HEADER = ("<div>Case Header</div><div>Case Type:</div><div>Non-Homestead Residential Foreclosure</div><div>Date Filed:</div>"
          "<div>11/6/2026</div><div>Location:</div><div>Circuit Civil Key West</div><div>UCN:</div><div>442026CA000001A001KW</div>"
          "<div>Judge:</div><div>Judge One</div><div>Status:</div><div>Pending</div><div>Citation Number:</div><div>Appear By Date:</div>"
          "<div>Parties</div>")

# --- dates and bands
check(mc.ms_date("/Date(1793941200000)/") == "2026-11-06", f"ms_date {mc.ms_date('/Date(1793941200000)/')}")
for label, code, cand in [("Commercial Foreclosure", "MO-COM-U", True),
                          ("Commercial Foreclosure - $250,000 or More", "MO-COM-3", True),
                          ("Commercial Foreclosure - $50,001 - $249,999", "MO-COM-LOW", False),
                          ("Commercial Foreclosure - up to $30,000", "MO-COM-LOW", False),
                          ("Non-Homestead Residential Foreclosure", "MO-NH-U", True),
                          ("Non-Homestead Residential Foreclosure - $250,000 or More", "MO-NH-3", True),
                          ("Non-Homestead  Residential Foreclosure - $30,001 - $50,000", "MO-NH-LOW", False),
                          ("Homestead Residential Foreclosure", "MO-OTHER", False)]:
    check(mc.band_of(label) == (code, cand), f"band_of({label!r}) = {mc.band_of(label)}")
for text, ceil in [("Claim Amount at Filing $50,001 - $75,000", 75000), ("Claim Amount at Filing Over $100,000.00", None),
                   ("Claim Amount at Filing $0 - $15,000", 15000), (None, None)]:
    check(mc.claim_ceiling(text) == ceil, f"claim_ceiling({text!r}) = {mc.claim_ceiling(text)}")

# --- parsing
p = mc.parse_parties(PARTIES)
check(p["plaintiffs"] == ["BANK ONE"] and p["defendants"] == ["JANE DOE", "UNKNOWN TENANT 1"], f"parties {p}")
check(p["attorneys"] == ["Pat Counsel"] and p["attorney_phones"] == ["305-555-0100"], f"attorney {p}")
h = mc.parse_header(HEADER)
check((h["file_date"], h["ucn"], h["status"], h["location"]) == ("2026-11-06", "442026CA000001A001KW", "Pending", "Circuit Civil Key West"), f"header {h}")
c = mc.pick_complaint(DOCKET)
check(c and c["EventId"] == 8, f"complaint pick {c}")
check(mc.pick_complaint([ev(1, "CAAMC", "Amended Complaint", 10)]) is None, "amended complaint is not the complaint")
check(mc.claim_entry(DOCKET) == "Claim Amount at Filing Over $100,000.00", "claim entry")

# --- storage: Miami-Dade schema first (no county column), then Monroe rows
tmp = tempfile.mkdtemp()
db = sqlite3.connect(os.path.join(tmp, "t.db"))
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE foreclosure_cases (case_id TEXT PRIMARY KEY, case_number TEXT UNIQUE NOT NULL, case_type_code TEXT NOT NULL,
              case_type TEXT, filing_date TEXT, case_style TEXT, case_status TEXT, first_seen TEXT NOT NULL,
              complaint_status TEXT NOT NULL DEFAULT 'pending', complaint_din INTEGER, complaint_pdf TEXT, complaint_sha256 TEXT,
              attempts INTEGER NOT NULL DEFAULT 0, last_attempt TEXT, note TEXT)""")
db.execute("INSERT INTO foreclosure_cases (case_id, case_number, case_type_code, case_type, first_seen) VALUES ('999','2025-017183-CA-01','27185','RPMF-Commercial','2026-01-01')")
found, new = mc.store_cases(db, SEARCH, include_lower=False)
check((found, new) == (4, 4), f"stored {found} {new} (homestead must be skipped)")
rows = {r["case_id"]: r for r in db.execute("SELECT * FROM foreclosure_cases WHERE county='MONROE'")}
check(set(rows) == {"MO:1", "MO:2", "MO:3", "MO:4"}, f"case ids {set(rows)}")
check(rows["MO:3"]["complaint_status"] == "below_band_threshold", "lower band not fetched")
check(rows["MO:1"]["complaint_status"] == "pending" and rows["MO:4"]["complaint_status"] == "pending", "band-less types are read")
check(rows["MO:1"]["filing_date"] == "2026-11-06" and rows["MO:1"]["case_style"] == "BANK ONE vs DOE, JANE,UNKNOWN TENANT 1", "row fields")
check(json.loads(rows["MO:1"]["metadata_json"])["enc_id"] == "ENC1==", "encrypted id kept for later fetches")
check(db.execute("SELECT county FROM foreclosure_cases WHERE case_id='999'").fetchone()[0] == "MIAMI-DADE", "Miami-Dade row keeps its county")
check(mc.store_cases(db, SEARCH, include_lower=False) == (4, 0), "re-search adds nothing")


# --- fetch
class FakeSite:
    def __init__(self, docket, pdf=b"%PDF-1.7 fake"):
        self.docket, self.data, self.pdf_calls = docket, pdf, []

    def case(self, enc):
        return {"header_html": HEADER, "parties": PARTIES, "docket": self.docket}

    def pdf(self, ver):
        self.pdf_calls.append(ver)
        return self.data


mc.CASE_PAUSE = mc.IMAGE_PAUSE = 0
mc.PDF_DIR = Path(tmp) / "pdfs"
site = FakeSite(DOCKET)
check(mc.fetch_one(db, site, rows["MO:1"]) == "downloaded", "public complaint downloaded")
r1 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id='MO:1'").fetchone()
meta = json.loads(r1["metadata_json"])
check(site.pdf_calls == ["COMPLAINT=="], f"fetched the paged complaint, not the shared stub: {site.pdf_calls}")
check(Path(r1["complaint_pdf"]).name == "MO_26-CA-000001-K_E8.pdf" and r1["complaint_sha256"], f"pdf stored {r1['complaint_pdf']}")
check(r1["case_style"] == "BANK ONE v. JANE DOE (+1)", f"style {r1['case_style']}")
check(meta["plaintiffs"] == ["BANK ONE"] and meta["attorneys"] == ["Pat Counsel"] and meta["ucn"] == "442026CA000001A001KW", f"meta {meta}")

vor = [dict(e, DocumentSecurityGroup="VORP") if e["EventId"] == 8 else e for e in DOCKET]
check(mc.fetch_one(db, FakeSite(vor), rows["MO:2"]) == "complaint_not_public", "pending-redaction complaint not fetched")
check(db.execute("SELECT note FROM foreclosure_cases WHERE case_id='MO:2'").fetchone()[0].startswith("Complaint not public yet"), "reason recorded")

low = [dict(e, EventTypeDesc="Claim Amount at Filing $50,001 - $75,000") if e["EventId"] == 9 else e for e in DOCKET]
s_low = FakeSite(low)
check(mc.fetch_one(db, s_low, rows["MO:4"]) == "below_band_threshold" and not s_low.pdf_calls, "claim ceiling under $250k skips the download")
check(mc.fetch_one(db, FakeSite([ev(1, "CACCS", "Civil Cover Sheet", 3)]), db.execute("SELECT * FROM foreclosure_cases WHERE case_id='MO:4'").fetchone()) == "no_complaint_entry", "no complaint entry")

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: monroe_complaints offline checks passed")
