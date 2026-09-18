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

import entity_names
import name_matching
import document_direction

DB = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

# ── County scope ──────────────────────────────────────────────────────────────
# Which counties feed the derived tables.
#
# Broward was added 2026-08-10, after its documents had been extracted. The gate
# existed because the raw-name signal sweep has no loan-transfer filter, so
# Broward names could shift the classification of entities trading in both
# counties. Rehearsed twice against production snapshots before widening:
#
#   without Broward extractions → zero drift at all
#   with 539 extractions (374 LOAN_TRANSFER) → +374 rows in aom_events_clean,
#     47 new entities, 110 of 20,320 existing entities changed volume (0.5%),
#     and exactly ONE reclassification — WILMINGTON TRUST NATIONAL ASSN moved
#     OTHER → TRUST, which is a correction, not a regression.
#
# The volume movement is the intended cross-county entity resolution: MERS +178,
# US BANK +86. entity_nodes carries no county, so panels built on it are labelled
# "not filtered by county" in the UI rather than pretending to respect the filter.
#
# Still overridable, so a future county can be rehearsed the same way:
# NORMALIZE_COUNTIES="MIAMI-DADE" to narrow, or "ALL" for every county.
_COUNTIES_ENV = os.environ.get('NORMALIZE_COUNTIES', '').strip()
NORMALIZE_COUNTIES: tuple[str, ...] | None = (
    None if _COUNTIES_ENV.upper() == 'ALL'
    else tuple(c.strip().upper() for c in _COUNTIES_ENV.split(',') if c.strip())
    or ('MIAMI-DADE', 'BROWARD')
)


# ── Non-assignment doc types ──────────────────────────────────────────────────
# Document types collected for their party data but which are NOT assignment
# instruments, and must not reach the analytical tables.
#
# FST (UCC financing statements) was added 2026-09-09 for the lending
# relationships it exposes — secured party ↔ debtor, present on 99% of filings.
# It is a different instrument: a UCC-1 records a NEW security interest, it does
# not transfer a mortgage. Two things follow, and both are load-bearing:
#
#   1. It stays out of aom_events_clean. Without this, any FST the extractor
#      happens to label LOAN_TRANSFER would silently land in the Reporting tab
#      and move numbers the owner already reports on. Measured composition of
#      the bucket: >25% consumer solar / home-improvement finance (ISPC 359,
#      GoodLeap 145, Solar Mosaic, Aqua, Palmetto) — noise in an assignment
#      table by any reading.
#   2. It stays out of the raw-name signal sweep. That sweep has no
#      loan-transfer filter and merges suffix signals by canonical name, so a
#      consumer-finance name landing there can flip assignor_type/assignee_type
#      on an entity that also trades in mortgage assignments — silently
#      changing existing rows. This is the same hazard the county scope note
#      below describes for Broward; see collector/tests/check_doc_type_scope.py,
#      which asserts both invariants.
#
# Extraction is deliberately NOT filtered: the PDFs are read and everything is
# stored in pdf_extractions, so the data is available to query. Only the
# derived/analytical tables are gated.
NON_ASSIGNMENT_DOC_TYPES: tuple[str, ...] = ('FINANCING STATEMENT UCC - FST',)


def non_assignment_filter(alias: str = '') -> str:
    """SQL fragment excluding NON_ASSIGNMENT_DOC_TYPES, for the analytical path.

    Written as NOT IN with a NULL guard rather than `!=` because doc_type is
    nullable: legacy rows predate the column and are AMO by definition, and
    `doc_type NOT IN (...)` is NULL — not true — for those, which would drop
    every one of them from the clean table.
    """
    if not NON_ASSIGNMENT_DOC_TYPES:
        return ''
    quoted = ', '.join("'" + t.replace("'", "''") + "'" for t in NON_ASSIGNMENT_DOC_TYPES)
    col = f'{alias}doc_type'
    return f" AND ({col} IS NULL OR {col} NOT IN ({quoted}))"


def county_filter(conn, alias: str = '') -> str:
    """SQL fragment scoping a query to NORMALIZE_COUNTIES, or '' if not applicable.

    Returns an empty string when the column does not exist yet, so this runs
    unchanged against a database that predates the multi-county migration.
    Values are inlined rather than parameterised because callers compose this
    into UNIONed statements where positional placeholders would have to be
    duplicated and kept in order — the inputs are module constants, not input.
    """
    if not NORMALIZE_COUNTIES:
        return ''
    cols = [r[1] for r in conn.execute('PRAGMA table_info(assignments)')]
    if 'county' not in cols:
        return ''
    quoted = ', '.join("'" + c.replace("'", "''") + "'" for c in NORMALIZE_COUNTIES)
    col = f'{alias}county'
    # COALESCE: rows written before the migration are Miami-Dade by definition.
    return f" AND COALESCE({col}, 'MIAMI-DADE') IN ({quoted})"


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
    # SPACED abbreviations. The county index frequently records these letter by
    # letter — "U S BANK N A", "COMPUTERSHARE TRUST CO N A TRU" — and the
    # patterns above only tolerate an optional PERIOD between the letters, not a
    # space. So "U S BANK NA" canonicalised to US BANK while "U S BANK N A" did
    # not, leaving the same institution split in two. Measured 2026-09-14:
    # 5,326 name occurrences end in " N A", plus L L C 127, P A 33, F S B 19.
    #
    # Written as separate patterns rather than by loosening the ones above,
    # because a looser `\bN[\s.]?A\b` also matches the start of a two-word
    # phrase like "N A REALTY", and keeping them separate makes each one
    # reviewable on its own line.
    r'\bN\s+A\b',
    r'\bL\s+L\s+C\b',
    r'\bF\s+S\s+B\b',
    r'\bP\s+A\b',
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
    # BANK must follow U S directly, which is what keeps "U S CENTURY BANK" — a
    # different institution — out of this. The old form additionally required a
    # TRUST/NA/NATIONAL suffix, and so missed every spaced spelling the county
    # actually records: "U S BANK N A", "U S BANK N A CO", "U S BANK N TRU",
    # "U S BANK NAL ASSN", "U S BANK TRUSY N A" (OCR for TRUST). \b after BANK
    # keeps it clear of BANKRUPTCY.
    (r'U\.?\s*S\.?\s*BANK\b', 'US BANK'),
    # Wilmington Savings. SAVINGS? — the county also records "WILMINGTON SAVING
    # FUND SOCIETY", which missed this and stood alone at 404 filings (+62 as
    # "...TRU") until 2026-09-18.
    (r'WILMINGTON\s+SAVINGS?\b', 'WILMINGTON SAVINGS'),
    # Wilmington Trust — "WILMINGTON TRUST TRU" is the index truncating TRUSTEE
    (r'WILMINGTON\s+TRUST\b', 'WILMINGTON TRUST'),
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
    (r'MORTGAGE\s+ASSETS\s+(?:MANAGEMENT|MGMT)', 'MORTGAGE ASSETS MANAGEMENT'),
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
    # ── Merges confirmed by the owner 2026-09-18 (QC fix list #4) ──────────
    # One company recorded under several spellings. Deliberately NOT merged,
    # because they are different firms: Citibank / CIT Bank, Civic / CV3,
    # My Mortgage / TY Mortgage, Churchill MRA Funding, the Headlands and Legacy
    # trust series.
    (r'FACE\s*BANK|\bINTERNATIONAL\s+FACEBANK', 'FACEBANK INTERNATIONAL'),
    (r'BENWORTH\s+CAPITAL', 'BENWORTH CAPITAL PARTNERS'),
    (r'HOMEBRIDGE\s+FIN', 'HOMEBRIDGE FINANCIAL SERVICES'),
    (r'RUSHMORE\s+LOAN', 'RUSHMORE LOAN MANAGEMENT SERVICES'),
    (r'FIRST[\s-]+CITIZENS\s+BANK\s*(?:&|AND)\s*TRUST', 'FIRST CITIZENS BANK & TRUST COMPANY'),
    (r'CHASE\s+HOME\s+LENDING\s+(?:MTG|MORTGAGE)\s+TRUST\s+2023\W*RPL\s*1', 'CHASE HOME LENDING MORTGAGE TRUST 2023-RPL1'),
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


