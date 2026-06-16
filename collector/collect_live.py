"""
Miami-Dade Assignment Collector — UI-intercept approach
-------------------------------------------------------
• Fills the native HTML search form (select#documentType, input#dateRangeFrom,
  input#dateRangeTo) and clicks SEARCH — React handles reCAPTCHA automatically.
• Intercepts the getStandardRecords API response with page.expect_response().
• Recursive chunk-splitting when count >= 499 (server cap).
• Resume-safe: skips (doc type, date range) pairs already in collection_log.
• Collects MULTIPLE document types (see DOC_TYPES). Documents filed under the
  generic ASSIGNMENT / ASSIGNMENT OF INTEREST types are a mixed bag (mortgage
  assignments, rents/leases, collateral, judgments...) — extract_pdfs.py reads
  the actual PDFs and classifies them; normalize.py keeps only true loan
  transfers in aom_events_clean.

Usage:
    python collect_live.py --start 2025-01-01 --end 2026-04-10
    python collect_live.py --start 2025-01-01 --end 2026-04-10 --doc-types "ASSIGNMENT - ASG"
"""

import asyncio, json, logging, sys, os
from datetime import date, timedelta, datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(__file__))
from playwright.async_api import async_playwright, Page
from database import init_db, insert_records, log_collection, already_collected

# Credentials: env vars first, then optional local config.py (not in git)
CLERK_EMAIL    = os.environ.get('CLERK_EMAIL', '')
CLERK_PASSWORD = os.environ.get('CLERK_PASSWORD', '')
if not CLERK_EMAIL or not CLERK_PASSWORD:
    try:
        from config import CLERK_EMAIL, CLERK_PASSWORD  # type: ignore
    except ImportError:
        pass

# ── Config ──────────────────────────────────────────────────────────────────
LOGIN_URL   = "https://www2.miamidadeclerk.gov/UserManagementServices/?hs=or"
BASE        = "https://onlineservices.miamidadeclerk.gov/officialrecords"

# Document types covering loan/mortgage transfers. The dedicated AMO type is
# clean by definition; ASG and AIT are generic buckets that also contain
# mortgage/note assignments — PDF classification filters out the rest.
DOC_TYPES = [
    "ASSIGNMENT OF MORTGAGE - AMO",
    "ASSIGNMENT - ASG",
    "ASSIGNMENT OF INTEREST - AIT",
]

CHUNK_DAYS  = 3          # start conservative; auto-splits if still capped
MIN_CHUNK   = 1          # minimum 1 day

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(),
              logging.FileHandler(os.path.join(os.path.dirname(__file__), "collector.log"))],
)
log = logging.getLogger("collector")


# ── Date helpers ─────────────────────────────────────────────────────────────

def iso(d: date) -> str:  return d.strftime("%Y-%m-%d")
def ymd(d: date) -> str:  return d.strftime("%Y-%m-%d")   # date input format


# ── Parse API records ────────────────────────────────────────────────────────

def parse_date(raw: str) -> Optional[str]:
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw[:10] if raw else None


def parse_models(models: list, doc_type: str) -> list[dict]:
    records = []
    for m in models:
        cfn_raw = m.get("clerk_File", "")
        cfn     = cfn_raw.replace(" ", "").upper()
        grantor = (m.get("firsT_PARTY")  or "").strip().upper() or None
        grantee = (m.get("seconD_PARTY") or "").strip().upper() or None
        records.append({
            "cfn":        cfn,
            "raw_cfn":    cfn_raw,
            "rec_date":   parse_date(m.get("reC_DATE", "")),
            "doc_type":   doc_type,
            "grantor":    grantor,
            "grantee":    grantee,
            "address":    (m.get("address") or "").strip(),
            "legal_desc": (m.get("legaL_DESCRIPTION") or "").strip(),
            "rec_book":   str(m.get("reC_BOOK") or "").strip(),
            "rec_page":   str(m.get("reC_PAGE") or "").strip(),
            "misc_ref":   (m.get("misC_REF") or "").strip(),
            "grantors":   [grantor] if grantor else [],
            "grantees":   [grantee] if grantee else [],
        })
    return records


# ── Single search ────────────────────────────────────────────────────────────

async def go_to_search(page: Page):
    """Navigate to homepage and click the Name/Document tab."""
    await page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=20000)
    await asyncio.sleep(0.8)
    await page.locator("span.cursorPointer", has_text="Name/Document").first.click()
    await page.wait_for_selector("select#documentType", state="visible", timeout=10000)
    await asyncio.sleep(0.3)


