# Market Intelligence → AMO Dashboard merge — running session doc

> **Status:** STEPS 1–3 DONE — droplet copy live at `http://165.22.35.75/intel` with no Vercel service left in use (not announced; Vercel still production) · **Owner:** Enrique C. · **Started:** 28 Oct 2026 · **Last updated:** 28 Oct 2026
>
> Read this before doing anything on the merge. The state header above and the log at the bottom are the
> source of truth; update both at the end of every session that touches this work. The plain-English
> version of the plan is section 3. Owner decisions still open are in section 6.

---

## 1. What we are merging

**Market Intelligence** is a password-gated Next.js dashboard for Safe Harbor, deployed on Vercel. It
pulls FDIC Call Reports, SEC EDGAR filings, Federal Register / LegiScan / GPO rulemaking and RSS news
into five tabs — **News, Market Analytics, Market Research, Legal Landscape, Peers** — so the team can
find banks under CRE stress to buy notes from, and see what competing managers are raising.

The goal is one tool, one server, one login: Market Intelligence folded into the AMO dashboard.

### 1.1 Market Intelligence — facts (read from its code, 28 Oct 2026)

| Item | Fact |
|---|---|
| Repo | `github.com/EnriqueColon/market-intelligence-tool` — owned by the same GitHub account as this repo and **public** (checked with `gh repo view` on 28 Oct 2026; the code-read notes called it private). No invite or deploy key needed; the droplet can clone it directly |
| Size | ~406 TS/TSX files, ~82k lines across `app/`, `lib/`, `components/`; **49 server actions**, 12 API route groups |
| Framework | Next.js 15.5.12, App Router, React 18.3, Tailwind 4, Radix/shadcn, TypeScript; **Node 24.x pinned in `engines`** |
| Runtime | Every route handler is `runtime = "nodejs"`. No edge functions, no KV, no Upstash, no AI SDK |
| Database | Vercel Postgres (`@vercel/postgres` 0.10), **optional** — `lib/db.ts` `isDbEnabled()` checks `POSTGRES_URL`, call sites degrade without it. Seven tables created by `app/api/admin/init-db/route.ts`: `research_reports`, `research_summaries`, `research_search_cache`, `research_feed_cache`, `industry_outlook_cache`, `institution_watchlist`, `bill_status_history`. Two LLM-summary caches, one uploaded-report store, one global watchlist, one bill-tracking table. Nothing relational or load-bearing |
| Auth | Single shared password. `POST /api/auth` compares to `APP_PASSWORD`, sets `auth_token` cookie = `COOKIE_SECRET`, 365-day sliding expiry. No users, sessions, roles or per-user state |
| LLM | ~19 files, all through `lib/openai.ts` — hand-rolled fetch to OpenAI **Responses API**, 55 s timeout. Default `gpt-4.1-mini`, overridable per use: `OPENAI_SMART_MODEL`, `OPENAI_FAST_MODEL`, `OPENAI_SUMMARY_MODEL`, `OPENAI_SUMMARY_PDF_MODEL`, `OPENAI_TREND_MODEL`, `OPENAI_SEARCH_FILTER_MODEL`. Uses OpenAI's hosted `web_search` tool with domain allowlists on some call sites (forces a non-mini model) |
| Peers data | Not LLM. `lib/peer-intel/adv-extract.json` (880 KB) and `adv-history.json` (728 KB) are committed files built from IAPD PDFs and SEC bulk archives. Readings are deterministic from on-screen figures — a hard convention that survives any port |
| Vercel-only | **Cron**: `vercel.json` runs `/api/cron/warm-cache` 05:00 and `/api/cron/warm-briefs` 05:15; a third handler `/api/cron/measure-load`; all check `CRON_SECRET`. **Blob**: `@vercel/blob` for uploaded research PDFs incl. the client-upload token handshake (`/api/blob/handle-upload`, `token-preflight`, `transfer-diagnostics`) and `BLOB_READ_WRITE_TOKEN`. **Postgres**: standard connection string, Neon/Supabase would drop in. **`@vercel/analytics`**: trivial to remove |
| Analytics API | `app/api/analytics/v1/*` (behavior-signals, cohort-watch, institution, screening, visuals, meta) — built for AMO to consume, bearer `ANALYTICS_API_KEY`, exempt from the login wall in `middleware.ts`. Whole-scope `behavior-signals` response was **4,318,145 bytes on 26 Oct against Vercel's 4,480,000-byte ceiling**, growing 3.90 → 4.02 → 4.12 MB as FDIC data arrives |
| Tabs | Which tabs exist is read from `ENABLED_TABS` |
| AMO data | Reads **nothing** from AMO. The dependency ran the other way (see 1.3) |

