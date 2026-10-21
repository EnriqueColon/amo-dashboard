"""
Guardrail: the completeness verdict is decided by INSTRUMENTS, never by counts.

Before 21 Oct 2026 the daily check compared per-day counts. Two things that
cost real documents show why that is not enough:

  * equal counts can hide a swap — one document we hold that the county no
    longer lists under that day, one it lists that we never got;
  * a count one short can be nothing — the county lists some documents under
    two types (an AMO also returned as ASG) and we store one row per
    instrument, so the per-type count sits below the county's while every
    document is present.

classify() takes the county's instrument set, the subset of it we hold
anywhere, and our per-type row count, and must:
  1. say SHORT, naming the instruments, whenever the county lists one we hold
     nowhere — even if the counts are equal;
  2. say OK with a note when the count is short but every instrument is held;
  3. say AHEAD when we hold more than the county lists (feeds re-send
     corrections) and nothing is missing;
  4. say OK, no note, on an exact match — including the empty day.

Run:  collector/.venv/bin/python3 collector/tests/check_reconcile_sets.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reconcile_counties import classify, OK, SHORT, AHEAD  # noqa: E402

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


def main() -> int:
    county = {'2026R1', '2026R2', '2026R3'}

    print('1. a missing instrument is SHORT even when counts agree')
    v, missing, note = classify(county, {'2026R1', '2026R2'}, ours=3)   # we hold 3 rows, but not R3
    check('  verdict SHORT', v, SHORT)
    check('  names the instrument', missing, ['2026R3'])
    check('  note says missing', (note or '').startswith('missing 1'), True)

    print('2. count short but every instrument held is OK with a note')
    v, missing, note = classify(county, county, ours=2)
    check('  verdict OK', v, OK)
    check('  nothing missing', missing, [])
    check('  note explains the dual listing', 'held under another type or date' in (note or ''), True)

    print('3. holding more than the county lists is AHEAD, not a failure')
    v, missing, note = classify(county, county, ours=4)
    check('  verdict AHEAD', v, AHEAD)
    check('  nothing missing', missing, [])

    print('4. exact match is OK with no note')
    v, missing, note = classify(county, county, ours=3)
    check('  verdict OK', v, OK)
    check('  no note', note, None)
    v, missing, note = classify(set(), set(), ours=0)
    check('  an empty day is OK', v, OK)

    print('5. missing instruments are reported sorted and capped in the note')
    big = {f'2026R{i:06d}' for i in range(1, 41)}
    v, missing, note = classify(big, set(), ours=0)
    check('  all 40 named in the list', len(missing), 40)
    check('  list is sorted', missing == sorted(missing), True)
    check('  note shows the count and a sample', note.startswith('missing 40:') and note.count('2026R') == 10, True)

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
