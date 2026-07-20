# AMO Dashboard

Miami-Dade Assignment-of-Mortgage tracking dashboard. Stack: React/Vite client (`client/`), Express + better-sqlite3 server (`server/`), Python collector pipeline (`collector/`). SQLite DB `miami_dade_amo.db` (gitignored).

**Before doing anything else, read [SESSION_LOG.md](SESSION_LOG.md)** — it has the current state of in-progress work, recent findings, and open threads. It's kept dense on purpose; read it instead of asking the user to re-explain where things left off. Append a new dated entry there at the end of any substantive session (concise — facts, not transcript).

This same handoff mechanism is mirrored for Cursor (any model) at [.cursor/rules/amo-session-handoff.mdc](.cursor/rules/amo-session-handoff.mdc), which points to the same `SESSION_LOG.md`. Keep both this file and that one in sync if operational facts change — they intentionally duplicate the facts below so either tool works standalone.

## Operational facts

- **Deploy:** production runs on a DigitalOcean droplet (`165.22.35.75`, `/opt/amo-dashboard`, **1 vCPU / 1GB RAM** — keep any CPU-heavy cron jobs (OCR concurrency, etc.) modest, this box has no headroom). `git pull` alone does NOT update the live site — must also `npm run build` and restart the Node process (`node dist/index.cjs`, port 5000). Don't kill Python backfill processes when restarting.
- **User runs all droplet/production actions manually** — code changes happen here (commit + push to `origin/main`), deployment is a separate manual step the user does themselves. Don't attempt to SSH or act on the droplet directly.
- **LLM provider is OpenAI** (`gpt-4.1-nano` by default) for `collector/extract_pdfs.py` and `collector/enrich_entities.py` — not Claude/Anthropic.
- **GitHub workflow:** every agreed-on code change should be committed and pushed to `origin/main` once confirmed.
- Local dev DB (`AMO_DB_PATH=./miami_dade_amo.db`) can lag production significantly — check actual row/date coverage before assuming it's current.
