# Runbook — make nginx the only public entry point (close port 5000)

Drafted 26 Oct 2026. **Nothing here has been applied until the owner says yes**; the "Status" line
at the bottom records what has.

## Why

- The dashboard's Node process binds `0.0.0.0:5000`, `ufw` is inactive and there is no DigitalOcean
  cloud firewall, so **every user talks to Node directly** at `http://165.22.35.75:5000`. nginx has been
  listening on `:80` and proxying to `127.0.0.1:5000` since April 2026, but nobody uses it.
- Express parses request bodies **before** the password check. A request with
  `Content-Encoding: br` makes Node inflate the body with its bundled Brotli, which on the EOL
  Node 20.20.2 the droplet runs is unpatched (CVE-2026-111497). Verified 26 Oct 2026: an
  unauthenticated `POST` with `Content-Encoding: br` from the public internet reaches zlib on `:5000`
  (the server answers `400 {"message":"Decompression failed"}`, i.e. the decoder ran).
- The Node upgrade is a separate, parked task (ABI rebuild of `better-sqlite3`, owner deferred). This
  runbook removes the exposure without it: Node listens on loopback only, nginx strips `br` before
  proxying, and the host firewall closes everything but 22/80/443.

What users see: **the URL changes from `http://165.22.35.75:5000` to `http://165.22.35.75/`**
(port 80). Same page, same password, same cookie. Nothing else changes for them.

## Pieces

| Piece | Where | State |
|---|---|---|
| `AMO_BIND_HOST` — listen address, default `127.0.0.1` when `NODE_ENV=production`, `0.0.0.0` otherwise | `server/index.ts` | committed on `main`, **not deployed** |
| nginx site file: `br` stripped via a `map`, `X-Forwarded-*` added, websocket headers kept | [`nginx-amo-dashboard.conf`](nginx-amo-dashboard.conf) → `/etc/nginx/sites-available/amo-dashboard` | drafted, syntax-tested on the droplet with `nginx -t -c` against a throwaway wrapper, **not installed** |
| Host firewall (`ufw`): allow 22, 80, 443 only | droplet | **not enabled** |
| DigitalOcean cloud firewall (same rules, outside the box) | DO control panel | **none exists** — owner's call, needs the DO account |
| TLS | — | **blocked on a hostname** (see "Open decisions") |

**Pushing the `server/index.ts` commit arms the change.** The next routine deploy (`git pull && npm
run build && pm2 restart`) would bind Node to loopback and silently close `:5000` for every user who
has not been told about the new URL. Do step 1 before the commit is pushed, or deploy with
`AMO_BIND_HOST=0.0.0.0` exported if `:5000` must stay open a little longer.

## Runbook — in this order

All commands on the droplet as root (`ssh root@165.22.35.75`; if `Permission denied (publickey)`,
run `ssh-add --apple-load-keychain` on the Mac first). Verify each step before the next one.

### 0. Baseline (from the Mac, before touching anything)

```bash
curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://165.22.35.75:5000/login   # 200 today
curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://165.22.35.75/login        # 200 today
printf 'notbrotli' | curl -s -m 10 -w "\n%{http_code}\n" -X POST -H 'Content-Type: application/json' -H 'Content-Encoding: br' --data-binary @- http://165.22.35.75/login
# today: {"message":"Decompression failed"} 400  ← brotli decoder ran inside Node
```

### 1. Tell the users

Send before anything else, by whatever channel reaches Andres and David: *"The AOM Tracker address is
now `http://165.22.35.75/` (no `:5000`). The old address stops working on <date/time>. Same password."*
Give at least a working day. Update any bookmark or link you control (the weekly email has no link
to the dashboard — checked `server/email/`).

### 2. Install the nginx change (safe on its own — `:5000` stays open)

```bash
cd /opt/amo-dashboard && git pull                       # brings docs/ops/nginx-amo-dashboard.conf
cp /etc/nginx/sites-available/amo-dashboard /etc/nginx/amo-dashboard.before_close5000.$(date +%s)
install -m 644 docs/ops/nginx-amo-dashboard.conf /etc/nginx/sites-available/amo-dashboard
nginx -t && systemctl reload nginx
```

Verify (from the Mac):

```bash
curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://165.22.35.75/login   # 200
printf 'notbrotli' | curl -s -m 10 -w "\n%{http_code}\n" -X POST -H 'Content-Type: application/json' -H 'Content-Encoding: br' --data-binary @- http://165.22.35.75/login
# expected now: {"message":"Unexpected token ...is not valid JSON"} 400  ← JSON parser, not the decoder
```

Log in through `http://165.22.35.75/` in a browser and click through two pages. If anything is
wrong: `cp /etc/nginx/amo-dashboard.before_close5000.* /etc/nginx/sites-available/amo-dashboard && nginx -t && systemctl reload nginx`.

### 3. Deploy the bind change (this is the step that closes `:5000`)

The `git pull` in step 2 already fetched the code. `--update-env` is required: PM2 holds the
environment it was started with (`ecosystem.config.cjs`, Apr 2026) and ignores `.env`. Export **only**
`AMO_BIND_HOST` — never `source .env` wholesale under `--update-env` (its `AMO_PASSWORD` differs from
the one PM2 runs with and would silently change the login password).

```bash
cd /opt/amo-dashboard
git log --oneline -1                                    # the bind-host commit or later
echo 'AMO_BIND_HOST=127.0.0.1' >> .env                  # for the record; the server does not read .env
npm run build && ls -la dist/index.cjs                  # build BEFORE restart; bundle must exist
export AMO_BIND_HOST=127.0.0.1
pm2 restart amo-dashboard --update-env && pm2 save
pm2 logs amo-dashboard --lines 5 --nostream             # "serving on 127.0.0.1:5000"
ss -ltnp | grep ':5000'                                 # 127.0.0.1:5000, NOT 0.0.0.0:5000
```

