"""
Guardrail: a merge recorded DURING a rebuild must survive the rebuild.

What happened on 15 Oct 2026: the owner merged 140 duplicate clusters on the
Entities page between 09:34 and 10:41 UTC. The nightly normalize had started at
08:30, loaded the alias table then, and at 10:41 committed a rebuild that knew
nothing about those 140 rules — every merge silently reverted until the next
night. normalize.apply_late_aliases() closes that gap.

These checks build a scratch database with the two event tables already
"rebuilt" under pre-merge names, record aliases with created_at after the run
began, and assert:
  1. rows under a late variant are re-pointed to the canonical, in both tables;
  2. a chain (A → B recorded, then B → C recorded) resolves to C;
  3. the canonical's classification is applied and txn_type is re-derived —
     a borrower LLC merged into a BANK stops reading as an ORIGINATION;
  4. an alias recorded BEFORE the run began is left alone (load_aliases() owns
     those), and a facility-scoped alias is ignored.

Run:  collector/.venv/bin/python3 collector/tests/check_late_alias_replay.py
"""
import os
import sqlite3
import sys
import tempfile

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


EVENT_COLS = ('cfn TEXT PRIMARY KEY, assignor TEXT, assignee TEXT, '
              'assignor_canon TEXT, assignee_canon TEXT, '
              'assignor_type TEXT, assignee_type TEXT, txn_type TEXT')


def fresh_db() -> str:
    path = os.path.join(tempfile.mkdtemp(prefix='late_alias_'), 'test.db')
    conn = sqlite3.connect(path)
    conn.executescript(f"""
        CREATE TABLE aom_events_clean ({EVENT_COLS});
        CREATE TABLE aom_events_nonloan ({EVENT_COLS});
        CREATE TABLE entity_aliases (
            variant TEXT PRIMARY KEY, canonical TEXT NOT NULL,
            created_at TEXT, created_by TEXT, note TEXT, scope TEXT DEFAULT 'all');
        CREATE TABLE entity_classifications (name TEXT PRIMARY KEY, category TEXT);
    """)
    conn.commit()
    conn.close()
    return path


def main() -> int:
    db = fresh_db()
    os.environ['AMO_DB_PATH'] = db
    sys.modules.pop('normalize', None)
    sys.path.insert(0, COLLECTOR)
    import normalize

    RUN_STARTED = '2026-10-15T08:30:00'
    before, after = '2026-10-15T08:00:00.000Z', '2026-10-15T09:35:00.000Z'

    conn = sqlite3.connect(db)
    conn.executemany(
        "INSERT INTO entity_classifications (name, category) VALUES (?, ?)",
        [('BANK OF AMERICA', 'BANK'), ('WELLS FARGO', 'BANK'),
         ('ALTO CAPITAL', 'PRIVATE_CREDIT')])
    rows = [
        # cfn, assignor, assignee, assignor_canon, assignee_canon, a_type, b_type, txn
        ('R1', 'BANK-OF AMERICA', 'WELLS FARGO', 'BANK-OF AMERICA', 'WELLS FARGO',
         'OTHER', 'BANK', 'ORIGINATION'),            # late variant on the assignor side
        ('R2', 'WELLS FARGO', 'BANK-OF AMERICA', 'WELLS FARGO', 'BANK-OF AMERICA',
         'BANK', 'OTHER', 'INSTITUTIONAL_OUT'),      # late variant on the assignee side
        ('R3', 'ALTO CAP', 'WELLS FARGO', 'ALTO CAP', 'WELLS FARGO',
         'OTHER', 'BANK', 'ORIGINATION'),            # chain: ALTO CAP → ALTO CAPITAL GRP → ALTO CAPITAL
        ('R4', 'OLD VARIANT', 'WELLS FARGO', 'OLD VARIANT', 'WELLS FARGO',
         'OTHER', 'BANK', 'ORIGINATION'),            # alias recorded BEFORE the run: not ours to touch
        ('R5', 'FAC VARIANT', 'WELLS FARGO', 'FAC VARIANT', 'WELLS FARGO',
         'OTHER', 'BANK', 'ORIGINATION'),            # facility-scoped alias: ignored
    ]
    conn.executemany("INSERT INTO aom_events_clean VALUES (?,?,?,?,?,?,?,?)", rows)
    conn.executemany("INSERT INTO aom_events_nonloan VALUES (?,?,?,?,?,?,?,?)", rows[:1])
    conn.executemany(
        "INSERT INTO entity_aliases (variant, canonical, created_at, created_by, scope) VALUES (?,?,?,?,?)",
        [('BANK-OF AMERICA', 'BANK OF AMERICA', after, 'user', 'all'),
         ('ALTO CAP', 'ALTO CAPITAL GRP', after, 'user', 'all'),
         ('ALTO CAPITAL GRP', 'ALTO CAPITAL', after, 'user', None),   # NULL scope counts as 'all'
         ('OLD VARIANT', 'BANK OF AMERICA', before, 'user', 'all'),
         ('FAC VARIANT', 'BANK OF AMERICA', after, 'user', 'facility')])
    conn.commit()

    touched = normalize.apply_late_aliases(conn, RUN_STARTED)
    get = lambda table, cfn: conn.execute(  # noqa: E731
        f"SELECT assignor_canon, assignee_canon, assignor_type, assignee_type, txn_type "
        f"FROM {table} WHERE cfn=?", (cfn,)).fetchone()

    print('1. late variant re-pointed in both tables')
    check('  clean R1 assignor → BANK OF AMERICA', get('aom_events_clean', 'R1')[0], 'BANK OF AMERICA')
    check('  clean R2 assignee → BANK OF AMERICA', get('aom_events_clean', 'R2')[1], 'BANK OF AMERICA')
    check('  nonloan R1 assignor → BANK OF AMERICA', get('aom_events_nonloan', 'R1')[0], 'BANK OF AMERICA')
    check('  rows re-pointed counted', touched >= 4, True)

    print('2. a chain resolves to its final canonical')
    check('  ALTO CAP → ALTO CAPITAL (not the intermediate)', get('aom_events_clean', 'R3')[0], 'ALTO CAPITAL')

    print('3. type and txn_type follow the canonical')
    r1 = get('aom_events_clean', 'R1')
    check('  assignor_type becomes BANK', r1[2], 'BANK')
    check('  bank → bank is a MARKET_TRANSFER, not an ORIGINATION', r1[4], 'MARKET_TRANSFER')
    r3 = get('aom_events_clean', 'R3')
    check('  ALTO CAPITAL typed PRIVATE_CREDIT', r3[2], 'PRIVATE_CREDIT')
    check('  private credit → bank is a MARKET_TRANSFER', r3[4], 'MARKET_TRANSFER')

    print('4. aliases that are not this step\'s business are untouched')
    check('  alias recorded before the run: left for load_aliases()', get('aom_events_clean', 'R4')[0], 'OLD VARIANT')
    check('  facility-scoped alias ignored', get('aom_events_clean', 'R5')[0], 'FAC VARIANT')

    print('5. nothing to do is a clean no-op')
    check('  second pass re-points nothing', normalize.apply_late_aliases(conn, RUN_STARTED), 0)
    conn.close()

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
