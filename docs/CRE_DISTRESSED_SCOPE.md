# CRE Distressed Debt Signal & Search — Scoping Document

**Status:** draft for review, held 17 Oct 2026 to resume next session · **Written:** 14 Oct 2026 · **No code written**

> Owner's direction so far (14–16 Oct): before building anything new, the existing assignment pipeline had to be made provably complete — that work is done (see SESSION_LOG 14–17 Oct 2026). Four decisions in §9 are still open; the owner answered none of them yet and asked to hold. The first thing in question 1 was deferred with "hold this in the to-do".

---

## 1. Current state of the existing code (as of 14 Oct 2026; counts have since grown)

### 1.1 AMO Dashboard — Florida county clerk pipeline (`amo-dashboard/`)

The most mature asset. Live in production on a DigitalOcean droplet, three counties.

| | Miami-Dade | Broward | Hillsborough |
|---|---|---|---|
| Channel | Playwright UI-intercept on the **logged-in** clerk portal | Public **SFTP** bulk feed | Public **search API** |
| Images | On demand | Same feed, **~10-day retention, unrecoverable after** | On demand |
| Live since | 2026 (original) | 10 Aug 2026 | 13 Oct 2026 |

**Volumes (14 Oct 2026):** 218,093 index rows · 131,230 documents OCR'd and LLM-read · 70,602 normalized loan transfers · 31,123 UCC filings · 455 credit-facility events · 28,120 classified entities.

**Pipeline shape:**

```
collect index → fetch image → tesseract OCR → OpenAI structured extraction
  → normalize.py (canonicalize → classify entity → derive txn_type)
  → SQLite → Express/React dashboard + weekly email + "Ask the Data" chat
```

Already solved and worth keeping: the document classification taxonomy (`LOAN_TRANSFER` / `RENTS_LEASES` / `COLLATERAL` / `OTHER`) with prompt rules hardened against real failure modes; a separate pilot-validated facility-language detector with evidence quotes; entity canonicalization and classification (`BANK / SERVICER / TRUST / GSE / PRIVATE_CREDIT / MERS / OTHER`) with a user-managed alias table whose merges survive every rebuild; transaction typing; executable county-isolation guardrails; and — since 14–16 Oct — daily collection in every county, a per-county reconciliation against each county's own counts with self-repair, and a Friday day-by-day review.

**Gaps relative to a distressed-debt product:**

1. **Ownership-centric, not distress-centric.** It answers "who holds this loan now". No lis pendens, foreclosure docket, default, maturity or receivership.
2. **No loan object.** Everything is per-document. Distressed work needs a loan whose state moves over time.
3. **Property linkage is weak.** Folio captured by the LLM on ~50% of Miami-Dade rows, ~29% Broward, ~31% Hillsborough; no property table.
4. **No CRE/residential distinction.** The corpus is dominated by residential MERS/servicer traffic.
5. **SQLite on one box.** No Postgres, no PostGIS.
6. **Fragility.** Miami-Dade depends on a logged-in portal session driven by browser automation (the clerk changed its login markup on 16 Oct 2026 and every pull failed for three hours); Broward images expire in 10 days.

### 1.2 Market Intelligence — quarterly FDIC monitor (`~/Downloads/Market Intelligence 2`, deployed on Vercel)

Next.js app; the dashboard's "FDIC Data Analytics" page reads it via a versioned contract at `/api/analytics/v1/*`. Pulls FDIC BankFind financials (incl. the CRE call-report buckets `LNRECONS`, `LNREMULT`, `LNRENRES`, past-due, nonaccrual, charge-offs), institutions, failures; national + all 50 states, quarter-keyed. It also contains, already written, a **Python ingestion framework** (`BaseConnector.run(ctx) -> RunResult`, a registry over `configs/connectors.yaml`, `RawEvent` + typed row models, a raw store with migrations) with connectors stubbed for FFIEC, UCC, foreclosure notices and census — the closest existing thing to the adapter pattern wanted. Reuse the shape, not the code. Gaps: bank-level, quarterly, nothing links a bank to the loans it holds; two stale local copies, deployed version ahead of both.

