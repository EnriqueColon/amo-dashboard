"""Balance-sheet behaviour signals (stage 3): what a bank is *doing* about its CRE book.

    .venv/bin/python3 -m bank_stress.cli behavior

Reads fdic_financials_raw, writes bank_behavior — one row per bank-quarter with
the measures, the seven signals (fired / unjudged), the CRE nonaccrual
roll-forward for each category, the balances the drawer charts, and national
percentiles of the six measures that get one.

This is a faithful port of the Market Intelligence tool's
lib/analytics/bank-behavior*.ts (27 Oct 2026), so a bank fires the same way it
did on the page before stage 2. The rules:

  * Every value traces to a named BankFind field; null means "not reported",
    never zero. A signal whose inputs are not all reported is *unjudged*.
  * Signals fire on absolute floors and the bank's own history, never on the
    cohort — the same bank fires the same way in any scope. Percentiles are
    attached as context only.
  * Gross charge-offs (RI-B) are YTD: the quarter's figure is the YTD in Q1 and
    the difference from the prior quarter's YTD otherwise; a gap leaves it null.
  * CRE for balances = construction + multifamily + non-owner-occupied nonfarm
    (the tab definition); the charge-off *rate* uses CRE incl. owner-occupied,
    because the reported quarter nets cover the whole nonfarm line.
  * Thresholds live in config.json under "behavior".
"""

from __future__ import annotations

import json
import sys
from bisect import bisect_left

from . import db as store
from .pull import previous_quarter
from .scoring import band_for

SIGNAL_DEFS: list[dict] = [
    {"key": "hfsTransfer", "label": "HFS transfer", "side": "action", "meaning": "Bank has decided to sell",
     "rule": "Held-for-sale rose by at least {hfsRisePctOfLoans}% of gross loans in the quarter and stands at least {hfsNewLevelMultiple}× the bank's own high of the previous four quarters (so a bank that always runs a mortgage pipeline does not fire every quarter)."},
    {"key": "realizedSale", "label": "Realized sale", "side": "action", "meaning": "A sale closed; a loss is a discount",
     "rule": "Net gains or losses on loan sales were non-zero in the quarter, and either a loss, or the bank reported loan-sale gains in at most one of the previous four quarters (so routine mortgage sellers do not fire)."},
    {"key": "chargeOffSpike", "label": "CRE charge-off spike", "side": "action", "meaning": "Active write-down or clean-up",
     "rule": "Quarterly CRE net charge-offs reached {ncoRateAbsolute}% of CRE loans, or at least {ncoRateFloor}% and {ncoOwnHistoryMultiple}× the bank's own trailing average."},
    {"key": "unexplainedExit", "label": "Unexplained nonaccrual exit", "side": "action", "meaning": "Loans left the books another way: likely a note sale",
     "rule": "CRE nonaccrual fell, and the roll-forward residual — prior nonaccrual plus prior 90+ past due, less current nonaccrual, charge-offs and the OREO increase — is at least {exitSharePct}% of the prior nonaccrual and {exitPctOfCre}% of CRE loans. Cures and payoffs land here too: a flag, not a dollar estimate."},
    {"key": "foreclosureRoute", "label": "Foreclosure route", "side": "action", "meaning": "REO sale candidates coming",
     "rule": "CRE OREO rose by at least {oreoRisePctOfCre}% of CRE loans while CRE nonaccrual fell."},
    {"key": "modificationBuild", "label": "Modification build", "side": "pressure", "meaning": "Extend-and-pretend; losses deferred, not resolved",
     "rule": "CRE modifications to borrowers in financial difficulty rose by at least {modificationRisePctOfCre}% of CRE loans while CRE past-dues (30–89 and 90+) were flat or falling."},
    {"key": "creRunoff", "label": "CRE runoff", "side": "action", "meaning": "Deliberate de-risking",
     "rule": "CRE loans fell by more than {runoffAbs}% in the quarter and more than {runoff4qAbs}% over four quarters, both after adding back net charge-offs (a sustained shrink, not one payoff)."},
]
SIGNAL_KEYS = [s["key"] for s in SIGNAL_DEFS]
ACTION_KEYS = [s["key"] for s in SIGNAL_DEFS if s["side"] == "action"]
PRESSURE_KEYS = [s["key"] for s in SIGNAL_DEFS if s["side"] == "pressure"]
PERCENTILED = ["hfsChangePct", "creNcoRateQ", "unexplainedExitPctOfCre", "oreoCreChangePct", "modificationsCreChangePct", "creRunoffPct"]
CRE_CATEGORY_LABEL = {"construction": "Construction & land", "multifamily": "Multifamily", "nonfarmNonres": "Nonfarm nonresidential", "cre": "All CRE"}


