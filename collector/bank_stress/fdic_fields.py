"""The FDIC BankFind fields this package pulls, and the assertion that guards them.

Every code here was verified on 27 Oct 2026 against a live pull of CERT 17281
(REPDTE 20260630) AND against the official properties file
https://api.fdic.gov/banks/docs/risview_properties.yaml. The FDIC API silently
drops any field name it does not recognise, so `assert_fields_present` is
mandatory after every pull — a missing field must fail loudly, never become a
silent null.

Units: dollar fields are $ thousands. `basis`:
  id    identifier / descriptor
  ytd   income-statement flow, cumulative year-to-date (de-cumulated in metrics.py)
  qtr   FDIC's own quarterly flow (used to cross-check the de-cumulation)
  pit   balance-sheet point-in-time
  ratio FDIC-computed ratio, percent units (cross-checks only)
"""

from __future__ import annotations

# (code, basis, sql_type, title as the FDIC properties file states it)
FINANCIAL_FIELDS: list[tuple[str, str, str, str]] = [
    # ── identifiers ──────────────────────────────────────────────────────────
    ("CERT",     "id", "INTEGER", "FDIC certificate number"),
    ("NAME",     "id", "TEXT",    "Institution name"),
    ("REPDTE",   "id", "TEXT",    "Report date YYYYMMDD"),
    ("STALP",    "id", "TEXT",    "State (FIPS alpha)"),
    ("RSSDHCR",  "id", "TEXT",    "RSSD id of the regulatory top holding company (blank/0 = none)"),
    ("NAMEHCR",  "id", "TEXT",    "Bank holding company name (regulatory top holder)"),
    ("ESTYMD",   "id", "INTEGER", "Established date YYYYMMDD"),
    ("CBLRIND",  "id", "INTEGER", "Community bank leverage ratio filer (1 = no risk-based capital reported)"),
    ("ACTEVT",   "id", "TEXT",    "Structure activity event code (merger / closing codes only)"),
    # ── balance sheet, point in time ─────────────────────────────────────────
    ("ASSET",    "pit", "REAL", "Total assets"),
    ("AVASSETJ", "pit", "REAL", "Average assets (PCA) — FDIC's own average, for comparison"),
    ("LNLSNET",  "pit", "REAL", "Loans and leases, net of allowance"),
    ("LNLSGR",   "pit", "REAL", "Loans and leases, gross"),
    ("DEP",      "pit", "REAL", "Total deposits"),
    ("EQ",       "pit", "REAL", "Total equity capital"),
    ("EQCMRG",   "ytd", "REAL", "Change in equity due to mergers (YTD)"),
    ("LNATRES",  "pit", "REAL", "Allowance for loan and lease losses (adjusted)"),
    ("NCLNLS",   "pit", "REAL", "Noncurrent loans and leases (90+ days past due + nonaccrual)"),
    ("NCRECONS", "pit", "REAL", "Noncurrent construction & land development loans"),
    ("NCREMULT", "pit", "REAL", "Noncurrent multifamily loans"),
    ("NCRENRES", "pit", "REAL", "Noncurrent nonfarm nonresidential loans (all)"),
    ("NCRENROT", "pit", "REAL", "Noncurrent nonfarm nonresidential, NON-owner-occupied"),
    ("LNRE",     "pit", "REAL", "Real estate loans, total"),
    ("LNRECONS", "pit", "REAL", "Construction & land development loans"),
    ("LNREMULT", "pit", "REAL", "Multifamily loans"),
    ("LNRENRES", "pit", "REAL", "Nonfarm nonresidential loans (all, incl. owner-occupied)"),
    ("LNRENROT", "pit", "REAL", "Nonfarm nonresidential loans, NON-owner-occupied"),
    ("RBC1AAJ",  "ratio", "REAL", "Tier 1 leverage ratio (PCA), percent"),
    ("RBCT1J",   "pit", "REAL", "Tier 1 capital (PCA, adjusted) — reported by every bank"),
    ("RBC",      "pit", "REAL", "Total risk-based capital (PCA) — 0 for CBLR filers"),
    ("RBCT2",    "pit", "REAL", "Tier 2 capital (PCA) — 0 for CBLR filers"),
    ("RBCRWAJ",  "ratio", "REAL", "Total risk-based capital ratio, percent — 0 for CBLR filers"),
    ("BRO",      "pit", "REAL", "Brokered deposits"),
    ("DEPUNINS", "pit", "REAL", "Estimated uninsured deposits (domestic offices)"),
    ("DEPINS",   "pit", "REAL", "Estimated insured deposits"),
    ("SCAF",     "pit", "REAL", "Available-for-sale securities, fair value"),
    ("SCAA",     "pit", "REAL", "Available-for-sale securities, amortized cost"),
    ("SCHA",     "pit", "REAL", "Held-to-maturity securities, amortized cost"),
    ("SCHF",     "pit", "REAL", "Held-to-maturity securities, fair value"),
    ("ORE",      "pit", "REAL", "Other real estate owned"),
    ("LNLSSALE", "pit", "REAL", "Loans and leases held for sale"),
    # ── added 27 Oct 2026 for the FDIC Data Analytics page (stage 2) ─────────
    ("STNAME",   "id",  "TEXT", "State name"),
    ("CITY",     "id",  "TEXT", "City"),
    ("NALNLS",   "pit", "REAL", "Nonaccrual loans and leases"),
    ("P3LNLS",   "pit", "REAL", "Loans and leases past due 30–89 days"),
    ("P9LNLS",   "pit", "REAL", "Loans and leases past due 90+ days (still accruing)"),
    ("P3ASSET",  "pit", "REAL", "Assets past due 30–89 days"),
    ("P9ASSET",  "pit", "REAL", "Assets past due 90+ days"),
    ("LNRENROW", "pit", "REAL", "Nonfarm nonresidential loans, owner-occupied"),
    ("LNRERES",  "pit", "REAL", "1–4 family residential loans"),
    ("UCLN",     "pit", "REAL", "Unused loan commitments, total"),
    ("UCCOMRE",  "pit", "REAL", "Unused commitments: commercial real estate, construction & land development"),
    ("RBCT1CER", "ratio", "REAL", "Common equity Tier 1 capital ratio, percent (0 for CBLR filers)"),
    ("RBC1RWAJ", "ratio", "REAL", "Tier 1 risk-based capital ratio, percent (0 for CBLR filers)"),
    ("RWAJ",     "pit", "REAL", "Risk-weighted assets (PCA)"),
    ("NIMR",     "ratio", "REAL", "Net interest margin (FDIC ratio, YTD annualized), percent"),
    # ── income statement, year-to-date ───────────────────────────────────────
    ("INTINC",     "ytd", "REAL", "Total interest income"),
    ("EINTEXP",    "ytd", "REAL", "Total interest expense (= EDEP + EFREPP + EOTHINT)"),
    ("EDEP",       "ytd", "REAL", "Interest on deposits"),
    ("EFREPP",     "ytd", "REAL", "Interest on fed funds purchased & repos"),
    ("EOTHINT",    "ytd", "REAL", "Other interest expense (other borrowings incl. sub-debt)"),
    ("NIM",        "ytd", "REAL", "Net interest income ($, not the margin)"),
    ("ELNATR",     "ytd", "REAL", "Provision for credit losses"),
    ("NONII",      "ytd", "REAL", "Total noninterest income"),
    ("NONIX",      "ytd", "REAL", "Total noninterest expense"),
    ("PTAXNETINC", "ytd", "REAL", "Pre-tax net operating income (= NIM + NONII − NONIX − ELNATR; excludes securities gains)"),
    ("NETINC",     "ytd", "REAL", "Net income"),
    ("IGLSEC",     "ytd", "REAL", "Realized securities gains (losses)"),
    ("NETGNSLN",   "ytd", "REAL", "Net gains (losses) on sales of loans"),
    ("NETGNSRE",   "ytd", "REAL", "Net gains (losses) on sales of other real estate owned"),
    ("EQCDIV",     "ytd", "REAL", "Cash dividends declared, common + preferred"),
    ("NTLNLS",     "ytd", "REAL", "Net charge-offs, total loans and leases"),
    ("NTRECONS",   "ytd", "REAL", "Net charge-offs, construction & land development"),
    ("NTREMULT",   "ytd", "REAL", "Net charge-offs, multifamily"),
    ("NTRENRES",   "ytd", "REAL", "Net charge-offs, nonfarm nonresidential (all)"),
    ("NTRENROT",   "ytd", "REAL", "Net charge-offs, nonfarm nonresidential NON-owner-occupied"),
    # ── FDIC's own quarterly flows (cross-check the de-cumulation) ───────────
    ("INTINQ",     "qtr", "REAL", "Total interest income, quarter"),
    ("EINTXQ",     "qtr", "REAL", "Total interest expense, quarter"),
    ("EOTHINTQ",   "qtr", "REAL", "Other interest expense, quarter"),
    ("NIMQ",       "qtr", "REAL", "Net interest income, quarter"),
    ("ELNATQ",     "qtr", "REAL", "Provision for credit losses, quarter"),
    ("NONIIQ",     "qtr", "REAL", "Total noninterest income, quarter"),
    ("NONIXQ",     "qtr", "REAL", "Total noninterest expense, quarter"),
    ("NETINCQ",    "qtr", "REAL", "Net income, quarter"),
    ("NTLNLSQ",    "qtr", "REAL", "Net charge-offs, quarter"),
    ("NTGLLNQ",    "qtr", "REAL", "Net gains (losses) on sales of loans, quarter"),
    ("NTRECONQ",   "qtr", "REAL", "Net charge-offs construction, quarter"),
    ("NTREMULQ",   "qtr", "REAL", "Net charge-offs multifamily, quarter"),
    ("NTRENRSQ",   "qtr", "REAL", "Net charge-offs nonfarm nonresidential (all), quarter"),
    # ── FDIC-computed ratios, percent units (cross-checks only) ─────────────
    ("ROA",      "ratio", "REAL", "Return on assets (annualized YTD)"),
    ("ROAPTX",   "ratio", "REAL", "Pre-tax return on assets"),
    ("EEFFR",    "ratio", "REAL", "Efficiency ratio"),
    ("LNLSDEPR", "ratio", "REAL", "Net loans / deposits"),
    ("NCLNLSR",  "ratio", "REAL", "Noncurrent loans / gross loans"),
    ("LNATRESR", "ratio", "REAL", "Allowance / gross loans"),
    ("ELNANTR",  "ratio", "REAL", "Provision / net charge-offs"),
    ("NIMY",     "ratio", "REAL", "Net interest margin"),
    ("NTLNLSR",  "ratio", "REAL", "Net charge-offs / loans"),
]