### 1.2 AMO dashboard — the receiving side

Express 5 + better-sqlite3 + Drizzle server, Vite/React 18 client with Radix/shadcn, one bundle
(`dist/index.cjs`) under PM2 on the DigitalOcean droplet `165.22.35.75` (4 vCPU / 8 GB, Node
22.23.4, nginx on :80, no TLS). Single shared password (`AMO_PASSWORD` / `AMO_SECRET`), no user
model. Repo `EnriqueColon/amo-dashboard` is **public** (see Confluence §7.6 item 1).

### 1.3 The fact that reshapes the job

Between 27 and 28 Oct 2026 the dashboard rebuilt the Market Analytics side of Market Intelligence on
its own FDIC pull (Bank Stress Ranking stages 1–3: `bank_stress.db`, `server/bank-stress.ts`,
`server/fdic-analytics.ts`, `collector/bank_stress/behavior.py`). **Nothing in AMO reads the Market
Intelligence API any more**; stage 4 (removing the MI client, proxy and env vars) is armed for
29 Oct 06:00 UTC. So:

- the `/api/analytics/v1/*` surface has no consumer and can be switched off;
- the 4.3 MB payload-ceiling problem disappears with it;
- the Market Analytics tab is a duplicate of AMO's Bank Stress / FDIC Data Analytics pages;
- roughly a fifth of the tool is gone before any merge work starts.

---

## 2. Decision (28 Oct 2026)

**Co-host first, port tabs second. Do not rewrite 82k lines up front.**

The alternatives considered and set aside:

- **Full port into the AMO repo now.** 49 server actions each become an Express route plus a client
  fetch; Tailwind 4 → 3; App Router pages → wouter routes. Weeks of work before anything ships, and
  most of it for tabs that may not be worth owning.
- **Leave it on Vercel and link it.** Fast, but two deployments, two bills, cross-origin cookies, and
  the Vercel body-size ceiling stays.

Co-hosting gets one box and one login in days, with every later step optional and independently
shippable. The droplet has no 4.5 MB response ceiling. Porting is deferred until a tab has proved it
is worth owning.

---

## 3. The plan, step by step (plain English first, then the technical detail)

### Step 1 — Move Market Intelligence onto our own server
*Today it lives on Vercel's computers. We copy it onto the DigitalOcean server that already runs the
AMO dashboard and start it there as a second program running side by side. Nothing about the app
changes yet; it just runs in a different place, at an address like `http://server/intel`.*

- Clone the repo to its own folder on the droplet (e.g. `/opt/market-intelligence`).
  **Keep MI code in its own repo, never inside `amo-dashboard`** — separate history, separate
  deploy, and both repos are public so no secrets in either.
- `next.config.mjs`: set `basePath: '/intel'` (and `assetPrefix`) so it lives under a path.
- nginx: `location /intel/ { proxy_pass http://127.0.0.1:<port>; }` beside the existing AMO block.
- PM2: second app `market-intelligence` (`next start -p <port>`), `pm2 save`. Same `--update-env`
  rule as AMO when adding variables.
- Relax `engines.node` from 24.x to `>=20` (Next 15 needs 18.18+; droplet is 22.23.4) **or** move
  the droplet to Node 24 LTS. Relaxing is cheaper and avoids the PM2/systemd update race of 26 Oct.
- `next build` on the droplet (8 GB is enough; do it outside the county-collector window).

