"""Per-bank, per-quarter metrics from the raw Call Report rows.

    .venv/bin/python3 -m bank_stress.cli metrics

Reads fdic_financials_raw, writes bank_metrics (dropped and rebuilt in one
transaction, so a reader never sees a half-built table).

The rules, all from the brief and verified against FDIC's own quarterly fields
(README §2):

  * Income-statement fields are YTD. Quarterly flow = YTD(t) − YTD(t−1) for Q2–Q4,
    = YTD for Q1. Where FDIC publishes its own quarterly twin (NETINCQ, NIMQ …)
    the two must agree to the dollar; disagreements are counted per row in
    `twin_mismatches`. When the prior quarter is missing (bank absent from the
    universe that quarter) the twin is used and `flow_source` says so.
  * Annualized ratio = quarterly flow × 4 / average assets, average assets =
    mean of ASSET at t and t−1 (FDIC's own AVASSETJ when t−1 is missing).
  * Balance-sheet fields are point-in-time; never de-cumulated.
  * Small denominators (config `floors`) make a ratio null, never zero or inf.
  * CRE = construction + multifamily + NON-owner-occupied nonfarm nonresidential
    (LNRENROT), the interagency definition; owner-occupied is excluded.
  * Capital denominator for concentrations = Tier 1 capital (RBCT1J), the one
    figure every bank reports (CBLR filers report total RBC as 0).
  * Trend features: Δ QoQ, Δ YoY and the 4-quarter OLS slope (per quarter) of
    each metric. A feature is null when the window spans a merger quarter.
  * Merger quarter = ACTEVT set, or EQCMRG ≠ 0, or assets up > 25% QoQ.
"""

from __future__ import annotations

import datetime as dt
import sys
from bisect import bisect_left

from . import db as store
from .fdic_fields import QUARTERLY_TWINS
from .pull import previous_quarter

