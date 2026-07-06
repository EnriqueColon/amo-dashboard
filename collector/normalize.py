"""
AMO Normalization Pipeline
--------------------------
1. Canonical entity name mapping (typo correction + suffix stripping)
2. Per-CFN transaction deduplication → aom_events_clean
3. Entity relationship edge list → entity_relationships
4. Multi-signal entity type classification:
   manual overrides → FDIC match → suffix signals → behavioral → regex → default
"""
import sqlite3
import re
import os
import time
import requests
from collections import defaultdict

DB = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

# ── OCR sanity filter ─────────────────────────────────────────────────────────
# Rejects extracted text fields that look like OCR garbage before they reach
# aom_events_clean.  Returns the value if it passes, else None.

_STREET_SUFFIXES = re.compile(
    r'\b(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|HWY|PKY|PKWY|CIR|TER|TERR|'
    r'STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|HIGHWAY|CIRCLE|'
    r'TERRACE|NW|NE|SW|SE)\b',
    re.IGNORECASE,
)

_GARBAGE_RE = re.compile(
    r'[¢£€§©®™°±×÷]'          # currency / symbol garbage
    r'|[^\x00-\x7F]'           # non-ASCII characters (OCR artifacts)
    r'|\b[a-z]{1,2}[A-Z]{2,}'  # mixed-case OCR noise like "sy NarkeuS"
)


def looks_like_address(text: str) -> bool:
    """Return True if the string looks like a street address rather than an entity name."""
    if not text:
        return False
    # Has leading digits (street number) AND a street suffix word
    has_number = bool(re.match(r'^\d+\s', text.strip()))
    has_suffix = bool(_STREET_SUFFIXES.search(text))
    return has_number and has_suffix


def sanitize_ocr_field(value, max_garbage_ratio: float = 0.08) -> str | None:
    """Return value if it looks clean, else None.

    Checks:
    - Not None / empty
    - Not unreasonably short or long
    - Garbage character ratio below threshold
    - Doesn't look like a street address (for name fields)
    """
    if not value or not isinstance(value, str):
        return None
    v = value.strip()
    if not v or len(v) < 3:
        return None
    # Count garbage characters
    garbage_chars = len(_GARBAGE_RE.findall(v))
    if len(v) > 0 and garbage_chars / len(v) > max_garbage_ratio:
        return None
    return v


def sanitize_name_field(value) -> str | None:
    """Like sanitize_ocr_field but also rejects address-like strings."""
    v = sanitize_ocr_field(value)
    if v and looks_like_address(v):
        return None
    return v


def sanitize_address_field(value) -> str | None:
    """For address fields — allow street-like strings but still reject garbage."""
    return sanitize_ocr_field(value)


# ── Suffix / noise removal ────────────────────────────────────────────────────
# These are stripped from the END of entity names before canonicalization
STRIP_SUFFIXES = [
    # Multi-word legal / descriptive phrases (strip whole phrase first)
    r'\bA NEW YORK STATE CHARTERED BANK\b',
    r'\bA NATIONAL BANKING ASSOCIATION\b',
    r'\bA DELAWARE LIMITED LIABILITY COMPANY\b',
    r'\bA DELAWARE CORPORATION\b',
    r'\bA NEW YORK CORPORATION\b',
    r'\bA MARYLAND CORPORATION\b',
    r'\bA CALIFORNIA CORPORATION\b',
    r'\bA FLORIDA CORPORATION\b',
    r'\bNATIONAL BANKING ASSOCIATION\b',
    r'\bNATIONAL BANKING ASSOC\b',
    r'\bNATIONAL ASSOCIATION\b',
    r'\bFEDERAL SAVINGS BANK\b',
    r'\bFEDERAL SAVINGS\b',
    r'\bFEDERAL BANK\b',
    r'\bSAVINGS BANK\b',
    r'\bSTATE BANK\b',
    r'\bAS INDENTURE TRUSTEE\b',
    r'\bAS COLLATERAL AGENT\b',
    r'\bAS ADMINISTRATIVE AGENT\b',
    r'\bAS TRUSTEE\b',
    r'\bAS AGENT\b',
    r'\bIN ITS CAPACITY AS\b',
    r'\bIN ITS INDIVIDUAL CAPACITY\b',
    r'\bADMINISTRATOR\b',
    # Pure legal entity suffixes — safe to strip, carry no brand meaning
    r'\bCORPORATION\b',
    r'\bCORP\.?\b',
    r'\bINCORPORATED\b',
    r'\bINC\.?\b',
    r'\bLIMITED LIABILITY COMPANY\b',
    r'\bLLLP\b',
    r'\bLLLC\b',
    r'\bLLC\b',
    r'\bL\.L\.C\.?\b',
    r'\bL\.P\.?\b',
    r'\bLTD\.?\b',
    r'\bCO\.?\b',
    r'\bPLC\b',
    r'\bLP\b',
    r'\bFSB\b',
    r'\bN\.?A\.?\b',
    r'\bII\b',
    r'\bIII\b',
    # NOTE: FINANCIAL, MORTGAGE, BANK, CAPITAL, TRUST, FUND, GROUP, HOLDINGS
    # are intentionally NOT stripped here because they are often core brand
    # identifiers (e.g. "EASTERN FINANCIAL", "FIGURE LENDING", "ALTO CAPITAL").
    # Entities where these words are truly noise are handled via MANUAL_OVERRIDES.
]

