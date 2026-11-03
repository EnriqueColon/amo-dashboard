"""
Guardrail & verification suite for `collector/hillsborough_complaints.py`.

Verifies:
  1. Parsing of Hillsborough daily civil filing CSVs (`CivilFiling_YYYYMMDD.csv`):
     - Keeps Commercial & NonHomestead Mortgage Foreclosures (bands 1/2/3).
     - Excludes Homestead and County Civil (`CC`) foreclosures.
     - Groups multi-party rows into a single case with plaintiffs, defendants,
       addresses, and attorneys.
     - Flags Band 3 (`$250,000 or More`) as the candidate band for >= $500k principal.
  2. Multi-county schema migration (`county` column on `foreclosure_cases`).
  3. Attaching local complaint PDFs (`attach_local_complaint_pdfs`) and running
     full extraction (`extract_from_page_text_payload`) to populate all required
     fields: `unpaid_principal`, `right_to_reinstate_clause` (including riders),
     `default_date`, `property_address`, and `computed_meets_criteria`.

Run:
    collector/.venv/bin/python3 collector/tests/check_hillsborough_complaints.py
"""

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any, List

COLLECTOR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, COLLECTOR_DIR)

import complaints_extract  # noqa: E402
import hillsborough_complaints as hc  # noqa: E402

failures: List[str] = []


def check(label: str, got: Any, want: Any) -> None:
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures.append(label)


SAMPLE_CSV = """CaseCategory,CaseTypeDescription,CaseNumber,Title,FilingDate,PartyType,FirstName,MiddleName,LastName/CompanyName,PartyAddress,Attorney
Circuit Civil,"Mortgage Foreclosure - Commercial -3- $250,000 or More",26-CA-011777,APEX COMMERCIAL BANK VS TAMPA BAY INDUSTRIAL LLC,11/02/2026,Plaintiff,,,APEX COMMERCIAL BANK,"100 FINANCIAL PLAZA, TAMPA, FL 33602",SMITH JOHN ESQ
Circuit Civil,"Mortgage Foreclosure - Commercial -3- $250,000 or More",26-CA-011777,APEX COMMERCIAL BANK VS TAMPA BAY INDUSTRIAL LLC,11/02/2026,Defendant,,,TAMPA BAY INDUSTRIAL LLC,"4500 N DALE MABRY HWY, TAMPA, FL 33614",
Circuit Civil,"Mortgage Foreclosure - NonHomestead -2- $50,001 - $249,999",26-CA-011780,SERVICER CORP VS DOE JANE,11/02/2026,Plaintiff,,,SERVICER CORP,"200 MAIN ST, TAMPA, FL 33601",JONES MARY
Circuit Civil,"Mortgage Foreclosure - Homestead -3- $250,000 or More",26-CA-011799,BANK X VS HOMEOWNER JOE,11/02/2026,Plaintiff,,,BANK X,"",
County Civil,CC Real Property/Mortgage Foreclosure,26-CC-054325,HOA INC VS OWNER BOB,11/02/2026,Plaintiff,,,HOA INC,"",
"""