async def do_search(page: Page, doc_type: str, df: date, dt: date) -> tuple[list, str]:
    """
    Run one UI search for doc_type in [df, dt].
    Returns (records, status) where status is 'OK' | 'CAPPED' | 'ERROR'.
    """
    try:
        await go_to_search(page)

        # Fill the form
        await page.select_option("select#documentType", value=doc_type)
        await page.fill("input#dateRangeFrom", ymd(df))
        await page.fill("input#dateRangeTo",   ymd(dt))

        # Click SEARCH and intercept the getStandardRecords response
        async with page.expect_response(
            lambda r: "getStandardRecords" in r.url,
            timeout=45000
        ) as resp_info:
            await page.click("button[type='submit'].button-green")

        resp    = await resp_info.value
        data    = await resp.json()
        models  = data.get("recordingModels", [])
        count   = len(models)
        status  = "CAPPED" if count >= 499 else "OK"
        log.info(f"  [{status}] {doc_type[:24]} {iso(df)}–{iso(dt)}: {count} rows")
        return parse_models(models, doc_type), status

    except Exception as e:
        log.warning(f"  [ERR] {doc_type[:24]} {iso(df)}–{iso(dt)}: {e}")
        return [], "ERROR"


# ── Recursive range collector ─────────────────────────────────────────────────

async def collect_range(page: Page, doc_type: str, start: date, end: date,
                        chunk_days: int = CHUNK_DAYS) -> int:
    total = 0
    cur   = start

    while cur <= end:
        chunk_end = min(cur + timedelta(days=chunk_days - 1), end)

        if already_collected(iso(cur), iso(chunk_end), doc_type):
            log.info(f"  [SKIP] {doc_type[:24]} {iso(cur)}–{iso(chunk_end)}")
            cur = chunk_end + timedelta(days=1)
            continue

        records, status = await do_search(page, doc_type, cur, chunk_end)

        if status == "CAPPED" and (chunk_end - cur).days >= MIN_CHUNK:
            # Halve the chunk and retry
            new_chunk = max((chunk_end - cur).days // 2, MIN_CHUNK)
            log.info(f"  [SPLIT] {iso(cur)}–{iso(chunk_end)} → {new_chunk}-day chunks")
            total += await collect_range(page, doc_type, cur, chunk_end, new_chunk)
        else:
            inserted = insert_records(records)
            log_collection(iso(cur), iso(chunk_end), len(records), status, doc_type)
            total += inserted
            log.info(f"  [DB]   {inserted} new rows inserted")

        cur = chunk_end + timedelta(days=1)
        await asyncio.sleep(1.5)   # polite delay

    return total


# ── Login ─────────────────────────────────────────────────────────────────────

async def login(page: Page) -> bool:
    log.info("[Auth] Logging in...")
    await page.goto(LOGIN_URL, wait_until="networkidle", timeout=30000)
    await page.locator("input[name='userName']").fill(CLERK_EMAIL)
    await page.locator("input[name='password']").fill(CLERK_PASSWORD)
    await page.locator("input[name='btnCall'][value='Login']").click()
    try:
        await page.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    await asyncio.sleep(2)
    await page.goto(f"{BASE}/", wait_until="networkidle", timeout=20000)
    await asyncio.sleep(1)

    body = await page.inner_text("body")
    cookies = await page.context.cookies()
    ok = "Enrique" in body or any(c["name"] == ".PremierIDDade" for c in cookies)
    log.info("[Auth] ✅ Logged in" if ok else "[Auth] ⚠️  Could not confirm login")
    return ok


# ── Main ──────────────────────────────────────────────────────────────────────

async def run(start_iso: str, end_iso: str, doc_types: list[str]):
    init_db()
    start = date.fromisoformat(start_iso)
    end   = date.fromisoformat(end_iso)
    days  = (end - start).days + 1
    log.info(f"Collection: {start_iso} → {end_iso} ({days} days) "
             f"× {len(doc_types)} doc types")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        )
        ctx  = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = await ctx.new_page()
        await login(page)

        total = 0
        for doc_type in doc_types:
            log.info(f"── Collecting: {doc_type} ──")
            total += await collect_range(page, doc_type, start, end)
        await browser.close()

    log.info(f"✅ Collection complete — {total} new rows inserted into DB")
    return total


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--start", default="2025-01-01")
    p.add_argument("--end",   default=date.today().isoformat())
    p.add_argument("--doc-types", default=None,
                   help="comma-separated doc type values; default: all configured types")
    args = p.parse_args()
    types = ([t.strip() for t in args.doc_types.split(',')] if args.doc_types
             else DOC_TYPES)
    asyncio.run(run(args.start, args.end, types))