def _is_institutional(name: str | None) -> bool:
    return bool(name) and classify_canonical(canonicalize(name)) in _INST_TYPES


# Anything carrying one of these is an organisation of some kind, even when the
# type classifier does not recognise which. Used to tell a homeowner's name from
# a company the classifier simply has no pattern for — a distinction the
# classifier alone cannot make, since both come back 'OTHER'.
_CORPORATE_MARKER_RE = re.compile(
    r'\b(?:INC|CORP|CORPORATION|INCORPORATED|LLC|L\.?L\.?C|LTD|LP|L\.?P|LLP|PLC|'
    r'CO|COMPANY|BANK|BANKING|N\.?A|F\.?S\.?B|SSB|TRUST|TRUSTEE|ASSOCIATION|ASSN|'
    r'FUND|FUNDING|CAPITAL|HOLDINGS?|PARTNERS?|PARTNERSHIP|GROUP|SERIES|SYSTEMS|'
    r'MORTGAGE|SERVICING|FINANCIAL|FINANCE|LENDING|LENDERS?|REALTY|PROPERTIES|'
    r'INVESTMENTS?|SAVINGS|CREDIT|UNION|AGENCY|AUTHORITY|SECRETARY|DEPARTMENT|'
    r'BANCORP|BANCSHARES|ENTERPRISES?|VENTURES?|ASSOCIATES|P\.?A)\b', re.I)


def _looks_like_person(name: str | None) -> bool:
    """True when nothing in the name marks it as an organisation.

    Deliberately not "the classifier said OTHER". The classifier returns OTHER
    for a homeowner AND for every company it has no pattern for, and treating
    those the same is what made an earlier draft of the rule swap FV-1 INC ->
    "FY-I, INC. IN TRUST FOR MORGAN STANLEY..." — trading a clean index name for
    one whose key identifier is OCR damage, which then fails to merge with the
    entity's other filings.
    """
    return bool(name) and not _CORPORATE_MARKER_RE.search(name)


def prefer_document_party(index_name: str | None, pdf_name: str | None,
                          broad: bool = True) -> str | None:
    """Pick which name to report for a party: the document's, or the index's.

    The county index lists EVERY party on a filing. For an assignment that
    routinely includes the original borrower and MERS alongside the two
    institutions actually trading the loan, and the dominant-party heuristic
    above has no way to tell which is which — so the Reporting table was showing
    a homeowner's name in the Assignor column on roughly one row in five
    (12,068 of 55,839 measured 2026-09-16). The document itself names the
    assignor and assignee explicitly, and that is the answer to "who sold this
    loan to whom".

    Measured across production before this was changed, preferring the
    document's name is right 13,120 times and wrong 575 times — 23 to 1.

    The swap is deliberately NARROW: it fires only where the index gave a
    non-institution and the document gives an institution. A blanket preference
    was tried first and rejected on the evidence — it changed 52% of canonical
    names, and the dry run showed why that is not a free improvement:

        FV-1                 -> "FY-I, . IN TRUST FOR MORGAN STAN"   OCR damage
        LOAN STORE           -> "THE LOAN STORE"          BANK reclassified OTHER
        HEADLANDS RESIDENTIAL -> (variant spelling)        BANK reclassified OTHER

    The index is clerk-typed and clean; the document is OCR'd and noisy. So the
    index wins on SPELLING and the document wins on WHICH PARTY — and only the
    second of those was ever broken. Narrowing to that captures all 13,120
    corrections, avoids all 575 regressions, and leaves the ~41,000 rows where
    both sides already name an institution completely untouched.

    Asserted by tests/check_party_preference.py.
    """
    pdf = sanitize_ocr_field(pdf_name)
    if not pdf:
        return index_name
    idx = (index_name or '').strip()
    if not idx or looks_like_address(idx):
        # Pre-existing behaviour: an index grantor that is a street address was
        # never a party name, so anything the document offers beats it.
        return pdf
    if _looks_like_person(idx) and _is_institutional(pdf):
        return pdf
    # Widened 2026-09-18 (QC fix list #2). "The document names an institution"
    # was the test, and _is_institutional() only knows the classifier's
    # patterns — so the homeowner stayed in the Assignor column whenever the
    # document's seller was MERS (4,330 Miami-Dade rows: "MORTGAGE ELECTRONIC
    # REGISTRATION SYSTEMS, INC., AS NOMINEE FOR CALIBER HOME LOANS") or a
    # company the classifier has no pattern for (3,372: Forethought Life
    # Insurance, the FDIC, Reverse Mortgage Funding). Read by eye: 2023R100219,
    # 2025R944628, 2026R68031. A name carrying an organisational marker is
    # enough; the same marker test that keeps FV-1 INC from being "corrected"
    # decides it. The caller guards against the one bad outcome measured — the
    # document's party being the other side of the row (~3 in 20 sampled).
    if broad and _looks_like_person(idx) and not _looks_like_person(pdf):
        return pdf
    return index_name