# Manual canonical overrides — maps normalized → canonical brand name
# Format: pattern (regex) → canonical
MANUAL_OVERRIDES = [
    # MERS
    (r'MORTGAGE ELECTRONIC REGISTRATION', 'MERS'),
    # Wells Fargo
    (r'WELLS\s+FARGO', 'WELLS FARGO'),
    # JP Morgan / Chase
    (r'JP\s*MORGAN|JPMORGAN|CHASE BANK', 'JPMORGAN CHASE'),
    # Bank of America
    (r'BANK OF AMERICA', 'BANK OF AMERICA'),
    # Oaktree
    (r'OAKTREE\s+FUNDING|OAKTREE\s+CAPITAL', 'OAKTREE'),
    # NewRez
    (r'NEWREZ|NEW\s*REZ|SHELLPOINT', 'NEWREZ / SHELLPOINT'),
    # Nationstar / Mr. Cooper (all variants unified)
    (r'NATIONSTAR|MR\.?\s*COOPER', 'NATIONSTAR / MR. COOPER'),
    # Lakeview
    (r'LAKEVIEW\s+LOAN', 'LAKEVIEW LOAN SERVICING'),
    # US Bank
    (r'U\.?\s*S\.?\s*BANK\s+TRUST|U\.?\s*S\.?\s*BANK\s+NA|U\.?\s*S\.?\s*BANK\s+NATIONAL', 'US BANK'),
    # Wilmington Savings
    (r'WILMINGTON\s+SAVINGS', 'WILMINGTON SAVINGS'),
    # Goldman Sachs
    (r'GOLDMAN\s+SACHS', 'GOLDMAN SACHS'),
    # Deutsche Bank
    (r'DEUTSCHE\s+BANK', 'DEUTSCHE BANK'),
    # TPG
    (r'TPG\s+RE|TPG\s+FINANCE', 'TPG RE FINANCE'),
    # Carlyle
    (r'CARLYLE\s+CREDIT', 'CARLYLE CREDIT'),
    # Atlas SP
    (r'ATLAS\s+SP', 'ATLAS SP'),
    # Computershare
    (r'COMPUTERSHARE', 'COMPUTERSHARE TRUST'),
    # Citibank / Citigroup
    (r'CITI\s*BANK|CITI\s*GROUP|CITI\s*MORTGAGE', 'CITIBANK'),
    # PHH Mortgage
    (r'PHH\s+MORT', 'PHH MORTGAGE'),
    # Rocket / Quicken
    (r'ROCKET\s+MORT|QUICKEN\s+LOAN', 'ROCKET MORTGAGE'),
    # Freedom Mortgage (all variants)
    (r'FREEDOM\s+MORT|FREEDOM\s+MTG', 'FREEDOM MORTGAGE'),
    # PennyMac
    (r'PENNYMAC|PENNY\s*MAC', 'PENNYMAC'),
    # Mr. Cooper (standalone)
    (r'\bMR\.?\s+COOPER\b', 'NATIONSTAR / MR. COOPER'),
    # SPS / Select Portfolio
    (r'SELECT\s+PORTFOLIO|SPS\b', 'SELECT PORTFOLIO SERVICING'),
    # Ocwen
    (r'OCWEN', 'OCWEN / PHH'),
    # Carrington
    (r'CARRINGTON\s+MORT', 'CARRINGTON MORTGAGE'),
    # FNMA / Fannie Mae
    (r'FEDERAL\s+NATIONAL\s+MORT|FANNIE\s+MAE|\bFNMA\b', 'FANNIE MAE'),
    # FHLMC / Freddie Mac
    (r'FEDERAL\s+HOME\s+LOAN\s+MORT|FREDDIE\s+MAC|\bFHLMC\b', 'FREDDIE MAC'),
    # Ginnie Mae
    (r'GINNIE\s+MAE|\bGNMA\b', 'GINNIE MAE'),
    # HUD / Secretary of Housing — all variants → single canonical
    (r'SECRETARY\s+OF\s+HOUSING|HOUSING\s+AND\s+URBAN\s+DEV|HOUSING\s*&\s*URBAN\s+DEV|\bHUD\b', 'SECRETARY OF HOUSING AND URBAN DEVELOPMENT'),
    # Mortgage Assets Management (special servicer)
    (r'MORTGAGE\s+ASSETS\s+MANAGEMENT', 'MORTGAGE ASSETS MANAGEMENT'),
    # Kiavi Funding (bridge/private lender)
    (r'KIAVI\s+FUND', 'KIAVI FUNDING'),
    # Figure Lending
    (r'FIGURE\s+LEND', 'FIGURE LENDING'),
    # Velocity Commercial Capital
    (r'VELOCITY\s+COMMERCIAL', 'VELOCITY COMMERCIAL CAPITAL'),
    # Churchill Funding
    (r'CHURCHILL\s+FUND', 'CHURCHILL FUNDING I'),
    # City First
    (r'CITY\s+FIRST', 'CITY FIRST'),
    # ELS Holdings
    (r'ELS\s+HOLD', 'ELS HOLDINGS'),
    # Alto Capital (incl. common typos: CAPITL/CAPITOL/CAPOITAL/CAPTIAL);
    # keep pattern tight so RIVO ALTO PARTNERS, D ALTO (person), etc. don't fold in
    (r'\bALTO\s+(CAP\w*|OPPORTUN\w*)', 'ALTO CAPITAL'),
    # CitiMortgage
    (r'CITI\s*MORTGAGE|CITOMORTGAGE', 'CITIMORTGAGE'),
    # Paramount Residential Mortgage
    (r'PARAMOUNT\s+RESIDENTIAL', 'PARAMOUNT RESIDENTIAL MORTGAGE'),
    # Taylor Made Lending
    (r'TAYLOR\s+MADE\s+LENDING', 'TAYLOR MADE LENDING'),
    # Worthy Lending
    (r'WORTHY\s+LENDING', 'WORTHY LENDING'),
    # Eastern Financial (South Florida credit union mortgage arm)
    (r'EASTERN\s+FINANCIAL', 'EASTERN FINANCIAL MORTGAGE'),
    # Bradesco (Brazilian bank with US/FL operations)
    (r'BRADESCO', 'BRADESCO BANK'),
    # Space Coast Credit Union (successor to Eastern Financial Federal CU)
    (r'SPACE\s+COAST\s+CREDIT', 'SPACE COAST CREDIT UNION'),
    # AmeriHome / Western Alliance mortgage arm (all spelling variants)
    (r'AMERIHOME\s+M(ORT|TG)', 'AMERIHOME MORTGAGE'),
    # New Residential Mortgage (servicing subsidiary of Rithm Capital — keep separate from parent REIT)
    (r'NEW\s+RESIDENTIAL\s+MORTGAGE', 'NEW RESIDENTIAL MORTGAGE'),
    # MidFirst Bank (large private bank)
    (r'MIDFIRST', 'MIDFIRST BANK'),
    # American Bancshares Mortgage (correspondent/originator)
    (r'AMERICA[N]?\s+BANC\s*SHARES\s+MORTGAGE', 'AMERICAN BANCSHARES MORTGAGE'),
    # Saluda Grade Mortgage Funding (securitization trust / non-QM funding vehicle)
    (r'SALUDA\s+GRADE', 'SALUDA GRADE MORTGAGE FUNDING'),
    # Pacific Life Insurance (large institutional insurer)
    (r'PACIFIC\s+LIFE\s+INS', 'PACIFIC LIFE INSURANCE'),
    # MTGLQ Investors (Goldman Sachs NPL acquisition vehicle)
    (r'MTGLQ', 'MTGLQ INVESTORS'),
    # Arixa Capital / Arixa Institutional Lending (private bridge lender — consolidate all sub-entities)
    (r'ARIXA', 'ARIXA CAPITAL'),
    # Athene Annuity (Apollo-backed institutional insurer / credit investor)
    (r'ATHENE\s+ANNUITY|ATHENE\s+HOLDING', 'ATHENE ANNUITY'),
    # Truist (BB&T + SunTrust merger)
    (r'TRUIST', 'TRUIST BANK'),
    # Pacific Union Financial
    (r'PACIFIC\s+UNION\s+FINANCIAL', 'PACIFIC UNION FINANCIAL'),
    # Ameritas Life Partners
    (r'AMERITAS', 'AMERITAS LIFE'),
    # Towd Point (Angelo Gordon CLO trust)
    (r'TOWD\s+POINT', 'TOWD POINT'),
    # New Penn / Shellpoint
    (r'NEW\s+PENN\s+FINANCIAL|NEW\s+PENN\s+MORT', 'NEWREZ / SHELLPOINT'),
    # Waterfall Asset Management
    (r'WATERFALL\s+ASSET', 'WATERFALL ASSET MANAGEMENT'),
    # MEB Loan Trust (distressed debt vehicle)
    (r'\bMEB\s+LOAN\s+TRUST', 'MEB LOAN TRUST'),
    # RRA Capital
    (r'\bRRA\s+CP\b|\bRRA\s+CAPITAL', 'RRA CAPITAL'),
    # 1 Sharpe Opportunity
    (r'1\s+SHARPE\s+OPPORTUNITY|ONE\s+SHARPE\s+OPPORTUNITY', '1 SHARPE OPPORTUNITY TRUST'),
    # Banesco (FL state-chartered bank — OCR/word-order variants: BANESCO USA,
    # USA BANESCO, BANESCOUSA, BANK BANESCO, etc.)
    (r'BANESCO', 'BANESCO USA'),
    # First Federal Bank — suffix stripping would otherwise reduce these to 'FIRST'
    (r'FIRST\s+FEDERAL\s+BANK\s+OF\s+KANSAS\s+CITY', 'FIRST FEDERAL BANK OF KANSAS CITY'),
    (r'FIRST\s+FEDERAL\s+BANK', 'FIRST FEDERAL BANK'),
]

