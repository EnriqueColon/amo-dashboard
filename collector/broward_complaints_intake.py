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
  - plaintiff is not a condo / homeowners / community association (their liens are not mortgages).
    A lender whose name says "National Assn" (U S BANK TRUST NATIONAL ASSN ...) is NOT an association:
    until 17 Nov 2026 the word ASSN alone dropped ~1 in 10 lender cases (14 in 10 days).
  - case filed this year or last (a lis pendens on an old case is not a new foreclosure).
  - a lis pendens with NO case number ("-NOT SHOWN", "-OTHER", blank) is still listed (id BR:LP-<instrument>),
    so a person can find the case by party name (owner 17 Nov 2026: "make sure we get everything").
The person checks the case type on the Clerk's case page and skips Homestead cases.

Tiers (owner, 17 Nov 2026; collector/broward_property_roll.py): nothing is hidden, cases are only RANKED.
The lis pendens image (same county feed, img.zip) is OCR'd ONLY to read the property's folio / "a/k/a" address
(never stored or shown as a document); that, or the borrower's name, is looked up in the state property roll:
1 company borrower or non-residential parcel, 2 no homestead exemption, 3 unknown, 4 homestead exemption.

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
# Lender words: a plaintiff with one of these is a lender even when its name contains ASSN ("NATIONAL ASSN").
LENDER_RE = re.compile(r"\b(NATIONAL|NATL|BANK|BANCORP|SAVINGS|FEDERAL|TRUST COMPANY|TRUSTEE|MORTGAGE|MTG|LOAN|"
                       r"LENDING|FUNDING|FINANCIAL|SERVICING|CREDIT UNION)\b")
COUNTY_COURT_RE = re.compile(r"^(CO[A-Z]{2}|PR|DR|FM|CT|MM|CJ|TR|IN)[A-Z]*-")
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
    is_association = lambda p: bool(ASSOCIATION_RE.search(p)) and not LENDER_RE.search(p)
    cases: dict[str, dict] = {}
    for file_date, name in files:
        doc = bc.read_remote_text(sftp, f"{bc.DAILY_DIR}/{name}")
        lps = bc.parse_doc_records(doc, {"LP"}, None, None)
        if not lps:
            continue
        names = bc.parse_name_records(bc.read_remote_text(sftp, f"{bc.DAILY_DIR}/{name.replace('doc-ver', 'nme-ver')}"), set(lps))
        for instr, r in lps.items():
            raw = (r.get("case_number") or "").upper().strip()
            m = CASE_RE.match(raw)
            if r["rec_date"] < since:
                continue
            if m:
                if int(m.group(1)) < min_year:
                    continue
                case_number = f"CACE-{m.group(1)}-{m.group(2).zfill(6)}"
                case_id = f"BR:{case_number}"
            elif COUNTY_COURT_RE.match(raw):
                continue  # County Court (<= $50,000) or another court
            else:
                case_number, case_id = f"LP-{instr}", f"BR:LP-{instr}"  # no usable case number on the lis pendens
            n = names.get(instr, {})
            plaintiffs, defendants = n.get("grantors", []), n.get("grantees", [])
            if not plaintiffs or any(is_association(p) for p in plaintiffs):
                continue
            c = cases.setdefault(case_number, {
                "case_id": case_id, "case_number": case_number, "no_case_number": not m, "raw_case_number": raw,
                "recorded": r["rec_date"], "plaintiffs": plaintiffs, "defendants": defendants,
                "lis_pendens": [], "feed_file": file_date,
            })
            c["lis_pendens"].append(instr)
            c["recorded"] = min(c["recorded"], r["rec_date"])
    return list(cases.values())


ADDRESS_RE = re.compile(
    r"(?:A\s*/\s*K\s*/\s*A|ALSO\s+KNOWN\s+AS|COMMONLY\s+KNOWN\s+AS|PROPERTY\s+ADDRESS|STREET\s+ADDRESS|ADDRESS)"
    r"\s*[:.\-]*\s*(\d{1,6}\s+[^,;]{3,60},\s*[A-Z .']{3,30},?\s*(?:FL|FLORIDA)\.?,?\s*3\d{4})", re.I)
FOLIO_RE = re.compile(r"(?:FOLIO|PARCEL\s+(?:ID|NO|NUMBER)|PCN|TAX\s+ID)\s*(?:NO\.?|NUMBER|#)?\s*[:#.]?\s*(\d[\d\s\-]{10,20}\d)", re.I)