# ── Property address: reject what is not an address ──────────────────────────
# The extractor answers in prose when a document does not state an address —
# "AS DESCRIBED IN SAID MORTGAGE", "not explicitly stated", "more fully
# described in said Mortgage" — and sometimes returns the borrower's name or a
# bare county. 801+ rows carried one of these. A blank column is honest; a
# column that says "not explicitly stated" is noise that also breaks the
# property filter and the CSV export.
_PROP_PROSE_RE = re.compile(
    r'not\s+(?:explicitly\s+|specifically\s+)?(?:stated|specified|provided|given|listed|available)'
    r'|as\s+described\s+in|more\s+fully\s+described|described\s+in\s+said'
    r'|said\s+mortgage|see\s+(?:the\s+)?exhibit|attached\s+exhibit|legal\s+description'
    r'|the\s+property\s+situated|^\s*(?:n/?a|none|unknown|null)\s*$',
    re.I)

# A county or state with no street is not a property address. Anchored so it
# only fires when that is the WHOLE value — "MIAMI-DADE County, Florida" goes,
# "123 SW 8 ST, MIAMI-DADE COUNTY, FL" stays.
_PROP_GEO_ONLY_RE = re.compile(
    r'^\s*(?:miami[-\s]?dade|broward|palm\s+beach)?\s*(?:county)?\s*,?\s*'
    r'(?:florida|fl)?\s*,?\s*(?:\d{5})?\s*$', re.I)


# A platted legal description — "Lot 13, Block 2, of LYNWOOD, according to the
# Plat thereof, as recorded in Plat Book 46" — is NOT a street address but it
# does identify the property, often more precisely than one. An earlier draft of
# this function threw those away along with the prose, which would have been the
# same mistake in the opposite direction: dropping real information to tidy a
# column. They are kept.
_PROP_LEGAL_RE = re.compile(
    r'\b(?:lot|lots|block|plat|tract|township|range|section|unit|condominium)\b', re.I)


def clean_property_address(value: str | None) -> str | None:
    """Return the value if it identifies a property, else None."""
    v = sanitize_ocr_field(value)
    if not v:
        return None
    if _PROP_PROSE_RE.search(v):
        return None
    if _PROP_GEO_ONLY_RE.match(v):
        return None
    # Something locatable carries a number: a street number, a PO box, or a lot
    # and block. Without one there is nothing to find, and what remains is
    # almost always a person's name or a fragment of recital text.
    if not re.search(r'\d', v):
        return None
    if (re.match(r'^\s*\d', v)
            or re.search(r'\bP\.?\s*O\.?\s*BOX\b', v, re.I)
            or _PROP_LEGAL_RE.search(v)):
        return v
    return None

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

    # 0. MERS is a registry, never a bank. Until 2026-09-18 it reached step 6
    #    below, where its volume and spread of counterparties look exactly like
    #    a bank's — so 2,867 MERS filings counted as market sales and MERS
    #    ranked #2 seller, and MERS_RELEASE fired 6 times in total. Exact
    #    pattern, not a substring: FARMERS and CUSTOMERS contain "MERS".
    if classify_canonical(entity) == 'MERS':
        return 'MERS', 'manual_override'

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
    # Government
    'NATIONAL HOMEBUYERS FUND':     'GSE',              # "an instrumentality of government"

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
    # Added 2026-09-18 (QC fix list #5) — lenders the classifier left as OTHER
    'CASA FINANCE GROUP':           'PRIVATE_CREDIT',   # trades with Unitas / Churchill
    'NEWTEK BUSINESS SERVICES':     'PRIVATE_CREDIT',   # SBA lender, sells to its own SPVs
    'INTERNATIONAL MORTGAGE BROKERS': 'PRIVATE_CREDIT', # local private-money lender
    # Servicers
    'MORTGAGE ASSETS MANAGEMENT':   'SERVICER',         # HUD reverse-mortgage servicer
    'FINANCE OF AMERICA REVERSE':   'SERVICER',
    'PARAMOUNT RESIDENTIAL':        'SERVICER',
    'CITIMORTGAGE':                 'SERVICER',
    'COMPUTERSHARE TRUST':          'SERVICER',
    'AMERIHOME MORTGAGE':           'SERVICER',
    'PACIFIC UNION FINANCIAL':      'SERVICER',
    'NEW RESIDENTIAL MORTGAGE':     'SERVICER',
    'AMERICAN BANCSHARES MORTGAGE': 'SERVICER',
    # Banks
    'FACEBANK':                     'BANK',             # FaceBank International, Coral Gables
    'EASTERN FINANCIAL':            'BANK',
    'BRADESCO':                     'BANK',
    'SPACE COAST CREDIT UNION':     'BANK',
    'DLJ MORTGAGE CAPITAL':         'BANK',
    'TRUIST BANK':                  'BANK',
    'MIDFIRST BANK':                'BANK',
    'PACIFIC LIFE INSURANCE':       'BANK',
}


# Held at their pre-2026-09-18 type. These lenders were typed by the
# behavioural rule (step 6 of resolve_entity_type), which needs >= 5 distinct
# counterparties feeding the entity. Before QC fix #2 most of those
# counterparties were HOMEOWNERS wrongly shown as sellers; once the document's
# real seller (usually MERS) replaced them, 133 lenders fell below the threshold
# and dropped to OTHER — a side effect nobody asked for, worth ~1,100 market
# transfers. Pinned here so fix #2 changes who is shown selling, not what
# these firms are. Measured on a dry run of production, 18 Sep 2026; every
# entity with >= 25 filings that lost its type, minus the ones that were
# never institutions (Habitat for Humanity; "NP", a truncated name).
_PINNED_TYPES_2026_09_18: dict[str, str] = {
    'U S SMALL BUSINESS ADMINISTRATION': 'GSE',
    'FEDERAL HOME LOAN MTG':        'GSE',              # Freddie Mac, abbreviated
    **{name: 'BANK' for name in (
        'RBI MORTGAGES', 'LOAN STORE', 'RBI PRIVATE LENDING', 'FLORIDA HOME TRUST MORTGAGE',
        'UNITAS FUNDING', 'CIVIC FINANCIAL SERVICES', 'MCM HOLDINGS', 'HOMETAP EQUITY PARTNERS',
        'ANGEL OAK MORTGAGE SOLUTIONS', 'MY MORTGAGE', 'ALTALOANS', '1ST FINANCIAL',
        'FAMILY BENEFIT LIFE INSURANCE', 'NO LIMIT MTG SOLUTIONS', 'JLM CAPITAL', 'AVAIL 3',
        'CV3 FINANCIAL SERVICES', 'TOWNE MORTGAGE COMPANY', 'FAIRWAY INDEPENDENT M', 'REAL CAPITAL FINANCE',
        'POINT MORTGAGE', 'CELINK', 'EAGLE HOME MORTGAGE', 'LENNAR MTG', 'POINT TITLING TRUST',
        'DHI MORTGAGE COMPANY', 'LIBERTY HOME EQUITY SOLUTIONS', 'READY MORTGAGE LENDERS',
        'HOMEXPRESS MORTGAGE', 'OCMBC', 'AMCAP MORTGAGE', 'ATHAS CAPITAL GROUP',
        'FIRST CITIZENS SECURITIZATION DEPOSITOR', 'MY MTG', 'BPL MORTGAGE', 'TRUST MTG LENDING',
        'CHAMPION MTG', 'GENEVA FINANCIAL', 'HAMILTON HOME LOANS', 'MOVEMENT MTG', 'FM HOME LOANS',
        'HMC ASSETS', 'WORLD ALLIANCE FINANCIAL', 'RESIDENTIAL MORTGAGE AGGREGATION TRUST',
        'ROK LENDING', 'SUN WEST MTG')},
    'DISCOVER BANK':                'SERVICER',
}
_MANUAL_TYPE_OVERRIDES.update(_PINNED_TYPES_2026_09_18)


