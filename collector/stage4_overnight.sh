#!/bin/bash
# Stage 4 production step, run ONCE overnight (owner: "do that overnight … without impacting
# today's usage", 27 Oct 2026). Removes MI_BASE_URL / MI_ANALYTICS_API_KEY from /opt/amo-dashboard/.env
# and from PM2's held environment, deploys the stage-4 code, verifies, and rolls back on any failure.
#
# Scheduled as a one-shot cron line (installed by hand, removed by this script at the end):
#   0 6 29 10 * /opt/amo-dashboard/collector/stage4_overnight.sh >> /opt/amo-dashboard/collector/stage4_overnight.log 2>&1
# History: the 28 Oct 2026 06:00 run switched, failed its own sign-in check and rolled back cleanly —
# verify() read AMO_PASSWORD from .env with `cut`, but .env stores values shell-quoted, so the test
# sign-in sent the wrong string. verify() now sources .env; --check proves the sign-in path first.
# 06:00 UTC = 02:00 Eastern (EDT). Nothing else runs then: backup 03:15, bank stress Sunday 03:00,
# nightly normalize 08:30 (which restarts PM2 afterwards — harmless, the dump will already be clean).
#
# Why not a plain `pm2 restart --update-env`: PM2 merges the shell environment INTO the one it holds
# and never drops a variable, so the only way to remove one is delete + fresh start. The fresh start
# gets exactly the environment PM2 holds today minus the two MI_* keys — read from `pm2 env` at run
# time, so OPENAI_API_KEY / AMO_DB_PATH / PORT / NODE_ENV (which live in PM2 but not in .env) survive.
#
#   ./stage4_overnight.sh --check   preconditions only, changes nothing (run this before scheduling)
#   ./stage4_overnight.sh           the real thing

set -u
APP=/opt/amo-dashboard
TS=$(date -u +%Y%m%dT%H%M%SZ)
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
KEEP_KEYS="AMO_PASSWORD AMO_SECRET AMO_BIND_HOST AMO_DB_PATH OPENAI_API_KEY PORT NODE_ENV"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "FAILED: $*"; exit 1; }

pm2_env_value() {  # by process NAME, so a renumbered id after delete+start cannot fool it
    pm2 jlist 2>/dev/null | python3 -c '
import json, sys
k = sys.argv[1]
ps = [p for p in json.load(sys.stdin) if p.get("name") == "amo-dashboard"]
v = ps[0]["pm2_env"].get(k, "") if ps else ""
print(v if isinstance(v, str) else json.dumps(v))' "$1"
}

cd "$APP" || die "cannot cd $APP"
log "=== stage 4 overnight $([ "$CHECK" = 1 ] && echo '(CHECK MODE) ')start — HEAD $(git log --oneline -1)"

# ── preconditions ────────────────────────────────────────────────────────────
pgrep -f "normalize.p[y]" >/dev/null && die "a normalize rebuild is running — not touching PM2"
for k in $KEEP_KEYS; do
    v=$(pm2_env_value "$k")
    [ -n "$v" ] || die "PM2 does not hold $k — refusing to rebuild its environment"
done
[ -n "$(pm2_env_value MI_BASE_URL)" ] || log "note: PM2 already holds no MI_BASE_URL"
grep -q "^MI_BASE_URL=" .env && log ".env holds MI_BASE_URL (will be removed)" || log "note: .env has no MI_BASE_URL line"
[ -s dist/index.cjs ] || die "dist/index.cjs missing"
git fetch -q origin main || die "git fetch failed"
TARGET=$(git rev-parse origin/main)
log "origin/main = ${TARGET:0:7}; local = $(git rev-parse --short HEAD)"
git merge-base --is-ancestor HEAD "$TARGET" || die "local HEAD is not an ancestor of origin/main — someone committed on the droplet"
if [ "$CHECK" = 1 ]; then
    # Prove the verification itself against the running server: the 28 Oct 06:00 run
    # failed only because verify() read a shell-quoted password with `cut`.
    if verify; then
        log "CHECK OK: verify() passes against the current server (sign-in 302, all API families 200); PM2 holds $KEEP_KEYS; would pull to ${TARGET:0:7}, drop MI_* from .env and PM2, build, restart fresh, verify."
        exit 0
    else
        die "CHECK FAILED: verify() does not pass against the CURRENT server — fix that before scheduling"
    fi
fi

# ── capture current state for rollback ───────────────────────────────────────
cp .env ".env.before_stage4.$TS" && chmod 600 ".env.before_stage4.$TS"
cp dist/index.cjs "/root/index.cjs.before_stage4.$TS"
PREV_HEAD=$(git rev-parse HEAD)
declare -A KEEP
for k in $KEEP_KEYS; do KEEP[$k]=$(pm2_env_value "$k"); done
OLD_MI_BASE=$(pm2_env_value MI_BASE_URL); OLD_MI_KEY=$(pm2_env_value MI_ANALYTICS_API_KEY)
log "captured .env, dist and PM2 env (backups: .env.before_stage4.$TS, /root/index.cjs.before_stage4.$TS)"

