"""
Broward property roll lookup for Manual Complaint Intake tiers (owner, 17 Nov 2026).

The intake lists EVERY Broward lender foreclosure (nothing is hidden: "make sure we get everything").
This module only RANKS them, so the person works the likely Commercial / Non-Homestead cases first:

  tier 1  certain     borrower is a company (a company can't claim homestead), or the property in the lis
                      pendens is a non-residential parcel
  tier 2  likely      the property (from the lis pendens address, or the borrower's only/all parcels) has no
                      homestead exemption
  tier 3  unknown     no usable match (common name, several properties with mixed exemptions, not found)
  tier 4  likely Homestead   the property has a homestead exemption. STILL LISTED (collapsed): the Clerk's
                      Case Type is the filer's choice and the roll is as of 1 January, so it can disagree.

Source: Florida Department of Revenue NAL (Name-Address-Legal) file for Broward (county 16), e.g.
NAL16F202601.csv from the DOR Data Portal (Tax Roll Data Files -> NAL). Homestead = JV_HMSTD > 0 or
EXMPT_01 > 0 (the 2026 test used the same rule). Load it into its own small DB (not the main DB):

  python broward_property_roll.py --load /path/NAL16F202601.csv      # builds BROWARD_ROLL_DB
  python broward_property_roll.py --case "SMITH,JOHN" --address "519 SW 90TH TERRACE, COOPER CITY, FL 33328"

Reload each year when DOR publishes the new roll (the tiers say which roll year they used).
"""
import argparse
import csv
import os
import re
import sqlite3
import sys

