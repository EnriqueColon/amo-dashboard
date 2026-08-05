"""
Verify facility-scoped aliases never reach canonicalize().
----------------------------------------------------------
The canonicalize baseline forces _ALIAS_MAP empty, so it cannot catch a scope
leak — it tests the rules, not the loader. This does.

A facility-scoped merge must change the facility path only. If it also changes
canonicalize(), it moves aom_events_clean and every tab built on it, which is
exactly what v1 promised not to do.

  collector/.venv/bin/python3 collector/tests/check_alias_scope.py
"""
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import normalize      # noqa: E402
import entity_names   # noqa: E402

PROBE = 'ACME WAREHOUSE PARTNERS LLC'
TARGET = 'Acme Warehouse Partners, LLC'


def main():
    fd, path = tempfile.mkstemp(suffix='.db')
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE entity_aliases (
        variant TEXT PRIMARY KEY, canonical TEXT NOT NULL,
        created_at TEXT, created_by TEXT, note TEXT, scope TEXT)""")
    conn.execute("INSERT INTO entity_aliases VALUES (?,?,null,null,null,'facility')",
                 (PROBE, TARGET))
    # canonicalize() strips legal suffixes BEFORE the alias lookup, so an
    # 'all'-scoped variant must be written in its post-stripping form.
    conn.execute("INSERT INTO entity_aliases VALUES (?,?,null,null,null,'all')",
                 ('GLOBAL PROBE', 'Global Probe Company'))
    conn.commit()

    normalize._ALIAS_MAP = {}
    before = normalize.canonicalize(PROBE)
    normalize.load_aliases(conn)
    after = normalize.canonicalize(PROBE)

    entity_names.load_aliases(conn, scope='facility')
    facility_result = entity_names.display_name(PROBE)

    global_after = normalize.canonicalize('GLOBAL PROBE CO')
    conn.close()
    os.unlink(path)

    failures = 0
    if before != after:
        print(f"FAIL  facility-scoped alias leaked into canonicalize()")
        print(f"      {PROBE!r}: {before!r} -> {after!r}")
        failures += 1
    else:
        print(f"PASS  facility-scoped alias does not affect canonicalize()")

    if facility_result != TARGET:
        print(f"FAIL  facility path ignored its own alias: got {facility_result!r}")
        failures += 1
    else:
        print(f"PASS  facility path applies the facility-scoped alias")

    if global_after != 'Global Probe Company':
        print(f"FAIL  'all'-scoped alias not applied: got {global_after!r}")
        failures += 1
    else:
        print(f"PASS  'all'-scoped alias still reaches canonicalize()")

    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
