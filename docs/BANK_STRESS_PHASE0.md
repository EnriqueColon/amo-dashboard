# Bank Stress Ranking — Phase 0 report (27 Oct 2026)

> **Status update, same day:** the owner decided all five questions in §7 (build here; Tier 1
> denominator; owner-occupied excluded; CERT 17281 confirmed; four bands) and additionally to drop the
> Market Intelligence dependency in three stages. **Stage 1 is built and verified locally** — see
> `collector/bank_stress/README.md` for the implementation and SESSION_LOG 27 Oct (later) for results.
> The rest of this document is the exploration as it was reported.

Exploration only. **Nothing was built, no code or data changed.** This answers the four Phase 0
questions of the owner's brief, corrects the parts of the brief that no longer match the repo, and
proposes a plan that cannot disturb anything already in production. Decisions needed are at the end.

## 0. Two premises of the brief that are out of date

1. **"We already have a tool that pulls Call Report data from the FDIC `/financials` endpoint."**
   Not in this repo any more. `server/fdic.ts` and `GET /api/fdic/financials` were removed on
   7 Oct 2026 (`0bcc0b3`); the FDIC Data Analytics page now reads the **Market Intelligence** API
   (`server/market-intelligence.ts`, a Vercel app in `~/Downloads/Market Intelligence 2`). The only
   FDIC call left here is `collector/normalize.py::build_fdic_lookup`, which caches `/institutions`
   names → CERT in `fdic_institution_cache` for entity matching. The FDIC puller lives in the
   Market Intelligence repo (`lib/fdic-config.ts`, `lib/analytics/*`).
2. **"Our Florida county clerk mortgage-assignment collector, which isn't built yet."** It is built
   and is this dashboard: three counties live, 221,492 assignments, `aom_events_clean` with
   seller/buyer per loan transfer. The validation hook in the brief is therefore a join we can make
   now (section 6), not a placeholder.

A third thing the brief does not know: **Market Intelligence shipped a "Seller Likelihood" score to
production on 26 Oct 2026** (four states, backtested against the 13 failures since 2022, ranked list
of 288 banks). It answers the same business question from the bank-*behaviour* side (held-for-sale
transfers, loan-sale losses, OREO, modifications). The brief's ranking is a bank-*condition* composite
with explainable flags. They are complementary, but we should decide where the new one lives before
building (section 7, decision 1).

## 1. How the existing pieces work

### 1.1 Market Intelligence FDIC pull (the puller we have)

- Base `https://api.fdic.gov/banks` (primary) with `https://banks.data.fdic.gov/api` as a fallback
  alias; the old host answers **301** to the new one, `fetch` follows it. `scripts/verify-fdic-hosts.ts`
  checks both. API key optional (`FDIC_API_KEY`, server-only).
- Endpoints `/financials`, `/institutions`, `/failures`, `/history`, `/summary`, `/sod`.
  Explicit field lists in `FDIC_FIELDS.financials` and `FDIC_FIELDS.behavior`; the behaviour list is
  kept separate because the financials list is shared by every pull on that tab.
- Pull shape: one request per scope, `limit` up to 10,000, nine quarters per bank; national =
  40,318 rows / 31 MB / 12.8 s. Computed in a weekly cron on Vercel (`vercel.json`: 05:00 and 05:15
  UTC), stored in Vercel's Data Cache in **asset-band chunks because of a 2 MB per-entry cap**, plus
  `@vercel/postgres` for other tabs. Its `confluence.md` §10 lists the FDIC traps it has hit (percent
  fields are already in percent units; `LNLSSALE` is titled "held for *re*sale"; 4 MB response guard).
- Exposed to this dashboard as `/api/analytics/v1/{meta,screening,visuals,cohort-watch,
  behavior-signals,institution/[cert]}`, proxied here under `/api/mi/*` with a 7-day cache.

### 1.2 This dashboard

- **Server:** Express + `better-sqlite3`, one DB file (`AMO_DB_PATH`, production
  `/opt/amo-dashboard/miami_dade_amo.db`), `server/db.ts::getDb()`. Routes are registered in
  `server/routes.ts::registerRoutes`, which calls per-module registrars at the end
  (`registerMarketIntelligenceRoutes(app)`, `registerChatRoutes(app)`) — the pattern a new module
  follows. Everything sits behind the global `checkAuth`. Responses go through `server/cache.ts`
  (7 days, `POST /api/cache/bust`).
