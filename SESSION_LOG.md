# AMO Dashboard — Session Log

Read this at the start of a session before re-deriving context. Most recent entry first. Keep entries dense (facts, not narrative) — this file exists to cut future token spend, so prune/compact old entries rather than letting it grow unbounded.

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

**Scripts used (throwaway, NOT in this repo — live in the Claude Code scratchpad, may not persist):**
- Download+OCR via the Clerk's public document-image API (same endpoint as `extract_pdfs.py`) + `pdftoppm`/`tesseract`, no LLM call, no DB writes.
- Keyword grep against OCR'd text for candidate phrases.
- If continuing this research in a fresh session, these will need to be rewritten (they were quick and dirty, not meant to be permanent) — happy to redo quickly since the approach is now proven.

**Key gotcha discovered:** `extract_pdfs.py` never persists raw OCR text anywhere — only the LLM's structured JSON output. If/when we do build wording-based detection into the real pipeline, either (a) add temporary raw-text capture, or (b) extend the LLM extraction schema directly to flag/quote LOC evidence. User explicitly deferred this decision — no tool changes yet.

**Also this session:** Did a full codebase walkthrough (architecture: Express + better-sqlite3 server, React/Vite client, Python collector pipeline). Flagged that the GitHub remote had a PAT embedded in plaintext in `.git/config` — user should rotate it.

---
