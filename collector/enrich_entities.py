"""
Entity Enrichment Pipeline (LLM Fallback)
------------------------------------------
Runs AFTER normalize.py's multi-signal classification pipeline.
Only sends entities to OpenAI that couldn't be classified by:
  manual overrides → FDIC match → suffix signals → behavioral patterns → regex rules

Step 1 — Skip high-confidence classifications from normalize.py
Step 2 — gpt-4.1-nano for remaining entities typed OTHER with no confident source
Step 3 — Cache results in entity_classifications
Step 4 — Propagate to entity_nodes + aom_events_clean

Model is configurable via OPENAI_MODEL (default: gpt-4.1-nano).
"""
import sqlite3
import os
import time
import json
import re
import sys
import requests

DB           = os.environ.get('AMO_DB_PATH', '/opt/amo-dashboard/miami_dade_amo.db')
OPENAI_KEY   = os.environ.get('OPENAI_API_KEY', '')
OPENAI_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4.1-nano')
OPENAI_URL   = 'https://api.openai.com/v1/chat/completions'
MIN_VOL    = 1      # lowered: classify all entities (signals handle confidence)
BATCH_SIZE = 60     # names per request

VALID_TYPES = {'BANK', 'SERVICER', 'PRIVATE_CREDIT', 'GSE', 'MERS', 'TRUST', 'OTHER'}

# High-confidence sources that the LLM should NOT override
HIGH_CONFIDENCE_SOURCES = {'manual_override', 'fdic_match', 'suffix_gse', 'suffix_banking', 'suffix_trust_name'}

MERS_PATTERN = re.compile(r'^MERS$|MORTGAGE ELECTRONIC', re.IGNORECASE)
GSE_PATTERN = re.compile(
    r'FANNIE MAE|FREDDIE MAC|GINNIE MAE|FHLMC|FNMA|GNMA|'
    r'SECRETARY OF HOUSING|DEPT\.? OF HOUSING|\bHUD\b|'
    r'FEDERAL HOUSING ADMIN|FEDERAL HOME LOAN BANK|'
    r'VETERANS AFFAIRS|\bFDIC\b|FEDERAL DEPOSIT INSURANCE',
    re.IGNORECASE
)


def rule_classify(name: str) -> str | None:
    """Quick rule check for MERS and GSE — used as pre-filter before LLM."""
    if MERS_PATTERN.search(name):
        return 'MERS'
    if GSE_PATTERN.search(name):
        return 'GSE'
    return None


# ── Claude batch classification ───────────────────────────────────────────────
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
- Respond ONLY with a valid JSON object: {"results": [{"name":"...","type":"BANK"}, ...]}
- No explanation, no markdown fences, no extra text — only the JSON object."""


def llm_classify_batch(names: list[str]) -> dict[str, str]:
    """Send up to BATCH_SIZE names to OpenAI; return {name: type}."""
    if not OPENAI_KEY:
        print("  [WARN] OPENAI_API_KEY not set — skipping LLM")
        return {}
    raw = ''
    try:
        resp = requests.post(
            OPENAI_URL,
            headers={
                'Authorization': f'Bearer {OPENAI_KEY}',
                'Content-Type': 'application/json',
            },
            json={
                'model': OPENAI_MODEL,
                'max_tokens': 4096,
                'temperature': 0,
                'response_format': {'type': 'json_object'},
                'messages': [
                    {'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user',   'content': '\n'.join(names)},
                ],
            },
            timeout=90,
        )
        resp.raise_for_status()
        raw = resp.json()['choices'][0]['message']['content']
        parsed = json.loads(raw)
        items = parsed.get('results', [])
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

    # Ensure confidence_source column exists
    try:
        conn.execute("ALTER TABLE entity_classifications ADD COLUMN confidence_source TEXT")
    except Exception:
        pass

    # Identify entities that still need LLM classification:
    # - Not already classified by a high-confidence source
    # - Currently typed OTHER or not yet cached
    if force_reclassify:
        # Re-classify everything that isn't high-confidence
        candidates = conn.execute("""
            SELECT en.entity, en.total_vol
            FROM entity_nodes en
            LEFT JOIN entity_classifications ec ON en.entity = ec.name
            WHERE en.total_vol >= ?
              AND COALESCE(ec.confidence_source, 'default') NOT IN (?, ?, ?, ?, ?)
            ORDER BY en.total_vol DESC
        """, (MIN_VOL, *HIGH_CONFIDENCE_SOURCES)).fetchall()
    else:
        # Only classify entities still at OTHER/default that haven't had LLM run
        candidates = conn.execute("""
            SELECT en.entity, en.total_vol
            FROM entity_nodes en
            LEFT JOIN entity_classifications ec ON en.entity = ec.name
            WHERE en.total_vol >= ?
              AND COALESCE(ec.confidence_source, 'default') IN ('default', 'regex_rule')
              AND COALESCE(ec.category, 'OTHER') = 'OTHER'
            ORDER BY en.total_vol DESC
        """, (MIN_VOL,)).fetchall()

    # Also pick up entities not yet in the cache at all
    uncached = conn.execute("""
        SELECT en.entity, en.total_vol
        FROM entity_nodes en
        LEFT JOIN entity_classifications ec ON en.entity = ec.name
        WHERE ec.name IS NULL AND en.total_vol >= ?
        ORDER BY en.total_vol DESC
    """, (MIN_VOL,)).fetchall()

    to_classify = list({e: v for e, v in candidates + uncached}.items())
    high_conf_count = conn.execute(
        "SELECT COUNT(*) FROM entity_classifications WHERE confidence_source IN (?, ?, ?, ?, ?)",
        tuple(HIGH_CONFIDENCE_SOURCES)
    ).fetchone()[0]

    print(f"Entities for LLM pass: {len(to_classify)}  (skipping {high_conf_count} high-confidence)")

    results: dict[str, str] = {}

    # ── Pass 1: fast rules (MERS/GSE only — other rules already ran in normalize) ─
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
    print(f"  Sending {len(batches)} batches to {OPENAI_MODEL}...")

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

    # ── Write cache with confidence_source ───────────────────────────────────
    print(f"\nCaching {len(results)} classifications...")
    llm_set = set(llm_queue)
    cache_rows = [(name, etype, 'llm' if name in llm_set else 'regex_rule')
                  for name, etype in results.items()]

    conn.executemany("""
        INSERT INTO entity_classifications (name, category, confidence_source)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET category = excluded.category,
                                        confidence_source = excluded.confidence_source
    """, cache_rows)
    conn.commit()

    # ── Update entity_nodes (including OTHER results from LLM) ────────────
    print("Updating entity_nodes...")
    conn.executemany(
        "UPDATE entity_nodes SET entity_type = ? WHERE entity = ?",
        [(t, n) for n, t in results.items()]
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
