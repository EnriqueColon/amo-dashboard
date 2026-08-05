"""
Merge proposals for OCR-damaged entity names.
---------------------------------------------
entity_names.entity_key() answers "do these two strings normalize to the same
thing?".  That is not enough for production data, where the dominant defect is
character-level OCR damage: VASTER SUB II -> SUB IL / SUB HU / SUB dI / SUBMIT.
No independent per-name transform can fix those without also merging genuinely
different entities (VASTER LOANS II vs III are separate companies).

So this module compares names against each other and emits PROPOSALS in two
tiers.  It never mutates anything.

  AUTO     safe enough to apply mechanically. Each rule is either lossless or
           self-validating (see "confirmed landing" below).
  REVIEW   probably the same entity, but the evidence is circumstantial.
           A human confirms, and the decision is stored in entity_aliases.

## The three AUTO rules

1. Punctuation becomes a SPACE, not nothing.  "VASTER'SUB II" currently keys to
   VASTERSUB II and matches nothing; as VASTER SUB II it lands correctly.

2. Known OCR misreads of LLC (LEC/LUC/LLG/LCC/IIC), final position only, and
   ONLY when the corrected name already exists in the corpus — the "confirmed
   landing" rule.  PFG LOAN FUNDER I LEC becomes ...LLC because PFG Loan Funder
   I, LLC is genuinely present.  If nothing matched we leave it alone, so the
   rule cannot invent an entity.

3. An ABSENT suffix matches any suffix; CONFLICTING suffixes never match.
   "WINSTON ... GROUP" joins "WINSTON ... GROUP, LLC"; "X LLC" never joins
   "X INC".  If a bare name could match two different suffixed variants it is
   ambiguous — we do not merge, we emit it as REVIEW.

## Why REVIEW exists rather than a looser rule

A rule slack enough to pull "SUB IL" into "SUB II" would also pull "LOANS II"
into "LOANS III", inventing a lending relationship that does not exist.  A
duplicate row looks wrong and gets fixed; a fabricated merge looks correct and
does not.  So near-misses carry their evidence to a human instead.
"""
import re
from collections import defaultdict

import entity_names

# Legal suffixes, and the OCR corruptions of LLC we are willing to correct.
SUFFIXES = {'LLC', 'INC', 'LP', 'LLP', 'CORP', 'LTD', 'CO', 'PA', 'PLLC', 'PC',
            # Spelled-out forms appear in county records as often as the
            # abbreviations. Omitting them made incorporated entities look
            # like private individuals and sank real families to LOW.
            'CORPORATION', 'INCORPORATED', 'COMPANY', 'LIMITED'}
LLC_OCR = {'LEC', 'LUC', 'LLG', 'LCC', 'IIC', 'L1C', 'LLO', 'LIC'}

# How far apart two stems may be and still be worth a human's attention.
REVIEW_MAX_DISTANCE = 2
# Stems shorter than this produce too many false neighbours to be useful.
REVIEW_MIN_STEM_LEN = 6

_ROMAN_RE = re.compile(r'^(?=[IVXL])M*(C[MD]|D?C*)(X[CL]|L?X*)(I[XV]|V?I*)$')


# Entity series really do run I, II, III... so two names differing ONLY in a
# valid trailing numeral are siblings, not misreadings of each other. Bounded,
# because "SUB LI" (51) is a scanner mangling "SUB II" rather than the
# fifty-first entity in a series.
MAX_PLAUSIBLE_SERIES = 20
_ROMAN_VALUES = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000}


def numeral_value(tok: str) -> int | None:
    """Value of a trailing series marker, or None if it is not a valid one."""
    if tok.isdigit():
        return int(tok)
    if not tok or not _ROMAN_RE.match(tok):
        return None
    total, prev = 0, 0
    for ch in reversed(tok):
        v = _ROMAN_VALUES[ch]
        total += -v if v < prev else v
        prev = max(prev, v)
    return total