ROLL_DB = os.environ.get("BROWARD_ROLL_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "broward_roll.db"))

# A borrower name that is a company. TRUST and ESTATE are left out on purpose: a living trust or an
# estate can hold a homestead, so they are not "certain".
COMPANY_RE = re.compile(
    r"\b(LLC|L L C|LLLP|LLP|INC|INCORPORATED|CORP|CORPORATION|COMPANY|LP|LTD|LIMITED|PLLC|"
    r"HOLDINGS|PARTNERS|PARTNERSHIP|GROUP|PROPERTIES|INVESTMENTS?|VENTURES|ENTERPRISES|DEVELOPMENT|"
    r"MANAGEMENT|REALTY|CAPITAL|FUND)\b")
# Parties that are named in a foreclosure but are never the borrower (junior lienholders, government).
NOT_BORROWER_RE = re.compile(
    r"\b(ASSN|ASSOCIATION|CONDOMINIUM|CONDO|HOMEOWNERS|MAINTENANCE|SECRETARY|UNITED STATES|STATE OF|"
    r"COUNTY|CITY|TOWN|VILLAGE OF|DEPARTMENT|REVENUE|CLERK|UNKNOWN|TENANT|BANK|MORTGAGE|MTG|FINANCE|"
    r"FINANCIAL|CREDIT|LENDING|FUNDING|SERVICING|PORTFOLIO|MIDLAND|CAPITAL ONE|DISCOVER|AMERICAN EXPRESS)\b")
STREET_SUFFIX = {
    "STREET": "ST", "AVENUE": "AVE", "AV": "AVE", "ROAD": "RD", "DRIVE": "DR", "TERRACE": "TER", "TERR": "TER",
    "COURT": "CT", "PLACE": "PL", "LANE": "LN", "BOULEVARD": "BLVD", "CIRCLE": "CIR", "WAY": "WAY",
    "PARKWAY": "PKWY", "HIGHWAY": "HWY", "TRAIL": "TRL", "PLAZA": "PLZ", "POINT": "PT", "ISLE": "IS",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHWEST": "NW", "NORTHEAST": "NE", "SOUTHWEST": "SW", "SOUTHEAST": "SE",
}
# DOR use codes 000-009 (and 0000-0099 in 4-digit form) are residential; anything else is not.
RESIDENTIAL_UC = re.compile(r"^0*0\d$")


def toks(s: str) -> list[str]:
    return [t for t in re.split(r"[^A-Z0-9]+", (s or "").upper()) if t]


def norm_street(addr: str) -> tuple[str, str]:
    """'519 SW 90" Terrace' -> ('519', 'SW 90 TER'); ordinals dropped (90TH -> 90)."""
    t = toks((addr or "").split("#")[0].split(",")[0] if "," in (addr or "") else (addr or "").split("#")[0])
    if not t or not t[0].isdigit():
        return "", ""
    out = []
    for w in t[1:]:
        w = re.sub(r"^(\d+)(ST|ND|RD|TH)$", r"\1", w)
        w = STREET_SUFFIX.get(w, w)
        if w in ("UNIT", "APT", "STE", "SUITE", "BLDG"):
            break
        out.append(w)
    return t[0], " ".join(out)


def load(csv_path: str, db_path: str = ROLL_DB) -> int:
    tmp = db_path + ".loading"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
        CREATE TABLE parcels (parcel_id TEXT PRIMARY KEY, owner TEXT, homestead INTEGER, jv REAL, use_code TEXT,
                              addr TEXT, city TEXT, zip TEXT, house TEXT, street TEXT, roll_year TEXT);
        CREATE TABLE owner_tokens (tok TEXT, parcel_id TEXT);
        CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    """)
    n = 0
    year = ""
    with open(csv_path, newline="", encoding="latin-1") as fh:
        for r in csv.DictReader(fh):
            pid = (r.get("PARCEL_ID") or "").strip()
            if not pid:
                continue
            year = year or (r.get("ASMNT_YR") or "").strip()
            owner = (r.get("OWN_NAME") or "").upper().strip()
            hm = 1 if (float(r.get("JV_HMSTD") or 0) > 0 or float(r.get("EXMPT_01") or 0) > 0) else 0
            addr = (r.get("PHY_ADDR1") or "").upper().strip()
            house, street = norm_street(addr)
            db.execute("INSERT OR REPLACE INTO parcels VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (pid, owner, hm, float(r.get("JV") or 0), (r.get("DOR_UC") or "").strip(), addr,
                        (r.get("PHY_CITY") or "").upper().strip(), (r.get("PHY_ZIPCD") or "").strip()[:5],
                        house, street, (r.get("ASMNT_YR") or "").strip()))
            db.executemany("INSERT INTO owner_tokens VALUES (?,?)", [(t, pid) for t in set(toks(owner)) if len(t) >= 2])
            n += 1
    db.executescript("""
        CREATE INDEX ix_tok ON owner_tokens(tok);
        CREATE INDEX ix_house ON parcels(house, zip);
        CREATE INDEX ix_house_street ON parcels(house, street);
    """)
    db.execute("INSERT INTO meta VALUES ('roll_year', ?)", (year,))
    db.execute("INSERT INTO meta VALUES ('source', ?)", (os.path.basename(csv_path),))
    db.execute("INSERT INTO meta VALUES ('parcels', ?)", (str(n),))
    db.commit()
    db.close()
    os.replace(tmp, db_path)
    return n


def open_roll(db_path: str = ROLL_DB):
    if not os.path.exists(db_path):
        return None
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def roll_year(db) -> str:
    r = db.execute("SELECT v FROM meta WHERE k='roll_year'").fetchone()
    return r[0] if r else "?"


def parcel_by_folio(db, folio: str) -> list[sqlite3.Row]:
    d = re.sub(r"\D", "", folio or "")
    return db.execute("SELECT * FROM parcels WHERE parcel_id = ?", (d,)).fetchall() if len(d) >= 10 else []


def parcel_by_address(db, address: str) -> list[sqlite3.Row]:
    """Parcels at the lis pendens address: same house number, and the same ZIP or the same street words."""
    house, street = norm_street(address)
    if not house:
        return []
    zips = re.findall(r"\b(3[0-4]\d{3})\b", address or "")
    rows = []
    if zips:
        rows = db.execute("SELECT * FROM parcels WHERE house = ? AND zip = ?", (house, zips[-1])).fetchall()
    if street:
        sw = set(street.split())
        cands = rows or db.execute("SELECT * FROM parcels WHERE house = ?", (house,)).fetchall()
        # keep parcels whose street words are all in the lis pendens street (or the other way round)
        rows = [p for p in cands if p["street"] and (set(p["street"].split()) <= sw or sw <= set(p["street"].split()))]
    # one building can hold many condo units: same address, many parcels. That is still one answer if they agree.
    return rows


def parcels_by_name(db, name: str) -> list[sqlite3.Row]:
    """Parcels owned by a person 'LAST,FIRST MIDDLE': owner name holds the last name and the first name."""
    last, _, first = (name or "").upper().partition(",")
    lt, ft = toks(last), toks(first)[:1]
    if not lt or not ft or len(lt[0]) < 2:
        return []
    ids = [r[0] for r in db.execute("SELECT parcel_id FROM owner_tokens WHERE tok = ?", (lt[0],))]
    if not ids:
        return []
    out = []
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        for p in db.execute(f"SELECT * FROM parcels WHERE parcel_id IN ({','.join('?' * len(chunk))})", chunk):
            ot = set(toks(p["owner"]))
            if all(t in ot for t in lt + ft):
                out.append(p)
    return out


def _person(name: str) -> str:
    """'PHINN,ALEX LEONID' -> 'Alex Leonid Phinn'."""
    last, _, first = name.partition(",")
    return f"{first.strip()} {last.strip()}".strip().title()


def _where(p) -> str:
    return f"{p['addr'].title()}, {p['city'].title()}"


def classify(db, defendants: list[str], address: str | None = None, folio: str | None = None) -> dict:
    """Tier (1-4), a one-line reason in plain words, and what it was based on."""
    defendants = [d for d in (defendants or []) if d]
    first = defendants[0] if defendants else ""
    if first and COMPANY_RE.search(first.upper()) and not NOT_BORROWER_RE.search(first.upper()):
        return {"tier": 1, "basis": "company", "reason": f"Company borrower ({first.title()}): a company can't claim homestead"}
    if db is None:
        return {"tier": 3, "basis": "no_roll", "reason": "Property roll not loaded: check the Case Type on the case page"}
    yr = roll_year(db)
    if folio or address:
        ps = (parcel_by_folio(db, folio) if folio else []) or (parcel_by_address(db, address) if address else [])
        if ps:
            if any(not RESIDENTIAL_UC.match(p["use_code"] or "") for p in ps):
                return {"tier": 1, "basis": "address_use", "reason": f"Non-residential property at {_where(ps[0])} (state roll {yr})"}
            hm = {p["homestead"] for p in ps}
            if hm == {0}:
                return {"tier": 2, "basis": "address", "reason": f"No homestead exemption on {_where(ps[0])} (state roll {yr})"}
            if hm == {1}:
                return {"tier": 4, "basis": "address", "reason": f"Homestead exemption on {_where(ps[0])} (state roll {yr})"}
    people = [d for d in defendants[:3] if "," in d and not COMPANY_RE.search(d.upper()) and not NOT_BORROWER_RE.search(d.upper())]
    for person in people[:2]:
        ps = parcels_by_name(db, person)
        if not ps:
            continue
        if len(ps) > 4:
            return {"tier": 3, "basis": "name_common", "reason": f"{_person(person)}: {len(ps)} properties under that name, can't tell which"}
        hm = {p["homestead"] for p in ps}
        if hm == {0}:
            return {"tier": 2, "basis": "name", "reason": f"{_person(person)} owns {len(ps)} propert{'y' if len(ps) == 1 else 'ies'}, none with a homestead exemption ({_where(ps[0])})"}
        if hm == {1} and len(ps) == 1:
            return {"tier": 4, "basis": "name", "reason": f"{_person(person)}'s only property, {_where(ps[0])}, has a homestead exemption (state roll {yr})"}
        return {"tier": 3, "basis": "name_mixed", "reason": f"{_person(person)} owns {len(ps)} properties, homestead on some: the foreclosed one could be a rental"}
    return {"tier": 3, "basis": "not_found", "reason": "Borrower not found in the state property roll"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--load", metavar="CSV")
    ap.add_argument("--case", metavar="DEFENDANTS", help="semicolon-separated defendant names")
    ap.add_argument("--address")
    ap.add_argument("--folio")
    args = ap.parse_args()
    if args.load:
        n = load(args.load)
        print(f"loaded {n:,} parcels into {os.path.abspath(ROLL_DB)}")
    if args.case is not None:
        print(classify(open_roll(), [d.strip() for d in args.case.split(";")], args.address, args.folio))
    return 0


if __name__ == "__main__":
    sys.exit(main())