def signal_definitions(cfg: dict) -> list[dict]:
    t = cfg["behavior"]
    fmt = dict(t, exitSharePct=round(t["exitShareOfPriorNonaccrual"] * 100), runoffAbs=abs(t["runoffPct"]), runoff4qAbs=abs(t["runoff4qPct"]))
    return [dict(s, rule=s["rule"].format(**fmt)) for s in SIGNAL_DEFS]


# ── None-propagating arithmetic ─────────────────────────────────────────────

def _n(v):
    return None if v is None else float(v)


def _sum(*xs):
    if any(x is None for x in xs):
        return None
    return float(sum(xs))


def _diff(a, b):
    return None if a is None or b is None else float(a) - float(b)


def _pct(num, den):
    if num is None or den is None or den <= 0:
        return None
    return num / den * 100.0


def _ratio(num, den):
    if num is None or den is None or den <= 0:
        return None
    return num / den


# ── one quarter ─────────────────────────────────────────────────────────────

CATEGORY_FIELDS = {
    "construction": ("na_cons", "pd90_cons", "co_cons_q", "oreo_cons"),
    "multifamily": ("na_mult", "pd90_mult", "co_mult_q", "oreo_mult"),
    "nonfarmNonres": ("na_nres", "pd90_nres", "co_nres_q", "oreo_nres"),
    "cre": ("na_cre", "pd90_cre", "co_cre_q", "oreo_cre"),
}


def quarter_record(r: dict, prior: dict | None) -> dict:
    """Typed quarter from a raw row (prior row for the YTD differencing)."""
    q = {
        "repdte": r["REPDTE"], "assets": _n(r.get("ASSET")), "gross_loans": _n(r.get("LNLSGR")),
        "cons": _n(r.get("LNRECONS")), "mult": _n(r.get("LNREMULT")), "nres": _n(r.get("LNRENRES")),
        "nres_own": _n(r.get("LNRENROW")), "nres_nonown": _n(r.get("LNRENROT")),
        "hfs": _n(r.get("LNLSSALE")), "loan_sale_q": _n(r.get("NTGLLNQ")),
        "nco_cons_q": _n(r.get("NTRECONQ")), "nco_mult_q": _n(r.get("NTREMULQ")), "nco_nres_q": _n(r.get("NTRENRSQ")),
        "oreo_total": _n(r.get("ORE")), "oreo_cons": _n(r.get("ORECONS")), "oreo_mult": _n(r.get("OREMULT")), "oreo_nres": _n(r.get("ORENRES")),
        "pd30_cons": _n(r.get("P3RECONS")), "pd90_cons": _n(r.get("P9RECONS")), "na_cons": _n(r.get("NARECONS")),
        "pd30_mult": _n(r.get("P3REMULT")), "pd90_mult": _n(r.get("P9REMULT")), "na_mult": _n(r.get("NAREMULT")),
        "pd30_nres": _n(r.get("P3RENRES")), "pd90_nres": _n(r.get("P9RENRES")), "na_nres": _n(r.get("NARENRES")),
        "mods_cons": _n(r.get("RSCONS")), "mods_mult": _n(r.get("RSMULT")), "mods_nres": _n(r.get("RSNRES")), "mods_total": _n(r.get("RSLNLTOT")),
    }
    # CRE balance, tab definition; fall back to the whole nonfarm line when the split is not reported
    nonown = q["nres_nonown"] if q["nres_nonown"] is not None else q["nres"]
    q["cre_loans"] = _sum(q["cons"], q["mult"], nonown)
    q["cre_broad"] = _sum(q["cons"], q["mult"], q["nres"])
    q["oreo_cre"] = _sum(q["oreo_cons"], q["oreo_mult"], q["oreo_nres"])
    q["na_cre"] = _sum(q["na_cons"], q["na_mult"], q["na_nres"])
    q["pd30_cre"] = _sum(q["pd30_cons"], q["pd30_mult"], q["pd30_nres"])
    q["pd90_cre"] = _sum(q["pd90_cons"], q["pd90_mult"], q["pd90_nres"])
    q["mods_cre"] = _sum(q["mods_cons"], q["mods_mult"], q["mods_nres"])
    q["nco_cre_q"] = _sum(q["nco_cons_q"], q["nco_mult_q"], q["nco_nres_q"])
    # gross charge-offs for the quarter from the YTD columns
    first = r["REPDTE"][4:6] == "03"
    for key, code in (("co_cons_q", "DRRECONS"), ("co_mult_q", "DRREMULT"), ("co_nres_q", "DRRENRES")):
        ytd = _n(r.get(code))
        if first:
            q[key] = ytd
        elif prior is not None:
            q[key] = _diff(ytd, _n(prior.get(code)))
        else:
            q[key] = None
    q["co_cre_q"] = _sum(q["co_cons_q"], q["co_mult_q"], q["co_nres_q"])
    return q


