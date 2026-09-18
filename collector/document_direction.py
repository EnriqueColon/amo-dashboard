"""
Which way did the loan move? — the county index vs the document
================================================================
In Miami-Dade the county index sometimes lists the two parties of an
assignment in reverse: the index says Nationstar -> Wells Fargo, the recorded
document says Wells Fargo, "(ASSIGNOR)", assigns to Nationstar, "(ASSIGNEE)".
Measured 17-18 Sep 2026 on 51-55k Miami-Dade loan transfers:

    bucket (AI-read document parties vs the index)      rows    verdict
    D1  same order, names match exactly                18,153   right (14/14 decided)
    D2  same order, one name is a variant              20,698   right
    D3  exact reverse                                   3,566   WRONG (9/9 by eye, 64/65 by
                                                                  text, 8/8 JPMorgan/FDIC,
                                                                  QC 16/17 decided)
    D4  reverse, one name is a variant                  3,912   WRONG (QC 12/13 decided; the
                                                                  one "confirm" read by eye
                                                                  was reversed too)
    D5  names do not match                              4,587   mostly the homeowner /
                                                                  MERS-nominee problem, not
                                                                  direction

Rule, used by normalize.py for every Miami-Dade row on every rebuild:

  * The DOCUMENT decides the direction; the index still supplies the spelling.
    Direction comes from the AI reading of the document (pdf_assignor /
    pdf_assignee), because that is what the evidence above validated.
  * An independent TEXT check reads the stored OCR (document_text, filled by
    reread_documents.py) using only the index names, never the AI's. It is a
    veto and a second opinion, not the driver: it abstains often
    ("undetermined") and its known noise — shared servicer addresses, recitals
    naming the other party — is why it never swaps a row on its own.

        D3 / D4   swap, unless the text check says the index order is right
                  -> then keep the index order and flag for review
        D1 / D2   keep; if the text check says reversed -> flag for review
        D5        keep; if the text check says reversed -> flag for review

  * Every decision is written to `direction_decisions` (rebuilt each run) so
    the swaps and the review list can be audited without re-deriving them.

Broward is excluded: its index was checked and is not reversed (0 rows).

Self-test, no database:  python3 collector/document_direction.py --selftest
Measure on production:   AMO_DB_PATH=... python3 collector/document_direction.py --measure
"""
import re
import sys
import zlib

# Tokens that identify nothing on their own. Same list the QC audit uses.
STOP = {'BANK', 'NA', 'N', 'A', 'LLC', 'L', 'C', 'INC', 'CORP', 'CORPORATION', 'COMPANY', 'CO', 'TRUST', 'TRU',
        'NATIONAL', 'ASSOCIATION', 'THE', 'OF', 'AND', 'FSB', 'LP', 'LTD', 'MORTGAGE', 'MTG', 'FUND', 'AS',
        'TRUSTEE', 'FOR', 'SERVICES', 'SERVICING', 'LOAN', 'LOANS', 'FINANCIAL', 'HOME', 'CAPITAL', 'FIRST',
        'AMERICAN', 'FEDERAL', 'GROUP', 'HOLDINGS', 'SAVINGS', 'SOCIETY', 'NOT', 'ITS', 'INDIVIDUAL',
        'CAPACITY', 'BUT', 'SOLELY', 'OWNER', 'SERIES', 'LENDING', 'LENDER'}

