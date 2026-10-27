"""Backtest against FDIC bank failures.

    .venv/bin/python3 -m bank_stress.cli backtest

For every bank in fdic_failures whose last report before failure falls inside
our scored window, look up its composite 4 and 8 quarters before that report
and say where it sat in the whole cohort (composite percentile, 100 = most
stressed) and whether it was in the top decile / quintile.

Read the result for what it is: failures are rare (13 with dates since 2023)
and this score predicts *selling*, not failing. The hit rates are directional.
Results are printed and stored in backtest_results.
"""

from __future__ import annotations

import datetime as dt
import sys
from bisect import bisect_right

from . import db as store
from .pull import previous_quarter, quarter_end


def _parse_faildate(s: str) -> dt.date:
    m, d, y = s.split("/")
    return dt.date(int(y), int(m), int(d))


def last_quarter_on_or_before(date: dt.date) -> str:
    q = (date.month - 1) // 3 + 1
    qe = quarter_end(date.year, q)
    qe_date = dt.date(int(qe[:4]), int(qe[4:6]), int(qe[6:8]))
    # `date` lies inside that quarter, so the quarter has ended only on its last day
    return qe if date >= qe_date else previous_quarter(qe)


def run(lags: tuple[int, ...] = (4, 8)) -> int:
    conn = store.connect()
    scores = [dict(r) for r in conn.execute("SELECT cert, repdte, composite, peer_band, name FROM bank_scores WHERE rank IS NOT NULL")]
    if not scores:
        print("[backtest] no scores — run score first", file=sys.stderr)
        return 2
    by_q: dict[str, list[float]] = {}
    by_cert_q: dict[tuple[int, str], dict] = {}
    for s in scores:
        by_q.setdefault(s["repdte"], []).append(s["composite"])
        by_cert_q[(s["cert"], s["repdte"])] = s
    for q in by_q:
        by_q[q].sort()
    scored_quarters = sorted(by_q)

    failures = [dict(r) for r in conn.execute("SELECT CERT, NAME, FAILDATE, QBFASSET FROM fdic_failures ORDER BY FAILDATE")]
    computed_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    results: list[dict] = []
    for f in failures:
        fd = _parse_faildate(f["FAILDATE"])
        q0 = last_quarter_on_or_before(fd)
        for lag in lags:
            q = q0
            for _ in range(lag):
                q = previous_quarter(q)
            s = by_cert_q.get((int(f["CERT"]), q))
            if s is None:
                note = "quarter not in scored window" if q not in by_q else "bank not scored that quarter"
                results.append({"cert": f["CERT"], "name": f["NAME"], "faildate": f["FAILDATE"], "lag": lag, "repdte": q,
                                "composite": None, "pctile": None, "band": None, "decile": None, "quintile": None, "note": note})
                continue
            cohort = by_q[q]
            pctile = 100.0 * bisect_right(cohort, s["composite"]) / len(cohort)
            results.append({"cert": f["CERT"], "name": f["NAME"], "faildate": f["FAILDATE"], "lag": lag, "repdte": q,
                            "composite": s["composite"], "pctile": round(pctile, 1), "band": s["peer_band"],
                            "decile": 1 if pctile >= 90 else 0, "quintile": 1 if pctile >= 80 else 0, "note": ""})

    conn.execute("DELETE FROM backtest_results")
    conn.executemany(
        "INSERT INTO backtest_results (computed_at, cert, name, faildate, lag_quarters, repdte, composite, composite_pctile, peer_band, in_top_decile, in_top_quintile, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ((computed_at, r["cert"], r["name"], r["faildate"], r["lag"], r["repdte"], r["composite"], r["pctile"], r["band"], r["decile"], r["quintile"], r["note"]) for r in results),
    )
    conn.commit()

    print(f"[backtest] scored window {scored_quarters[0]} → {scored_quarters[-1]}; {len(failures)} failures on file")
    print(f"{'cert':>6} {'name':34s} {'failed':10s} lag  quarter   composite pctile  band")
    for r in results:
        if r["composite"] is None:
            print(f"{r['cert']:>6} {r['name'][:34]:34s} {r['faildate']:10s} {r['lag']:>3}  {r['repdte']}  —  ({r['note']})")
        else:
            print(f"{r['cert']:>6} {r['name'][:34]:34s} {r['faildate']:10s} {r['lag']:>3}  {r['repdte']}  {r['composite']:>7.1f} {r['pctile']:>6.1f}  {r['band']}")
    for lag in lags:
        hits = [r for r in results if r["lag"] == lag and r["composite"] is not None]
        if hits:
            dec = sum(r["decile"] for r in hits)
            qui = sum(r["quintile"] for r in hits)
            print(f"[backtest] {lag} quarters before failure: {len(hits)} scored — top decile {dec}/{len(hits)}, top quintile {qui}/{len(hits)}")
        else:
            print(f"[backtest] {lag} quarters before failure: none inside the scored window (pull more quarters with --quarters)")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(run())
