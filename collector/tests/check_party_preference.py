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

from normalize import (  # noqa: E402
    prefer_document_party, pick_listed_party, prefer_document_seller, clean_property_address)

# (index_name, names listed on that side, pdf_name, expected, why). Hillsborough
# lists each side alphabetically, so the first name is not the seller.
LISTED_CASES = [
    ('BMF V FL GRAND PAVILION LLC',
     ['BMF V FL GRAND PAVILION LLC', 'FEDERAL HOME LOAN MORTGAGE CORPORATION'],
     'FEDERAL HOME LOAN MORTGAGE CORPORATION', 'FEDERAL HOME LOAN MORTGAGE CORPORATION',
     '2026400005: the borrower sorted first and the row read as an ORIGINATION'),
    ('CALIBER HOME LOANS INC',
     ['CALIBER HOME LOANS INC', 'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS'],
     'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC., AS NOMINEE FOR CALIBER HOME LOANS',
     'CALIBER HOME LOANS INC',
     'MERS signing as nominee does not displace the lender — Miami-Dade shows the '
     'lender on most such filings'),
    ('FAY SERVICING LLC ATTY',
     ['FAY SERVICING LLC ATTY', 'NATIONAL LOAN FUNDING LLC'],
     'NATIONAL LOAN FUNDING, LLC', 'NATIONAL LOAN FUNDING LLC',
     'a servicer signing as attorney-in-fact gives way to its principal, in the '
     "index's spelling"),
    ('RMAC TRUST, SERIES 2016-CTT',
     ['RMAC TRUST, SERIES 2016-CTT', 'U S BANK NATIONAL ASSOCIATION TRU'],
     'U.S. BANK NATIONAL ASSOCIATION, AS TRUSTEE', 'RMAC TRUST, SERIES 2016-CTT',
     'a recognised trust is not swapped for its trustee'),
    ('BMF V FL GRAND PAVILION LLC',
     ['BMF V FL GRAND PAVILION LLC', 'FEDERAL HOME LOAN MORTGAGE CORPORATION'],
     'WELLS FARGO BANK, N.A.', 'BMF V FL GRAND PAVILION LLC',
     'a document party the index does not list on this side is not trusted here'),
    ('WELLS FARGO BANK', ['WELLS FARGO BANK'], 'US BANK', 'WELLS FARGO BANK',
     'a single listed party leaves nothing to choose between'),
    ('WELLS FARGO BANK', None, 'US BANK', 'WELLS FARGO BANK',
     'Miami-Dade rows carry no party list'),
    ('CSMC 2021 JR2 TRUST',
     ['CSMC 2021 JR2 TRUST', 'WILMINGTON SAVINGS FUND SOCIETY FSB TRU'],
     'WILMINGTON SAVINGS FUND SOCIETY, FSB, AS TRUSTEE', 'CSMC 2021 JR2 TRUST',
     'an untyped trust is still not swapped for its trustee'),
    ('ONITY MORTGAGE CORPORATION',
     ['ONITY MORTGAGE CORPORATION', 'PHH MORTGAGE CORPORATION'],
     'PHH MORTGAGE CORPORATION', 'ONITY MORTGAGE CORPORATION',
     'a recognised servicer keeps the row; swapping merges Onity into its former name'),
]

# The stored classification of each index pick; anything absent is OTHER.
INDEX_TYPES = {
    'CALIBER HOME LOANS INC': 'BANK',
    'FAY SERVICING LLC ATTY': 'SERVICER',
    'RMAC TRUST, SERIES 2016-CTT': 'TRUST',
    'WELLS FARGO BANK': 'BANK',
    'ONITY MORTGAGE CORPORATION': 'SERVICER',
}

