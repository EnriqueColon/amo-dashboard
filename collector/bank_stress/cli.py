"""Command line entry point.

    .venv/bin/python3 -m bank_stress.cli pull [--quarters N] [--latest YYYYMMDD]
    .venv/bin/python3 -m bank_stress.cli metrics
    .venv/bin/python3 -m bank_stress.cli score
    .venv/bin/python3 -m bank_stress.cli backtest
    .venv/bin/python3 -m bank_stress.cli link       # seed cert ↔ AOM canonical name from the main DB
    .venv/bin/python3 -m bank_stress.cli all [--quarters N]

Exit codes: 0 ok, 2 a step failed (nothing partial is left behind by that step).
"""

from __future__ import annotations

import datetime as dt
import os
import sqlite3
import sys

from . import backtest, db as store, metrics, pull, scoring


def link() -> int:
    """Copy fdic_institution_cache (canonical_name → cert) from the AOM database into bank_entity_link.

    Read-only on the main database; skipped silently when it is not reachable
    (the pipeline must run on a machine without it).
    """
    amo = os.environ.get("AMO_DB_PATH")
    if not amo or not os.path.exists(amo):
        print("[link] AMO_DB_PATH not set or missing — skipped")
        return 0
    try:
        src = sqlite3.connect(f"file:{amo}?mode=ro", uri=True)
        rows = src.execute("SELECT canonical_name, cert FROM fdic_institution_cache WHERE cert IS NOT NULL AND cert != ''").fetchall()
        src.close()
    except sqlite3.Error as exc:
        print(f"[link] could not read fdic_institution_cache: {exc} — skipped")
        return 0
    conn = store.connect()
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    n = 0
    for canonical, cert in rows:
        try:
            conn.execute("INSERT OR IGNORE INTO bank_entity_link (cert, canonical_name, source, linked_at) VALUES (?,?,?,?)",
                         (int(cert), canonical, "fdic_institution_cache", now))
            n += 1
        except (TypeError, ValueError):
            continue
    conn.commit()
    conn.close()
    print(f"[link] {n:,} cert ↔ canonical-name rows available for the loan-sale join")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "pull":
        return pull.main(rest)
    if cmd == "metrics":
        return metrics.run()
    if cmd == "score":
        return scoring.run()
    if cmd == "backtest":
        return backtest.run()
    if cmd == "link":
        return link()
    if cmd == "all":
        rc = pull.main(rest)
        if rc:
            return rc
        for step in (metrics.run, scoring.run, backtest.run, link):
            rc = step()
            if rc:
                return rc
        return 0
    print(f"unknown command {cmd!r}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
