"""Bank Stress Ranking — FDIC Call Report pull, metrics, scoring, flags, backtest.

Run from the collector directory:

    .venv/bin/python3 -m bank_stress.cli all

Every formula and field mapping is documented in README.md next to this file.
The package writes only to its own SQLite file (bank_stress.db); it never opens
miami_dade_amo.db.
"""
