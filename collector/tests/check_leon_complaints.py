"""Offline checks for the Leon foreclosure-complaints collector (no network).

Fixtures are inline HTML with the table ids, cell order and checkbox-value shape lforms.leonclerk.com returns
from the name search and the full case view (captured 10 Nov 2026); party names are made up.

  collector/.venv/bin/python3 collector/tests/check_leon_complaints.py
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
import leon_complaints as lc  # noqa: E402

failures: list[str] = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


NH3 = "MORTGAGE FORECLOSURE NON-HOMESTEAD RESIDENTIAL VALUE OF CLAIM IS $250,000 OR MORE"
C3 = "MORTGAGE FORECLOSURE COMMERCIAL VALUE OF CLAIM IS $250,000 OR MORE"
NH2 = "MORTGAGE FORECLOSURE NON-HOMESTEAD RESIDENTIAL MORE THAN $50,000 BUT LESS THAN $250,000"
HR3 = "MORTGAGE FORECLOSURE HOMESTEAD RESIDENTIAL VALUE OF CLAIM IS $250,000 OR MORE"


def srow(party, ptype, action, fdate, caseid, nbr):
    return (f"<tr>\n<td bgcolor=#FFFFFF  width=25%>{party}</td>\n<td bgcolor=#FFFFFF width=5%>&nbsp;</td>\n"
            f"<td bgcolor=#FFFFFF width=15%>{ptype}</td>\n<td bgcolor=#FFFFFF width=20%>{action}</td>\n"
            f"<td bgcolor=#FFFFFF width=5%>{fdate}</td>\n<td bgcolor=#FFFFFF width=5%>JUDGE</td>\n"
            f"<td bgcolor=#FFFFFF width=5%>OPEN</td>\n<td bgcolor=#FFFFFF width=10%>N/A - see case</td>\n"
            f"<td bgcolor=#FFFFFF width=20%><a href=\"javascript:popup('./process.asp?report=full_view&caseid={caseid}&jiscaseid=', 750, 480,'no','no')\">{nbr}</a></td>\n</tr>")


def search_html(rows):
    return ('<script src="https://www.google.com/recaptcha/api.js" async defer></script>'
            '<table class="sortable" id="searchresultstable"><thead role="rowgroup"><tr role="row"><th>Party</th><th> DOB</th>'
            '<th> Party Type</th><th> Action Code</th><th> File Date</th><th> Judge</th><th> Case Status</th><th> Case Balance</th>'
            '<th> Case Number</th></tr></thead>' + "\n".join(rows) + "</table>")


SEARCH_A = search_html([srow("BANK ONE NATIONAL ASSOCIATION", "PLAINTIFF", NH3, "10/30/2026", "100", "2026 CA 000100"),
                        srow("LENDER CAPITAL LLC", "PLAINTIFF", C3, "11/2/2026", "101", "2026 CA 000101"),
                        srow("SMALL CREDIT UNION", "PLAINTIFF", NH2, "11/3/2026", "102", "2026 CA 000102"),
                        srow("HOME BANK", "PLAINTIFF", HR3, "11/4/2026", "103", "2026 CA 000103")])
SEARCH_E = search_html([srow("BANK ONE NATIONAL ASSOCIATION", "PLAINTIFF", NH3, "10/30/2026", "100", "2026 CA 000100"),
                        srow("SECOND LENDER TRUSTEE", "PLAINTIFF", NH3, "10/30/2026", "100", "2026 CA 000100")])


def dkt(date_, dktid, code, desc, image=True):
    link = (f'<a href="image_orders.asp?caseid=100&jiscaseid=&defseq=&chargeseq=&dktid={dktid}&dktsource=BM&sexual_case=" '
            f'target="_new">&nbsp;&nbsp;<img src="images/pdf.png"></a>') if image else ""
    return (f"<tr>\n<td bgcolor=#F8F0E0 valign=top>{date_}</td>\n<td align=\"center\">7</td>\n<td valign=top nowrap>{code}{link}</td>\n"
            f'<td valign=top nowrap>&nbsp;&nbsp;<input id= "{dktid}" name= "RequestECertifyDocument" type="checkbox" '
            f'value="100|{dktid}|BM|{code}|{desc}|sexual_case=" onClick="parent.addrequestecertify(this.value,this.id);"></td>\n'
            f"<td >{desc}</td>\n<td>&nbsp;</td>\n<td>&nbsp;</td>\n<td align=\"center\">BM</td>\n</tr>")


def case_html(docket):
    return ('<script src="https://www.google.com/recaptcha/api.js" async defer></script>'
            '<tr>\n<td colspan=2 bgcolor=""  style="padding: 5px"><b>37 2026 CA 000100 - BANK ONE NATIONAL ASSOCIATION vs DOE, JANE</b></font></td>\n</tr>'
            '<table id="parties_table" ><thead role="rowgroup"><tr role="row"><th>Party Status</th><th> Party</th><th> Party Code</th>'
            '<th> Attorney</th><th> Attorney Status</th></tr></thead>'
            '<tr>\n<td width= 10% ></td>\n<td><a href="process.asp?report=party_drilldown&idntid=1&caseid=100">DOE&nbsp;, JANE</a></td>\n'
            '<td width = 10%>DEFENDANT</td>\n<td><a href="process.asp?report=atty_drilldown&idntid=229&caseid=100">  PRO SE</a></td>\n<td>ACTIVE</td>\n</tr>'
            '<tr>\n<td width= 10% ></td>\n<td><a href="process.asp?report=party_drilldown&idntid=2&caseid=100">UNKNOWN TENANT 1&nbsp;,    </a></td>\n'
            '<td width = 10%>DEFENDANT</td>\n<td><a href="process.asp?report=atty_drilldown&idntid=229&caseid=100">  PRO SE</a></td>\n<td>ACTIVE</td>\n</tr>'
            '<tr>\n<td width= 10% ></td>\n<td><a href="process.asp?report=party_drilldown&idntid=3&caseid=100">BANK ONE NATIONAL ASSOCIATION&nbsp;,    </a></td>\n'
            '<td width = 10%>PLAINTIFF</td>\n<td><a href="process.asp?report=atty_drilldown&idntid=4&caseid=100">PAT  COUNSEL</a></td>\n<td>ACTIVE</td>\n</tr>'
            '</table>'
            '<table id="case_dsp_table" ><thead role="rowgroup"><tr role="row"><th>Action Dscr</th><th> Open/Reopen Status</th>'
            '<th> Open/Reopen Date</th><th> Disposition</th><th> Disposition Date</th><th> Judge</th></tr></thead>'
            f'<tr>\n<td valign=top>{NH3}</td>\n<td valign=top>OPEN</td>\n<td valign=top>10/30/2026 3:47:26 PM</td>\n'
            '<td valign=top>&nbsp;</td>\n<td valign=top>&nbsp;</td>\n<td valign=top>JUDGE ONE</td>\n</tr></table>'
            '<table id="dockets_ecert_table" class="sortable"><thead role="rowgroup"><tr role="row"><th>Docket Date</th></tr></thead>'
            + "\n".join(docket) + "</table>")


DOCKET = [dkt("10/30/2026", "500", "CCS", "CIVIL COVER SHEET"),
          dkt("10/30/2026", "502", "VORP", "VALUE OF REAL PROPERTY OR MORTGAGE FORECLOSURE CLAIM FORM"),
          dkt("10/30/2026", "503", "MTFC3", "COMPLAINT FOR MORTGAGE FORECLOSURE VALUE OF THE CLAIM IS $250,000 OR MORE"),
          dkt("12/1/2026", "600", "AMCO", "AMENDED COMPLAINT")]

# --- bands, dates, names
for label, code, cand in [(NH3, "LE-NH-3", True), (C3, "LE-COM-3", True), (NH2, "LE-NH-LOW", False),
                          ("MORTGAGE FORECLOSURE COMMERCIAL $50,000 OR LESS", "LE-COM-LOW", False), (HR3, "LE-OTHER", False)]:
    check(lc.band_of(label) == (code, cand), f"band_of({label!r}) = {lc.band_of(label)}")
check(lc.us_date("10/30/2026 3:47:26 PM") == "2026-10-30" and lc.us_date("9/3/2026") == "2026-09-03", "us_date")
check(lc.party_name("UNKNOWN TENANT 1&nbsp;,    ") == "UNKNOWN TENANT 1" and lc.party_name("DOE&nbsp;, JANE") == "DOE, JANE", "party_name")

# --- CAPTCHA detection: the pages' unused recaptcha script and commented-out field are not a CAPTCHA
for page in (SEARCH_A, case_html(DOCKET), '<!-- <input type="hidden" name="recaptcha_result" value="true" /> -->'):
    check(not lc.CAPTCHA_RE.search(page.encode()), "unused recaptcha script flagged as a CAPTCHA")
check(lc.CAPTCHA_RE.search(b'<div class="g-recaptcha" data-sitekey="x"></div>'), "a live widget is a CAPTCHA")

# --- search parsing and the per-letter union
cases, n = lc.parse_search(SEARCH_A)
check(n == 4 and set(cases) == {"100", "101", "102", "103"}, f"parse_search {n} {set(cases)}")
check(cases["101"]["file_date"] == "2026-11-02" and cases["101"]["case_number"] == "2026 CA 000101", f"case fields {cases['101']}")


class FakeSite:
    def __init__(self, docket=DOCKET, pdf=b"%PDF-1.7 fake"):
        self.docket, self.data, self.pdf_calls, self.searches = docket, pdf, [], []

    def search(self, d_from, d_to, letter):
        self.searches.append(letter)
        return SEARCH_A if letter == "A" else SEARCH_E if letter == "E" else search_html([])

    def case(self, cid):
        return case_html(self.docket)

    def pdf(self, cid, dktid):
        self.pdf_calls.append((cid, dktid))
        return self.data


lc.SEARCH_PAUSE = lc.CASE_PAUSE = lc.IMAGE_PAUSE = 0
from datetime import date  # noqa: E402
fs = FakeSite()
u = lc.search_window(fs, date(2026, 10, 30), date(2026, 11, 5))
check(fs.searches == list(lc.NAME_LETTERS), f"one search per letter {fs.searches}")
check(len(u) == 4 and u["100"]["plaintiffs"] == ["BANK ONE NATIONAL ASSOCIATION", "SECOND LENDER TRUSTEE"], f"union {u.get('100')}")

# --- case parsing
c = lc.parse_case(case_html(DOCKET))
check(c["plaintiffs"] == ["BANK ONE NATIONAL ASSOCIATION"] and c["defendants"] == ["DOE, JANE", "UNKNOWN TENANT 1"], f"parties {c}")
check(c["attorneys"] == ["PAT COUNSEL"], f"attorney (PRO SE dropped) {c['attorneys']}")
check((c["file_date"], c["status"], c["judge"]) == ("2026-10-30", "OPEN", "JUDGE ONE"), f"action {c}")
check(len(c["docket"]) == 4 and all(d["viewable"] for d in c["docket"]), f"docket {c['docket']}")
p = lc.pick_complaint(c["docket"])
check(p and p["dktid"] == "503", f"complaint pick {p}")
check(lc.pick_complaint([d for d in c["docket"] if d["dktid"] == "600"]) is None, "amended complaint is not the complaint")

# --- storage: Miami-Dade schema first (no county column), then Leon rows
tmp = tempfile.mkdtemp()
db = sqlite3.connect(os.path.join(tmp, "t.db"))
db.row_factory = sqlite3.Row
db.execute("""CREATE TABLE foreclosure_cases (case_id TEXT PRIMARY KEY, case_number TEXT UNIQUE NOT NULL, case_type_code TEXT NOT NULL,
              case_type TEXT, filing_date TEXT, case_style TEXT, case_status TEXT, first_seen TEXT NOT NULL,
              complaint_status TEXT NOT NULL DEFAULT 'pending', complaint_din INTEGER, complaint_pdf TEXT, complaint_sha256 TEXT,
              attempts INTEGER NOT NULL DEFAULT 0, last_attempt TEXT, note TEXT)""")
db.execute("INSERT INTO foreclosure_cases (case_id, case_number, case_type_code, case_type, first_seen) VALUES ('999','2025-017183-CA-01','27185','RPMF-Commercial','2026-01-01')")
found, new = lc.store_cases(db, u, include_lower=False)
check((found, new) == (3, 3), f"stored {found} {new} (homestead must be skipped)")
rows = {r["case_id"]: r for r in db.execute("SELECT * FROM foreclosure_cases WHERE county='LEON'")}
check(set(rows) == {"LE:100", "LE:101", "LE:102"}, f"case ids {set(rows)}")
check(rows["LE:102"]["complaint_status"] == "below_band_threshold", "lower band not fetched")
check(rows["LE:100"]["complaint_status"] == "pending" and rows["LE:101"]["complaint_status"] == "pending", "$250k+ bands are read")
check(db.execute("SELECT county FROM foreclosure_cases WHERE case_id='999'").fetchone()[0] == "MIAMI-DADE", "Miami-Dade row keeps its county")
check(lc.store_cases(db, u, include_lower=False) == (3, 0), "re-search adds nothing")
check({r["case_id"] for r in lc.due_for_fetch(db)} == {"LE:100", "LE:101"}, "due for fetch")

# --- fetch
lc.PDF_DIR = Path(tmp) / "pdfs"
site = FakeSite()
check(lc.fetch_one(db, site, rows["LE:100"]) == "downloaded", "viewable complaint downloaded")
r1 = db.execute("SELECT * FROM foreclosure_cases WHERE case_id='LE:100'").fetchone()
meta = json.loads(r1["metadata_json"])
check(site.pdf_calls == [("100", "503")], f"fetched the complaint entry {site.pdf_calls}")
check(Path(r1["complaint_pdf"]).name == "LE_2026-CA-000100_D503.pdf" and r1["complaint_sha256"] and r1["complaint_din"] == 503, f"pdf stored {r1['complaint_pdf']}")
check(r1["case_style"] == "BANK ONE NATIONAL ASSOCIATION v. DOE, JANE (+1)", f"style {r1['case_style']}")
check(meta["attorneys"] == ["PAT COUNSEL"] and meta["complaint"]["code"] == "MTFC3", f"meta {meta}")

hidden = [dkt("10/30/2026", "503", "MTFC3", "COMPLAINT FOR MORTGAGE FORECLOSURE", image=False)]
s_h = FakeSite(hidden)
check(lc.fetch_one(db, s_h, rows["LE:101"]) == "complaint_not_public" and not s_h.pdf_calls, "non-viewable complaint not fetched")
check(db.execute("SELECT note FROM foreclosure_cases WHERE case_id='LE:101'").fetchone()[0].startswith("Complaint not public yet"), "reason recorded")
check(lc.fetch_one(db, FakeSite([dkt("10/30/2026", "500", "CCS", "CIVIL COVER SHEET")]), rows["LE:101"]) == "no_complaint_entry", "no complaint entry")

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("OK: leon_complaints offline checks passed")