# Compiled patterns
_SUFFIX_RES = [re.compile(p, re.IGNORECASE) for p in STRIP_SUFFIXES]
_OVERRIDE_RES = [(re.compile(p, re.IGNORECASE), canon) for p, canon in MANUAL_OVERRIDES]

# ── Entity type classification (applied to canonical names) ───────────────────
# Order matters — first match wins, so higher-priority types go first.
ENTITY_TYPE_PATTERNS = [
    # GSE
    ('GSE',            r'FANNIE MAE|FREDDIE MAC|GINNIE MAE'),
    # MERS gets its own color in the UI
    ('MERS',           r'^MERS$|MORTGAGE ELECTRONIC'),
    # Banks (commercial, investment, savings, credit unions, institutional insurers acting as lenders)
    ('BANK',           r'WELLS FARGO|JPMORGAN CHASE|BANK OF AMERICA|US BANK|CITIBANK|'
                       r'DEUTSCHE BANK|GOLDMAN SACHS|WILMINGTON SAVINGS|BARCLAYS|'
                       r'MORGAN STANLEY|HSBC|REGIONS|TRUIST BANK|PNC|TD BANK|BB&T|SUNTRUST|'
                       r'CITIZENS BANK|KEYBANK|FIFTH THIRD|CREDIT SUISSE|UBS|'
                       r'FIRST REPUBLIC|SIGNATURE BANK|SILICON VALLEY|'
                       r'COMMERCE BANK|SOUTH STATE|SEACOAST|BANKUNITED|'
                       r'SYNOVUS|AMERIS|PINNACLE|CADENCE|STERLING BANK|'
                       r'INDEPENDENT BANK|CENTERSTATE|WESTERN ALLIANCE|'
                       r'FLAGSTAR|HEARTLAND|GLACIER|COLUMBIA BANKING|BANNER BANK|'
                       r'PACIFIC PREMIER|VALLEY NATIONAL|ENTERPRISE BANK|PROVIDENT|'
                       r'BRADESCO BANK|EASTERN FINANCIAL MORTGAGE|SPACE COAST CREDIT UNION|'
                       r'DLJ MORTGAGE CAPITAL|PACIFIC UNION FINANCIAL|AMERITAS LIFE|'
                       r'MIDFIRST BANK|PACIFIC LIFE INSURANCE'),
    # Securitization trusts / structured finance vehicles
    # These are passive pools of loans — NOT active investment managers.
    ('TRUST',          r'MEB LOAN TRUST|TOWD POINT|CV3 ALPHA TRUST|'
                       r'US MORTGAGE RESOLUTION TRUST|US MTG RESOLUTION|'
                       r'1 SHARPE OPPORTUNITY TRUST|CHURCHILL FUNDING|'
                       r'NWL 2016 EVERGREEN|NWL COMPANY|'
                       r'FIRSTKEY MORTGAGE|FIRSTKEY HOMES|'
                       r'SALUDA GRADE MORTGAGE FUNDING'),
    # Private credit / active asset managers / PE funds
    # NOTE: NEW RESIDENTIAL MORTGAGE (servicing arm) is in SERVICER below.
    # Only RITHM CAPITAL (the parent REIT) stays here.
    ('PRIVATE_CREDIT', r'OAKTREE|TPG RE|CARLYLE|ATLAS SP|BLACKSTONE|APOLLO|KKR|ARES|'
                       r'PIMCO|CERBERUS|LONE STAR|FORTRESS|ANGELO GORDON|'
                       r'BENEFIT STREET|BAIN CAPITAL|CENTERBRIDGE|BROOKFIELD|'
                       r'STARWOOD|READY CAPITAL|MESA WEST|ACRES CAPITAL|TORCHLIGHT|'
                       r'LADDER CAPITAL|ARBOR REALTY|HUNT REAL ESTATE|'
                       r'BRIDGE INVESTMENT|THETIS ASSET|SCULPTOR|MARATHON ASSET|'
                       r'RITHM CAPITAL|ELLINGTON|'
                       r'TWO HARBORS|ANNALY|CHIMERA|AG MORTGAGE|CLAROS|'
                       r'RRA CAPITAL|WATERFALL ASSET|FIXED INCOME USA|'
                       r'MTGLQ INVESTORS|ARIXA CAPITAL|ATHENE ANNUITY'),
    # Mortgage servicers and correspondent mortgage originators / banks
    ('SERVICER',       r'NEWREZ|SHELLPOINT|NATIONSTAR|MR\.? COOPER|LAKEVIEW LOAN|'
                       r'PHH MORTGAGE|FREEDOM MORTGAGE|PENNYMAC|SELECT PORTFOLIO|'
                       r'OCWEN|CARRINGTON MORTGAGE|ROUNDPOINT|PLANET HOME|RUSHMORE|'
                       r'CENLAR|BSI FINANCIAL|SETERUS|GREEN TREE|DOVENMUEHLE|'
                       r'BAYVIEW|SPECIALIZED LOAN|SERVIS ONE|DITECH|'
                       r'WALTER INVESTMENT|SENECA MORTGAGE|'
                       r'COMPUTERSHARE|SOLUTIONSTAR|ALTISOURCE|'
                       r'LOANDEPOT|CALIBER HOME|HOME POINT CAPITAL|'
                       r'ROCKET MORTGAGE|UNITED WHOLESALE|UWM\b|'
                       r'LOANCORE|CROSSCOUNTRY|CROSS COUNTRY MORTGAGE|'
                       r'AMERIHOME MORTGAGE|NEW RESIDENTIAL MORTGAGE|'
                       r'AMERICAN BANCSHARES MORTGAGE'),
]
_TYPE_COMPILED = [(t, re.compile(p, re.IGNORECASE)) for t, p in ENTITY_TYPE_PATTERNS]


