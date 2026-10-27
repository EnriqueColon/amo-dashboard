"""Pull the FDIC universe, one request per quarter, raw rows stored as-is.

    .venv/bin/python3 -m bank_stress.cli pull [--quarters N] [--latest YYYYMMDD]

Host: https://api.fdic.gov/banks (banks.data.fdic.gov answers 301 to it; we
go straight to the new host). No key is needed for these endpoints.

Guarantees after a successful run:
  * every requested field is a key on every stored row (assert_fields_present),
  * the row count equals the API's own `meta.total` for that quarter,
  * `pull_log` holds one row per request, ok or not.
A failed quarter raises and exits non-zero; nothing is written for it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time

import requests

from . import db as store
from .fdic_fields import (
    FAILURE_CODES,
    FINANCIAL_CODES,
    FINANCIAL_FIELDS,
    INSTITUTION_CODES,
    MissingFieldError,
    assert_fields_present,
)

BASE_URL = "https://api.fdic.gov/banks"
PAGE_LIMIT = 10_000  # the API's maximum
TIMEOUT_S = 180
RETRIES = 3
USER_AGENT = "amo-dashboard-bank-stress/1.0 (+https://github.com/EnriqueColon/amo-dashboard)"
MIN_UNIVERSE = 1_000  # a quarter with fewer banks than this is not published yet


def _get(path: str, params: dict) -> dict:
    url = f"{BASE_URL}{path}"
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            if resp.status_code >= 500:
                raise RuntimeError(f"HTTP {resp.status_code} from {url}")
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, RuntimeError, ValueError) as exc:  # ValueError: bad JSON
            last = exc
            if attempt < RETRIES:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"FDIC request failed after {RETRIES} attempts: {last}")


def fetch_all(path: str, filters: str, fields: list[str], sort_by: str = "CERT") -> tuple[list[dict], int]:
    """Collect every row matching `filters`, paging by offset. Returns (rows, meta.total)."""
    rows: list[dict] = []
    offset = 0
    total: int | None = None
    while True:
        payload = _get(path, {
            "filters": filters,
            "fields": ",".join(fields),
            "limit": PAGE_LIMIT,
            "offset": offset,
            "sort_by": sort_by,
            "sort_order": "ASC",
            "format": "json",
        })
        meta_total = int(payload.get("meta", {}).get("total", 0))
        total = meta_total if total is None else total
        page = [item["data"] for item in payload.get("data", [])]
        rows.extend(page)
        if not page or len(rows) >= total:
            break
        offset += len(page)
    if total is None:
        total = 0
    if len(rows) != total:
        raise RuntimeError(f"{path} {filters}: collected {len(rows)} rows but the API reports total={total}")
    return rows, total


# ── quarter arithmetic ───────────────────────────────────────────────────────

def quarter_end(year: int, q: int) -> str:
    month = {1: 3, 2: 6, 3: 9, 4: 12}[q]
    day = {3: 31, 6: 30, 9: 30, 12: 31}[month]
    return f"{year}{month:02d}{day:02d}"


def previous_quarter(repdte: str) -> str:
    y, m = int(repdte[:4]), int(repdte[4:6])
    q = (m - 1) // 3 + 1
    return quarter_end(y - 1, 4) if q == 1 else quarter_end(y, q - 1)


def quarter_list(latest: str, n: int) -> list[str]:
    """`n` consecutive quarter-ends ending at `latest`, newest first."""
    out = [latest]
    while len(out) < n:
        out.append(previous_quarter(out[-1]))
    return out


def discover_latest_quarter(today: dt.date | None = None) -> str:
    """Newest REPDTE for which the FDIC has published the universe.

    Walks back from the most recent calendar quarter-end until a quarter holds
    at least MIN_UNIVERSE banks. The FDIC publishes roughly 60 days after the
    quarter closes, so this is normally one or two probes.
    """
    today = today or dt.date.today()
    y, q = today.year, (today.month - 1) // 3 + 1
    candidate = quarter_end(y - 1, 4) if q == 1 else quarter_end(y, q - 1)
    for _ in range(8):
        payload = _get("/financials", {"filters": f"REPDTE:{candidate}", "fields": "CERT", "limit": 1, "format": "json"})
        if int(payload.get("meta", {}).get("total", 0)) >= MIN_UNIVERSE:
            return candidate
        candidate = previous_quarter(candidate)
    raise RuntimeError("could not find a published FDIC quarter in the last eight")


# ── storage ──────────────────────────────────────────────────────────────────

def _log(conn, endpoint: str, repdte: str | None, rows: int | None, total: int | None, ok: bool, detail: str, started: float) -> None:
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO pull_log (endpoint, repdte, rows, expected_total, ok, detail, started_at, finished_at, seconds) VALUES (?,?,?,?,?,?,?,?,?)",
        (endpoint, repdte, rows, total, 1 if ok else 0, detail,
         dt.datetime.fromtimestamp(started, dt.timezone.utc).isoformat(timespec="seconds"), now, round(time.time() - started, 2)),
    )
    conn.commit()


def _coerce(value, sql_type: str):
    if value is None or value == "":
        return None
    if sql_type == "INTEGER":
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if sql_type == "REAL":
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    return str(value)


def store_financials(conn, repdte: str, rows: list[dict], fetched_at: str) -> None:
    cols = [code for code, *_ in FINANCIAL_FIELDS]
    types = {code: sql_type for code, _b, sql_type, _t in FINANCIAL_FIELDS}
    placeholders = ",".join("?" for _ in cols) + ",?"
    sql = f"INSERT OR REPLACE INTO fdic_financials_raw ({','.join(cols)}, fetched_at) VALUES ({placeholders})"
    conn.executemany(sql, ([_coerce(r.get(c), types[c]) for c in cols] + [fetched_at] for r in rows))
    conn.commit()


def pull_quarter(conn, repdte: str) -> int:
    started = time.time()
    try:
        rows, total = fetch_all("/financials", f"REPDTE:{repdte}", FINANCIAL_CODES)
        assert_fields_present(rows, FINANCIAL_CODES, f"financials {repdte}")
        fetched_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        store_financials(conn, repdte, rows, fetched_at)
        _log(conn, "financials", repdte, len(rows), total, True, "ok", started)
        return len(rows)
    except (MissingFieldError, RuntimeError) as exc:
        _log(conn, "financials", repdte, None, None, False, str(exc), started)
        raise


def pull_institutions(conn) -> int:
    from .fdic_fields import INSTITUTION_FIELDS
    started = time.time()
    try:
        rows, total = fetch_all("/institutions", "ACTIVE:1", INSTITUTION_CODES)
        # Descriptors may be absent (not null — absent) on a bank that has not
        # filed yet; the identifiers must be on every row.
        absent = assert_fields_present(rows, INSTITUTION_CODES, "institutions",
                                       optional=("ASSET", "REPDTE", "RSSDHCR", "NAMEHCR", "ESTYMD", "CITY", "BKCLASS"))
        detail = "ok" if not absent else "ok; absent on some rows: " + ", ".join(f"{k}×{v}" for k, v in sorted(absent.items()))
        fetched_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        cols = [c for c, *_ in INSTITUTION_FIELDS]
        types = {c: t for c, _b, t, _ in INSTITUTION_FIELDS}
        conn.executemany(
            f"INSERT OR REPLACE INTO fdic_institutions ({','.join(cols)}, fetched_at) VALUES ({','.join('?' for _ in cols)},?)",
            ([_coerce(r.get(c), types[c]) for c in cols] + [fetched_at] for r in rows),
        )
        conn.commit()
        _log(conn, "institutions", None, len(rows), total, True, detail, started)
        if absent:
            print(f"[pull] institutions: {detail}")
        return len(rows)
    except (MissingFieldError, RuntimeError) as exc:
        _log(conn, "institutions", None, None, None, False, str(exc), started)
        raise


def pull_failures(conn, since_year: int) -> int:
    from .fdic_fields import FAILURE_FIELDS
    started = time.time()
    try:
        rows, total = fetch_all("/failures", f"FAILYR:[{since_year} TO 2099]", FAILURE_CODES, sort_by="FAILDATE")
        if rows:
            assert_fields_present(rows, FAILURE_CODES, "failures")
        fetched_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        cols = [c for c, *_ in FAILURE_FIELDS]
        types = {c: t for c, _b, t, _ in FAILURE_FIELDS}
        conn.executemany(
            f"INSERT OR REPLACE INTO fdic_failures ({','.join(cols)}, fetched_at) VALUES ({','.join('?' for _ in cols)},?)",
            ([_coerce(r.get(c), types[c]) for c in cols] + [fetched_at] for r in rows),
        )
        conn.commit()
        _log(conn, "failures", None, len(rows), total, True, "ok", started)
        return len(rows)
    except (MissingFieldError, RuntimeError) as exc:
        _log(conn, "failures", None, None, None, False, str(exc), started)
        raise


def run(quarters: int | None = None, latest: str | None = None, skip_institutions: bool = False,
        skip_financials: bool = False) -> list[str]:
    cfg = store.load_config()
    n = quarters or int(cfg["raw_quarters"])
    conn = store.connect()
    print(f"[pull] database {store.db_path()}")
    latest = latest or discover_latest_quarter()
    wanted = quarter_list(latest, n)
    if skip_financials:
        print(f"[pull] latest published quarter {latest}; financials skipped on request")
    else:
        print(f"[pull] latest published quarter {latest}; pulling {n} quarters {wanted[-1]} → {wanted[0]}")
        for repdte in wanted:
            t0 = time.time()
            count = pull_quarter(conn, repdte)
            print(f"[pull] {repdte}: {count:,} banks in {time.time() - t0:.1f}s")
    if not skip_institutions:
        print(f"[pull] institutions (active): {pull_institutions(conn):,}")
    first_year = int(wanted[-1][:4]) - 1
    print(f"[pull] failures since {first_year}: {pull_failures(conn, first_year):,}")
    conn.close()
    return wanted


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quarters", type=int, help="how many quarters back (default: config raw_quarters)")
    ap.add_argument("--latest", help="force the newest REPDTE, e.g. 20260630 (default: discovered)")
    ap.add_argument("--skip-institutions", action="store_true")
    ap.add_argument("--skip-financials", action="store_true", help="only refresh institutions and failures")
    args = ap.parse_args(argv)
    try:
        run(args.quarters, args.latest, args.skip_institutions, args.skip_financials)
    except (MissingFieldError, RuntimeError) as exc:
        print(f"[pull] FAILED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