FINANCIAL_CODES: list[str] = [f[0] for f in FINANCIAL_FIELDS]

# YTD code → FDIC quarterly twin, where one exists. metrics.py asserts
# (ytd_t − ytd_{t−1}) == twin_t to the dollar on every pull.
QUARTERLY_TWINS: dict[str, str] = {
    "INTINC": "INTINQ",
    "EINTEXP": "EINTXQ",
    "EOTHINT": "EOTHINTQ",
    "NIM": "NIMQ",
    "ELNATR": "ELNATQ",
    "NONII": "NONIIQ",
    "NONIX": "NONIXQ",
    "NETINC": "NETINCQ",
    "NTLNLS": "NTLNLSQ",
    "NETGNSLN": "NTGLLNQ",
    "NTRECONS": "NTRECONQ",
    "NTREMULT": "NTREMULQ",
    "NTRENRES": "NTRENRSQ",
}

INSTITUTION_FIELDS: list[tuple[str, str, str, str]] = [
    ("CERT",    "id", "INTEGER", "FDIC certificate number"),
    ("NAME",    "id", "TEXT",    "Institution name"),
    ("CITY",    "id", "TEXT",    "City"),
    ("STALP",   "id", "TEXT",    "State"),
    ("RSSDHCR", "id", "TEXT",    "RSSD id of the regulatory top holder"),
    ("NAMEHCR", "id", "TEXT",    "Holding company name"),
    ("ESTYMD",  "id", "TEXT",    "Established date (MM/DD/YYYY on this endpoint)"),
    ("ACTIVE",  "id", "INTEGER", "1 = active"),
    ("BKCLASS", "id", "TEXT",    "Institution class"),
    ("ASSET",   "pit", "REAL",   "Total assets at REPDTE"),
    ("REPDTE",  "id", "TEXT",    "Report date of the ASSET figure"),
]
INSTITUTION_CODES: list[str] = [f[0] for f in INSTITUTION_FIELDS]

