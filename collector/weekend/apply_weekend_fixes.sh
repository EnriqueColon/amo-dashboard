#!/bin/bash
# P4 of the weekend run (run_weekend.sh): apply the owner-confirmed QC fixes
# 1-6 (docs/qc/QC_FIX_LIST_2026-09-17.md, "confirm all" on 18 Sep 2026) in ONE
# rebuild. Exits non-zero on the first problem; run_weekend.sh then stops and
# the Monday email does not send.
#
#   1. deploy the fix commit (fast-forward only) and rebuild the web bundle
#   2. guardrail tests, offline and against the live database
#   3. fix 6: read the few documents the lending-relationship reader created
#      ahead of the main reader (capped at $1)
#   4. DRY RUN on a copy of the live database; check the numbers moved the way
#      the fix list says. A failure here leaves production untouched.
#   5. the real rebuild on production, the same checks again, restart the app
#
# The fixes themselves are permanent code in normalize.py and
# document_direction.py, so every later nightly rebuild keeps them.
set -u
APP=/opt/amo-dashboard
C=$APP/collector
PY=$C/.venv/bin/python3
DB=$APP/miami_dade_amo.db
DRY=$APP/weekend_dryrun.db
BK=$APP/backups
say() { echo "$(date -u +%FT%TZ) [apply] $*"; }
die() { say "FAIL: $*"; exit 1; }
cd $APP || exit 1
set -a; . ./.env; set +a

# ── 1. deploy ────────────────────────────────────────────────────────────────
say "1/5 deploy"
# This script is placed on the droplet before the commit that tracks it is
# pulled; git refuses to overwrite an untracked file. Bash keeps reading the
# open copy, so removing it here is safe.
git ls-files --error-unmatch collector/weekend/apply_weekend_fixes.sh >/dev/null 2>&1 \
    || rm -f collector/weekend/apply_weekend_fixes.sh
git fetch -q origin && git merge -q --ff-only origin/main || die "git fast-forward failed"
grep -q "def text_verdict" $C/document_direction.py || die "fix commit not present"
say "at $(git log --oneline -1)"
npm run build >/tmp/weekend_build.log 2>&1 || die "npm run build (see /tmp/weekend_build.log)"

# ── 2. tests ─────────────────────────────────────────────────────────────────
say "2/5 guardrail tests"
$PY $C/document_direction.py || die "document_direction self-test"
for t in $C/tests/check_*.py; do
    case $t in *check_extraction_completeness.py) continue ;; esac   # fixed in step 3
    AMO_DB_PATH=$DB $PY "$t" >/tmp/weekend_test.log 2>&1 || { cat /tmp/weekend_test.log; die "$(basename $t)"; }
done
say "tests pass"

# ── 3. fix 6 ─────────────────────────────────────────────────────────────────
say "3/5 reading documents the main reader has not read yet"
(cd $C && AMO_DB_PATH=$DB $PY -u extract_pdfs.py --limit 20 --county MIAMI-DADE --budget 1) 2>&1 | tail -4
AMO_DB_PATH=$DB $PY $C/tests/check_extraction_completeness.py | tail -3 \
    || say "note: completeness check still lists rows (the lending-relationship reader creates them daily; not blocking)"

# ── never overlap the nightly rebuild (08:30 UTC) ────────────────────────────
wait_clear() {
    while pgrep -f "[n]ormalize.py" >/dev/null || { h=$(date -u +%H%M); [ "$h" -ge 0630 ] && [ "$h" -lt 1030 ]; }; do
        sleep 120
    done
}

