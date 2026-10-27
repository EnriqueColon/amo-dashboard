"""Percentiles, sub-scores, composite, flags and tiers.

    .venv/bin/python3 -m bank_stress.cli score

Reads bank_metrics, writes bank_scores and bank_stress_meta.

  * Peer group = asset band (config `peer_bands`) within the same quarter.
  * Each component is a metric level or trend feature, oriented so that a
    HIGHER percentile = MORE stress (metrics.METRICS says which way each points;
    the same sign applies to its changes). Percentile = share of the cohort
    strictly below, 0–100, computed over banks that have the value.
  * Sub-score = mean of the available component percentiles; composite =
    weighted mean of the available sub-scores (weights re-normalized);
    completeness = available components / all components.
  * De novo banks (established < `de_novo_years` before the report date) are
    not in the cohort and get no rank; they are still scored against it.
  * Flags f1–f8 (one point each) and watch flags, thresholds in config.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from bisect import bisect_left

from . import db as store
from .metrics import METRICS, METRIC_BY_KEY
from .pull import previous_quarter

FLAG_DEFS = [
    {"id": "f1", "label": "Weak or falling earnings", "rule": "ROA < 0.5% OR core ROA down ≥ 30% YoY"},
    {"id": "f2", "label": "Net interest income compressing", "rule": "NII / assets down ≥ 25 bp YoY"},
    {"id": "f3", "label": "Funding cost rising", "rule": "funding cost ratio up ≥ 10 points YoY"},
    {"id": "f4", "label": "Inefficient", "rule": "efficiency ratio > 70%"},
    {"id": "f5", "label": "Provisioning behind losses", "rule": "provision coverage < 1.0× for 2+ consecutive quarters OR provision up ≥ 3× QoQ"},
    {"id": "f6", "label": "CRE charge-offs rising", "rule": "CRE net charge-offs rising 2+ consecutive quarters"},
    {"id": "f7", "label": "Dividend strain (standalone banks)", "rule": "TTM payout > 100% OR dividend suspended (TTM dividends from > 0 to 0)"},
    {"id": "f8", "label": "Selling at a loss", "rule": "net loss on loan sales or OREO sales this quarter"},
]
WATCH_DEFS = [
    {"id": "w_cre300",   "label": "CRE > 300% of Tier 1 capital"},
    {"id": "w_constr100", "label": "Construction > 100% of Tier 1 capital"},
    {"id": "w_lev8",     "label": "Tier 1 leverage < 8% (watch)"},
    {"id": "w_lev5",     "label": "Tier 1 leverage < 5%"},
    {"id": "w_nc2",      "label": "Noncurrent loans > 2% of loans"},
    {"id": "w_ltd100",   "label": "Loans > 100% of deposits"},
]


def band_for(assets_k, bands: list[dict]) -> str | None:
    if assets_k is None:
        return None
    for b in bands:
        if b["max_assets_k"] is None or float(assets_k) < float(b["max_assets_k"]):
            return b["key"]
    return bands[-1]["key"]


def component_id(c: dict) -> str:
    return c["metric"] if c["feature"] == "level" else f"{c['metric']}__{c['feature']}"


def component_label(c: dict) -> str:
    base = METRIC_BY_KEY[c["metric"]]["label"]
    return {"level": base, "qoq": f"{base} Δ QoQ", "yoy": f"{base} Δ YoY", "slope": f"{base} 4Q trend"}[c["feature"]]


def stress_sign(metric_key: str) -> int:
    return 1 if METRIC_BY_KEY[metric_key]["stress_when"] == "high" else -1


def stress_value(row: dict, c: dict):
    v = row.get(component_id(c))
    return None if v is None else stress_sign(c["metric"]) * float(v)


def is_de_novo(estymd, repdte: str, years: int) -> bool:
    if not estymd:
        return False
    try:
        est = int(estymd)
    except (TypeError, ValueError):
        return False
    cutoff = int(repdte) - years * 10_000
    return est > cutoff


def percentile(sorted_cohort: list[float], v: float) -> float:
    if not sorted_cohort:
        return 0.0
    return 100.0 * bisect_left(sorted_cohort, v) / len(sorted_cohort)


# ── flags ─────────────────────────────────────────────────────────────────────

def compute_flags(cur: dict, prev: dict | None, prev2: dict | None, cfg: dict) -> tuple[list[str], list[str]]:
    T = cfg["flags"]
    W = T["watch"]
    F = cfg["floors"]
    flags: list[str] = []

    def lt(a, b):
        return a is not None and b is not None and a < b

    def gt(a, b):
        return a is not None and b is not None and a > b

    # f1
    roa = cur.get("roa")
    core, core_yoy = cur.get("core_roa"), cur.get("core_roa__yoy")
    core_prev = None if (core is None or core_yoy is None) else core - core_yoy
    core_drop = core_prev is not None and core_prev > 0 and (core - core_prev) / core_prev * 100.0 <= -float(T["f1_core_roa_yoy_drop_pct"])
    if lt(roa, float(T["f1_roa_below_pct"])) or core_drop:
        flags.append("f1")
    # f2
    if lt(cur.get("nii_ratio__yoy"), -float(T["f2_nii_ratio_yoy_drop_pp"])):
        flags.append("f2")
    # f3
    if gt(cur.get("funding_cost_ratio__yoy"), float(T["f3_funding_cost_yoy_rise_pts"])):
        flags.append("f3")
    # f4
    if gt(cur.get("efficiency_ratio"), float(T["f4_efficiency_above_pct"])):
        flags.append("f4")
    # f5
    cov_now, cov_prev = cur.get("provision_coverage"), (prev or {}).get("provision_coverage")
    low_cov = int(T["f5_consecutive_quarters"]) <= 2 and lt(cov_now, float(T["f5_provision_coverage_below_x"])) and lt(cov_prev, float(T["f5_provision_coverage_below_x"]))
    p_now, p_prev = cur.get("q_ELNATR"), (prev or {}).get("q_ELNATR")
    spike = p_now is not None and p_prev is not None and p_prev >= float(F["provision_prior_k"]) and p_now >= float(T["f5_provision_qoq_multiple"]) * p_prev
    if low_cov or spike:
        flags.append("f5")
    # f6
    def cre_nco(r):
        if r is None:
            return None
        parts = [r.get("q_NTRECONS"), r.get("q_NTREMULT"), r.get("q_NTRENROT")]
        return None if any(p is None for p in parts) else sum(parts)
    n0, n1, n2 = cre_nco(cur), cre_nco(prev), cre_nco(prev2)
    if n0 is not None and n1 is not None and n2 is not None and n0 > n1 > n2 and n0 > 0:
        flags.append("f6")
    # f7 — standalone banks only
    if cur.get("hc_owned") == 0:
        div_ttm, ni_ttm, div_prev = cur.get("dividends_ttm_k"), cur.get("netinc_ttm_k"), cur.get("dividends_ttm_prev_k")
        over = gt(cur.get("dividend_payout"), float(T["f7_payout_above_pct"])) or (div_ttm is not None and ni_ttm is not None and div_ttm > 0 and ni_ttm <= 0)
        suspended = div_ttm is not None and div_prev is not None and div_ttm == 0 and div_prev > 0
        if over or suspended:
            flags.append("f7")
    # f8
    if lt(cur.get("q_NETGNSLN"), 0.0) or lt(cur.get("q_NETGNSRE"), 0.0):
        flags.append("f8")

    watch: list[str] = []
    if gt(cur.get("cre_concentration"), float(W["cre_concentration_above_pct"])):
        watch.append("w_cre300")
    if gt(cur.get("construction_concentration"), float(W["construction_concentration_above_pct"])):
        watch.append("w_constr100")
    lev = cur.get("tier1_leverage")
    if lt(lev, float(W["tier1_leverage_critical_below_pct"])):
        watch.append("w_lev5")
    elif lt(lev, float(W["tier1_leverage_watch_below_pct"])):
        watch.append("w_lev8")
    if gt(cur.get("noncurrent_ratio"), float(W["noncurrent_ratio_above_pct"])):
        watch.append("w_nc2")
    if gt(cur.get("loan_to_deposit"), float(W["loan_to_deposit_above_pct"])):
        watch.append("w_ltd100")
    return flags, watch


def tier_for(flag_count: int, cfg: dict) -> str:
    t = cfg["tiers"]
    if flag_count >= int(t["pressure_min_flags"]):
        return "pressure"
    if flag_count >= int(t["watchlist_min_flags"]):
        return "watchlist"
    return "normal"


# ── scoring one quarter ───────────────────────────────────────────────────────

def score_quarter(rows: list[dict], cfg: dict, by_cert_q: dict) -> list[dict]:
    """rows: bank_metrics rows for one REPDTE. Returns bank_scores rows."""
    bands = cfg["peer_bands"]
    comps = cfg["components"]
    all_components = [(sub, c) for sub, cs in comps.items() for c in cs]
    weights = cfg["weights"]
    years = int(cfg["de_novo_years"])

    for r in rows:
        r["_band"] = band_for(r.get("assets_k"), bands)
        r["_excluded"] = None
        if r["_band"] is None:
            r["_excluded"] = "no_assets"
        elif is_de_novo(r.get("estymd"), r["repdte"], years):
            r["_excluded"] = "de_novo"

    # cohort distributions per band per component
    dist: dict[tuple[str, str], list[float]] = {}
    band_size: dict[str, int] = {}
    for r in rows:
        if r["_excluded"]:
            continue
        band_size[r["_band"]] = band_size.get(r["_band"], 0) + 1
        for _sub, c in all_components:
            v = stress_value(r, c)
            if v is not None:
                dist.setdefault((r["_band"], component_id(c)), []).append(v)
    for k in dist:
        dist[k].sort()
    cohort_size = sum(band_size.values())

    out: list[dict] = []
    for r in rows:
        comp_pct: dict[str, float | None] = {}
        comp_val: dict[str, float | None] = {}
        sub_scores: dict[str, float | None] = {}
        available = 0
        for sub, cs in comps.items():
            pcts = []
            for c in cs:
                cid = component_id(c)
                v = stress_value(r, c)
                comp_val[cid] = r.get(cid)
                if v is None or r["_band"] is None:
                    comp_pct[cid] = None
                    continue
                p = percentile(dist.get((r["_band"], cid), []), v)
                comp_pct[cid] = round(p, 1)
                pcts.append(p)
                available += 1
            sub_scores[sub] = round(sum(pcts) / len(pcts), 1) if pcts else None
        wsum = sum(float(weights[s]) for s, v in sub_scores.items() if v is not None)
        composite = round(sum(float(weights[s]) * v for s, v in sub_scores.items() if v is not None) / wsum, 1) if wsum else None
        completeness = round(100.0 * available / len(all_components), 1)

        prev = by_cert_q.get((r["cert"], previous_quarter(r["repdte"])))
        prev2 = by_cert_q.get((r["cert"], previous_quarter(previous_quarter(r["repdte"]))))
        flags, watch = compute_flags(r, prev, prev2, cfg)
        seller = all(f in flags for f in cfg["cre_seller_signal_flags"])
        drivers = sorted(
            ({"id": cid, "label": component_label(c), "percentile": comp_pct[cid], "value": comp_val[cid]}
             for _s, c in all_components for cid in [component_id(c)] if comp_pct.get(cid) is not None),
            key=lambda d: -d["percentile"],
        )[:3]
        out.append({
            "cert": r["cert"], "repdte": r["repdte"], "name": r.get("name"), "state": r.get("state"),
            "assets_k": r.get("assets_k"), "peer_band": r["_band"], "hc_owned": r.get("hc_owned"),
            "excluded_reason": r["_excluded"],
            "condition": sub_scores.get("condition"), "deterioration": sub_scores.get("deterioration"),
            "cre_exposure": sub_scores.get("cre_exposure"), "composite": composite, "completeness": completeness,
            "rank": None, "rank_in_band": None, "cohort_size": cohort_size, "band_size": band_size.get(r["_band"], 0),
            "flag_count": len(flags), "flags_json": json.dumps(flags), "watch_flags_json": json.dumps(watch),
            "tier": tier_for(len(flags), cfg), "cre_seller_signal": 1 if seller else 0,
            "top_drivers_json": json.dumps(drivers), "components_json": json.dumps(comp_pct),
            "_cre": r.get("cre_concentration") or 0.0,
        })

    ranked = sorted((o for o in out if o["excluded_reason"] is None and o["composite"] is not None),
                    key=lambda o: (-o["composite"], -o["_cre"], o["cert"]))
    per_band: dict[str, int] = {}
    for i, o in enumerate(ranked, start=1):
        o["rank"] = i
        per_band[o["peer_band"]] = per_band.get(o["peer_band"], 0) + 1
        o["rank_in_band"] = per_band[o["peer_band"]]
    for o in out:
        o.pop("_cre", None)
    return out


def definitions(cfg: dict) -> dict:
    from .behavior import CRE_CATEGORY_LABEL, signal_definitions  # local import: behavior imports band_for from here
    return {
        "behavior_signals": signal_definitions(cfg),
        "behavior_thresholds": cfg.get("behavior", {}),
        "cre_category_labels": CRE_CATEGORY_LABEL,
        "metrics": [{k: m[k] for k in ("key", "label", "unit", "stress_when", "group", "formula")} for m in METRICS],
        "components": {sub: [{"id": component_id(c), "label": component_label(c), "metric": c["metric"], "feature": c["feature"]} for c in cs]
                       for sub, cs in cfg["components"].items()},
        "weights": cfg["weights"],
        "flags": FLAG_DEFS,
        "watch_flags": WATCH_DEFS,
        "tiers": cfg["tiers"],
        "cre_seller_signal_flags": cfg["cre_seller_signal_flags"],
        "peer_bands": cfg["peer_bands"],
        "deal_view": cfg["deal_view"],
        "de_novo_years": cfg["de_novo_years"],
    }


def run() -> int:
    cfg = store.load_config()
    conn = store.connect()
    rows = [dict(r) for r in conn.execute("SELECT * FROM bank_metrics ORDER BY repdte, cert")]
    if not rows:
        print("[score] bank_metrics is empty — run metrics first", file=sys.stderr)
        return 2
    by_cert_q = {(r["cert"], r["repdte"]): r for r in rows}
    by_q: dict[str, list[dict]] = {}
    for r in rows:
        by_q.setdefault(r["repdte"], []).append(r)
    quarters = sorted(by_q, reverse=True)
    # Score every quarter whose trend features can be complete (the oldest
    # `trend_warmup_quarters` raw quarters only feed the YoY / slope of later
    # ones). The API shows the newest `history_quarters`; the rest exist for
    # the backtest.
    warmup = int(cfg.get("trend_warmup_quarters", 4))
    keep = quarters[: max(int(cfg["history_quarters"]), len(quarters) - warmup)]

    cols = ["cert", "repdte", "name", "state", "assets_k", "peer_band", "hc_owned", "excluded_reason", "condition",
            "deterioration", "cre_exposure", "composite", "completeness", "rank", "rank_in_band", "cohort_size",
            "band_size", "flag_count", "flags_json", "watch_flags_json", "tier", "cre_seller_signal",
            "top_drivers_json", "components_json"]
    insert = f"INSERT INTO bank_scores ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})"
    all_out: dict[str, list[dict]] = {}
    for q in keep:
        all_out[q] = score_quarter(by_q[q], cfg, by_cert_q)

    computed_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    conn.execute("BEGIN")
    conn.execute("DELETE FROM bank_scores")
    for q, outs in all_out.items():
        conn.executemany(insert, ([o[c] for c in cols] for o in outs))
    latest = keep[0]
    scored = sum(1 for o in all_out[latest] if o["rank"] is not None)
    conn.execute(
        "INSERT INTO bank_stress_meta (computed_at, quarters_json, latest_quarter, config_json, definitions_json, banks_scored, detail) VALUES (?,?,?,?,?,?,?)",
        (computed_at, json.dumps(keep), latest, json.dumps(cfg), json.dumps(definitions(cfg)), scored,
         f"{len(rows):,} bank-quarters in; {sum(len(v) for v in all_out.values()):,} scored rows over {len(keep)} quarters"),
    )
    conn.execute("COMMIT")
    latest_rows = all_out[latest]
    tiers = {}
    for o in latest_rows:
        if o["rank"] is not None:
            tiers[o["tier"]] = tiers.get(o["tier"], 0) + 1
    sellers = sum(1 for o in latest_rows if o["cre_seller_signal"] and o["rank"] is not None)
    excluded = sum(1 for o in latest_rows if o["excluded_reason"])
    print(f"[score] {latest}: {scored:,} banks ranked ({excluded} excluded), tiers {tiers}, CRE seller signal {sellers}; "
          f"quarters kept {keep[-1]} → {keep[0]}; computed_at {computed_at}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
