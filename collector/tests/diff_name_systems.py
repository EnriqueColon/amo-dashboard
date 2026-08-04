"""
Measure how far the two name-normalization systems have drifted apart.
----------------------------------------------------------------------
The codebase currently has two independent ways of deciding "are these two
strings the same company?":

  entity path    normalize.canonicalize()      — brand folding, strips LLC/INC/NA
  facility path  normalize.facility_name_key() — display-safe, keeps suffixes

They share no alias list and no rules.  Before merging them into one address
book we need to know, on real data, exactly where they disagree and in which
direction.  This script answers that.

  collector/.venv/bin/python3 collector/tests/diff_name_systems.py

Reads names from AMO_DB_PATH (same sources as the baseline).  Writes a full
reviewable report to name_system_disagreements.tsv; prints a summary.

Reading the two disagreement classes:

  ENTITY-MERGES  the entity path treats several names as one company, the
                 facility path keeps them apart.  These are merges the Lending
                 Relationships tab is currently MISSING — the upside case.

  FACILITY-MERGES  the facility path groups names the entity path separates.
                 Usually suffix-only differences that brand folding pulled
                 apart, or OCR fixes only the facility path knows.

Neither class is automatically right.  Suffix folding is correct for banks
("BANK OF AMERICA NA" = "BANK OF AMERICA") and wrong for single-purpose
borrowers ("222 NORTH MIAMI LLC" != "222 NORTH MIAMI INC"), which is the whole
reason the merged design needs two key levels rather than one.
"""
import os
import sqlite3
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

import normalize  # noqa: E402

REPORT = os.path.join(HERE, 'name_system_disagreements.tsv')
SHOW = 12   # clusters printed per class
MEMBERS = 4  # member names printed per cluster


def collect_names(db_path: str) -> list[str]:
    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT DISTINCT grantor FROM assignments
         WHERE grantor IS NOT NULL AND TRIM(grantor) <> ''
        UNION
        SELECT DISTINCT grantee FROM assignments
         WHERE grantee IS NOT NULL AND TRIM(grantee) <> ''
        UNION
        SELECT DISTINCT name FROM entity_classifications
         WHERE name IS NOT NULL AND TRIM(name) <> ''
    """).fetchall()
    conn.close()
    return sorted({r[0] for r in rows})


def cluster(names, keyfn):
    """key -> set of raw names that collapse onto it (blank keys dropped)."""
    out = defaultdict(set)
    for n in names:
        k = keyfn(n)
        if k and k != 'UNKNOWN':
            out[k].add(n)
    return out


def disagreements(clusters, other_keyfn):
    """Clusters this system merged that the other system would split apart.

    Returned as (key, {other_key: [names]}) sorted by how badly they split.
    """
    found = []
    for key, members in clusters.items():
        if len(members) < 2:
            continue
        split = defaultdict(list)
        for n in members:
            split[other_keyfn(n)].append(n)
        if len(split) > 1:
            found.append((key, {k: sorted(v) for k, v in split.items()}))
    found.sort(key=lambda x: (-len(x[1]), x[0]))
    return found


def report_class(f, label, note, rows):
    print(f"\n{'─' * 70}\n{label}: {len(rows):,} cluster(s)\n{note}")
    for key, split in rows[:SHOW]:
        print(f"\n  [{key}] splits into {len(split)}:")
        for other_key, names in sorted(split.items()):
            shown = ', '.join(repr(n) for n in names[:MEMBERS])
            more = f" (+{len(names) - MEMBERS} more)" if len(names) > MEMBERS else ''
            print(f"    → {other_key or '(blank)'}: {shown}{more}")
    if len(rows) > SHOW:
        print(f"\n  ... and {len(rows) - SHOW:,} more (full list in the .tsv)")

    for key, split in rows:
        for other_key, names in sorted(split.items()):
            for n in names:
                f.write(f"{label}\t{key}\t{other_key}\t{n}\n")


def main():
    db_path = os.environ.get('AMO_DB_PATH', normalize.DB)
    if not os.path.exists(db_path):
        print(f"ERROR: database not found: {db_path}")
        sys.exit(1)

    # Pure rules on both sides — user merges are DB-specific and would make the
    # comparison non-reproducible across local/snapshot/production.
    normalize._ALIAS_MAP = {}

    names = collect_names(db_path)
    print(f"Comparing both systems over {len(names):,} distinct raw names")

    ent = cluster(names, normalize.canonicalize)
    fac = cluster(names, normalize.facility_name_key)
    print(f"  entity path   → {len(ent):,} groups")
    print(f"  facility path → {len(fac):,} groups")

    ent_merges = disagreements(ent, normalize.facility_name_key)
    fac_merges = disagreements(fac, normalize.canonicalize)

    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write("# Disagreements between the two name-normalization systems\n")
        f.write("# class\tthis_system_key\tother_system_key\traw_name\n")
        report_class(
            f, 'ENTITY-MERGES',
            'Entity path groups these; facility path keeps them apart.\n'
            'Merges the Lending Relationships tab is currently missing.',
            ent_merges)
        report_class(
            f, 'FACILITY-MERGES',
            'Facility path groups these; entity path keeps them apart.',
            fac_merges)

    total = sum(len(names) for _, s in ent_merges + fac_merges for names in s.values())
    print(f"\n{'─' * 70}")
    print(f"{len(ent_merges) + len(fac_merges):,} disagreeing clusters "
          f"covering {total:,} names")
    print(f"Full reviewable list: {REPORT}")


if __name__ == '__main__':
    main()
