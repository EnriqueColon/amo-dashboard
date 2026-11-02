"""Address repair for the Clerk-complaints pipeline (follow-up to Stage 5, doc section 19).

The Mortgage and Note exhibits are scans read by OCR, which misreads street names, numbers and
ZIPs ("Floxida City", "SW 236" for SW 296). When the two exhibit readings disagree, or the
complaint body disagrees with them, this module shows the model the actual page image of the
cited Mortgage page and Note page and asks it to copy the property address it can SEE. It then
decides in code: agreement between independent readings wins; anything else stays flagged.
It never fills an address from outside data (approved rule, doc section 12.4).
"""
import base64
import json
import subprocess
import tempfile
from pathlib import Path

import requests

from complaints_extract import OPENAI_URL, classify_flags, normalize_address, request_params, street_key as _street_key

IMAGE_PROMPT = """This is one page of a scanned mortgage or promissory note. Find the PROPERTY address: the \
line labelled "Property Address", "commonly known as", "which currently has the address of" or similar -- \
NOT the mortgagor's, borrower's or lender's mailing/notice address. Copy it EXACTLY as printed, character by \
character, including unit/apartment and ZIP. Do not correct spelling and do not guess unreadable characters \
(write ? for them). Return JSON: {"address": string or null, "unit": string or null, "legible": true/false}. \
If this page has no property address, return {"address": null, "unit": null, "legible": true}."""


USAGE = {"in": 0, "out": 0}  # tokens spent on page-image reads since the caller last reset it


def render_page(pdf_path: str, page: int, dpi: int = 200) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "p"
        subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-png",
                        pdf_path, str(stem)], check=True, capture_output=True)
        return next(Path(tmp).glob("p*.png")).read_bytes()


def read_address_image(png: bytes, model: str, api_key: str) -> dict:
    b64 = base64.b64encode(png).decode()
    body = {"model": model, **request_params(model), "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": IMAGE_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"}}]}]}
    r = requests.post(OPENAI_URL, json=body, timeout=300, headers={"Authorization": f"Bearer {api_key}"})
    if not r.ok:
        raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:200]}")
    j = r.json()
    USAGE["in"] += j.get("usage", {}).get("prompt_tokens", 0)
    USAGE["out"] += j.get("usage", {}).get("completion_tokens", 0)
    return json.loads(j["choices"][0]["message"]["content"])


def needs_repair(prop: dict) -> bool:
    return bool(prop.get("address_conflict") or prop.get("exhibit_addresses_differ"))


def _key(addr):
    return normalize_address(addr) if addr else None


street_key = _street_key


def repair_property(pdf_path: str, prop: dict, model: str, api_key: str) -> dict:
    """Show the model the cited Mortgage and Note pages, then let all readings of the street line vote
    (image readings of both pages, OCR readings of both, the complaint body). A street line wins only with
    at least two votes and strictly more than any other; otherwise the property stays flagged."""
    prop = dict(prop)
    reads = {}
    for src, page_key in (("mortgage", "address_mortgage_page"), ("note", "address_note_page")):
        page = prop.get(page_key)
        if isinstance(page, int) and page > 0:
            try:
                reads[src] = read_address_image(render_page(pdf_path, page), model, api_key).get("address")
            except Exception as e:  # keep going; the property just stays flagged
                reads[src] = None
                prop.setdefault("address_repair_errors", []).append(f"{src}: {e}"[:150])
    prop["address_image_reads"] = reads
    # priority order = which full reading is reported when the street line is settled
    readings = [("image mortgage", reads.get("mortgage")), ("image note", reads.get("note")),
                ("ocr mortgage", prop.get("address_mortgage")), ("ocr note", prop.get("address_note")),
                ("body", prop.get("address_body"))]
    readings = [(n, a) for n, a in readings if a and "?" not in a and street_key(a)]
    votes = {}
    for n, a in readings:
        votes.setdefault(street_key(a), []).append(n)
    ranked = sorted(votes.items(), key=lambda kv: -len(kv[1]))
    settled = lambda r: bool(r) and len(r[0][1]) >= 2 and (len(r) == 1 or len(r[0][1]) > len(r[1][1]))
    if not settled(ranked):
        # No clear winner: read both pages again at higher resolution and let those readings vote too.
        for src, page_key in (("mortgage", "address_mortgage_page"), ("note", "address_note_page")):
            page = prop.get(page_key)
            if isinstance(page, int) and page > 0:
                try:
                    a = read_address_image(render_page(pdf_path, page, dpi=300), model, api_key).get("address")
                except Exception as e:
                    prop.setdefault("address_repair_errors", []).append(f"{src} hi-res: {e}"[:150])
                    continue
                if a and "?" not in a and street_key(a):
                    readings.insert(0, (f"image {src} 300dpi", a))
                    votes.setdefault(street_key(a), []).append(f"image {src} 300dpi")
        ranked = sorted(votes.items(), key=lambda kv: -len(kv[1]))
    prop["address_votes"] = {k: v for k, v in ranked}
    if settled(ranked):
        win = ranked[0][0]
        chosen = next(a for n, a in readings if street_key(a) == win)
        prop["property_address"], prop["address_key"] = chosen, _key(chosen)
        prop["address_source"] = "image-checked: " + ", ".join(ranked[0][1])
        prop["address_repair_status"] = "repaired_by_vote"
    elif ranked:
        prop["address_repair_status"] = "readings_disagree_needs_review"
    else:
        prop["address_repair_status"] = "unreadable_needs_review"
    return prop


def repair_result(pdf_path: str, result: dict, model: str, api_key: str) -> dict:
    out = dict(result)
    out["properties"] = [repair_property(pdf_path, p, model, api_key) if needs_repair(p) else p
                         for p in result.get("properties") or []]
    for p in out["properties"]:
        if p.get("address_repair_status") == "repaired_by_vote":
            p["address_conflict"] = bool(p.get("address_body") and
                                         street_key(p["address_body"]) != street_key(p["property_address"]))
            p["exhibit_addresses_differ"] = False
    return classify_flags(out)
