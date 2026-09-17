"""
Whole-tool QC audit — data, accuracy against the documents, integrity, ops.
--------------------------------------------------------------------------
READ-ONLY. Writes nothing to the database. Produces qc_data.json and
qc_data.md in the output directory given on the command line.

Every check records a severity so the report can be read top-down:
  FAIL  wrong data a reader would act on, or something broken
  WARN  a gap, a risk, or a number worth knowing before quoting the tool
  OK    checked and fine
  INFO  context, no judgement

Accuracy is measured against the recorded documents themselves, downloaded and
OCR'd for a stratified sample, and judged by plain text rules that never look at
the AI extraction — the extraction is one of the things being audited, so it
cannot also be the reference. Where a rule cannot decide, the document is
counted as undetermined, never guessed.

Built 2026-09-17 for the owner's QC before the weekend fix run.

    AMO_DB_PATH=... python3 -u collector/qc/qc_audit.py OUT_DIR [--sample-scale 1.0]
"""
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import zlib
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.dirname(HERE)
sys.path.insert(0, COLLECTOR)
from extract_pdfs import (  # noqa: E402
    get_conn, download_pdf, ocr_pdf, _CAT_PLEDGE, _CAT_RENTS_BODY,
)
from normalize import canonicalize  # noqa: E402

random.seed(20260917)
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/qc'
SCALE = float(sys.argv[sys.argv.index('--sample-scale') + 1]) if '--sample-scale' in sys.argv else 1.0
os.makedirs(OUT, exist_ok=True)

conn = get_conn()
q = lambda s, *a: conn.execute(s, a).fetchall()
one = lambda s, *a: conn.execute(s, a).fetchone()[0]

report: list[dict] = []


def add(section, check, severity, summary, detail=None, numbers=None):
    report.append({'section': section, 'check': check, 'severity': severity,
                   'summary': summary, 'detail': detail or [], 'numbers': numbers or {}})
    print(f'[{severity:<4}] {section} :: {check} — {summary}', flush=True)


def pct(a, b):
    return f'{a * 100 / b:.1f}%' if b else 'n/a'


TODAY = dt.date.today()

# ═════════════════════════════════════════════════════════════════════════════
# A. FRESHNESS AND COLLECTION COMPLETENESS
# ═════════════════════════════════════════════════════════════════════════════
S = 'A. Freshness & completeness'
for county, mx, n in q("SELECT COALESCE(county,'MIAMI-DADE'), MAX(rec_date), COUNT(*) FROM assignments GROUP BY 1"):
    age = (TODAY - dt.date.fromisoformat(mx)).days
    limit = 9 if county == 'MIAMI-DADE' else 5      # MD collected weekly, Broward daily
    add(S, f'latest filing — {county}', 'OK' if age <= limit else 'WARN',
        f'latest recorded date {mx} ({age} days ago), {n:,} filings indexed',
        numbers={'latest': mx, 'age_days': age})

# US federal holidays + day after Thanksgiving, 2023-2026. Good Friday listed
# separately: clerk closure on it is not confirmed.
HOL = {
    '2023-01-02', '2023-01-16', '2023-02-20', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04',
    '2023-10-09', '2023-11-10', '2023-11-23', '2023-11-24', '2023-12-25',
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02',
    '2024-10-14', '2024-11-11', '2024-11-28', '2024-11-29', '2024-12-25',
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
    '2025-10-13', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
    '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25',
}
GOOD_FRIDAY = {'2023-04-07', '2024-03-29', '2025-04-18', '2026-04-03'}
days = {d for (d,) in q("""SELECT DISTINCT rec_date FROM assignments
                           WHERE COALESCE(county,'MIAMI-DADE')='MIAMI-DADE' AND rec_date >= '2023-01-03'""")}
mx_md = max(days)
missing, goodfri = [], []
d = dt.date(2023, 1, 3)
while d.isoformat() <= mx_md:
    s = d.isoformat()
    if d.weekday() < 5 and s not in HOL and s not in days:
        (goodfri if s in GOOD_FRIDAY else missing).append(s)
    d += dt.timedelta(days=1)
add(S, 'Miami-Dade business days with zero filings', 'WARN' if missing else 'OK',
    f'{len(missing)} business day(s) with no filings at all (holidays excluded); '
    f'{len(goodfri)} more on Good Friday', detail=missing[:60], numbers={'days': missing})