# Names whose index spelling and document spelling share no distinctive token.
ALIASES = [
    (r'FEDERAL NATIONAL MORTGAGE|FANNIE', r'FEDERAL\s+NATIONAL\s+MORTGAGE|FANNIE\s+MAE'),
    (r'FEDERAL HOME LOAN MORTGAGE|FREDDIE', r'FEDERAL\s+HOME\s+LOAN\s+MORTGAGE|FREDDIE\s+MAC'),
    (r'MORTGAGE ELECTRONIC|^\s*MERS\b', r'MORTGAGE\s+ELECTRONIC|\bMERS\b'),
    (r'^\s*U\s*S\s+BANK|^\s*US\s+BANK', r'U\.?\s*S\.?\s*BANK'),
    (r'J\s*P\s*MORGAN|JPMORGAN', r'J\.?\s*P\.?\s*MORGAN'),
    (r'FEDERAL DEPOSIT', r'FEDERAL\s+DEPOSIT'),
    (r'SECRETARY OF HOUSING|HOUSING AND URBAN', r'SECRETARY\s+OF\s+HOUSING|HOUSING\s+AND\s+URBAN'),
    (r'NATIONSTAR|MR\.?\s*COOPER', r'NATIONSTAR|MR\.?\s*COOPER'),
    (r'NEWREZ|NEW\s*REZ|SHELLPOINT', r'NEW\s*REZ|SHELLPOINT'),
]


def name_regex(raw):
    """Distinctive tokens of a name, in order, allowing up to 3 words between
    (the first version required them adjacent and missed 'Alto CAPITAL Holdings')."""
    if not raw:
        return None
    s = re.sub(r'[^A-Z0-9 ]', ' ', raw.upper())
    for trigger, pat in ALIASES:
        if re.search(trigger, s):
            return re.compile(pat, re.I)
    toks = [t for t in s.split() if len(t) >= 3 and t not in STOP][:3]
    if not toks:
        # Short brand names such as "A&D MORTGAGE LLC" leave no distinctive
        # token. Fall back to the first word spelled letter by letter, allowing
        # the punctuation between ("A&D", "A & D"), but only when it carried
        # punctuation — a bare two-letter word matches too much text.
        first = raw.upper().split()[0] if raw.split() else ''
        chars = re.sub(r'[^A-Z0-9]', '', first)
        if len(chars) >= 2 and re.search(r'[^A-Z0-9]', first):
            return re.compile(r'\b' + r'\W{0,3}'.join(re.escape(c) for c in chars) + r'\b', re.I)
        return None
    if len(toks) == 1 and len(toks[0]) < 5:
        return None                      # one short word matches too much text
    return re.compile(r'\b' + r'(?:\W+\w+){0,3}?\W+'.join(re.escape(t) for t in toks) + r'\b', re.I)


# ── Text cleanup ────────────────────────────────────────────────────────────
# A party's mailing address often names ANOTHER party: Rushmore's address is
# "C/O NATIONSTAR MORTGAGE LLC, 8950 CYPRESS WATERS BLVD., COPPELL, TX". Read
# as-is, that puts Nationstar on the assignor's side of the sentence. Blank
# out every address phrase (up to its ZIP code) and every return-to / prepared-
# by header before looking for names.
_ADDR = re.compile(
    r'(?:\bWHOSE\s+(?:MAILING\s+)?ADDRESS\s+IS|\bHAVING\s+(?:ITS|AN?)\s+(?:PRINCIPAL\s+)?(?:OFFICE|ADDRESS|PLACE\s+OF\s+BUSINESS)'
    r'|\bWITH\s+(?:ITS|AN?)\s+(?:PRINCIPAL\s+)?(?:OFFICE|ADDRESS)|\bLOCATED\s+AT|\bC/O\b|\bCARE\s+OF\b'
    r'|\bRETURN(?:ED)?\s+TO\b|\bPREPARED\s+BY\b|\bMAIL\s+TO\b|\bADDRESS\s*:)'
    r'.{0,200}?\b\d{5}(?:-\d{4})?\b', re.I | re.S)