def are_siblings(stem_a: str, stem_b: str) -> bool:
    """True when two stems differ only by a plausible series numeral.

    This is the rule that protects sub-entities: VASTER LOANS II and VASTER
    LOANS III are separate companies under one parent, and they legitimately
    share a facility amount because facility_amount is the parent facility's
    credit limit quoted on every filing. Amount agreement therefore cannot be
    trusted to tell them apart — the numeral can.
    """
    a, b = stem_a.split(), stem_b.split()
    if len(a) != len(b) or a[:-1] != b[:-1] or not a or not b:
        return False
    va, vb = numeral_value(a[-1]), numeral_value(b[-1])
    return (va is not None and vb is not None and va != vb
            and va <= MAX_PLAUSIBLE_SERIES and vb <= MAX_PLAUSIBLE_SERIES)


def health(stem: str, suffix: str | None) -> int:
    """How likely a spelling is to be the UNDAMAGED one.

    Merges must point at the healthy spelling, not away from it. Filing count
    alone is not enough: "VASTER LOANS IH" carries more filings than the real
    "VASTER LOANS II", so ranking by popularity would make the corrupted form
    canonical and show it in the UI.

    Two signals, both cheap and specific to how this data degrades:
      - a real legal suffix beats an OCR'd one (LLC over LEC/LUC/LLG)
      - a trailing roman numeral or digit beats noise (II over IH/IL/HU/dI),
        because entity names really do end in series numbers
    """
    score = 2 if suffix in SUFFIXES else 0
    tail = stem.split()[-1] if stem.split() else ''
    if tail and (_ROMAN_RE.match(tail) or tail.isdigit()):
        score += 1
    return score


def tokens(name: str) -> list[str]:
    """Uppercase word list. Rule 1: every non-alphanumeric run becomes a space,
    so punctuation separates words instead of welding them together."""
    return re.sub(r'[^A-Z0-9]+', ' ', (name or '').upper()).split()


def split_suffix(toks: list[str]) -> tuple[str, str | None]:
    """Return (stem, suffix). Suffix is None when the name carries none.

    OCR corruptions of LLC count as suffix candidates here — otherwise
    "VASTER SUB II LEC" keeps LEC inside its stem and can never match
    "VASTER SUB II LLC", which defeats rule 2 entirely.
    """
    if toks and toks[-1] in SUFFIXES | LLC_OCR:
        return ' '.join(toks[:-1]), toks[-1]
    return ' '.join(toks), None


def edit_distance(a: str, b: str, cap: int) -> int:
    """Levenshtein, abandoned once it provably exceeds cap."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _corrected_suffix(suffix: str | None, stem: str, known_stems_with_llc: set) -> str | None:
    """Rule 2. Only rewrite an OCR'd LLC when the corrected name really exists."""
    if suffix in LLC_OCR and stem in known_stems_with_llc:
        return 'LLC'
    return suffix


