"""
Regression checks for two defects found in the 3 Nov 2026 audit of the first week of complaints
(independent reading of all 24 PDFs against the tool's output):

  1. Case 2026-022247-CA-01: the exhibit said 17466 NW 91 Ct. Four page-image reads of a blotchy digit (two pages,
     each read again at 300 dpi) said 17465 and outvoted the three text readings, because OCR wrote "NW.91" as one
     of them and the street key split that vote. Fixed: directional+number spacing is normalised, and a 300-dpi
     re-read of the same page counts as the same witness, not a second one.
  2. Case 2026-021952-CA-01 (Helm Bank, $1.68M): a rider deleted the reinstatement section; the extractor read the
     uniform clause and said "present". Fixed in the prompt; the prompt text is asserted here so it cannot be lost.

Run: python3 collector/tests/check_complaints_address_vote.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import complaints_address as ca
import complaints_extract as ce

fails = []


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# 1. spacing variants of one address share a street key; a different house number does not
check("NW.91 / NW91 / NW 91 collapse to one key",
      len({ce.street_key(a) for a in ("17466 NW.91 CT, Miami, Florida 33018", "17466 NW91 CT, Miami",
                                       "17466 NW 91 Ct, Miami, Florida 33018")}) == 1)
check("17465 and 17466 stay different", ce.street_key("17465 NW 91 CT") != ce.street_key("17466 NW 91 CT"))
check("ZIP-only difference is still one key", ce.street_key("485 Brickell Ave Apt 2808, Miami 33131") ==
      ce.street_key("485 BRICKELL AVE #2808, Miami FL 33134"))

# 2. the exact vote from the failed case: 2 image reads (+2 hi-res re-reads) vs 3 independent text reads
ca.read_address_image = lambda png, model, key: {"address": "17465 NW 91 CT, Miami, Florida 33018"}
ca.render_page = lambda pdf, page, dpi=200: b""
prop = {"address_mortgage_page": 16, "address_note_page": 10, "address_conflict": True,
        "address_mortgage": "17466 NW.91 CT, Miami, Florida 33018", "address_note": "17466 NW 91 CT, Miami, FL 33013",
        "address_body": "17466 NW 91 Ct, Miami, Florida 33018"}
out = ca.repair_property("x.pdf", prop, "m", "k")
check("three independent text readings beat two image reads", "17466" in (out.get("property_address") or ""))

# 3. the rider rule stays in the prompt
check("prompt tells the model riders can delete the reinstatement clause",
      "RIDERS COUNT" in ce.SYSTEM_PROMPT and "Section 19 is deleted" in ce.SYSTEM_PROMPT)

print("\n%s" % ("ALL OK" if not fails else "%d FAILED" % len(fails)))
sys.exit(1 if fails else 0)
