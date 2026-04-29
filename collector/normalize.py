"""
AMO Normalization Pipeline
--------------------------
1. Canonical entity name mapping (typo correction + suffix stripping)
2. Per-CFN transaction deduplication → aom_events_clean
3. Entity relationship edge list → entity_relationships
"""
import sqlite3
import re
import os
from collections import defaultdict

DB = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')

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
    # Alto Capital
    (r'\bALTO\b', 'ALTO CAPITAL'),
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
            return canon
    
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
    
    return s if s else 'UNKNOWN'


def build_normalized_tables():
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')

    print("Building aom_events_clean...")

    # aom_events_clean: one canonical record per CFN
    # Strategy: for each CFN, find the DOMINANT direction
    # (the one assignee that appears in the most rows, paired with a canonical assignor)
    # For CFNs with a single assignor→grantee pair repeated N times, just pick the canonical pair
    conn.executescript("""
        DROP TABLE IF EXISTS aom_events_clean;
        CREATE TABLE aom_events_clean (
            cfn            TEXT PRIMARY KEY,
            rec_date       TEXT,
            assignor       TEXT,  -- raw, dominant assignor name
            assignee       TEXT,  -- raw, dominant assignee name
            assignor_canon TEXT,
            assignee_canon TEXT,
            assignor_type  TEXT,
            assignee_type  TEXT,
            txn_type       TEXT,  -- MARKET_TRANSFER | ORIGINATION | SELF_ASSIGN | MERS_RELEASE | PRIVATE | OTHER
            rec_book       TEXT,
            rec_page       TEXT,
            total_parties  INTEGER  -- how many raw rows were rolled up
        );
    """)

    # For each CFN: pick the dominant (assignor, grantee) direction.
    # "Dominant" = the pair where grantee appears the most times.
    # If there's a clear majority grantee, that's the real transaction target.
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
               COUNT(*) OVER (PARTITION BY a.cfn, a.grantee) as grantee_count
        FROM assignments a
        LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
        LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
    """).fetchall()

    print(f"  Loaded {len(rows)} raw rows")

    # Group by CFN, find dominant grantee
    from collections import defaultdict
    cfn_groups: dict = defaultdict(list)
    for row in rows:
        cfn_groups[row[0]].append(row)

    print(f"  Processing {len(cfn_groups)} unique CFNs...")

    inserts = []
    for cfn, entries in cfn_groups.items():
        total_parties = entries[0][8]

        # Count grantee occurrences per CFN
        grantee_counts: dict = defaultdict(list)
        for e in entries:
            grantee_counts[e[3]].append(e)

        # Pick dominant grantee (most rows)
        dominant_grantee, dominant_rows = max(grantee_counts.items(), key=lambda x: len(x[1]))
        
        # Pick the dominant assignor: the one that appears most as grantor among dominant rows
        assignor_counts: dict = defaultdict(int)
        for e in dominant_rows:
            # Skip if assignor == grantee (self-assignment / mirror)
            if (e[2] or '').strip().upper() != (dominant_grantee or '').strip().upper():
                assignor_counts[e[2]] += 1

        if assignor_counts:
            dominant_assignor = max(assignor_counts, key=assignor_counts.get)
            # Get type info for dominant assignor
            assignor_entry = next((e for e in dominant_rows if e[2] == dominant_assignor), dominant_rows[0])
            assignor_type = assignor_entry[6]
        else:
            assignor_entry = entries[0]
            dominant_assignor = assignor_entry[2] or 'UNKNOWN'
            assignor_type = assignor_entry[6] or 'OTHER'

        # Get grantee type
        grantee_type = dominant_rows[0][7]
        rec_date = entries[0][1]
        rec_book = entries[0][4]
        rec_page = entries[0][5]

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
            total_parties
        ))

    conn.executemany("""
        INSERT OR REPLACE INTO aom_events_clean
        (cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
         assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, inserts)
    conn.commit()

    n = conn.execute("SELECT COUNT(*) FROM aom_events_clean").fetchone()[0]
    print(f"  aom_events_clean: {n} rows")

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

    # ── Post-classification: assign entity types from canonical name patterns ──
    print("Classifying entity types...")
    all_nodes = conn.execute("SELECT entity FROM entity_nodes").fetchall()
    type_updates = []
    for (entity,) in all_nodes:
        etype = classify_canonical(entity)
        if etype != 'OTHER':
            type_updates.append((etype, entity))

    if type_updates:
        conn.executemany(
            "UPDATE entity_nodes SET entity_type = ? WHERE entity = ?",
            type_updates
        )
        conn.commit()
        print(f"  Classified {len(type_updates)} entities (out of {n_nodes})")

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
    # Re-derive txn_type now that types are finalized
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
