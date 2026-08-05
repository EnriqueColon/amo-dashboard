"""
Print the merge proposals for a set of borrower names — the review artifact.
----------------------------------------------------------------------------
Nothing is written or changed. This exists so merges are approved as a list,
with evidence attached, before anything touches the database.

  collector/.venv/bin/python3 collector/tests/show_merge_proposals.py
  collector/.venv/bin/python3 collector/tests/show_merge_proposals.py --db   # live data

Default input is the captured City National fixture, because the local dev DB
holds only 11 facility rows and cannot exercise the OCR cases.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

import name_matching as nm  # noqa: E402

FIXTURE = os.path.join(HERE, 'fixtures', 'city_national_rows.tsv')


def from_fixture(path=FIXTURE):
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.rstrip('\n').split('\t')
            name, amount, filings = parts[0], parts[1], int(parts[2])
            out.append({'name': name, 'amounts': {amount} if amount else set(),
                        'filings': filings,
                        'period': parts[3] if len(parts) > 3 else ''})
    return out


def from_db(db_path):
    conn = sqlite3.connect(db_path)
    # Collect EVERY distinct amount per name. Selecting a bare
    # facility_amount alongside GROUP BY would let SQLite pick an arbitrary
    # row's value, making the amount evidence silently meaningless.
    rows = conn.execute("""
        SELECT facility_borrower_name,
               GROUP_CONCAT(DISTINCT facility_amount) AS amounts,
               COUNT(*) AS filings,
               MIN(facility_lender_name) AS lender
          FROM credit_facility_events
         WHERE facility_borrower_name IS NOT NULL
      GROUP BY facility_borrower_name
    """).fetchall()
    conn.close()
    return [{'name': r[0],
             'amounts': {a for a in (r[1] or '').split(',') if a},
             'filings': r[2], 'lender': r[3], 'period': ''} for r in rows]


def main():
    if '--db' in sys.argv:
        db = os.environ.get('AMO_DB_PATH', './miami_dade_amo.db')
        records, src = from_db(db), db
    else:
        records, src = from_fixture(), os.path.basename(FIXTURE)

    result = nm.propose(records)
    auto, review, amb = result['auto'], result['review'], result['ambiguous']
    sibs = result['siblings']

    absorbed = sum(len(g) - 1 for g in auto)
    print(f"Source: {src}")
    print(f"{len(records)} rows -> {len(records) - absorbed} after AUTO merges "
          f"({absorbed} absorbed)\n")

    print("=" * 72)
    print(f"AUTO — apply mechanically ({len(auto)} group(s), {absorbed} rows absorbed)")
    print("=" * 72)
    for grp in sorted(auto, key=lambda g: -sum(m['filings'] for m in g)):
        # Keep the healthiest spelling, not merely the most common one — the
        # kept name is what the dashboard displays.
        keep = max(grp, key=lambda m: (nm.health(m['stem'], m['raw_suffix']), m['filings']))
        print(f"\n  -> {keep['name']}")
        for m in sorted(grp, key=lambda m: -m['filings']):
            mark = '  (keep)' if m is keep else ''
            amt = ', '.join(sorted(m['amounts'])) or '-'
            print(f"       {amt:>24}  {m['filings']:>2}f   "
                  f"{m['name']!r}{mark}")

    print("\n" + "=" * 72)
    print(f"REVIEW — needs your decision ({len(review)})")
    print("=" * 72)
    order = {'high': 0, 'medium': 1, 'low': 2, 'conflict': 3}
    for r in sorted(review, key=lambda r: (order[r['confidence']], -r['filings'])):
        eq = ('same amount' if r['amount_agrees']
              else 'AMOUNTS CONFLICT - likely different entities'
              if r['amount_conflicts'] else 'no amount to compare')
        print(f"\n  [{r['confidence'].upper():6}] {r['name']!r}  ({r['filings']}f, "
              f"{', '.join(r['amounts']) or 'no amount'})")
        print(f"           looks like: {r['target']}")
        print(f"           evidence:   {r['distance']} character(s) different, {eq}")

    if amb:
        print("\n" + "=" * 72)
        print(f"AMBIGUOUS — deliberately not merged ({len(amb)})")
        print("=" * 72)
        for a in amb:
            print(f"  {a['member']['name']!r}: {a['reason']} "
                  f"({', '.join(a['candidates'])})")

    if sibs:
        print("\n" + "=" * 72)
        print(f"SIBLINGS — separate entities in a series, never merged ({len(sibs)})")
        print("=" * 72)
        for s in sibs:
            print(f"  {s['name']!r}  is a sibling of  {s['sibling_of']}")

    # Merges first: a family should count companies, not misspellings.
    parents = nm.propose_parents(nm.apply_auto(records, result))
    if parents:
        print("\n" + "=" * 72)
        print(f"PARENT FAMILIES — proposed, none assigned ({len(parents)})")
        print("=" * 72)
        for fam in parents:
            note = ('same lender' if fam['shared_lender']
                    else f"{len(fam['lenders'])} lenders")
            print(f"\n  [{fam['confidence'].upper():6}] {fam['parent']}  "
                  f"({len(fam['entities'])} entities, {fam['filings']} filings, {note})")
            for e in fam['entities'][:6]:
                print(f"            {e}")
            if len(fam['entities']) > 6:
                print(f"            ... and {len(fam['entities']) - 6} more")

    print(f"\nNothing was changed. {absorbed} automatic, {len(review)} awaiting review.")


if __name__ == '__main__':
    main()
