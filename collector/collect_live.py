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

import asyncio, json, logging, sys, os, time
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
#
# AIT has returned zero rows since it was added (2026-06-16): the clerk answers
# every AIT search with isValidSearch:false, the same answer it gives for a day
# with no filings at all. It is kept here deliberately, at the owner's decision,
# so that we start collecting automatically if the county ever activates the
# type — an AIT search now costs ~1s instead of the 45s it used to hang for.
# See do_search() and SESSION_LOG.md.
#
# FST is NOT an assignment. It is collected for the lending relationships it
# exposes (secured party ↔ debtor, present on 99% of filings) and is excluded
# from aom_events_clean and from entity-type classification by
# normalize.NON_ASSIGNMENT_DOC_TYPES — collecting it must not move the
# assignment numbers the dashboard already reports.
DOC_TYPES = [
    "ASSIGNMENT OF MORTGAGE - AMO",
    "ASSIGNMENT - ASG",
    "ASSIGNMENT OF INTEREST - AIT",
    "FINANCING STATEMENT UCC - FST",
]

CHUNK_DAYS  = 3          # start conservative; auto-splits if still capped

# --force: collect every window in range even if collection_log says OK.
#
# A window logged OK is not finished — the county keeps adding documents to a
# recording date afterwards. database.RECHECK_DAYS covers that for recent
# windows; this is for a TARGETED re-collection of an old day that a
# reconciliation found short. Without it the 16 Oct 2026 re-collection of
# eight such days silently skipped three of them (their 1-day windows had been
# logged OK months earlier), and the forced re-run of one returned 212 rows
# where the original had seen 207.
FORCE = False
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


async def do_search(page: Page, doc_type: str, df: date, dt: date,
                    name_prefix: str | None = None) -> tuple[list, str]:
    """
    Run one UI search for doc_type in [df, dt].
    Returns (records, status) where status is 'OK' | 'CAPPED' | 'EMPTY' | 'ERROR'.

    `name_prefix` narrows the search to records whose FIRST-named party starts
    with it (verified 15 Oct 2026: company mode's one field matches as a prefix
    of the first party, people included, and 'B' on a capped day returned 15
    rows, all first-party B, all inside the unfiltered result). That is what
    lets collect_day_partitioned() get past the 500-row cap on a single day.

    The portal searches in TWO steps, and knowing that is the whole point of
    this function's shape:

        POST /api/home/standardsearch   -> {"isValidSearch": true, "qs": "<token>"}
        GET  /api/SearchResults/getStandardRecords?qs=<token>  -> the rows

    When step one answers `isValidSearch:false` the browser never issues step
    two. Waiting on getStandardRecords therefore waits forever. That is exactly
    what happened to every AIT search from 2026-06-16 onward: 45s of nothing,
    logged as a timeout ERROR, blamed on the network for months. The same
    `isValidSearch:false` comes back for a date range the county never recorded
    anything in (a holiday, a closure), so it means "no results", NOT "broken".

    Both responses are therefore watched from the moment of the click, and a
    rejected search returns EMPTY in about a second.
    """
    state: dict = {"valid": None, "records": None}

    async def capture(resp):
        try:
            if "home/standardsearch" in resp.url:
                state["valid"] = bool((await resp.json()).get("isValidSearch"))
            elif "getStandardRecords" in resp.url:
                state["records"] = await resp.json()
        except Exception:
            pass  # a body we cannot read must not kill the search

    handler = lambda r: asyncio.create_task(capture(r))

    try:
        await go_to_search(page)

        # Fill the form
        await page.select_option("select#documentType", value=doc_type)
        await page.fill("input#dateRangeFrom", ymd(df))
        await page.fill("input#dateRangeTo",   ymd(dt))
        if name_prefix:
            await page.click("#companySearchRadio")
            await page.fill("input#companyName", name_prefix)

        page.on("response", handler)
        await page.click("button[type='submit'].button-green")

        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if state["records"] is not None:
                break
            if state["valid"] is False:
                log.info(f"  [EMPTY] {doc_type[:24]} {iso(df)}–{iso(dt)}: "
                         f"portal reports no records for this window")
                return [], "EMPTY"
            await asyncio.sleep(0.25)

        if state["records"] is None:
            raise TimeoutError("no getStandardRecords response within 45s")

        models  = state["records"].get("recordingModels", [])
        count   = len(models)
        status  = "CAPPED" if count >= 499 else "OK"
        tag     = f" [{name_prefix}…]" if name_prefix else ""
        log.info(f"  [{status}] {doc_type[:24]} {iso(df)}–{iso(dt)}{tag}: {count} rows")
        return parse_models(models, doc_type), status

    except Exception as e:
        log.warning(f"  [ERR] {doc_type[:24]} {iso(df)}–{iso(dt)}: {e}")
        return [], "ERROR"
    finally:
        try:
            page.remove_listener("response", handler)
        except Exception:
            pass


