# Bank Stress Ranking — pipeline reference

Which banks are under enough earnings, credit and commercial-real-estate pressure that they are
likely to sell distressed CRE loans. Built from FDIC Call Reports, pulled directly from the FDIC
BankFind API, scored within asset-size peer groups, with rule flags for explainability.

    cd collector
    .venv/bin/python3 -m bank_stress.cli all        # pull → metrics → score → backtest → link
    .venv/bin/python3 ../collector/tests/check_bank_stress.py

Cron: `collector/run_bank_stress.sh`, Sunday 03:00 UTC. Output: **`bank_stress.db`** (its own
SQLite file; `AMO_BANK_STRESS_DB_PATH`, else next to `AMO_DB_PATH`, else the repo root). The
package never writes to `miami_dade_amo.db`. The server (`server/bank-stress.ts`) opens the file
read-only and keys its cache on `bank_stress_meta.computed_at`, so a new run is live without a
restart.

Tunables are in **`config.json`** (weights, thresholds, bands, floors), never in code.

## 1. Data pull (`pull.py`, `fdic_fields.py`)

- Host `https://api.fdic.gov/banks` (the old `banks.data.fdic.gov` answers 301 to it). No key.
- `/financials`: **one request per quarter**, `filters=REPDTE:YYYYMMDD`, explicit `fields=`,
  `limit=10000` (the API maximum; the universe is ~4,300 so one page), offset paging as a fallback,
  row count asserted equal to the API's `meta.total`. 20 quarters by default (`raw_quarters`).
- The latest quarter is discovered by probing quarter-ends backwards until one holds ≥ 1,000 banks.
- **The API silently drops unknown field names.** `assert_fields_present` checks every requested
  code is a key on every row (null values are fine, absent keys are not) and raises
  `MissingFieldError` → exit 2, nothing stored for that quarter. On `/institutions` the descriptor
  fields may be absent on individual rows (the API omits the key for a bank that has not filed yet);
  a field absent from every row is still fatal.
- `/institutions` (`ACTIVE:1`) for city / class / active flag; `/failures` since the year before the
  window for the backtest. Raw rows are stored as received (`fdic_financials_raw`, one column per
  code, `INSERT OR REPLACE` on `(CERT, REPDTE)` so restatements overwrite). `pull_log` records every
  request.

### Field map (verified 27 Oct 2026 against a live pull of CERT 17281 and the FDIC properties file)

| Concept | Code | Basis | Note |
| --- | --- | --- | --- |
| Identifiers | `CERT NAME REPDTE STALP` | id | |
| Holding company | `RSSDHCR` (id), `NAMEHCR` | id | on `/financials`; blank/`0` = standalone. 83% of banks are HC-owned |
| Established | `ESTYMD` | id | `YYYYMMDD` on `/financials` |
| CBLR filer | `CBLRIND` | id | 1 = reports no risk-based capital (42% of banks) |
| Structure event | `ACTEVT` | id | **sticky**: carried on every later quarter; only a *new* code marks a merger quarter |
| Equity change from mergers | `EQCMRG` | YTD | de-cumulated like the income lines |
| Total assets / FDIC average | `ASSET` / `AVASSETJ` | PIT | |
| Loans net / gross | `LNLSNET` / `LNLSGR` | PIT | |
| Deposits, equity | `DEP`, `EQ` | PIT | |
| Allowance | `LNATRES` | PIT | |
| Noncurrent loans | `NCLNLS`; CRE: `NCRECONS NCREMULT NCRENRES NCRENROT` | PIT | `NCRENROT` = non-owner-occupied nonfarm nonres |
| CRE loans | `LNRECONS LNREMULT LNRENRES LNRENROT`, `LNRE` | PIT | **CRE = `LNRECONS + LNREMULT + LNRENROT`** (owner-occupied excluded, interagency definition) |
| Capital | `RBC1AAJ` (Tier 1 leverage %), `RBCT1J` (Tier 1 $), `RBC` `RBCT2` `RBCRWAJ` | PIT / ratio | CBLR filers report `RBC = RBCT2 = RBCRWAJ = 0`, so **Tier 1 capital `RBCT1J` is the concentration denominator for every bank** |
| Deposits detail | `BRO` (brokered), `DEPUNINS` / `DEPINS` (est. uninsured / insured) | PIT | |
| Securities | `SCAF` `SCAA` (AFS fair / amortized), `SCHF` `SCHA` (HTM fair / amortized) | PIT | unrealized G/L = `(SCAF−SCAA) + (SCHF−SCHA)`; `IGLSCA/IGLSCH` are *realized* and not used |
| OREO, held for sale | `ORE`, `LNLSSALE` | PIT | stored for later use |
| Interest income / expense | `INTINC`; `EINTEXP = EDEP + EFREPP + EOTHINT` (exact) | YTD | `EOTHINT` = other borrowings incl. sub-debt |
| Net interest income | `NIM` ($ — the margin % is `NIMY`) | YTD | |
| Provision | `ELNATR` | YTD | can be negative (release) |
| Noninterest income / expense | `NONII` / `NONIX` | YTD | |
| Pre-tax net operating income | `PTAXNETINC` = `NIM + NONII − NONIX − ELNATR` | YTD | **already excludes securities gains** |
| Net income | `NETINC` | YTD | |
| Realized securities G/L | `IGLSEC` | YTD | |
| Gains on loan sales / OREO sales | `NETGNSLN` / `NETGNSRE` | YTD | negative = loss |
| Dividends | `EQCDIV` | YTD | |
| Net charge-offs | `NTLNLS`; CRE: `NTRECONS NTREMULT NTRENRES NTRENROT` | YTD | brief's `NTLNLSCO` does not exist |
| FDIC quarterly twins | `INTINQ EINTXQ EOTHINTQ NIMQ ELNATQ NONIIQ NONIXQ NETINCQ NTLNLSQ NTGLLNQ NTRECONQ NTREMULQ NTRENRSQ` | qtr | cross-check only |
| FDIC ratios | `ROA ROAPTX EEFFR LNLSDEPR NCLNLSR LNATRESR ELNANTR NIMY NTLNLSR` | ratio (%) | cross-check only |

