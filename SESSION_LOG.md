# AMO Dashboard — Session Log

Read this at the start of a session before re-deriving context. Most recent entry first. Keep entries dense (facts, not narrative) — this file exists to cut future token spend, so prune/compact old entries rather than letting it grow unbounded.

---

## 2026-07-15 — Warehouse/credit-facility extraction: research → pilot → integrated (DONE)

**Outcome:** built and integrated real facility-detection into `collector/extract_pdfs.py` + `normalize.py`. See below for the full arc; this supersedes the "in progress" entry that follows.

**Key finding:** literal "warehouse line of credit" wording essentially never appears in Miami-Dade recorded documents. Real language varies every time — "Warehousing Loan and Security Agreement", "(Warehouse Agreement)" (a bare parenthetical), "Credit Agreement" + "as Agent for the Lenders", UCC "as Administrative Agent" chains — so keyword search fails. Confirmed via a user-supplied real example (`Collateral Assignment of Mortgage`, CFN `2024R432043`, BGI Financial LLC / City National Bank of Florida) which led to finding **13 related documents** for that one relationship (1 "Collateral Assignment of Mortgage", 9 "Quit-Claim Release and Reassignment of Mortgage", 3 "Partial Re-Assignment of Mortgage and Loan Documents" — title alone isn't a reliable filter either), plus a second relationship (Bradesco Bank / Eastern Financial Mortgage Corp, 2 documents, same pattern).

**Pilot (189 documents, `collector/research/scripts/extract_facility_pilot_v3.py`):** iterated a dedicated LLM extraction prompt to 10/13 on the known-positive cluster, 0/6 known-negatives, 0/135 false positives on a random baseline. Repeated-entity-pair heuristic (same grantor/grantee recurring 5+ times) has poor precision on its own (1 real hit out of 7 tested candidates) — real integration scans every document, doesn't gate on that heuristic. LLM cost is trivial: ~$0.00024/doc measured → ~$12-15 for the full ~51,700-doc corpus.

**Integration done this session (`extract_pdfs.py`, `batch_extract_facility.py`, `normalize.py`):**
- **Critical lesson learned:** first attempt merged facility detection into the existing `doc_category` LLM call (one call, more fields) — this **completely broke detection** (0/13 known-positives, previously 10/13 standalone). Root cause: dropped the `has_facility_language` boolean field and renamed JSON keys when integrating, an untested deviation from the pilot's exact validated prompt. **Facility detection is now a second, fully separate LLM call** (`llm_extract_facility()` / `FACILITY_SYSTEM_PROMPT` in `extract_pdfs.py`) using the *exact* verbatim pilot prompt/field names — renaming into our `facility_*`-prefixed DB columns happens only in `postprocess_facility()`, in code, never by asking the model for different names. **Do not merge these two calls or edit `FACILITY_SYSTEM_PROMPT`'s field names without re-running `collector/research/scripts/verify_integration.py` against the known-labeled CFNs first** (21 CFNs, must score 21/21).
- `pdf_extractions` gained 10 new `facility_*` columns (type, agreement name/date, lender/agent/borrower name, amount/amount_type, evidence_quote, confidence). New `save_facility()` does a partial UPDATE (only `facility_*` columns) so the Batch API backfill path never clobbers doc_category/assignor_name/etc. from a prior real-time extraction.
- New `credit_facility_events` table in `normalize.py` (separate from `aom_events_clean`, whose loan-transfer-only filter is completely untouched — confirmed via git diff and a full local `normalize.py` run: filter logic unchanged, row-count delta was 100% explained by this session's own test data changing 14 CFNs' `doc_category`, not by any logic change).
- New `collector/batch_extract_facility.py` — bulk historical backfill via OpenAI's Batch API (24h turnaround, ~50% cheaper than real-time). Has both a manual 4-stage CLI (`--build`/`--submit`/`--poll`/`--ingest`, for debugging) and an automatic **`--tick`** mode meant for cron: polls in-flight batch jobs, ingests any that finished, and tops back up to `--max-concurrent` (default 3) by building+submitting new chunks of `--chunk-size` (default 3000) documents — newest `rec_date` first, so it naturally works backward from the present across repeated invocations. State tracked in two new tables, `batch_jobs` and `batch_job_documents` (the latter exists specifically so an in-flight, not-yet-ingested chunk's CFNs aren't re-selected into a second chunk before the first finishes — `facility_type` alone can't tell "in flight" apart from "not started" since it's only set on ingest; this was a real bug caught during local testing, same 5 CFNs got submitted 3x before the fix). A lock file (`collector/batch/tick.lock`) prevents overlapping cron invocations; stale `building`-status jobs older than 1h with no `batch_id` are auto-failed (crash recovery) so their claimed CFNs free up again. `collector/batch/` added to `.gitignore` (contains OCR'd document text).
- **User's plan:** run via cron on the droplet, e.g. `*/20 * * * * cd /opt/amo-dashboard && collector/.venv/bin/python3 collector/batch_extract_facility.py --tick >> collector/batch/tick.log 2>&1` (see script's module docstring for the exact line). Not yet running in production — this session only verified the full state machine (build→submit→poll→ingest, concurrency top-up, no-duplicate-claim) locally against real (non-test) documents with a temporary API key: 3 concurrent jobs, all completed and ingested correctly, capacity automatically refilled.
- Verified locally: 21/21 known-labeled CFNs match expected facility_type after the fix; `credit_facility_events` populated correctly (11 rows: 10 BGI + 1 Bradesco); `aom_events_clean` build logic unaffected.