# ── metric registry: the single definition of what is computed and which way it points ──
#
# stress_when: 'high' → a high value means more stress; 'low' → a low value
# means more stress; None → descriptive only, never scored.
METRICS: list[dict] = [
    # core performance
    {"key": "roa",                     "label": "ROA",                          "unit": "pct", "stress_when": "low",  "group": "performance", "formula": "net income × 4 / avg assets"},
    {"key": "pretax_roa",              "label": "Pre-tax ROA",                  "unit": "pct", "stress_when": "low",  "group": "performance", "formula": "pre-tax net operating income × 4 / avg assets"},
    {"key": "core_roa",                "label": "Core ROA",                     "unit": "pct", "stress_when": "low",  "group": "performance", "formula": "(pre-tax net operating income − loan-sale gains − OREO-sale gains) × 4 / avg assets. PTAXNETINC already excludes securities gains."},
    {"key": "nii_ratio",               "label": "Net interest income / assets", "unit": "pct", "stress_when": "low",  "group": "performance", "formula": "net interest income × 4 / avg assets"},
    {"key": "funding_cost_ratio",      "label": "Funding cost ratio",           "unit": "pct", "stress_when": "high", "group": "performance", "formula": "interest expense / interest income"},
    {"key": "wholesale_funding_share", "label": "Wholesale funding share",      "unit": "pct", "stress_when": "high", "group": "performance", "formula": "(fed funds & repo interest + other interest expense) / total interest expense"},
    {"key": "efficiency_ratio",        "label": "Efficiency ratio",             "unit": "pct", "stress_when": "high", "group": "performance", "formula": "noninterest expense / (net interest income + noninterest income)"},
    {"key": "fee_dependence",          "label": "Fee dependence",               "unit": "pct", "stress_when": None,   "group": "performance", "formula": "noninterest income / (net interest income + noninterest income)"},
    # credit & capital
    {"key": "provision_ratio",         "label": "Provision / assets",           "unit": "pct", "stress_when": "high", "group": "credit", "formula": "provision × 4 / avg assets"},
    {"key": "provision_coverage",      "label": "Provision coverage",           "unit": "x",   "stress_when": "low",  "group": "credit", "formula": "provision / net charge-offs; null when quarterly net charge-offs < $50K"},
    {"key": "provision_burden",        "label": "Provision burden",             "unit": "pct", "stress_when": "high", "group": "credit", "formula": "provision / pre-provision pre-tax income; null when that income ≤ 0"},
    {"key": "cre_nco_ratio",           "label": "CRE net charge-offs / CRE loans", "unit": "pct", "stress_when": "high", "group": "credit", "formula": "(construction + multifamily + non-owner-occupied nonfarm nonres net charge-offs) × 4 / CRE loans"},
    {"key": "cre_chargeoff_share",     "label": "CRE share of charge-offs",     "unit": "pct", "stress_when": "high", "group": "credit", "formula": "CRE net charge-offs / total net charge-offs; null when total < $50K"},
    {"key": "dividend_payout",         "label": "Dividend payout (TTM)",        "unit": "pct", "stress_when": "high", "group": "credit", "formula": "trailing-4-quarter dividends / trailing-4-quarter net income; null for holding-company-owned banks and when TTM net income ≤ 0"},
    {"key": "retained_earnings_drag",  "label": "Retained earnings / assets",   "unit": "pct", "stress_when": "low",  "group": "credit", "formula": "(net income − dividends) × 4 / avg assets"},
    {"key": "noncurrent_ratio",        "label": "Noncurrent loans / loans",     "unit": "pct", "stress_when": "high", "group": "credit", "formula": "noncurrent loans & leases / gross loans"},
    {"key": "reserve_coverage",        "label": "Reserve coverage",             "unit": "pct", "stress_when": "low",  "group": "credit", "formula": "allowance / max(noncurrent loans, $50K) — a bank with no noncurrent loans reads very high, i.e. well covered"},
    {"key": "tier1_leverage",          "label": "Tier 1 leverage ratio",        "unit": "pct", "stress_when": "low",  "group": "capital", "formula": "FDIC RBC1AAJ"},
    {"key": "loan_to_deposit",         "label": "Loans / deposits",             "unit": "pct", "stress_when": "high", "group": "capital", "formula": "net loans / total deposits"},
    {"key": "cre_concentration",       "label": "CRE / Tier 1 capital",         "unit": "pct", "stress_when": "high", "group": "cre", "formula": "(construction + multifamily + non-owner-occupied nonfarm nonres loans) / Tier 1 capital"},
    {"key": "construction_concentration", "label": "Construction / Tier 1 capital", "unit": "pct", "stress_when": "high", "group": "cre", "formula": "construction & land development loans / Tier 1 capital"},
    {"key": "unrealized_sec_to_equity", "label": "Unrealized securities G/L / equity", "unit": "pct", "stress_when": "low", "group": "capital", "formula": "((AFS fair value − AFS amortized cost) + (HTM fair value − HTM amortized cost)) / equity"},
    {"key": "loan_sale_gains_ratio",   "label": "Loan & OREO sale gains / assets", "unit": "pct", "stress_when": "low", "group": "cre", "formula": "(net gains on loan sales + net gains on OREO sales) × 4 / avg assets; negative = losses"},
    {"key": "brokered_share",          "label": "Brokered deposits / deposits", "unit": "pct", "stress_when": "high", "group": "funding", "formula": "brokered deposits / total deposits"},
    {"key": "uninsured_share",         "label": "Uninsured deposits / deposits", "unit": "pct", "stress_when": "high", "group": "funding", "formula": "estimated uninsured deposits / total deposits"},
    {"key": "cre_loans_k",             "label": "CRE loans ($K)",               "unit": "usd_k", "stress_when": None, "group": "cre", "formula": "construction + multifamily + non-owner-occupied nonfarm nonres loans"},
]
METRIC_KEYS = [m["key"] for m in METRICS]
METRIC_BY_KEY = {m["key"]: m for m in METRICS}
FEATURES = ("qoq", "yoy", "slope")

FLOW_CODES = ["INTINC", "EINTEXP", "EFREPP", "EOTHINT", "NIM", "ELNATR", "NONII", "NONIX", "PTAXNETINC",
              "NETINC", "IGLSEC", "NETGNSLN", "NETGNSRE", "EQCDIV", "NTLNLS", "NTRECONS", "NTREMULT",
              "NTRENRES", "NTRENROT"]


# ── arithmetic helpers (None-propagating) ─────────────────────────────────────

def _add(*xs):
    if any(x is None for x in xs):
        return None
    return float(sum(xs))


def _sub(a, b):
    if a is None or b is None:
        return None
    return float(a) - float(b)


def pct(num, den, floor: float):
    """num / den × 100, or None when den < floor (floor > 0) or either is None."""
    if num is None or den is None or den < floor:
        return None
    return float(num) / float(den) * 100.0


def ratio(num, den, floor: float):
    if num is None or den is None or den < floor:
        return None
    return float(num) / float(den)


def ols_slope(values: list[float]) -> float | None:
    """Slope of an ordinary least-squares line through (0, v0) … (n−1, v_{n−1})."""
    n = len(values)
    if n < 2 or any(v is None for v in values):
        return None
    xm = (n - 1) / 2.0
    ym = sum(values) / n
    sxx = sum((i - xm) ** 2 for i in range(n))
    sxy = sum((i - xm) * (values[i] - ym) for i in range(n))
    return sxy / sxx if sxx else None


