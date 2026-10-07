"""
Verify canonicalize() strips bare COMPANY, LIMITED and a spaced "L P".
----------------------------------------------------------------------
CORPORATION, INCORPORATED, LTD, CO and LP were all in STRIP_SUFFIXES; bare
COMPANY and bare LIMITED were not, and `\\bCO\\.?\\b` cannot reach COMPANY
across a word boundary. Every firm the county recorded both ways therefore
stayed split, with no path for suffix stripping to reunite it — Bank of New
York Mellon Trust broke 179/178, Northern Trust 179/88, MCLP Asset 486/130.

This is the same class of defect as the truncated-name split the owner reported
on 2 Oct 2026 ("CITY NATIONAL BANK OF FLORIDA" vs "CITY NATIONAL BANK") and the
same class the 2026-09-23 comma fix closed — a word the index includes
inconsistently and canonicalize() treated as brand content.

Measured against production 2026-10-07 over all 45,262 distinct recorded names:
113 collision groups, 119 canonical names merged away, every group read and
confirmed to be one real company.

The SPLITS block is the half that matters. Two failure modes are silent here:

  1. "LIMITED PARTNERSHIP" stripped word by word leaves a dangling
     "... PARTNERSHIP", which splits a firm a second way instead of merging it.
     Only stripping the phrase whole, BEFORE bare LIMITED, gathers all seven
     Cardinal Financial spellings.
  2. A geographic qualifier is NOT a legal suffix. "CITY NATIONAL BANK" and
     "CITY NATIONAL BANK OF FLORIDA" are two different real banks (the former
     is the Los Angeles one), so the owner's own example is the member of the
     class that must NOT be merged. Nothing here may reach it.

  collector/.venv/bin/python3 collector/tests/check_company_suffix.py

Needs no database and no network.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)

from normalize import canonicalize, classify_canonical  # noqa: E402

# Spellings that must reach ONE canonical name. Every string is a real form
# taken from production, not invented.
MERGES = [
    ('the widest split found — a near-even 179/178 break',
     ['BANK OF NEW YORK MELLON TRUST COMPANY', 'BANK OF NEW YORK MELLON TRUST']),
    ('bare COMPANY on a bank',
     ['NORTHERN TRUST COMPANY', 'NORTHERN TRUST']),
    ('bare COMPANY on an insurer',
     ['METROPOLITAN LIFE INSURANCE COMPANY', 'METROPOLITAN LIFE INSURANCE']),
    ('bare COMPANY on a lender',
     ['SUN WEST MORTGAGE COMPANY', 'SUN WEST MORTGAGE']),
    ('COMPANY mid-name, not trailing',
     ['UNITED GUARANTY RESIDENTIAL INSURANCE COMPANY OF NORTH CAROLINA',
      'UNITED GUARANTY RESIDENTIAL INSURANCE OF NORTH CAROLINA']),
    ('bare LIMITED',
     ['UNITED NORTHERN MORTGAGE BANKERS LIMITED', 'UNITED NORTHERN MORTGAGE BANKERS']),
    ('spaced L P, which neither \\bLP\\b nor \\bL\\.P\\.\\b could reach',
     ['GIMLET HOLDINGS L P', 'GIMLET HOLDINGS']),
    ('LP recorded three ways',
     ['PROVIDENT FUNDING ASSOCIATES L P', 'PROVIDENT FUNDING ASSOCIATES LP',
      'PROVIDENT FUNDING ASSOCIATES L.P.', 'PROVIDENT FUNDING ASSOCIATES']),
    # The ordering case. If bare LIMITED is applied before the phrase, these
    # land on "CARDINAL FINANCIAL PARTNERSHIP" and the firm stays split in two.
    ('all seven Cardinal Financial spellings, the LIMITED PARTNERSHIP ordering',
     ['CARDINAL FINANCIAL', 'CARDINAL FINANCIAL COMPANY',
      'CARDINAL FINANCIAL LIMITED PARTNERSHIP',
      'CARDINAL FINANCIAL COMPANY LIMITED PARTNERSHIP',
      'CARDINAL FINANCIAL COMPANY LIMITED',
      'CARDINAL FINANCIAL L P', 'CARDINAL FINANCIAL COMPANY L P']),
    ('the three NWL Company spellings',
     ['NWL COMPANY LLC', 'NWL CO LLC', 'NWL COMPANY INC']),
]

# Spellings that must stay APART. These are the cases that would prove the
# change too broad.
SPLITS = [
    # The owner's reported example, and the reason it is not fixed by this
    # change: "OF FLORIDA" is a geographic qualifier, and City National Bank
    # (Los Angeles) is a different real bank from City National Bank of Florida.
    ('a geographic qualifier is not a legal suffix',
     ['CITY NATIONAL BANK', 'CITY NATIONAL BANK OF FLORIDA']),
    ('COMPANY is not a series designator',
     ['PFP HOLDING COMPANY VI', 'PFP HOLDING COMPANY VII']),
    ('firms sharing a prefix stay distinct once the suffix is gone',
     ['NWL COMPANY LLC', 'NWL CREDIT HOLDINGS LLC',
      'NWL 7600 FISHER ISLAND LENDER LLC']),
    # Each of these pairs is two canonical names that both exist in production
    # and must not be pulled together by a wider suffix list.
    ('dropping COMPANY must not shorten a name into its own shorter sibling',
     ['CARDINAL FINANCIAL COMPANY', 'CARDINAL COMPANY']),
    ('one word of difference between two Bank of New York vehicles',
     ['BANK OF NEW YORK MELLON TRUST COMPANY', 'BANK OF NEW YORK TRUST COMPANY']),
    ('one word of difference between two MetLife insurers',
     ['METROPOLITAN LIFE INSURANCE COMPANY',
      'METROPOLITAN TOWER LIFE INSURANCE COMPANY']),
]

# Known, deliberately out of scope: canonicalize() also strips a bare `II`/`III`
# (STRIP_SUFFIXES, added long before this change), so "ARVE INVESTMENTS II
# LIMITED PARTNERSHIP" and "ARVE INVESTMENTS LIMITED PARTNERSHIP" were already
# one canonical name before COMPANY/LIMITED were touched, and NWL CREDIT
# INVESTORS I and II are split from each other rather than merged. That is a
# roman-numeral problem, not a legal-suffix one — asserting it here would pin
# behavior this change neither introduced nor fixed.


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

    # ENTITY_TYPE_PATTERNS match the CANONICAL name, so a suffix change can
    # silently unclassify an entity the patterns named by its full spelling.
    # "NWL COMPANY" was listed under TRUST and now canonicalizes to "NWL";
    # 106 filings would have dropped to the default type with nothing failing.
    if classify_canonical(canonicalize('NWL COMPANY LLC')) != 'TRUST':
        failures.append('NWL Company lost its TRUST classification: '
                        f"{canonicalize('NWL COMPANY LLC')} -> "
                        f"{classify_canonical(canonicalize('NWL COMPANY LLC'))}")
    # The anchor on that pattern is what keeps the unrelated NWL entities out.
    for other in ('NWL CREDIT HOLDINGS LLC', 'NWL 7600 FISHER ISLAND LENDER LLC'):
        if classify_canonical(canonicalize(other)) == 'TRUST':
            failures.append(f'{other} wrongly classified TRUST by the NWL pattern')

    print(f'  · {len(MERGES)} merge groups and {len(SPLITS)} split groups checked')
    print('  · plus the NWL entity-type coupling in both directions')
    print('  · no database and no network needed')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ COMPANY, LIMITED and a spaced "L P" are legal suffixes, not brand content')
    return 0


if __name__ == '__main__':
    sys.exit(main())