**Not done yet / next steps for a future session:** user sets up the actual cron entry on the droplet and lets it run; once the backlog drains, decide on dashboard UI for `credit_facility_events` (currently just a queryable table, no client-side view yet). `normalize.py` needs to be (re-)run periodically too so `credit_facility_events` reflects newly-ingested batches — not itself automated by `--tick` (it rebuilds several other large tables and is slower; fine as an occasional manual step or a separate, less-frequent cron entry).

---

## 2026-07-15 — Collateral / Line-of-Credit wording discovery (in progress)

**Goal:** Before building any pipeline changes, find real document wording that indicates a "line of credit" / warehouse-facility relationship in collateral-type recorded documents — so the eventual detection logic is based on actual language, not guesses. Explicit constraint from user: **no changes to `collector/` tooling yet** — this is pure research, done with throwaway scripts outside the repo.

**Where things stand:**
- Local dev machine now has a working scrape environment: `collector/.venv` (Python venv, gitignored automatically via its own internal `.gitignore`) with `playwright` + chromium + `requests` installed. `collector/config.py` has real Clerk credentials populated locally. No `.env` / `OPENAI_API_KEY` locally — LLM classification (`extract_pdfs.py`, `enrich_entities.py`) cannot run locally, only download+OCR.
- Local `miami_dade_amo.db` doc_type coverage after this session:
  - `ASSIGNMENT OF MORTGAGE - AMO`: 48,836 rows, 2023-01-03 → 2026-04-22 (**stale**, pre-existing, not touched this session)
  - `ASSIGNMENT - ASG`: 1,489 new rows, 2026-04-14 → 2026-07-13 (collected this session)
  - `FINANCING STATEMENT UCC - FST`: 2,581 new rows, 2026-04-14 → 2026-07-13 (collected this session)
  - `ASSIGNMENT OF INTEREST - AIT`: **broken on the live Clerk site itself**, not our bug. Confirmed via a completely fresh Playwright session (no prior request history) — form fills and submits correctly, but the site never returns a response or error, it just hangs past the 45s timeout, 100% reproducible. Screenshot evidence saved (see below). Deprioritized; revisit later or test manually in a real browser.