def run_tests() -> None:
    print("1. Testing Hillsborough CivilFiling CSV discovery & filtering...")
    cases = hc.parse_daily_csv_text(SAMPLE_CSV)
    check("Keeps Commercial & NonHomestead, excludes Homestead & CC", len(cases), 2)

    c_comm = next(c for c in cases if c["case_number"] == "26-CA-011777")
    check("Commercial Band 3 marked as candidate", c_comm["is_band3_candidate"], True)
    check("Case ID prefixed with HC:", c_comm["case_id"], "HC:26-CA-011777")
    check("Filing date normalized to ISO YYYY-MM-DD", c_comm["filing_date"], "2026-11-02")
    check("Plaintiffs grouped from multi-row CSV", c_comm["plaintiffs"], ["APEX COMMERCIAL BANK"])
    check("Defendants grouped from multi-row CSV", c_comm["defendants"], ["TAMPA BAY INDUSTRIAL LLC"])
    check("Attorney captured", c_comm["attorneys"], ["SMITH JOHN ESQ"])

    c_nh2 = next(c for c in cases if c["case_number"] == "26-CA-011780")
    check("NonHomestead Band 2 marked is_band3_candidate=False", c_nh2["is_band3_candidate"], False)

    print("\n2. Testing DB storage, county isolation & Band 3 filtering...")
    tmp_dir = Path(tempfile.mkdtemp(prefix="hc_complaints_test_"))
    db_path = tmp_dir / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    found, new = hc.store_discovered_cases(conn, cases, band3_only=False)
    check("Both in-scope cases stored", (found, new), (2, 2))
    # Re-inserting same cases is idempotent
    found2, new2 = hc.store_discovered_cases(conn, cases, band3_only=False)
    check("Idempotent re-run inserts 0 duplicates", new2, 0)

    stored_row = conn.execute(
        "SELECT * FROM foreclosure_cases WHERE case_id='HC:26-CA-011777'"
    ).fetchone()
    check("County column set to HILLSBOROUGH", stored_row["county"], "HILLSBOROUGH")
    check("Initial complaint_status is pending", stored_row["complaint_status"], "pending")

    print("\n3. Testing PDF attachment & full Unpaid-Balance / Reinstatement / Address extraction...")
    pdf_file = tmp_dir / "HC_26-CA-011777_Complaint.pdf"
    pdf_file.write_bytes(b"%PDF-1.4\n%fake complaint pdf bytes for test")
    attached = hc.attach_local_complaint_pdfs(conn, tmp_dir)
    check("Matching complaint PDF attached by case number", attached, 1)

    after_attach = conn.execute(
        "SELECT complaint_status, complaint_pdf FROM foreclosure_cases WHERE case_id='HC:26-CA-011777'"
    ).fetchone()
    check("complaint_status updated to downloaded", after_attach["complaint_status"], "downloaded")

    # Mock `complaints_extract.call_model` to verify full extraction of unpaid principal,
    # rider-deleted reinstatement, default date, and property address into `foreclosure_extractions`
    orig_call_model = complaints_extract.call_model

    def fake_call_model(text: str, model: str, api_key: str):
        return (
            {
                "is_mortgage_foreclosure": True,
                "foreclosure_reason": "Verified complaint to foreclose a commercial mortgage and note.",
                "date_filed": "2026-11-02",
                "document_title": "VERIFIED COMPLAINT FOR COMMERCIAL FORECLOSURE",
                "county_court": "Hillsborough",
                "plaintiff": "APEX COMMERCIAL BANK",
                "defendants": ["TAMPA BAY INDUSTRIAL LLC"],
                "attorney": {
                    "name": "John Smith, Esq.",
                    "firm": "Smith Law PA",
                    "phone": "813-555-0199",
                    "emails": ["jsmith@smithlaw.example.com"],
                },
                "guarantors": [],
                "notes": [
                    {
                        "note_date": "2022-06-15",
                        "original_principal": 1500000.0,
                        "original_lender": "APEX COMMERCIAL BANK",
                        "note_rate_text": "7.25% per annum",
                        "note_rate_page": 14,
                        "maturity_date": "2027-06-15",
                        "latest_extended_maturity": None,
                        "default_date": "2026-05-01",
                        "default_date_page": 4,
                        "other_default_dates": [],
                        "default_reason": "Failure to pay monthly installment due May 1, 2026",
                        "unpaid_principal": 1385420.50,
                        "unpaid_principal_page": 5,
                        "principal_by_defendant": [],
                        "deferred_principal": None,
                        "late_fee_text": "5% of overdue payment",
                        "default_interest_text": "18% per annum",
                        "right_to_reinstate_clause": False,
                        "right_to_reinstate_page": 29,
                        "fannie_freddie_form": False,
                        "sba_mentioned": False,
                    }
                ],
                "properties": [
                    {
                        "address_mortgage": "4500 N DALE MABRY HWY, TAMPA, FL 33614",
                        "address_mortgage_page": 22,
                        "address_note": "4500 N DALE MABRY HWY, TAMPA, FL 33614",
                        "address_note_page": 13,
                        "address_body": "4500 N DALE MABRY HWY, TAMPA, FL 33614",
                        "address_missing_reason": None,
                        "legal_description": "LOT 4 BLOCK 2 TAMPA INDUSTRIAL PARK",
                        "property_county": "Hillsborough",
                    }
                ],
                "lien_priority_quote": "inferior and subordinate to Plaintiff's Mortgage",
                "lien_priority_page": 6,
                "lien_priority_number": 1,
            },
            {"prompt_tokens": 12000, "completion_tokens": 450},
        )

    try:
        complaints_extract.call_model = fake_call_model
        res = hc.extract_from_page_text_payload(
            conn,
            case_id="HC:26-CA-011777",
            pages_text=[
                "VERIFIED COMPLAINT FOR COMMERCIAL FORECLOSURE... unpaid principal of $1,385,420.50",
                "MORTGAGE EXHIBIT... Property Address: 4500 N DALE MABRY HWY, TAMPA, FL 33614",
            ],
            model="gpt-5.5",
            api_key="fake_key",
        )
    finally:
        complaints_extract.call_model = orig_call_model

    check("Unpaid principal extracted ($1,385,420.50 >= $500k)", res["notes"][0]["test_principal"], 1385420.50)
    check("Meets amount threshold", res["notes"][0]["meets_amount"], True)
    check("Right to reinstate is False", res["notes"][0]["right_to_reinstate_clause"], False)
    check("Property address resolved from mortgage exhibit", res["properties"][0]["property_address"], "4500 N DALE MABRY HWY, TAMPA, FL 33614")
    check("Case qualifies (computed_meets_criteria == True)", res["computed_meets_criteria"], True)

    ext_row = conn.execute(
        "SELECT meets_criteria, result_json FROM foreclosure_extractions WHERE case_id='HC:26-CA-011777'"
    ).fetchone()
    check("foreclosure_extractions stored with meets_criteria=1", ext_row["meets_criteria"], 1)


if __name__ == "__main__":
    run_tests()
    if failures:
        print(f"\nFAILED ({len(failures)}): {', '.join(failures)}")
        sys.exit(1)
    print("\nALL HILLSBOROUGH COMPLAINTS PIPELINE CHECKS PASSED")