### Step 2 — Replace the four things that only work on Vercel
*Vercel provided four services the server doesn't have. Each gets a plain equivalent.*

| Vercel service | Replacement | Notes |
|---|---|---|
| `vercel.json` crons (05:00 warm-cache, 05:15 warm-briefs, measure-load) | Three `crontab` lines that `curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:<port>/intel/api/cron/...` | Move off the 05:00 window — the county collectors and the Bank Stress Sunday job run early morning UTC |
| `@vercel/blob` (uploaded research PDFs + client-upload token handshake) | Write to a folder on disk (e.g. `/opt/market-intelligence/uploads`), serve via Next route or nginx | Removes `handle-upload`, `token-preflight`, `transfer-diagnostics` and `BLOB_READ_WRITE_TOKEN` entirely. Add the folder to the backup job |
| Vercel Postgres | Local Postgres on the droplet **or** a free Neon database; swap `@vercel/postgres` for `postgres`/`pg` with the same `sql` tagged-template shape | Seven small tables; `init-db` route recreates them. Snapshot once, cut over, no dual-write |
| `@vercel/analytics` | Delete the import | — |

### Step 3 — One password opens both apps
*Both apps already work the same way: one shared password, no individual accounts. We set them to the
same password and make the AMO login also log you into Market Intelligence.*

- `APP_PASSWORD` = `AMO_PASSWORD`.
- AMO's login handler (`server/auth.ts`) additionally sets MI's `auth_token` cookie with
  `COOKIE_SECRET` on the same host, path `/intel`. ~20 lines. Both token values live in PM2's
  environment and `.env` — keep the two in step as with `AMO_SECRET`.
- Add "Market Intelligence" to the AMO sidebar as a link to `/intel`.

### Step 4 — Remove what is now duplicated
*The dashboard already rebuilt the bank-stress analytics. Market Intelligence's Market Analytics tab and
its data feed to AMO are no longer needed.*

- After stage 4 of the Bank Stress work verifies clean (29 Oct 06:00 UTC): drop `analytics` from
  `ENABLED_TABS`; disable `app/api/analytics/v1/*` and its `middleware.ts` exemption; remove
  `ANALYTICS_API_KEY`.

### Step 5 — Fold the remaining tabs into the dashboard, one at a time
*Everything works now, from one server, with one login, but they are still two apps with a link
between them. Each remaining tab gets rebuilt inside the dashboard itself, easiest first, and switched
off in the old app as it lands. When the last one moves, the old app is turned off.*

| Order | Tab | Why this position | Effort |
|---|---|---|---|
| 1 | **Peers** | Data is two committed JSON files; readings are deterministic; no LLM, no DB | 1–2 days |
| 2 | **News** | Feed fetch + LLM summaries; needs an OpenAI client in the Express server and a cache table in SQLite | 3–5 days |
| 3 | **Legal Landscape** | Federal Register / LegiScan / GPO + `bill_status_history` | 3–5 days |
| 4 | **Market Research** | PDF upload + summaries + search cache; the most Vercel-shaped tab | 5+ days, or leave in the Next app indefinitely |

Each port: Express routes under `/api/intel/...`, data in `miami_dade_amo.db` or its own SQLite file
(the `bank_stress.db` pattern), page in `client/src/pages/`, nav entry, glossary tooltips, the
tool's own unit tests for that tab's logic carried over. **All four tabs are ported (owner, 28 Oct
2026, §6 row 6); the co-hosted app is a bridge and is retired when the last one lands.**

### The remaining work, phased (28 Oct 2026, after steps 1–3)