# ── numbers the fixes must produce ───────────────────────────────────────────
check_numbers() {   # $1 = database
    AMO_DB_PATH="$1" $PY - <<'EOF'
import os, sqlite3, sys
c = sqlite3.connect(f"file:{os.environ['AMO_DB_PATH']}?mode=ro", uri=True)
one = lambda q: c.execute(q).fetchone()[0]
checks = []
def chk(name, ok, val): checks.append((name, ok, val)); print(f"  {'ok  ' if ok else 'FAIL'} {name}: {val}")
total = one("SELECT COUNT(*) FROM aom_events_clean")
chk('loan transfers present', total > 50000, total)
sw = one("SELECT COUNT(*) FROM direction_decisions WHERE action='SWAPPED'")
chk('direction: rows swapped to the document order (expect ~6,500-7,600)', 5000 <= sw <= 8500, sw)
rv = one("SELECT COUNT(*) FROM direction_decisions WHERE needs_review=1")
chk('direction: rows flagged for review (expect < 3,000)', rv < 3000, rv)
top = c.execute("""SELECT assignor_canon, assignee_canon, COUNT(*) n FROM aom_events_clean
                   WHERE assignor_canon IN ('WELLS FARGO','NATIONSTAR / MR. COOPER')
                     AND assignee_canon IN ('WELLS FARGO','NATIONSTAR / MR. COOPER')
                   GROUP BY 1,2""").fetchall()
d = {(a, b): n for a, b, n in top}
wf, ns = d.get(('WELLS FARGO', 'NATIONSTAR / MR. COOPER'), 0), d.get(('NATIONSTAR / MR. COOPER', 'WELLS FARGO'), 0)
chk('direction: Wells Fargo -> Nationstar now outnumbers the reverse', wf > ns, f'WF->NS {wf}, NS->WF {ns}')
mm = one("SELECT COUNT(*) FROM aom_events_clean WHERE txn_type='MARKET_TRANSFER' AND (assignor_canon='MERS' OR assignee_canon='MERS')")
chk('MERS: no MERS filing counted as a market sale', mm == 0, mm)
mt = one("SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon='MERS' AND assignor_type!='MERS'")
chk('MERS: typed MERS everywhere', mt == 0, mt)
import re; sys.path.insert(0, '/opt/amo-dashboard/collector')
from normalize import _looks_like_person
ho = sum(1 for a, pa in c.execute(
            "SELECT assignor, pdf_assignor FROM aom_events_clean WHERE county='MIAMI-DADE' AND pdf_assignor IS NOT NULL")
         if a and _looks_like_person(a) and re.search(r'ELECTRONIC REGISTRATION|\bMERS\b', pa, re.I))
chk('homeowner: rows still showing a person where the document names MERS (was 4,330)', ho < 500, ho)
self_ = one("SELECT COUNT(*) FROM aom_events_clean WHERE txn_type='SELF_ASSIGN'")
chk('no burst of fake self-transfers (was 3,561)', self_ < 4200, self_)
for name in ('FACEBANK INTERNATIONAL', 'RUSHMORE LOAN MANAGEMENT SERVICES', 'HOMEBRIDGE FINANCIAL SERVICES'):
    n = one(f"SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon='{name}' OR assignee_canon='{name}'")
    chk(f'merge: {name} present under one name', n > 0, n)
left = one("""SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon IN
             ('FACEBANK INTL','FACE BANK INTERNATIONAL','INTERNATIONAL FACEBANK','HOMEBRIDGE FINCANCIAL SERVICES',
              'RUSHMORE LOAN MGMT SERV','RUSHMORE LOAN MGMT SERVICES','WILMINGTON SAVING FUND SOCIETY')""")
chk('merge: old spellings gone', left == 0, left)
fb = one("SELECT COUNT(*) FROM aom_events_clean WHERE assignee_canon='FACEBANK INTERNATIONAL' AND assignee_type!='BANK'")
chk('types: FaceBank typed BANK', fb == 0, fb)
sys.exit(0 if all(ok for _, ok, _ in checks) else 1)
EOF
}

# ── 4. dry run on a copy ─────────────────────────────────────────────────────
say "4/5 dry run on a copy of the live database"
wait_clear
rm -f $DRY
sqlite3 $DB "VACUUM INTO '$DRY'" || die "copy for dry run"
(cd $C && AMO_DB_PATH=$DRY $PY -u normalize.py) > /tmp/weekend_dryrun.log 2>&1 \
    || { tail -30 /tmp/weekend_dryrun.log; die "dry-run rebuild failed — production untouched"; }
grep -E "Direction:|aom_events_clean:" /tmp/weekend_dryrun.log
check_numbers $DRY || die "dry-run numbers off — production untouched (copy kept at $DRY)"
say "dry run ok"

# ── 5. production ────────────────────────────────────────────────────────────
say "5/5 production rebuild"
mkdir -p $BK
sqlite3 $DB "VACUUM INTO '$BK/pre_weekend_fixes_$(date -u +%Y%m%d%H%M).db'" || die "pre-rebuild backup"
wait_clear
(cd $C && AMO_DB_PATH=$DB $PY -u normalize.py) > /tmp/weekend_normalize.log 2>&1 \
    || { tail -30 /tmp/weekend_normalize.log; die "production rebuild failed"; }
grep -E "Direction:|aom_events_clean:" /tmp/weekend_normalize.log
check_numbers $DB || die "production numbers off after rebuild — backup in $BK"
pm2 restart amo-dashboard >/dev/null || die "pm2 restart"
rm -f $DRY
say "APPLIED — fixes 1-6 live"