Expect the usual ~2 s restart blip on `:80`. Do not kill Python collector processes.

Verify (from the Mac):

```bash
curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://165.22.35.75:5000/login   # connection refused / timeout (exit 7 or 28)
curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://165.22.35.75/login        # 200
```

Log in at `http://165.22.35.75/` again; check the Overview and one Reporting export.

### 4. Firewall — close the rest

**Important:** `ufw` on Ubuntu 24.04 defaults to *deny incoming*. Allow SSH **first**, in the same
command block, or the session is the last one in.

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
ufw status verbose          # 22, 80, 443 ALLOW IN; default deny (incoming), allow (outgoing)
```

Outbound is unaffected (the collectors' HTTPS/SFTP, OpenAI, DigitalOcean Spaces backup all go out).
Then, in a **second** terminal, confirm a fresh `ssh root@165.22.35.75` works before closing the first.

Verify from the Mac: `nc -vz -w 5 165.22.35.75 5000` → refused/timed out; `:80` → open.

**Optional, owner's account:** a DigitalOcean cloud firewall (Networking → Firewalls) with the same
three inbound rules, attached to the droplet. It filters before packets reach the box and survives a
mis-set `ufw`. Nothing in this runbook depends on it.

### 5. Record it

- Confluence page: production URL, §6.2/§6.3, §7.5 — already drafted in the same commit; mark the
  risk-register row "applied <date>".
- `SESSION_LOG.md`: date, what was applied, the before/after `curl` output.
- Update the "Status" line at the bottom of this file.

## Rollback

Reopen `:5000` directly (users can go back to the old URL at once):

```bash
export AMO_BIND_HOST=0.0.0.0
pm2 restart amo-dashboard --update-env && pm2 save
ss -ltnp | grep ':5000'                                 # 0.0.0.0:5000
ufw allow 5000/tcp                                      # only if step 4 was done
```

Restore the old nginx file: `cp /etc/nginx/amo-dashboard.before_close5000.<ts> /etc/nginx/sites-available/amo-dashboard && nginx -t && systemctl reload nginx`.
Disable the host firewall entirely: `ufw disable`.

Rolling back the code is not needed: with `AMO_BIND_HOST=0.0.0.0` in PM2's environment the
production default is overridden, and `pm2 save` keeps it across reboots.

## Open decisions for the owner

1. **A hostname, so TLS can follow.** Let's Encrypt will not issue a certificate for a bare IP
   address, and the dashboard password crosses the wire in clear text on every login today. Any name
   under a domain the company controls (e.g. `aom.<company-domain>`) pointed at `165.22.35.75` is
   enough; then `certbot --nginx` adds `:443` and the `:80` server becomes a redirect. Until there is
   a name, this runbook leaves the site on plain HTTP — strictly better than today (Node is no longer
   reachable directly) but not finished.
2. **DigitalOcean cloud firewall** — yes/no. Needs the DO account; five minutes in the control panel.
3. **When** to announce the URL change and cut over (step 1 → step 3 gap).

## Things to know

- `X-Forwarded-For` is now passed in, but the server does not read it yet. Before any code uses
  `req.ip` (the pending login rate limit), add `app.set('trust proxy', 'loopback')` in
  `server/index.ts` — otherwise every client is `127.0.0.1`.
- `nginx -t` only checks syntax. The behavioural check is the `br` `POST` in step 2.
- `pm2 startup` is systemd-enabled and the dump is from 7 Oct 2026; `pm2 save` in step 3 refreshes it
  so a reboot comes back with `AMO_BIND_HOST` set.
- The `amo-droplet` MCP `deploy` tool does pull + build + `pm2 restart` **without** `--update-env`.
  After step 3 that is fine (the code's production default is loopback) but it will not *add* the
  variable, so do step 3 by hand the first time.

## Status

- 26 Oct 2026 ~17:15 UTC — drafted; code committed on `main`; nginx file syntax-tested; owner asked.
- **26 Oct 2026 17:28–17:36 UTC — APPLIED, steps 2–4, on the owner's go-ahead** ("run steps through
  step 5"; the owner tells Andres and David about the URL themselves, so step 1 was theirs).
  - Step 2 nginx: backup `/etc/nginx/amo-dashboard.before_close5000.1793035829`, `nginx -t` ok,
    reloaded. Brotli `POST` to `:80` went from `400 Decompression failed` to
    `400 Unexpected token 'n', "notbrotli" is not valid JSON`; gzip control still decoded.
  - Step 3 Node: `63ec058` built (`dist/index.cjs` 17:31 UTC), `pm2 restart --update-env` with
    `AMO_BIND_HOST=127.0.0.1`, `pm2 save`; log `serving on 127.0.0.1:5000`; `ss` shows
    `127.0.0.1:5000`. From the Mac: `:5000` → connection refused (curl exit 7), `:80/login` → 200
    `AOM Tracker — Sign In`.
  - Step 4 ufw: 22/80/443 allowed, enabled, active on boot. Fresh SSH ok; `nc :5000` times out,
    `:80`/`:22` succeed; outbound HTTPS (OpenAI, GitHub) and SFTP to `BCFTP.Broward.org:22` still
    work; PM2 online; the running `collect_live.py` was left alone.
  - Still open: DigitalOcean cloud firewall (recommended, needs the DO account) and a hostname for TLS.