cols = [r[1] for r in q("PRAGMA table_info(collection_log)")]
if cols:
    st = dict(q("SELECT status, COUNT(*) FROM collection_log GROUP BY 1"))
    add(S, 'collection log statuses', 'INFO', ', '.join(f'{k} {v}' for k, v in st.items()), numbers=st)
    capped = q("""SELECT doc_type, date_from FROM collection_log WHERE status='CAPPED'
                  ORDER BY date_from DESC""")
    held = []
    for dtype, f in capped:
        n = one("SELECT COUNT(DISTINCT cfn) FROM assignments WHERE rec_date=? AND doc_type=?", f, dtype)
        held.append(f'{f} {dtype}: {n} filings held')
    avg = one("""SELECT AVG(n) FROM (SELECT rec_date, COUNT(DISTINCT cfn) n FROM assignments
                 WHERE doc_type='ASSIGNMENT OF MORTGAGE - AMO' AND rec_date>='2025-01-01' GROUP BY 1)""") or 0
    add(S, 'truncated collection days (CAPPED)', 'FAIL' if capped else 'OK',
        f'{len(capped)} day(s) hit the portal result cap, so filings beyond it are missing; '
        f'a normal AMO day holds ~{avg:.0f}', detail=held)
    errs = q("SELECT doc_type, date_from, date_to FROM collection_log WHERE status='ERROR'")
    real = []
    for dtype, f, t in errs:
        if not f:
            continue
        a = dt.date.fromisoformat(f)
        b = dt.date.fromisoformat(t or f)
        while a <= b:
            s = a.isoformat()
            if a.weekday() < 5 and s not in HOL and s not in GOOD_FRIDAY:
                if one("SELECT COUNT(*) FROM assignments WHERE rec_date=? AND doc_type=?", s, dtype) == 0:
                    real.append(f'{s} {dtype}')
            a += dt.timedelta(days=1)
    add(S, 'collection errors on real business days never recovered', 'WARN' if real else 'OK',
        f'{len(real)} business-day/doc-type window(s) errored and hold zero filings '
        f'(of {len(errs)} error windows; the rest are weekends/holidays)', detail=sorted(set(real))[:60])

# ═════════════════════════════════════════════════════════════════════════════
# B. EXTRACTION PIPELINE
# ═════════════════════════════════════════════════════════════════════════════
S = 'B. Extraction pipeline'
for county, total, read in q("""
    SELECT COALESCE(a.county,'MIAMI-DADE'), COUNT(DISTINCT a.cfn),
           COUNT(DISTINCT CASE WHEN px.cfn IS NOT NULL THEN a.cfn END)
    FROM assignments a LEFT JOIN pdf_extractions px ON px.cfn=a.cfn AND px.status='OK'
    WHERE a.doc_type != 'FINANCING STATEMENT UCC - FST' GROUP BY 1"""):
    sev = 'OK' if read / max(total, 1) > 0.97 else ('WARN' if county == 'BROWARD' else 'FAIL')
    add(S, f'assignment documents read — {county}', sev,
        f'{read:,} of {total:,} read ({pct(read, total)}); {total - read:,} indexed but never read',
        numbers={'total': total, 'read': read})
unread_recent = q("""
    SELECT SUBSTR(a.rec_date,1,7), COUNT(DISTINCT a.cfn) FROM assignments a
    LEFT JOIN pdf_extractions px ON px.cfn=a.cfn AND px.status='OK'
    WHERE COALESCE(a.county,'MIAMI-DADE')='MIAMI-DADE' AND px.cfn IS NULL
      AND a.doc_type != 'FINANCING STATEMENT UCC - FST' AND a.rec_date >= date('now','-120 day')
    GROUP BY 1 ORDER BY 1""")
add(S, 'Miami-Dade unread documents, last 4 months', 'WARN' if sum(n for _, n in unread_recent) > 200 else 'OK',
    ', '.join(f'{m}: {n}' for m, n in unread_recent) or 'none')
st = dict(q("SELECT COALESCE(status,'?'), COUNT(*) FROM pdf_extractions GROUP BY 1"))
add(S, 'extraction statuses', 'WARN' if st.get('LLM_ERROR', 0) + st.get('ERROR', 0) > 500 else 'INFO',
    ', '.join(f'{k} {v:,}' for k, v in st.items()), numbers=st)