**Findings (the actual research result so far):**
1. Two AMO-type docs previously classified `COLLATERAL` by the LLM pipeline turned out to be **false positives** — standard RMBS-trust "Corporate Assignment of Mortgage" transfers with zero collateral/LOC language. Likely misclassified because the return address said "Collateral Document Services" (a mail-drop name, not a legal signal).
2. Sampled 60 `ASSIGNMENT - ASG` docs (newest-first, downloaded + OCR'd, keyword-scanned, no LLM): dominated by **Assignment of Rents/Leases** (~34/60, new-loan-origination security, not a resale of existing debt) and consumer HELOC boilerplate (Finastra/LaserPro forms) that happens to say "revolving line of credit" — **not** the institutional warehouse-line pattern being sought. The 9 true Assignment-of-Mortgage docs in the sample showed **zero** collateral/LOC language.
3. Pivoted to `FINANCING STATEMENT UCC - FST` (UCC-1 filings) as the more likely home for warehouse-line language, since that's the standard legal mechanism for pledging a mortgage/note pool as collateral for a credit facility. User confirmed they expect wording like **"warehouse line of credit"**.
4. Sampled 60 FST docs: all 60 matched "collateral" (a standard UCC form field, not meaningful) but **zero** matched "warehouse"/"line of credit"/"revolving" literally. One instructive example found: a **UCC-3 amendment** reassigning collateral from `FS CREIT FINANCE HOLDINGS LLC` → `FS RIALTO 2026-FL11 ISSUER, LLC` — looks like a loan graduating from warehouse-style financing into a CLO securitization pool. Real deal intelligence, but amendments reference the *original* UCC-1 by file number rather than repeating the underlying facility language.

**Immediate next step (was mid-task when session ended):** Compare *initial* UCC-1 filings vs *amendments* in the FST sample — hypothesis is the underlying "warehouse credit and security agreement" language lives in the initial filing's collateral description (box 4), not in amendments. Was running:
```
cd collector/.venv/.. && for f in .../fst_texts/*.txt; do head -12 "$f" | grep -i "UCC FINANCING STATEMENT"; done | sort | uniq -c
```
to split the 60-doc sample by filing type before reading initial filings closely.

**Scripts + downloaded/OCR'd text — persisted at `collector/research/` (gitignored, local-only, NOT committed):**
- `collector/research/scripts/` — `scan_asg_batch.py`, `scan_fst_batch.py`, `read_collateral_docs.py`, `diag_doctype.py`, `diag_ait_search.py`, `ait_fail.png`. Throwaway/discovery-only, not part of the real pipeline. Download+OCR via the Clerk's public document-image API (same endpoint as `extract_pdfs.py`) + `pdftoppm`/`tesseract`, no LLM call, no DB writes.
- `collector/research/asg_texts/` — 60 OCR'd ASG docs already pulled and scanned.
- `collector/research/fst_texts/` — 60 OCR'd FST (UCC-1) docs already pulled; **mid-analysis, not yet split by initial-filing vs amendment** — that's the next step (see below). Re-run `collector/.venv/bin/python3 collector/research/scripts/scan_fst_batch.py <limit> <offset>` with a higher offset to pull more of the 2,581 collected FST docs if this batch doesn't yield a clean "warehouse line of credit" example.

**Key gotcha discovered:** `extract_pdfs.py` never persists raw OCR text anywhere — only the LLM's structured JSON output. If/when we do build wording-based detection into the real pipeline, either (a) add temporary raw-text capture, or (b) extend the LLM extraction schema directly to flag/quote LOC evidence. User explicitly deferred this decision — no tool changes yet.

**Cross-tool handoff set up this session:** added `CLAUDE.md` (auto-loaded by Claude Code) and this file (`SESSION_LOG.md`, the shared source of truth) at the repo root, and rewrote the stale `.cursor/rules/amo-session-handoff.mdc` (previously described abandoned June work) to point here too, so Cursor — regardless of which model is configured — gets the same handoff. All three committed and pushed to `origin/main`.

**Also this session:** Did a full codebase walkthrough (architecture: Express + better-sqlite3 server, React/Vite client, Python collector pipeline). Flagged that the GitHub remote had a PAT embedded in plaintext in `.git/config` — user should rotate it.

---