### 1.3 Waterfront properties DB (`~/waterfront_properties`) — reusable for keys and code paths, not coverage

44,685 Miami-Dade parcels (folio PK, address, lat/lng, prop_type — 14,952 "Commercial/Other", 2,980 multifamily — assessed/land/building value, flood zone, owner, last sale) · 181,085 deed-history rows · 1,723 foreclosure complaints synced from a Google Sheet with loan amount/date/rate, maturity, default reason/date, unpaid balance, guarantor, plaintiff attorney · an unpopulated `property_alerts` table built on the **Miami-Dade Clerk "Developers" Official Records API** (keyed; `parameter1=<folio>&parameter2=FN` → every recorded document on that parcel with type, dates, parties, book/page, CFN). Also the MDCPA property-appraiser proxy and the county GIS parcel layers. **Caveat:** it is the waterfront subset only (~45k of ~900k parcels). Only 116 of 1,723 complaints matched to a folio.

### 1.4 `~/Mortgage_Foreclosures_Collector` — discovery only, but holds the gold set

`docs/CRITERIA.md`: a two-stage CRE inclusion rule **validated at 98.70% against 7,061 classified rows** from a Safe Harbor Equity document-processing export (threshold **$500,000**, SBA not an exclusion). `docs/DATA_SPEC.md`: the 40-column target output contract. The labeled workbook itself (gitignored). A ready-made inclusion rule and evaluation set.

### 1.5 Cross-cutting

Three live systems, three stores, three deploy targets, three auth models, no shared property key and no shared entity key.

---

## 2. Phased plan (solo-developer weeks with heavy Claude assist)

- **Phase 0 — Spike, 1 week.** (1) Does the Miami-Dade Clerk Developers API support date-range + doc-type discovery, not just folio lookup? (2) Does the book/page → folio linkage trick (§3.4) work — measure on 500 real assignments. (3) Stand up the Postgres core schema and backfill it from the existing AMO SQLite as adapter #1. (4) Freeze the CRE rule from the Safe Harbor set; cut a 200-document eval set.
- **Phase 1 — Core + Miami-Dade + Broward, 6–8 weeks.** Postgres/PostGIS, FastAPI, adapter framework, Claude extraction service, signal engine, n8n orchestration; adapters for both recorders, both assessors, the recorder-index distress events, and a wrapper on the FDIC service; full parcel tables; loan assembly; the validated CRE filter; search + watchlists + alert feed; eval harness. Out: full court dockets, CMBS/SEC, press, tax delinquency, other counties, other states.
- **Phase 2 — Florida statewide, 4–6 weeks.** Write ~4–5 **platform** adapters (the clerks share a few vendor platforms), add counties as config rows; verify the FL DOR NAL/NAP statewide tax roll as the parcel universe.
- **Phase 3 — National overlays, 4–6 weeks (parallel).** FDIC (built), FFIEC (stubbed), **SEC EDGAR CMBS ABS-EE / 10-D loan tapes** (free, loan-level, national — best value on the list), Fed/Treasury, press via feeds for corroboration only.
- **Phase 4 — Second state, 4 weeks then ~2 each.** Order: national overlays → Texas (non-judicial, non-disclosure) → Georgia (GSCCCA statewide index) → Arizona/Nevada → New York (ACRIS) → Cook County. Precondition: the event taxonomy must absorb a non-judicial procedure profile without a schema change — write Texas's profile as config during Phase 1.

---

## 3. Core data model (outline)

