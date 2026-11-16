"""
Broward foreclosure complaints: daily case list for Manual Complaint Intake (owner, 16 Nov 2026).

Broward's Clerk publishes no daily list of new civil cases, and its case search has a CAPTCHA, so:
  * the CASE LIST comes from the county's free Official Records SFTP feed (the same feed
    broward_collect.py already reads): each new foreclosure records a lis pendens (doc type LP) that
    carries the Circuit Civil case number (CACE-YY-NNNNNN), the plaintiff and the defendants. The lis
    pendens is used ONLY to learn that the case exists; it is not stored as a document or read.
  * the COMPLAINT is downloaded by a person from the Clerk's case search and uploaded on
    Data -> Manual Complaint Intake; the server reads it (complaints_read_case.py), same reader and
    $500,000 test as every county.

Filters (owner chose "Skip on case page"; the feed has no property type or claim band):
  - Circuit Civil only (CACE-); County Court cases (CONO/COSO/COCE/COWE) are $50,000 and under.
  - plaintiff is not a condo / homeowners / community association (their liens are not mortgages);
  - case filed this year or last (a lis pendens on an old case is not a new foreclosure).
The person checks the case type on the Clerk's case page and skips Homestead cases.

Broward publishes the feed 3-6 business days late, so cases appear about a week after filing.

  python broward_complaints_intake.py                # store new cases from every daily file on the server
  python broward_complaints_intake.py --dry-run      # print what would be stored
  python broward_complaints_intake.py --extract      # also read uploaded Broward complaints not yet read
"""
import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broward_collect as bc  # noqa: E402  (SFTP connection + index parsing)
import complaints_collect  # noqa: E402
import complaints_extract  # noqa: E402

COUNTY = "BROWARD"
CASE_RE = re.compile(r"^CACE-(\d{2})-(\d{4,7})$")
ASSOCIATION_RE = re.compile(
    r"\b(ASSN|ASSOC|ASSOCIATION|CONDOMINIUM|CONDOMINIUMS|CONDO|HOMEOWNERS?|HOA|MAINTENANCE|MASTER|COMMUNITY|"
    r"CLUB|VILLAS|TOWNHOMES|COOPERATIVE|CO-OP|PROPERTY OWNERS)\b")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Owner, 16 Nov 2026: forward only. The newest feed file that day was 13 Nov; nothing recorded before it.
START_DATE = os.environ.get("BROWARD_INTAKE_START", "2026-11-13")


def lis_pendens_cases(sftp, since: str = START_DATE) -> list[dict]:
    """Every in-scope case from the daily files currently on the server (about 10 days), recorded on/after `since`."""
    files = sorted(
        (f"{m.group(3)}-{m.group(1)}-{m.group(2)}", name)
        for name in sftp.listdir(bc.DAILY_DIR) if (m := bc.DAILY_FILE_RE.match(name)))
    min_year = (date.today().year - 1) % 100
    cases: dict[str, dict] = {}
    for file_date, name in files:
        doc = bc.read_remote_text(sftp, f"{bc.DAILY_DIR}/{name}")
        lps = bc.parse_doc_records(doc, {"LP"}, None, None)
        if not lps:
            continue
        names = bc.parse_name_records(bc.read_remote_text(sftp, f"{bc.DAILY_DIR}/{name.replace('doc-ver', 'nme-ver')}"), set(lps))
        for instr, r in lps.items():
            m = CASE_RE.match((r.get("case_number") or "").upper().strip())
            if not m or int(m.group(1)) < min_year or r["rec_date"] < since:
                continue
            n = names.get(instr, {})
            plaintiffs, defendants = n.get("grantors", []), n.get("grantees", [])
            if not plaintiffs or any(ASSOCIATION_RE.search(p) for p in plaintiffs):
                continue
            case_number = f"CACE-{m.group(1)}-{m.group(2).zfill(6)}"
            c = cases.setdefault(case_number, {
                "case_id": f"BR:{case_number}", "case_number": case_number,
                "recorded": r["rec_date"], "plaintiffs": plaintiffs, "defendants": defendants,
                "lis_pendens": [], "feed_file": file_date,
            })
            c["lis_pendens"].append(instr)
            c["recorded"] = min(c["recorded"], r["rec_date"])
    return list(cases.values())


def store(conn, cases: list[dict]) -> int:
    complaints_collect.ensure_county_schema(conn)
    new = 0
    for c in cases:
        style = f"{c['plaintiffs'][0]} vs {c['defendants'][0] if c['defendants'] else 'UNKNOWN'}"
        meta = {"plaintiffs": c["plaintiffs"], "defendants": c["defendants"],
                "found_by": "lis pendens in the county Official Records feed (case list only)",
                "lis_pendens_instruments": c["lis_pendens"], "lis_pendens_recorded": c["recorded"]}
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (c["case_id"], c["case_number"], "BR-CA", "Circuit Civil foreclosure (type on case page)",
             c["recorded"], style, "Open", now_iso(), "pending", None, COUNTY, json.dumps(meta)))
        new += cur.rowcount
    conn.commit()
    return new


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--extract", action="store_true", help="read uploaded Broward complaints not yet read")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    args = ap.parse_args()

    client, sftp = bc.connect()
    try:
        cases = lis_pendens_cases(sftp)
    finally:
        client.close()
    print(f"{len(cases)} Broward circuit-civil lender foreclosure case(s) in the feed's current files")
    if args.dry_run:
        for c in sorted(cases, key=lambda x: x["recorded"]):
            print(f"  {c['case_number']}  {c['recorded']}  {c['plaintiffs'][0][:40]}  vs  {(c['defendants'] or ['?'])[0][:30]}")
        return 0

    conn = complaints_collect.connect()
    new = store(conn, cases)
    print(f"{new} new case(s) stored as To download")
    if args.extract:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set")
        ids = [r["case_id"] for r in conn.execute("SELECT case_id FROM foreclosure_cases WHERE county=?", (COUNTY,))]
        print("Extraction:", complaints_extract.process_pending(conn, args.model, key, budget_usd=args.budget, case_ids=ids))
    return 0


if __name__ == "__main__":
    sys.exit(main())