# ── roll-forward, measures, signals ─────────────────────────────────────────

def rollforward_step(p: dict, q: dict, category: str) -> dict:
    na, pd90, co, oreo = CATEGORY_FIELDS[category]
    prior_na, new_proxy, cur_na, charge = p[na], p[pd90], q[na], q[co]
    oreo_proxy = None if q[oreo] is None or p[oreo] is None else max(0.0, q[oreo] - p[oreo])
    complete = all(v is not None for v in (prior_na, new_proxy, cur_na, charge, oreo_proxy))
    exit_ = prior_na + new_proxy - cur_na - charge - oreo_proxy if complete else None
    return {
        "quarter": q["repdte"], "label": _label(q["repdte"]),
        "priorNonaccrual": prior_na, "newNonaccrualProxy": new_proxy, "currentNonaccrual": cur_na,
        "chargeOffs": charge, "oreoTransferProxy": oreo_proxy, "unexplainedExit": exit_,
        "unexplainedExitPctOfCre": _pct(exit_, q["cre_loans"]),
        "unexplainedExitShareOfPrior": _ratio(exit_, prior_na),
    }


def _label(repdte: str) -> str:
    return f"Q{(int(repdte[4:6]) - 1) // 3 + 1} {repdte[:4]}"


def measures_at(series: list[dict], i: int) -> dict:
    q, p = series[i], series[i - 1]
    trailing = series[max(0, i - 4):i]
    hfs_values = [t["hfs"] for t in trailing if t["hfs"] is not None]
    sales_values = [t["loan_sale_q"] for t in trailing if t["loan_sale_q"] is not None]
    nco_history = [v for v in (_pct(t["nco_cre_q"], t["cre_broad"]) for t in series[:i]) if v is not None]
    step = rollforward_step(p, q, "cre")

    def pd_cre(t):
        return _sum(t["pd30_cre"], t["pd90_cre"])

    nco = q["nco_cre_q"]
    runoff = None
    if q["cre_loans"] is not None and p["cre_loans"] is not None and p["cre_loans"] > 0 and nco is not None:
        runoff = (q["cre_loans"] - p["cre_loans"] + nco) / p["cre_loans"] * 100.0
    runoff4 = None
    if i >= 4:
        base = series[i - 4]
        ncos = [t["nco_cre_q"] for t in series[i - 3:i + 1]]
        if q["cre_loans"] is not None and base["cre_loans"] is not None and base["cre_loans"] > 0 and all(v is not None for v in ncos):
            runoff4 = (q["cre_loans"] - base["cre_loans"] + sum(ncos)) / base["cre_loans"] * 100.0
    return {
        "hfsBalance": q["hfs"],
        "hfsPct": _pct(q["hfs"], q["gross_loans"]),
        "hfsChangePct": None if q["hfs"] is None or p["hfs"] is None else _pct(q["hfs"] - p["hfs"], q["gross_loans"]),
        "hfsTrailingMax": max(hfs_values) if hfs_values else None,
        "loanSaleGainQ": q["loan_sale_q"],
        "priorQuartersWithSales": sum(1 for v in sales_values if v != 0) if sales_values else None,
        "creNcoRateQ": _pct(nco, q["cre_broad"]),
        "creNcoRateTrailingMean": sum(nco_history) / len(nco_history) if len(nco_history) >= 3 else None,
        "unexplainedExit": step["unexplainedExit"],
        "unexplainedExitPctOfCre": step["unexplainedExitPctOfCre"],
        "unexplainedExitShareOfPrior": step["unexplainedExitShareOfPrior"],
        "nonaccrualCreChange": _diff(q["na_cre"], p["na_cre"]),
        "oreoCrePct": _pct(q["oreo_cre"], q["cre_loans"]),
        "oreoCreChangePct": None if q["oreo_cre"] is None or p["oreo_cre"] is None else _pct(q["oreo_cre"] - p["oreo_cre"], q["cre_loans"]),
        "modificationsCrePct": _pct(q["mods_cre"], q["cre_loans"]),
        "modificationsCreChangePct": None if q["mods_cre"] is None or p["mods_cre"] is None else _pct(q["mods_cre"] - p["mods_cre"], q["cre_loans"]),
        "pastDueCreChange": _diff(pd_cre(q), pd_cre(p)),
        "creRunoffPct": runoff,
        "creRunoff4qPct": runoff4,
    }


