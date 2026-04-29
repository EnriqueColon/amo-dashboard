"""
Entity Enrichment Pipeline
--------------------------
Step 1 — Rule-based     : instant classification for GSEs and MERS
Step 2 — GPT-4o-mini    : batch-classifies remaining entities by canonical name
Step 3 — entity_classifications cache : persists across future normalize runs
Step 4 — Propagate      : updates entity_nodes + aom_events_clean

Run after normalize.py. Safe to re-run — skips already-cached entities.
"""
import sqlite3
import os
import time
import json
import re
import sys
import requests

DB         = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')
OPENAI_KEY = os.environ.get('OPENAI_API_KEY', '')
MIN_VOL    = 3      # skip entities with fewer total transactions
BATCH_SIZE = 60     # names per GPT request

VALID_TYPES = {'BANK', 'SERVICER', 'PRIVATE_CREDIT', 'GSE', 'MERS', 'TRUST', 'OTHER'}

# ── Fast rule-based pre-classification ────────────────────────────────────────
GSE_PATTERN = re.compile(
    r'FANNIE MAE|FREDDIE MAC|GINNIE MAE|FHLMC|FNMA|GNMA|'
    r'SECRETARY OF HOUSING|DEPT\.? OF HOUSING|\bHUD\b|'
    r'FEDERAL HOUSING ADMIN|FEDERAL HOME LOAN BANK|'
    r'VETERANS AFFAIRS|\bFDIC\b|FEDERAL DEPOSIT INSURANCE',
    re.IGNORECASE
)
MERS_PATTERN = re.compile(r'^MERS$|MORTGAGE ELECTRONIC', re.IGNORECASE)

# ── Manual overrides — corrections that the LLM gets wrong ────────────────────
# Applied BEFORE the LLM pass; these always win.
MANUAL_OVERRIDES: dict[str, str] = {
    # ── Securitization trusts / structured finance vehicles ──────────────────
    # These are PASSIVE pools of loans held in trust, not active investment firms.
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
    # ── Active private credit / asset managers ───────────────────────────────
    'KIAVI FUNDING':                'PRIVATE_CREDIT',
    'ANCHOR LOANS':                 'PRIVATE_CREDIT',
    'FIGURE LENDING':               'PRIVATE_CREDIT',
    'VELOCITY COMMERCIAL CAPITAL':  'PRIVATE_CREDIT',
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
    # ── Servicers ────────────────────────────────────────────────────────────
    'FINANCE OF AMERICA REVERSE':   'SERVICER',
    'PARAMOUNT RESIDENTIAL MORTGAGE': 'SERVICER',
    'PARAMOUNT RESIDENTIAL':          'SERVICER',
    'CITIMORTGAGE':                 'SERVICER',
    'COMPUTERSHARE TRUST':          'SERVICER',
    'AMERIHOME MORTGAGE':           'SERVICER',
    'PACIFIC UNION FINANCIAL':      'SERVICER',
    # New Residential Mortgage = servicing subsidiary of Rithm Capital, NOT the parent PE REIT
    'NEW RESIDENTIAL MORTGAGE':     'SERVICER',
    # Correspondent originators / mortgage banks
    'AMERICAN BANCSHARES MORTGAGE': 'SERVICER',
    # ── Banks ────────────────────────────────────────────────────────────────
    'EASTERN FINANCIAL MORTGAGE':   'BANK',
    'EASTERN FINANCIAL':            'BANK',
    'BRADESCO BANK':                'BANK',
    'BRADESCO':                     'BANK',
    'SPACE COAST CREDIT UNION':     'BANK',
    'DLJ MORTGAGE CAPITAL':         'BANK',
    'TRUIST BANK':                  'BANK',
    'MIDFIRST BANK':                'BANK',
    # Pacific Life = large institutional insurer (regulated, not PE)
    'PACIFIC LIFE INSURANCE':       'BANK',
    # ── Securitization trusts ────────────────────────────────────────────────
    'SALUDA GRADE MORTGAGE FUNDING': 'TRUST',
    # ── Private credit (active managers) ────────────────────────────────────
    # MTGLQ = Goldman Sachs NPL acquisition vehicle (confirmed PE/credit fund)
    'MTGLQ INVESTORS':              'PRIVATE_CREDIT',
    # Arixa Capital = private real estate bridge lender
    'ARIXA CAPITAL':                'PRIVATE_CREDIT',
    # Athene Annuity = Apollo-backed insurer / structured credit investor
    'ATHENE ANNUITY':               'PRIVATE_CREDIT',
}