try:
    bj = dict(q("SELECT status, COUNT(*) FROM batch_jobs GROUP BY 1"))
    tail = subprocess.run(['bash', '-c', "grep -E '^Done\\.' /opt/amo-dashboard/collector/batch/tick.log | tail -36"],
                          capture_output=True, text=True).stdout.strip().splitlines()
    stuck = [l for l in tail if re.search(r'Done\. 0 requests written', l)]
    last_ingest = one("SELECT MAX(rec_date) FROM credit_facility_events")
    add(S, 'lending-relationship background reader (facility tick)',
        'FAIL' if tail and len(stuck) == len(tail) else 'OK',
        f'last {len(tail)} runs: {len(stuck)} processed nothing (every download timing out); '
        f'batch jobs {bj}; newest facility filing {last_ingest}', detail=tail[-3:])
except Exception as e:                                               # noqa: BLE001
    add(S, 'facility tick', 'WARN', f'could not inspect: {e}')

# ═════════════════════════════════════════════════════════════════════════════
# F. INTEGRITY (cheap, before the slow document sampling)
# ═════════════════════════════════════════════════════════════════════════════
S = 'F. Data integrity'
dup = one("SELECT COUNT(*) - COUNT(DISTINCT cfn) FROM aom_events_clean")
both = one("SELECT COUNT(*) FROM aom_events_clean c JOIN aom_events_nonloan n ON n.cfn=c.cfn")
add(S, 'duplicate or double-counted filings', 'OK' if dup == 0 and both == 0 else 'FAIL',
    f'{dup} duplicate CFN rows; {both} filings in both loan and non-loan tables')
nul = one("SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon IS NULL OR assignee_canon IS NULL OR assignor_canon='UNKNOWN' OR assignee_canon='UNKNOWN'")
add(S, 'transfers with an unknown party', 'WARN' if nul > 100 else 'OK', f'{nul:,} rows')
same = one("SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon = assignee_canon AND txn_type != 'SELF_ASSIGN'")
add(S, 'same company both sides but not marked self-assign', 'WARN' if same else 'OK', f'{same:,} rows')
future = one("SELECT COUNT(*) FROM aom_events_clean WHERE rec_date > date('now')")
add(S, 'future-dated filings', 'FAIL' if future else 'OK', f'{future} rows')
mix = dict(q("SELECT txn_type, COUNT(*) FROM aom_events_clean GROUP BY 1"))
add(S, 'transaction mix', 'INFO', ', '.join(f'{k} {v:,}' for k, v in sorted(mix.items(), key=lambda x: -x[1])), numbers=mix)
tot = one("SELECT COUNT(*) FROM aom_events_clean")
nonloan = dict(q("SELECT doc_category, COUNT(*) FROM aom_events_nonloan GROUP BY 1"))
add(S, 'row counts', 'INFO', f'loan transfers {tot:,}; non-loan {nonloan}', numbers={'clean': tot, 'nonloan': nonloan})

# ═════════════════════════════════════════════════════════════════════════════
# D. ENTITIES AND CLASSIFICATION
# ═════════════════════════════════════════════════════════════════════════════
S = 'D. Entities & classification'
mers_types = dict(q("SELECT assignor_type, COUNT(*) FROM aom_events_clean WHERE assignor_canon='MERS' GROUP BY 1"))
mers_mt = one("SELECT COUNT(*) FROM aom_events_clean WHERE assignor_canon='MERS' AND txn_type='MARKET_TRANSFER'")
add(S, 'MERS counted as a market seller', 'FAIL' if mers_mt > 100 else 'OK',
    f'MERS typed {mers_types}; {mers_mt:,} MERS filings counted as MARKET_TRANSFER; '
    f'MERS_RELEASE fires {mix.get("MERS_RELEASE", 0)} times')
other_big = q("""SELECT e, SUM(n) FROM (
      SELECT assignor_canon e, COUNT(*) n FROM aom_events_clean WHERE assignor_type='OTHER' GROUP BY 1
      UNION ALL SELECT assignee_canon, COUNT(*) FROM aom_events_clean WHERE assignee_type='OTHER' GROUP BY 1)
    GROUP BY e ORDER BY 2 DESC LIMIT 40""")