# Recital that names the PAYER, i.e. the assignee, before the verb:
# "...party of the first part, in consideration of $10 received from ALATKA..."
_PAYER = re.compile(r'\b(?:RECEIVED\s+(?:FROM|OF)|PAID\s+(?:TO\s+\w+\s+)?BY|ON\s+BEHALF\s+OF)\b', re.I)
# Where the assignee clause ends and the description of the mortgage begins —
# "...unto the said party of the second part a certain mortgage made by X in
# favor of NO LIMIT..." must not read NO LIMIT as the assignee.
_MTG_DESC = re.compile(
    r'\b(?:(?:A|THAT|THE|SAID)\s+(?:CERTAIN\s+)?(?:MORTGAGE|NOTE|DEED|SECURITY\s+INSTRUMENT)|MADE\s+BY|'
    r'EXECUTED\s+BY|IN\s+FAVOR\s+OF|GIVEN\s+BY|ORIGINAL\s+(?:MORTGAGEE|LENDER|MORTGAGOR)|DATED\b)', re.I)
_VERB = re.compile(r'\b(?:assign|assigns|convey|conveys|transfer|transfers|sell|sells|set\s+over)\b'
                   r'[^.;]{0,260}?\b(?:to|unto)\b', re.I)
_LABEL = re.compile(r'\b(assignor|assignee)\b', re.I)


# "MERS, as nominee for CITY NATIONAL BANK, its successors and assigns
# (Assignor) ... unto City National Bank (Assignee)". The lender named inside
# the nominee phrase is often the ASSIGNEE too, so reading it as assignor-side
# evidence flags correct rows. Blank the phrase; MERS itself stays in place.
_NOMINEE = re.compile(r'\bAS\s+NOMINEE\s+FOR\b.{0,160}?(?=\bITS\s+SUCCESSORS\b|\(|["\u201c\u201d]|'
                      r'\bWHOSE\b|\bBY\s+THESE\b|\bDOES\b|\bHEREBY\b|$)', re.I | re.S)


def _clean(text: str) -> str:
    t = ' '.join(text.split())
    t = _ADDR.sub(' ; ', t)
    return _NOMINEE.sub(' AS NOMINEE ; ', t)


def _last_match(seg, pats):
    best = None
    for key, p in pats.items():
        for m in p.finditer(seg):
            if best is None or m.end() > best[1]:
                best = (key, m.end())
    return best[0] if best else None


def _first_match(seg, pats):
    best = None
    for key, p in pats.items():
        m = p.search(seg)
        if m and (best is None or m.start() < best[1]):
            best = (key, m.start())
    return best[0] if best else None


def text_verdict(text: str | None, index_assignor: str | None, index_assignee: str | None) -> str | None:
    """'FORWARD' if the document makes the index's assignor the assignor,
    'REVERSED' if it makes the index's assignee the assignor, None if it cannot
    tell. Uses ONLY the index names, so it is independent of the AI reading."""
    if not text:
        return None
    pa, pb = name_regex(index_assignor), name_regex(index_assignee)
    if not pa or not pb or pa.pattern == pb.pattern:
        return None
    pats = {'A': pa, 'B': pb}
    t = _clean(text)
    votes = []

    # 1. The operative sentence: "<assignor> ... does hereby assign ... to <assignee>"
    for m in _VERB.finditer(t):
        before = t[max(0, m.start() - 400):m.start()]
        payer = None
        for payer in _PAYER.finditer(before):
            pass
        if payer:
            before = before[:payer.start()]
        after = t[m.end():m.end() + 260]
        d = _MTG_DESC.search(after)
        if d:
            after = after[:d.start()]
        a, b = _last_match(before, pats), _first_match(after, pats)
        if a and b and a != b:
            votes.append(a)
        elif a and not b:
            votes.append(a)                 # assignee given only as "party of the second part"
        elif b and not a:
            votes.append('B' if b == 'A' else 'A')
        break                               # only the first operative sentence

    # 2. Explicit role labels. Two layouts: "WELLS FARGO BANK, N.A. (ASSIGNOR)"
    #    names the party BEFORE the label; the form layout "Assignor: FIRSTKEY
    #    MORTGAGE, LLC ... Assignee: TOWD POINT" names it AFTER.
    for m in _LABEL.finditer(t):
        role = m.group(1).upper()
        if re.match(r'\s*["\u201c\u201d\u2019\']*\s*:', t[m.end():m.end() + 6]):
            # Form layout: the party runs from the colon to the NEXT label —
            # otherwise "Assignor: MERS, as nominee for ... Assignee: U.S. BANK"
            # reads U.S. Bank as the assignor.
            seg = t[m.end():m.end() + 200]
            nxt = re.search(r'\b(?:assignor|assignee|executed\s+by)\b', seg[2:], re.I)
            who = _first_match(seg[:nxt.start() + 2] if nxt else seg, pats)
        else:
            who = _last_match(t[max(0, m.start() - 300):m.start()], pats)
        if who:
            votes.append(who if role == 'ASSIGNOR' else ('B' if who == 'A' else 'A'))
            break

    if votes and len(set(votes)) == 1:
        return 'FORWARD' if votes[0] == 'A' else 'REVERSED'
    return None