# ── Credit-facility name cleaning ─────────────────────────────────────────────
# The facility extractor returns lender/borrower names verbatim from document
# text, so the same real-world entity shows up under OCR/formatting variants
# ("VASTER-LOANS IIL LLC", "Assignee (AMERANT BANK, N.A.)") and splits into
# multiple rows in the dashboard's relationship view. Two layers:
#   clean_facility_name() — light display cleanup, names stay close to the doc
#   facility_name_key()   — aggressive grouping key (punctuation-free, upper)
# Both are deliberately separate from canonicalize(): no brand folding or
# suffix stripping here, these names are shown in the UI.

_FAC_ROLE_PREFIX_RE = re.compile(
    r'^\s*(?:ASSIGNEE|ASSIGNOR|LENDER|BORROWER)\s*[:\(]\s*', re.IGNORECASE)
# Names that are just a document role, not an entity — extraction gaps
_FAC_ROLE_ONLY = {'LENDER', 'BORROWER', 'ASSIGNEE', 'ASSIGNOR', 'AGENT', 'TRUSTEE', 'BANK'}
# Exact-match aliases (keyed on the aggressive key form) for OCR misreads that
# rules can't safely catch. Add entries as new variants show up in production.
# Seed data only — these two OCR fixes used to live here as the single source
# of truth. They now live in the entity_aliases table (scope='facility') and are
# inserted once by seed_facility_aliases(); the dict is kept solely so an empty
# database still gets them. Add new corrections from the dashboard, not here.
_FAC_ALIASES = {
    'GIDY NATIONAL BANK OF FLORIDA': 'City National Bank of Florida',
    'BGI FINANCIAL LEC': 'BGI Financial, LLC',
}


def seed_facility_aliases(conn) -> None:
    """Insert the legacy hardcoded aliases if they aren't in the table yet.

    INSERT OR IGNORE, so a correction the user has since edited from the
    dashboard is never overwritten by this seed.
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS entity_aliases (
            variant TEXT PRIMARY KEY, canonical TEXT NOT NULL,
            created_at TEXT, created_by TEXT, note TEXT
        )
    """)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(entity_aliases)")}
    if 'scope' not in cols:
        conn.execute("ALTER TABLE entity_aliases ADD COLUMN scope TEXT DEFAULT 'all'")
    for variant, canonical in _FAC_ALIASES.items():
        conn.execute(
            "INSERT OR IGNORE INTO entity_aliases "
            "(variant, canonical, created_at, created_by, note, scope) "
            "VALUES (?, ?, datetime('now'), 'migration', ?, 'facility')",
            (variant, canonical, 'migrated from normalize._FAC_ALIASES'))


# Both delegate to entity_names, the shared address book. Kept as named
# functions because they are registered as SQLite user functions below and
# referenced by name in the facility table build.
def clean_facility_name(name):
    """Display-level cleanup of an extracted facility lender/borrower name."""
    return entity_names.display_name(name)


def facility_name_key(name):
    """Exact-entity grouping key — punctuation-free, legal suffixes preserved.

    Returns '' (not NULL) when there is no usable name, so SQL grouping and
    exact-match lookups behave consistently.
    """
    return entity_names.entity_key(name)


def facility_brand_key(name):
    """Brand-family key for the same name: the entity's parent brand.

    Stored alongside the entity key so the dashboard can roll filings up by
    institution WITHOUT losing the individual borrower shell or trust, which is
    what the entity key preserves. Brand folding is deliberately reused from
    canonicalize() rather than reimplemented — the two must not drift.
    """
    cleaned = entity_names.display_name(name)
    return canonicalize(cleaned) if cleaned else ''


def get_txn_type(assignor_canon: str, assignee_canon: str,
                 assignor_type: str, assignee_type: str) -> str:
    if assignor_canon == assignee_canon:
        return 'SELF_ASSIGN'
    if assignor_type == 'MERS' or assignee_type == 'MERS':
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
    # Scope matters: only 'all'-scoped entries may affect canonicalize(), which
    # drives aom_events_clean and every dashboard tab built on it. Facility-
    # scoped merges are for the facility path alone. Selecting every row here
    # silently applied them brand-wide and voided the non-breaking guarantee.
    # Rows predating the scope column are NULL and count as 'all'.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(entity_aliases)")}
    if 'scope' not in cols:
        conn.execute("ALTER TABLE entity_aliases ADD COLUMN scope TEXT DEFAULT 'all'")
    raw = dict(conn.execute(
        "SELECT variant, canonical FROM entity_aliases "
        "WHERE COALESCE(scope, 'all') = 'all'"))
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

    # Strip leading punctuation and OCR junk, but KEEP leading digits.
    #
    # This used to be r'^[^A-Z]+', which also ate the number in a company name.
    # "7190 HOLDINGS LLC" became "HOLDINGS", "1347 PRODUCE LLC" became
    # "PRODUCE" — and because South Florida property companies are routinely
    # named after their street number, 47 unrelated firms collapsed into a
    # single fictional "INVESTMENTS" entity and 45 into "HOLDINGS". Their
    # profiles, volumes and rankings summed businesses with nothing to do with
    # each other. Measured 2026-09-14: 1,752 filings across 1,113 companies.
    #
    # Keeping digits fixes that without fragmenting any real institution —
    # US BANK still gathers its 236 spellings, CITIBANK 67, JPMORGAN CHASE 57.
    s = re.sub(r'^[^A-Z0-9]+', '', s)

    # A LEADING ZERO, though, is never part of a company name — it is a filing
    # sequence number or OCR damage, and stripping it lets the spellings gather:
    #   "001 FOUNDATIONAL FAMILY REVOCABLE TRUST" -> the bare trust name
    #   "0 0WELLS FARGO BANK NA"                  -> WELLS FARGO
    #
    # Magnitude was tried as the discriminator — strip anything under 100 as a
    # "sequence prefix" — and the data rejected it. Two-digit and even
    # single-digit leading numbers are overwhelmingly real street numbers here:
    # "10 COLEE LLC", "11 SOUTH LLC", "12 WEST 29 STREET LLC", "1 OAK RICHLAND
    # LLC", "1 DOLLAR PLUS LLC". That rule would have turned "11 SOUTH LLC" into
    # "SOUTH" and recreated the exact merge it was meant to fix.
    #
    # So only leading zeros go. The residual cost is that "1 SHARPE OPPORTUNITY
    # TRUST" stays separate from "SHARPE OPPORTUNITY TRUST" where the 1 really
    # was noise. That is the right way to be wrong: a split entity is visible on
    # the Entities page and mergeable there by hand, whereas a false merge
    # fabricates a company nobody can spot.
    s = re.sub(r'^0[\d\s]*(?=[A-Z])', '', s)
    pre_suffix = s
    
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

    # Suffix stripping can leave a bare number: "1104 LLC" -> "1104". That is
    # accurate but useless in an entity list, and unlike the old behaviour it
    # does not merge anything, so the form WITH the suffix is kept instead.
    # 97 names hit this.
    if re.fullmatch(r'[\d\s\-.]+', s or ''):
        s = pre_suffix or s
    
    if not s:
        return 'UNKNOWN'
    # Final step: apply user-managed merges from the Entities page
    return _ALIAS_MAP.get(s, s)