def propose(records: list[dict]) -> dict:
    """records: [{name, amounts, filings}, ...]

    `amounts` is a SET of every distinct facility amount seen for that name, not
    a single value. Production data settled this: one entity legitimately files
    at several amounts (4774 North Bay appears at $13.0M and $10.36M), so a
    scalar would make "the" amount arbitrary and the evidence meaningless.

    Returns {'auto': [...], 'review': [...], 'groups': {name: group_id}}.
    Nothing is written; the caller decides what to do with the proposals.
    """
    parsed = []
    for r in records:
        toks = tokens(r['name'])
        stem, suffix = split_suffix(toks)
        # raw_suffix survives rule 2's rewrite. Without it, once LEC has been
        # corrected to LLC both spellings look equally healthy and the damaged
        # one can win the display name.
        parsed.append({**r, 'stem': stem, 'suffix': suffix, 'raw_suffix': suffix})

    # Rule 2 needs to know which stems genuinely appear with a real LLC before
    # it may rewrite a corrupted one — that is the "confirmed landing".
    known_llc = {p['stem'] for p in parsed if p['suffix'] == 'LLC'}
    for p in parsed:
        p['suffix'] = _corrected_suffix(p['suffix'], p['stem'], known_llc)

    # ── AUTO: group by stem, honouring rule 3 on suffixes ────────────────────
    by_stem = defaultdict(list)
    for p in parsed:
        by_stem[p['stem']].append(p)

    auto, ambiguous = [], []
    for stem, members in by_stem.items():
        suffixes = {m['suffix'] for m in members if m['suffix']}
        if len(suffixes) > 1:
            # Conflicting suffixes: LLC and INC are different companies. Keep
            # them apart, and send any bare-suffix member to review because it
            # cannot be attributed to either one.
            for m in members:
                if m['suffix'] is None:
                    ambiguous.append({'member': m, 'candidates': sorted(suffixes),
                                      'reason': 'bare name matches multiple suffixes'})
            for suf in suffixes:
                grp = [m for m in members if m['suffix'] == suf]
                if len(grp) > 1:
                    auto.append(grp)
        elif len(members) > 1:
            auto.append(members)

    # ── REVIEW: near-miss stems, carrying their corroborating evidence ───────
    # Anchor on the largest group for a stem: OCR damage is the exception, so
    # the healthy spelling is almost always the one with the most filings.
    anchors = sorted(
        ({'stem': s, 'filings': sum(m['filings'] for m in ms),
          'amounts': {a for m in ms for a in m['amounts']},
          'health': max(health(s, m['raw_suffix']) for m in ms)}
         for s, ms in by_stem.items()),
        key=lambda a: (-a['health'], -a['filings']))

    grouped_stems = {m['stem'] for grp in auto for m in grp}
    review, siblings = [], []
    for p in parsed:
        if len(p['stem']) < REVIEW_MIN_STEM_LEN:
            continue
        # Already resolved by an AUTO rule — do not also queue it for a human.
        if p['stem'] in grouped_stems:
            continue
        # Collect every plausible anchor, then choose — picking the first match
        # by filing count alone gets this wrong in exactly the case that
        # matters. VASTER LOANS IH ($102.5M) is one character from both
        # VASTER LOANS III ($127.5M, 29 filings) and VASTER LOANS II
        # ($102.5M, 1 filing). The amount identifies the real target; filing
        # count would hand it to the wrong sibling and fabricate a merge.
        p_rank = (health(p['stem'], p['raw_suffix']), p['filings'])
        candidates = []
        for anchor in anchors:
            # Only ever propose merging INTO a healthier (or equally healthy
            # but better-attested) spelling, never away from one.
            if anchor['stem'] == p['stem'] or p_rank >= (anchor['health'], anchor['filings']):
                continue
            d = edit_distance(p['stem'], anchor['stem'], REVIEW_MAX_DISTANCE)
            if d > REVIEW_MAX_DISTANCE:
                continue
            if are_siblings(p['stem'], anchor['stem']):
                siblings.append({'name': p['name'], 'stem': p['stem'],
                                 'sibling_of': anchor['stem']})
                continue
            # Any shared amount is corroboration. Full disjointness is
            # counter-evidence — but only weak counter-evidence, since one
            # entity really does file at several amounts.
            agrees = bool(p['amounts'] & anchor['amounts'])
            conflicts = bool(p['amounts'] and anchor['amounts'] and not agrees)
            candidates.append((agrees, d, anchor, conflicts))
        if candidates:
            # Amount agreement outranks closeness; closeness outranks size.
            amount_agrees, d, anchor, conflicts = min(
                candidates, key=lambda c: (c[3], not c[0], c[1], -c[2]['filings']))
            review.append({
                'name': p['name'], 'stem': p['stem'], 'filings': p['filings'],
                'amounts': sorted(p['amounts']), 'target': anchor['stem'],
                'distance': d, 'amount_agrees': amount_agrees,
                'amount_conflicts': conflicts,
                # Matching amounts mean "same entity, misread". Differing
                # amounts are normal between siblings under one parent, so
                # their absence is weak evidence, not counter-evidence.
                'confidence': 'conflict' if conflicts
                              else 'high' if amount_agrees and d == 1
                              else 'medium' if amount_agrees or d == 1
                              else 'low',
            })

    return {'auto': auto, 'review': review, 'ambiguous': ambiguous,
            'siblings': siblings,
            'stems_grouped': grouped_stems}