inst_like = [(e, n) for e, n in other_big if e and
             re.search(r'BANK|TRUST|MORTGAGE|LOAN|CAPITAL|FUND|FINANC|SERVIC|LENDING|CREDIT', e)]
add(S, 'institutions typed OTHER (unclassified)', 'WARN' if inst_like else 'OK',
    f'{len(inst_like)} of the 40 largest OTHER-typed names look like institutions',
    detail=[f'{n:>5}  {e}' for e, n in inst_like[:25]])
top = q("""SELECT e, SUM(n) FROM (
      SELECT assignor_canon e, COUNT(*) n FROM aom_events_clean GROUP BY 1
      UNION ALL SELECT assignee_canon, COUNT(*) FROM aom_events_clean GROUP BY 1)
    GROUP BY e ORDER BY 2 DESC LIMIT 400""")
import difflib  # noqa: E402
key = lambda s: re.sub(r'[^A-Z]', '', s.upper())
names = [(e, n) for e, n in top if e and e != 'UNKNOWN']
pairs = []
for i, (a, na) in enumerate(names):
    ka = key(a)
    for b, nb in names[i + 1:]:
        kb = key(b)
        if len(ka) >= 6 and len(kb) >= 6 and ka != kb and difflib.SequenceMatcher(None, ka, kb).ratio() >= 0.9:
            pairs.append((na + nb, a, na, b, nb))
pairs.sort(reverse=True)
add(S, 'one company split across several names (top 400)', 'WARN' if pairs else 'OK',
    f'{len(pairs)} near-duplicate name pairs (some are genuinely different entities — review)',
    detail=[f'{a} ({na}) ~ {b} ({nb})' for _, a, na, b, nb in pairs[:30]])
conflict = q("""SELECT e, COUNT(DISTINCT t) FROM (
      SELECT assignor_canon e, assignor_type t FROM aom_events_clean
      UNION ALL SELECT assignee_canon, assignee_type FROM aom_events_clean)
    GROUP BY e HAVING COUNT(DISTINCT t) > 1 ORDER BY 2 DESC LIMIT 20""")
add(S, 'same company typed differently on the two sides', 'WARN' if conflict else 'OK',
    f'{len(conflict)} companies carry more than one type', detail=[e for e, _ in conflict])

# ═════════════════════════════════════════════════════════════════════════════
# E. MONEY
# ═════════════════════════════════════════════════════════════════════════════
S = 'E. Dollar amounts'
cover = one("SELECT COUNT(*) FROM aom_events_clean WHERE loan_amount > 0")
add(S, 'loan amount coverage', 'INFO', f'{cover:,} of {tot:,} transfers state an amount ({pct(cover, tot)}); '
    'blanks verified genuine on 17 Sep (40/40 documents state none)')
tiny = q("SELECT cfn, loan_amount FROM aom_events_clean WHERE loan_amount > 0 AND loan_amount < 1000")
add(S, 'implausibly small loan amounts (< $1,000)', 'WARN' if tiny else 'OK', f'{len(tiny)} rows',
    detail=[f'{c} ${a:,.0f}' for c, a in tiny[:20]])
huge = q("""SELECT loan_amount, COUNT(*), MIN(rec_date), MIN(assignor_canon) FROM aom_events_clean
            WHERE loan_amount > 1000000000 GROUP BY 1 ORDER BY 1 DESC""")
add(S, 'loans over $1B (verify each is real)', 'INFO', f'{len(huge)} distinct amounts',
    detail=[f'${a:,.0f} × {n} filings, {d}, {s}' for a, n, d, s in huge])

# ═════════════════════════════════════════════════════════════════════════════
# C. ACCURACY AGAINST THE DOCUMENTS
# ═════════════════════════════════════════════════════════════════════════════
S = 'C. Accuracy vs documents'
STOP = {'BANK', 'NA', 'N', 'A', 'LLC', 'L', 'C', 'INC', 'CORP', 'CORPORATION', 'COMPANY', 'CO', 'TRUST', 'TRU',
        'NATIONAL', 'ASSOCIATION', 'THE', 'OF', 'AND', 'FSB', 'LP', 'LTD', 'MORTGAGE', 'MTG', 'FUND', 'AS',
        'TRUSTEE', 'FOR', 'SERVICES', 'SERVICING', 'LOAN', 'LOANS', 'FINANCIAL', 'HOME', 'CAPITAL', 'FIRST',
        'AMERICAN', 'FEDERAL', 'GROUP', 'HOLDINGS', 'SAVINGS', 'SOCIETY', 'NOT', 'ITS', 'INDIVIDUAL',
        'CAPACITY', 'BUT', 'SOLELY', 'OWNER', 'SERIES', 'LENDING', 'LENDER'}
