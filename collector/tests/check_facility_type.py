"""
Verify the facility_type rules — offline, no API calls, no cost.
---------------------------------------------------------------
Until 2026-09-12 facility_type was decided by the model, and it put **623 of 625**
production rows in `warehouse_or_revolving_credit_facility`, 2 in any other
bucket, and zero in `syndicated_credit_agreement`. Documents whose own agreement
name read "Commercial NON-Revolving Line of Credit" came back as revolving, and
101 whose only named agreement was "Security Instrument" or "Mortgage" — plain
conveyancing boilerplate — came back as credit facilities.

The existing gate (`collector/research/scripts/verify_integration.py`) never
caught it because it only compared `none` against not-`none`; it never looked at
which type was chosen. A field no test asserts is a field nothing protects.

`classify_facility_type` is a pure function of two extracted strings, so unlike
that gate this file needs no network, no OCR and no API key, and runs instantly:

    collector/.venv/bin/python3 collector/tests/check_facility_type.py

Every case below is a REAL agreement name taken from production.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from extract_pdfs import classify_facility_type, VALID_FACILITY_TYPES  # noqa: E402

WAREHOUSE = 'warehouse_or_revolving_credit_facility'
SYNDICATED = 'syndicated_credit_agreement'
CONSUMER = 'consumer_or_business_line_of_credit'
NONE = 'none'

# (agreement_name, evidence_quote, expected, why it matters)
CASES = [
    # ── genuine warehouse lines. These are the BGI Financial / City National
    # documents the 21/21 integration gate covers, so a change that breaks them
    # breaks that gate too.
    ('Warehouse Mortgage Loan and Security Agreement', None, WAREHOUSE, 'canonical warehouse'),
    ('Warehousing Loan and Security Agreement', None, WAREHOUSE, 'warehousing spelling'),
    ('Warehouse Agreement', 'that certain (Warehouse Agreement) dated March 29, 2016',
     WAREHOUSE, 'brief parenthetical still counts'),
    ('Warchouse Mortgage Loan and Security Agreement', None, WAREHOUSE, 'OCR damage: Warchouse'),
    ('Second Amended and Restated Warehouse Mortgage Loan and Security Agreement', None,
     WAREHOUSE, 'long restated name'),
    ('Master Repurchase Agreement', None, WAREHOUSE, 'repo is a warehouse construct'),
    (None, 'the Pledged Loans securing the facility', WAREHOUSE, 'evidence only, no name'),

    # ── the bug this file exists for: non-revolving read as revolving
    ('Commercial Non-Revolving Line of Credit Promissory Note', None, CONSUMER,
     'says NON-revolving; was warehouse in production'),
    ('Commercial Non-revolving Line of Credit', None, CONSUMER, 'lowercase variant'),

    # ── generic conveyancing instruments are not facilities at all
    ('Security Instrument', None, NONE, '83 production rows called this a facility'),
    ('Mortgage', None, NONE, '18 production rows'),
    ('Mortgage Note', None, NONE, 'still just the note'),
    ('Operator Security Agreement', None, NONE, '112 production rows'),
    ('Assignment of Mortgage', None, NONE, 'the instrument being recorded'),

    # ── single term loans
    ('Construction Loan Agreement', None, NONE, 'a term loan, not a facility'),
    ('Loan Agreement', None, NONE, 'bare name, nothing else'),
    ('Loan and Security Agreement', None, NONE, 'bare name, nothing else'),

    # ── syndicated: the agent PHRASE, not the agent field
    ('Loan Agreement', 'that certain Term Loan and Security Agreement dated as of the date '
     'hereof among Borrower, Administrative Agent and the Lenders', SYNDICATED,
     'administrative agent + the Lenders'),
    ('Credit Agreement', 'U.S. Bank National Association, as Collateral Agent for the Lenders',
     SYNDICATED, 'collateral agent for lenders'),

    # ── consumer / business lines
    ('Revolving Line of Credit Promissory Note', None, CONSUMER, 'plainly a line of credit'),
    ('Home Equity Line of Credit', None, CONSUMER, 'HELOC'),
    ('Credit Agreement', 'REVOLVING LINE OF CREDIT. This Assignment secures the Indebtedness',
     CONSUMER, 'generic name, line-of-credit evidence'),

    # ── precedence: warehouse beats a bare line-of-credit mention
    ('Warehousing Line of Credit Promissory Note', None, WAREHOUSE,
     'warehouse wins over line-of-credit'),
]

failures: list[str] = []
notes: list[str] = []


def main() -> int:
    for name, evidence, expected, why in CASES:
        got, reason = classify_facility_type(name, evidence)
        if got != expected:
            failures.append(
                f'{name!r} + evidence={str(evidence)[:40]!r}\n'
                f'      expected {expected}, got {got} (rule: {reason}) — {why}')

    # Every result must be a type the DB accepts.
    for name, evidence, _e, _w in CASES:
        got, _ = classify_facility_type(name, evidence)
        if got not in VALID_FACILITY_TYPES:
            failures.append(f'{name!r} produced {got!r}, which is not in VALID_FACILITY_TYPES')

    # Negative control. If warehouse detection is removed, the canonical
    # warehouse case must stop passing — otherwise this file proves nothing
    # about the rule that does the most work.
    import extract_pdfs
    original = extract_pdfs._FAC_WAREHOUSE
    try:
        import re as _re
        extract_pdfs._FAC_WAREHOUSE = _re.compile(r'(?!x)x')  # matches nothing
        still, _ = classify_facility_type('Warehouse Mortgage Loan and Security Agreement', None)
    finally:
        extract_pdfs._FAC_WAREHOUSE = original
    if still == WAREHOUSE:
        failures.append('negative control failed: the canonical warehouse name still classified '
                        'as warehouse with the warehouse rule disabled, so these assertions do '
                        'not demonstrate that rule is what decides it')
    else:
        notes.append('negative control passed — the warehouse rule is what classifies warehouses')

    notes.append(f'{len(CASES)} rules checked, no network and no API key needed')

    for n in notes:
        print(f'  · {n}')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ facility_type rules hold')
    return 0


if __name__ == '__main__':
    sys.exit(main())
