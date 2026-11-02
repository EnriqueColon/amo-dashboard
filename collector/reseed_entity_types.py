#!/usr/bin/env python3
"""
Put back AI entity types that a rebuild erased, from a backup taken before it.
-----------------------------------------------------------------------------
The nightly rebuild used to overwrite every AI verdict with the rule result
(fixed in normalize.py on 2 Nov 2026 - see docs/audit_2026-10-31/ACCURACY_AUDIT.md,
finding F1). The fix protects FUTURE rebuilds; it cannot bring back what a past
one erased. This copies the erased verdicts out of a backup so that the next
normalize.py run keeps them, instead of waiting for Friday's job to ask the AI
about ~10,000 entities again.

It writes ONLY entity_classifications, and only a row that is, today, an
unplaced entity:

    live row: confidence_source IN ('default','regex_rule') AND category = 'OTHER'
              (or no row at all)
    backup:   confidence_source = 'llm' AND category <> 'OTHER'

So it never overwrites an FDIC match, a banking/trust/GSE signal, a behavioural
verdict, a code override, a dashboard override ('user_override'), or a verdict
the AI has since changed. Re-running it is a no-op.

    # what would change, nothing written
    AMO_DB_PATH=... python3 reseed_entity_types.py --backup /path/to/backup.db

    # apply
    AMO_DB_PATH=... python3 reseed_entity_types.py --backup /path/to/backup.db --apply

Then run normalize.py (it reads these rows as 'llm' and applies them) and restart
the app to clear the 7-day cache.
"""
import argparse
import os
import sqlite3
import sys
from collections import Counter

DB_PATH = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')
VALID = {'BANK', 'SERVICER', 'PRIVATE_CREDIT', 'GSE', 'MERS', 'TRUST'}   # OTHER is never restored


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--backup', required=True, help='uncompressed backup .db taken before the erase')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.backup):
        print(f'backup not found: {args.backup}', file=sys.stderr)
        return 1
    bk = sqlite3.connect(f'file:{args.backup}?mode=ro', uri=True)
    verdicts = {n: c for n, c in bk.execute(
        "SELECT name, category FROM entity_classifications WHERE confidence_source='llm' AND category <> 'OTHER'")
        if c in VALID}
    print(f'backup holds {len(verdicts):,} AI verdicts (non-OTHER)')

    conn = sqlite3.connect(DB_PATH, timeout=120)
    live = {n: (c, s) for n, c, s in conn.execute(
        "SELECT name, category, confidence_source FROM entity_classifications")}

    todo, skipped = [], Counter()
    for name, cat in verdicts.items():
        row = live.get(name)                      # (category, confidence_source) or None
        if row is None:
            todo.append((name, cat, 'new'))
        elif row[0] == 'OTHER' and (row[1] is None or row[1] in ('default', 'regex_rule')):
            todo.append((name, cat, 'was OTHER'))
        else:
            skipped[row[1] or '(no source)'] += 1
    print(f'would restore {len(todo):,} (not present: {sum(1 for t in todo if t[2]=="new"):,}, '
          f'currently OTHER/default: {sum(1 for t in todo if t[2]=="was OTHER"):,})')
    print('left alone because the live row is already decided by something else:',
          dict(skipped.most_common(8)))
    print('restored by type:', dict(Counter(c for _, c, _ in todo).most_common()))

    if not args.apply:
        print('\nDRY RUN - nothing written. Add --apply to write.')
        return 0

    conn.executemany("""
        INSERT INTO entity_classifications (name, category, confidence_source)
        VALUES (?, ?, 'llm')
        ON CONFLICT(name) DO UPDATE SET category = excluded.category, confidence_source = 'llm'
        WHERE entity_classifications.category = 'OTHER'
          AND COALESCE(entity_classifications.confidence_source, 'default') IN ('default', 'regex_rule')
    """, [(n, c) for n, c, _ in todo])
    conn.commit()
    after = Counter(s for (s,) in conn.execute("SELECT COALESCE(confidence_source,'(none)') FROM entity_classifications"))
    print(f'applied. classification sources now: {dict(after.most_common(6))}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