- **Client:** Vite + React + wouter. A page = `client/src/pages/X.tsx` + a `<Route>` in
  `client/src/App.tsx` + a row in `NAV_ITEMS` in `client/src/components/Sidebar.tsx` (groups `main`
  / `analysis` / `data`). Charts are Recharts; the bank drawer
  (`InstitutionProfileDrawer.tsx`, `TREND_PANELS`) already renders eight-quarter small multiples and
  `client/src/lib/peer-metrics.ts` already holds a percentile-with-direction contract guarded by
  `script/check-metric-directions.ts` in `npm run check`.
- **Pipeline:** Python 3 collector scripts under `collector/`, run by droplet cron through
  `run_*.sh` wrappers that source `.env`; `collector/tests/check_*.py` is the test convention
  (plain scripts, no pytest). The venv has `requests` only — **no numpy, pandas or PyYAML** — and
  that is fine for this work (stdlib `statistics.linear_regression`, Python ≥ 3.10; local venv is
  3.13.4, confirm the droplet's).
- **Cron windows already taken (UTC):** 08:30 nightly normalize (+ PM2 restart), 12:30 / 17:30 /
  22:30 Miami-Dade, 12:30 Broward, 13:45 Hillsborough, 16:30 reconcile, Fri 06:00 weekly, Fri 17:00
  review, backups. A weekly FDIC refresh fits at **Sunday 03:00 UTC**.
- **Stack note for the brief:** it prefers Python / FastAPI / PostgreSQL but says to follow the
  repo. The repo is Python + Express + SQLite + React, run 24/7 by cron and PM2 on one droplet.
  Adding FastAPI and PostgreSQL would be a second runtime and a database server to operate; the
  plan below stays on the existing stack.

## 2. Host and transport — confirmed

| Check | Result (27 Oct 2026) |
| --- | --- |
| `https://banks.data.fdic.gov/api/financials?…` | **301** → `https://api.fdic.gov/banks/financials?…` |
| `https://api.fdic.gov/banks/financials?…` | 200, JSON |
| Market Intelligence client | primary is already `api.fdic.gov/banks`; redirect followed |
| Field definitions | `https://api.fdic.gov/banks/docs/risview_properties.yaml` (616 KB, 2,378 properties; needs a browser `User-Agent` or it serves the docs HTML). The `banks.data.fdic.gov/docs/…` copy returns HTML. |
| One request per quarter | `filters=REPDTE:20260630&fields=…&limit=10000` → all **4,313** rows, 3.6 MB, ~4 s. No paging needed (API cap is 10,000). Q3 2024: 4,589; Q1 2023: 4,740. |
| Silent field drop | **Confirmed.** 105 candidate codes asked, 89 returned, the other 16 vanish without error. A post-pull assertion is mandatory, as the brief says. |
| Field completeness across the universe | Every requested field present in all 4,313 Q2 2026 rows (nulls, never absent keys). |

## 3. Field verification (brief's code → verified code)

All dollar fields are **$ thousands**. Income-statement fields are **YTD** unless the code ends in
`Q` (FDIC's own quarterly figure). Balance-sheet and ratio fields are point-in-time. "Verified" means
the code returned a value in a live pull for CERT 17281 at 20260630 **and** appears in the
properties YAML with the title shown.

### Identifiers

| Brief | Verified | FDIC title | Note |
| --- | --- | --- | --- |
| CERT | `CERT` | FDIC Certificate # | |
| NAME | `NAME` | Institution name | |
| REPDTE | `REPDTE` | Report date | `YYYYMMDD` |
| STALP | `STALP` | FIPS state alpha code | |
| ASSET | `ASSET` | Total assets | $K, PIT |
| RSSDHCR / HC name (`/institutions`) | `RSSDHCR`, `NAMEHCR` | RSSD of regulatory top holder; its name | **Available on `/financials` directly** — no `/institutions` join needed. Blank/`0` = no holding company. 83.2 % of banks are HC-owned at Q2 2026. |
| establishment date | `ESTYMD` | Established date | On `/financials` too (`19531204`). 27 banks established after 30 Jun 2023 (de novo < 3 y). |
| — | `ACTEVT`, `EQCMRG` | Activity event code (merger/closing codes); equity change due to mergers | For merger-quarter detection: 344 banks carry an `ACTEVT` (810 ×279, 820 ×51…) and 87 a non-zero `EQCMRG` at Q2 2026. |
| — | `CBLRIND` | Community bank leverage ratio filer | 1,814 of 4,313 banks (42 %). See capital below. |

### Income (YTD $K) and their FDIC quarterly twins

| Brief | Verified YTD | FDIC quarterly | Title | Note |
| --- | --- | --- | --- | --- |
| INTINC | `INTINC` | `INTINQ` | Total interest income | |
| EINTEXP | `EINTEXP` | `EINTXQ` | Total interest expense | `EINTEXP = EDEP + EFREPP + EOTHINT` exactly (CNB: 613,705 + 611 + 156,907 = 771,223). |
| EOTHINT | `EOTHINT` | `EOTHINTQ` | Other interest expense | Interest on borrowings other than deposits and fed funds/repos; `ESUBND` (sub-debt) is inside it. Wholesale share = `(EFREPP + EOTHINT) / EINTEXP` is the cleaner definition. |
| NIM | `NIM` | `NIMQ` | **Net interest income ($)** | Not the margin — the margin % is `NIMY`. |
| ELNATR | `ELNATR` | `ELNATQ` | Provision for credit losses | Can be negative (CNB Q2 2026: −20,999). |
| NONII | `NONII` | `NONIIQ` | Total noninterest income | |
| NONIX | `NONIX` | `NONIXQ` | Total noninterest expense | |
| PTAXNETINC | `PTAXNETINC` | — | Pre-tax net **operating** income | Formula field = `NIM + NONII − NONIX − ELNATR`; **already excludes securities gains** (CNB: 1,531,906 + 407,430 − 1,278,825 − 23,657 = 636,854 ✓). Subtracting `IGLSEC` again for Core ROA would double-count. |
| NETINC | `NETINC` | `NETINCQ` | Net income | |
| IGLSEC | `IGLSEC` | — | Securities gains and losses (realized) | `IGLSCA` / `IGLSCH` split AFS / HTM. |
| NETGNSLN | `NETGNSLN` | `NTGLLNQ` | Net gain/loss on sales of loans | Negative = loss. |
| NETGNSRE | `NETGNSRE` | — | Net gain/loss on other real estate owned | |
| EQCDIV | `EQCDIV` | — | Cash dividends on common & preferred | `EQCDIVNTINC` = FDIC's own payout % (YTD). CNB paid 286 % YTD — RBC-owned, so correctly excluded by the HC rule. |
| NTLNLSCO / NTLNLS | **`NTLNLS`** | `NTLNLSQ` | Total loans & leases net charge-offs | `NTLNLSCO` does not exist. 59 % of banks have YTD net charge-offs under $50K at Q2 2026 → the provision-coverage floor will skip most small banks; apply the floor to the quarterly figure and record it as "not computed", not zero. |
| NTRECONS | `NTRECONS` | `NTRECONQ` | Construction RE net charge-offs | |
| NTREMULT | `NTREMULT` | `NTREMULQ` | Multifamily net charge-offs | |
| NTRENRES | `NTRENRES` | `NTRENRSQ` | Nonfarm nonresidential net charge-offs | `NTRENROT` = non-owner-occupied part, `NTRENROW` owner-occupied. |

**De-cumulation rule verified exactly.** For CNB Q2 2026, `YTD Jun − YTD Mar` equals FDIC's own
`*Q` field for all eight pairs tested (NETINC 296,632; NIM 777,035; NONII 227,374; NONIX 640,998;
INTINC 1,159,897; EINTEXP 382,862; ELNATR −20,999; NTLNLS 6,554). Plan: compute from YTD per the
brief **and assert equality to the `*Q` field** wherever FDIC publishes one — a free correctness check
on every pull.

### Balance sheet and capital (PIT $K unless noted)

| Brief | Verified | FDIC title | Note |
| --- | --- | --- | --- |
| LNLSNET | `LNLSNET` | Loans and leases, net | `LNLSGR` = gross. |
| DEP | `DEP` | Total deposits | |
| EQ | `EQ` | Total equity capital | |
| LNATRES | `LNATRES` | Allowance for loan losses (adjusted) | |
| NCLNLS | `NCLNLS` | Total noncurrent loans & leases | `NCLNLSR` = FDIC's ratio %. |
| CRE noncurrent by category | `NCRECONS`, `NCREMULT`, `NCRENRES` (+ `NCRENROT` non-owner-occ) | | |
| LNRECONS / LNREMULT / LNRENRES | same | Construction & land dev; multifamily; nonfarm nonres | **`LNRENROT`** = non-owner-occupied nonfarm nonres. The interagency 300 % test excludes owner-occupied, so CRE concentration should use `LNRECONS + LNREMULT + LNRENROT` (what Market Intelligence does); the brief's `LNRENRES` would overstate it. Decision 3. |
| RBC1AAJ | `RBC1AAJ` | Leverage ratio (PCA), **%** | All banks report it. |
| total risk-based capital | `RBC` ($), `RBCRWAJ` (%) | Total risk-based capital; its ratio | **CBLR filers (42 % of banks) report `RBC = 0`, `RBCT2 = 0`, `RBCRWAJ = 0`.** Use **Tier 1 capital `RBCT1J`** as the concentration denominator (reported by every bank; it is also what regulators use for CBLR banks), or `RBC` only where > 0. Decision 2. |
| brokered deposits | `BRO` | Brokered deposits | |
| uninsured deposits | `DEPUNINS` | Estimated uninsured deposits (domestic) | `DEPINS` = insured. |
| unrealized securities G/L | **derived:** `SCAF − SCAA` (AFS fair value − amortized cost) and `SCHF − SCHA` (HTM fair value − amortized cost) | | No single "unrealized" field exists; `IGLSCA`/`IGLSCH` are *realized*. CNB Q2 2026: AFS −70,016; HTM −516,871 (vs EQ 11.28 M). |
| — | `ORE`, `LNLSSALE` | OREO balance; loans held for sale | Useful CRE-seller inputs, already used by Market Intelligence. |
| — | `AVASSETJ` | Average assets (PCA) | FDIC's own average; we use the brief's two-point average and can show the difference. |

### Ready-made FDIC ratios kept for cross-checks only

`ROA`, `ROAPTX`, `EEFFR` (efficiency), `LNLSDEPR` (loans/deposits), `NCLNLSR`, `LNATRESR`,
`ELNANTR` (provision/NCO), `NIMY`, `NTLNLSR`, `INTEXPY`, `INTINCY`. All in percent units. They let a
test assert our formula against FDIC's for every bank-quarter.

## 4. Sanity check — CERT 17281 at 30 Jun 2026

CERT 17281 is **City National Bank, Los Angeles (CA), owned by Royal Bank of Canada**
(`RSSDHCR 1232497`, `NAMEHCR ROYAL BANK OF CANADA`). It is not City National Bank of Florida
(CERT 20234). The brief's expected figures were clearly derived from 17281, so the number is right;
confirm it was the intended bank (decision 4).

YTD × 2 / average of Q1 and Q2 total assets (99,947,369 and 99,102,519):

| Line | Computed | Brief expects |
| --- | --- | --- |
| Interest income | 4.63 % | 4.65 % |
| Interest expense | 1.55 % | 1.56 % |
| Net interest income | 3.08 % | 3.09 % |
| Noninterest income | 0.82 % | 0.82 % |
| Noninterest expense | 2.57 % | 2.58 % |
| Provision | 0.05 % | 0.05 % |
| Pre-tax | 1.28 % | 1.28 % |
| Net income | 0.96 % | 0.97 % |
| Net charge-offs | 0.02 % | 0.02 % |
| Dividends | 2.76 % | 2.77 % |
| Efficiency `NONIX/(NIM+NONII)` | 65.9 % (FDIC `EEFFR` 65.81) | ~66 % |
| Funding cost `EINTEXP/INTINC` | 33.5 % | ~34 % |

The 0.01–0.02 pp gaps are the averaging basis (FDIC averages daily/five quarter-ends; `AVASSETJ`
99,577,374 vs our 99,524,944). Holding-company owned → payout (286 % YTD) must not flag it. ✓

## 5. Data facts that shape the design

| Fact | Consequence |
| --- | --- |
| Peer bands at Q2 2026: < $1B **3,246**, $1–10B **902**, $10–100B **133**, > $100B **32** | Percentiles in the top band are 3-point steps. Keep the brief's four bands but show band size on the page (decision 5 offers a merge). |
| Failures with dates: 2023 ×5, 2024 ×2, 2025 ×2, 2026 ×4 (13 since 2023; 8 in 2024–26) | The backtest is directional, not statistical — Market Intelligence reached the same conclusion with the same 13. Report hit rates, do not tune weights to them. |
| 59 % of banks have YTD net charge-offs < $50K at Q2 2026 | Provision coverage is "not computed" for most small banks most quarters; completeness % must reflect it. |
| 42 % are CBLR filers with no total risk-based capital | Decision 2. |
| `ACTEVT` / `EQCMRG` exist | Merger quarters can be flagged from the source, with the 25 % asset-jump rule as the backstop. |
| Universe shrinks ~100 banks a year (4,740 → 4,313 over 13 quarters) | Pull by `REPDTE`, store rows as they were; a bank that disappears keeps its history. |

## 6. Proposed implementation (nothing here touches existing tables, jobs or pages)

**Where:** this repo, following its own patterns. A single new collector package, its **own SQLite
file**, one new server module, one new page. The main database, `normalize.py`, the nightly staging
swap, the backup job, the county-isolation guardrail, the Market Intelligence proxy and the FDIC Data
Analytics page are not modified.

```
collector/bank_stress/
  README.md            every formula, field mapping, threshold and its source
  config.json          weights (40/40/20), flag thresholds, tiers, peer bands, floors, de-novo years,
                       merger jump %, CRE dollar floor, default states (FL + Southeast)
  fdic_fields.py       the field list with title/units/YTD-or-PIT + the post-pull assertion
  pull.py              one request per REPDTE (8 quarters + 1 prior for averages/YoY), limit 10000,
                       explicit fields, /institutions for est. date, /failures; raw rows stored as-is
  metrics.py           de-cumulation (+ equality assert vs *Q fields), annualization, ratios,
                       ΔQoQ / ΔYoY / 4-quarter OLS slope (statistics.linear_regression)
  scoring.py           within-band percentiles oriented stress-high, sub-scores, composite,
                       completeness %, exclusions (de novo, merger quarter, HC payout), flags, tiers,
                       CRE seller signal, top-3 drivers
  backtest.py          /failures → percentile 4 and 8 quarters before failure, top-decile/quintile hit rate
  run_bank_stress.sh   cron wrapper, Sunday 03:00 UTC (sources .env like the others; no new variables)
collector/tests/check_bank_stress.py      the brief's unit tests, repo convention
```

**Tables** in `/opt/amo-dashboard/bank_stress.db` (new file, added to `run_backup.sh`'s list):
`fdic_financials_raw (cert, repdte, … all pulled fields, fetched_at)`, `fdic_institutions`,
`fdic_failures`, `bank_metrics (cert, repdte, each metric, its ΔQoQ/ΔYoY/slope, merger_quarter)`,
`bank_scores (cert, repdte, peer_band, condition, deterioration, cre, composite, completeness, tier,
flags_json, top_drivers_json, cre_seller_signal, excluded_reason)`, `bank_stress_meta (computed_at,
quarters, config_hash)`, and the validation hook `bank_entity_link (cert ↔ canonical_name)` seeded
from the existing `fdic_institution_cache` so scores can be joined to `aom_events_clean` sellers.

**Server:** `server/bank-stress.ts` → `registerBankStressRoutes(app)` called next to
`registerMarketIntelligenceRoutes`. Opens `bank_stress.db` read-only (separate handle, not `getDb()`).
`GET /api/bank-stress/meta`, `GET /api/bank-stress/ranking?quarter&band&state&min_score&cre_only`,
`GET /api/bank-stress/bank/:cert` (8-quarter history, sub-scores, flags, top drivers). Cache keys
include `computed_at`, so a weekly refresh needs **no PM2 restart and no cache bust**.

**Client:** `client/src/pages/BankStress.tsx` ("Bank Stress Ranking", sidebar `analysis` group),
sortable table per the brief, deal-sourcing toggle (CRE ≥ 200 % or CRE $ ≥ floor; state default
FL + Southeast), and a drawer reusing the `TREND_PANELS` chart component from the existing bank drawer.
Metric direction declared once in config and asserted by the Python tests (the TypeScript guardrail
pattern, kept in the language that computes the numbers).

**Commits, one per phase as the brief asks:** data pull → metrics → scoring → flags → API → UI →
tests + backtest. Deploy is the standard `git pull → npm run build → pm2 restart` (≈2 s blip) plus one
crontab line. No new env vars, no `--update-env`, no OpenAI cost, no schema change to the main DB.

**What stays open after this:** Market Intelligence's Seller Likelihood is the behaviour-side twin;
once both exist, showing its state next to our composite in the drawer is a one-field addition to the
existing `/api/mi/institution/:cert` call.

## 7. Decisions needed before building

1. **Where it lives.** (a) **This repo as above — recommended**: keeps the data next to the loan-sale
   evidence for the validation join, no Vercel 2 MB cache limits, no dependence on the other
   session's branch. (b) Inside Market Intelligence next to Seller Likelihood, surfaced here through
   the existing `/api/mi/*` proxy: no second FDIC puller, but the computation would live in the other
   repo and the join to AOM sellers would cross systems.
2. **Capital denominator for CBLR filers (42 % of banks):** Tier 1 capital `RBCT1J` for everyone
   (recommended, one definition) vs total RBC where reported and Tier 1 otherwise.
3. **CRE loan definition:** exclude owner-occupied nonfarm nonres (`LNRENROT`, interagency and
   Market Intelligence convention — recommended) vs the brief's `LNRENRES` including it.
4. **Sanity bank:** confirm CERT 17281 (City National Bank, Los Angeles, RBC-owned) is intended.
5. **Peer bands:** keep four (recommended, as specified; the > $100B band has 32 banks) or merge to
   three (≥ $10B).
