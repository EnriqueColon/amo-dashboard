"""
Completeness reconciliation — does the tool hold everything the county holds?
=============================================================================

The question this answers is the one a user actually asks: *on day X, does the
tool contain every assignment the clerk's own website shows on day X?* Until
now nothing asked it. Collection either threw an exception or was assumed to
have worked, and the one status that meant "we got some of it" (`CAPPED`) was
written to a log table nobody read — 23 times, over three years.

For each county this asks the SOURCE how many documents it holds per recording
day, compares that to our row count for the same day, and fails loudly on a
shortfall. Each county has a different notion of ground truth:

  MIAMI-DADE    the portal search, one query per document type per day, reusing
                collect_live's hardened login/search. The portal caps a result
                set at 500 PARTY rows (not documents) and reports neither a
                total nor a page, so a day at the cap is recorded UNKNOWN
                rather than counted — a capped day cannot be reconciled, only
                flagged. That is itself the finding.
  BROWARD       the daily feed file for that day, which is the authoritative
                export. Exact, and free of the cap problem.
  HILLSBOROUGH  the search API, which splits on its own 6,000-row cap and so
                always returns a true count.

Results land in `index_coverage`, one row per (county, day, doc type), so a gap
is a queryable record rather than a line in a log. Exit status is 1 when any
day is short, which is what lets the cron wrappers surface it.

A day where we hold MORE than the source is not a gap: Hillsborough's feed
carries corrections the search API has not re-indexed yet, and Miami-Dade's
portal omits documents that were later re-recorded. Those are reported as AHEAD
and do not fail the run.

Usage:
    python reconcile_counties.py --county MIAMI-DADE --days 10
    python reconcile_counties.py --all --days 7
    python reconcile_counties.py --county BROWARD --days 12 --quiet
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from database import get_conn  # noqa: E402

OK, SHORT, AHEAD, UNKNOWN = 'OK', 'SHORT', 'AHEAD', 'UNKNOWN'

SCHEMA = """
CREATE TABLE IF NOT EXISTS index_coverage (
    county        TEXT NOT NULL,
    rec_date      TEXT NOT NULL,
    doc_type      TEXT NOT NULL,
    source_count  INTEGER,
    our_count     INTEGER,
    status        TEXT NOT NULL,
    note          TEXT,
    checked_at    TEXT NOT NULL,
    PRIMARY KEY (county, rec_date, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_coverage_status ON index_coverage(status, rec_date);
"""


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def init_schema() -> None:
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def our_count(county: str, doc_type: str, day: date) -> int:
    """Rows we hold for that county/type/day.

    county is COALESCEd because collector builds before 2026-10-14 left the
    column NULL on freshly collected Miami-Dade rows, and a reconciliation that
    read NULL as "not Miami-Dade" would invent a gap on every recent day.
    """
    conn = get_conn()
    try:
        row = conn.execute(
            """
            SELECT COUNT(*) FROM assignments
             WHERE COALESCE(county, 'MIAMI-DADE') = ?
               AND doc_type = ? AND rec_date = ?
            """,
            (county, doc_type, day.isoformat()),
        ).fetchone()
        return row[0] if row else 0
    finally:
        conn.close()


def record(county: str, day: date, doc_type: str, source: int | None,
           ours: int, status: str, note: str | None = None) -> None:
    conn = get_conn()
    try:
        conn.execute(
            """
            INSERT INTO index_coverage
                (county, rec_date, doc_type, source_count, our_count,
                 status, note, checked_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(county, rec_date, doc_type) DO UPDATE SET
                source_count=excluded.source_count, our_count=excluded.our_count,
                status=excluded.status, note=excluded.note,
                checked_at=excluded.checked_at
            """,
            (county, day.isoformat(), doc_type, source, ours, status, note, now_utc()),
        )
        conn.commit()
    finally:
        conn.close()


def verdict(source: int, ours: int) -> str:
    if ours < source:
        return SHORT
    if ours > source:
        return AHEAD
    return OK


def window(days: int, skip_weekends: bool = True) -> list[date]:
    today = date.today()
    out = []
    for n in range(days, 0, -1):
        d = today - timedelta(days=n)
        if skip_weekends and d.weekday() >= 5:
            continue
        out.append(d)
    return out


def date_range(start: date, end: date, skip_weekends: bool = True) -> list[date]:
    out, d = [], start
    while d <= end:
        if not (skip_weekends and d.weekday() >= 5):
            out.append(d)
        d += timedelta(days=1)
    return out


def already_verified(county: str, day: date, doc_type: str) -> bool:
    """Has this county/day/type already been confirmed OK?

    Only used by the historical sweep. A multi-thousand-day Miami-Dade sweep is
    hours of portal time, so it has to survive being interrupted and resumed
    without re-asking for days that already matched. Recent-window checks never
    use this — a day that matched yesterday can be short today, because the
    county is still adding documents to it.
    """
    conn = get_conn()
    try:
        row = conn.execute(
            """
            SELECT 1 FROM index_coverage
             WHERE county=? AND rec_date=? AND doc_type=? AND status=?
            """,
            (county, day.isoformat(), doc_type, OK),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


# ── Miami-Dade ───────────────────────────────────────────────────────────────

async def reconcile_miami_dade(days_list: list[date], quiet: bool,
                               skip_verified: bool = False) -> list[tuple]:
    import collect_live as cl
    from playwright.async_api import async_playwright

    findings = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--no-sandbox'])
        page = await (await browser.new_context(
            viewport={'width': 1280, 'height': 900})).new_page()
        try:
            if not await cl.login(page):
                print('MIAMI-DADE: login failed — cannot reconcile', file=sys.stderr)
                return [('MIAMI-DADE', None, None, UNKNOWN, 'login failed')]

            for day in days_list:
                for doc_type in cl.DOC_TYPES:
                    if skip_verified and already_verified('MIAMI-DADE', day, doc_type):
                        continue
                    records, status = await cl.do_search(page, doc_type, day, day)
                    ours = our_count('MIAMI-DADE', doc_type, day)

                    if status == 'CAPPED':
                        # The portal returned its 500-row ceiling, so its own
                        # answer is incomplete. We cannot know the true count,
                        # and must not report OK just because we also hold a
                        # lot. Flagged for the day-splitting repair.
                        record('MIAMI-DADE', day, doc_type, None, ours, UNKNOWN,
                               'portal hit the 500-row cap — true count unknown')
                        findings.append(('MIAMI-DADE', day, doc_type, UNKNOWN,
                                         'portal capped at 500 rows'))
                        continue
                    if status == 'ERROR':
                        record('MIAMI-DADE', day, doc_type, None, ours, UNKNOWN,
                               'search error')
                        findings.append(('MIAMI-DADE', day, doc_type, UNKNOWN,
                                         'search error'))
                        continue

                    source = len({r['cfn'] for r in records})
                    v = verdict(source, ours)
                    record('MIAMI-DADE', day, doc_type, source, ours, v)
                    if v == SHORT:
                        findings.append(('MIAMI-DADE', day, doc_type, v,
                                         f'county {source}, ours {ours}'))
                    if not quiet:
                        print(f'  MIAMI-DADE {day} {doc_type[:30]:30} '
                              f'county={source:4} ours={ours:4} {v}')
        finally:
            await browser.close()
    return findings


# ── Broward ──────────────────────────────────────────────────────────────────

def reconcile_broward(days_list: list[date], quiet: bool,
                      skip_verified: bool = False) -> list[tuple]:
    """Reconcile Broward from the daily feed files.

    Only covers days still on the feed (~12-day retention). Older history is
    reconciled against the yearly exports by reconcile_broward_years(), which
    is both cheaper and authoritative — one file read per calendar year instead
    of one per day.
    """
    import broward_collect as bc

    findings = []
    client, sftp = bc.connect()
    try:
        available = {}
        for entry in sftp.listdir(bc.DAILY_DIR):
            m = bc.DAILY_FILE_RE.match(entry)
            if m:
                mm, dd, yyyy = m.groups()
                available[date(int(yyyy), int(mm), int(dd))] = entry

        for day in days_list:
            if skip_verified and already_verified('BROWARD', day, 'AST'):
                continue
            entry = available.get(day)
            if not entry:
                # Outside the feed's ~12-day retention. Not a gap on its own —
                # the yearly export is the authority for older days and is
                # checked by --year, not here.
                record('BROWARD', day, 'AST', None, our_count('BROWARD', 'AST', day),
                       UNKNOWN, 'no daily feed file on the server (retention)')
                continue
            text = bc.read_remote_text(sftp, f'{bc.DAILY_DIR}/{entry}')
            docs = bc.parse_doc_records(text, bc.DOC_TYPES, None, None)
            source = sum(1 for d in docs.values() if d['rec_date'] == day.isoformat())
            ours = our_count('BROWARD', 'AST', day)
            v = verdict(source, ours)
            record('BROWARD', day, 'AST', source, ours, v)
            if v == SHORT:
                findings.append(('BROWARD', day, 'AST', v,
                                 f'feed {source}, ours {ours}'))
            if not quiet:
                print(f'  BROWARD    {day} {"AST":30} feed={source:4} ours={ours:4} {v}')
    finally:
        sftp.close()
        client.close()
    return findings


def reconcile_broward_years(years: list[int], quiet: bool) -> list[tuple]:
    """Day-by-day reconciliation of whole calendar years from the yearly export.

    The yearly file IS the county's own complete record of that year, so this
    is the authoritative check and it costs one file read per year rather than
    one request per day. The current calendar year has no yearly export — the
    county publishes it after year-end — so a year still in progress can only
    be checked for the days still on the daily feed.
    """
    import broward_collect as bc

    findings = []
    client, sftp = bc.connect()
    try:
        remote = set(sftp.listdir(bc.YEARLY_DIR))
        for year in years:
            name = f'CY{year}doc-rec.txt'
            if name not in remote:
                print(f'  BROWARD CY{year}: no yearly export on the server '
                      f'(the county publishes it after year-end)')
                findings.append(('BROWARD', None, f'CY{year}', UNKNOWN,
                                 'no yearly export published yet'))
                continue

            text = bc.read_remote_text(sftp, f'{bc.YEARLY_DIR}/{name}')
            per_day: dict[str, int] = {}
            for line in text.splitlines():
                rec = bc.parse_doc_line(line) if hasattr(bc, 'parse_doc_line') else None
                if rec is None:
                    f = line.split('|')
                    if len(f) < 14 or f[4].strip() not in bc.DOC_TYPES:
                        continue
                    rd = bc.parse_date(f[1].strip(), f[2].strip())
                    if not rd:
                        continue
                elif rec['doc_type'] not in bc.DOC_TYPES:
                    continue
                else:
                    rd = rec['rec_date']
                per_day[rd] = per_day.get(rd, 0) + 1

            conn = get_conn()
            try:
                ours_by_day = dict(conn.execute(
                    """
                    SELECT rec_date, COUNT(*) FROM assignments
                     WHERE COALESCE(county,'MIAMI-DADE')='BROWARD' AND doc_type='AST'
                       AND rec_date BETWEEN ? AND ?
                     GROUP BY rec_date
                    """,
                    (f'{year}-01-01', f'{year}-12-31'),
                ))
            finally:
                conn.close()

            short_days = 0
            for rd in sorted(set(per_day) | set(ours_by_day)):
                source, ours = per_day.get(rd, 0), ours_by_day.get(rd, 0)
                v = verdict(source, ours)
                day = datetime.strptime(rd, '%Y-%m-%d').date()
                record('BROWARD', day, 'AST', source, ours, v,
                       f'CY{year} yearly export')
                if v == SHORT:
                    short_days += 1
                    findings.append(('BROWARD', day, 'AST', v,
                                     f'export {source}, ours {ours}'))
            total_src, total_ours = sum(per_day.values()), sum(ours_by_day.values())
            flag = 'OK' if total_src == total_ours else f'{total_ours - total_src:+,}'
            print(f'  BROWARD CY{year}: export={total_src:,} ours={total_ours:,} '
                  f'{flag} — {len(per_day)} recording days, {short_days} short')
    finally:
        sftp.close()
        client.close()
    return findings


# ── Hillsborough ─────────────────────────────────────────────────────────────

def reconcile_hillsborough(days_list: list[date], quiet: bool,
                           skip_verified: bool = False) -> list[tuple]:
    import hillsborough_collect as hc

    findings = []
    for day in days_list:
        for code in sorted(hc.DOC_TYPES):
            if skip_verified and already_verified('HILLSBOROUGH', day, code):
                continue
            try:
                rows = hc.fetch_window(code, day, day)
            except Exception as e:
                record('HILLSBOROUGH', day, code, None,
                       our_count('HILLSBOROUGH', code, day), UNKNOWN, str(e)[:200])
                findings.append(('HILLSBOROUGH', day, code, UNKNOWN, str(e)[:80]))
                continue
            source = len({str(r.get('Instrument')) for r in rows})
            ours = our_count('HILLSBOROUGH', code, day)
            v = verdict(source, ours)
            record('HILLSBOROUGH', day, code, source, ours, v)
            if v == SHORT:
                findings.append(('HILLSBOROUGH', day, code, v,
                                 f'api {source}, ours {ours}'))
            if not quiet:
                print(f'  HILLSBOROUGH {day} {code:28} api={source:4} ours={ours:4} {v}')
    return findings


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--county', choices=['MIAMI-DADE', 'BROWARD', 'HILLSBOROUGH'])
    ap.add_argument('--all', action='store_true', help='reconcile every county')
    ap.add_argument('--days', type=int, default=10,
                    help='how many days back to check (default 10)')
    ap.add_argument('--start', help='sweep from this date (YYYY-MM-DD) instead of --days')
    ap.add_argument('--end', help='sweep to this date (default: today)')
    ap.add_argument('--resume', action='store_true',
                    help='skip county/day/type combinations already recorded OK. '
                         'For long historical sweeps only — a recent day that '
                         'matched yesterday can be short today')
    ap.add_argument('--broward-years', action='store_true',
                    help='reconcile Broward from the yearly exports instead of the '
                         'daily feed: day-by-day for a whole year, one file read')
    ap.add_argument('--quiet', action='store_true', help='only print findings')
    args = ap.parse_args()

    if not args.county and not args.all:
        ap.error('pass --county or --all')

    if args.start:
        start = datetime.strptime(args.start, '%Y-%m-%d').date()
        end = (datetime.strptime(args.end, '%Y-%m-%d').date() if args.end
               else date.today())
        days_list = date_range(start, end)
        label = f'{start} → {end}, {len(days_list)} business days'
    else:
        days_list = window(args.days)
        label = f'last {args.days} days'

    init_schema()
    counties = (['MIAMI-DADE', 'BROWARD', 'HILLSBOROUGH'] if args.all
                else [args.county])

    findings: list[tuple] = []
    for county in counties:
        print(f'── reconciling {county} ({label}) ──', flush=True)
        try:
            if county == 'MIAMI-DADE':
                findings += asyncio.run(
                    reconcile_miami_dade(days_list, args.quiet, args.resume))
            elif county == 'BROWARD':
                if args.broward_years:
                    years = sorted({d.year for d in days_list})
                    findings += reconcile_broward_years(years, args.quiet)
                else:
                    findings += reconcile_broward(days_list, args.quiet, args.resume)
            else:
                findings += reconcile_hillsborough(days_list, args.quiet, args.resume)
        except Exception as e:
            print(f'{county}: reconciliation FAILED — {e}', file=sys.stderr)
            findings.append((county, None, None, UNKNOWN, f'reconciler failed: {e}'))

    shortfalls = [f for f in findings if f[3] == SHORT]
    unknowns = [f for f in findings if f[3] == UNKNOWN]

    print()
    if shortfalls:
        print(f'❌ {len(shortfalls)} day(s) SHORT of the county:')
        for county, day, doc_type, _, note in shortfalls:
            print(f'   {county} {day} {doc_type} — {note}')
    if unknowns:
        print(f'⚠️  {len(unknowns)} day(s) could not be verified:')
        for county, day, doc_type, _, note in unknowns[:20]:
            print(f'   {county} {day} {doc_type} — {note}')
    if not shortfalls and not unknowns:
        print('✅ every checked day matches the county')

    # Only a genuine shortfall fails the run. An unverifiable day is recorded
    # and surfaced, but it is not evidence of a miss and must not cry wolf
    # every night until the cap repair lands.
    return 1 if shortfalls else 0


if __name__ == '__main__':
    raise SystemExit(main())