| Phase | Work | Effort |
|---|---|---|
| **A. Clear the ground** | step 4 (hide Market Analytics, close the analytics API) after the 29 Oct stage 4 check; copy watchlist / reports / bill history from Neon (owner supplies the connection string); decide The Real Deal | ~2 days |
| **B. Foundation in the dashboard** | OpenAI Responses-API client in Express + cache tables; "Intelligence" sidebar section, page scaffolding, shared article/card components, glossary; **rename to SHCP Intelligence Platform** (title, login, sidebar, email header, Confluence) | ~3 days |
| **C. Rebuild the tabs** | Peers 1–2 d → News 4–6 d → Legal Landscape 4–6 d → Market Research 5–7 d; each switched off in the bridge app as it lands | 3–4 weeks |
| **D. Cut over and retire** | DNS + TLS, users get the new name; remove the bridge app, its nginx route, PM2 entry, Postgres and backup job; close the Vercel project | ~2 days |

Total ≈ 5–6 weeks of build. **Design call pending with the owner:** the ported data lives in the
dashboard's SQLite (recommended: one engine, one backup) or stays in the droplet's Postgres.

---

## 4. Effort

| Step | Effort | Ships what |
|---|---|---|
| 1 Co-host | 1–2 days | MI running on the droplet |
| 2 Vercel swaps | 1–2 days | Vercel account can be closed |
| 3 Shared login + nav | ½ day | One sign-in |
| 4 Trim Analytics | 1 hour | Duplicate gone |
| 5 Port Peers | 1–2 days | First tab native in AMO |
| 5 Port News, Legal | 3–5 days each | — |
| 5 Port Market Research | 5+ days | Next app can be retired |

Steps 1–4: about a week, leaving a usable merged tool. Step 5 is optional per tab.

---

## 5. Risks and things to know

- **No TLS on the droplet.** Vercel gave MI HTTPS. Co-hosting at `http://165.22.35.75/intel` sends
  the shared password in the clear. Already open in the 26 Oct security audit. A domain + Let's
  Encrypt is an afternoon and should land before or with step 1.
- **Node pin.** See step 1. Don't `pm2 update` and reinstall Node in the same session (26 Oct race).
- **Box load.** Next server + Express + up to 4 OCR workers + a `next build` fit in 8 GB, but
  schedule builds and MI's crons away from the collector window.