def judge_signals(m: dict, t: dict) -> dict:
    """{key: (fired, judged)} — the seven rules, verbatim from the source tool."""
    def judged(*keys):
        return all(m[k] is not None for k in keys)

    hfs_j = judged("hfsChangePct", "hfsBalance")
    hfs = hfs_j and m["hfsChangePct"] >= t["hfsRisePctOfLoans"] and (
        m["hfsTrailingMax"] is None or m["hfsTrailingMax"] == 0 or m["hfsBalance"] >= t["hfsNewLevelMultiple"] * m["hfsTrailingMax"])
    sale_j = m["loanSaleGainQ"] is not None
    sale = sale_j and m["loanSaleGainQ"] != 0 and (m["loanSaleGainQ"] < 0 or m["priorQuartersWithSales"] is None or m["priorQuartersWithSales"] <= 1)
    nco_j = m["creNcoRateQ"] is not None
    spike = nco_j and (m["creNcoRateQ"] >= t["ncoRateAbsolute"] or (
        m["creNcoRateQ"] >= t["ncoRateFloor"] and m["creNcoRateTrailingMean"] is not None
        and m["creNcoRateQ"] >= t["ncoOwnHistoryMultiple"] * max(m["creNcoRateTrailingMean"], 0.01)))
    exit_j = judged("unexplainedExit", "unexplainedExitPctOfCre", "nonaccrualCreChange")
    exit_ = exit_j and m["nonaccrualCreChange"] < 0 and m["unexplainedExit"] > 0 and m["unexplainedExitShareOfPrior"] is not None \
        and m["unexplainedExitShareOfPrior"] >= t["exitShareOfPriorNonaccrual"] and m["unexplainedExitPctOfCre"] >= t["exitPctOfCre"]
    oreo_j = judged("oreoCreChangePct", "nonaccrualCreChange")
    oreo = oreo_j and m["oreoCreChangePct"] >= t["oreoRisePctOfCre"] and m["nonaccrualCreChange"] < 0
    mod_j = judged("modificationsCreChangePct", "pastDueCreChange")
    mod = mod_j and m["modificationsCreChangePct"] >= t["modificationRisePctOfCre"] and m["pastDueCreChange"] <= 0
    run_j = judged("creRunoffPct", "creRunoff4qPct")
    run = run_j and m["creRunoffPct"] <= t["runoffPct"] and m["creRunoff4qPct"] <= t["runoff4qPct"]
    return {
        "hfsTransfer": (bool(hfs), hfs_j), "realizedSale": (bool(sale), sale_j), "chargeOffSpike": (bool(spike), nco_j),
        "unexplainedExit": (bool(exit_), exit_j), "foreclosureRoute": (bool(oreo), oreo_j),
        "modificationBuild": (bool(mod), mod_j), "creRunoff": (bool(run), run_j),
    }


def _round(v, dp=3):
    return None if v is None else round(v, 0 if float(v).is_integer() else dp)


# ── build ───────────────────────────────────────────────────────────────────

POINT_COLUMNS = ["gross_loans", "cre_loans", "hfs", "oreo_cre", "oreo_total", "na_cre", "mods_cre", "co_cre_q", "nco_cre_q", "loan_sale_q"]


def build_bank(rows: list[dict], cfg: dict, keep_from: str) -> list[dict]:
    """rows: one bank's raw rows. Returns bank_behavior rows for quarters ≥ keep_from."""
    by_q = {r["REPDTE"]: r for r in rows}
    quarters = sorted(by_q)
    series = []
    for q in quarters:
        prior = by_q.get(previous_quarter(q))
        series.append(quarter_record(by_q[q], prior))
    t = cfg["behavior"]
    out = []
    for i, q in enumerate(series):
        if q["repdte"] < keep_from:
            continue
        rec = {"cert": int(rows[0]["CERT"]), "repdte": q["repdte"], "assets_k": q["assets"],
               "band": band_for(q["assets"], cfg["peer_bands"]), "quarters_available": i + 1}
        for c in POINT_COLUMNS:
            rec[c] = q[c]
        rec["hfs_pct"] = _pct(q["hfs"], q["gross_loans"])
        # a quarter needs its predecessor in the series (not just any earlier quarter)
        if i >= 1 and series[i - 1]["repdte"] == previous_quarter(q["repdte"]):
            m = measures_at(series, i)
            judged = judge_signals(m, t)
            fired = [k for k in SIGNAL_KEYS if judged[k][0]]
            unjudged = [k for k in SIGNAL_KEYS if not judged[k][1]]
            rec.update({
                "judged": 1, "measures_json": json.dumps({k: _round(v) for k, v in m.items()}),
                "fired_json": json.dumps(fired), "unjudged_json": json.dumps(unjudged),
                "action_count": sum(1 for k in fired if k in ACTION_KEYS), "pressure_count": sum(1 for k in fired if k in PRESSURE_KEYS),
                "rollforward_json": json.dumps({cat: rollforward_step(series[i - 1], q, cat) for cat in CATEGORY_FIELDS}),
            })
        else:
            rec.update({"judged": 0, "measures_json": None, "fired_json": "[]", "unjudged_json": json.dumps(SIGNAL_KEYS),
                        "action_count": 0, "pressure_count": 0, "rollforward_json": None})
        rec["percentiles_json"] = None
        out.append(rec)
    return out