ALIASES = [
    (r'FEDERAL NATIONAL MORTGAGE|FANNIE', r'FEDERAL\s+NATIONAL\s+MORTGAGE|FANNIE\s+MAE'),
    (r'FEDERAL HOME LOAN MORTGAGE|FREDDIE', r'FEDERAL\s+HOME\s+LOAN\s+MORTGAGE|FREDDIE\s+MAC'),
    (r'MORTGAGE ELECTRONIC|^\s*MERS\b', r'MORTGAGE\s+ELECTRONIC|\bMERS\b'),
    (r'^\s*U\s*S\s+BANK|^\s*US\s+BANK', r'U\.?\s*S\.?\s*BANK'),
    (r'J\s*P\s*MORGAN|JPMORGAN', r'J\.?\s*P\.?\s*MORGAN'),
    (r'FEDERAL DEPOSIT', r'FEDERAL\s+DEPOSIT'),
    (r'SECRETARY OF HOUSING|HOUSING AND URBAN', r'SECRETARY\s+OF\s+HOUSING|HOUSING\s+AND\s+URBAN'),
]


def name_regex(raw):
    """Distinctive tokens of a name, in order, allowing up to 3 words between —
    the 17 Sep version required them adjacent and missed 'Alto CAPITAL Holdings'."""
    if not raw:
        return None
    s = re.sub(r'[^A-Z0-9 ]', ' ', raw.upper())
    for trigger, pat in ALIASES:
        if re.search(trigger, s):
            return re.compile(pat, re.I)
    toks = [t for t in s.split() if len(t) >= 3 and t not in STOP][:3]
    if not toks:
        return None
    if len(toks) == 1 and len(toks[0]) < 5:
        return None                      # one short word matches too much text
    return re.compile(r'\b' + r'(?:\W+\w+){0,3}?\W+'.join(re.escape(t) for t in toks) + r'\b', re.I)


VERB = re.compile(r'\b(assign|assigns|convey|conveys|transfer|transfers|sell|sells|set\s+over)\b'
                  r'[^.;]{0,260}?\b(to|unto)\b', re.I)
LABEL = re.compile(r'\b(assignor|assignee)\b', re.I)


def nearest_before(text, pos, pats, window=400):
    seg, best = text[max(0, pos - window):pos], None
    for key_, p in pats.items():
        for m in p.finditer(seg):
            if best is None or m.end() > best[1]:
                best = (key_, m.end())
    return best[0] if best else None


def first_after(text, pos, pats, window=260):
    seg, best = text[pos:pos + window], None
    for key_, p in pats.items():
        m = p.search(seg)
        if m and (best is None or m.start() < best[1]):
            best = (key_, m.start())
    return best[0] if best else None


def doc_assignor(text, pats):
    """Which name the DOCUMENT makes the assignor, by text position only."""
    votes = []
    for m in VERB.finditer(text):
        a, b = nearest_before(text, m.start(), pats), first_after(text, m.end(), pats)
        if a and b and a != b:
            votes.append(a)
            break
    for m in LABEL.finditer(text):
        if m.group(1).lower() == 'assignor':
            who = nearest_before(text, m.start(), pats, 300)
            if who:
                votes.append(who)
            break
    return votes[0] if votes and len(set(votes)) == 1 else None


def bucket(r):
    ca, cb, a, b = canonicalize(r['pdf_assignor']), canonicalize(r['pdf_assignee']), r['assignor_canon'], r['assignee_canon']
    if ca == a and cb == b: return 'D1 same order'
    if ca == b and cb == a: return 'D3 exact reverse'
    if ca == b or cb == a: return 'D4 reverse, a name varies'
    if ca == a or cb == b: return 'D2 same order, a name varies'
    return 'D5 names do not match'


