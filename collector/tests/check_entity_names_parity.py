"""
Prove entity_names.py is a drop-in replacement for the facility name logic.
---------------------------------------------------------------------------
The shared address book only earns its place if swapping it in changes nothing
except alias resolution.  This replays every name in the database through both
the old functions and the new module and demands they agree.

  AMO_DB_PATH=./miami_dade_amo.db \\
    collector/.venv/bin/python3 collector/tests/check_entity_names_parity.py

Two checks, because the old logic has a hardcoded alias table baked into it:

  1. PURE RULES   normalize._FAC_ALIASES emptied, no aliases loaded.
                  entity_key() must equal facility_name_key() and
                  display_name() must equal clean_facility_name(), everywhere.

  2. MIGRATION    the two hardcoded aliases loaded into the new module instead.
                  Output must match the old logic running with them built in —
                  proving the move from code to database preserves behavior.

Exit 0 = safe to wire in. Exit 1 = the replacement is not equivalent; the report
names the inputs that diverged.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

import re               # noqa: E402
import normalize        # noqa: E402
import entity_names     # noqa: E402

SHOW = 15

# ── Frozen reference implementation ───────────────────────────────────────────
# Verbatim copy of normalize.clean_facility_name / facility_name_key as they
# stood at tag pre-entity-normalization, BEFORE they were repointed at
# entity_names.  Frozen here on purpose: once normalize.py delegates to the
# shared module, comparing against its live functions would compare the module
# to itself and pass trivially.  Do not "simplify" this by importing normalize —
# that silently voids the guarantee.

_LEGACY_ROLE_PREFIX_RE = re.compile(
    r'^\s*(?:ASSIGNEE|ASSIGNOR|LENDER|BORROWER)\s*[:\(]\s*', re.IGNORECASE)
_LEGACY_ROLE_ONLY = {'LENDER', 'BORROWER', 'ASSIGNEE', 'ASSIGNOR', 'AGENT',
                     'TRUSTEE', 'BANK'}
LEGACY_FAC_ALIASES = {
    'GIDY NATIONAL BANK OF FLORIDA': 'City National Bank of Florida',
    'BGI FINANCIAL LEC': 'BGI Financial, LLC',
}


def _legacy_alias_key(s: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', '', s.upper())).strip()


def legacy_clean_facility_name(name, aliases=None):
    if name is None or not str(name).strip():
        return None
    s = re.sub(r'\s+', ' ', str(name)).strip()
    s = _LEGACY_ROLE_PREFIX_RE.sub('', s)
    if s.endswith(')') and s.count(')') > s.count('('):
        s = s[:-1].rstrip()
    s = re.sub(r'(\w)\s*-\s*(\w)', r'\1 \2', s)
    s = re.sub(r'\bIIL\b', 'III', s)
    s = re.sub(r'\s+', ' ', s).strip(' ,')
    if not s or s.upper() in _LEGACY_ROLE_ONLY:
        return None
    return (aliases or {}).get(_legacy_alias_key(s), s)


def legacy_facility_name_key(name, aliases=None):
    cleaned = legacy_clean_facility_name(name, aliases)
    return _legacy_alias_key(cleaned) if cleaned else ''


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
        UNION
        SELECT DISTINCT facility_lender_name FROM credit_facility_events
         WHERE facility_lender_name IS NOT NULL
        UNION
        SELECT DISTINCT facility_borrower_name FROM credit_facility_events
         WHERE facility_borrower_name IS NOT NULL
    """).fetchall()
    conn.close()
    return sorted({r[0] for r in rows})


def compare(names, label, old_fn, new_fn):
    """Report inputs where the two implementations disagree."""
    bad = [(n, o, x) for n in names
           if (o := old_fn(n)) != (x := new_fn(n))]
    if not bad:
        print(f"  PASS  {label}: identical across {len(names):,} names")
        return 0
    print(f"  FAIL  {label}: {len(bad):,} disagreement(s)")
    for n, o, x in bad[:SHOW]:
        print(f"        {n!r}\n          old: {o!r}\n          new: {x!r}")
    if len(bad) > SHOW:
        print(f"        ... and {len(bad) - SHOW:,} more")
    return 1