# ── Parent families ───────────────────────────────────────────────────────────
# A parent groups sub-entities WITHOUT merging them. VASTER LOANS III and VASTER
# SUB II stay separate rows with separate facilities; the parent is a folder
# above them, not a combination of them.
#
# This can never be fully automatic. "Shared leading word" groups Vaster
# correctly and would also group BANK OF AMERICA with BANK OF THE OZARKS. So it
# proposes, a human confirms, and confirmations persist. New entities matching a
# confirmed family are proposed again rather than absorbed silently — otherwise
# an unrelated company could join a family months later with nobody seeing it.

# Leading words that describe a place or a line of business rather than a
# corporate family. Observed in production: NORTH, METRO, SHORE, SAFE all
# produced spurious families.
GENERIC_LEAD = {
    'NORTH', 'SOUTH', 'EAST', 'WEST', 'MIAMI', 'BEACH', 'METRO', 'SHORE',
    'SAFE', 'BANK', 'CAPITAL', 'FIRST', 'NEW', 'THE', 'GRAND', 'ROYAL',
    'AMERICAN', 'ATLANTIC', 'PACIFIC', 'CENTRAL', 'UNITED', 'GLOBAL',
    'PREMIER', 'PRIME', 'STAR', 'SUN', 'PALM', 'BAY', 'OCEAN', 'CITY',
}
PARENT_MIN_LEAD_LEN = 4      # shorter leads (BI, GJ, FC) are too weak alone
PARENT_MIN_ENTITIES = 2


def propose_parents(records: list[dict], confirmed: dict | None = None) -> list[dict]:
    """Propose corporate families. records need name, filings, and lender.

    Returns proposals only — nothing is assigned. `confirmed` maps an already
    approved entity stem to its parent, so settled entities are not re-proposed.
    """
    confirmed = confirmed or {}
    families = defaultdict(list)
    for r in records:
        stem, suffix = split_suffix(tokens(r['name']))
        if not stem:
            continue
        lead = stem.split()[0]
        families[lead].append({**r, 'stem': stem, 'suffix': suffix})

    proposals = []
    for lead, members in families.items():
        distinct = {m['stem'] for m in members}
        if len(distinct) < PARENT_MIN_ENTITIES:
            continue
        pending = [m for m in members if m['stem'] not in confirmed]
        if not pending:
            continue

        # Normalize lender names through the shared address book. Comparing
        # raw text split "City National Bank of Florida" from its all-caps form
        # and made Vaster look like a two-lender family when all 21 of its
        # filings face one bank.
        lenders = {entity_names.entity_key(m['lender'])
                   for m in members if m.get('lender')}
        lenders.discard('')
        # A corporate family almost always carries legal suffixes; a cluster of
        # bare personal names sharing a first name (JOSE) is not a family.
        corporate = sum(1 for m in members if m['suffix']) / len(members)

        # Lender count is reported but does NOT affect confidence. A real
        # corporate group borrows from several banks — Winston runs one entity
        # per relationship (WINSTON AB -> Amerant, BAN -> Banesco, USC -> U.S.
        # Century), so multiple lenders is normal structure, not doubt. Scoring
        # it as doubt buried the most clear-cut families in the list.
        if lead in GENERIC_LEAD or len(lead) < PARENT_MIN_LEAD_LEN:
            confidence = 'low'
        elif corporate >= 0.8:
            confidence = 'high'
        elif corporate >= 0.5:
            confidence = 'medium'
        else:
            confidence = 'low'       # mostly bare names: people, not a family

        proposals.append({
            'parent': lead.title(),
            'lead': lead,
            'entities': sorted(distinct),
            'members': members,
            'filings': sum(m['filings'] for m in members),
            'lenders': sorted(lenders),
            'shared_lender': len(lenders) == 1,
            'corporate_ratio': round(corporate, 2),
            'confidence': confidence,
        })
    order = {'high': 0, 'medium': 1, 'low': 2}
    proposals.sort(key=lambda p: (order[p['confidence']], -p['filings']))
    return proposals