rows = [dict(zip(['cfn', 'rec_date', 'assignor', 'assignee', 'assignor_canon', 'assignee_canon', 'pdf_assignor',
                  'pdf_assignee', 'loan_amount', 'property_address', 'book', 'page', 'doc_title'], r)) for r in q("""
    SELECT c.cfn, c.rec_date, c.assignor, c.assignee, c.assignor_canon, c.assignee_canon, c.pdf_assignor,
           c.pdf_assignee, c.loan_amount, c.property_address, MAX(a.rec_book), MAX(a.rec_page), c.doc_title
    FROM aom_events_clean c JOIN assignments a ON a.cfn=c.cfn
    WHERE COALESCE(c.county,'MIAMI-DADE')='MIAMI-DADE' AND c.pdf_assignor IS NOT NULL AND c.pdf_assignee IS NOT NULL
      AND c.txn_type != 'SELF_ASSIGN' AND a.rec_book IS NOT NULL AND a.rec_book != ''
    GROUP BY c.cfn""")]
by_bucket = defaultdict(list)
for r in rows:
    by_bucket[bucket(r)].append(r)
SIZES = {'D1 same order': 20, 'D2 same order, a name varies': 25, 'D3 exact reverse': 20,
         'D4 reverse, a name varies': 25, 'D5 names do not match': 30}
sample = []
for b, n in SIZES.items():
    for r in random.sample(by_bucket[b], min(int(n * SCALE), len(by_bucket[b]))):
        sample.append(('direction', b, r))
cat_rows = [dict(zip(['cfn', 'doc_category', 'doc_title', 'book', 'page'], r)) for r in q("""
    SELECT n.cfn, n.doc_category, n.doc_title, MAX(a.rec_book), MAX(a.rec_page) FROM aom_events_nonloan n
    JOIN assignments a ON a.cfn=n.cfn
    WHERE COALESCE(n.county,'MIAMI-DADE')='MIAMI-DADE' AND a.rec_book IS NOT NULL AND a.rec_book != ''
    GROUP BY n.cfn""")]
cat_by = defaultdict(list)
for r in cat_rows:
    cat_by[r['doc_category']].append(r)
for cat, n in (('COLLATERAL', 20), ('RENTS_LEASES', 15), ('OTHER', 15)):
    for r in random.sample(cat_by[cat], min(int(n * SCALE), len(cat_by[cat]))):
        sample.append(('category', cat, r))
add(S, 'sample drawn', 'INFO', f'{len(sample)} documents; population by direction bucket: '
    + ', '.join(f'{b} {len(v):,}' for b, v in sorted(by_bucket.items())))


def fetch(item):
    kind, b, r = item
    try:
        with tempfile.TemporaryDirectory() as wd:
            p = os.path.join(wd, 'd.pdf')
            if not download_pdf(r['book'], r['page'], p):
                return item, None
            return item, ' '.join((ocr_pdf(p, wd) or '').split())
    except Exception:                                                # noqa: BLE001
        return item, None


results = defaultdict(Counter)
examples = defaultdict(list)
cat_res = defaultdict(Counter)
amount_res, prop_res = Counter(), Counter()
CONVEY = re.compile(r'without\s+recourse|set\s+over|all\s+(?:its\s+)?right,?\s+title\s+and\s+interest|'
                    r'grant,?\s+bargain,?\s+sell|does\s+hereby\s+(?:grant|assign|transfer|convey)', re.I)
