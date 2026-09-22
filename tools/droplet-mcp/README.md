# amo-droplet MCP server

Exposes the production droplet (`165.22.35.75`, `/opt/amo-dashboard`) to Claude as
a small set of named tools, instead of Claude shelling out to `ssh` by hand.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `pipeline_status` | pm2 state, disk, memory, crontab, and last-modified time of every collector log | no |
| `git_state` | HEAD vs `origin/main`, uncommitted files, and `dist/index.cjs` build time vs commit time — this is how you tell "pulled" from "deployed" | no |
| `tail_log` | Tail one of the known logs, with optional filter | no |
| `db_query` | Read-only SQL against `miami_dade_amo.db` (opened with `-readonly`) | no |
| `restart_app` | `pm2 restart` only — no pull, no build | yes |
| `deploy` | pull → `npm run build` → `pm2 restart` → HTTP check. Requires `confirm:true` | yes |
| `run_collector` | Trigger one collector script off-schedule, detached. Requires `confirm:true` | yes |

## Why `deploy` bundles the build

On this box `git pull` alone changes nothing that users see — pm2 runs
`dist/index.cjs`, which only changes when `npm run build` runs. The `deploy` tool
does all three steps so that step can't be forgotten, and `git_state` reports the
dist-vs-commit timestamps so a half-finished deploy is visible.

## Safety

- There is no "run arbitrary command" tool. Every remote command is built from
  fixed strings plus validated enum/integer arguments.
- `db_query` uses `sqlite3 -readonly`; SQLite itself rejects writes.
- `deploy` and `run_collector` refuse to act without `confirm:true`.
- SQL is piped over stdin, and `tail_log`'s filter is base64-encoded in transit,
  so neither is spliced into a shell command line.

## SSH auth

The server uses your existing ssh-agent key — no new credential is created.

MCP clients spawn servers with a stripped environment, so `SSH_AUTH_SOCK` is
normally missing and auth fails with `Permission denied (publickey)`. The key on
disk is passphrase-protected, so pointing `ssh -i` at it does not help. On macOS
the server recovers the agent socket with `launchctl getenv SSH_AUTH_SOCK` at
startup. On Linux, export `SSH_AUTH_SOCK` in the MCP client's own environment.

## Config

Overridable via environment variables:

`AMO_DROPLET_HOST` · `AMO_DROPLET_USER` · `AMO_DROPLET_PATH` · `AMO_PM2_APP`

## Install

```bash
cd tools/droplet-mcp && npm install
claude mcp add amo-droplet --scope user -- node "$PWD/server.mjs"
```

## Smoke test

Runs the read-only tools against production and checks that the guarded ones refuse:

```bash
node tools/droplet-mcp/smoke-test.mjs
```