# ── AI-reading bucket ───────────────────────────────────────────────────────
def bucket(index_a_canon: str, index_b_canon: str, pdf_a_canon: str | None, pdf_b_canon: str | None) -> str:
    """D1..D5 as defined in the module docstring (same definition as the QC)."""
    ca, cb, a, b = pdf_a_canon, pdf_b_canon, index_a_canon, index_b_canon
    if not ca or not cb or ca == 'UNKNOWN' or cb == 'UNKNOWN':
        return 'D0'                                   # no document parties
    fwd = (ca == a) + (cb == b)
    rev = (ca == b) + (cb == a)
    # A tie means the document names the same party on both sides once folded —
    # "CITIMORTGAGE" canonicalises to CITIBANK, "CITIGROUP MORTGAGE LOAN TRUST
    # ... BY U.S. BANK" to US BANK. That is evidence of nothing, never a swap.
    if fwd == rev:
        return 'D5'
    if rev == 2:
        return 'D3'
    if rev == 1 and fwd == 0:
        return 'D4'
    return 'D1' if fwd == 2 else 'D2'


def decide(bkt: str, verdict: str | None) -> tuple[bool, bool]:
    """(swap, needs_review) for one row."""
    if bkt in ('D3', 'D4'):
        if verdict == 'FORWARD':
            return False, True
        return True, False
    if verdict == 'REVERSED':
        return False, True
    return False, False


def load_texts(conn) -> dict:
    """cfn -> OCR text for every stored document. ~55k rows, ~90 MB unpacked."""
    try:
        return {cfn: zlib.decompress(z).decode('utf-8', 'replace')
                for cfn, z in conn.execute(
                    "SELECT cfn, text_z FROM document_text WHERE status = 'OK' AND text_z IS NOT NULL")}
    except Exception:                                   # noqa: BLE001 - table may not exist yet
        return {}


