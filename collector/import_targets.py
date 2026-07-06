#!/usr/bin/env python3
"""
Import the Market Participants watchlist into the target_entities table.

Reads collector/targets_seed.csv (deduped firm list exported from the
"Lenders and Brokers Contacts" spreadsheet, Market Participants tab) and
inserts each firm into target_entities. Firm names are matched against the
canonical entities already present in the database (exact match first, then
with common corporate suffixes stripped) so a target like "C BRIDGE INC"
consolidates onto the canonical "C BRIDGE" and picks up its activity.

Existing targets are never overwritten; re-running is safe.

Usage:
    AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db python3 collector/import_targets.py
"""

import csv
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('AMO_DB_PATH') or os.path.join(HERE, '..', 'miami_dade_amo.db')
SEED_CSV = os.path.join(HERE, 'targets_seed.csv')

# The pipeline's canonicalizer (manual overrides, suffix rules, etc.) is the
# source of truth for entity names — use it when available so targets follow
# consolidations like BANESCO / USA BANESCO / BANESCOUSA → BANESCO USA.
sys.path.insert(0, HERE)
try:
    from normalize import canonicalize as pipeline_canonicalize
    from normalize import load_aliases as pipeline_load_aliases
except Exception:
    pipeline_canonicalize = None
    pipeline_load_aliases = None

SUFFIX = re.compile(
    r'\s+(LLC|INC|CORP|CORPORATION|LP|LLP|CO|COMPANY|NA|N A|BANK NA|FSB|SSB|NATIONAL ASSOCIATION)$'
)


def norm(s: str) -> str:
    s = unicodedata.normalize('NFKD', s)
    s = s.upper().strip()
    s = re.sub(r'[.,]', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'\s*&\s*', ' & ', s)
    return s.strip()


def strip_suffix(s: str) -> str:
    prev = None
    while prev != s:
        prev = s
        s = SUFFIX.sub('', s).strip()
    return s


def main() -> int:
    if not os.path.exists(SEED_CSV):
        print(f'Seed file not found: {SEED_CSV}', file=sys.stderr)
        return 1
    if not os.path.exists(DB_PATH):
        print(f'Database not found: {DB_PATH} (set AMO_DB_PATH)', file=sys.stderr)
        return 1

    db = sqlite3.connect(DB_PATH)
    if pipeline_load_aliases:
        pipeline_load_aliases(db)  # honor user-managed merges from the Entities page
    db.execute("""
        CREATE TABLE IF NOT EXISTS target_entities (
            entity TEXT PRIMARY KEY,
            added_at TEXT,
            notes TEXT
        )
    """)

    canon = set(
        r[0] for r in db.execute(
            "SELECT DISTINCT assignor_canon FROM aom_events_clean "
            "UNION SELECT DISTINCT assignee_canon FROM aom_events_clean"
        ) if r[0]
    )
    canon |= set(r[0] for r in db.execute("SELECT entity FROM entity_nodes") if r[0])

    canon_stripped = {}
    for c in canon:
        canon_stripped.setdefault(strip_suffix(norm(c)), c)

    def to_canonical(n: str) -> str:
        # Pipeline canonicalizer first (applies MANUAL_OVERRIDES consolidations),
        # then exact DB match, then suffix-stripped DB match.
        if pipeline_canonicalize:
            c = pipeline_canonicalize(n)
            if c in canon:
                return c
        if n in canon:
            return n
        return canon_stripped.get(strip_suffix(n), n)

    # Re-canonicalize any existing watchlist rows so they follow newly added
    # consolidation rules (e.g. BANESCO → BANESCO USA after a re-normalize).
    existing = db.execute("SELECT entity, added_at, notes FROM target_entities").fetchall()
    for entity, added_at, notes in existing:
        c = to_canonical(norm(entity))
        if c != entity:
            db.execute(
                "INSERT INTO target_entities (entity, added_at, notes) VALUES (?, ?, ?) "
                "ON CONFLICT(entity) DO NOTHING", (c, added_at, notes))
            db.execute("DELETE FROM target_entities WHERE entity = ?", (entity,))
            print(f'  Consolidated watchlist entry: {entity} -> {c}')

    # Read seed and consolidate onto canonical DB names
    final: dict[str, set] = {}
    with open(SEED_CSV, newline='') as f:
        for row in csv.DictReader(f):
            n = norm(row['entity'])
            if not n:
                continue
            name = to_canonical(n)
            final.setdefault(name, set())
            if row.get('type'):
                final[name].update(t for t in row['type'].split('/') if t)

    now = datetime.now(timezone.utc).isoformat()
    inserted = skipped = 0
    for name, types in sorted(final.items()):
        note = 'Imported from Lenders & Brokers Contacts 12.1.2025'
        if types:
            note += ' · ' + '/'.join(sorted(types))
        cur = db.execute(
            "INSERT INTO target_entities (entity, added_at, notes) VALUES (?, ?, ?) "
            "ON CONFLICT(entity) DO NOTHING",
            (name, now, note),
        )
        if cur.rowcount:
            inserted += 1
        else:
            skipped += 1

    db.commit()
    total = db.execute("SELECT COUNT(*) FROM target_entities").fetchone()[0]
    with_activity = db.execute("""
        SELECT COUNT(*) FROM target_entities t
        WHERE EXISTS (
            SELECT 1 FROM aom_events_clean c
            WHERE c.assignor_canon = t.entity OR c.assignee_canon = t.entity
        )
    """).fetchone()[0]
    print(f'Inserted: {inserted}, already present: {skipped}, table total: {total}')
    print(f'Targets with recorded activity: {with_activity}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