All dollar fields are **$ thousands**. Percent-type FDIC fields are already in percent units.

## 2. Metrics (`metrics.py`)

**Quarterly flows.** Income-statement codes are YTD. Q1 = YTD; Q2–Q4 = YTD(t) − YTD(t−1).
Verified exact against the FDIC's own quarterly fields on every tested bank; disagreements are
counted per row in `twin_mismatches` (all of them are merger quarters, where the FDIC's quarterly
figure is for the merged entity). When the prior quarter is missing the FDIC twin is used
(`flow_source = 'twin'`).

**Annualized ratio** = flow × 4 / average assets × 100, average assets = mean of `ASSET` at t and
t−1 (`AVASSETJ` if t−1 is missing). Balance-sheet items are point-in-time.

**Floors** (`config.floors`): a denominator below the floor makes the ratio **null**, never 0 or ∞.

| Metric | Formula | Stress when |
| --- | --- | --- |
| `roa` | NETINC × 4 / avg assets | low |
| `pretax_roa` | PTAXNETINC × 4 / avg assets | low |
| `core_roa` | (PTAXNETINC − NETGNSLN − NETGNSRE) × 4 / avg assets | low |
| `nii_ratio` | NIM × 4 / avg assets | low |
| `funding_cost_ratio` | EINTEXP / INTINC | high |
| `wholesale_funding_share` | (EFREPP + EOTHINT) / EINTEXP | high |
| `efficiency_ratio` | NONIX / (NIM + NONII) | high |
| `fee_dependence` | NONII / (NIM + NONII) | — |
| `provision_ratio` | ELNATR × 4 / avg assets | high |
| `provision_coverage` (×) | ELNATR / NTLNLS, null if quarterly NTLNLS < $50K | low |
| `provision_burden` | ELNATR / (PTAXNETINC + ELNATR), null if ≤ 0 | high |
| `cre_nco_ratio` | (NTRECONS + NTREMULT + NTRENROT) × 4 / CRE loans | high |
| `cre_chargeoff_share` | CRE net charge-offs / NTLNLS, null if NTLNLS < $50K | high |
| `dividend_payout` | TTM EQCDIV / TTM NETINC; **null for HC-owned banks** and when TTM net income ≤ 0 | high |
| `retained_earnings_drag` | (NETINC − EQCDIV) × 4 / avg assets | low |
| `noncurrent_ratio` | NCLNLS / LNLSGR | high |
| `reserve_coverage` | LNATRES / max(NCLNLS, $50K) | low |
| `tier1_leverage` | RBC1AAJ | low |
| `loan_to_deposit` | LNLSNET / DEP | high |
| `cre_concentration` | (LNRECONS + LNREMULT + LNRENROT) / RBCT1J | high |
| `construction_concentration` | LNRECONS / RBCT1J | high |
| `unrealized_sec_to_equity` | ((SCAF − SCAA) + (SCHF − SCHA)) / EQ | low |
| `loan_sale_gains_ratio` | (NETGNSLN + NETGNSRE) × 4 / avg assets (negative = losses) | low |
| `brokered_share`, `uninsured_share` | BRO / DEP, DEPUNINS / DEP | high |
| `cre_loans_k` | LNRECONS + LNREMULT + LNRENROT ($K) | — |

Dividend payout is trailing-four-quarter rather than single-quarter because many banks pay once a
year; a quarterly ratio would flag every annual payer once a year.