def build_normalized_tables():
    # timeout/busy_timeout rather than python's 5s default. This rebuild ends in
    # ONE large commit, and it has to take the write lock to do it. Any other
    # writer active at that moment — the facility tick, or an extraction
    # backfill writing a row every couple of seconds — makes a 5s limit a
    # coin toss, and losing it raises "database is locked" and throws away the
    # whole ~85-minute run. run_nightly_normalize.sh then correctly skips the
    # PM2 restart, so the symptom is simply that the dashboard silently does not
    # refresh that night.
    conn = sqlite3.connect(DB, timeout=300)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=300000')

    # ── Step 0a: Load user-managed merges so canonicalize() honors them ─────
    n_aliases = load_aliases(conn)
    if n_aliases:
        print(f"Loaded {n_aliases} user-managed entity aliases")

    # Shared address book (entity_names). Seeded once from the legacy hardcoded
    # dict, then read from entity_aliases like every other correction.
    seed_facility_aliases(conn)
    n_fac_aliases = entity_names.load_aliases(conn, scope='facility')
    print(f"Loaded {n_fac_aliases} facility-scope aliases from the address book")
    n_parents = entity_names.load_parents(conn)
    print(f"Loaded {n_parents} confirmed parent assignments")

    # ── Step 0: Collect suffix signals from ALL raw filing names ───────────
    print("Extracting suffix signals from raw filings...")
    entity_signals: dict = defaultdict(lambda: {
        'has_banking_suffix': False,
        'has_trustee_role': False,
        'has_trust_name': False,
        'has_gse_suffix': False,
    })

    # Scoped by county on purpose. The loan-transfer filter further down keeps
    # Broward documents out of aom_events_clean until they have extractions, but
    # THIS sweep has no such filter: it reads raw names straight off
    # `assignments`, and a Broward name landing here can flip the suffix signals
    # of a canonical entity that also trades in Miami-Dade — silently changing
    # assignor_type/assignee_type on existing rows. Widen this when Broward
    # extraction lands and cross-county entity resolution is wanted.
    scope = county_filter(conn) + non_assignment_filter()
    all_raw = conn.execute(
        f"SELECT DISTINCT grantor FROM assignments WHERE grantor IS NOT NULL{scope} "
        "UNION "
        f"SELECT DISTINCT grantee FROM assignments WHERE grantee IS NOT NULL{scope}"
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
    # Collected from BOTH tables: a filing can be reviewed from the Reporting tab
    # whichever category it sits under, and both tables are dropped below. Taking
    # marks from the clean table alone silently discarded every review made on a
    # collateral or rents-and-leases filing on the next nightly run.
    review_rows = []
    for _table in ('aom_events_clean', 'aom_events_nonloan'):
        try:
            review_rows += conn.execute(f"""
                SELECT cfn, classification, reviewed_by, reviewed_at FROM {_table}
                WHERE reviewed_at IS NOT NULL OR classification IS NOT NULL
            """).fetchall()
        except sqlite3.OperationalError:
            pass  # first run, or the table/columns do not exist yet
    if review_rows:
        print(f"  Preserving {len(review_rows)} manual review marks")

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
            reviewed_at          TEXT,
            -- MUST be declared here and populated below. This table is dropped
            -- and recreated on every run, so a column added by a migration does
            -- not survive. Worse than losing it: server/db.ts re-adds it on the
            -- next startup and backfills NULL -> 'MIAMI-DADE', which would
            -- silently relabel every Broward row and serve it under a
            -- Miami-Dade filter with no error anywhere.
            county               TEXT
        );
    """)

    # Sibling table: assignment filings that are NOT loan transfers — collateral
    # assignments, assignments of rents and leases, and the rest. Identical
    # schema on purpose, so the Reporting query can read either one or UNION
    # both without a column map.
    #
    # A SEPARATE TABLE rather than a widened aom_events_clean, deliberately:
    # the Overview, Entities, Lending Relationships, the emailed report and the
    # entity graph all read that table, and widening it would mean finding and
    # patching every one of them or watching every published number move. A
    # consumer that has never heard of this table physically cannot be affected
    # by it. UCC filings are excluded from BOTH tables — see
    # NON_ASSIGNMENT_DOC_TYPES for why their party columns do not mean the same
    # thing.
    conn.executescript("""
        DROP TABLE IF EXISTS aom_events_nonloan;
        CREATE TABLE aom_events_nonloan (
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
            reviewed_at          TEXT,
            -- Same trap as the clean table: declare county HERE. The table is
            -- dropped and recreated each run, and server/db.ts backfills a
            -- missing county to MIAMI-DADE, which would silently relabel every
            -- Broward row.
            county               TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nonloan_category ON aom_events_nonloan(doc_category);
        CREATE INDEX IF NOT EXISTS idx_nonloan_date     ON aom_events_nonloan(rec_date);
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
            folio_parcel         TEXT,
            sponsor_address      TEXT,
            signatory_officer    TEXT,
            facility_type              TEXT,
            facility_agreement_name    TEXT,
            facility_agreement_date    TEXT,
            facility_lender_name       TEXT,
            facility_agent_name        TEXT,
            facility_borrower_name     TEXT,
            facility_amount            REAL,
            facility_amount_type       TEXT,
            facility_evidence_quote    TEXT,
            facility_confidence        TEXT,
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
            # Note: clean_property_address, NOT sanitize_address_field. The
            # property column has to hold a locatable address or nothing;
            # sponsor_address below keeps the looser rule, because a corporate
            # address is exactly what that field is for.
            'property_address':    clean_property_address(r[6]),
            'loan_amount':         r[7],
            'consideration_amount':r[8],
            'doc_title':           sanitize_ocr_field(r[9]),
            'folio_parcel':        sanitize_ocr_field(r[10]),
            'sponsor_address':     sanitize_address_field(r[11]),
            'signatory_officer':   sanitize_name_field(r[12]),
            'facility_type':            r[13],
            'facility_agreement_name':  sanitize_ocr_field(r[14]),
            'facility_agreement_date':  r[15],
            'facility_lender_name':     sanitize_name_field(r[16]),
            'facility_agent_name':      sanitize_name_field(r[17]),
            'facility_borrower_name':   sanitize_name_field(r[18]),
            'facility_amount':          r[19],
            'facility_amount_type':     r[20],
            'facility_evidence_quote':  sanitize_ocr_field(r[21]),
            'facility_confidence':      r[22],
        }
        for r in conn.execute("""
            SELECT cfn, doc_category, assignor_name, assignor_parent,
                   assignee_name, assignee_parent, property_address,
                   loan_amount, consideration_amount, doc_title,
                   folio_parcel, sponsor_address, signatory_officer,
                   facility_type, facility_agreement_name, facility_agreement_date,
                   facility_lender_name, facility_agent_name, facility_borrower_name,
                   facility_amount, facility_amount_type, facility_evidence_quote,
                   facility_confidence
            FROM pdf_extractions WHERE status = 'OK'
        """).fetchall()
    }
    print(f"  PDF extractions available: {len(extractions)}")
    n_facility = sum(1 for e in extractions.values()
                     if e['facility_type'] and e['facility_type'] != 'none')
    print(f"  Of which with facility language: {n_facility}")

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
               a.address,
               -- Appended at the END on purpose: the rows below are unpacked by
               -- positional index (entries[0][8] etc.), so inserting a column
               -- anywhere earlier would silently shift every one of them.
               COALESCE(a.county, 'MIAMI-DADE') AS county
        FROM assignments a
        LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
        LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
        WHERE 1=1""" + county_filter(conn, 'a.') + non_assignment_filter('a.') + """
    """).fetchall()

    print(f"  Loaded {len(rows)} raw rows")

    cfn_groups: dict = defaultdict(list)
    for row in rows:
        cfn_groups[row[0]].append(row)

    # Stored OCR text for the direction check (document_direction.py). Empty
    # until reread_documents.py has run; the rule then relies on the AI reading
    # alone, which is what the D3/D4 evidence validated.
    doc_texts = document_direction.load_texts(conn)
    print(f"  Stored document texts for the direction check: {len(doc_texts)}")
    direction_rows = []

    print(f"  Processing {len(cfn_groups)} unique CFNs...")

    AMO_DOC_TYPE = 'ASSIGNMENT OF MORTGAGE - AMO'
    inserts = []
    # Assignment filings the loan-transfer filter rejects — collateral
    # assignments, assignments of rents and leases, and the rest. Until
    # 2026-09-11 these were counted and dropped on the floor; they now go to
    # aom_events_nonloan so the Reporting tab can filter to them, while
    # aom_events_clean keeps its exact previous meaning and every page built on
    # it keeps its exact previous numbers.
    #
    # Both sides of these filings are still institutions — a collateral
    # assignment is a lender pledging a mortgage it owns — so assignor/assignee
    # mean the same thing here as in the clean table. That is precisely why UCC
    # filings are NOT in this table: there the first party is the BORROWER, and
    # mixing the two would put property owners into seller rankings.
    nonloan_inserts = []
    skipped_non_loan = 0
    unread_skipped = 0
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
        # A filing only reaches the sibling table once its PDF has actually been
        # read. An unread document has no doc_category, and filing it under a
        # category filter would be a lie — it is not "other", it is unknown.
        #
        # This is not a rounding error: production holds 41,970 such rows, all
        # Broward AST filings with neither a book/page nor a harvested image, so
        # they are unreadable until the bulk image order lands. They already
        # appear on the Raw Assignments page, which is the right home for
        # unprocessed index data. Admitting them here would have put more rows
        # into the Reporting tab than every classified document combined.
        classified = doc_category is not None
        if not include:
            skipped_non_loan += 1
            if not classified:
                unread_skipped += 1
                continue
            # Read, and genuinely not a loan transfer. Deliberately NOT
            # `continue`: the row is built exactly as a clean row would be — same
            # canonicalization, same dominant-party resolution, same extracted
            # fields — and routed to the sibling table at the bottom of the loop.
            # Building it separately is how the two tables would drift apart.

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

        # ── Direction: which way did the loan move? ─────────────────────────
        # Miami-Dade's index lists some assignments backwards (7,478 rows,
        # 13.6%, measured 2026-09-17/18). The document decides the direction,
        # the index keeps the spelling. Rule and evidence: document_direction.py.
        # Runs BEFORE the party preference below, so each index name is paired
        # with the document's party on the same side.
        if include and ext and entries[0][13] == 'MIAMI-DADE':
            pa_raw, pb_raw = ext.get('assignor_name'), ext.get('assignee_name')
            bkt = document_direction.bucket(
                canonicalize(dominant_assignor), canonicalize(dominant_grantee),
                canonicalize(pa_raw) if pa_raw else None, canonicalize(pb_raw) if pb_raw else None)
            verdict = document_direction.text_verdict(doc_texts.get(cfn), dominant_assignor, dominant_grantee)
            swap, review = document_direction.decide(bkt, verdict)
            if swap or review:
                direction_rows.append((cfn, bkt, verdict, 'SWAPPED' if swap else 'KEPT', int(review),
                                       dominant_assignor, dominant_grantee))
            if swap:
                dominant_assignor, dominant_grantee = dominant_grantee, dominant_assignor
                assignor_type, grantee_type = grantee_type, assignor_type

        # The document names the assignor and assignee explicitly; the index
        # only lists everyone who appears on the filing. Prefer the document.
        if ext:
            new_a = prefer_document_party(dominant_assignor, ext.get('assignor_name'))
            new_b = prefer_document_party(dominant_grantee, ext.get('assignee_name'))
            # The widened rule (2026-09-18) must never turn a two-party row into
            # a fake self-transfer: in ~3 of 20 sampled rows the document's
            # "assignor" was the buyer. Where it would, keep the narrow rule.
            if canonicalize(new_a) == canonicalize(new_b):
                new_a = prefer_document_party(dominant_assignor, ext.get('assignor_name'), broad=False)
                new_b = prefer_document_party(dominant_grantee, ext.get('assignee_name'), broad=False)
            dominant_assignor, dominant_grantee = new_a, new_b

        assignor_canon = canonicalize(dominant_assignor)
        assignee_canon = canonicalize(dominant_grantee)

        # The reported name may now come from the document rather than the
        # index, so the index's own classification no longer describes it — that
        # is how a bank ended up labelled OTHER. Re-derive from the name
        # actually being reported, keeping the index's answer only where the
        # pattern classifier has nothing to say.
        if (t := classify_canonical(assignor_canon)) != 'OTHER':
            assignor_type = t
        if (t := classify_canonical(assignee_canon)) != 'OTHER':
            grantee_type = t
        txn_type = get_txn_type(assignor_canon, assignee_canon, assignor_type, grantee_type)

        (inserts if include else nonloan_inserts).append((
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
            (ext['property_address'] if ext and ext['property_address']
             else clean_property_address(index_address)),
            ext['loan_amount']           if ext else None,
            ext['consideration_amount']  if ext else None,
            ext['folio_parcel']          if ext else None,
            ext['sponsor_address']       if ext else None,
            ext['signatory_officer']     if ext else None,
            # index 13 of the source row — see the SELECT comment above
            entries[0][13],
        ))

    conn.executemany("""
        INSERT OR REPLACE INTO aom_events_clean
        (cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
         assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties,
         doc_type, doc_category, doc_title, pdf_assignor, pdf_assignee,
         assignor_parent, assignee_parent, property_address,
         loan_amount, consideration_amount,
         folio_parcel, sponsor_address, signatory_officer, county)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, inserts)

    conn.commit()

    conn.executemany("""
        INSERT OR REPLACE INTO aom_events_nonloan
        (cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
         assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties,
         doc_type, doc_category, doc_title, pdf_assignor, pdf_assignee,
         assignor_parent, assignee_parent, property_address,
         loan_amount, consideration_amount,
         folio_parcel, sponsor_address, signatory_officer, county)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, nonloan_inserts)

    # Restore preserved review marks, now that BOTH tables are populated. Each
    # CFN matches in exactly one of them; the other UPDATE is a no-op. Doing this
    # before the sibling insert would have dropped every mark on a non-loan row.
    if review_rows:
        for _table in ('aom_events_clean', 'aom_events_nonloan'):
            conn.executemany(f"""
                UPDATE {_table}
                SET classification = ?, reviewed_by = ?, reviewed_at = ?
                WHERE cfn = ?
            """, [(c, rb, ra, cfn) for cfn, c, rb, ra in review_rows])
    conn.commit()

    # Every direction decision that changed a row or needs a human look. Rebuilt
    # each run, like the tables it explains; the Needs-review list is
    # `WHERE needs_review = 1`.
    conn.executescript("""
        DROP TABLE IF EXISTS direction_decisions;
        CREATE TABLE direction_decisions (
            cfn             TEXT PRIMARY KEY,
            bucket          TEXT,     -- D1..D5, see document_direction.py
            text_verdict    TEXT,     -- FORWARD | REVERSED | NULL (text check abstained / no text)
            action          TEXT,     -- SWAPPED | KEPT
            needs_review    INTEGER,
            index_assignor  TEXT,     -- the index's order, before any swap
            index_assignee  TEXT
        );
    """)
    conn.executemany("INSERT OR REPLACE INTO direction_decisions VALUES (?,?,?,?,?,?,?)", direction_rows)
    conn.commit()
    n_swapped = sum(1 for r in direction_rows if r[3] == 'SWAPPED')
    n_review = sum(r[4] for r in direction_rows)
    print(f"  Direction: {n_swapped} Miami-Dade rows swapped to the document's order; "
          f"{n_review} flagged for review")

    n = conn.execute("SELECT COUNT(*) FROM aom_events_clean").fetchone()[0]
    n_other = conn.execute("SELECT COUNT(*) FROM aom_events_nonloan").fetchone()[0]
    print(f"  aom_events_clean:   {n} rows (loan transfers)")
    print(f"  aom_events_nonloan: {n_other} rows of {skipped_non_loan} non-loan-transfer "
          f"filings ({unread_skipped} skipped as not yet read)")
    for cat, cnt in conn.execute(
            "SELECT COALESCE(doc_category,'(none)'), COUNT(*) FROM aom_events_nonloan "
            "GROUP BY 1 ORDER BY 2 DESC"):
        print(f"      {cat:<16} {cnt}")

    # ── Credit facility events ─────────────────────────────────────────────
    # Independent of the aom_events_clean loan-transfer filter above — a
    # document can carry real warehouse/credit-facility language regardless
    # of its doc_category, so this surfaces those separately rather than
    # folding them into (or being excluded from) Clean Transactions.
    print("Building credit_facility_events...")
    conn.create_function('clean_fac_name', 1, clean_facility_name)
    conn.create_function('fac_name_key', 1, facility_name_key)
    conn.create_function('fac_brand_key', 1, facility_brand_key)
    # County-recorded borrower name. grantor/grantee come from the county's
    # typed index; facility_borrower_name is LLM-extracted from OCR'd body
    # text. Stored ALONGSIDE the extracted name rather than replacing it, so
    # existing queries and the UI are untouched while the accurate name becomes
    # available. Verified on CFN 2025R173932, where the extractor produced
    # "VASTER SUBIII, LLG" for a filing the county recorded as VASTER SUB III.
    def _recorded(ext, gr, ge, ln):
        return name_matching.resolve_recorded_name(ext, gr, ge, ln)[0]

    # Cleaned + alias-resolved, so the IIL->III OCR fix and any approved merge
    # actually reach the stored name.
    conn.create_function(
        'fac_recorded', 4,
        lambda ext, gr, ge, ln: entity_names.display_name(_recorded(ext, gr, ge, ln)))
    # The grouping key MUST derive from the recorded name too. Keying off the
    # extracted name left every approved merge inert: an alias recorded as
    # "VASTER SUB II LL" never matched a key built from the extraction
    # "VASTER SUB II, LLC", so a full rebuild changed nothing at all.
    conn.create_function(
        'fac_recorded_key', 4,
        lambda ext, gr, ge, ln: entity_names.entity_key(_recorded(ext, gr, ge, ln)))
    conn.create_function(
        'fac_recorded_brand', 4,
        lambda ext, gr, ge, ln: facility_brand_key(_recorded(ext, gr, ge, ln)))
    # Confirmed parent only — parent_of() never guesses, so an unassigned
    # entity stays NULL and surfaces as a proposal instead of being folded
    # into a family nobody approved.
    conn.create_function('fac_parent', 1, entity_names.parent_of)
    # Direction and party roles move server-side. They were computed in the
    # client from a hand-maintained JS copy of the key function, which had to
    # stay byte-identical to the Python by hand and did not.
    conn.create_function('fac_direction', 3, name_matching.filing_direction)
    conn.create_function('fac_role', 5, name_matching.party_role)
    conn.executescript("""
        DROP TABLE IF EXISTS credit_facility_events;
        CREATE TABLE credit_facility_events (
            cfn                      TEXT PRIMARY KEY,
            rec_date                 TEXT,
            doc_type                 TEXT,
            grantor                  TEXT,
            grantee                  TEXT,
            rec_book                 TEXT,
            rec_page                 TEXT,
            facility_type            TEXT,
            facility_agreement_name  TEXT,
            facility_agreement_date  TEXT,
            facility_lender_name     TEXT,
            facility_agent_name      TEXT,
            facility_borrower_name   TEXT,
            facility_amount          REAL,
            facility_amount_type     TEXT,
            facility_evidence_quote  TEXT,
            facility_confidence      TEXT,
            lender_key               TEXT,
            borrower_key             TEXT,
            -- Brand-family keys, stored ALONGSIDE the entity keys above so the
            -- dashboard can roll up by institution without losing the
            -- individual borrower shell or trust. Never group by these alone
            -- on the borrower side: brand folding merges distinct SPEs.
            lender_brand             TEXT,
            borrower_brand           TEXT,
            -- County-recorded borrower name and the confirmed corporate family.
            -- The parent GROUPS sub-entities without merging them: VASTER SUB II
            -- and VASTER SUB III both sit under "Vaster" and stay separate rows
            -- with their own facilities and filing histories.
            borrower_recorded        TEXT,
            borrower_parent          TEXT,
            lender_parent            TEXT,
            -- Pledge/release and the role of each recorded party, resolved
            -- against the same keys the pipeline groups on.
            direction                TEXT,
            grantor_role             TEXT,
            grantee_role             TEXT,
            -- Same reasoning as aom_events_clean: this table is dropped and
            -- recreated each run, so the column must live here rather than in a
            -- migration, or Broward rows get relabelled Miami-Dade on restart.
            county                   TEXT
        );
    """)
    # facility_amount <= 1000 is the standard deed recital ("for $10.00 and
    # other good and valuable consideration") leaking through — never a real
    # facility size, so null it rather than displaying it.
    conn.execute("""
        INSERT OR REPLACE INTO credit_facility_events
        SELECT a.cfn, a.rec_date, a.doc_type, a.grantor, a.grantee,
               a.rec_book, a.rec_page,
               px.facility_type, px.facility_agreement_name, px.facility_agreement_date,
               clean_fac_name(px.facility_lender_name),
               clean_fac_name(px.facility_agent_name),
               clean_fac_name(px.facility_borrower_name),
               CASE WHEN px.facility_amount <= 1000 THEN NULL ELSE px.facility_amount END,
               px.facility_amount_type, px.facility_evidence_quote,
               px.facility_confidence,
               fac_name_key(px.facility_lender_name),
               fac_recorded_key(px.facility_borrower_name, a.grantor, a.grantee,
                                px.facility_lender_name),
               fac_brand_key(px.facility_lender_name),
               fac_recorded_brand(px.facility_borrower_name, a.grantor, a.grantee,
                                  px.facility_lender_name),
               fac_recorded(px.facility_borrower_name, a.grantor, a.grantee,
                            px.facility_lender_name),
               fac_parent(fac_recorded(px.facility_borrower_name, a.grantor,
                                       a.grantee, px.facility_lender_name)),
               fac_parent(px.facility_lender_name),
               fac_direction(a.grantor, a.grantee, px.facility_lender_name),
               fac_role(a.grantor, px.facility_borrower_name, a.grantor, a.grantee,
                        px.facility_lender_name),
               fac_role(a.grantee, px.facility_borrower_name, a.grantor, a.grantee,
                        px.facility_lender_name),
               COALESCE(a.county, 'MIAMI-DADE')
        FROM pdf_extractions px
        JOIN assignments a ON a.cfn = px.cfn
        WHERE px.status = 'OK'
          AND px.facility_type IS NOT NULL AND px.facility_type != 'none'
          """ + county_filter(conn, 'a.') + """
        GROUP BY a.cfn
    """)
    conn.commit()

    n_cfe = conn.execute("SELECT COUNT(*) FROM credit_facility_events").fetchone()[0]
    n_pairs = conn.execute(
        "SELECT COUNT(DISTINCT lender_key || '|' || borrower_key) FROM credit_facility_events"
    ).fetchone()[0]
    print(f"  credit_facility_events: {n_cfe} rows ({n_pairs} distinct lender/borrower pairs)")

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

    # ── Strip corporate addresses out of the property column ─────────────────
    # The prompt tells the extractor not to return a party's own address, which
    # is not the same as it not happening: 118 rows carried Freedom Mortgage's
    # Boca Raton office, 51 a Meriden CT office, 33 a Coral Gables one.
    #
    # The tell is that the SAME string is already known to be a party's own
    # mailing address, because sponsor_address is extracted separately on every
    # document. An address a party lists as its own on three or more filings is
    # its office, whatever column it later turns up in.
    #
    # This replaces a first attempt that keyed on repetition instead — ">=15
    # filings sharing <=2 buyers". That was wrong in both directions: it missed
    # Freedom Mortgage's Boca Raton office (118 rows, but FOUR buyer spellings
    # once an OCR variant "FREDOM MORTGAGE" is counted) while catching a real
    # platted legal description. Repetition alone cannot separate a busy
    # property from a mailroom.
    #
    # Measured separation is clean, which is why the threshold is safe to set
    # low: known offices appear as a party address 10-351 times, and the real
    # properties in the same size band appear 0 or 1 times. Nothing sits
    # between 1 and 10.
    for table in ('aom_events_clean', 'aom_events_nonloan'):
        before = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE property_address IS NOT NULL").fetchone()[0]
        conn.execute(f"""
            UPDATE {table} SET property_address = NULL
            WHERE UPPER(TRIM(property_address)) IN (
                SELECT UPPER(TRIM(sponsor_address)) FROM pdf_extractions
                WHERE sponsor_address IS NOT NULL AND TRIM(sponsor_address) != ''
                GROUP BY UPPER(TRIM(sponsor_address))
                HAVING COUNT(*) >= 3
            )""")
        after = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE property_address IS NOT NULL").fetchone()[0]
        print(f"  {table}: cleared {before - after} party-address rows from property")

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
            -- MERS on EITHER side is record-keeping, not a sale. Before
            -- 2026-09-18 a loan assigned TO MERS fell through to PRIVATE here
            -- (and to INSTITUTIONAL_OUT in get_txn_type), because MERS was typed
            -- BANK and neither path had ever seen it on the buying side.
            WHEN assignor_type  = 'MERS' OR assignee_type = 'MERS' THEN 'MERS_RELEASE'
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
    conn2 = sqlite3.connect(DB, timeout=300)
    conn2.execute('PRAGMA busy_timeout=300000')
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