with ThreadPoolExecutor(max_workers=6) as pool:
    for (kind, b, r), text in pool.map(fetch, sample):
        if not text or len(text) < 200:
            (results[b] if kind == 'direction' else cat_res[b])['unreadable document'] += 1
            continue
        if kind == 'direction':
            pats = {k: p for k, p in {
                'IDX_A': name_regex(r['assignor']), 'IDX_B': name_regex(r['assignee']),
                'AI_A': name_regex(r['pdf_assignor']), 'AI_B': name_regex(r['pdf_assignee'])}.items() if p}
            who = doc_assignor(text, pats)
            side = ai = None
            if who:
                # The name the document places as assignor, as a canonical
                # identity — then compared, separately, to the table and to the AI.
                raw = {'IDX_A': r['assignor'], 'IDX_B': r['assignee'],
                       'AI_A': r['pdf_assignor'], 'AI_B': r['pdf_assignee']}[who]
                doc_seller = canonicalize(raw)
                side = ('TABLE_SELLER' if doc_seller == r['assignor_canon'] else
                        'TABLE_BUYER' if doc_seller == r['assignee_canon'] else 'OTHER_PARTY')
                ai = ('agrees' if doc_seller == canonicalize(r['pdf_assignor']) else
                      'swapped' if doc_seller == canonicalize(r['pdf_assignee']) else None)
            verdict = {'TABLE_SELLER': 'document confirms table direction',
                       'TABLE_BUYER': 'document says table is REVERSED',
                       'OTHER_PARTY': 'document assignor is a different party than the table shows',
                       None: 'undetermined'}[side]
            results[b][verdict] += 1
            if ai == 'swapped':
                results[b]['AI extraction disagrees with document'] += 1
            # Examples worth a human look: anything that is not the bucket's expected outcome.
            expected = 'TABLE_BUYER' if b.startswith(('D3', 'D4')) else 'TABLE_SELLER'
            if side != expected and len(examples[b]) < 8:
                examples[b].append(f"{r['cfn']} [{verdict}] table {r['assignor_canon']} -> {r['assignee_canon']} | "
                                   f"AI {r['pdf_assignor']} -> {r['pdf_assignee']}")
            if r['loan_amount'] and r['loan_amount'] > 0:
                a = int(round(r['loan_amount']))
                found = f'{a:,}' in text or str(a) in text.replace(',', '')
                amount_res['amount found in document' if found else 'amount NOT found in document'] += 1
            if r['property_address']:
                num = re.match(r'\s*(\d+)', r['property_address'])
                word = [w for w in re.findall(r'[A-Za-z]{4,}', r['property_address'])
                        if w.upper() not in {'MIAMI', 'FLORIDA', 'DADE', 'COUNTY', 'BEACH', 'STREET', 'AVENUE'}][:1]
                if num and word:
                    ok = num.group(1) in text and re.search(re.escape(word[0]), text, re.I)
                    prop_res['property found in document' if ok else 'property NOT found in document'] += 1
        else:
            pledge, rents, convey = bool(_CAT_PLEDGE.search(text)), bool(_CAT_RENTS_BODY.search(text)), bool(CONVEY.search(text))
            title = (r['doc_title'] or '').upper()
            if b == 'COLLATERAL':
                ok = pledge or 'ASSESSMENT' in title
            elif b == 'RENTS_LEASES':
                ok = rents or bool(re.search(r'RENT|LEASE', title))
            else:
                ok = not (convey and re.search(r'MORTGAGE', title) and not pledge and not rents)
            cat_res[b]['text supports label' if ok else 'text does NOT support label'] += 1
            if not ok and len(examples[b]) < 6:
                examples[b].append(f"{r['cfn']}: {r['doc_title']}")

for b in SIZES:
    c = results[b]
    decided = sum(v for k, v in c.items() if k.startswith('document'))
    rev = c['document says table is REVERSED']
    other = c['document assignor is a different party than the table shows']
    ok_ = c['document confirms table direction']
    wrong = rev + other
    sev = 'FAIL' if decided and wrong / decided > 0.05 else 'OK'
    add(S, f'direction — {b} ({len(by_bucket[b]):,} rows)', sev,
        f'{sum(c.values()) - c["AI extraction disagrees with document"]} read: {ok_} confirmed, {rev} reversed, '
        f'{other} different party, {c["undetermined"]} undetermined, {c["unreadable document"]} unreadable; '
        f'AI extraction disagreed with the document {c["AI extraction disagrees with document"]} time(s)',
        detail=examples[b], numbers=dict(c))
for b in ('COLLATERAL', 'RENTS_LEASES', 'OTHER'):
    c = cat_res[b]
    bad = c['text does NOT support label']
    add(S, f'document type — {b}', 'WARN' if bad > 2 else 'OK',
        f'{c["text supports label"]} supported, {bad} not supported, {c["unreadable document"]} unreadable',
        detail=examples[b], numbers=dict(c))
add(S, 'loan amount matches document', 'OK' if amount_res['amount NOT found in document'] <= 1 else 'WARN',
    ', '.join(f'{k} {v}' for k, v in amount_res.items()), numbers=dict(amount_res))
