"""
Record approved merge and parent decisions into the address book.
-----------------------------------------------------------------
Writes to entity_aliases (same_as) and entity_parents (belongs_to). It never
touches raw data, and normalize.py rebuilds derived tables from these decisions
on its next run — so any approval here is reversible by deleting its row.

  # see what would be written, change nothing (default)
  AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
      collector/apply_proposals.py

  # actually write, choosing which confidence tiers to accept
  AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
      collector/apply_proposals.py --write --merges auto,high,medium \
      --families high --exclude "VASTER SUBIII"

CONFLICT-tier proposals are never applied: they are the engine reporting that
two names are probably DIFFERENT entities. Siblings are never applied either.
Both require the opposite of approval.
"""
import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import entity_names            # noqa: E402
import name_matching as nm     # noqa: E402


def load_records(conn):
    """County-recorded names are the matching authority — see name_matching."""
    return nm.load_facility_records(conn)


def ensure_tables(conn):
    entity_names.load_aliases(conn)   # creates entity_aliases + scope column
    entity_names.load_parents(conn)   # creates entity_parents


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true',
                    help='actually write; omit for a dry run')
    ap.add_argument('--merges', default='auto,high',
                    help='comma list of tiers: auto,high,medium,low')
    ap.add_argument('--families', default='high',
                    help='comma list of tiers: high,medium,low')
    ap.add_argument('--exclude', action='append', default=[],
                    help='skip any proposal whose name contains this (repeatable)')
    args = ap.parse_args()

    merge_tiers = {t.strip() for t in args.merges.split(',') if t.strip()}
    family_tiers = {t.strip() for t in args.families.split(',') if t.strip()}
    db = os.environ.get('AMO_DB_PATH', './miami_dade_amo.db')

    conn = sqlite3.connect(db)
    ensure_tables(conn)
    records = load_records(conn)
    result = nm.propose(records)
    families = nm.propose_parents(nm.apply_auto(records, result))

    def excluded(text):
        return any(x.upper() in text.upper() for x in args.exclude)

    aliases, parents, skipped = [], [], []

    # Best surviving name per stem. A review target names a STEM, and several
    # records share it (VASTER SUB II as LLC, LEC and LUC). Taking the first
    # match pointed merges at the corrupted spelling and chained them through
    # a name that is itself being merged away.
    best_by_stem = {}
    for r in records:
        stem, suffix = nm.split_suffix(nm.tokens(r['name']))
        rank = (nm.health(stem, suffix), r['filings'])
        if stem not in best_by_stem or rank > best_by_stem[stem][0]:
            best_by_stem[stem] = (rank, r['name'])

    # ── same_as, from AUTO groups ────────────────────────────────────────────
    if 'auto' in merge_tiers:
        for grp in result['auto']:
            keep = max(grp, key=lambda m: (nm.health(m['stem'], m['raw_suffix']),
                                           m['filings']))
            for m in grp:
                if m['name'] == keep['name']:
                    continue
                (skipped if excluded(m['name']) else aliases).append(
                    (m['name'], keep['name'], 'auto'))

    # ── same_as, from REVIEW decisions ───────────────────────────────────────
    for r in result['review']:
        if r['confidence'] == 'conflict':
            continue          # the engine is saying NOT the same entity
        if r['confidence'] not in merge_tiers:
            continue
        target = best_by_stem.get(r['target'], (None, r['target']))[1]
        (skipped if excluded(r['name']) else aliases).append(
            (r['name'], target, r['confidence']))

    # ── belongs_to, from family proposals ────────────────────────────────────
    for fam in families:
        if fam['confidence'] not in family_tiers:
            continue
        for m in fam['members']:
            (skipped if excluded(m['name']) else parents).append(
                (m['name'], fam['parent'], fam['confidence']))

    print(f"Database: {db}")
    print(f"\nMERGES (same_as) — {len(aliases)}")
    for variant, canonical, tier in aliases:
        print(f"  [{tier:6}] {variant!r}  ->  {canonical!r}")
    print(f"\nPARENTS (belongs_to) — {len(parents)}")
    for name, parent, tier in parents:
        print(f"  [{tier:6}] {name!r}  ->  {parent}")
    if skipped:
        print(f"\nSKIPPED by --exclude — {len(skipped)}")
        for row in skipped:
            print(f"  {row[0]!r}")

    if not args.write:
        print("\nDRY RUN — nothing written. Re-run with --write to apply.")
        return 0

    for variant, canonical, tier in aliases:
        conn.execute(
            "INSERT OR REPLACE INTO entity_aliases "
            "(variant, canonical, created_at, created_by, note, scope) "
            "VALUES (?, ?, datetime('now'), 'proposal-review', ?, 'facility')",
            (variant, canonical, f'{tier} confidence'))
    for name, parent, tier in parents:
        conn.execute(
            "INSERT OR REPLACE INTO entity_parents "
            "(entity_key, parent, created_at, created_by, note) "
            "VALUES (?, ?, datetime('now'), 'proposal-review', ?)",
            (entity_names.entity_key(name), parent, f'{tier} confidence'))
    conn.commit()
    print(f"\nWROTE {len(aliases)} merge(s) and {len(parents)} parent "
          f"assignment(s). Re-run normalize.py to rebuild derived tables.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