- **LLM.** The 24 Oct AMO break was OpenAI retiring `gpt-4.1-nano`, not the key or account, so MI's
  `gpt-4.1-mini` call sites are unaffected today. Same family, same deprecation track: centralize
  MI's six model env vars in one place so the next retirement is a one-line change. A 404
  `model_not_found` should abort loudly (AMO's `extract_pdfs.py` convention).
- **Both repos are public.** MI code still stays in its own repo (separate history, separate deploy),
  but there is no privacy boundary between them. Both being public means **no secrets may ever be
  committed to either** — check MI's history for `.env` files or keys before cloning it onto the
  droplet. The `amo-dashboard` origin remote still carries a plaintext PAT (Confluence §7.6 item 1).
- **Peers readings convention.** Never have a model write a reading; they are computed from the
  figures on screen. Carry this into any port.

---

## 6. Owner decisions — open

| # | Decision | Options | Status |
|---|---|---|---|
| 1 | Domain + TLS for the droplet before co-hosting | Buy/point a domain → Let's Encrypt; or accept plain HTTP for now | ✅ **owner, 28 Oct 2026: merge first, DNS after.** Name will be `intelligence.safeharborcp.com` (IT adds an A record → `165.22.35.75`). Safeguard: build steps 1–3 on the droplet but **keep Vercel live and do not tell users about the droplet address until the certificate is installed**, so Market Intelligence never runs over plain HTTP for real users. Cut-over = the day the name resolves |
| 2 | Node: relax MI's `engines` pin, or upgrade droplet to Node 24 | Relax (recommended) / upgrade | ✅ **neither — a third way, 28 Oct 2026:** Node 24.22.1 installed in isolation at `/opt/node24` and used only by the MI PM2 app; the system Node 22 and the AMO app are untouched, and the pin stays as Vercel wants it |
| 3 | Postgres: local on the droplet, or free Neon | Local (one less account) / Neon (zero ops) | ✅ **local, forced, 28 Oct 2026:** Vercel will not export values it marks sensitive, so the Neon connection string could not be pulled; PostgreSQL 16 on the droplet, db `market_intelligence`, role `mi`, via a `pg` shim (`lib/db-pg.ts`). **The droplet DB starts empty** — see §7 "data not migrated" |
| 4 | Access to `market-intelligence-tool` | — | ✅ **not needed** — the repo is public and owned by the same account (28 Oct 2026) |
| 5 | Confirm the order: steps 1–4 first, step 5 per tab afterwards | yes / change | ✅ **confirmed by the owner, 28 Oct 2026** |
| 6 | Which of News / Legal / Market Research are worth porting at all, vs leaving in the co-hosted app | per tab | ✅ **all of them — owner, 28 Oct 2026:** "a complete integration of the tool's functionality into the AMO tracker… not just a link or a URL." The co-hosted Next app is a bridge only; every remaining tab (Peers, News, Legal Landscape, Market Research) is rebuilt inside the dashboard's own React client and Express server, and the Next app is retired when the last one lands. A sidebar link to `/intel` may exist in the interim but is not the deliverable |
| 7 | Product name | — | ✅ **owner, 28 Oct 2026: the AMO tracker becomes "SHCP Intelligence Platform"** once the tools are merged. Rename is part of the port (title, login page, sidebar, email report header, Confluence page), not a separate task. Hostname `intelligence.safeharborcp.com` fits it |

---

## 7. Log (most recent first)

### 2026-10-28 (latest) — STEP 2 DONE: no Vercel service in use on the droplet; `droplet-cohost` merged into `dev`

Owner: "Works, continue" after logging in at `/intel` and clicking through the tabs (the first
browser verification). Asked for step 2 and for the branch to be merged into MI's `dev`.

**Branches.** `droplet-cohost` merged into `dev` (`ae1da23`), then step 2 on `vercel-services-swap`
(`3dc1987`) merged into `dev` as a fast-forward. **The droplet now tracks `dev`** (same tree as the
running build, no rebuild needed). MI `main` still lacks all of it until the owner's next "push to
production"; none of it does anything on Vercel because the switches are droplet-only env vars.

**Blob → disk** (`lib/report-storage.ts`, new route `app/api/research/upload-file`). With
`REPORT_STORAGE=disk` and `NEXT_PUBLIC_REPORT_STORAGE=disk` the browser posts the PDF to the server
instead of running the Blob token handshake; files live under `REPORT_STORAGE_DIR` =
`/opt/market-intelligence-uploads` (outside the repo, mode 700) and are recorded in `research_reports`
as `local-report://market-research/YYYY/MM/<file>.pdf`. `register-upload`, `summarize-report` and
`report-file` read bytes through one helper that handles both Blob and disk; `delete-report` removes
the file with its row; `token-preflight`/`transfer-diagnostics`/`blob-health` report disk mode. The
two `report-file` links and the Blob handshake URL now go through `withBasePath`. **Verified end to
end from the droplet shell:** upload → file on disk → register (id 1) → listed → downloaded as
`application/pdf` → deleted, 0 files left. `@vercel/analytics` renders only when `VERCEL=1`.
Not verified: the upload form in a browser (needs the admin upload token typed on a production host).

**Postgres** — done in step 1 (local, `pg` shim). **Crons** — staged in step 1, still commented out.
**Analytics API** — closed on the droplet (`ANALYTICS_API_KEY` unset); the routes themselves are
step 4. So nothing on the droplet copy talks to Vercel any more.

**Backups.** The droplet is now the only place MI's database and uploads exist, so
`collector/run_mi_backup.sh` (amo-dashboard `78e3e0a`) dumps `market_intelligence` with
`pg_dump --clean --if-exists`, checks the trailer, ships to the Space under `mi_db/` and copies the
uploads folder to `mi_uploads/` (copy, never sync), keeps 7 local. First run: ok, 4 tables, 2 KB.
Cron **03:45 UTC** installed. Restore: `gunzip -c mi-<stamp>.sql.gz | sudo -u postgres psql market_intelligence`.

**The Real Deal, re-tested:** CloudFront answers the droplet with `202` and an empty body on the
JSON API and both RSS feeds, with or without full Chrome headers — an AWS WAF bot-control verdict on
the IP range, not something a header fixes. The owner saw the resulting "Subscriber sources
unavailable today" banner in the UI. Still a cut-over decision (§7 step-1 entry, item 2).

**Open:** unchanged from step 1 — data migration from Neon (needs the connection string from the
Vercel dashboard), The Real Deal, DNS/TLS; plus the owner's next "push to production" to carry
`dev` into `main`.

**Owner's direction at the end of the day ("lets wait"):** the target is **full integration** — every
tab rebuilt inside the dashboard, which becomes **SHCP Intelligence Platform** — not a link (§6 rows
6–7). Holding here. When work resumes: step 4 (hide Market Analytics via `ENABLED_TABS`, disable
`/api/analytics/v1/*`) once the Bank Stress stage 4 job verifies on 29 Oct, then step 5 starting with
Peers, each tab shipped as a page in `client/src/pages/` + routes under `/api/intel/*`, switched off
in the Next app as it lands. The sidebar link is optional interim scaffolding only.

### 2026-10-28 (later) — STEP 1 DONE: Market Intelligence runs on the droplet at `/intel`

**What is live.** `http://165.22.35.75/intel` → login page → the five tabs. PM2 app
`market-intelligence` (port 3100, Node 24.22.1 from `/opt/node24`, config at
`/opt/market-intelligence.config.cjs` outside the repo), code at `/opt/market-intelligence` on branch
**`droplet-cohost`** (`fb50fdb` + `faa4bd2`, pushed to GitHub, **not merged to `dev`/`main`**), nginx
`location ~ ^/intel(/|$)` in `sites-available/amo-dashboard` (backup `*.before_intel.<ts>`),
PostgreSQL 16 local. The AMO app, its port, its PM2 entry and its nginx block are unchanged; verified
`/` still answers as before. Vercel is untouched and remains production. **Nobody has been told the
droplet address** (plain HTTP; cut-over waits for the certificate).

**Verified from the droplet shell:** unauthenticated `/intel` → 307 to `/intel/login`; wrong password →
401; a session cookie renders the dashboard (308 KB, all five tab triggers present, so `ENABLED_TABS`
gating is active); assets under `/intel/_next/...` → 200; the login page screenshot through nginx.
**Not verified:** an actual browser login and each tab's data (needs the password typed on a
production host, which is the owner's to do). Memory after both apps: ~0.9 GB used of 7.9.

**Code changes (branch `droplet-cohost`, inert on Vercel because none of the variables are set there):**
- `NEXT_PUBLIC_BASE_PATH` → Next `basePath`; `lib/base-path.ts` + the 15 client `fetch("/...")`
  calls go through `withBasePath()`; middleware login redirects add the base path back.
- `middleware.ts` matcher lists `'/'` explicitly — under a basePath the catch-all never matched the
  bare `/intel`, so **the home page rendered without a session check** until this fix.
- `COOKIE_SECURE=false` keeps the auth cookie usable over plain HTTP until TLS.
- `lib/db-pg.ts` + `POSTGRES_DRIVER=pg`: a `pg` Pool behind the same `sql`/`sql.query` shapes;
  `pg` added to `package.json`/lockfile and `serverExternalPackages`.
- `fetch-research-feed.ts` self-URL precedence bug fixed (`a || b ? x : y` → "https://undefined").

**Environment.** `vercel env pull` (CLI already logged in as the owner) gave 68 variables, but Vercel
returns an **empty string for anything marked sensitive** — 22 keys, incl. `APP_PASSWORD`,
`COOKIE_SECRET`, `CRON_SECRET`, every `POSTGRES_*`/`PG*`/`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`,
`ANALYTICS_API_KEY`, `ANTHROPIC_API_KEY`. On the droplet (`/opt/market-intelligence/.env.production.local`,
mode 600, gitignored, loaded by `next build`/`next start` directly — no PM2 `--update-env` for this app):
`APP_PASSWORD` **= the AMO dashboard password** (copied from `/opt/amo-dashboard/.env` shell-side,
merge step 3 in effect already); `COOKIE_SECRET` and `CRON_SECRET` freshly generated; `POSTGRES_URL`
local; `VERCEL*`/`TURBO*` dropped; `APP_URL`/`NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100/intel`;
`NODE_OPTIONS=--dns-result-order=ipv4first` in the PM2 config (the droplet has no IPv6 route and the
first FDIC fetch hit ETIMEDOUT). Tables: `init-db` created three, the other four create themselves on
first use (`bill-status-tracking.ts`, `fetch-industry-outlook.ts`, `institution-watchlist.ts`,
`feed-reports/route.ts`). Crons staged in `crontab -l` **commented out** (05:00 warm-cache, 05:15
warm-briefs, same as `vercel.json`) — enabling them before cut-over would double the OpenAI spend.

**Open from this step (carry to cut-over):**
1. **Data not migrated.** The droplet DB is empty: no uploaded research reports, no watchlist, no bill
   history, cold caches. Migrating needs the Neon connection string, which only the Vercel dashboard
   shows (Storage → the database → `.env.local` tab). Owner action: paste `POSTGRES_URL` into the
   droplet env **or** run `pg_dump` from a machine that has it; a `pg_restore` into
   `market_intelligence` then takes minutes. Same for `BLOB_READ_WRITE_TOKEN` to copy the PDFs (step 2).
2. **The Real Deal blocks the droplet.** `therealdeal.com` (JSON API *and* RSS) answers the droplet
   with `202` and an empty body — a bot-manager verdict on the DigitalOcean IP; this Mac gets 403 to
   the same URLs; Vercel's warm runs report `subscriberSources: ok`. The News tab's "Subscriber
   sources" picks will be empty on the droplet. Options: fetch that one source through a proxy, keep
   a tiny Vercel function for it, or accept the loss. Decide before cut-over.
3. **Branch not merged.** `droplet-cohost` must be merged into `dev` → `main` by the owner's MI
   workflow so future releases carry the base-path code; otherwise the droplet stays pinned to today's
   code. Droplet update procedure once merged:
   `cd /opt/market-intelligence && git pull && PATH=/opt/node24/bin:$PATH npm ci && npm run build && pm2 restart market-intelligence`.
4. Blob upload paths (`handle-upload`, `token-preflight`, `register-upload`) fail on the droplet with
   the token unset — expected, replaced in step 2.
5. `ANALYTICS_API_KEY` unset → `/api/analytics/v1/*` closed on the droplet — expected, step 4.
6. The ENABLED_TABS value carries a trailing `\n` from Vercel (`…,news-v2\n`); harmless after `trim()`.

### 2026-10-28 — Scoped; nothing built
- Owner asked to merge the Vercel tool into AMO "in an efficient manner" and supplied a code-level
  read of Market Intelligence (section 1.1 is that read, verbatim in substance).
- Established that AMO's Bank Stress stages 1–3 already supersede the Market Analytics tab and the
  analytics API (section 1.3).
- Decided co-host-first (section 2), wrote the five steps (section 3), effort (4), risks (5), and the
  six open decisions (6). Saved the plan to Claude's memory so future sessions start here.
- No code, no production change, no Vercel change.
- **Owner confirmed decision 5 (the order) the same day**, and decision 1: **merge first, DNS record
  after**; the name will be `intelligence.safeharborcp.com`, added by company IT. Vercel stays live
  until the certificate is on the droplet (see §6 row 1). Decisions 2, 3, 4 and 6 remain open.
- **Gotcha to check in the MI code once the repo is readable:** if `POST /api/auth` sets the
  `auth_token` cookie with `secure: true` in production, browsers will refuse to send it over plain
  HTTP, and login on the droplet will silently fail until TLS lands. Make it follow an env flag.
- **Repo access resolved:** `gh repo view` shows the repo is public and owned by the same account
  as this one, so decision 4 is moot. Nothing blocks step 1 now.
- **Next:** step 1 on the droplet (clone to `/opt/market-intelligence`, basePath, nginx, PM2),
  keeping Vercel live.
