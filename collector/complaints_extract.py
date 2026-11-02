"""Stage 4 of the Clerk-complaints pipeline: page-numbered complaint text -> structured fields.

The model only READS: it returns what the complaint says, with the page each key figure came
from. Everything that is a judgment or arithmetic (threshold test, per-note totals, address
conflict, date normalisation) is done here in code. Rules are the nine approved on 2 Nov 2026
(docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md sections 12.4 and 17).

Usage: python complaints_extract.py read.json --model gpt-5-nano [--out result.json]
Env: OPENAI_API_KEY.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
MAX_OUTPUT_TOKENS = 12000
PRINCIPAL_THRESHOLD = 500_000  # rule 9: inclusive

SYSTEM_PROMPT = """You extract facts from a Florida circuit-court complaint (text is page-numbered, \
"=== PAGE n ===", some pages OCR'd and imperfect). Return ONE JSON object, no commentary.
Only report what the document itself says. Never use outside knowledge, never guess. If a value \
is not stated or is unreadable, use null. Money as plain numbers (no $ or commas). Dates as YYYY-MM-DD.
For every field that has a "page" companion, give the page number where you read it.

RULES (the owner approved these; follow them exactly):
1. is_mortgage_foreclosure = true only if the complaint seeks to foreclose a MORTGAGE securing a NOTE and \
both a Note and a Mortgage are attached or described. Construction-lien, association/condo-lien, \
timeshare-lien and similar suits are false. Give a one-sentence reason.
2. default_date = the earliest payment the complaint says was missed and not cured (for a balloon loan with \
no missed installment, the maturity date). NEVER a date of death, a notice date, an acceleration date or the \
filing date. List every other default date the complaint mentions in other_default_dates.
3. unpaid_principal = principal only (exclude interest, late charges, fees, costs, escrow). If the complaint \
demands different principal amounts from different defendants (borrower vs guarantor), list each in \
principal_by_defendant. If it states deferred principal separately, give it in deferred_principal.
4. right_to_reinstate_clause = true only if the MORTGAGE exhibit itself contains the uniform clause titled \
"Borrower's Right to Reinstate After Acceleration" (or equivalent wording); false if you read the mortgage \
pages and it is absent; null if the mortgage pages are missing or unreadable. Give the page. \
fannie_freddie_form = true if the loan documents carry the "Fannie Mae/Freddie Mac UNIFORM INSTRUMENT" footer. \
sba_mentioned = true if the word SBA / Small Business Administration appears in the loan documents.
5. One entry in "notes" per promissory note being foreclosed and one entry in "properties" per property \
(a single mortgage may cover several properties, possibly in different counties).
7. late_fee and default_interest are DIFFERENT: late_fee_text = a one-time charge on a late payment (e.g. "5% of \
the payment due"); default_interest_text = a higher interest rate after default (e.g. "18% per annum"). \
Do not put one in the other.
8. property address: report the "Property Address" printed in the MORTGAGE exhibit attached to the complaint \
(address_mortgage, with its page). If the Mortgage pages are unreadable use the Note exhibit's property address \
(address_note). Separately report any street address written in the complaint BODY (address_body). \
The address must be the PROPERTY being mortgaged, taken from the line labelled "Property Address" / "commonly \
known as" / "which currently has the address of" -- NOT the mortgagor's, borrower's, lender's or notice mailing \
address ("whose address is ..."). Report the Note's property address in address_note even when the Mortgage \
also gives one. Do not combine them and do not fix typos: copy each as printed. If none exists anywhere, leave all null and put \
a short reason in address_missing_reason. legal_description as printed, if present. property_county as stated or \
evident from the document.

JSON SHAPE:
{
 "is_mortgage_foreclosure": bool, "foreclosure_reason": str,
 "date_filed": "YYYY-MM-DD from the 'E-Filed' stamp or null",
 "county_court": str, "plaintiff": str, "defendants": [str],
 "attorney": {"name": str, "firm": str, "phone": str, "emails": [str]},
 "guarantors": [str],
 "notes": [ {
   "note_date": date, "original_principal": number, "original_lender": str,
   "note_rate_text": str, "note_rate_page": int, "maturity_date": date, "latest_extended_maturity": date,
   "default_date": date, "default_date_page": int, "other_default_dates": [date],
   "default_reason": str,
   "unpaid_principal": number, "unpaid_principal_page": int,
   "principal_by_defendant": [ {"defendant": str, "principal": number} ],
   "deferred_principal": number,
   "late_fee_text": str, "default_interest_text": str,
   "right_to_reinstate_clause": bool|null, "right_to_reinstate_page": int,
   "fannie_freddie_form": bool, "sba_mentioned": bool
 } ],
 "properties": [ {
   "address_mortgage": str, "address_mortgage_page": int,
   "address_note": str, "address_note_page": int,
   "address_body": str, "address_missing_reason": str,
   "legal_description": str, "property_county": str
 } ],
 "lien_priority_quote": str
}"""


def page_text(read: dict) -> str:
    out = []
    for p in read["pages"]:
        t = re.sub(r"[ \t]+", " ", p["text"])
        t = re.sub(r"\n\s*\n+", "\n", t).strip()
        out.append(f"=== PAGE {p['page']} ===\n{t}")
    return "\n".join(out)


def request_params(model: str) -> dict:
    m = model.lower()
    if m.startswith("gpt-5.4") or m.startswith("gpt-5.5"):
        return {"max_completion_tokens": MAX_OUTPUT_TOKENS, "reasoning_effort": "none", "temperature": 0}
    if m.startswith("gpt-5"):
        return {"max_completion_tokens": MAX_OUTPUT_TOKENS, "reasoning_effort": "minimal"}
    return {"max_tokens": MAX_OUTPUT_TOKENS, "temperature": 0}


def call_model(text: str, model: str, api_key: str) -> tuple[dict, dict]:
    body = {"model": model, **request_params(model), "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                         {"role": "user", "content": text}]}
    for attempt in range(4):
        r = requests.post(OPENAI_URL, json=body, timeout=900,
                          headers={"Authorization": f"Bearer {api_key}"})
        if r.status_code == 404:
            raise RuntimeError(f"model not found: {model}")
        if r.status_code in (429, 500, 502, 503):
            time.sleep(10 * (attempt + 1))
            continue
        if not r.ok:
            raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:300]}")
        j = r.json()
        return json.loads(j["choices"][0]["message"]["content"]), j.get("usage", {})
    raise RuntimeError("OpenAI kept failing")


# ---------------------------------------------------------------- code-side rules

def norm_date(v):
    if not v:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(str(v)[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return None


def num(v):
    try:
        return float(str(v).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return None


_DIR = {"NORTHWEST": "NW", "NORTHEAST": "NE", "SOUTHWEST": "SW", "SOUTHEAST": "SE",
        "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W"}
_SUFFIX = {"STREET": "ST", "AVENUE": "AVE", "COURT": "CT", "DRIVE": "DR", "ROAD": "RD", "BOULEVARD": "BLVD",
           "LANE": "LN", "PLACE": "PL", "TERRACE": "TER", "HIGHWAY": "HWY", "CIRCLE": "CIR", "WAY": "WAY"}


def normalize_address(a):
    """Comparison key only (rule 8): upper case, no commas/periods, directionals and suffixes abbreviated,
    unit markers unified, leading directional moved to a fixed place so '3038 7th St SW' == '3038 SW 7TH ST'."""
    if not a:
        return None
    s = a.upper().replace(".", "").replace(",", " ")
    s = re.sub(r"\b(APT|UNIT|STE|SUITE|NO)\b\.?\s*#?", "#", s)
    s = re.sub(r"#\s+", "#", s)
    toks = [_DIR.get(t, _SUFFIX.get(t, t)) for t in s.split()]
    toks = [re.sub(r"^(\d+)(ST|ND|RD|TH)$", r"\1", t) if re.match(r"^\d+(ST|ND|RD|TH)$", t) else t for t in toks]
    dirs = [t for t in toks if t in _DIR.values()]
    rest = [t for t in toks if t not in _DIR.values()]
    return " ".join(rest[:1] + sorted(dirs) + rest[1:])


def postprocess(raw: dict) -> dict:
    """Apply the approved rules in code. Never trusts a model-computed total or label."""
    res = dict(raw)
    res["date_filed"] = norm_date(raw.get("date_filed"))
    notes = []
    for n in raw.get("notes") or []:
        n = dict(n)
        for k in ("note_date", "maturity_date", "latest_extended_maturity", "default_date"):
            n[k] = norm_date(n.get(k))
        n["other_default_dates"] = [d for d in (norm_date(x) for x in n.get("other_default_dates") or []) if d]
        figs = [num(x.get("principal")) for x in n.get("principal_by_defendant") or []]
        figs.append(num(n.get("unpaid_principal")))
        figs = [f for f in figs if f is not None]
        n["test_principal"] = max(figs) if figs else None  # rule 3: largest principal demanded for this note
        n["meets_amount"] = None if n["test_principal"] is None else n["test_principal"] >= PRINCIPAL_THRESHOLD
        notes.append(n)
    res["notes"] = notes
    props = []
    for p in raw.get("properties") or []:
        p = dict(p)
        chosen, src = None, None
        if p.get("address_mortgage"):
            chosen, src = p["address_mortgage"], f"mortgage exhibit p.{p.get('address_mortgage_page')}"
        elif p.get("address_note"):
            chosen, src = p["address_note"], f"note exhibit p.{p.get('address_note_page')}"
        elif p.get("address_body"):
            chosen, src = p["address_body"], "complaint body"
        p["property_address"], p["address_source"] = chosen, src
        body = normalize_address(p.get("address_body"))
        p["address_conflict"] = bool(body and chosen and body != normalize_address(chosen)
                                     and src != "complaint body")
        p["address_key"] = normalize_address(chosen)
        note_key = normalize_address(p.get("address_note"))
        p["exhibit_addresses_differ"] = bool(note_key and p["address_key"] and src.startswith("mortgage")
                                             and note_key != p["address_key"])
        props.append(p)
    res["properties"] = props
    # Criteria are computed, never stored as a label: any note >= threshold AND clause absent.
    res["computed_meets_criteria"] = bool(res.get("is_mortgage_foreclosure") and any(
        n["meets_amount"] and n.get("right_to_reinstate_clause") is False for n in notes))
    return res


def extract(read: dict, model: str, api_key: str) -> dict:
    raw, usage = call_model(page_text(read), model, api_key)
    out = postprocess(raw)
    out["_model"], out["_usage"], out["_file"] = model, usage, read.get("file")
    return out


STORE_SCHEMA = """
CREATE TABLE IF NOT EXISTS foreclosure_extractions (
    case_id        TEXT NOT NULL,
    model          TEXT NOT NULL,
    extracted_at   TEXT NOT NULL,
    meets_criteria INTEGER,          -- computed in code at extraction time, not a stored judgment
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    result_json    TEXT NOT NULL,    -- full result incl. notes, properties and source pages
    PRIMARY KEY (case_id, model)
);
"""


def process_pending(conn, model: str, api_key: str, limit: int | None = None) -> dict:
    """Read + extract every downloaded complaint that has no extraction from this model yet."""
    import complaints_reader  # imported here: needs poppler/tesseract, which only the droplet job requires
    conn.executescript(STORE_SCHEMA)
    rows = conn.execute("""SELECT case_id, case_number, complaint_pdf FROM foreclosure_cases
                           WHERE complaint_status='downloaded' AND case_id NOT IN
                                 (SELECT case_id FROM foreclosure_extractions WHERE model=?)
                           ORDER BY filing_date""", (model,)).fetchall()
    rows = rows[:limit] if limit else rows
    done = failed = 0
    for r in rows:
        try:
            res = extract(complaints_reader.read_complaint(r["complaint_pdf"]), model, api_key)
            u = res.get("_usage", {})
            conn.execute("INSERT OR REPLACE INTO foreclosure_extractions VALUES (?,?,?,?,?,?,?)",
                         (r["case_id"], model, datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                          int(res["computed_meets_criteria"]), u.get("prompt_tokens"),
                          u.get("completion_tokens"), json.dumps(res)))
            conn.commit()
            done += 1
        except Exception as e:  # one bad complaint must not stop the batch
            failed += 1
            print(f"  ERROR {r['case_number']}: {e}")
    return {"extracted": done, "failed": failed}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("read_json")
    ap.add_argument("--model", default="gpt-5-nano")
    ap.add_argument("--out")
    a = ap.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("OPENAI_API_KEY is not set")
    res = extract(json.loads(Path(a.read_json).read_text()), a.model, key)
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))
    print(json.dumps({k: res[k] for k in ("_file", "_model", "_usage", "computed_meets_criteria")}))