start_pm2() {  # $1 = "with-mi" | "without-mi"
    pm2 delete amo-dashboard >/dev/null 2>&1 || true
    (
        for k in $KEEP_KEYS; do export "$k=${KEEP[$k]}"; done
        if [ "$1" = "with-mi" ]; then export MI_BASE_URL="$OLD_MI_BASE" MI_ANALYTICS_API_KEY="$OLD_MI_KEY"; fi
        pm2 start dist/index.cjs --name amo-dashboard --cwd "$APP" >/dev/null
    ) || return 1
    pm2 save >/dev/null 2>&1
    sleep 5
}

env_password() {  # .env stores values shell-quoted (shlex.quote), so SOURCE it rather than cut the line
    ( set -a; . "$APP/.env" 2>/dev/null; set +a; printf '%s' "${AMO_PASSWORD:-}" )
}

verify() {
    pm2 describe amo-dashboard 2>/dev/null | grep -q "online" || { log "verify: PM2 not online"; return 1; }
    for k in $KEEP_KEYS; do [ -n "$(pm2_env_value "$k")" ] || { log "verify: PM2 lost $k"; return 1; }; done
    local J; J=$(mktemp)
    local pw; pw=$(env_password)
    [ -n "$pw" ] || { log "verify: could not read AMO_PASSWORD from .env"; rm -f "$J"; return 1; }
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/login); [ "$code" = 200 ] || { log "verify: GET /login $code"; rm -f "$J"; return 1; }
    code=$(curl -s -c "$J" -o /dev/null -w "%{http_code}" --data-urlencode "password=$pw" http://127.0.0.1/login); [ "$code" = 302 ] || { log "verify: sign-in $code"; rm -f "$J"; return 1; }
    for u in api/fdic/meta api/bank-stress/meta api/chat/config api/entity-nodes?limit=1; do
        code=$(curl -s -b "$J" -o /dev/null -w "%{http_code}" "http://127.0.0.1/$u"); [ "$code" = 200 ] || { log "verify: /$u $code"; rm -f "$J"; return 1; }
    done
    curl -s -b "$J" http://127.0.0.1/api/chat/config | grep -q '"configured":true' || { log "verify: chat not configured (OPENAI_API_KEY lost?)"; rm -f "$J"; return 1; }
    rm -f "$J"
    return 0
}

remove_cron_line() {
    crontab -l > "$APP/collector/crontab.before_stage4_cleanup.$TS" 2>/dev/null || true
    crontab -l 2>/dev/null | grep -v "stage4_overnight.sh" | crontab -
}

rollback() {
    log "ROLLING BACK: $*"
    cp ".env.before_stage4.$TS" .env
    cp "/root/index.cjs.before_stage4.$TS" dist/index.cjs
    git reset -q --hard "$PREV_HEAD"
    start_pm2 with-mi
    if verify; then log "rollback verified: previous code, env and bundle are serving"; else log "ROLLBACK VERIFY FAILED — manual attention needed (pm2 resurrect from /root/.pm2/dump.pm2, .env.before_stage4.$TS)"; fi
    # The schedule is a one-shot date; left in place it would fire again next year.
    remove_cron_line
    exit 1
}

# ── the change ───────────────────────────────────────────────────────────────
git checkout -- package-lock.json 2>/dev/null || true
git pull --ff-only -q origin main || rollback "git pull failed"
log "pulled: $(git log --oneline -1)"
sed -i '/^MI_BASE_URL=/d;/^MI_ANALYTICS_API_KEY=/d' .env
log ".env: MI_* lines removed ($(grep -c . .env) lines left)"
npm run build >/tmp/stage4_build.log 2>&1 || rollback "npm run build failed (see /tmp/stage4_build.log)"
[ -s dist/index.cjs ] || rollback "build produced no dist/index.cjs"
log "built dist/index.cjs $(stat -c %s dist/index.cjs) bytes"
start_pm2 without-mi || rollback "pm2 start failed"
[ -z "$(pm2_env_value MI_BASE_URL)" ] || rollback "PM2 still holds MI_BASE_URL after the fresh start"
verify || rollback "post-start verification failed"
log "PM2 online; app env keys now: $(pm2 jlist | python3 -c 'import json,sys;ps=[p for p in json.load(sys.stdin) if p["name"]=="amo-dashboard"];e=ps[0]["pm2_env"];print(" ".join(sorted(k for k in e if k.startswith(("AMO_","MI_","OPENAI_")) or k in ("PORT","NODE_ENV"))))')"
curl -s -o /dev/null -w "old proxy /api/mi/meta now answers %{http_code} %{content_type}\n" http://127.0.0.1/api/mi/meta

# ── remove own cron line ─────────────────────────────────────────────────────
remove_cron_line
log "one-shot cron line removed"
log "=== stage 4 overnight DONE — exit 0"
exit 0
