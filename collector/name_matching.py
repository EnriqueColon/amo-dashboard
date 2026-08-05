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

# Legal suffixes, and the OCR corruptions of LLC we are willing to correct.
SUFFIXES = {'LLC', 'INC', 'LP', 'LLP', 'CORP', 'LTD', 'CO', 'PA', 'PLLC', 'PC'}
LLC_OCR = {'LEC', 'LUC', 'LLG', 'LCC', 'IIC', 'L1C', 'LLO', 'LIC'}

# How far apart two stems may be and still be worth a human's attention.
REVIEW_MAX_DISTANCE = 2
# Stems shorter than this produce too many false neighbours to be useful.
REVIEW_MIN_STEM_LEN = 6

_ROMAN_RE = re.compile(r'^(?=[IVXL])M*(C[MD]|D?C*)(X[CL]|L?X*)(I[XV]|V?I*)$')


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
    """records: [{name, amount, filings, first, last}, ...]  (amount may be None)

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
          'amounts': {m['amount'] for m in ms if m['amount']},
          'health': max(health(s, m['raw_suffix']) for m in ms)}
         for s, ms in by_stem.items()),
        key=lambda a: (-a['health'], -a['filings']))

    grouped_stems = {m['stem'] for grp in auto for m in grp}
    review = []
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
            agrees = bool(p['amount'] and p['amount'] in anchor['amounts'])
            # Both sides quote an amount and they disagree: that is positive
            # evidence of DIFFERENT entities, not merely missing evidence.
            # VASTER LOANS II ($102.5M) vs III ($127.5M) are real siblings.
            conflicts = bool(p['amount'] and anchor['amounts']
                             and p['amount'] not in anchor['amounts'])
            candidates.append((agrees, d, anchor, conflicts))
        if candidates:
            # Amount agreement outranks closeness; closeness outranks size.
            amount_agrees, d, anchor, conflicts = min(
                candidates, key=lambda c: (c[3], not c[0], c[1], -c[2]['filings']))
            review.append({
                'name': p['name'], 'stem': p['stem'], 'filings': p['filings'],
                'amount': p['amount'], 'target': anchor['stem'],
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
            'stems_grouped': grouped_stems}
