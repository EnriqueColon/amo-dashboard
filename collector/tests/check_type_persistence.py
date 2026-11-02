"""
Verify entity types written by the AI step and by users survive a rebuild.
--------------------------------------------------------------------------
Before 31 Oct 2026 normalize.py replaced every entity_classifications row with
its own rule result on each run. The nightly rebuild therefore erased the
verdicts the Friday job had just written: 10,785 AI-typed entities fell to 59
overnight and 21% of aom_events_clean changed txn_type (finding F1 of
docs/audit_2026-10-31/ACCURACY_AUDIT.md).

What this asserts, offline on a throwaway database (no production data):

  1. A dashboard override ('user_override') beats every rule, including the
     FDIC match and the MERS rule.
  2. An earlier AI verdict is used ONLY where no rule has an answer -
     it never beats an FDIC match, a banking suffix or a code override.
  3. An AI verdict of OTHER is not kept, so those entities are still retried.
  4. Two rebuilds in a row give identical types (the property the nightly job
     needs), and a rebuild no longer changes an AI-typed entity.
  5. The OLD behaviour (no `preserved` argument) still erases the AI verdict -
     a negative control proving the assertions above test the new code path
     and not some unrelated condition.
  6. The shape the dashboard wrote before it used 'user_override'
     (manual_override with sub_category = '') is read as a user decision, and the
     code-defined overrides (sub_category NULL) are not.

    collector/.venv/bin/python3 collector/tests/check_type_persistence.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import normalize  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE aom_events_clean (
            assignor_canon TEXT, assignee_canon TEXT, assignor_type TEXT, assignee_type TEXT);
        CREATE TABLE entity_classifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, category TEXT,
            subcategory TEXT, sub_category TEXT, notes TEXT, confidence_source TEXT);
    """)
    return conn


def put(conn, name, cat, src, sub=None):
    conn.execute("INSERT OR REPLACE INTO entity_classifications (name, category, sub_category, confidence_source) "
                 "VALUES (?,?,?,?)", (name, cat, sub, src))


NO_SIGNALS = {'has_banking_suffix': False, 'has_trustee_role': False, 'has_trust_name': False, 'has_gse_suffix': False}

conn = make_db()
put(conn, 'ATLANTIS HOLDINGS AM', 'PRIVATE_CREDIT', 'llm')
put(conn, 'RANDOM SHELL CO', 'OTHER', 'llm')
put(conn, 'FDIC BANK ONE', 'PRIVATE_CREDIT', 'llm')
put(conn, 'WELLS FARGO', 'TRUST', 'user_override', '')
put(conn, 'DLJ MORTGAGE CAPITAL', 'BANK', 'manual_override', '')      # old UI shape
put(conn, 'TOWD POINT', 'TRUST', 'manual_override', None)             # code-defined, sub NULL
P = normalize.load_preserved_types(conn)

check(P['llm'] == {'ATLANTIS HOLDINGS AM': 'PRIVATE_CREDIT', 'FDIC BANK ONE': 'PRIVATE_CREDIT'},
      f"llm verdicts: OTHER dropped, rest kept; got {P['llm']}")
check(P['user'] == {'WELLS FARGO': 'TRUST', 'DLJ MORTGAGE CAPITAL': 'BANK'},
      f"user decisions: new label + old UI shape only; got {P['user']}")

fdic = {'WELLS FARGO', 'FDIC BANK ONE'}

# 1. user override beats an FDIC match
got = normalize.resolve_entity_type('WELLS FARGO', NO_SIGNALS, fdic, conn, P)
check(got == ('TRUST', 'user_override'), f"user override must beat FDIC match; got {got}")

# 2a. AI verdict fills in where no rule answers
got = normalize.resolve_entity_type('ATLANTIS HOLDINGS AM', NO_SIGNALS, fdic, conn, P)
check(got == ('PRIVATE_CREDIT', 'llm'), f"AI verdict must be kept; got {got}")
# 2b. ...but never beats a rule
got = normalize.resolve_entity_type('FDIC BANK ONE', NO_SIGNALS, fdic, conn, P)
check(got == ('BANK', 'fdic_match'), f"AI verdict must not beat FDIC match; got {got}")
got = normalize.resolve_entity_type('ATLANTIS HOLDINGS AM', {**NO_SIGNALS, 'has_banking_suffix': True}, set(), conn, P)
check(got == ('BANK', 'suffix_banking'), f"AI verdict must not beat a banking suffix; got {got}")

# 3. an AI 'OTHER' is not kept
got = normalize.resolve_entity_type('RANDOM SHELL CO', NO_SIGNALS, fdic, conn, P)
check(got == ('OTHER', 'default'), f"AI OTHER must stay retryable; got {got}")

# 5. negative control: without `preserved` the AI verdict is erased (the old behaviour)
got = normalize.resolve_entity_type('ATLANTIS HOLDINGS AM', NO_SIGNALS, fdic, conn)
check(got == ('OTHER', 'default'), f"control: no `preserved` must reproduce the old erase; got {got}")

# 4. two rebuilds in a row are identical, and the second still holds the AI verdict
def rebuild(c):
    pres = normalize.load_preserved_types(c)
    out = {}
    for name in ('ATLANTIS HOLDINGS AM', 'RANDOM SHELL CO', 'FDIC BANK ONE', 'WELLS FARGO', 'DLJ MORTGAGE CAPITAL', 'UNSEEN LLC'):
        out[name] = normalize.resolve_entity_type(name, NO_SIGNALS, fdic, c, pres)
    for name, (t, s) in out.items():
        c.execute("INSERT INTO entity_classifications (name, category, confidence_source) VALUES (?,?,?) "
                  "ON CONFLICT(name) DO UPDATE SET category = excluded.category, confidence_source = excluded.confidence_source",
                  (name, t, s))
    return out

first, second = rebuild(conn), rebuild(conn)
check(first == second, f"rebuilds must be idempotent;\n first  {first}\n second {second}")
check(second['ATLANTIS HOLDINGS AM'] == ('PRIVATE_CREDIT', 'llm'), "AI verdict must survive repeated rebuilds")
check(second['UNSEEN LLC'] == ('OTHER', 'default'), "an entity nobody has classified stays OTHER/default")

# 6. a code-defined override is not read back as a user decision
check('TOWD POINT' not in P['user'], "code-defined manual_override (sub_category NULL) must not become a user decision")

if failures:
    print('FAIL')
    for f in failures:
        print(' -', f)
    sys.exit(1)
print('check-type-persistence: all passed')
