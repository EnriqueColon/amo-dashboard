"""
Verify how canonicalize() treats a leading number — offline, no database.
-------------------------------------------------------------------------
South Florida property companies are routinely named after their street number,
and until 2026-09-14 canonicalize() stripped every leading non-letter. That
turned "7190 HOLDINGS LLC" into "HOLDINGS" and, far worse, collapsed **47
unrelated firms into one fictional "INVESTMENTS" entity** and 45 into
"HOLDINGS" — their profiles, volumes and rankings summed businesses with
nothing to do with each other. 1,752 filings across 1,113 companies.

Only a LEADING ZERO is stripped now. Magnitude was tried as the discriminator —
treat anything under 100 as a sequence prefix — and the real names rejected it:
"10 COLEE LLC", "11 SOUTH LLC", "12 WEST 29 STREET LLC", "1 OAK RICHLAND LLC"
are all genuine street-numbered companies, and that rule would have turned
"11 SOUTH LLC" into "SOUTH", recreating the very merge it was meant to fix.

The residual cost is accepted: where a leading digit really was noise
("1 SHARPE OPPORTUNITY TRUST" beside the bare form), the two stay separate. A
split entity is visible on the Entities page and mergeable there by hand; a
false merge fabricates a company nobody can spot.

canonicalize_baseline.tsv covers drift across all 45k names; this file states
the INTENT, so the rule is readable rather than implied by a 45k-row golden
file. Neither replaces the other.

    collector/.venv/bin/python3 collector/tests/check_leading_numbers.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from normalize import canonicalize  # noqa: E402

# (raw name, expected canonical, why)
CASES = [
    # ── street numbers are part of the name and must survive ──────────────
    ('7190 HOLDINGS LLC', '7190 HOLDINGS', 'the number is what distinguishes it'),
    ('1347 PRODUCE LLC', '1347 PRODUCE', 'ditto'),
    ('11440 HOUSE LLC', '11440 HOUSE', 'ditto'),
    ('1001 BRICKELL OWNER LLC', '1001 BRICKELL OWNER', 'four-digit street number'),
    ('100 WEST SAN MARINO DRIVE LLC', '100 WEST SAN MARINO DRIVE', 'three digits is a street number'),
    ('150 SE 2ND AVE 709 710 LLC', '150 SE 2ND AVE 709 710', 'address-style name'),

    # ── the merge this file exists to prevent ─────────────────────────────
    # Different companies, and they must NOT land on the same canonical name.
    ('748 INVESTMENTS LLC', '748 INVESTMENTS', 'was merged into "INVESTMENTS"'),
    ('2325 INVESTMENTS LLC', '2325 INVESTMENTS', 'was merged into "INVESTMENTS"'),
    ('1051 INVESTMENTS LLC', '1051 INVESTMENTS', 'was merged into "INVESTMENTS"'),

    # ── small leading numbers are USUALLY real here, and must survive ─────
    # This block is the reason the magnitude rule was abandoned.
    ('54 INVESTMENTS LLC', '54 INVESTMENTS', 'two digits, and a real company'),
    ('11 SOUTH LLC', '11 SOUTH', 'would have become "SOUTH"'),
    ('10 COLEE LLC', '10 COLEE', 'would have become "COLEE"'),
    ('1 OAK RICHLAND LLC', '1 OAK RICHLAND', 'even one digit is usually real'),

    # ── leading ZEROS are the one unambiguous noise case ──────────────────
    ('001 FOUNDATIONAL FAMILY REVOCABLE TRUST', 'FOUNDATIONAL FAMILY REVOCABLE TRUST',
     'a leading zero is a sequence number, never a street number'),
    ('0 0WELLS FARGO BANK NA', 'WELLS FARGO', 'OCR damage, digits fused into the name'),

    # ── OCR junk is still stripped ────────────────────────────────────────
    ('  ‡ WELLS FARGO BANK NA', 'WELLS FARGO', 'leading punctuation must still go'),
    ('** BANK OF AMERICA NA', 'BANK OF AMERICA', 'ditto'),

    # ── institutions must keep gathering their spellings ──────────────────
    ('U S BANK NATIONAL ASSOCIATION', 'US BANK', 'the 236-variant case'),
    ('US BANK NA', 'US BANK', 'ditto'),
    ('WELLS FARGO BANK N A', 'WELLS FARGO', 'ditto'),

    # ── stripping the suffix must not leave a bare number ─────────────────
    ('1104 LLC', '1104 LLC', 'keeps the suffix rather than becoming "1104"'),
    ('05000 LLC', '05000 LLC', 'ditto'),
]

failures: list[str] = []


def main() -> int:
    for raw, expected, why in CASES:
        got = canonicalize(raw)
        if got != expected:
            failures.append(f'{raw!r}\n      expected {expected!r}, got {got!r} — {why}')

    # The merge itself, stated directly: three different companies, three
    # different canonical names. This is the assertion that would have caught
    # the original bug.
    canon = {canonicalize(n) for n in
             ('748 INVESTMENTS LLC', '2325 INVESTMENTS LLC', '1051 INVESTMENTS LLC',
              '3624 INVESTMENTS INC', '691 INVESTMENTS LLC')}
    if len(canon) != 5:
        failures.append(f'five different INVESTMENTS companies collapsed to {len(canon)} '
                        f'canonical name(s): {sorted(canon)}')

    # And the converse: one institution, many spellings, one name.
    # Real spellings taken from the county index, which stores names without
    # periods — an invented "U.S. BANK, N.A." would test a string that never
    # occurs, and did, on the first draft of this file.
    # Real spellings from the county index, which stores names without periods.
    # NOTE the deliberately narrow set: "U S BANK N A" (space between N and A)
    # does NOT reach "US BANK" and never has — the override pattern matches "NA"
    # but not "N A". That is a separate, pre-existing gap in the override list,
    # unrelated to leading numbers, and asserting it here would make this file
    # fail for a reason it does not own. Recorded in SESSION_LOG instead.
    bank = {canonicalize(n) for n in
            ('U S BANK NATIONAL ASSOCIATION', 'U S BANK NA',
             'US BANK NATIONAL ASSOCIATION AS TRUSTEE')}
    if len(bank) != 1:
        failures.append(f'US Bank fragmented into {len(bank)}: {sorted(bank)}')

    print(f'  · {len(CASES)} rules checked, plus a merge and a split assertion')
    print('  · no database and no network needed')
    if failures:
        print('\nFAILED:')
        for f in failures:
            print(f'  ✗ {f}')
        return 1
    print('\n✅ leading-number handling holds')
    return 0


if __name__ == '__main__':
    sys.exit(main())