def rule_classify(name: str) -> str | None:
    # Manual overrides win first
    upper = name.upper().strip()
    for key, val in MANUAL_OVERRIDES.items():
        if key in upper:
            return val
    if MERS_PATTERN.search(name):
        return 'MERS'
    if GSE_PATTERN.search(name):
        return 'GSE'
    return None


# ── GPT-4o-mini batch classification ──────────────────────────────────────────
SYSTEM_PROMPT = """You are an expert in US mortgage and real estate finance markets.
Classify each entity name as exactly one of:

  BANK           – commercial bank, savings bank, investment bank, trust company, credit union
  SERVICER       – mortgage servicer, loan servicer, mortgage originator / lender
  PRIVATE_CREDIT – private equity firm, hedge fund, ACTIVE asset manager, or REIT that invests in mortgage/real-estate debt
  GSE            – government-sponsored enterprise or federal agency (Fannie Mae, Freddie Mac, Ginnie Mae, HUD, FHA, VA, FDIC, SBA)
  MERS           – Mortgage Electronic Registration Systems ONLY
  TRUST          – securitization vehicle, mortgage loan trust, CLO, structured finance SPV, or resolution trust (e.g. "XYZ Loan Trust", "XYZ Mortgage Trust", "XYZ Opportunity Trust", "ABC Resolution Trust"). These are PASSIVE legal vehicles that hold pools of loans — they are NOT operating companies.
  OTHER          – individual person, small LLC, HOA, law firm, title company, local government, city/county, or truly cannot be determined

Classification rules:
- Names that look like a person (first + last name format) → OTHER
- Generic holding companies with no recognizable brand → OTHER
- "ASSETS MANAGEMENT" standalone → OTHER
- If a name contains "BANK" but is clearly a small local LLC → OTHER
- Any entity whose name ends in "LOAN TRUST", "MORTGAGE TRUST", "ASSET TRUST", or "RESOLUTION TRUST" → TRUST
- Respond ONLY with a valid JSON array: [{"name":"...","type":"BANK"}, ...]
- No explanation, no markdown fences, no extra text — only the JSON array."""


def llm_classify_batch(names: list[str]) -> dict[str, str]:
    """Send up to BATCH_SIZE names to GPT-4o-mini; return {name: type}."""
    if not OPENAI_KEY:
        print("  [WARN] OPENAI_API_KEY not set — skipping LLM")
        return {}
    try:
        resp = requests.post(
            'https://api.openai.com/v1/chat/completions',
            headers={
                'Authorization': f'Bearer {OPENAI_KEY}',
                'Content-Type': 'application/json',
            },
            json={
                'model': 'gpt-4o-mini',
                'temperature': 0,
                'messages': [
                    {'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user',   'content': '\n'.join(names)},
                ],
            },
            timeout=90,
        )
        resp.raise_for_status()
        raw = resp.json()['choices'][0]['message']['content'].strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        items = json.loads(raw)
        return {
            item['name']: item['type']
            for item in items
            if isinstance(item, dict) and item.get('type') in VALID_TYPES
        }
    except json.JSONDecodeError as e:
        print(f"  [WARN] JSON parse failed: {e} | raw={raw[:200]}")
        return {}
    except Exception as e:
        print(f"  [WARN] LLM batch error: {e}")
        return {}


