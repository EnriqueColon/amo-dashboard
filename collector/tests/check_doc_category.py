"""
Verify the COLLATERAL correction rule — offline, no database, no API key.
--------------------------------------------------------------------------
The model put 11,366 ASSIGNMENT OF MORTGAGE filings (21% of all AMO) in
COLLATERAL. Thirty-two were fetched and read by hand on 2026-09-15:

    20 suspects (title silent on collateral)  ALL outright transfers, 0 pledges
     6 genuine collateral assignments         all explicitly collateral
     6 known-good controls                    all transfers

The suspects say "forever without recourse", "grant, bargain, sell, assign,
transfer and set over", "all right, title and interest". Their assignees are
trustees, servicers, GSEs and HUD — nobody pledges collateral to HUD. The
genuine ones say "collaterally assign" or "for better securing the repayment of
the Loan" to a party named Lender.

Cause: the prompt defines COLLATERAL as a pledge "(no outright transfer)", with
the deciding clause in a trailing parenthetical and no positive anchor for a
plain assignment — while every mortgage assignment is full of "security" and
"securing", because a mortgage IS a security instrument.

The rule only ever OVERTURNS an unsupported COLLATERAL verdict. It never invents
one, never touches another category, and never touches a non-AMO filing.

    collector/.venv/bin/python3 collector/tests/check_doc_category.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from extract_pdfs import reclassify_collateral  # noqa: E402

AMO = 'ASSIGNMENT OF MORTGAGE - AMO'
ASG = 'ASSIGNMENT - ASG'
FST = 'FINANCING STATEMENT UCC - FST'

# Text fragments are verbatim from the sampled documents.
HUD = ("does hereby assign, transfer, convey, set over, and deliver to: SECRETARY OF "
       "HOUSING AND URBAN DEVELOPMENT, forever without recourse")
WILMINGTON = ("transfer to WILMINGTON SAVINGS FUND SOCIETY, FSB ... forever and without "
              "recourse ... all its right, title and interest in and to the described Mortgage")
CLASSIC = ("did grant, bargain, sell, assign, transfer and set over unto the Assignee the "
           "certain Mortgage bearing the date of July 18, 2024")
FIFTH_THIRD = ("by these presents does convey, assign, transfer and set over to: FIFTH THIRD "
               "BANK, NATIONAL ASSOCIATION, the described Mortgage, with all interest")

REAL_COLLATERAL = ("for better securing the repayment of the Loan and other good and valuable "
                   "considerations paid to Assignor, Assignor does hereby assign, grant, "
                   "bargain and convey to Lender all of Assignor's right, title and interest")
COLLATERALLY = ("does hereby collaterally assign, transfer and set over unto the Assignee, "
                "those certain Mortgages more particularly described in Exhibit A")
RE_ASSIGN = ("This Collateral Re-Assignment is being made without recourse, representation, "
             "or warranty")

RENTS = ("Assignment of Rents made by the Borrower in favour of the Lender covering all rents "
         "and profits of the property")

# (doc_type, title, text, model_says, expected, why)
CASES = [
    # ── suspects: must flip to LOAN_TRANSFER ──────────────────────────────
    (AMO, 'ASSIGNMENT OF MORTGAGE', HUD, 'COLLATERAL', 'LOAN_TRANSFER',
     'the document the owner spotted — assigned to HUD, forever without recourse'),
    (AMO, 'ASSIGNMENT OF MORTGAGE', WILMINGTON, 'COLLATERAL', 'LOAN_TRANSFER',
     'all right title and interest, forever'),
    (AMO, 'ASSIGNMENT OF MORTGAGE', CLASSIC, 'COLLATERAL', 'LOAN_TRANSFER',
     'the full common-law conveyance formula'),
    (AMO, 'CORPORATE ASSIGNMENT OF MORTGAGE', FIFTH_THIRD, 'COLLATERAL', 'LOAN_TRANSFER',
     'convey, assign, transfer and set over'),
    (AMO, 'ASSIGNMENT OF MORTGAGE', 'assigns the mortgage securing a note in the '
     'original principal amount of $544,185', 'COLLATERAL', 'LOAN_TRANSFER',
     '"securing a note" is ordinary boilerplate, not a pledge — this is the trap'),

    # ── genuine collateral: must be left alone ────────────────────────────
    (AMO, 'COLLATERAL ASSIGNMENT OF MORTGAGE', REAL_COLLATERAL, 'COLLATERAL', 'COLLATERAL',
     'securing repayment of the Loan, assignee is "Lender"'),
    (AMO, 'COLLATERAL ASSIGNMENT OF NOTE AND MORTGAGE', COLLATERALLY, 'COLLATERAL', 'COLLATERAL',
     'says "collaterally assign" outright'),
    (AMO, 'COLLATERAL RE-ASSIGNMENT OF MORTGAGE', RE_ASSIGN, 'COLLATERAL', 'COLLATERAL',
     'a re-assignment of collateral is still collateral'),
    (AMO, 'ASSIGNMENT OF MORTGAGE', 'assigned as collateral security for the obligations '
     'of Assignor under the Credit Agreement', 'COLLATERAL', 'COLLATERAL',
     'title is silent but the body is explicit — title alone must not decide'),

    # ── other categories are never touched ────────────────────────────────
    (AMO, 'ASSIGNMENT OF MORTGAGE', HUD, 'LOAN_TRANSFER', 'LOAN_TRANSFER',
     'already correct, passes through untouched'),
    (AMO, 'ASSIGNMENT OF RENTS', RENTS, 'RENTS_LEASES', 'RENTS_LEASES',
     "rents verdicts are not this rule's business"),
    (AMO, 'ASSIGNMENT OF JUDGMENT', 'assigns the judgment', 'OTHER', 'OTHER',
     'other verdicts pass through'),

    # ── non-AMO filings are out of scope ──────────────────────────────────
    (FST, 'UCC FINANCING STATEMENT', 'This FINANCING STATEMENT covers the following '
     'collateral: all inventory and equipment', 'COLLATERAL', 'COLLATERAL',
     'a UCC filing genuinely IS a collateral record — 20,522 rows must not move'),
    (ASG, 'ASSIGNMENT OF RENTS', RENTS, 'COLLATERAL', 'COLLATERAL',
     'ASG has its OWN wrong-bucket problem (1,375 rent assignments); flipping '
     'them here would swap one error for another'),
]

failures: list[str] = []


def main() -> int:
    for doc_type, title, text, said, expected, why in CASES:
        got, evidence = reclassify_collateral(doc_type, title, text, said)
        if got != expected:
            failures.append(f'{title!r} ({doc_type.split(" - ")[-1]})\n'
                            f'      model said {said}, expected {expected}, got {got} — {why}')
        # A kept COLLATERAL must be able to say why.
        if got == 'COLLATERAL' and said == 'COLLATERAL' and doc_type == AMO and not evidence:
            if expected == 'COLLATERAL':
                failures.append(f'{title!r}: kept COLLATERAL but recorded no evidence quote')

    # The rule must never CREATE a collateral verdict.
    for said in ('LOAN_TRANSFER', 'RENTS_LEASES', 'OTHER', None):
        got, _ = reclassify_collateral(AMO, 'COLLATERAL ASSIGNMENT OF MORTGAGE',
                                       REAL_COLLATERAL, said)
        if got == 'COLLATERAL' and said != 'COLLATERAL':
            failures.append(f'rule invented a COLLATERAL verdict from {said!r} — it must only '
                            f'ever overturn one, never create one')

    print(f'  · {len(CASES)} documents checked, plus a never-invent assertion')
    print('  · offline: no database, no network, no API key')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ collateral correction holds')
    return 0


if __name__ == '__main__':
    sys.exit(main())