# (index_name, pdf_name, expected, why) for prefer_document_seller; the index
# name is an unrecognised company. Names verbatim from production.
SELLER_CASES = [
    ('SUITE HOMES RENOVATION LLC', 'Debt Closing Services LLC ISAOA/ATIMA',
     'Debt Closing Services LLC ISAOA/ATIMA',
     '2026R695675: the borrower was the only grantor indexed'),
    ('MANGO GROVE FAMILY LLC', 'Velocity Commercial Capital, LLC',
     'Velocity Commercial Capital, LLC', 'borrower indexed, lender in the document'),
    ('M&M PRIVATE LENDING GROUP LLC', 'M & M PRIVATE LENDING GROUP, LLC',
     'M&M PRIVATE LENDING GROUP LLC', 'spelling variant: the clerk spelling stays'),
    ('BOYD LOAN FUNDING I LLC', 'Boyd Loan Funding 1, LLC', 'BOYD LOAN FUNDING I LLC',
     'I vs 1 is still the same company'),
    ('PAD SERIES V TRUST', 'U.S. BANK TRUST NATIONAL ASSOCIATION AS TRUSTEE',
     'PAD SERIES V TRUST', 'a trust is not swapped for its trustee'),
    ('ZARI CAFE LLC', 'GARY L. BROWN', 'ZARI CAFE LLC',
     'a person named in the document does not displace a company'),
    ('SUITE HOMES RENOVATION LLC', 'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS, INC.',
     'SUITE HOMES RENOVATION LLC', 'MERS is never substituted'),
    ('SUITE HOMES RENOVATION LLC', None, 'SUITE HOMES RENOVATION LLC',
     'no extraction: the index is all there is'),
]

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

    # ── both institutional: the INDEX keeps it ────────────────────────────
    # The index is clerk-typed and clean; the document is OCR'd. A blanket
    # preference for the document was tried and rejected — these are the real
    # regressions it produced, taken from the dry run against production.
    ('WELLS FARGO BANK', 'WELLS FARGO BANK, N.A.', 'WELLS FARGO BANK',
     'both already name the institution — swapping buys a cosmetic spelling '
     'change and 52% canonical churn across the table'),
    ('LOAN STORE', 'THE LOAN STORE', 'LOAN STORE',
     'the document spelling reclassifies a BANK as OTHER'),

    # ── unrecognised COMPANIES are not people and must be left alone ──────
    # Strings verbatim from production. The classifier returns OTHER for both a
    # homeowner and a company it has no pattern for; telling them apart is what
    # _looks_like_person is for.
    ('FV-1 INC', 'FY-I, INC. IN TRUST FOR MORGAN STANLEY MORTGAGE CAPITAL HOLDINGS LLC',
     'FV-1 INC',
     'the document misreads FV-1 as FY-I; swapping would fragment the entity '
     'away from its other filings for the sake of a longer string'),
    ('ONITY MORTGAGE CORP',
     'ONITY MORTGAGE CORPORATION F/K/A PHH MORTGAGE CORPORATION', 'ONITY MORTGAGE CORP',
     'canonicalises to PHH MORTGAGE and silently merges Onity into its former '
     'name — a change of identity, not a correction'),
    ('HEADLANDS RESIDENTIAL SERIES OWNER', 'US BANK', 'HEADLANDS RESIDENTIAL SERIES OWNER',
     'an unrecognised securitisation vehicle, not a person — "SERIES" marks it '
     'as an organisation, so the rule stays out of a trust-vs-trustee question '
     'it has no business deciding'),

    # ── both personal: a genuine person-to-person assignment ──────────────
    ('SMITH JOHN A', 'JOHN A. SMITH', 'SMITH JOHN A',
     'neither names an institution, so there is no party error to correct'),

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

    # ── legal descriptions identify the property and must survive ─────────
    ('Lot 13, Block 2, of LYNWOOD, according to the Plat thereof, as recorded in '
     'Plat Book 46, Page 21',
     'Lot 13, Block 2, of LYNWOOD, according to the Plat thereof, as recorded in '
     'Plat Book 46, Page 21',
     'not a street address, but it identifies the parcel more precisely than one '
     '— an earlier draft threw these away, which was the same mistake inverted'),
    ('Lots 20, 21 and 22 and the East 11 feet of Lot 23, Block 38, Silver Bluff Estates',
     'Lots 20, 21 and 22 and the East 11 feet of Lot 23, Block 38, Silver Bluff Estates',
     'plural lots, same reasoning'),
    ('Section 25, Township 54 South, Range 39 East, Miami-Dade County, Florida',
     'Section 25, Township 54 South, Range 39 East, Miami-Dade County, Florida',
     'a metes-and-bounds description is a real locator'),
    ('Condominium Unit No. 3601, MARQUIS, A CONDOMINIUM',
     'Condominium Unit No. 3601, MARQUIS, A CONDOMINIUM',
     'a condo unit number identifies the property exactly — the first draft '
     'cleared these because they do not start with a street number'),
    ('Unit 712 of Rise Condominium, Miami-Dade County, Florida',
     'Unit 712 of Rise Condominium, Miami-Dade County, Florida', 'same'),

    # ── a company name is not a property, even carrying a number ──────────
    ('Good Night Inn and Suite Baymeadow 770 LLC, Florida', None,
     'has a digit but is a business name — no street number, no lot, no unit'),

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

    for idx, listed, pdf, expected, why in LISTED_CASES:
        got = pick_listed_party(idx, listed, pdf, INDEX_TYPES.get(idx, 'OTHER'))
        if got != expected:
            failures.append(f'listed party: index={idx!r} pdf={pdf!r}\n'
                            f'      expected {expected!r}, got {got!r} — {why}')

    for idx, pdf, expected, why in SELLER_CASES:
        got = prefer_document_seller(idx, pdf)
        if got != expected:
            failures.append(f'seller: index={idx!r} pdf={pdf!r}\n'
                            f'      expected {expected!r}, got {got!r} — {why}')
    if prefer_document_seller('SUITE HOMES RENOVATION LLC', 'Debt Closing Services LLC', 'BANK') \
            != 'SUITE HOMES RENOVATION LLC':
        failures.append('seller: a recognised index name must keep the row')
    if prefer_document_seller('GENEVA CAPITAL GROUP LLC', 'NEHIR RESIDENCES LLC', 'OTHER',
                              {'GENEVA CAPITAL GROUP': 12}) != 'GENEVA CAPITAL GROUP LLC':
        failures.append('seller: a repeat seller in the index must keep the row (2025R667227)')

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

    print(f'  · {len(PARTY_CASES)} party choices, {len(LISTED_CASES)} listed-party '
          f'choices, {len(SELLER_CASES) + 2} seller choices and {len(PROPERTY_CASES)} property '
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