def main():
    db_path = os.environ.get('AMO_DB_PATH', normalize.DB)
    if not os.path.exists(db_path):
        print(f"ERROR: database not found: {db_path}")
        sys.exit(1)

    names = collect_names(db_path)
    print(f"Comparing old facility logic vs entity_names.py over {len(names):,} names\n")

    original_aliases = dict(LEGACY_FAC_ALIASES)
    failures = 0

    # ── 1. Pure rules — no aliases on either side ─────────────────────────
    print("1. Pure rules (no aliases loaded)")
    entity_names.clear_aliases()
    failures += compare(names, 'entity_key   vs legacy facility_name_key',
                        legacy_facility_name_key, entity_names.entity_key)
    failures += compare(names, 'display_name vs legacy clean_facility_name',
                        legacy_clean_facility_name, entity_names.display_name)

    # ── 2. Migration — hardcoded aliases move into the address book ───────
    print(f"\n2. Migration ({len(original_aliases)} hardcoded aliases -> address book)")
    entity_names.set_aliases(original_aliases)
    failures += compare(names, 'entity_key   vs legacy facility_name_key',
                        lambda n: legacy_facility_name_key(n, original_aliases),
                        entity_names.entity_key)
    failures += compare(names, 'display_name vs legacy clean_facility_name',
                        lambda n: legacy_clean_facility_name(n, original_aliases),
                        entity_names.display_name)

    # The aliases only prove anything if the names they target actually appear.
    hit = [v for v in original_aliases
           if any(entity_names.squash(n) == entity_names.squash(v) for n in names)]
    print(f"\n  {len(hit)}/{len(original_aliases)} alias variant(s) present in this database")
    if len(hit) < len(original_aliases):
        missing = set(original_aliases) - set(hit)
        print(f"  NOTE: not exercised here (absent from this DB): {sorted(missing)}")
        print("  Re-run against the production snapshot to cover them.")

    # ── 3. Alias resolution actually fires ────────────────────────────────
    # Checks 1-2 pass vacuously on a database whose names no alias targets, so
    # prove the mechanism works on synthetic input that does not depend on
    # which rows this DB happens to hold.
    print("3. Alias mechanism (synthetic — DB-independent)")
    cases = [
        # (aliases, raw input, expected display_name, description)
        ({'GIDY NATIONAL BANK OF FLORIDA': 'City National Bank of Florida'},
         'GIDY NATIONAL BANK OF FLORIDA', 'City National Bank of Florida',
         'exact variant resolves'),
        ({'GIDY NATIONAL BANK OF FLORIDA': 'City National Bank of Florida'},
         'Gidy National Bank of Florida,', 'City National Bank of Florida',
         'matching ignores case and trailing punctuation'),
        ({'A': 'B', 'B': 'C'}, 'A', 'C', 'chain A->B->C collapses'),
        ({'X': 'Y', 'Y': 'X'}, 'X', 'X', 'cycle terminates instead of hanging'),
        ({'ACME LLC': 'Acme Corp'}, 'UNRELATED CO', 'UNRELATED CO',
         'non-matching name passes through untouched'),
    ]
    for aliases, raw, expected, desc in cases:
        entity_names.set_aliases(aliases)
        got = entity_names.display_name(raw)
        if got == expected:
            print(f"  PASS  {desc}")
        else:
            print(f"  FAIL  {desc}: {raw!r} -> {got!r}, expected {expected!r}")
            failures += 1

    entity_names.clear_aliases()

    print()
    if failures:
        print(f"FAIL — {failures} check(s) diverged. Not safe to wire in.")
        return 1
    print("PASS — entity_names.py is behavior-identical to the logic it replaces.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