COLUMNS = [("cert", "INTEGER NOT NULL"), ("repdte", "TEXT NOT NULL"), ("assets_k", "REAL"), ("band", "TEXT"), ("quarters_available", "INTEGER")] \
    + [(c, "REAL") for c in POINT_COLUMNS] + [("hfs_pct", "REAL"), ("judged", "INTEGER"), ("measures_json", "TEXT"), ("fired_json", "TEXT"),
    ("unjudged_json", "TEXT"), ("action_count", "INTEGER"), ("pressure_count", "INTEGER"), ("rollforward_json", "TEXT"), ("percentiles_json", "TEXT")]


def run() -> int:
    cfg = store.load_config()
    conn = store.connect()
    latest = conn.execute("SELECT MAX(REPDTE) FROM fdic_financials_raw").fetchone()[0]
    if not latest:
        print("[behavior] no raw rows — run pull first", file=sys.stderr)
        return 2
    keep_from = latest
    for _ in range(int(cfg["behavior"].get("quarters", 9)) + 3):  # drawer shows 9; keep a little more for the strip
        keep_from = previous_quarter(keep_from)
    raw = [dict(r) for r in conn.execute("SELECT * FROM fdic_financials_raw ORDER BY CERT, REPDTE")]
    by_cert: dict[int, list[dict]] = {}
    for r in raw:
        by_cert.setdefault(int(r["CERT"]), []).append(r)

    rows: list[dict] = []
    for rs in by_cert.values():
        rows.extend(build_bank(rs, cfg, keep_from))

    # national percentiles of the six measures, among banks judged in the latest quarter
    current = [r for r in rows if r["repdte"] == latest and r["judged"]]
    dist: dict[str, list[float]] = {}
    for key in PERCENTILED:
        vals = sorted(json.loads(r["measures_json"])[key] for r in current if json.loads(r["measures_json"]).get(key) is not None)
        dist[key] = vals
    min_cohort = int(cfg["behavior"]["minCohort"])
    for r in current:
        m = json.loads(r["measures_json"])
        p = {}
        for key in PERCENTILED:
            v, vals = m.get(key), dist[key]
            p[key] = None if v is None or len(vals) < min_cohort else round(100.0 * bisect_left(vals, v) / len(vals), 1)
        r["percentiles_json"] = json.dumps(p)

    names = [c for c, _ in COLUMNS]
    conn.execute("DROP TABLE IF EXISTS bank_behavior_new")
    conn.execute(f"CREATE TABLE bank_behavior_new ({', '.join(f'{c} {t}' for c, t in COLUMNS)}, PRIMARY KEY (cert, repdte))")
    conn.executemany(f"INSERT INTO bank_behavior_new ({','.join(names)}) VALUES ({','.join('?' for _ in names)})", ([r.get(n) for n in names] for r in rows))
    conn.executescript("BEGIN; DROP TABLE IF EXISTS bank_behavior; ALTER TABLE bank_behavior_new RENAME TO bank_behavior; "
                       "CREATE INDEX IF NOT EXISTS idx_bank_behavior_repdte ON bank_behavior(repdte); COMMIT;")
    conn.commit()
    fired_any = sum(1 for r in current if json.loads(r["fired_json"]))
    counts = {k: sum(1 for r in current if k in json.loads(r["fired_json"])) for k in SIGNAL_KEYS}
    print(f"[behavior] {len(rows):,} bank-quarters for {len(by_cert):,} banks from {keep_from}; {latest}: {len(current):,} judged, "
          f"{fired_any:,} fired at least one signal; {counts}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