# ── quarterly flows ───────────────────────────────────────────────────────────

def quarter_of(repdte: str) -> int:
    return (int(repdte[4:6]) - 1) // 3 + 1


def quarterly_flows(row: dict, prior: dict | None) -> tuple[dict, str, int]:
    """De-cumulate the YTD codes. Returns (flows, source, twin_mismatches)."""
    q = quarter_of(row["REPDTE"])
    flows: dict = {}
    source = "ytd"
    mismatches = 0
    for code in FLOW_CODES:
        ytd = row.get(code)
        if q == 1:
            val = None if ytd is None else float(ytd)
        elif prior is not None and ytd is not None and prior.get(code) is not None:
            val = float(ytd) - float(prior[code])
        else:
            twin = QUARTERLY_TWINS.get(code)
            val = float(row[twin]) if twin and row.get(twin) is not None else None
            if val is not None:
                source = "twin"
        twin = QUARTERLY_TWINS.get(code)
        if twin and val is not None and row.get(twin) is not None and abs(val - float(row[twin])) > 1.0:
            mismatches += 1
        flows[code] = val
    return flows, source, mismatches


# ── level metrics for one bank-quarter ────────────────────────────────────────

def compute_levels(row: dict, flows: dict, avg_assets, cfg: dict) -> dict:
    F = cfg["floors"]

    def ann(x):
        return None if x is None else pct(x * 4.0, avg_assets, 1.0)

    core = _sub(_sub(flows["PTAXNETINC"], flows["NETGNSLN"]), flows["NETGNSRE"])
    revenue = _add(flows["NIM"], flows["NONII"])
    ppnr = _add(flows["PTAXNETINC"], flows["ELNATR"])
    cre_nco = _add(flows["NTRECONS"], flows["NTREMULT"], flows["NTRENROT"])
    cre_loans = _add(row.get("LNRECONS"), row.get("LNREMULT"), row.get("LNRENROT"))
    nclnls = row.get("NCLNLS")
    unreal = _add(_sub(row.get("SCAF"), row.get("SCAA")), _sub(row.get("SCHF"), row.get("SCHA")))

    m = {
        "roa": ann(flows["NETINC"]),
        "pretax_roa": ann(flows["PTAXNETINC"]),
        "core_roa": ann(core),
        "nii_ratio": ann(flows["NIM"]),
        "funding_cost_ratio": pct(flows["EINTEXP"], flows["INTINC"], F["interest_income_k"]),
        "wholesale_funding_share": pct(_add(flows["EFREPP"], flows["EOTHINT"]), flows["EINTEXP"], F["interest_expense_k"]),
        "efficiency_ratio": pct(flows["NONIX"], revenue, F["revenue_k"]),
        "fee_dependence": pct(flows["NONII"], revenue, F["revenue_k"]),
        "provision_ratio": ann(flows["ELNATR"]),
        "provision_coverage": ratio(flows["ELNATR"], flows["NTLNLS"], F["net_chargeoffs_k"]),
        "provision_burden": pct(flows["ELNATR"], ppnr, 1.0),
        "cre_nco_ratio": None if cre_nco is None else pct(cre_nco * 4.0, cre_loans, 1.0),
        "cre_chargeoff_share": pct(cre_nco, flows["NTLNLS"], F["net_chargeoffs_k"]),
        "dividend_payout": None,  # filled by the series pass (TTM)
        "retained_earnings_drag": ann(_sub(flows["NETINC"], flows["EQCDIV"])),
        "noncurrent_ratio": pct(nclnls, row.get("LNLSGR"), 1.0),
        "reserve_coverage": None if nclnls is None else pct(row.get("LNATRES"), max(float(nclnls), float(F["noncurrent_k"])), 1.0),
        "tier1_leverage": None if row.get("RBC1AAJ") is None else float(row["RBC1AAJ"]),
        "loan_to_deposit": pct(row.get("LNLSNET"), row.get("DEP"), 1.0),
        "cre_concentration": pct(cre_loans, row.get("RBCT1J"), F["tier1_capital_k"]),
        "construction_concentration": pct(row.get("LNRECONS"), row.get("RBCT1J"), F["tier1_capital_k"]),
        "unrealized_sec_to_equity": pct(unreal, row.get("EQ"), 1.0),
        "loan_sale_gains_ratio": ann(_add(flows["NETGNSLN"], flows["NETGNSRE"])),
        "brokered_share": pct(row.get("BRO"), row.get("DEP"), 1.0),
        "uninsured_share": pct(row.get("DEPUNINS"), row.get("DEP"), 1.0),
        "cre_loans_k": cre_loans,
    }
    return m