- **Jurisdiction and provenance:** `jurisdictions` (level, state, county_fips, `procedure_profile` jsonb, `parcel_format`, `doc_type_map`), `sources` (kind, channel, `terms_ref` + review date, rate limits), `source_runs`, `raw_documents` (immutable: sha256, storage_uri, raw payload).
- **Documents, properties, entities:** `documents` (instrument/book/page, recorded/executed dates, raw and canonical type, parties, text_uri, OCR quality), `properties` (UUID, `parcel_id_norm`, geom, land use, `property_class`, assessed value), **`property_identifiers`** crosswalk (`folio | apn | address_hash | geocode_h3 | legal_hash | book_page`), `entities` (class), **`entity_identifiers`** (`fdic_cert | lei | cik | state_corp_doc | ein`), `entity_aliases` (human merges persist).
- **Loans, events, extractions, signals:** `loans` (current holder, servicer, amount, maturity, lien position, **status**: performing → watch → default → foreclosure → reo → resolved), **`loan_properties`** (CRE loans are multi-property), `events` (append-only spine, with `superseded_by`), `extractions` (model, `prompt_version`, schema_version, output, cost, review verdict), `signals` (rule_version, `evidence_event_ids[]`), `watchlists` / `alerts` / `alert_deliveries`, `labels` (the eval set as a table).
- **Hardest resolution, within Florida:** borrower SPEs (one LLC per property — *Sunbiz bulk download links SPEs to sponsors; Phase 1*), servicers signing as attorney-in-fact, trust vs trustee, MERS as nominee, clerk indexing errors (the index is not trustworthy; the document wins, under measured guards), OCR corruption. **Across states:** no common sponsor identifier — resolve identifier-first, then blocked name+address, then a persistent human review queue.
- **Property resolution order (the most valuable mechanic):** stated parcel ID → **the referenced mortgage's book/page, which the clerk's own index ties to a folio** → clerk folio→records API in reverse → address geocode → legal-description hash.

---

## 4. Adapter interface

```python
class SourceAdapter(Protocol):
    key: str                      # "fl.miami_dade.recorder"
    jurisdiction: JurisdictionRef
    capabilities: Capabilities    # date_range | by_parcel | by_name | images | bulk | incremental
    def discover(self, window, ctx) -> Iterator[RecordRef]   # index rows only; cheap, resumable
    def fetch(self, ref, ctx) -> RawDocument                  # bytes + metadata; never re-fetches a sha256
    def parse(self, raw) -> ParsedDocument                    # structural only, no LLM
    def normalize(self, parsed) -> list[CanonicalEvent]       # via jurisdiction config
    def health(self) -> HealthReport
```

`RunContext`, a DB-held `Watermark`, provenance on every emitted object, extraction as a core stage (adapters never call the LLM), jurisdiction config in YAML mirrored to the table. **Adding a county = one adapter reference + one config entry.** n8n schedules, retries, fans out, delivers notifications and runs approvals; FastAPI does the work; no parsing logic in n8n nodes.

---

## 5. Event extraction

**v1 event types** — ownership: `mortgage_origination`, `assignment_of_mortgage`, `collateral_assignment`, `assignment_of_rents`, `ucc_filing/amendment/termination`, `satisfaction_release`. Distress: `lis_pendens` (judicial), `notice_of_default` (non-judicial), `foreclosure_complaint_filed`, `final_judgment_of_foreclosure`, `notice_of_sale`, `foreclosure_sale_result`, `deed_in_lieu`, **`receivership_appointed`**, `tax_delinquency`, `tax_certificate_sale`, `bankruptcy_filing`. Derived: `maturity_default`, `maturity_approaching`, `holder_changed`, `servicer_transfer`. Which events can occur is a jurisdiction-profile property; severity weights per jurisdiction.

**Extraction envelope:** `{schema_version, prompt_version, doc_class, doc_class_confidence, fields{…}, evidence:[{field, quote, page}], unresolved[], ocr_quality}`. Policies learned in AMO: one task per prompt; freeze field names once validated; every value carries an evidence quote; null beats a guess; store `prompt_version`; cheap first pass, escalate on low confidence or long documents (cost anchor ≈ $12 per 20,000 documents); the index is not trustworthy, the document wins under measured guards; **output-token cap sized for multi-parcel commercial documents** (a 31-parcel assignment overflowed 1,024 tokens on 15 Oct 2026).