# ── Main ──────────────────────────────────────────────────────────────────────
def enrich(force_reclassify: bool = False):
    conn = sqlite3.connect(DB)
    conn.execute('PRAGMA journal_mode=WAL')

    # Entities already in cache (skip unless --force flag)
    already: set[str] = set()
    if not force_reclassify:
        already = {
            row[0] for row in
            conn.execute("SELECT name FROM entity_classifications").fetchall()
        }

    # When forcing, apply manual overrides immediately to the cache and entity_nodes
    if force_reclassify:
        print("Force-reclassify mode: applying manual overrides to entire cache...")
        override_updates = []
        for row in conn.execute("SELECT name FROM entity_classifications").fetchall():
            name = row[0]
            for key, val in MANUAL_OVERRIDES.items():
                if key in name.upper():
                    override_updates.append((val, name))
                    break
        if override_updates:
            conn.executemany(
                "UPDATE entity_classifications SET category = ? WHERE name = ?",
                override_updates
            )
            conn.executemany(
                "UPDATE entity_nodes SET entity_type = ? WHERE entity = ?",
                override_updates
            )
            conn.commit()
            print(f"  Applied {len(override_updates)} override corrections")

    # Entities above volume threshold, sorted high→low so important ones go first
    candidates = conn.execute(
        "SELECT entity, total_vol FROM entity_nodes WHERE total_vol >= ? ORDER BY total_vol DESC",
        (MIN_VOL,)
    ).fetchall()

    to_classify = [(e, v) for e, v in candidates if e not in already]
    print(f"Entities to classify: {len(to_classify)}  (skipping {len(already)} already cached)")

    results: dict[str, str] = {}

    # ── Pass 1: fast rules ───────────────────────────────────────────────────
    llm_queue: list[str] = []
    for entity, _ in to_classify:
        t = rule_classify(entity)
        if t:
            results[entity] = t
        else:
            llm_queue.append(entity)
    print(f"  Rule-based: {len(results)} classified  |  LLM queue: {len(llm_queue)}")

    # ── Pass 2: LLM batches ──────────────────────────────────────────────────
    batches = [llm_queue[i:i+BATCH_SIZE] for i in range(0, len(llm_queue), BATCH_SIZE)]
    print(f"  Sending {len(batches)} batches to GPT-4o-mini...")

    for b_idx, batch in enumerate(batches):
        batch_result = llm_classify_batch(batch)
        results.update(batch_result)

        non_other = sum(1 for n in batch if results.get(n, 'OTHER') != 'OTHER')
        print(f"    [{b_idx+1:>2}/{len(batches)}] {non_other}/{len(batch)} non-OTHER", flush=True)

        if b_idx < len(batches) - 1:
            time.sleep(0.4)

    # Anything the LLM didn't return → OTHER
    for entity, _ in to_classify:
        results.setdefault(entity, 'OTHER')

    # ── Write cache ──────────────────────────────────────────────────────────
    print(f"\nCaching {len(results)} classifications...")
    conn.executemany(
        "INSERT OR REPLACE INTO entity_classifications (name, category) VALUES (?, ?)",
        list(results.items())
    )
    conn.commit()

    # ── Update entity_nodes ──────────────────────────────────────────────────
    print("Updating entity_nodes...")
    conn.executemany(
        "UPDATE entity_nodes SET entity_type = ? WHERE entity = ?",
        [(t, n) for n, t in results.items() if t != 'OTHER']
    )
    conn.commit()

    # ── Propagate to aom_events_clean + re-derive txn_type ───────────────────
    print("Propagating to aom_events_clean...")
    conn.execute("""
        UPDATE aom_events_clean
        SET
          assignor_type = COALESCE(
            (SELECT entity_type FROM entity_nodes WHERE entity = aom_events_clean.assignor_canon),
            'OTHER'
          ),
          assignee_type = COALESCE(
            (SELECT entity_type FROM entity_nodes WHERE entity = aom_events_clean.assignee_canon),
            'OTHER'
          )
    """)
    # Re-derive txn_type with finalized types
    if conn.execute("SELECT 1 FROM pragma_table_info('aom_events_clean') WHERE name='txn_type'").fetchone():
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

    # ── Summary ──────────────────────────────────────────────────────────────
    dist = conn.execute(
        "SELECT entity_type, COUNT(*) FROM entity_nodes GROUP BY entity_type ORDER BY 2 DESC"
    ).fetchall()
    print("\n=== Entity type distribution ===")
    for t, n in dist:
        bar = '█' * min(50, n // 5)
        print(f"  {t:<16} {n:>6}  {bar}")

    print("\nTop classified entities by volume:")
    for row in conn.execute(
        "SELECT entity, entity_type, total_vol FROM entity_nodes "
        "WHERE entity_type != 'OTHER' ORDER BY total_vol DESC LIMIT 25"
    ).fetchall():
        print(f"  {row[0]:<48} {row[1]:<16} vol={row[2]}")

    conn.close()
    print("\nEnrichment complete.")


if __name__ == '__main__':
    force = '--force' in sys.argv or '--force-reclassify' in sys.argv
    enrich(force_reclassify=force)