add(S, 'property address matches document', 'OK' if prop_res['property NOT found in document'] <= 2 else 'WARN',
    ', '.join(f'{k} {v}' for k, v in prop_res.items()), numbers=dict(prop_res))

# ═════════════════════════════════════════════════════════════════════════════
# I. OPERATIONS
# ═════════════════════════════════════════════════════════════════════════════
S = 'I. Operations'


def sh(cmd):
    return subprocess.run(['bash', '-c', cmd], capture_output=True, text=True).stdout.strip()


for label, cmd, ok_pat in [
    ('weekly collection (Fridays)', "grep -E '^(Started|Completed):' /opt/amo-dashboard/collector/cron.log | tail -2", r'Completed'),
    ('nightly rebuild', "grep 'nightly normalize done' /opt/amo-dashboard/collector/batch/normalize_nightly.log | tail -1", r'done'),
    ('Broward daily', "grep 'broward daily done' /opt/amo-dashboard/collector/broward_daily.log | tail -1", r'status=ok'),
    ('offsite backup', "grep 'backup done' /opt/amo-dashboard/collector/backup.log | tail -1", r'status=ok'),
]:
    out = sh(cmd)
    add(S, label, 'OK' if re.search(ok_pat, out) else 'WARN', out.replace('\n', ' | ') or 'no log line found')
env_perm = sh("stat -c %a /opt/amo-dashboard/.env")
add(S, '.env permissions', 'OK' if env_perm == '600' else 'FAIL', f'mode {env_perm}')
remote = sh("cd /opt/amo-dashboard && git remote -v | head -1")
add(S, 'credentials in git remote URL', 'FAIL' if re.search(r'//[^/@\s]+@', remote) else 'OK',
    'present' if re.search(r'//[^/@\s]+@', remote) else 'none (GitHub-side token revocation cannot be verified from here)')
disk = sh("df -h / | tail -1 | awk '{print $5\" used, \"$4\" free\"}'")
stale = sh("ls -1 /opt/amo-dashboard/*.db | grep -v miami_dade_amo.db | wc -l; du -ch $(ls /opt/amo-dashboard/*.db | grep -v miami_dade_amo.db) 2>/dev/null | tail -1")
add(S, 'disk', 'INFO', f'{disk}; old database copies in app folder: {stale.replace(chr(10), " totalling ")}')
pm = sh("pm2 jlist 2>/dev/null | python3 -c \"import sys,json;d=[p for p in json.load(sys.stdin) if p['name']=='amo-dashboard'][0];e=d['pm2_env'];print(e['status'],e['restart_time'],e.get('unstable_restarts'))\"")
add(S, 'web server (pm2)', 'OK' if pm.startswith('online') else 'FAIL', f'status/restarts/unstable: {pm}')
errs = sh("grep -c 'Internal Server Error' /root/.pm2/logs/amo-dashboard-error.log; stat -c %y /root/.pm2/logs/amo-dashboard-error.log | cut -c1-19")
add(S, 'server error log', 'INFO', errs.replace('\n', ' errors, last written '))
login500 = sh("grep -c \"destructure property 'password'\" /root/.pm2/logs/amo-dashboard-error.log")
add(S, 'login returns 500 on an empty request', 'WARN' if login500 not in ('', '0') else 'OK', f'{login500} occurrences')

json.dump(report, open(os.path.join(OUT, 'qc_data.json'), 'w'), indent=1, default=str)
order = {'FAIL': 0, 'WARN': 1, 'OK': 2, 'INFO': 3}
with open(os.path.join(OUT, 'qc_data.md'), 'w') as f:
    counts = Counter(r['severity'] for r in report)
    f.write(f'# QC data audit — {dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC\n\n'
            f'FAIL {counts["FAIL"]} · WARN {counts["WARN"]} · OK {counts["OK"]} · INFO {counts["INFO"]}\n\n')
    for sec in sorted({r['section'] for r in report}):
        f.write(f'## {sec}\n\n')
        for r in sorted([x for x in report if x['section'] == sec], key=lambda x: order[x['severity']]):
            f.write(f'- **[{r["severity"]}] {r["check"]}** — {r["summary"]}\n')
            for d_ in r['detail'][:30]:
                f.write(f'    - {d_}\n')
        f.write('\n')
print(f'\nwrote {OUT}/qc_data.md', flush=True)
conn.close()
