"""
Verify canonicalize() treats an internal comma as punctuation, not content.
---------------------------------------------------------------------------
The county index places commas inconsistently in the same name, and until
2026-09-23 canonicalize() stripped only TRAILING punctuation. So
"CITY NATIONAL BANK, OF FLORIDA" and "CITY NATIONAL BANK OF FLORIDA" survived
as two separate entities that no amount of suffix stripping could reunite —
the bank's own Credit Facilities ranking was split across two rows.

Measured against production on 2026-09-23: the fix merges 33 entities in 32
groups out of 26,208, every one manually confirmed to be the same real party,
plus the lender brand above. It cannot fabricate an entity the way the old
leading-digit strip did (see check_leading_numbers.py), because it only ever
merges names that are ALREADY identical apart from commas.

  collector/.venv/bin/python3 collector/tests/check_internal_commas.py

Needs no database and no network.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

from normalize import canonicalize, facility_brand_key  # noqa: E402

# Pairs that must reach ONE canonical name. Every string here is a real form
# taken from production, not invented — an invented spelling tests a string
# that never occurs.
MERGES = [
    ('the reported bug: a lender brand split in two',
     ['CITY NATIONAL BANK OF FLORIDA', 'CITY NATIONAL BANK, OF FLORIDA']),
    ('comma before a legal suffix',
     ['NEXBANK SSB', 'NEXBANK, SSB']),
    ('comma before a descriptive phrase',
     ['WASHINGTON MUTUAL BANK FA', 'WASHINGTON MUTUAL BANK, FA']),
    ('comma before "OF"',
     ['EQUICREDIT OF AMERICA', 'EQUICREDIT, OF AMERICA']),
    ('trust series designator',
     ['HEADLANDS RESIDENTIAL SERIES OWNER TRUST SERIES E',
      'HEADLANDS RESIDENTIAL SERIES OWNER TRUST, SERIES E']),
    # This is the case that forces comma -> SPACE rather than comma -> deleted.
    # entity_names.squash() deletes, which would give "HERNANDEZROLANDO" and
    # miss the spaced form entirely.
    ('surname,firstname recorded with no space after the comma',
     ['HERNANDEZ ROLANDO', 'HERNANDEZ,ROLANDO']),
    ('three spellings of one IRA custodian',
     ['PACIFIC PREMIER TRUST CUSTODIAN FBO ALAN FISKE IRA',
      'PACIFIC PREMIER TRUST, CUSTODIAN, FBO ALAN FISKE IRA',
      'PACIFIC PREMIER TRUST, CUSTODIAN,FBO ALAN FISKE IRA']),
    # "3415, LLC" strips to a bare number, which trips the all-digits guard and
    # restores the pre-suffix form. Both spellings must restore to the SAME one.
    ('numeric company name where the suffix guard fires',
     ['3415 LLC', '3415, LLC']),
]

# Names that must stay APART. Removing commas must not reach across a real
# distinction — these are the cases that would prove the change too broad.
SPLITS = [
    ('street-numbered property LLCs stay distinct',
     ['10820 INVESTMENTS LLC', '11140 INVESTMENTS LLC', '1260 INVESTMENTS INC']),
    ('different banks sharing a leading word',
     ['CITY NATIONAL BANK OF FLORIDA', 'CITY NATIONAL BANK OF NEW JERSEY']),
    ('a comma does not erase a different surname',
     ['HERNANDEZ,ROLANDO', 'HERNANDEZ,ROBERTO']),
]


def main() -> int:
    failures = []

    for label, names in MERGES:
        canon = {canonicalize(n) for n in names}
        if len(canon) != 1:
            failures.append(f'{label}: {len(names)} spellings gave '
                            f'{len(canon)} canonical names: {sorted(canon)}')

    for label, names in SPLITS:
        canon = {canonicalize(n) for n in names}
        if len(canon) != len(names):
            failures.append(f'{label}: {len(names)} distinct parties collapsed '
                            f'to {len(canon)}: {sorted(canon)}')

    # The reported bug travelled through facility_brand_key(), not canonicalize()
    # directly, so assert the real code path too — it is what writes
    # credit_facility_events.lender_brand.
    brands = {facility_brand_key(n) for n in
              ('CITY NATIONAL BANK OF FLORIDA', 'CITY NATIONAL BANK, OF FLORIDA')}
    if len(brands) != 1:
        failures.append(f'facility_brand_key still splits the lender: {sorted(brands)}')

    print(f'  · {len(MERGES)} merge groups and {len(SPLITS)} split groups checked')
    print('  · plus the facility_brand_key path that carried the reported bug')
    print('  · no database and no network needed')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ internal commas are punctuation, not content')
    return 0


if __name__ == '__main__':
    sys.exit(main())
