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
one and never touches another category.

Rents and leases — added 2026-09-15
-----------------------------------
COLLATERAL held a second, unrelated error: 6,043 filings that are ordinary
property-level security instruments — a landlord assigning tenant rents to its
own lender, recorded alongside the mortgage. Six were read by hand; all six said
"grants a continuing security interest in ... the Rents" and "THIS ASSIGNMENT IS
GIVEN TO SECURE (1) PAYMENT OF THE INDEBTEDNESS". No loan changes hands and no
loan is pledged, so they belong in RENTS_LEASES, and while they sat in COLLATERAL
they outnumbered the genuine collateral pledges four to one.

The deciding question is WHAT IS ASSIGNED, and the recorded title states it, so
that half needs no OCR text at all. Two traps are asserted below: "collateral" in
a title describes the manner and not the asset, so COLLATERAL ASSIGNMENT OF
LEASES AND RENTS is still a rents instrument; and the text test's LOAN_TRANSFER
fallback is only safe once the title names a debt instrument, because ASG also
carries permits, contracts and development rights.

    collector/.venv/bin/python3 collector/tests/check_doc_category.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from extract_pdfs import reclassify_collateral, reclassify_rents_by_title  # noqa: E402

AMO = 'ASSIGNMENT OF MORTGAGE - AMO'
ASG = 'ASSIGNMENT - ASG'
AST = 'AST'
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
    (FST, 'UCC FINANCING STATEMENT COVERING LEASES AND RENTS', 'collateral: all leases',
     'COLLATERAL', 'COLLATERAL',
     'the two UCC titles that DO mention leases must still not move — the doc '
     'type is excluded before the title is ever looked at'),

    # ── rents and leases: the second half of the wrong-bucket problem ──────
    # 6,043 rows. Titles are verbatim from production, including the OCR damage.
    (ASG, 'ASSIGNMENT OF RENTS', RENTS, 'COLLATERAL', 'RENTS_LEASES',
     'the largest single group (1,375) — a landlord pledging rents to its own '
     'lender is not a loan changing hands'),
    (ASG, 'COLLATERAL ASSIGNMENT OF LEASES AND RENTS', RENTS, 'COLLATERAL', 'RENTS_LEASES',
     '"collateral" describes the manner, not the asset — the asset is leases'),
    (ASG, 'COLEATERAL ASSIGNMENT OF LEASES, RENTS AND PROFITS', RENTS, 'COLLATERAL',
     'RENTS_LEASES', 'OCR damage: why this is a regex and not a list of titles'),
    (ASG, 'ABSOLUTE ASSIGNMENT OF LESSOR’S INTEREST IN LEASES AND RENTS', RENTS,
     'COLLATERAL', 'RENTS_LEASES', 'names neither "rent" nor "collateral" plainly'),
    (AST, 'ASSIGNMENT OF RENTS', RENTS, 'COLLATERAL', 'RENTS_LEASES',
     'the same instrument filed under a different county code'),
    (AMO, 'ASSIGNMENT OF ASSIGNMENT OF LEASES AND RENTS', RENTS, 'COLLATERAL',
     'RENTS_LEASES', 'still a rents instrument even when filed under the AMO code'),

    # ── the assessments pledge is real collateral and must survive ─────────
    (ASG, 'COLLATERAL ASSIGNMENT OF RIGHT TO COLLECT ASSESSMENTS AND ASSIGNMENT OF '
     'LIEN RIGHTS', 'condominium association assigns to Lender its right to collect '
     'assessments', 'COLLATERAL', 'COLLATERAL',
     '437 rows: an association pledging receivables for its own borrowing is '
     'exactly what COLLATERAL means — and "LIEN RIGHTS" must beat the rents test'),

    # ── a title naming a debt instrument is never settled by the title ─────
    (ASG, 'COLLATERAL ASSIGNMENT OF NOTE, MORTGAGE AND OTHER LOAN DOCUMENTS',
     REAL_COLLATERAL, 'COLLATERAL', 'COLLATERAL',
     'the body decides these, and here it says collateral'),
    (ASG, 'ASSIGNMENT OF MORTGAGE', CLASSIC, 'COLLATERAL', 'LOAN_TRANSFER',
     'the 119 ASG filings titled ASSIGNMENT OF MORTGAGE — sampled 6/6 outright '
     'transfers to servicers and trustees'),
    (AST, 'CORPORATE ASSIGNMENT OF MORTGAGE', FIFTH_THIRD, 'COLLATERAL', 'LOAN_TRANSFER',
     'same for the 61 AST ones'),
    (AMO, 'ASSIGNMENT OF MORTGAGE, ASSIGNMENT OF LEASES AND RENTS, SECURITY AGREEMENT '
     'AND FIXTURE FILING', 'assignment of leases and rents made by Borrower',
     'COLLATERAL', 'COLLATERAL',
     'mixed instrument: title names a mortgage AND rents, body is rents — not '
     'safely a transfer, so it is left alone rather than guessed at'),

    # ── ASG carries far more than loans; those must NOT become transfers ───
    (ASG, 'ASSIGNMENT OF PERMITS AND AGREEMENTS', 'assigns all permits and approvals',
     'COLLATERAL', 'COLLATERAL',
     'the reason the text test is gated on the title naming a debt instrument: '
     'absence of pledge language here means nothing, and LOAN_TRANSFER would '
     'put building permits into the Reporting tab'),
    (ASG, 'ASSIGNMENT OF AGREEMENTS AFFECTING REAL ESTATE', 'assigns the agreements',
     'COLLATERAL', 'COLLATERAL', 'same — 47 rows'),
    (ASG, 'ASSIGNMENT', 'assigns all right title and interest', 'COLLATERAL', 'COLLATERAL',
     'a bare title says nothing at all; 112 rows must stay put'),
]

