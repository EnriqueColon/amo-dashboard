"""
Verify the Broward publishing-lag warning counts business days, not calendar days.
---------------------------------------------------------------------------------
Why this test exists, and why business days specifically:

Broward publishes one day of records per business day, several days after the
fact. Until 2026-10-02 nothing measured that delay. Every daily run reported
`status=ok` and "✅ every day currently on the feed has been harvested" — both
TRUE, because we had harvested everything the county had published — while the
county's own lag doubled from ~3 days to ~6 around 23 Sep and Broward's figures
in the dashboard and the weekly email silently went a week stale. The job was
checking "are we up to date with the feed", never "is the feed up to date with
reality".

The arithmetic has to exclude weekends or the warning is useless. Measured in
calendar days, a feed that is a healthy 3 business days behind on Friday reads
as 5 days behind on Monday, so the warning would fire every single Monday — and
a warning that cries wolf weekly trains the reader to ignore the one that
matters. That is the same lesson record_run() in broward_images.py was written
for, and this test is here so it cannot be undone by someone "simplifying" the
date maths.

  collector/.venv/bin/python3 collector/tests/check_feed_lag.py

Needs no database and no network.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

from broward_images import business_days_between, MAX_FEED_LAG_BUSINESS_DAYS  # noqa: E402

failures = 0


def check(label, got, want):
    global failures
    if got == want:
        print(f'  PASS  {label}')
    else:
        failures += 1
        print(f'  FAIL  {label} — got {got}, want {want}')


print('\nBroward feed publishing lag\n')

# September 2026: 21st is a Monday, 25th a Friday, 26-27 the weekend,
# 28th a Monday. Every case below is anchored on those real weekdays.
check('Mon 21 -> Tue 22 is 1', business_days_between('2026-09-21', '2026-09-22'), 1)
check('Mon 21 -> Fri 25 is 4', business_days_between('2026-09-21', '2026-09-25'), 4)

# The weekend cases are the whole point: a Friday feed read on Monday is 1
# business day behind, not 3.
check('Fri 25 -> Mon 28 is 1 (not 3)', business_days_between('2026-09-25', '2026-09-28'), 1)
check('Fri 25 -> Sat 26 is 0', business_days_between('2026-09-25', '2026-09-26'), 0)
check('Fri 25 -> Sun 27 is 0', business_days_between('2026-09-25', '2026-09-27'), 0)

# The real incident. The feed's newest day was 25 Sep; by Thu 1 Oct that is 4
# business days, and by Mon 5 Oct it is 6 — over the threshold either way at the
# default of 5 on the Monday, which is when the owner would have been emailed
# figures that stopped on 25 Sep.
check('Fri 25 Sep -> Thu 1 Oct is 4', business_days_between('2026-09-25', '2026-10-01'), 4)
check('Fri 25 Sep -> Mon 5 Oct is 6', business_days_between('2026-09-25', '2026-10-05'), 6)
check(
    'the real incident trips the warning by Mon 5 Oct',
    business_days_between('2026-09-25', '2026-10-05') > MAX_FEED_LAG_BUSINESS_DAYS,
    True,
)
check(
    'a NORMAL ~3 business day lag does NOT warn',
    business_days_between('2026-09-25', '2026-09-30') > MAX_FEED_LAG_BUSINESS_DAYS,
    False,
)
# The Monday false alarm this test exists to prevent. A feed published Friday,
# read first thing Monday, is healthy and must stay silent.
check(
    'Friday feed read on Monday does NOT warn',
    business_days_between('2026-09-25', '2026-09-28') > MAX_FEED_LAG_BUSINESS_DAYS,
    False,
)

# Degenerate inputs: same day, and a feed somehow ahead of today. Neither should
# produce a negative number that compares as "fine" against the threshold.
check('same day is 0', business_days_between('2026-09-25', '2026-09-25'), 0)
check('end before start is 0', business_days_between('2026-09-25', '2026-09-20'), 0)

# Spanning a month boundary and several weekends, counted by hand:
# 28,29,30 Sep + 1,2 Oct = 5, then 5,6,7,8,9 Oct = 10.
check('Fri 25 Sep -> Fri 9 Oct is 10', business_days_between('2026-09-25', '2026-10-09'), 10)

print('')
if failures:
    print(f'check_feed_lag: {failures} FAILED\n')
    sys.exit(1)
print('check_feed_lag: all passed\n')