# ── One day past the cap: partition by first-party name prefix ───────────────
#
# The portal returns at most 500 index rows (one per party, not per document),
# reports no total and no page, and the collector cannot split a date range
# below one day. So a busy day was stored truncated and logged CAPPED — 23 days
# between 11 Jan 2023 and 3 Feb 2026, plus three more that only a fresh-session
# re-check exposed. Nothing read that log.
#
# Every row has a first-named party, and the portal's name field is a prefix
# filter on exactly that party. So the union over A–Z, 0–9 (and the few
# punctuation marks a clerk's index puts first) covers every document of the
# day, and any one partition that is itself over the cap recurses a letter
# deeper, to three. A single first-party name with 500+ rows on one day is
# not realistic (that would be 500 documents naming it first); a two-letter
# bucket over the cap on a very busy day is. Documents are deduplicated by CFN
# as they are gathered.

PARTITION_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
PARTITION_PUNCT = "&'(-./#$@\""
MAX_PREFIX_LEN  = 3


async def collect_day_partitioned(page: Page, doc_type: str, day: date,
                                  prefix: str = "") -> tuple[list, int]:
    """Every record of `doc_type` on `day`, gathered by first-party prefix.

    Returns (records, unresolved): records deduplicated by CFN, and the count of
    partitions that were still over the cap at MAX_PREFIX_LEN or errored — a
    day with any unresolved partition is logged CAPPED, not OK, so it stays
    visible and retry-eligible rather than passing as complete.
    """
    by_cfn: dict[str, dict] = {}
    unresolved = 0
    chars = PARTITION_CHARS + (PARTITION_PUNCT if not prefix else "")
    for ch in chars:
        p = prefix + ch
        records, status = await do_search(page, doc_type, day, day, name_prefix=p)
        if status == "CAPPED" and len(p) < MAX_PREFIX_LEN:
            sub, sub_unresolved = await collect_day_partitioned(page, doc_type, day, p)
            for r in sub:
                by_cfn.setdefault(r["cfn"], r)
            unresolved += sub_unresolved
        elif status == "CAPPED":
            unresolved += 1
            log.warning(f"  [CAP] {doc_type[:24]} {iso(day)} prefix {p!r} is still over "
                        f"the cap at {MAX_PREFIX_LEN} characters — kept what it returned")
            for r in records:
                by_cfn.setdefault(r["cfn"], r)
        elif status == "ERROR":
            unresolved += 1
        else:
            for r in records:
                by_cfn.setdefault(r["cfn"], r)
        await asyncio.sleep(0.5)
    return list(by_cfn.values()), unresolved


# ── Recursive range collector ─────────────────────────────────────────────────

async def collect_range(page: Page, doc_type: str, start: date, end: date,
                        chunk_days: int = CHUNK_DAYS) -> int:
    total = 0
    cur   = start

    while cur <= end:
        chunk_end = min(cur + timedelta(days=chunk_days - 1), end)

        if not FORCE and already_collected(iso(cur), iso(chunk_end), doc_type):
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
            if status == "CAPPED":
                # A single day over the cap: the date axis is exhausted, so
                # partition by first-party name instead of storing a truncated
                # day and moving on.
                log.info(f"  [PARTITION] {doc_type[:24]} {iso(cur)}: one day over the "
                         f"500-row cap — collecting by first-party name prefix")
                records, unresolved = await collect_day_partitioned(page, doc_type, cur)
                status = "CAPPED" if unresolved else "OK"
                log.info(f"  [PARTITION] {doc_type[:24]} {iso(cur)}: {len(records)} documents"
                         + (f", {unresolved} partition(s) unresolved — logged CAPPED"
                            if unresolved else ", complete"))
            # EMPTY is logged but deliberately NOT treated as collected:
            # already_collected() only skips status='OK', so a window the portal
            # currently reports as empty stays eligible for a later run. That is
            # the point — if the county ever starts filing AIT, the next run
            # picks it up instead of skipping a window we once saw empty. The
            # retry is cheap now that an empty search returns in ~1s.
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
    # The Login control was an <input name="btnCall" value="Login"> until
    # 16 Oct 2026 and is a <button name="btnCall"> since. Match on the name
    # alone so the next markup change of this kind is not an outage, and say
    # so plainly if even that stops matching — a raw 30s Playwright timeout on
    # a locator told nobody what had happened.
    submit = page.locator("[name='btnCall']")
    if await submit.count() == 0:
        raise RuntimeError(
            "clerk login page has no [name='btnCall'] control — the portal's "
            "login markup changed again; inspect it and update login()")
    await submit.first.click()
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
    p.add_argument("--force", action="store_true",
                   help="collect every window in range even if collection_log says OK — "
                        "for a targeted re-collection of a day found short")
    args = p.parse_args()
    FORCE = args.force
    types = ([t.strip() for t in args.doc_types.split(',')] if args.doc_types
             else DOC_TYPES)
    asyncio.run(run(args.start, args.end, types))