# ── Offline self-test: real cases read by eye on 17-18 Sep 2026 ─────────────
SELFTEST = [
    # (text excerpt, index assignor, index assignee, expected)
    ('ASSIGNMENT OF MORTGAGE FOR GOOD AND VALUABLE CONSIDERATION, the sufficiency of which is hereby '
     'acknowledged, the undersigned, RUSHMORE LOAN MANAGEMENT SERVICES, LLC, WHOSE ADDRESS IS C/O NATIONSTAR '
     'MORTGAGE LLC, 8950 CYPRESS WATERS BLVD., COPPELL, TX 75019, (ASSIGNOR), by these presents does convey, '
     'grant, assign, transfer and set over the described Mortgage with all interest secured thereby, all liens, '
     'and any rights due or to become due thereon to NATIONSTAR MORTGAGE LLC, WHOSE ADDRESS IS 8950 CYPRESS '
     'WATERS BLVD., COPPELL, TX 75019, ITS SUCCESSORS AND ASSIGNS, (ASSIGNEE).',
     'NATIONSTAR MORTGAGE LLC', 'RUSHMORE LOAN MANAGEMENT SERVICES LLC', 'REVERSED'),   # 2024R153948
    ('NO LIMIT MORTGAGE SOLUTIONS, INC. a Florida Corporation, party of the first part, in consideration of the '
     'sum of Ten ($10.00) Dollars, and other valuable considerations, received from or on behalf of ALATKA '
     'FINANCIAL CORPORATION, whose address is 1550 Madruga Ave., Suite 504, Coral Gables, Fl 33146, party of the '
     'second part, at or before the ensealing and delivery of these presents, the receipt whereof is hereby '
     'acknowledged, does hereby grant, bargain, sell, assign, transfer and set over unto the said party of the '
     'second part a certain mortgage, note and other loan documents made by MAURITIUS INTERNATIONAL INVESTMENT, '
     'LLC in favor of NO LIMIT MORTGAGE SOLUTIONS, INC.',
     'NO LIMIT MORTGAGE SOLUTIONS INC', 'ALATKA FINANCIAL CORP', 'FORWARD'),             # 2024R950033
    ('ASSIGNMENT OF MORTGAGE FOR VALUE RECEIVED, Mortgage Electronic Registration Systems, INC., as mortgagee, as '
     'nominee for A&D Mortgage LLC, a Florida Limited Liability Company, its successors and assigns, whose address '
     'is P.O. Box 2026, Flint, MI 48501-2026 ("Assignor") hereby grants, assigns and transfers to Anchor Bank, '
     'whose address is 4500 Pga Blvd Palm Beach Gardens, FL 33418 ("Assignee") all its rights',
     'ANCHOR BANK', 'A&D MORTGAGE LLC', 'REVERSED'),                                      # 2026R556954
    ('FOR GOOD AND VALUABLE CONSIDERATION, the undersigned, FORETHOUGHT LIFE INSURANCE COMPANY, whose address is '
     '30 HUDSON YARDS, 75TH FLOOR, NEW YORK, NY 10001, (ASSIGNOR), does hereby grant, assign and transfer to '
     'FIRSTKEY MORTGAGE, LLC, whose address is 900 THIRD AVENUE SUITE 500, NEW YORK, NY 10022, (ASSIGNEE)',
     'FORETHOUGHT LIFE INSURANCE CO', 'FIRSTKEY MORTGAGE LLC', 'FORWARD'),                 # 2026R68031
    ('CORPORATE ASSIGNMENT OF MORTGAGE Miami-Dade, Florida Date of Assignment: JUL 23 2026 Assignor: FIRSTKEY '
     'MORTGAGE, LLC. BY SELECT PORTFOLIO SERVICING, INC. AS ITS ATTORNEY IN FACT at C/O SELECT PORTFOLIO SERVICING, '
     'INC. 3217 S. DECKER LAKE DRIVE, SALT LAKE CITY, UT 84119 Assignee: TOWD POINT MORTGAGE TRUST 2020-4, U.S. BANK '
     'NATIONAL ASSOCIATION, AS INDENTURE TRUSTEE at C/O SELECT PORTFOLIO SERVICING, INC., 3217 S. DECKER LAKE DRIVE, '
     'SALT LAKE CITY, UT 84119 Executed By: JOSE GABRIEL BENITEZ',
     'TOWD POINT MORTGAGE TRUST 2020 4', 'FIRSTKEY MORTGAGE LLC', 'REVERSED'),            # 2026R549989
    ('ASSIGNMENT OF MORTGAGE FOR VALUE RECEIVED, the undersigned, Mortgage Electronic Registration Systems, Inc., '
     'as mortgagee, as nominee for City National Bank of Florida., its successors and assigns ("Assignor"), whose '
     'address is P.O. Box 2026, Flint, MI 48501- 2026, does hereby grant and convey unto City National Bank of '
     'Florida ("Assignee"), all of Assignor\'s rights, title and all interest under a certain mortgage',
     'MORTGAGE ELECTRONIC REGISTRATION SYSTEMS INC', 'CITY NATIONAL BANK OF FLORIDA', 'FORWARD'),  # 2026R593484
    ('CORPORATE ASSIGNMENT OF MORTGAGE Miami-Dade, Florida Date of Assignment: MAY 11 2026 Assignor: MORTGAGE '
     'ELECTRONIC REGISTRATION SYSTEMS, INC. ("MERS") AS MORTGAGEE, AS NOMINEE FOR CITY NATIONAL BANK OF FLORIDA, ITS '
     'SUCCESSORS AND ASSIGNS at P.O. Box 2026, FLINT, MI 48501-2026 Assignee: U.S. Bank Trust Company, National '
     'Association, not in its individual capacity but solely as trustee for COLT Mortgage Loan Trust 2023-1 at C/O '
     'SELECT PORTFOLIO SERVICING, INC, 3217 S. DECKER LAKE DRIVE, SALT LAKE CITY, UT 84119 Executed By: ERIC ED',
     'CITY NATIONAL BANK OF FLORIDA', 'U S BANK TRUST COMPANY NATIONAL ASSOCIATION', 'FORWARD'),  # 2026R351560
]


