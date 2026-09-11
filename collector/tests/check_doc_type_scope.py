"""
Verify non-assignment doc types never reach the analytical tables.
------------------------------------------------------------------
FST (UCC financing statements) is collected for the lending relationships it
exposes, but it is NOT an assignment: a UCC-1 records a new security interest,
it does not transfer a mortgage. Two invariants keep it from moving numbers the
dashboard already reports, and both are easy to break by accident:

  1. no FST row may enter `aom_events_clean` — not even one the extractor
     labels LOAN_TRANSFER. Over a quarter of the bucket is consumer solar and
     home-improvement finance (ISPC, GoodLeap, Solar Mosaic, Aqua, Palmetto).
  2. no FST party name may enter the raw-name signal sweep — that sweep has no
     loan-transfer filter and merges suffix signals by canonical name, so a
     consumer-finance name landing there can flip assignor_type/assignee_type
     on an entity that also trades in real mortgage assignments.

The fixture half matters more than the live half: production had no FST rows at
all when this was written, so a live-only check would pass while asserting
nothing. A negative control proves the filter is what excludes FST rather than
some unrelated condition — the same discipline as script/check-metric-directions.ts.

    AMO_DB_PATH=./prod_snapshot.db collector/.venv/bin/python3 \
        collector/tests/check_doc_type_scope.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import normalize  # noqa: E402

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

FST = 'FINANCING STATEMENT UCC - FST'
AMO = 'ASSIGNMENT OF MORTGAGE - AMO'
ASG = 'ASSIGNMENT - ASG'

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


# ── Fixture: an in-memory DB shaped like the real one ────────────────────────

def build_fixture() -> sqlite3.Connection:
    conn = sqlite3.connect(':memory:')
    conn.execute("""
        CREATE TABLE assignments (
            cfn TEXT, doc_type TEXT, grantor TEXT, grantee TEXT,
            county TEXT, rec_date TEXT
        )
    """)
    conn.executemany(
        "INSERT INTO assignments VALUES (?,?,?,?,?,?)",
        [
            # a real assignment — must survive
            ('2026R1', AMO, 'ACME MORTGAGE LLC', 'BIG BANK NA', 'MIAMI-DADE', '2026-01-02'),
            # a generic assignment — must survive
            ('2026R2', ASG, 'SOME LENDER LLC', 'ANOTHER BANK NA', 'MIAMI-DADE', '2026-01-03'),
            # legacy row predating the doc_type column — AMO by definition,
            # must survive. `doc_type NOT IN (...)` is NULL for this row, so a
            # filter without the NULL guard silently drops every legacy row.
            ('2026R3', None, 'OLD GRANTOR INC', 'OLD GRANTEE NA', 'MIAMI-DADE', '2026-01-04'),
            # the dangerous one — must be excluded everywhere analytical
            ('2026R4', FST, 'SOLAR DEBTOR LLC', 'GOODLEAP LLC', 'MIAMI-DADE', '2026-01-05'),
        ])
    conn.commit()
    return conn


def rows_passing_filter(conn, alias_sql: str) -> set[str]:
    return {r[0] for r in conn.execute(
        f"SELECT cfn FROM assignments WHERE 1=1{alias_sql}")}


def check_fixture() -> None:
    conn = build_fixture()

    kept = rows_passing_filter(conn, normalize.non_assignment_filter())

    if '2026R4' in kept:
        fail("non_assignment_filter() did NOT exclude the FST row — "
             "FST would reach aom_events_clean and the entity signal sweep")
    for cfn, label in (('2026R1', 'AMO'), ('2026R2', 'ASG')):
        if cfn not in kept:
            fail(f"non_assignment_filter() wrongly excluded the {label} row {cfn}")
    if '2026R3' not in kept:
        fail("non_assignment_filter() excluded the legacy NULL-doc_type row — "
             "this drops every pre-migration assignment from the clean table")

    # Aliased form, as normalize.py calls it inside the joined query.
    kept_alias = {r[0] for r in conn.execute(
        "SELECT a.cfn FROM assignments a WHERE 1=1"
        + normalize.non_assignment_filter('a.'))}
    if kept_alias != kept:
        fail(f"aliased filter disagrees with unaliased: {kept_alias} vs {kept}")

    # ── Negative control ────────────────────────────────────────────────────
    # Empty the constant and the FST row must come back. If it does not, the
    # exclusion above was caused by something other than this filter and the
    # test proves nothing.
    original = normalize.NON_ASSIGNMENT_DOC_TYPES
    try:
        normalize.NON_ASSIGNMENT_DOC_TYPES = ()
        unfiltered = rows_passing_filter(conn, normalize.non_assignment_filter())
    finally:
        normalize.NON_ASSIGNMENT_DOC_TYPES = original

    if '2026R4' not in unfiltered:
        fail("negative control failed: the FST row is missing even with "
             "NON_ASSIGNMENT_DOC_TYPES empty, so this test does not actually "
             "demonstrate that the filter is what excludes it")
    else:
        notes.append("negative control passed — the filter is what excludes FST")

    conn.close()
    notes.append(f"fixture: {len(kept)}/4 rows kept, FST excluded, "
                 f"legacy NULL row retained")


# ── Live DB: the invariant as it actually stands in production ───────────────

def table_exists(conn, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,)).fetchone() is not None


def check_live() -> None:
    if not os.path.exists(DB_PATH):
        notes.append(f"live DB {DB_PATH} not present — fixture checks only")
        return
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        if not table_exists(conn, 'assignments'):
            notes.append("live DB has no assignments table — skipped")
            return

        quoted = ', '.join('?' for _ in normalize.NON_ASSIGNMENT_DOC_TYPES)
        n_fst = conn.execute(
            f"SELECT COUNT(*) FROM assignments WHERE doc_type IN ({quoted})",
            normalize.NON_ASSIGNMENT_DOC_TYPES).fetchone()[0]
        notes.append(f"live DB holds {n_fst} non-assignment rows")

        if not table_exists(conn, 'aom_events_clean'):
            notes.append("live DB has no aom_events_clean — skipped")
            return

        leaked = conn.execute(f"""
            SELECT COUNT(*) FROM aom_events_clean c
            JOIN assignments a ON a.cfn = c.cfn
            WHERE a.doc_type IN ({quoted})
        """, normalize.NON_ASSIGNMENT_DOC_TYPES).fetchone()[0]
        if leaked:
            fail(f"{leaked} non-assignment rows reached aom_events_clean — "
                 f"the Reporting tab is counting UCC filings as assignments")
        elif n_fst:
            notes.append(f"none of the {n_fst} non-assignment rows reached "
                         f"aom_events_clean")
    finally:
        conn.close()


def check_nonloan_table() -> None:
    """aom_events_nonloan holds READ, NON-loan-transfer ASSIGNMENT filings only.

    Three ways this table can quietly go wrong, all of them invisible on screen:
      - a UCC filing slips in, and property owners start appearing as sellers
      - an unread filing slips in, and a document nobody has looked at gets
        filed under a category (41,970 Broward rows qualify)
      - a CFN lands in both tables, and every union double-counts it
    """
    if not os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        if not table_exists(conn, 'aom_events_nonloan'):
            notes.append("aom_events_nonloan absent — normalize.py has not run since "
                         "the feature shipped; skipped")
            return

        n = conn.execute("SELECT COUNT(*) FROM aom_events_nonloan").fetchone()[0]
        notes.append(f"aom_events_nonloan holds {n} rows")

        quoted = ', '.join('?' for _ in normalize.NON_ASSIGNMENT_DOC_TYPES)
        ucc = conn.execute(
            f"SELECT COUNT(*) FROM aom_events_nonloan WHERE doc_type IN ({quoted})",
            normalize.NON_ASSIGNMENT_DOC_TYPES).fetchone()[0]
        if ucc:
            fail(f"{ucc} UCC filings reached aom_events_nonloan — their first party is "
                 f"the BORROWER, so they would appear as loan sellers in Reporting")

        unread = conn.execute(
            "SELECT COUNT(*) FROM aom_events_nonloan WHERE doc_category IS NULL").fetchone()[0]
        if unread:
            fail(f"{unread} rows in aom_events_nonloan have no doc_category — an unread "
                 f"filing must not be presented under a category filter")

        both = conn.execute("""
            SELECT COUNT(*) FROM aom_events_nonloan n
            WHERE EXISTS (SELECT 1 FROM aom_events_clean c WHERE c.cfn = n.cfn)
        """).fetchone()[0]
        if both:
            fail(f"{both} CFNs appear in BOTH aom_events_clean and aom_events_nonloan — "
                 f"every union over the two double-counts them")

        loans = conn.execute(
            "SELECT COUNT(*) FROM aom_events_nonloan WHERE doc_category = 'LOAN_TRANSFER'"
        ).fetchone()[0]
        if loans:
            fail(f"{loans} LOAN_TRANSFER rows sit in aom_events_nonloan; they belong in "
                 f"aom_events_clean")

        if not failures and n:
            cats = conn.execute(
                "SELECT doc_category, COUNT(*) FROM aom_events_nonloan "
                "GROUP BY 1 ORDER BY 2 DESC").fetchall()
            notes.append("  categories: " + ", ".join(f"{c}={k}" for c, k in cats))
    finally:
        conn.close()


def main() -> int:
    check_fixture()
    check_live()
    check_nonloan_table()

    for n in notes:
        print(f"  · {n}")
    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("\n✅ doc-type scope holds")
    return 0


if __name__ == '__main__':
    sys.exit(main())
