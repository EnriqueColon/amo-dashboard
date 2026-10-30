#!/usr/bin/env python3
"""
Watchlist Stream 1 — newly recorded Assignments that name a target.

Each run looks at assignments rows added since the previous run (a high-water
mark on assignments.id, because the table carries no collection timestamp) and
records one watchlist_hits row for every target that appears as grantor or
grantee. The Monday email and the dashboard read watchlist_hits; nothing here
alters assignments or any derived table.

Why matching is on the raw index names and not aom_events_clean: that table
only holds LOAN_TRANSFER rows after extraction and a nightly rebuild, and
Hillsborough's generic ASG code only reaches it once the document is read. A
filing a target is party to must be flagged the day it is collected, so the
match is made on the county's own grantor/grantee text, canonicalized with the
pipeline's canonicalize() and the user-managed aliases — the same function
that produced the target names in target_entities.

First run: records the current maximum id and flags nothing, so the clock
starts at deployment and the backlog is not reported as new. Use
--since-days N to see what N days of history would have flagged (dry run only).

Usage:
    AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db python3 collector/watchlist_hits.py
    ... --dry-run                 print what would be recorded, write nothing
    ... --since-days 14 --dry-run rehearse against recent history
"""

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from normalize import canonicalize, load_aliases, non_assignment_filter  # noqa: E402

DB_PATH = os.environ.get('AMO_DB_PATH') or os.path.join(HERE, '..', 'miami_dade_amo.db')
STATE_KEY = 'last_assignment_id'


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_hits (
            cfn           TEXT NOT NULL,
            target_entity TEXT NOT NULL,
            county        TEXT,
            rec_date      TEXT,
            doc_type      TEXT,
            grantor       TEXT,
            grantee       TEXT,
            address       TEXT,
            role          TEXT,      -- 'assignor' | 'assignee' | 'both'
            is_self       INTEGER,   -- 1 when grantor and grantee canonicalize to the same name
            assignment_id INTEGER,
            first_seen_at TEXT,
            PRIMARY KEY (cfn, target_entity)
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_watchlist_hits_seen ON watchlist_hits(first_seen_at)")


def parties(raw: str | None) -> list[str]:
    """Canonical names for a grantor/grantee cell. Some rows hold several
    parties joined by ';', so each is matched on its own as well as the whole."""
    if not raw or not raw.strip():
        return []
    pieces = [raw] + [p for p in raw.split(';') if p.strip()]
    out: list[str] = []
    for p in pieces:
        c = canonicalize(p)
        if c and c != 'UNKNOWN' and c not in out:
            out.append(c)
    return out


def find_hits(rows, targets: set[str]):
    for r in rows:
        g_names, e_names = parties(r['grantor']), parties(r['grantee'])
        g_hit = [n for n in g_names if n in targets]
        e_hit = [n for n in e_names if n in targets]
        if not g_hit and not e_hit:
            continue
        is_self = int(bool(g_names) and bool(e_names) and g_names[0] == e_names[0])
        for t in dict.fromkeys(g_hit + e_hit):
            role = 'both' if (t in g_hit and t in e_hit) else ('assignor' if t in g_hit else 'assignee')
            yield r, t, role, is_self


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--since-days', type=int, default=None,
                    help='ignore the stored mark; consider rows recorded in the last N days (use with --dry-run)')
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        print(f'Database not found: {DB_PATH} (set AMO_DB_PATH)', file=sys.stderr)
        return 1
    if args.since_days is not None and not args.dry_run:
        print('--since-days rewinds the clock; it is only allowed with --dry-run', file=sys.stderr)
        return 2

    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    load_aliases(conn)

    max_id = conn.execute('SELECT COALESCE(MAX(id), 0) FROM assignments').fetchone()[0]
    stored = conn.execute('SELECT value FROM watchlist_state WHERE key = ?', (STATE_KEY,)).fetchone()

    if stored is None and args.since_days is None:
        if args.dry_run:
            print(f'First run (dry): would start the clock at assignments.id {max_id} and flag nothing.')
        else:
            conn.execute('INSERT INTO watchlist_state VALUES (?, ?)', (STATE_KEY, str(max_id)))
            conn.commit()
            print(f'First run: clock started at assignments.id {max_id}. Nothing flagged.')
        return 0

    targets = {r[0] for r in conn.execute('SELECT entity FROM target_entities')}
    if not targets:
        print('No targets on the watchlist; nothing to do.')
        return 0

    scope = non_assignment_filter('a.')
    if args.since_days is not None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=args.since_days)).strftime('%Y-%m-%d')
        where, params = 'a.rec_date >= ?', (cutoff,)
        label = f'rec_date >= {cutoff}'
    else:
        last_id = int(stored['value'])
        where, params = 'a.id > ?', (last_id,)
        label = f'id > {last_id}'

    rows = conn.execute(
        f"""SELECT a.id, a.cfn, a.rec_date, a.doc_type, a.grantor, a.grantee, a.address,
                   COALESCE(a.county, 'MIAMI-DADE') AS county
            FROM assignments a WHERE {where}{scope} ORDER BY a.id""", params).fetchall()

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    hits = list(find_hits(rows, targets))
    new = 0
    for r, target, role, is_self in hits:
        if args.dry_run:
            new += 1
            continue
        cur = conn.execute(
            """INSERT OR IGNORE INTO watchlist_hits
               (cfn, target_entity, county, rec_date, doc_type, grantor, grantee, address,
                role, is_self, assignment_id, first_seen_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r['cfn'], target, r['county'], r['rec_date'], r['doc_type'], r['grantor'],
             r['grantee'], r['address'], role, is_self, r['id'], now))
        new += cur.rowcount

    if not args.dry_run:
        conn.execute('INSERT OR REPLACE INTO watchlist_state VALUES (?, ?)', (STATE_KEY, str(max_id)))
        conn.commit()

    by_county: dict[str, int] = {}
    for r, *_ in hits:
        by_county[r['county']] = by_county.get(r['county'], 0) + 1
    print(f"{'DRY RUN ' if args.dry_run else ''}scanned {len(rows)} rows ({label}); "
          f"{len(hits)} target matches, {new} {'would be ' if args.dry_run else ''}recorded; "
          f"by county {by_county or '{}'}; mark -> {max_id}")
    if args.dry_run:
        for r, target, role, is_self in hits[:25]:
            print(f"  {r['county']:<12} {r['rec_date']} {target:<28} {role:<8}{' SELF' if is_self else '     '} "
                  f"{(r['grantor'] or '')[:34]} -> {(r['grantee'] or '')[:34]}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