def is_hc_owned(row: dict) -> bool:
    v = row.get("RSSDHCR")
    return v not in (None, "", "0", 0)


def is_merger_quarter(row: dict, prior: dict | None, jump_pct: float) -> bool:
    """Three signals, any one marks the quarter.

    ACTEVT is sticky — the FDIC carries the latest structure-event code on
    every later quarter (verified: 306 of the 344 banks with a code in Q2 2026
    had the same code in Q1) — so only a code that is new this quarter counts.
    EQCMRG is year-to-date like the income lines, so it is de-cumulated first.
    """
    act = row.get("ACTEVT") or None
    if act and prior is not None and (prior.get("ACTEVT") or None) != act:
        return True
    eq = row.get("EQCMRG")
    if eq not in (None, 0, 0.0):
        if quarter_of(row["REPDTE"]) == 1 or prior is None or prior.get("EQCMRG") is None:
            return True
        if abs(float(eq) - float(prior["EQCMRG"])) > 0:
            return True
    if prior is not None and prior.get("ASSET") and row.get("ASSET"):
        if float(row["ASSET"]) / float(prior["ASSET"]) - 1.0 > jump_pct / 100.0:
            return True
    return False


# ── series pass: one bank, all its quarters ───────────────────────────────────

def build_series(rows: list[dict], cfg: dict) -> list[dict]:
    """rows: one bank's raw rows, any order. Returns one output dict per quarter."""
    by_q = {r["REPDTE"]: r for r in rows}
    quarters = sorted(by_q)
    out_by_q: dict[str, dict] = {}

    for repdte in quarters:
        row = by_q[repdte]
        prior = by_q.get(previous_quarter(repdte))
        flows, flow_source, mismatches = quarterly_flows(row, prior)
        if prior is not None and prior.get("ASSET") is not None and row.get("ASSET") is not None:
            avg_assets, avg_src = (float(row["ASSET"]) + float(prior["ASSET"])) / 2.0, "two_point"
        elif row.get("AVASSETJ"):
            avg_assets, avg_src = float(row["AVASSETJ"]), "fdic_avassetj"
        else:
            avg_assets, avg_src = None, "none"
        levels = compute_levels(row, flows, avg_assets, cfg)
        out = {
            "cert": int(row["CERT"]), "repdte": repdte, "name": row.get("NAME"), "state": row.get("STALP"),
            "assets_k": row.get("ASSET"), "rssdhcr": row.get("RSSDHCR"), "hc_name": row.get("NAMEHCR"),
            "hc_owned": 1 if is_hc_owned(row) else 0, "estymd": row.get("ESTYMD"), "cblr": row.get("CBLRIND"),
            "merger_quarter": 1 if is_merger_quarter(row, prior, float(cfg["merger_asset_jump_pct"])) else 0,
            "avg_assets": avg_assets, "avg_assets_source": avg_src, "flow_source": flow_source,
            "twin_mismatches": mismatches,
        }
        for code in FLOW_CODES:
            out[f"q_{code}"] = flows[code]
        out.update(levels)
        out_by_q[repdte] = out

    # trailing-four-quarter dividends / net income (payout), needs four consecutive quarters
    for repdte in quarters:
        window = [repdte]
        for _ in range(3):
            window.append(previous_quarter(window[-1]))
        if all(q in out_by_q for q in window):
            div = [out_by_q[q]["q_EQCDIV"] for q in window]
            ni = [out_by_q[q]["q_NETINC"] for q in window]
            o = out_by_q[repdte]
            o["dividends_ttm_k"] = _add(*div)
            o["netinc_ttm_k"] = _add(*ni)
            if o["hc_owned"] == 0 and o["dividends_ttm_k"] is not None and o["netinc_ttm_k"] is not None and o["netinc_ttm_k"] > 0:
                o["dividend_payout"] = o["dividends_ttm_k"] / o["netinc_ttm_k"] * 100.0
        else:
            out_by_q[repdte]["dividends_ttm_k"] = None
            out_by_q[repdte]["netinc_ttm_k"] = None
        prev_year = previous_quarter(previous_quarter(previous_quarter(previous_quarter(repdte))))
        out_by_q[repdte]["dividends_ttm_prev_k"] = out_by_q[prev_year]["dividends_ttm_k"] if prev_year in out_by_q else None

    # trend features — null when the window spans a merger quarter
    def spans_merger(end: str, back: int) -> bool:
        q = end
        for _ in range(back):
            if q not in out_by_q:
                return True
            if out_by_q[q]["merger_quarter"]:
                return True
            q = previous_quarter(q)
        return False

    for repdte in quarters:
        o = out_by_q[repdte]
        q1 = previous_quarter(repdte)
        q4 = previous_quarter(previous_quarter(previous_quarter(q1)))
        window4 = [repdte, q1, previous_quarter(q1), previous_quarter(previous_quarter(q1))]
        for key in METRIC_KEYS:
            if key == "cre_loans_k":
                continue
            v = o.get(key)
            o[f"{key}__qoq"] = None if (v is None or q1 not in out_by_q or out_by_q[q1].get(key) is None or spans_merger(repdte, 1)) else v - out_by_q[q1][key]
            o[f"{key}__yoy"] = None if (v is None or q4 not in out_by_q or out_by_q[q4].get(key) is None or spans_merger(repdte, 4)) else v - out_by_q[q4][key]
            if all(q in out_by_q and out_by_q[q].get(key) is not None for q in window4) and not spans_merger(repdte, 3):
                o[f"{key}__slope"] = ols_slope([out_by_q[q][key] for q in reversed(window4)])
            else:
                o[f"{key}__slope"] = None
    return [out_by_q[q] for q in quarters]


