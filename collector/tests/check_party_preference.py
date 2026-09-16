"""
Verify who gets reported as the parties, and what counts as a property address.
-------------------------------------------------------------------------------
Two fixes from 2026-09-16, both offline, no database and no API key.

**Parties.** The Reporting table showed the county index's grantor, and the
county index lists EVERY party on a filing — for an assignment that routinely
includes the original borrower and MERS, not just the two institutions trading
the loan. Measured on production: 12,068 of 55,839 rows (22%) showed a person's
name where the document named a bank. The owner spotted it on the top row of
his own screen — "SOSA JAIME → FREEDOM MORTGAGE", where the document says
"WELLS FARGO BANK, NA → FREEDOM MORTGAGE CORPORATION".

Preferring the document's own name is right 13,120 times and wrong 575 times.
The 575 are the reason this is not a blanket swap and are asserted below: when
the index names an institution and the document names a person, the extractor
has lifted the borrower out of a recital, so the index keeps the row.

**Property.** 801+ rows held prose instead of an address — "AS DESCRIBED IN
SAID MORTGAGE", "not explicitly stated" — plus bare counties and borrower
names. A blank column is honest; "not explicitly stated" is noise that also
breaks the property filter and the CSV export.

    collector/.venv/bin/python3 collector/tests/check_party_preference.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from normalize import prefer_document_party, clean_property_address  # noqa: E402

# (index_name, pdf_name, expected, why) — names verbatim from production.
PARTY_CASES = [
    # ── the bug the owner saw ─────────────────────────────────────────────
    ('SOSA JAIME', 'WELLS FARGO BANK, NA', 'WELLS FARGO BANK, NA',
     'the homeowner is not a party to the sale — this is the top row of the '
     'screenshot that started this'),
    ('PEREZ ALVAREZ KIAMY', 'WELLS FARGO BANK, N.A.', 'WELLS FARGO BANK, N.A.',
     'same shape, same day'),
    ('HENRY NAIRN QYNATA', 'WELLS FARGO BANK, N.A.', 'WELLS FARGO BANK, N.A.',
     'same'),

    # ── the 575: document is WORSE, index must win ────────────────────────
    ('WELLS FARGO BANK, N.A.', 'GISELE M SANTOS', 'WELLS FARGO BANK, N.A.',
     'extractor lifted the borrower out of a recital; the index named the '
     'actual seller and keeps the row'),
    ('LAKEVIEW LOAN SERVICING, LLC', 'JOHN Q HOMEOWNER', 'LAKEVIEW LOAN SERVICING, LLC',
     'institution in the index, person in the document — index wins'),

    # ── both institutional: document is the authority on spelling ─────────
    ('WELLS FARGO BANK', 'WELLS FARGO BANK, N.A.', 'WELLS FARGO BANK, N.A.',
     'the document carries the full legal name'),
    ('MORTGAGE ELECTRONIC REGISTRATION SYSTEMS INC',
     'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC., AS NOMINEE',
     'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC., AS NOMINEE',
     'MERS keeps its role wording, which the index drops'),

    # ── both personal: a genuine person-to-person assignment ──────────────
    ('SMITH JOHN A', 'JOHN A. SMITH', 'JOHN A. SMITH',
     'neither is institutional; the document still spells it properly'),

    # ── the document has nothing usable ───────────────────────────────────
    ('FREEDOM MORTGAGE CORPORATION', None, 'FREEDOM MORTGAGE CORPORATION',
     'no extraction — the index is all there is'),
    ('FREEDOM MORTGAGE CORPORATION', '', 'FREEDOM MORTGAGE CORPORATION',
     'empty extraction must not blank the party'),
    ('FREEDOM MORTGAGE CORPORATION', '  ', 'FREEDOM MORTGAGE CORPORATION',
     'whitespace-only must not blank the party'),

    # ── the pre-existing address rule still holds ─────────────────────────
    ('700 Kansas Lane, Monroe, LA', 'WELLS FARGO BANK, N.A.', 'WELLS FARGO BANK, N.A.',
     'an index grantor that is a street address is never a party name'),
]

# (value, expected, why)
PROPERTY_CASES = [
    # ── real addresses must survive ───────────────────────────────────────
    ('951 YAMATO ROAD, SUITE 175, BOCA RATON, FL 33431',
     '951 YAMATO ROAD, SUITE 175, BOCA RATON, FL 33431',
     'a corporate HQ still LOOKS like an address — it is caught structurally '
     'after the fact, not here, because nothing in the string itself is wrong'),
    ('11740 SW 178TH TER, MIAMI, FL 33177', '11740 SW 178TH TER, MIAMI, FL 33177',
     'ordinary property address'),
    ('863 SE 17TH ST, HOMESTEAD, FL', '863 SE 17TH ST, HOMESTEAD, FL', 'ordinary'),
    ('10865 SW 41 TERRACE, MIAMI, FL', '10865 SW 41 TERRACE, MIAMI, FL', 'ordinary'),
    ('P.O. BOX 1234, MIAMI, FL 33101', 'P.O. BOX 1234, MIAMI, FL 33101',
     'a PO box has no street number but is still locatable'),

    # ── prose: the extractor answering in words ───────────────────────────
    ('AS DESCRIBED IN SAID MORTGAGE', None, '162 rows'),
    ('not explicitly stated', None, '120 rows'),
    ('not specified', None, '90 rows'),
    ('more fully described in said Mortgage', None, '74 rows'),
    ('the property situated in said State and County as more fully described', None,
     '106 rows'),
    ('Said Mortgage was made by GISELE M SANTOS', None,
     "a borrower's name, and a privacy problem in a column labelled Property"),
    ('see Exhibit A', None, '44 rows'),
    ('n/a', None, 'literal n/a'),
    ('unknown', None, 'literal unknown'),

    # ── geography with no street ──────────────────────────────────────────
    ('Miami-Dade County, Florida', None, '54 rows — a county is not an address'),
    ('MIAMI-DADE County, Florida', None, '38 rows, different casing'),
    ('Coral Gables, FL 33134', None, 'a city and zip locate nothing specific'),

    # ── names and fragments ───────────────────────────────────────────────
    ('KIAMY PEREZ-ALVAREZ', None, 'a person, not a place'),
    ('VALENCIA S CULMER AND BRIAN C CULMER', None, 'two people, not a place'),

    # ── empties ───────────────────────────────────────────────────────────
    (None, None, 'null in, null out'),
    ('', None, 'empty string'),
    ('   ', None, 'whitespace only'),
]

failures: list[str] = []


def main() -> int:
    for idx, pdf, expected, why in PARTY_CASES:
        got = prefer_document_party(idx, pdf)
        if got != expected:
            failures.append(f'party: index={idx!r} pdf={pdf!r}\n'
                            f'      expected {expected!r}, got {got!r} — {why}')

    for value, expected, why in PROPERTY_CASES:
        got = clean_property_address(value)
        if got != expected:
            failures.append(f'property: {value!r}\n'
                            f'      expected {expected!r}, got {got!r} — {why}')

    # The party rule must never blank a party. A row with no assignor is worse
    # than a row with the wrong one: it drops out of every entity ranking
    # silently instead of being visibly wrong.
    for idx in ('WELLS FARGO BANK, N.A.', 'SOSA JAIME', 'X'):
        for pdf in (None, '', '   ', 'ok name'):
            if prefer_document_party(idx, pdf) in (None, ''):
                failures.append(f'party rule blanked a party: index={idx!r} pdf={pdf!r}')

    print(f'  · {len(PARTY_CASES)} party choices and {len(PROPERTY_CASES)} property '
          f'values checked, plus a never-blank assertion')
    print('  · offline: no database, no network, no API key')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ party preference and property cleaning hold')
    return 0


if __name__ == '__main__':
    sys.exit(main())