# Kept COLLATERAL because the rule had no basis to move them, not because it
# found one. These carry no evidence quote, and should not: inventing a citation
# for a verdict nothing supports is how the original bug read from the outside.
DECLINED_TO_DECIDE = {
    'ASSIGNMENT OF MORTGAGE, ASSIGNMENT OF LEASES AND RENTS, SECURITY AGREEMENT '
    'AND FIXTURE FILING',
    'ASSIGNMENT OF PERMITS AND AGREEMENTS',
    'ASSIGNMENT OF AGREEMENTS AFFECTING REAL ESTATE',
    'ASSIGNMENT',
    'UCC FINANCING STATEMENT',
    'UCC FINANCING STATEMENT COVERING LEASES AND RENTS',
}

failures: list[str] = []


def main() -> int:
    for doc_type, title, text, said, expected, why in CASES:
        got, evidence = reclassify_collateral(doc_type, title, text, said)
        if got != expected:
            failures.append(f'{title!r} ({doc_type.split(" - ")[-1]})\n'
                            f'      model said {said}, expected {expected}, got {got} — {why}')
        # A COLLATERAL verdict the rule AFFIRMED must be able to say why. That is
        # different from one it merely declined to overturn: an out-of-scope
        # filing, or an instrument whose title and body disagree, keeps the
        # model's label untouched and has nothing of its own to cite. Both are
        # correct outcomes, and a stored evidence quote is exactly what tells
        # them apart later — so the distinction is named here rather than the
        # assertion being dropped.
        if got == 'COLLATERAL' and expected == 'COLLATERAL' and not evidence:
            if title not in DECLINED_TO_DECIDE:
                failures.append(f'{title!r}: affirmed COLLATERAL but recorded no evidence quote')
        if got == 'COLLATERAL' and evidence and title in DECLINED_TO_DECIDE:
            failures.append(f'{title!r}: expected to be left undecided, but the rule '
                            f'affirmed it with evidence {evidence!r}')

    # The rule must never CREATE a collateral verdict.
    for said in ('LOAN_TRANSFER', 'RENTS_LEASES', 'OTHER', None):
        got, _ = reclassify_collateral(AMO, 'COLLATERAL ASSIGNMENT OF MORTGAGE',
                                       REAL_COLLATERAL, said)
        if got == 'COLLATERAL' and said != 'COLLATERAL':
            failures.append(f'rule invented a COLLATERAL verdict from {said!r} — it must only '
                            f'ever overturn one, never create one')

    # Nor may the title rule reroute anything that was not COLLATERAL. A
    # LOAN_TRANSFER whose title happens to mention rents must survive it — that
    # would quietly drain the Reporting tab's default view.
    for said in ('LOAN_TRANSFER', 'OTHER', None):
        got, _ = reclassify_rents_by_title(
            ASG, 'ASSIGNMENT OF MORTGAGE AND ASSIGNMENT OF LEASES AND RENTS', said)
        if got != said:
            failures.append(f'title rule rerouted a {said!r} verdict to {got!r} — it may only '
                            f'ever act on COLLATERAL')

    # The title rule must reach the same verdict as the full rule when the title
    # decides, since the fast backfill runs it alone, without any OCR text.
    for doc_type, title, text, said, expected, why in CASES:
        if expected != 'RENTS_LEASES':
            continue
        got, _ = reclassify_rents_by_title(doc_type, title, said)
        if got != expected:
            failures.append(f'{title!r}: full rule says {expected} but the title-only rule '
                            f'used by the backfill says {got} — they must agree')

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