# ── table build ───────────────────────────────────────────────────────────────

def output_columns() -> list[tuple[str, str]]:
    cols: list[tuple[str, str]] = [
        ("cert", "INTEGER NOT NULL"), ("repdte", "TEXT NOT NULL"), ("name", "TEXT"), ("state", "TEXT"),
        ("assets_k", "REAL"), ("rssdhcr", "TEXT"), ("hc_name", "TEXT"), ("hc_owned", "INTEGER"),
        ("estymd", "INTEGER"), ("cblr", "INTEGER"), ("merger_quarter", "INTEGER"),
        ("avg_assets", "REAL"), ("avg_assets_source", "TEXT"), ("flow_source", "TEXT"), ("twin_mismatches", "INTEGER"),
    ]
    cols += [(f"q_{c}", "REAL") for c in FLOW_CODES]
    cols += [("dividends_ttm_k", "REAL"), ("netinc_ttm_k", "REAL"), ("dividends_ttm_prev_k", "REAL")]
    for key in METRIC_KEYS:
        cols.append((key, "REAL"))
        if key != "cre_loans_k":
            cols += [(f"{key}__{f}", "REAL") for f in FEATURES]
    return cols


def run() -> int:
    cfg = store.load_config()
    conn = store.connect()
    raw = [dict(r) for r in conn.execute("SELECT * FROM fdic_financials_raw ORDER BY CERT, REPDTE")]
    if not raw:
        print("[metrics] no raw rows — run pull first", file=sys.stderr)
        return 2
    by_cert: dict[int, list[dict]] = {}
    for r in raw:
        by_cert.setdefault(int(r["CERT"]), []).append(r)

    cols = output_columns()
    names = [c for c, _ in cols]
    conn.execute("DROP TABLE IF EXISTS bank_metrics_new")
    conn.execute(f"CREATE TABLE bank_metrics_new ({', '.join(f'{c} {t}' for c, t in cols)}, PRIMARY KEY (cert, repdte))")
    total = 0
    mismatch_rows = 0
    twin_rows = 0
    insert = f"INSERT INTO bank_metrics_new ({','.join(names)}) VALUES ({','.join('?' for _ in names)})"
    for cert, rows in by_cert.items():
        series = build_series(rows, cfg)
        conn.executemany(insert, ([o.get(n) for n in names] for o in series))
        total += len(series)
        mismatch_rows += sum(1 for o in series if o["twin_mismatches"])
        twin_rows += sum(1 for o in series if o["flow_source"] == "twin")
    # Swap in one transaction; the index is created after the rename because an
    # index keeps its name across ALTER TABLE … RENAME, so creating it on the
    # staging table would collide with the previous run's.
    conn.executescript(
        "BEGIN; DROP TABLE IF EXISTS bank_metrics; ALTER TABLE bank_metrics_new RENAME TO bank_metrics; "
        "CREATE INDEX IF NOT EXISTS idx_bank_metrics_repdte ON bank_metrics(repdte); COMMIT;"
    )
    conn.commit()
    print(f"[metrics] {total:,} bank-quarters for {len(by_cert):,} banks; de-cumulation vs FDIC quarterly twins: "
          f"{mismatch_rows:,} rows with a >$1K mismatch, {twin_rows:,} rows used the twin (prior quarter missing)")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
