"""
Verify canonicalize() still behaves exactly as it did when the baseline was cut.
--------------------------------------------------------------------------------
Needs NO database — it replays the inputs recorded in canonicalize_baseline.tsv.
Run it after any edit to normalize.py's naming logic:

  collector/.venv/bin/python3 collector/tests/check_canonicalize_baseline.py

Exit 0 = entity grouping unchanged (aom_events_clean and every dashboard tab
built on it are unaffected).  Exit 1 = something moved; the report lists what.

A failure is not automatically a bug — it is a prompt to review.  If the change
is intended, re-run gen_canonicalize_baseline.py and review the .tsv diff.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

import normalize  # noqa: E402

BASELINE = os.path.join(HERE, 'canonicalize_baseline.tsv')
SHOW = 25  # mismatches printed before truncating


def unesc(s: str) -> str:
    """Inverse of esc() in gen_canonicalize_baseline.py. Single left-to-right
    pass so an escaped backslash can't be re-interpreted as an escape char."""
    out, i = [], 0
    while i < len(s):
        if s[i] == '\\' and i + 1 < len(s):
            nxt = s[i + 1]
            out.append({'n': '\n', 'r': '\r', 't': '\t', '\\': '\\'}.get(nxt, '\\' + nxt))
            i += 2
        else:
            out.append(s[i])
            i += 1
    return ''.join(out)


def load_baseline() -> list[tuple[str, str]]:
    if not os.path.exists(BASELINE):
        print(f"ERROR: baseline not found: {BASELINE}")
        print("Generate it first: gen_canonicalize_baseline.py")
        sys.exit(1)
    pairs = []
    with open(BASELINE, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#'):
                continue
            line = line.rstrip('\n')
            if not line:
                continue
            raw, expected = line.split('\t', 1)
            pairs.append((unesc(raw), unesc(expected)))
    return pairs


def main():
    # Must match the generator: pure rules, no user merges.
    normalize._ALIAS_MAP = {}

    pairs = load_baseline()
    mismatches = [(raw, exp, got) for raw, exp in pairs
                  if (got := normalize.canonicalize(raw)) != exp]

    print(f"Checked {len(pairs):,} names against the baseline")

    if not mismatches:
        print("PASS — canonicalize() output is unchanged.")
        return 0

    # Collapsed vs split matters more than the raw count: a merge reduces the
    # number of distinct canonical names, a split increases it.
    before = len({exp for _, exp in pairs})
    after = len({normalize.canonicalize(raw) for raw, _ in pairs})

    print(f"FAIL — {len(mismatches):,} name(s) now canonicalize differently")
    print(f"Distinct canonical names: {before:,} → {after:,} ({after - before:+,})")
    print()
    for raw, exp, got in mismatches[:SHOW]:
        print(f"  {raw!r}")
        print(f"    was: {exp!r}")
        print(f"    now: {got!r}")
    if len(mismatches) > SHOW:
        print(f"  ... and {len(mismatches) - SHOW:,} more")
    print()
    print("If this change is intentional, re-run gen_canonicalize_baseline.py")
    print("and review the .tsv diff before committing.")
    return 1


if __name__ == '__main__':
    sys.exit(main())