def classify_canonical(name: str) -> str:
    """Classify a canonical entity name into a known type, or 'OTHER'."""
    for etype, pat in _TYPE_COMPILED:
        if pat.search(name):
            return etype
    return 'OTHER'

_INST_TYPES = {'BANK', 'SERVICER', 'PRIVATE_CREDIT', 'GSE', 'TRUST'}

# ── Suffix signal extraction ─────────────────────────────────────────────────
# Captures classification-relevant information from raw filing names BEFORE
# legal suffixes are stripped during canonicalization.

_BANKING_SUFFIX_RE = re.compile(
    r'NATIONAL BANKING ASSOCIATION|NATIONAL BANKING ASSOC|'
    r'NATIONAL ASSOCIATION|FEDERAL SAVINGS BANK|FEDERAL SAVINGS|'
    r'FEDERAL BANK|SAVINGS BANK|STATE BANK|CREDIT UNION|'
    r'STATE CHARTERED BANK|BANKING ASSOCIATION',
    re.IGNORECASE
)
_TRUSTEE_ROLE_RE = re.compile(
    r'AS TRUSTEE|AS INDENTURE TRUSTEE|AS COLLATERAL AGENT|'
    r'AS ADMINISTRATIVE AGENT|AS AGENT',
    re.IGNORECASE
)
_TRUST_NAME_RE = re.compile(
    r'LOAN TRUST|MORTGAGE TRUST|ASSET TRUST|RESOLUTION TRUST|'
    r'OPPORTUNITY TRUST|PASS.THROUGH CERT',
    re.IGNORECASE
)
_GSE_SUFFIX_RE = re.compile(
    r'SECRETARY OF HOUSING|HOUSING AND URBAN DEV|'
    r'FEDERAL HOUSING ADMIN|VETERANS AFFAIRS|\bHUD\b|\bFHA\b|\bFDIC\b',
    re.IGNORECASE
)


def extract_suffix_signals(raw_name: str) -> dict:
    """Extract classification signals from a raw filing name before suffix stripping."""
    upper = (raw_name or '').upper()
    return {
        'has_banking_suffix': bool(_BANKING_SUFFIX_RE.search(upper)),
        'has_trustee_role':   bool(_TRUSTEE_ROLE_RE.search(upper)),
        'has_trust_name':     bool(_TRUST_NAME_RE.search(upper)),
        'has_gse_suffix':     bool(_GSE_SUFFIX_RE.search(upper)),
    }


# ── FDIC institution cross-reference ─────────────────────────────────────────

FDIC_API_URL = 'https://banks.data.fdic.gov/api/institutions'
FDIC_CACHE_MAX_AGE_DAYS = 30