**Trend features** per metric: `__qoq` (t − t−1), `__yoy` (t − t−4), `__slope` (OLS slope over
t−3…t, per quarter). A feature is null when any quarter the change spans is a **merger quarter**:
a *new* `ACTEVT` code, a non-zero quarterly `EQCMRG`, or assets up > 25% QoQ.

## 3. Scoring (`scoring.py`)

- **Peer group** = asset band (`< $1B`, `$1–10B`, `$10–100B`, `> $100B`) within the quarter. Q2 2026:
  3,246 / 902 / 133 / 32 banks.
- **Component percentile** = share of the band strictly below the bank, 0–100, after orienting the
  value so that higher = more stress (`stress_when` above; the same sign applies to changes). Only
  banks with the value form the distribution.
- **Sub-scores** (mean of available component percentiles):
  - Condition 40%: roa, core_roa, efficiency_ratio, noncurrent_ratio, reserve_coverage, tier1_leverage, loan_to_deposit
  - Deterioration 40%: YoY and 4Q slope of nii_ratio, funding_cost_ratio, provision_ratio, cre_nco_ratio, noncurrent_ratio
  - CRE exposure 20%: cre_concentration, cre_chargeoff_share, loan_sale_gains_ratio
- **Composite** = weighted mean of the available sub-scores (weights re-normalized).
  **Completeness** = available components / 20. Nothing is imputed.
- **Excluded from the cohort and unranked** (still scored for display): de novo banks
  (established < 3 years before the report date), banks with no asset figure.
- **Rank** = composite desc, ties by CRE concentration; `rank_in_band` likewise within the band.
- **Top drivers** = the three components with the highest percentiles.
- Every quarter with full trend history is scored (raw quarters minus 4 warm-up); the API shows the
  newest 8, the rest serve the backtest.

### Flags (one point each; thresholds in `config.flags`)

| | Rule |
| --- | --- |
| f1 | ROA < 0.5% OR core ROA down ≥ 30% YoY (prior-year core ROA > 0) |
| f2 | nii_ratio down ≥ 0.25 pp YoY |
| f3 | funding_cost_ratio up ≥ 10 points YoY |
| f4 | efficiency_ratio > 70% |
| f5 | provision_coverage < 1.0× this quarter and last, OR quarterly provision ≥ 3 × prior quarter (prior ≥ $50K) |
| f6 | quarterly CRE net charge-offs rising two consecutive quarters and > 0 |
| f7 | standalone banks only: TTM payout > 100% (or dividends paid on a TTM loss) OR TTM dividends fell from > 0 to 0 |
| f8 | NETGNSLN < 0 or NETGNSRE < 0 this quarter |

Tiers: 0–2 normal, 3–4 watchlist, 5+ likely pressure. **CRE seller signal** = f5 + f6 + f8.
Watch flags (shown, not counted): CRE > 300% of Tier 1, construction > 100%, Tier 1 leverage < 8%
(watch) / < 5%, noncurrent > 2%, loans > 100% of deposits.

## 4. Backtest (`backtest.py`)

For each failure in `fdic_failures`, the bank's composite 4 and 8 quarters before its last report,
its percentile in the whole scored cohort that quarter, and whether it sat in the top decile /
quintile. Failures are rare (13 with dates since 2023) and this score predicts selling, not failing —
read the hit rates as directional. First run, 27 Oct 2026, 16 scored quarters: 4 quarters before
failure 4 of 9 in the top decile; 8 quarters before, 2 of 7 in the top decile and 4 of 7 in the top
quintile.

## 5. Validation hook

`bank_entity_link (cert, canonical_name)` is seeded from the AOM database's `fdic_institution_cache`
by `cli.py link` (read-only). Join `bank_scores` → `bank_entity_link` → `aom_events_clean.assignor_canon`
to compare scores with observed loan sales in the county records.

## 6. Tables

`fdic_financials_raw`, `fdic_institutions`, `fdic_failures`, `pull_log` (raw layer);
`bank_metrics` (one row per bank-quarter: flows, metrics, trend features, merger flag);
`bank_scores` (sub-scores, composite, rank, flags, tier, drivers, component percentiles);
`bank_stress_meta` (compute timestamp, quarters, config and definitions as JSON);
`backtest_results`; `bank_entity_link`.

## 7. Sanity anchor

CERT 17281 (City National Bank, Los Angeles, owned by Royal Bank of Canada), 30 Jun 2026, YTD × 2 /
average assets: interest income 4.63%, interest expense 1.55%, NII 3.08%, noninterest income 0.82%,
noninterest expense 2.57%, provision 0.05%, pre-tax 1.28%, net income 0.96%, net charge-offs 0.02%,
dividends 2.76% — within 0.02 pp of the brief; efficiency 65.9%, funding cost 33.5%; HC-owned so flag
7 is never applied. `tests/check_bank_stress.py` re-checks this whenever a local pull exists.