def lis_pendens_property(sftp, cases: list[dict]) -> None:
    """OCR each case's lis pendens image ONLY to read the property's folio and street address (for the tier).
    Images come from the same county feed (img.zip per day). Nothing from the image is stored but those two."""
    import subprocess
    import tempfile
    import broward_images as bi
    by_day: dict[str, list[dict]] = {}
    for c in cases:
        by_day.setdefault(c["feed_file"], []).append(c)
    zips = {}
    for n in sftp.listdir(bc.DAILY_DIR):
        m = bi.IMG_ZIP_RE.match(n)
        if m:
            zips[f"{m.group(3)}-{m.group(1)}-{m.group(2)}"] = n
    for day, cs in by_day.items():
        if day not in zips:
            continue
        want = {i: c for c in cs for i in c["lis_pendens"]}
        try:
            z, handle, _ = bi.read_central_directory(sftp, f"{bc.DAILY_DIR}/{zips[day]}")
            pages: dict[str, list] = {}
            for info in z.infolist():
                mm = bi.ENTRY_RE.match(os.path.basename(info.filename))
                if mm and mm.group(1) in want:
                    pages.setdefault(mm.group(1), []).append((int(mm.group(2)), info))
            for instr, ps in pages.items():
                text = ""
                with tempfile.TemporaryDirectory() as td:
                    for no, info in sorted(ps, key=lambda x: x[0]):
                        f = os.path.join(td, f"{no}.tif")
                        with open(f, "wb") as fh:
                            fh.write(bi.extract_entry(handle, info))
                        text += subprocess.run(["tesseract", f, "-", "--psm", "6"], capture_output=True, text=True,
                                               timeout=120).stdout + "\n"
                flat = re.sub(r"\s+", " ", text)
                c = want[instr]
                a, fo = ADDRESS_RE.search(flat), FOLIO_RE.search(flat)
                if a and not c.get("lp_address"):
                    c["lp_address"] = a.group(1).strip()
                if fo and not c.get("lp_folio"):
                    c["lp_folio"] = re.sub(r"\D", "", fo.group(1))
                c["lp_read"] = True
        except Exception as e:  # never let the reading stop the case list
            print(f"  lis pendens images for {day}: {e}")


def add_tiers(cases: list[dict]) -> None:
    import broward_property_roll as bpr
    roll = bpr.open_roll()
    if roll is None:
        print("  property roll not loaded (broward_property_roll.py --load): every case is tier 3 'unknown'")
    for c in cases:
        c.update({f"tier_{k}" if k != "tier" else "tier": v
                  for k, v in bpr.classify(roll, c["defendants"], c.get("lp_address"), c.get("lp_folio")).items()})
        c["roll_year"] = bpr.roll_year(roll) if roll is not None else None


def store(conn, cases: list[dict]) -> int:
    complaints_collect.ensure_county_schema(conn)
    new = 0
    for c in cases:
        style = f"{c['plaintiffs'][0]} vs {c['defendants'][0] if c['defendants'] else 'UNKNOWN'}"
        meta = {"plaintiffs": c["plaintiffs"], "defendants": c["defendants"],
                "found_by": "lis pendens in the county Official Records feed (case list only)",
                "lis_pendens_instruments": c["lis_pendens"], "lis_pendens_recorded": c["recorded"]}
        for k in ("no_case_number", "raw_case_number", "lp_address", "lp_folio", "lp_read", "tier", "tier_reason",
                  "tier_basis", "roll_year"):
            if c.get(k) is not None:
                meta[k] = c[k]
        cur = conn.execute(
            """INSERT OR IGNORE INTO foreclosure_cases
               (case_id, case_number, case_type_code, case_type, filing_date, case_style, case_status,
                first_seen, complaint_status, note, county, metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (c["case_id"], c["case_number"], "BR-CA", "Circuit Civil foreclosure (type on case page)",
             c["recorded"], style, "Open", now_iso(), "pending", None, COUNTY, json.dumps(meta)))
        new += cur.rowcount
        if not cur.rowcount:
            # already listed: refresh only the ranking (and what it was based on), never the status
            row = conn.execute("SELECT metadata_json FROM foreclosure_cases WHERE case_id = ?", (c["case_id"],)).fetchone()
            old = json.loads(row[0] or "{}") if row else {}
            old.update({k: v for k, v in meta.items() if k.startswith(("tier", "lp_", "roll_")) or k == "no_case_number"})
            conn.execute("UPDATE foreclosure_cases SET metadata_json = ? WHERE case_id = ?", (json.dumps(old), c["case_id"]))
    conn.commit()
    return new


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--extract", action="store_true", help="read uploaded Broward complaints not yet read")
    ap.add_argument("--model", default=os.environ.get("COMPLAINTS_MODEL", "gpt-5.5"))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15")))
    args = ap.parse_args()

    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    known = {r[0]: json.loads(r[1] or "{}") for r in conn.execute(
        "SELECT case_id, metadata_json FROM foreclosure_cases WHERE county = ?", (COUNTY,))}
    client, sftp = bc.connect()
    try:
        cases = lis_pendens_cases(sftp)
        # read each lis pendens image once (new cases, and listed ones not read yet)
        for c in cases:
            m = known.get(c["case_id"], {})
            for k in ("lp_address", "lp_folio", "lp_read"):
                if m.get(k) is not None:
                    c[k] = m[k]
        todo = [c for c in cases if not c.get("lp_read")]
        print(f"reading {len(todo)} lis pendens image(s) for the property address")
        lis_pendens_property(sftp, todo)
    finally:
        client.close()
    add_tiers(cases)
    print(f"{len(cases)} Broward circuit-civil lender foreclosure case(s) in the feed's current files")
    if args.dry_run:
        for c in sorted(cases, key=lambda x: x["recorded"]):
            print(f"  {c['case_number']}  {c['recorded']}  tier {c.get('tier')}  {c['plaintiffs'][0][:34]}  vs  "
                  f"{(c['defendants'] or ['?'])[0][:26]}  | {c.get('tier_reason', '')[:90]}")
        return 0

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
