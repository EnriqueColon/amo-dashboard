#!/usr/bin/env bash
#
# Keeps docs/CONFLUENCE_AMO_DASHBOARD.md from going stale.
#
# Wired to two Claude Code hook events (see .claude/settings.json):
#
#   SessionStart  →  records the HEAD sha the session began at
#   Stop          →  if the session changed repo files but never touched the
#                    Confluence doc, blocks the stop once and asks for it
#
# The reminder fires AT MOST ONCE per session (marker file in $TMPDIR), so it
# can never loop, and it stays silent when the session changed nothing, changed
# only the doc/session log, or only touched the SQLite artifacts.
#
# Test it by hand:
#   echo '{"session_id":"test"}' | .claude/hooks/session-doc-reminder.sh Stop
#   rm -f "${TMPDIR:-/tmp}"/amo-doc-reminder/test.*
#
set -u

DOC="docs/CONFLUENCE_AMO_DASHBOARD.md"
LOG="SESSION_LOG.md"

# Repo root, resolved from this script's own location (.claude/hooks/ → repo).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

EVENT="${1:-Stop}"
PAYLOAD="$(cat 2>/dev/null || true)"
SESSION="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)"

STATE="${TMPDIR:-/tmp}/amo-doc-reminder"
mkdir -p "$STATE" 2>/dev/null || exit 0
BASE_FILE="$STATE/$SESSION.base"
DONE_FILE="$STATE/$SESSION.done"

cd "$REPO" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# ── SessionStart: just remember where we started ─────────────────────────────
if [ "$EVENT" = "SessionStart" ]; then
    git rev-parse HEAD > "$BASE_FILE" 2>/dev/null || : > "$BASE_FILE"
    # Opportunistic cleanup of markers older than a week.
    find "$STATE" -type f -mtime +7 -delete 2>/dev/null || true
    exit 0
fi

# ── Stop: decide whether to ask for a doc refresh ────────────────────────────
[ -f "$DONE_FILE" ] && exit 0          # already reminded in this session

BASE="$(cat "$BASE_FILE" 2>/dev/null || true)"
HEAD_NOW="$(git rev-parse HEAD 2>/dev/null || true)"

# Everything this session touched: commits made since it started, plus whatever
# is still uncommitted. If SessionStart never ran (hook added mid-session), the
# commit half is simply empty and the working tree still counts.
CHANGED=""
if [ -n "$BASE" ] && [ -n "$HEAD_NOW" ] && [ "$BASE" != "$HEAD_NOW" ]; then
    CHANGED="$(git diff --name-only "$BASE" "$HEAD_NOW" 2>/dev/null || true)"
fi
CHANGED="$CHANGED
$(git status --porcelain 2>/dev/null | awk '{print $NF}')"

# Did the session already update the doc? Then there is nothing to nag about.
printf '%s\n' "$CHANGED" | grep -qxF "$DOC" && exit 0

# Real work = anything that is not the doc, the session log, or a DB artifact.
WORK="$(printf '%s\n' "$CHANGED" \
    | sed '/^[[:space:]]*$/d' \
    | grep -vE '\.db(-shm|-wal)?$' \
    | grep -vxF "$DOC" \
    | grep -vxF "$LOG" \
    | sort -u || true)"

[ -z "$WORK" ] && exit 0               # nothing substantive happened

: > "$DONE_FILE"

FILES="$(printf '%s\n' "$WORK" | head -12 | sed 's/^/  - /')"
EXTRA=""
[ "$(printf '%s\n' "$WORK" | wc -l | tr -d ' ')" -gt 12 ] && EXTRA="
  … and more"

REASON="This session changed repo files but did not update $DOC.

Changed:
$FILES$EXTRA

Before finishing, refresh the Confluence page so it stays the current picture of
the tool:
  1. Update whichever sections this change affects — description, how-to-use,
     architecture, developer maintenance/runbooks.
  2. ALWAYS re-check section 7 'Current status': production numbers, the
     component status table, known gaps, and the risk register.
  3. Bump the 'Last reviewed' date in the header.
  4. Append a dated entry to $LOG as usual.
  5. Commit and push both.

If this change genuinely does not affect the documentation (a scratch file, a
revert, an aborted experiment), say so in one line and stop — this reminder
fires only once per session."

jq -n --arg r "$REASON" '{decision:"block", reason:$r}'
