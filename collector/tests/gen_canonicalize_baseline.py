"""
Generate the canonicalize() behavior baseline (golden file).
------------------------------------------------------------
Captures the CURRENT output of normalize.canonicalize() for every distinct raw
entity name in the database, so that later refactors can prove they did not
change entity grouping.  Run this ONCE before touching normalize.py; after that
use check_canonicalize_baseline.py, which needs no database at all.

  collector/.venv/bin/python3 collector/tests/gen_canonicalize_baseline.py

Regenerate ONLY when a canonicalize() change is intentional and reviewed — the
git diff of the .tsv is the review artifact (it lists every mapping that moved).

Deliberately excluded: the user-managed alias map (entity_aliases).  _ALIAS_MAP
is forced empty here so the baseline captures pure RULE behavior and stays
reproducible against any database — local, snapshot, or production, which each
carry a different set of user merges.  Alias application is a separate concern
and is covered by its own check.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

import normalize  # noqa: E402

BASELINE = os.path.join(HERE, 'canonicalize_baseline.tsv')


def esc(s: str) -> str:
    """One-line, tab-safe encoding. A handful of OCR'd names really do contain
    embedded newlines, and those are worth keeping in the baseline rather than
    dropping — they exercise the whitespace-collapsing path."""
    return (s.replace('\\', '\\\\')
             .replace('\t', '\\t')
             .replace('\r', '\\r')
             .replace('\n', '\\n'))


def collect_names(db_path: str) -> list[str]:
    """Every distinct raw string that canonicalize() sees in production.

    Two sources, because they do not fully overlap: assignments holds the raw
    grantor/grantee text the pipeline actually feeds in, and
    entity_classifications carries names retained from earlier collection runs.
    """
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

    names = {r[0] for r in rows}
    return sorted(names)


def main():
    db_path = os.environ.get('AMO_DB_PATH', normalize.DB)
    if not os.path.exists(db_path):
        print(f"ERROR: database not found: {db_path}")
        print("Set AMO_DB_PATH to the database you want to read names from.")
        sys.exit(1)

    # Pure-rule behavior: no user merges applied (see module docstring).
    normalize._ALIAS_MAP = {}

    print(f"Reading names from {db_path} ...")
    names = collect_names(db_path)
    print(f"{len(names):,} distinct raw names")

    with open(BASELINE, 'w', encoding='utf-8') as f:
        f.write("# canonicalize() behavior baseline — DO NOT EDIT BY HAND\n")
        f.write("# Regenerate with gen_canonicalize_baseline.py only when a change is intentional.\n")
        f.write("# Format: <raw name>\\t<canonicalize output>, backslash-escaped\n")
        for n in names:
            f.write(f"{esc(n)}\t{esc(normalize.canonicalize(n))}\n")

    distinct_out = len({normalize.canonicalize(n) for n in names})
    print(f"Wrote {BASELINE}")
    print(f"{len(names):,} inputs → {distinct_out:,} distinct canonical names")


if __name__ == '__main__':
    main()