def _selftest() -> int:
    bad = 0
    for text, ia, ib, want in SELFTEST:
        got = text_verdict(text, ia, ib)
        ok = got == want
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {ia} -> {ib}: {got} (want {want})")
    for args, want in [(('US BANK', 'CITIGROUP MORTGAGE LOAN TRUST', 'US BANK', 'US BANK'), 'D5'),
                       (('ANCHOR BANK', 'A&D MORTGAGE', 'MERS', 'ANCHOR BANK'), 'D4'),
                       (('NATIONSTAR / MR. COOPER', 'WELLS FARGO', 'WELLS FARGO', 'NATIONSTAR / MR. COOPER'), 'D3'),
                       (('WELLS FARGO', 'FREEDOM MORTGAGE', 'WELLS FARGO', 'FREEDOM MORTGAGE'), 'D1')]:
        got = bucket(*args)
        bad += got != want
        print(f"{'ok  ' if got == want else 'FAIL'} bucket{args} = {got}")
    for bkt, v, want in [('D3', None, (True, False)), ('D3', 'FORWARD', (False, True)),
                         ('D4', 'REVERSED', (True, False)), ('D1', 'REVERSED', (False, True)),
                         ('D1', 'FORWARD', (False, False)), ('D5', None, (False, False)),
                         ('D0', 'REVERSED', (False, True))]:
        got = decide(bkt, v)
        ok = got == want
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} decide({bkt}, {v}) = {got}")
    print('PASS' if not bad else f'{bad} FAILED')
    return 1 if bad else 0


def _measure() -> int:
    """How the text check agrees with each AI bucket on stored documents."""
    import sqlite3, os                                   # noqa: E401
    from collections import Counter, defaultdict
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import normalize as N
    conn = sqlite3.connect(f"file:{os.environ['AMO_DB_PATH']}?mode=ro", uri=True)
    N.load_aliases(conn)
    texts = load_texts(conn)
    res = defaultdict(Counter)
    for cfn, a, b, pa, pb in conn.execute("""
            SELECT cfn, assignor, assignee, pdf_assignor, pdf_assignee FROM aom_events_clean
            WHERE county = 'MIAMI-DADE' AND txn_type != 'SELF_ASSIGN'"""):
        if cfn not in texts:
            continue
        bk = bucket(N.canonicalize(a), N.canonicalize(b),
                    N.canonicalize(pa) if pa else None, N.canonicalize(pb) if pb else None)
        res[bk][text_verdict(texts[cfn], a, b)] += 1
    for bk in sorted(res):
        c = res[bk]
        print(bk, sum(c.values()), dict(c))
    return 0


if __name__ == '__main__':
    if '--measure' in sys.argv:
        sys.exit(_measure())
    sys.exit(_selftest())