---

## 6. Data sources, ranked (value / effort / risk)

**County:** MD Clerk Developers API (★★★★★, low, low — already keyed; should replace Playwright) · Broward SFTP (★★★★, have) · Hillsborough API (★★★★, have) · assessors + GIS (have for MD) · **MD portal via Playwright (high risk — retire)** · other FL counties via ~4–5 vendor platforms · tax collector delinquency (strong early signal).
**State/federal:** **SEC EDGAR CMBS ABS-EE/10-D** (★★★★★, medium, none) · **FL Sunbiz bulk** (★★★★★, low — the entity-resolution unlock) · **FL DOR NAL/NAP tax roll** (★★★★, verify) · FDIC (done) · FFIEC (stubbed) · Fed H.8/Treasury.
**Courts:** recorder index LP/FC/judgments (Phase 1) · FL civil dockets / e-portal (high value, high effort, ToS review) · PACER bankruptcy.
**Commercial/press:** Trepp / CRED iQ / Morningstar (the comparable product; a buy decision) · ATTOM/RealtyTrac · Bisnow / TRD / Commercial Observer / GlobeSt (corroboration only; copyright) · **CoStar — prohibited.**

---

## 7. Evaluation

Gold set from the Safe Harbor 7,061 rows plus 200 hand-labeled documents per jurisdiction per class. Measure **per field, per jurisdiction**: doc_class ≥0.95 F1, parties ≥0.90, amounts/dates ≥0.95, property link ≥0.85, entity-resolution pairwise precision ≥0.95, alert precision@k ≥0.80 before any external user sees a jurisdiction. **Shadow run + diff before every rule change** (this caught two regressions in the AMO pipeline this week); re-eval on every prompt/model change; guardrail tests as CI; a false-positive reason taxonomy from weekly review.

---

## 8. Risks

1. Scraper fragility and access revocation (Miami-Dade portal login + plaintext credentials; the markup changed 16 Oct) → keyed API, secrets out of the repo.
2. Licensing/ToS → `terms_ref` + review date on every source; nothing goes live without one.
3. Legal review of the *use* (FDCPA, solicitation statutes) → shapes research-tool vs lead-gen.
4. False positives destroy trust → confidence thresholds, evidence quotes with every alert, two-source corroboration for high-severity events.
5. PII at volume → access control, retention, no-train commitment.
6. Adapter maintenance → platform families; health checks mandatory from day one.
7. Model/extraction drift and cost → pin, version, re-eval, cost on a dashboard.
8. Codebase sprawl, key-person risk → consolidate deliberately.

---

## 9. Open questions — the owner's to decide (none answered yet)

1. **Product shape:** loan-level alert feed (principal) vs Bigdata-style search tool vs both, alerts first? *(Owner, 14 Oct: "hold this in the to-do".)*
2. **CRE definition:** the validated Safe Harbor rule (non-homestead residential + commercial > $500k) as the Phase-1 filter, or a different cut?
3. **Existing systems:** new repo with AMO as adapter #1 (recommended), migrate AMO in, or keep all separate?
4. **Licensed data budget:** free/public only, one licensed source (Trepp/CRED iQ/ATTOM), or decide after Phase 0?
5. What tier/licence does the waterfront project's Miami-Dade clerk API key carry, and does it permit bulk date-range harvesting?
6. Who does the legal read on ToS and use-of-data, and by when?

## 10. Recommended first step

Phase 0, one week, four deliverables in this order: clerk API spike (one afternoon) → book/page→folio linkage spike on 500 real assignments (one day) → Postgres core backfilled from the 218k AMO records through the adapter interface (two days) → freeze the CRE rule and cut the eval set (one day). Then scope Phase 1 on measurements, not assumptions.
