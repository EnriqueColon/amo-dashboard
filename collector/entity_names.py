"""
Shared entity-name address book.
--------------------------------
One place that decides "are these two strings the same company?", so a
correction taught once applies everywhere instead of being re-taught per
pipeline.  Replaces the hardcoded _FAC_ALIASES dict in normalize.py.

Deliberately standalone: this module imports nothing from normalize.py, so the
dependency runs one way (normalize -> entity_names) and the logic stays testable
without a database or the wider pipeline.

## Two key levels, on purpose

    entity_key()   exact entity.  Punctuation-blind, but legal suffixes are
                   KEPT.  "222 NORTH MIAMI LLC" != "222 NORTH MIAMI INC".
                   Correct for borrowers, which are single-purpose shells whose
                   names differ only by suffix or number.

    brand level    brand family.  Strips LLC/INC/N.A. so every arm of one bank
                   folds together.  Lives in normalize.canonicalize() and is
                   NOT reimplemented here — v1 must not change its output.

Collapsing these into a single key is the one thing that must never happen: at
brand level, 180 distinct Towd Point securitization trusts become one "TOWD
POINT", which is right for "which brands are active" and catastrophic if applied
to borrower names.

## v1 parity guarantee

With no aliases loaded, entity_key() and display_name() reproduce
normalize.facility_name_key() and clean_facility_name() exactly, over every name
in the database — enforced by tests/check_entity_names_parity.py.  So the only
behavior this module introduces is alias resolution, which is the point.
"""
import re

# ── Shared cleanup core ───────────────────────────────────────────────────────

_ROLE_PREFIX_RE = re.compile(
    r'^\s*(?:ASSIGNEE|ASSIGNOR|LENDER|BORROWER)\s*[:\(]\s*', re.IGNORECASE)

# Names that are only a document role, not an entity — extraction gaps.
_ROLE_ONLY = {'LENDER', 'BORROWER', 'ASSIGNEE', 'ASSIGNOR', 'AGENT', 'TRUSTEE', 'BANK'}


def squash(s: str) -> str:
    """Punctuation-free uppercase form used for matching and for alias lookup.

    Ampersand spacing disappears here, which is why the facility side already
    unifies "A & D MORTGAGE" / "A&D MORTGAGE" while the brand side does not.
    """
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', '', s.upper())).strip()


def clean_name(raw) -> str | None:
    """Normalize a raw extracted name for display. Returns None if unusable.

    Legal suffixes are intentionally preserved — these strings are rendered in
    the UI, and for borrowers the suffix carries identity.
    """
    if raw is None or not str(raw).strip():
        return None
    s = re.sub(r'\s+', ' ', str(raw)).strip()
    s = _ROLE_PREFIX_RE.sub('', s)
    if s.endswith(')') and s.count(')') > s.count('('):   # "Assignee (X)" -> "X"
        s = s[:-1].rstrip()
    s = re.sub(r'(\w)\s*-\s*(\w)', r'\1 \2', s)           # "VASTER-LOANS" -> "VASTER LOANS"
    s = re.sub(r'\bIIL\b', 'III', s)                      # OCR misread of III
    s = re.sub(r'\s+', ' ', s).strip(' ,')
    if not s or s.upper() in _ROLE_ONLY:
        return None
    return s


# ── Alias crosswalk (the address book itself) ─────────────────────────────────
# Loaded from the entity_aliases table so corrections made from the dashboard
# survive every rebuild.  Keyed on squash(variant) for punctuation-insensitive
# matching.  Empty until load_aliases() is called — the pure-rule default keeps
# this module reproducible across local, snapshot, and production databases.

_ALIASES: dict[str, str] = {}

# Scope controls which pipelines honor an entry:
#   'all'       both the brand path and the entity path
#   'facility'  entity path only
# The two OCR fixes migrated out of normalize._FAC_ALIASES start facility-scoped
# so v1 provably cannot move brand-level output; promoting them to 'all' is a
# separate, reviewed change.
SCOPES = ('all', 'facility')


def load_aliases(conn, scope: str = 'facility') -> int:
    """Load the alias crosswalk for a scope. Returns the number of entries."""
    global _ALIASES
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entity_aliases (
            variant TEXT PRIMARY KEY,
            canonical TEXT NOT NULL,
            created_at TEXT,
            created_by TEXT,
            note TEXT
        )
    """)
    # Defensive: the column post-dates the table on existing databases.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(entity_aliases)")}
    if 'scope' not in cols:
        conn.execute("ALTER TABLE entity_aliases ADD COLUMN scope TEXT DEFAULT 'all'")

    raw = dict(conn.execute(
        "SELECT variant, canonical FROM entity_aliases "
        "WHERE COALESCE(scope, 'all') IN ('all', ?)", (scope,)))
    _ALIASES = _resolve_chains(raw)
    return len(_ALIASES)


def _resolve_chains(raw: dict) -> dict:
    """Collapse A->B, B->C into A->C. Cycles stop at the first repeat."""
    resolved = {}
    for variant, canon in raw.items():
        seen = {squash(variant)}
        while squash(canon) in {squash(k) for k in raw} and squash(canon) not in seen:
            seen.add(squash(canon))
            canon = next(v for k, v in raw.items() if squash(k) == squash(canon))
        resolved[squash(variant)] = canon
    return resolved


def set_aliases(mapping: dict) -> None:
    """Set the crosswalk directly, without a database. For tests and one-offs."""
    global _ALIASES
    _ALIASES = _resolve_chains(mapping)


def clear_aliases() -> None:
    """Drop all aliases — restores pure-rule behavior."""
    global _ALIASES
    _ALIASES = {}


# ── Public API ────────────────────────────────────────────────────────────────

def display_name(raw) -> str | None:
    """Human-facing name: cleaned, alias-resolved, suffixes intact."""
    cleaned = clean_name(raw)
    if not cleaned:
        return None
    return _ALIASES.get(squash(cleaned), cleaned)


def entity_key(raw) -> str:
    """Exact-entity grouping key.

    Returns '' (not None) when there is no usable name, so SQL grouping and
    dict lookups behave consistently rather than silently dropping rows.
    """
    name = display_name(raw)
    return squash(name) if name else ''