def apply_auto(records: list[dict], result: dict) -> list[dict]:
    """Collapse the AUTO groups into single records.

    Parent proposals must run on POST-merge entities. Otherwise OCR variants
    inflate a family — TG CAPITAL LENDING and TG CAPITAL LENDINGY are one
    company, and counting them as two members makes the family look broader
    than it is.
    """
    merged, absorbed = [], set()
    for grp in result['auto']:
        keep = max(grp, key=lambda m: (health(m['stem'], m['raw_suffix']), m['filings']))
        merged.append({
            'name': keep['name'],
            'amounts': {a for m in grp for a in m['amounts']},
            'filings': sum(m['filings'] for m in grp),
            'lender': keep.get('lender'),
        })
        absorbed.update(m['name'] for m in grp)
    # Match on name, not identity: propose() works on copies of the input
    # records, so an identity check silently absorbs nothing and every row
    # gets counted twice.
    merged.extend(r for r in records if r['name'] not in absorbed)
    return merged


# ── County-recorded names are the authority ───────────────────────────────────
# facility_borrower_name is LLM-extracted from OCR'd document body text — two
# lossy steps. grantor/grantee come from the county's own typed index. Verified
# on CFN 2025R173932: the extractor produced "VASTER SUBIII, LLG" while the
# county index recorded "VASTER SUB III LLC" — a real third entity, not a
# misreading of SUB II. Matching on the extracted name merged five distinct
# Vaster entities incorrectly; matching on the recorded name does not.
#
# The extracted name is still useful as a HINT: a filing records two parties and
# only one is the borrower, so we use the extraction to choose between them.

RECORD_MATCH_MIN = 0.55   # below this the extraction matches neither party


def similarity(a: str, b: str) -> float:
    """0..1 similarity of two names, punctuation- and case-insensitive."""
    a, b = entity_names.squash(a or ''), entity_names.squash(b or '')
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    longest = max(len(a), len(b))
    d = edit_distance(a, b, longest)
    return max(0.0, 1.0 - d / longest)


def resolve_recorded_name(extracted, grantor, grantee, lender) -> tuple[str, str]:
    """Return (name, source) — the county-recorded borrower where we can find it.

    source is 'recorded' when a recorded party matched the extraction well
    enough to be trusted, else 'extracted' with the original name returned
    unchanged. Never invents a name.
    """
    if not extracted:
        return extracted, 'extracted'

    candidates = []
    for party in (grantor, grantee):
        if not party:
            continue
        # A party that IS the lender cannot be the borrower.
        if lender and similarity(party, lender) > 0.85:
            continue
        candidates.append((similarity(party, extracted), party))

    if not candidates:
        return extracted, 'extracted'
    score, best = max(candidates, key=lambda c: c[0])
    if score < RECORD_MATCH_MIN:
        # Recorded parties are third parties (an affiliate co-borrower or a
        # prior holder), not this filing's borrower. Keep the extraction.
        return extracted, 'extracted'
    return best, 'recorded'


def load_facility_records(conn) -> list[dict]:
    """Borrower records for matching, keyed on COUNTY-RECORDED names.

    Resolves each filing individually before aggregating — the recorded name
    varies per filing, so grouping first would pick one arbitrarily and discard
    the evidence that distinguishes SUB II from SUB III.
    """
    rows = conn.execute("""
        SELECT facility_borrower_name, grantor, grantee, facility_lender_name,
               facility_amount
          FROM credit_facility_events
         WHERE facility_borrower_name IS NOT NULL
    """).fetchall()

    agg: dict = {}
    for extracted, grantor, grantee, lender, amount in rows:
        name, source = resolve_recorded_name(extracted, grantor, grantee, lender)
        rec = agg.setdefault(name, {'name': name, 'amounts': set(), 'filings': 0,
                                    'lender': lender, 'from_recorded': 0,
                                    'extracted_as': set()})
        rec['filings'] += 1
        if amount is not None:
            rec['amounts'].add(str(amount))
        if source == 'recorded':
            rec['from_recorded'] += 1
        if extracted != name:
            rec['extracted_as'].add(extracted)
        if not rec['lender']:
            rec['lender'] = lender
    return list(agg.values())
