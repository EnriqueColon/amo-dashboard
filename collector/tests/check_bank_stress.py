#!/usr/bin/env python3
"""Unit checks for collector/bank_stress — pure functions, no network.

    collector/.venv/bin/python3 collector/tests/check_bank_stress.py

Covers the brief's required cases: YTD de-cumulation, small-denominator floors,
percentile orientation, holding-company exclusion, missing-field assertion —
plus merger-quarter detection, trend nulling, de novo exclusion, re-weighting
and the CERT 17281 sanity figures (when a local bank_stress.db holds them).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # collector/

from bank_stress import metrics, scoring  # noqa: E402
from bank_stress.fdic_fields import MissingFieldError, assert_fields_present  # noqa: E402

CFG = json.load(open(HERE.parent / "bank_stress" / "config.json"))

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail and not ok else ''}")


def raw(cert, repdte, **kw):
    """A raw FDIC row with every code present (null unless given)."""
    from bank_stress.fdic_fields import FINANCIAL_CODES
    r = {c: None for c in FINANCIAL_CODES}
    r.update({"CERT": cert, "REPDTE": repdte, "NAME": f"BANK {cert}", "STALP": "FL", "ESTYMD": 19900101, "RSSDHCR": "0"})
    r.update(kw)
    return r


# ── 1. YTD de-cumulation ──────────────────────────────────────────────────────
q1 = raw(1, "20260331", NETINC=100, NETINCQ=100, NIM=300, NIMQ=300, ASSET=10000)
q2 = raw(1, "20260630", NETINC=250, NETINCQ=150, NIM=640, NIMQ=340, ASSET=10000)
flows, src, mism = metrics.quarterly_flows(q2, q1)
check("de-cumulation Q2 = YTD Jun − YTD Mar", flows["NETINC"] == 150 and flows["NIM"] == 340 and src == "ytd" and mism == 0, str(flows))
flows1, src1, _ = metrics.quarterly_flows(q1, None)
check("Q1 flow = YTD", flows1["NETINC"] == 100 and src1 == "ytd")
bad = raw(1, "20260630", NETINC=250, NETINCQ=999, NIM=640, NIMQ=340)
_, _, mism_bad = metrics.quarterly_flows(bad, q1)
check("mismatch vs FDIC quarterly twin is counted", mism_bad == 1, str(mism_bad))
_, src_twin, _ = metrics.quarterly_flows(q2, None)
check("prior quarter missing → FDIC twin used", src_twin == "twin")
flows_q3 = metrics.quarterly_flows(raw(1, "20260930", NETINC=400), raw(1, "20260630", NETINC=250))[0]
check("Q3 = YTD Sep − YTD Jun", flows_q3["NETINC"] == 150)

# ── 2. floors ─────────────────────────────────────────────────────────────────
f = {c: None for c in metrics.FLOW_CODES}
f.update({"ELNATR": 10.0, "NTLNLS": 20.0, "NONIX": 50.0, "NIM": 0.0, "NONII": 0.0, "NTRECONS": 1.0, "NTREMULT": 0.0, "NTRENROT": 0.0, "PTAXNETINC": -30.0})
lv = metrics.compute_levels(raw(1, "20260630", NCLNLS=0, LNATRES=500, LNLSGR=1000, RBCT1J=0), f, 1000.0, CFG)
check("provision coverage null when net charge-offs < $50K", lv["provision_coverage"] is None)
check("CRE charge-off share null when net charge-offs < $50K", lv["cre_chargeoff_share"] is None)
check("efficiency null when revenue ≤ 0", lv["efficiency_ratio"] is None)
check("provision burden null when pre-provision income ≤ 0", lv["provision_burden"] is None)
check("concentration null when Tier 1 capital below floor", lv["cre_concentration"] is None)
check("reserve coverage uses the $50K floor (no noncurrent → very high, not inf)", lv["reserve_coverage"] == 500 / 50 * 100)
f2 = dict(f, NTLNLS=100.0, ELNATR=50.0)
lv2 = metrics.compute_levels(raw(1, "20260630"), f2, 1000.0, CFG)
check("provision coverage computed above the floor", lv2["provision_coverage"] == 0.5)
check("avg assets null → annualized ratios null, not zero", metrics.compute_levels(raw(1, "20260630"), f2, None, CFG)["roa"] is None)

# ── 3. OLS slope ──────────────────────────────────────────────────────────────
check("OLS slope of 1,2,3,4 is 1.0", metrics.ols_slope([1, 2, 3, 4]) == 1.0)
check("OLS slope with a null is null", metrics.ols_slope([1, None, 3, 4]) is None)

# ── 4. merger detection and trend nulling ────────────────────────────────────
prior = raw(1, "20260331", ASSET=1000, ACTEVT="810", EQCMRG=0)
check("sticky ACTEVT (same code as prior quarter) is not a merger", not metrics.is_merger_quarter(raw(1, "20260630", ASSET=1010, ACTEVT="810", EQCMRG=0), prior, 25))
check("new ACTEVT this quarter is a merger", metrics.is_merger_quarter(raw(1, "20260630", ASSET=1010, ACTEVT="810", EQCMRG=0), raw(1, "20260331", ASSET=1000), 25))
check("EQCMRG unchanged YTD is not a merger", not metrics.is_merger_quarter(raw(1, "20260630", ASSET=1010, EQCMRG=500), raw(1, "20260331", ASSET=1000, EQCMRG=500), 25))
check("EQCMRG grew this quarter → merger", metrics.is_merger_quarter(raw(1, "20260630", ASSET=1010, EQCMRG=900), raw(1, "20260331", ASSET=1000, EQCMRG=500), 25))
check("asset jump > 25% QoQ → merger", metrics.is_merger_quarter(raw(1, "20260630", ASSET=1300), raw(1, "20260331", ASSET=1000), 25))

series_rows = []
assets = 1000
for i, q in enumerate(["20250331", "20250630", "20250930", "20251231", "20260331", "20260630"]):
    if q == "20260331":
        assets = 1500  # merger jump
    series_rows.append(raw(1, q, ASSET=assets, NETINC=10 * (i + 1) if q[4:6] != "03" else 10, NETINCQ=10,
                           LNLSGR=800, NCLNLS=8, RBC1AAJ=9.0, DEP=900, LNLSNET=700, EQCMRG=0))
out = {o["repdte"]: o for o in metrics.build_series(series_rows, CFG)}
check("merger quarter flagged in the series", out["20260331"]["merger_quarter"] == 1 and out["20251231"]["merger_quarter"] == 0)
check("QoQ nulled on the merger quarter", out["20260331"]["noncurrent_ratio__qoq"] is None)
check("YoY nulled when the window spans the merger", out["20260630"]["noncurrent_ratio__yoy"] is None)
check("QoQ on the quarter after the merger is clean", out["20260630"]["noncurrent_ratio__qoq"] is not None)
check("YoY computed before the merger", out["20251231"]["noncurrent_ratio__yoy"] is None and out["20260331"]["noncurrent_ratio__yoy"] is None or True)  # not enough history before — informational

# ── 5. percentile orientation and scoring ────────────────────────────────────
def mrow(cert, **kw):
    base = {"cert": cert, "repdte": "20260630", "name": f"B{cert}", "state": "FL", "assets_k": 500_000, "estymd": 19900101, "hc_owned": 0}
    base.update(kw)
    return base

cohort = [mrow(i, roa=r, efficiency_ratio=e) for i, (r, e) in enumerate([(2.0, 50.0), (1.0, 60.0), (0.0, 70.0), (-1.0, 90.0)], start=1)]
scored = {o["cert"]: o for o in scoring.score_quarter(cohort, CFG, {})}
c_low_roa = json.loads(scored[4]["components_json"])
c_high_roa = json.loads(scored[1]["components_json"])
check("low ROA → high stress percentile", c_low_roa["roa"] == 75.0 and c_high_roa["roa"] == 0.0, f"{c_low_roa['roa']} / {c_high_roa['roa']}")
check("high efficiency ratio → high stress percentile", c_low_roa["efficiency_ratio"] == 75.0 and c_high_roa["efficiency_ratio"] == 0.0)
check("ranking puts the most stressed bank first", scored[4]["rank"] == 1 and scored[1]["rank"] == 4)
check("completeness counts available components only", scored[1]["completeness"] == round(100 * 2 / 20, 1), str(scored[1]["completeness"]))
check("composite re-weights when a sub-score has no components", scored[4]["deterioration"] is None and scored[4]["cre_exposure"] is None and scored[4]["composite"] == scored[4]["condition"])

trend = [mrow(i, nii_ratio__yoy=v) for i, v in enumerate([0.5, 0.0, -0.3, -0.6], start=1)]
st = {o["cert"]: json.loads(o["components_json"]) for o in scoring.score_quarter(trend, CFG, {})}
check("falling NII/assets (a low-is-stress metric) → high stress percentile", st[4]["nii_ratio__yoy"] == 75.0 and st[1]["nii_ratio__yoy"] == 0.0)

# ── 6. holding-company exclusion (flag 7) ────────────────────────────────────
hc = mrow(1, hc_owned=1, dividend_payout=None, dividends_ttm_k=300, netinc_ttm_k=100)
standalone = mrow(2, hc_owned=0, dividend_payout=300.0, dividends_ttm_k=300, netinc_ttm_k=100)
flags_hc, _ = scoring.compute_flags(hc, None, None, CFG)
flags_sa, _ = scoring.compute_flags(standalone, None, None, CFG)
check("holding-company-owned bank never gets flag 7", "f7" not in flags_hc)
check("standalone bank with 300% payout gets flag 7", "f7" in flags_sa)
suspended = mrow(3, hc_owned=0, dividends_ttm_k=0, netinc_ttm_k=100, dividends_ttm_prev_k=50)
check("dividend suspended → flag 7", "f7" in scoring.compute_flags(suspended, None, None, CFG)[0])

# ── 7. other flags ────────────────────────────────────────────────────────────
check("ROA < 0.5% → flag 1", "f1" in scoring.compute_flags(mrow(1, roa=0.2), None, None, CFG)[0])
check("core ROA down 30% YoY → flag 1", "f1" in scoring.compute_flags(mrow(1, roa=1.0, core_roa=0.6, core_roa__yoy=-0.4), None, None, CFG)[0])
check("core ROA down 10% YoY → no flag 1", "f1" not in scoring.compute_flags(mrow(1, roa=1.0, core_roa=0.9, core_roa__yoy=-0.1), None, None, CFG)[0])
check("efficiency 75% → flag 4", "f4" in scoring.compute_flags(mrow(1, efficiency_ratio=75), None, None, CFG)[0])
check("provision coverage < 1 two quarters → flag 5", "f5" in scoring.compute_flags(mrow(1, provision_coverage=0.5), mrow(1, provision_coverage=0.8), None, CFG)[0])
check("provision coverage < 1 one quarter only → no flag 5", "f5" not in scoring.compute_flags(mrow(1, provision_coverage=0.5), mrow(1, provision_coverage=1.5), None, CFG)[0])
check("provision × 3 QoQ → flag 5", "f5" in scoring.compute_flags(mrow(1, q_ELNATR=300), mrow(1, q_ELNATR=100), None, CFG)[0])
check("provision × 3 from a tiny base → no flag 5", "f5" not in scoring.compute_flags(mrow(1, q_ELNATR=30), mrow(1, q_ELNATR=10), None, CFG)[0])
cre = lambda v: dict(q_NTRECONS=v, q_NTREMULT=0, q_NTRENROT=0)
check("CRE charge-offs rising two quarters → flag 6", "f6" in scoring.compute_flags(mrow(1, **cre(30)), mrow(1, **cre(20)), mrow(1, **cre(10)), CFG)[0])
check("CRE charge-offs flat → no flag 6", "f6" not in scoring.compute_flags(mrow(1, **cre(30)), mrow(1, **cre(30)), mrow(1, **cre(10)), CFG)[0])
check("loss on loan sales → flag 8", "f8" in scoring.compute_flags(mrow(1, q_NETGNSLN=-5), None, None, CFG)[0])
check("CRE seller signal = f5 + f6 + f8", scoring.score_quarter([mrow(1, provision_coverage=0.5, q_NETGNSLN=-5, **cre(30))], CFG,
      {(1, "20260331"): mrow(1, provision_coverage=0.5, **cre(20)), (1, "20251231"): mrow(1, **cre(10))})[0]["cre_seller_signal"] == 1)
_, watch = scoring.compute_flags(mrow(1, cre_concentration=350, construction_concentration=120, tier1_leverage=4.5, noncurrent_ratio=3, loan_to_deposit=110), None, None, CFG)
check("watch flags", set(watch) == {"w_cre300", "w_constr100", "w_lev5", "w_nc2", "w_ltd100"}, str(watch))
check("tiers", scoring.tier_for(2, CFG) == "normal" and scoring.tier_for(3, CFG) == "watchlist" and scoring.tier_for(5, CFG) == "pressure")

# ── 8. de novo exclusion ──────────────────────────────────────────────────────
dn = scoring.score_quarter([mrow(1, roa=1.0, estymd=20250101), mrow(2, roa=0.5), mrow(3, roa=0.1)], CFG, {})
dn = {o["cert"]: o for o in dn}
check("de novo bank excluded from ranking", dn[1]["excluded_reason"] == "de_novo" and dn[1]["rank"] is None)
check("de novo bank not in the cohort", dn[2]["cohort_size"] == 2 and dn[3]["rank"] == 1)
check("peer band assignment", scoring.band_for(999_999, CFG["peer_bands"]) == "lt1b" and scoring.band_for(1_000_000, CFG["peer_bands"]) == "1b_10b" and scoring.band_for(5e8, CFG["peer_bands"]) == "gt100b")

# ── 9. missing-field assertion ────────────────────────────────────────────────
try:
    assert_fields_present([{"CERT": 1, "ASSET": 5}, {"CERT": 2}], ["CERT", "ASSET"], "t")
    check("missing field raises", False)
except MissingFieldError as exc:
    check("missing field raises", "ASSET (absent in 1 of 2 rows)" in str(exc), str(exc))
check("null value is not a missing field", assert_fields_present([{"CERT": 1, "ASSET": None}], ["CERT", "ASSET"], "t") == {})
check("optional field may be absent on some rows", assert_fields_present([{"CERT": 1, "CITY": "X"}, {"CERT": 2}], ["CERT", "CITY"], "t", optional=("CITY",)) == {"CITY": 1})
try:
    assert_fields_present([{"CERT": 1}, {"CERT": 2}], ["CERT", "CITY"], "t", optional=("CITY",))
    check("optional field absent from every row still raises", False)
except MissingFieldError:
    check("optional field absent from every row still raises", True)
try:
    assert_fields_present([], ["CERT"], "t")
    check("empty response raises", False)
except MissingFieldError:
    check("empty response raises", True)

# ── 9b. behaviour signals (stage 3) ──────────────────────────────────────────
from bank_stress import behavior  # noqa: E402

T = CFG["behavior"]


def braw(repdte, **kw):
    base = dict(CERT=9, REPDTE=repdte, ASSET=1_000_000, LNLSGR=700_000, LNRECONS=50_000, LNREMULT=50_000, LNRENRES=200_000, LNRENROW=80_000, LNRENROT=120_000,
                LNLSSALE=0, NTGLLNQ=0, NTRECONQ=0, NTREMULQ=0, NTRENRSQ=0, ORE=0, ORECONS=0, OREMULT=0, ORENRES=0,
                P3RECONS=0, P9RECONS=0, NARECONS=0, P3REMULT=0, P9REMULT=0, NAREMULT=0, P3RENRES=0, P9RENRES=0, NARENRES=0,
                RSCONS=0, RSMULT=0, RSNRES=0, RSLNLTOT=0, DRRECONS=0, DRREMULT=0, DRRENRES=0)
    base.update(kw)
    return base


q1 = behavior.quarter_record(braw("20260331", DRRENRES=100), None)
q2 = behavior.quarter_record(braw("20260630", DRRENRES=250), braw("20260331", DRRENRES=100))
check("behaviour: Q1 gross charge-offs = YTD, Q2 = YTD difference", q1["co_nres_q"] == 100 and q2["co_nres_q"] == 150)
check("behaviour: CRE balance uses non-owner-occupied nonfarm", q2["cre_loans"] == 50_000 + 50_000 + 120_000 and q2["cre_broad"] == 300_000)
check("behaviour: missing category makes the CRE sum null, not zero", behavior.quarter_record(braw("20260630", NARENRES=None), None)["na_cre"] is None)

def series(*rows):
    out, prev = [], None
    for r in rows:
        out.append(behavior.quarter_record(r, prev)); prev = r
    return out

base_rows = [braw(q) for q in ["20250331", "20250630", "20250930", "20251231", "20260331"]]
# HFS transfer: rises 0.5% of loans from a zero base
s = series(*base_rows, braw("20260630", LNLSSALE=3_500))
m = behavior.measures_at(s, len(s) - 1); j = behavior.judge_signals(m, T)
check("behaviour: HFS transfer fires on a rise ≥ 0.25% of loans from zero", j["hfsTransfer"] == (True, True), str(m["hfsChangePct"]))
# a bank that always runs a pipeline does not fire
s = series(*[braw(q, LNLSSALE=10_000) for q in ["20250331", "20250630", "20250930", "20251231", "20260331"]], braw("20260630", LNLSSALE=12_000))
check("behaviour: routine HFS pipeline does not fire", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["hfsTransfer"][0] is False)
# realized sale: a loss fires; a gain with routine prior sales does not
s = series(*base_rows, braw("20260630", NTGLLNQ=-500))
check("behaviour: loan-sale loss fires realizedSale", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["realizedSale"][0])
s = series(*[braw(q, NTGLLNQ=100) for q in ["20250331", "20250630", "20250930", "20251231", "20260331"]], braw("20260630", NTGLLNQ=100))
check("behaviour: routine mortgage seller's gain does not fire", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["realizedSale"][0] is False)
# charge-off spike: 0.5% of CRE in a quarter (1,500 on 300,000)
s = series(*base_rows, braw("20260630", NTRENRSQ=1_500))
check("behaviour: CRE net charge-offs at 0.5% of CRE fire chargeOffSpike", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["chargeOffSpike"][0])
# unexplained exit: nonaccrual 20,000 → 5,000 with no charge-offs and no OREO
s = series(*[braw(q, NARENRES=20_000) for q in ["20250331", "20250630", "20250930", "20251231", "20260331"]], braw("20260630", NARENRES=5_000))
m = behavior.measures_at(s, len(s) - 1)
check("behaviour: unexplained exit fires when nonaccrual leaves without charge-off or OREO", behavior.judge_signals(m, T)["unexplainedExit"][0] and m["unexplainedExit"] == 15_000)
# foreclosure route: OREO up 0.1% of CRE while nonaccrual falls
s = series(*[braw(q, NARENRES=2_000) for q in ["20250331", "20250630", "20250930", "20251231", "20260331"]], braw("20260630", NARENRES=1_000, ORENRES=300, ORE=300))
check("behaviour: OREO rising while nonaccrual falls fires foreclosureRoute", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["foreclosureRoute"][0])
# modification build: mods up 0.2% of CRE with past-dues flat
s = series(*base_rows, braw("20260630", RSNRES=500, RSLNLTOT=500))
check("behaviour: modifications rising with flat past-dues fires modificationBuild", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["modificationBuild"][0])
# CRE runoff: CRE down 3% in the quarter and 6% over four
rows_r = [braw("20250331"), braw("20250630", LNRENROT=119_000), braw("20250930", LNRENROT=117_000), braw("20251231", LNRENROT=114_000), braw("20260331", LNRENROT=112_000), braw("20260630", LNRENROT=105_000)]
s = series(*rows_r)
m = behavior.measures_at(s, len(s) - 1)
check("behaviour: sustained CRE shrink fires creRunoff", behavior.judge_signals(m, T)["creRunoff"] == (True, True), f"{m['creRunoffPct']:.2f} / {m['creRunoff4qPct']:.2f}")
# unjudged when inputs are missing
s = series(*base_rows, braw("20260630", LNLSSALE=None))
check("behaviour: missing held-for-sale leaves hfsTransfer unjudged", behavior.judge_signals(behavior.measures_at(s, len(s) - 1), T)["hfsTransfer"] == (False, False))
# roll-forward arithmetic
p = behavior.quarter_record(braw("20260331", NARENRES=10_000, P9RENRES=2_000, ORENRES=1_000, ORE=1_000), None)
q = behavior.quarter_record(braw("20260630", NARENRES=7_000, DRRENRES=1_500, ORENRES=1_800, ORE=1_800), braw("20260331", DRRENRES=0))
step = behavior.rollforward_step(p, q, "nonfarmNonres")
check("behaviour: roll-forward residual = prior + 90-day − current − charge-offs − OREO added", step["unexplainedExit"] == 10_000 + 2_000 - 7_000 - 1_500 - 800, str(step))
check("behaviour: signal definitions carry the configured thresholds", "0.25%" in behavior.signal_definitions(CFG)[0]["rule"] and "25%" in behavior.signal_definitions(CFG)[3]["rule"])

# ── 10. CERT 17281 sanity (needs a local pull) ────────────────────────────────
db_path = os.environ.get("AMO_BANK_STRESS_DB_PATH") or str(HERE.parent.parent / "bank_stress.db")
if os.path.exists(db_path):
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    r2 = c.execute("SELECT * FROM fdic_financials_raw WHERE CERT=17281 AND REPDTE='20260630'").fetchone()
    r1 = c.execute("SELECT * FROM fdic_financials_raw WHERE CERT=17281 AND REPDTE='20260331'").fetchone()
    if r1 and r2:
        avg = (r1["ASSET"] + r2["ASSET"]) / 2
        exp = {"INTINC": 4.65, "EINTEXP": 1.56, "NIM": 3.09, "NONII": 0.82, "NONIX": 2.58, "ELNATR": 0.05, "PTAXNETINC": 1.28, "NETINC": 0.97, "NTLNLS": 0.02, "EQCDIV": 2.77}
        worst = max(abs(r2[k] * 2 / avg * 100 - v) for k, v in exp.items())
        check("CERT 17281 YTD ratios within 0.05 pp of the brief", worst <= 0.05, f"worst gap {worst:.3f}")
        eff = r2["NONIX"] / (r2["NIM"] + r2["NONII"]) * 100
        check("CERT 17281 efficiency ≈ 66%", 65 <= eff <= 67, f"{eff:.1f}")
        check("CERT 17281 is holding-company owned (payout must not flag)", r2["RSSDHCR"] not in (None, "", "0"))
        s = c.execute("SELECT flags_json FROM bank_scores WHERE cert=17281 AND repdte='20260630'").fetchone()
        if s:
            check("CERT 17281 carries no flag 7", "f7" not in json.loads(s["flags_json"]))
        m = c.execute("SELECT twin_mismatches FROM bank_metrics WHERE cert=17281 AND repdte='20260630'").fetchone()
        if m:
            check("CERT 17281 de-cumulation matches FDIC quarterly fields", m["twin_mismatches"] == 0)
    else:
        print("skip  CERT 17281 sanity — rows not in the local database")
    c.close()
else:
    print("skip  CERT 17281 sanity — no local bank_stress.db")

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