def build_fdic_lookup(conn) -> set:
    """Fetch FDIC-insured institution names and canonicalize them for matching.
    Caches in a SQLite table; re-fetches if stale or empty."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fdic_institution_cache (
            canonical_name TEXT PRIMARY KEY,
            raw_name       TEXT,
            cert           TEXT,
            fetched_at     TEXT
        )
    """)

    row = conn.execute(
        "SELECT fetched_at FROM fdic_institution_cache LIMIT 1"
    ).fetchone()
    if row:
        try:
            age_days = (time.time() - time.mktime(time.strptime(row[0], '%Y-%m-%d'))) / 86400
            if age_days < FDIC_CACHE_MAX_AGE_DAYS:
                cached = conn.execute("SELECT canonical_name FROM fdic_institution_cache").fetchall()
                print(f"  FDIC cache hit: {len(cached)} institutions (age {age_days:.0f}d)")
                return {r[0] for r in cached}
        except (ValueError, TypeError):
            pass

    try:
        print("  Fetching FDIC institution list...")
        resp = requests.get(
            FDIC_API_URL,
            params={
                'filters': 'ACTIVE:1',
                'fields': 'CERT,NAME',
                'limit': '10000',
                'format': 'json',
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json().get('data', [])

        today = time.strftime('%Y-%m-%d')
        rows = []
        canonical_set = set()
        for item in data:
            d = item.get('data', item)
            raw = (d.get('NAME') or '').strip()
            cert = str(d.get('CERT', ''))
            if raw:
                canon = canonicalize(raw)
                canonical_set.add(canon)
                rows.append((canon, raw, cert, today))

        conn.execute("DELETE FROM fdic_institution_cache")
        conn.executemany(
            "INSERT OR IGNORE INTO fdic_institution_cache (canonical_name, raw_name, cert, fetched_at) VALUES (?,?,?,?)",
            rows
        )
        conn.commit()
        print(f"  Cached {len(canonical_set)} FDIC institutions")
        return canonical_set

    except Exception as e:
        print(f"  [WARN] FDIC fetch failed: {e} — continuing without FDIC data")
        cached = conn.execute("SELECT canonical_name FROM fdic_institution_cache").fetchall()
        if cached:
            print(f"  Using stale FDIC cache ({len(cached)} institutions)")
            return {r[0] for r in cached}
        return set()


def fdic_classify(canonical_name: str, fdic_set: set) -> str | None:
    """Return 'BANK' if the canonical name matches an FDIC-insured institution."""
    if canonical_name in fdic_set:
        return 'BANK'
    return None


# ── Behavioral classification ─────────────────────────────────────────────────

def behavioral_classify(entity: str, conn) -> str | None:
    """Classify based on transaction patterns in aom_events_clean."""
    stats = conn.execute("""
        SELECT
            COALESCE(SUM(CASE WHEN assignee_canon = ? THEN 1 END), 0),
            COALESCE(SUM(CASE WHEN assignor_canon = ? THEN 1 END), 0),
            COUNT(DISTINCT CASE WHEN assignee_canon = ? THEN assignor_canon END),
            COUNT(DISTINCT CASE WHEN assignor_canon = ? THEN assignee_canon END),
            COALESCE(SUM(CASE WHEN assignee_canon = ? AND assignor_type = 'MERS' THEN 1 END), 0),
            COALESCE(SUM(CASE WHEN assignee_canon = ? AND assignor_canon = assignee_canon THEN 1 END), 0)
        FROM aom_events_clean
    """, (entity, entity, entity, entity, entity, entity)).fetchone()

    inbound, outbound, in_cp, out_cp, from_mers, self_assigns = stats
    total = inbound + outbound

    if total < 3:
        return None

    # SERVICER: frequently receives from MERS (nominee releases)
    if from_mers >= 3 and from_mers / max(inbound, 1) > 0.15:
        return 'SERVICER'

    # TRUST: almost exclusively receives, rarely or never assigns out,
    # limited number of counterparties feeding it
    non_self_out = outbound - self_assigns
    if inbound >= 3 and non_self_out <= 1 and in_cp <= 5:
        return 'TRUST'

    # BANK: high volume, balanced in/out flow, many unique counterparties
    if total >= 10 and in_cp >= 5 and out_cp >= 3 and outbound >= 2:
        return 'BANK'

    return None


# ── Confidence waterfall resolver ─────────────────────────────────────────────

CONFIDENCE_ORDER = [
    'manual_override',
    'fdic_match',
    'suffix_gse',
    'suffix_banking',
    'suffix_trust_name',
    'behavioral',
    'regex_rule',
    'default',
]


def resolve_entity_type(entity: str, suffix_signals: dict,
                        fdic_set: set, conn) -> tuple:
    """Classify an entity using all available signals.
    Returns (entity_type, confidence_source)."""

    # 1. Manual overrides from enrich_entities (imported inline to avoid circular dep)
    for key, val in _MANUAL_TYPE_OVERRIDES.items():
        if key in entity.upper():
            return val, 'manual_override'

    # 2. GSE suffix (raw name had HUD/FHA/FDIC etc.)
    if suffix_signals.get('has_gse_suffix'):
        return 'GSE', 'suffix_gse'

    # 3. FDIC institution match
    t = fdic_classify(entity, fdic_set)
    if t:
        return t, 'fdic_match'

    # 4. Banking suffix ("National Association", "Federal Savings Bank", etc.)
    #    Only if the entity doesn't have a trust name (banks act as trustees)
    if suffix_signals.get('has_banking_suffix') and not suffix_signals.get('has_trust_name'):
        return 'BANK', 'suffix_banking'

    # 5. Trust vehicle name pattern ("XYZ Loan Trust", etc.)
    if suffix_signals.get('has_trust_name'):
        return 'TRUST', 'suffix_trust_name'

    # 6. Behavioral analysis from transaction patterns
    t = behavioral_classify(entity, conn)
    if t:
        return t, 'behavioral'

    # 7. Existing regex rule patterns
    t = classify_canonical(entity)
    if t != 'OTHER':
        return t, 'regex_rule'

    return 'OTHER', 'default'


# Consolidated manual type overrides — single source of truth used by both
# normalize.py and enrich_entities.py. Keyed by substring match on UPPER name.
_MANUAL_TYPE_OVERRIDES: dict[str, str] = {
    # Securitization trusts / structured finance vehicles
    'MEB LOAN TRUST':               'TRUST',
    'TOWD POINT':                   'TRUST',
    'CV3 ALPHA TRUST':              'TRUST',
    'US MORTGAGE RESOLUTION TRUST': 'TRUST',
    'US RESOLUTION':                'TRUST',
    'US MTG RESOLUTION':            'TRUST',
    '1 SHARPE OPPORTUNITY TRUST':   'TRUST',
    'CHURCHILL FUNDING I':          'TRUST',
    'NWL 2016 EVERGREEN':           'TRUST',
    'NWL COMPANY':                  'TRUST',
    'FIRSTKEY MORTGAGE':            'TRUST',
    'FIRSTKEY HOMES':               'TRUST',
    'SALUDA GRADE MORTGAGE FUNDING': 'TRUST',
    # Private credit / active asset managers
    'KIAVI FUNDING':                'PRIVATE_CREDIT',
    'ANCHOR LOANS':                 'PRIVATE_CREDIT',
    'FIGURE LENDING':               'PRIVATE_CREDIT',
    'VELOCITY COMMERCIAL':          'PRIVATE_CREDIT',
    'REVERSE MORTGAGE FUNDING':     'PRIVATE_CREDIT',
    'ELS HOLDINGS':                 'PRIVATE_CREDIT',
    'ALTO CAPITAL':                 'PRIVATE_CREDIT',
    'CITY FIRST':                   'PRIVATE_CREDIT',
    'PACIFIC ASSET HOLDING':        'PRIVATE_CREDIT',
    'LADDER CRE FINANCE REIT':      'PRIVATE_CREDIT',
    'BANKWARD':                     'PRIVATE_CREDIT',
    'RRA CAPITAL':                  'PRIVATE_CREDIT',
    'WATERFALL ASSET MANAGEMENT':   'PRIVATE_CREDIT',
    'FIXED INCOME USA':             'PRIVATE_CREDIT',
    'MTGLQ INVESTORS':              'PRIVATE_CREDIT',
    'ARIXA CAPITAL':                'PRIVATE_CREDIT',
    'ATHENE ANNUITY':               'PRIVATE_CREDIT',
    # Servicers
    'FINANCE OF AMERICA REVERSE':   'SERVICER',
    'PARAMOUNT RESIDENTIAL':        'SERVICER',
    'CITIMORTGAGE':                 'SERVICER',
    'COMPUTERSHARE TRUST':          'SERVICER',
    'AMERIHOME MORTGAGE':           'SERVICER',
    'PACIFIC UNION FINANCIAL':      'SERVICER',
    'NEW RESIDENTIAL MORTGAGE':     'SERVICER',
    'AMERICAN BANCSHARES MORTGAGE': 'SERVICER',
    # Banks
    'EASTERN FINANCIAL':            'BANK',
    'BRADESCO':                     'BANK',
    'SPACE COAST CREDIT UNION':     'BANK',
    'DLJ MORTGAGE CAPITAL':         'BANK',
    'TRUIST BANK':                  'BANK',
    'MIDFIRST BANK':                'BANK',
    'PACIFIC LIFE INSURANCE':       'BANK',
}


def get_txn_type(assignor_canon: str, assignee_canon: str,
                 assignor_type: str, assignee_type: str) -> str:
    if assignor_canon == assignee_canon:
        return 'SELF_ASSIGN'
    if assignor_type == 'MERS':
        return 'MERS_RELEASE'
    a_inst = assignor_type in _INST_TYPES
    b_inst = assignee_type in _INST_TYPES
    if a_inst and b_inst:
        return 'MARKET_TRANSFER'
    if not a_inst and b_inst:
        return 'ORIGINATION'
    if a_inst and not b_inst:
        return 'INSTITUTIONAL_OUT'
    return 'PRIVATE'


# ── User-managed entity aliases (entity_aliases table) ─────────────────────
# Merges made from the dashboard's Entities page are recorded as
# variant → canonical rows. canonicalize() applies them as its final step so
# user merges survive every rebuild. Populated by load_aliases().
_ALIAS_MAP: dict = {}


def load_aliases(conn) -> int:
    """Load the user-managed alias crosswalk from the DB into _ALIAS_MAP."""
    global _ALIAS_MAP
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entity_aliases (
            variant TEXT PRIMARY KEY,
            canonical TEXT NOT NULL,
            created_at TEXT,
            created_by TEXT,
            note TEXT
        )
    """)
    raw = dict(conn.execute("SELECT variant, canonical FROM entity_aliases"))
    # Resolve chains (A→B, B→C  ⇒  A→C), guarding against cycles
    resolved = {}
    for variant, canon in raw.items():
        seen = {variant}
        while canon in raw and canon not in seen:
            seen.add(canon)
            canon = raw[canon]
        resolved[variant] = canon
    _ALIAS_MAP = resolved
    return len(_ALIAS_MAP)


def canonicalize(name: str) -> str:
    """Return a canonical brand name for a raw entity string."""
    if not name or not name.strip():
        return 'UNKNOWN'
    
    s = name.strip().upper()
    
    # Remove leading garbage characters / numbers
    s = re.sub(r'^[^A-Z]+', '', s)
    
    # Check manual overrides first (before stripping suffixes)
    for pat, canon in _OVERRIDE_RES:
        if pat.search(s):
            return _ALIAS_MAP.get(canon, canon)
    
    # Strip suffixes iteratively
    prev = None
    while prev != s:
        prev = s
        for rex in _SUFFIX_RES:
            s = rex.sub('', s).strip()
        # Remove trailing punctuation/commas/spaces
        s = re.sub(r'[\s,;\.]+$', '', s)
    
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    
    # If nothing left, use original
    if not s:
        s = name.strip().upper()
    
    if not s:
        return 'UNKNOWN'
    # Final step: apply user-managed merges from the Entities page
    return _ALIAS_MAP.get(s, s)


def build_normalized_tables():
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')

    # ── Step 0a: Load user-managed merges so canonicalize() honors them ─────
    n_aliases = load_aliases(conn)
    if n_aliases:
        print(f"Loaded {n_aliases} user-managed entity aliases")

    # ── Step 0: Collect suffix signals from ALL raw filing names ───────────
    print("Extracting suffix signals from raw filings...")
    entity_signals: dict = defaultdict(lambda: {
        'has_banking_suffix': False,
        'has_trustee_role': False,
        'has_trust_name': False,
        'has_gse_suffix': False,
    })

    all_raw = conn.execute(
        "SELECT DISTINCT grantor FROM assignments WHERE grantor IS NOT NULL "
        "UNION "
        "SELECT DISTINCT grantee FROM assignments WHERE grantee IS NOT NULL"
    ).fetchall()

    for (raw_name,) in all_raw:
        canon = canonicalize(raw_name)
        signals = extract_suffix_signals(raw_name)
        for key, val in signals.items():
            if val:
                entity_signals[canon][key] = True

    n_with_signals = sum(1 for s in entity_signals.values() if any(s.values()))
    print(f"  Scanned {len(all_raw)} raw names → {n_with_signals} entities with suffix signals")

    # ── Step 1: Build aom_events_clean ─────────────────────────────────────
    print("Building aom_events_clean...")

    # Preserve manual review marks (set via the Reporting UI) across the rebuild
    review_rows = []
    try:
        review_rows = conn.execute("""
            SELECT cfn, classification, reviewed_by, reviewed_at FROM aom_events_clean
            WHERE reviewed_at IS NOT NULL OR classification IS NOT NULL
        """).fetchall()
        if review_rows:
            print(f"  Preserving {len(review_rows)} manual review marks")
    except sqlite3.OperationalError:
        pass  # first run, or review columns not present yet

    conn.executescript("""
        DROP TABLE IF EXISTS aom_events_clean;
        CREATE TABLE aom_events_clean (
            cfn                  TEXT PRIMARY KEY,
            rec_date             TEXT,
            assignor             TEXT,
            assignee             TEXT,
            assignor_canon       TEXT,
            assignee_canon       TEXT,
            assignor_type        TEXT,
            assignee_type        TEXT,
            txn_type             TEXT,
            rec_book             TEXT,
            rec_page             TEXT,
            total_parties        INTEGER,
            doc_type             TEXT,
            doc_category         TEXT,
            doc_title            TEXT,
            pdf_assignor         TEXT,
            pdf_assignee         TEXT,
            assignor_parent      TEXT,
            assignee_parent      TEXT,
            property_address     TEXT,
            loan_amount          REAL,
            consideration_amount REAL,
            folio_parcel         TEXT,
            sponsor_address      TEXT,
            signatory_officer    TEXT,
            classification       TEXT,
            reviewed_by          TEXT,
            reviewed_at          TEXT
        );
    """)

    # PDF extraction cache (built by extract_pdfs.py; may be empty)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pdf_extractions (
            cfn                  TEXT PRIMARY KEY,
            rec_book             TEXT,
            rec_page             TEXT,
            status               TEXT,
            doc_category         TEXT,
            doc_title            TEXT,
            assignor_name        TEXT,
            assignor_parent      TEXT,
            assignee_name        TEXT,
            assignee_parent      TEXT,
            property_address     TEXT,
            loan_amount          REAL,
            consideration_amount REAL,
            ocr_chars            INTEGER,
            model                TEXT,
            extracted_at         TEXT,
            raw_json             TEXT
        )
    """)
    extractions = {
        r[0]: {
            'doc_category':        r[1],
            'assignor_name':       sanitize_name_field(r[2]),
            'assignor_parent':     sanitize_name_field(r[3]),
            'assignee_name':       sanitize_name_field(r[4]),
            'assignee_parent':     sanitize_name_field(r[5]),
            'property_address':    sanitize_address_field(r[6]),
            'loan_amount':         r[7],
            'consideration_amount':r[8],
            'doc_title':           sanitize_ocr_field(r[9]),
            'folio_parcel':        sanitize_ocr_field(r[10]),
            'sponsor_address':     sanitize_address_field(r[11]),
            'signatory_officer':   sanitize_name_field(r[12]),
        }
        for r in conn.execute("""
            SELECT cfn, doc_category, assignor_name, assignor_parent,
                   assignee_name, assignee_parent, property_address,
                   loan_amount, consideration_amount, doc_title,
                   folio_parcel, sponsor_address, signatory_officer
            FROM pdf_extractions WHERE status = 'OK'
        """).fetchall()
    }
    print(f"  PDF extractions available: {len(extractions)}")

    rows = conn.execute("""
        SELECT a.cfn,
               a.rec_date,
               a.grantor,
               a.grantee,
               a.rec_book,
               a.rec_page,
               COALESCE(ec_g.category, 'OTHER') as assignor_type,
               COALESCE(ec_a.category, 'OTHER') as assignee_type,
               COUNT(*) OVER (PARTITION BY a.cfn) as total_parties,
               ROW_NUMBER() OVER (
                   PARTITION BY a.cfn, a.grantee
                   ORDER BY a.rowid
               ) as rn,
               COUNT(*) OVER (PARTITION BY a.cfn, a.grantee) as grantee_count,
               a.doc_type,
               a.address
        FROM assignments a
        LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
        LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
    """).fetchall()

    print(f"  Loaded {len(rows)} raw rows")

    cfn_groups: dict = defaultdict(list)
    for row in rows:
        cfn_groups[row[0]].append(row)

    print(f"  Processing {len(cfn_groups)} unique CFNs...")

    AMO_DOC_TYPE = 'ASSIGNMENT OF MORTGAGE - AMO'
    inserts = []
    skipped_non_loan = 0
    for cfn, entries in cfn_groups.items():
        total_parties = entries[0][8]
        doc_type = entries[0][11] or AMO_DOC_TYPE
        index_address = (entries[0][12] or '').strip() or None

        # ── Loan-transfer filter ────────────────────────────────────────────
        # Dedicated AMO filings are loan transfers by definition; they stay
        # unless the PDF proves otherwise. Generic ASG / AIT filings are a
        # mixed bag (rents, leases, collateral, judgments...) and only enter
        # the clean table once the PDF is classified as a loan transfer.
        ext = extractions.get(cfn)
        doc_category = ext['doc_category'] if ext else None
        if doc_type == AMO_DOC_TYPE:
            include = doc_category in (None, 'LOAN_TRANSFER')
        else:
            include = doc_category == 'LOAN_TRANSFER'
        if not include:
            skipped_non_loan += 1
            continue

        grantee_counts: dict = defaultdict(list)
        for e in entries:
            grantee_counts[e[3]].append(e)

        dominant_grantee, dominant_rows = max(grantee_counts.items(), key=lambda x: len(x[1]))

        assignor_counts: dict = defaultdict(int)
        for e in dominant_rows:
            if (e[2] or '').strip().upper() != (dominant_grantee or '').strip().upper():
                assignor_counts[e[2]] += 1

        if assignor_counts:
            dominant_assignor = max(assignor_counts, key=assignor_counts.get)
            assignor_entry = next((e for e in dominant_rows if e[2] == dominant_assignor), dominant_rows[0])
            assignor_type = assignor_entry[6]
        else:
            assignor_entry = entries[0]
            dominant_assignor = assignor_entry[2] or 'UNKNOWN'
            assignor_type = assignor_entry[6] or 'OTHER'

        grantee_type = dominant_rows[0][7]
        rec_date = entries[0][1]
        rec_book = entries[0][4]
        rec_page = entries[0][5]

        # If the raw grantor looks like a street address, prefer the PDF-extracted name
        if looks_like_address(dominant_assignor) and ext and ext.get('assignor_name'):
            dominant_assignor = ext['assignor_name']
        if looks_like_address(dominant_grantee) and ext and ext.get('assignee_name'):
            dominant_grantee = ext['assignee_name']

        assignor_canon = canonicalize(dominant_assignor)
        assignee_canon = canonicalize(dominant_grantee)
        txn_type = get_txn_type(assignor_canon, assignee_canon, assignor_type, grantee_type)

        inserts.append((
            cfn, rec_date,
            dominant_assignor or 'UNKNOWN', dominant_grantee or 'UNKNOWN',
            assignor_canon, assignee_canon,
            assignor_type, grantee_type,
            txn_type,
            rec_book, rec_page,
            total_parties,
            doc_type,
            doc_category,
            ext['doc_title']             if ext else None,
            ext['assignor_name']         if ext else None,
            ext['assignee_name']         if ext else None,
            ext['assignor_parent']       if ext else None,
            ext['assignee_parent']       if ext else None,
            (ext['property_address'] if ext and ext['property_address'] else index_address),
            ext['loan_amount']           if ext else None,
            ext['consideration_amount']  if ext else None,
            ext['folio_parcel']          if ext else None,
            ext['sponsor_address']       if ext else None,
            ext['signatory_officer']     if ext else None,
        ))

    conn.executemany("""
        INSERT OR REPLACE INTO aom_events_clean
        (cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
         assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties,
         doc_type, doc_category, doc_title, pdf_assignor, pdf_assignee,
         assignor_parent, assignee_parent, property_address,
         loan_amount, consideration_amount,
         folio_parcel, sponsor_address, signatory_officer)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, inserts)

    # Restore preserved review marks
    if review_rows:
        conn.executemany("""
            UPDATE aom_events_clean
            SET classification = ?, reviewed_by = ?, reviewed_at = ?
            WHERE cfn = ?
        """, [(c, rb, ra, cfn) for cfn, c, rb, ra in review_rows])
    conn.commit()

    n = conn.execute("SELECT COUNT(*) FROM aom_events_clean").fetchone()[0]
    print(f"  aom_events_clean: {n} rows ({skipped_non_loan} non-loan-transfer filings excluded)")

    # ── Entity relationships ──────────────────────────────────────────────────
    print("Building entity_relationships...")

    conn.executescript("""
        DROP TABLE IF EXISTS entity_relationships;
        CREATE TABLE entity_relationships (
            source_entity      TEXT,
            target_entity      TEXT,
            transaction_count  INTEGER,
            first_seen_date    TEXT,
            last_seen_date     TEXT,
            PRIMARY KEY (source_entity, target_entity)
        );
    """)

    conn.execute("""
        INSERT OR REPLACE INTO entity_relationships
        SELECT
            assignor_canon as source_entity,
            assignee_canon as target_entity,
            COUNT(*) as transaction_count,
            MIN(rec_date) as first_seen_date,
            MAX(rec_date) as last_seen_date
        FROM aom_events_clean
        WHERE assignor_canon != assignee_canon
          AND assignor_canon != 'UNKNOWN'
          AND assignee_canon != 'UNKNOWN'
        GROUP BY assignor_canon, assignee_canon
        ORDER BY transaction_count DESC
    """)
    conn.commit()

    n_rel = conn.execute("SELECT COUNT(*) FROM entity_relationships").fetchone()[0]
    print(f"  entity_relationships: {n_rel} rows")

    # ── Entity node stats ─────────────────────────────────────────────────────
    print("Building entity_nodes...")
    conn.executescript("""
        DROP TABLE IF EXISTS entity_nodes;
        CREATE TABLE entity_nodes (
            entity         TEXT PRIMARY KEY,
            outbound_vol   INTEGER,  -- total txns as source
            inbound_vol    INTEGER,  -- total txns as target
            total_vol      INTEGER,
            degree         INTEGER,  -- unique counterparties
            entity_type    TEXT,
            first_seen     TEXT,
            last_seen      TEXT
        );
    """)
    # Build entity_nodes from aom_events_clean directly so every canonical entity
    # is included — even those that only appear in self-assign transactions (which
    # are excluded from entity_relationships to avoid noise in the graph).
    conn.execute("""
        INSERT OR REPLACE INTO entity_nodes
        WITH all_entities AS (
            SELECT assignor_canon AS entity FROM aom_events_clean
            UNION
            SELECT assignee_canon FROM aom_events_clean
        ),
        out_stats AS (
            SELECT assignor_canon AS entity,
                   COUNT(*) AS outbound_vol,
                   COUNT(DISTINCT assignee_canon) AS out_degree,
                   MIN(rec_date) AS first_seen,
                   MAX(rec_date) AS last_seen
            FROM aom_events_clean GROUP BY assignor_canon
        ),
        in_stats AS (
            SELECT assignee_canon AS entity,
                   COUNT(*) AS inbound_vol,
                   COUNT(DISTINCT assignor_canon) AS in_degree,
                   MIN(rec_date) AS first_seen,
                   MAX(rec_date) AS last_seen
            FROM aom_events_clean GROUP BY assignee_canon
        ),
        types AS (
            SELECT assignee_canon AS entity, assignee_type AS etype
            FROM aom_events_clean GROUP BY assignee_canon
            UNION
            SELECT assignor_canon, assignor_type FROM aom_events_clean GROUP BY assignor_canon
        )
        SELECT
            ae.entity,
            COALESCE(o.outbound_vol, 0) AS outbound_vol,
            COALESCE(i.inbound_vol,  0) AS inbound_vol,
            COALESCE(o.outbound_vol, 0) + COALESCE(i.inbound_vol, 0) AS total_vol,
            COALESCE(o.out_degree,   0) + COALESCE(i.in_degree,   0) AS degree,
            COALESCE(t.etype, 'OTHER') AS entity_type,
            COALESCE(o.first_seen, i.first_seen) AS first_seen,
            COALESCE(i.last_seen,  o.last_seen)  AS last_seen
        FROM all_entities ae
        LEFT JOIN out_stats o ON ae.entity = o.entity
        LEFT JOIN in_stats  i ON ae.entity = i.entity
        LEFT JOIN types     t ON ae.entity = t.entity
    """)
    conn.commit()

    n_nodes = conn.execute("SELECT COUNT(*) FROM entity_nodes").fetchone()[0]
    print(f"  entity_nodes: {n_nodes} rows")

    # ── Multi-signal entity type classification ─────────────────────────────
    print("Classifying entity types (multi-signal pipeline)...")

    # Fetch FDIC institution list for bank identification
    fdic_set = build_fdic_lookup(conn)

    # Ensure entity_classifications has confidence_source column
    try:
        conn.execute("ALTER TABLE entity_classifications ADD COLUMN confidence_source TEXT")
    except Exception:
        pass

    all_nodes = conn.execute("SELECT entity FROM entity_nodes").fetchall()
    type_updates = []
    classification_upserts = []
    source_counts: dict = defaultdict(int)

    for (entity,) in all_nodes:
        signals = entity_signals.get(entity, {
            'has_banking_suffix': False, 'has_trustee_role': False,
            'has_trust_name': False, 'has_gse_suffix': False,
        })
        etype, source = resolve_entity_type(entity, signals, fdic_set, conn)
        source_counts[source] += 1
        type_updates.append((etype, entity))
        classification_upserts.append((entity, etype, source))

    conn.executemany(
        "UPDATE entity_nodes SET entity_type = ? WHERE entity = ?",
        type_updates
    )
    conn.executemany("""
        INSERT INTO entity_classifications (name, category, confidence_source)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET category = excluded.category,
                                        confidence_source = excluded.confidence_source
    """, classification_upserts)
    conn.commit()

    non_other = sum(1 for etype, _ in type_updates if etype != 'OTHER')
    print(f"  Classified {non_other} entities (out of {n_nodes})")
    print(f"  Signal sources: {dict(source_counts)}")

    # Propagate updated types back into aom_events_clean and re-derive txn_type
    conn.execute("""
        UPDATE aom_events_clean
        SET assignor_type = COALESCE(
            (SELECT entity_type FROM entity_nodes WHERE entity = aom_events_clean.assignor_canon),
            'OTHER'
        ),
        assignee_type = COALESCE(
            (SELECT entity_type FROM entity_nodes WHERE entity = aom_events_clean.assignee_canon),
            'OTHER'
        )
    """)
    conn.execute("""
        UPDATE aom_events_clean SET txn_type =
        CASE
            WHEN assignor_canon = assignee_canon THEN 'SELF_ASSIGN'
            WHEN assignor_type  = 'MERS'         THEN 'MERS_RELEASE'
            WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
             AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'MARKET_TRANSFER'
            WHEN assignor_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS')
             AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'ORIGINATION'
            WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
             AND assignee_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS') THEN 'INSTITUTIONAL_OUT'
            ELSE 'PRIVATE'
        END
    """)
    conn.commit()
    print("  Propagated types + txn_type to aom_events_clean")

    # Show type distribution
    type_dist = conn.execute(
        "SELECT entity_type, COUNT(*) as n FROM entity_nodes GROUP BY entity_type ORDER BY n DESC"
    ).fetchall()
    print("  Type distribution:", {r[0]: r[1] for r in type_dist})

    # ── Indexes ───────────────────────────────────────────────────────────────
    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_clean_date ON aom_events_clean(rec_date);
        CREATE INDEX IF NOT EXISTS idx_clean_txn_type ON aom_events_clean(txn_type);
        CREATE INDEX IF NOT EXISTS idx_clean_assignor ON aom_events_clean(assignor_canon);
        CREATE INDEX IF NOT EXISTS idx_clean_assignee ON aom_events_clean(assignee_canon);
        CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_entity);
        CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_entity);
        CREATE INDEX IF NOT EXISTS idx_rel_count ON entity_relationships(transaction_count DESC);
        CREATE INDEX IF NOT EXISTS idx_nodes_vol ON entity_nodes(total_vol DESC);
    """)

    conn.close()
    print("\nNormalization complete.")

    # ── Quick validation ──────────────────────────────────────────────────────
    conn2 = sqlite3.connect(DB)
    print("\n=== Validation ===")
    print("Top 10 acquirers (inbound):")
    for r in conn2.execute("SELECT entity, inbound_vol, entity_type FROM entity_nodes ORDER BY inbound_vol DESC LIMIT 10").fetchall():
        print(f"  {r[0][:40]} | in={r[1]} | {r[2]}")
    print("\nTop 10 sellers (outbound):")
    for r in conn2.execute("SELECT entity, outbound_vol, entity_type FROM entity_nodes ORDER BY outbound_vol DESC LIMIT 10").fetchall():
        print(f"  {r[0][:40]} | out={r[1]} | {r[2]}")
    print("\nTop 10 most connected (degree):")
    for r in conn2.execute("SELECT entity, degree, total_vol FROM entity_nodes ORDER BY degree DESC LIMIT 10").fetchall():
        print(f"  {r[0][:40]} | degree={r[1]} | vol={r[2]}")
    print("\nTop relationships:")
    for r in conn2.execute("SELECT source_entity, target_entity, transaction_count FROM entity_relationships ORDER BY transaction_count DESC LIMIT 10").fetchall():
        print(f"  {r[0][:25]} → {r[1][:25]} ({r[2]})")
    conn2.close()


if __name__ == '__main__':
    build_normalized_tables()