FAILURE_FIELDS: list[tuple[str, str, str, str]] = [
    ("CERT",     "id", "INTEGER", "FDIC certificate number"),
    ("NAME",     "id", "TEXT",    "Institution name at failure"),
    ("FAILDATE", "id", "TEXT",    "Failure date (M/D/YYYY on this endpoint)"),
    ("FAILYR",   "id", "TEXT",    "Failure year"),
    ("CITYST",   "id", "TEXT",    "City, state"),
    ("QBFASSET", "pit", "REAL",   "Total assets at the last report before failure"),
    ("RESTYPE",  "id", "TEXT",    "Resolution type"),
]
FAILURE_CODES: list[str] = [f[0] for f in FAILURE_FIELDS]


class MissingFieldError(RuntimeError):
    """Raised when the FDIC response lacks a field we asked for."""


def assert_fields_present(rows: list[dict], expected: list[str], context: str,
                          optional: tuple[str, ...] = ()) -> dict[str, int]:
    """Fail loudly if any expected field is absent from any row.

    The FDIC API drops unknown field names without an error, so an absent KEY
    (not a null value — nulls are legitimate) means our field list is wrong or
    the API changed. Checked on every row, not only the first: a field can be
    absent from one row and present in another when the index is inconsistent.

    `optional` names fields that may be absent on individual rows without
    failing the pull — used for the /institutions descriptors, where the API
    omits the key instead of sending null for a bank that has not filed yet.
    A field absent from EVERY row is still an error, optional or not. Returns
    the per-field count of rows where an optional field was absent.
    """
    if not rows:
        raise MissingFieldError(f"{context}: the response holds no rows")
    missing: dict[str, int] = {}
    for row in rows:
        for code in expected:
            if code not in row:
                missing[code] = missing.get(code, 0) + 1
    fatal = {code: n for code, n in missing.items() if code not in optional or n == len(rows)}
    if fatal:
        detail = ", ".join(f"{code} (absent in {n} of {len(rows)} rows)" for code, n in sorted(fatal.items()))
        raise MissingFieldError(f"{context}: FDIC response is missing requested fields — {detail}")
    return {code: n for code, n in missing.items() if code in optional}
