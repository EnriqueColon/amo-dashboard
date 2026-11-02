#!/usr/bin/env python3
"""
Accuracy audit — every classification layer measured against the data it was
derived from. READ-ONLY: the database is opened with mode=ro, nothing is written
except the report files under --out.

Layers audited (one section each in the report):
  S1  population and coverage        rows read / unread / lost between tables
  S2  document category vs title     what the recorded title says is assigned
  S3  document category vs text      pledge / rents-security / transfer language (Miami-Dade, stored OCR)
  S4  direction                      index order vs document order, per county
  S5  parties                        person-shaped parties, missing document parties, self-assignments
  S6  entity types                   OTHER-typed lenders, BANK without FDIC match, behavioural/LLM verdicts
  S7  transaction type               what INTO_INSTITUTION / SELF_ASSIGN rows actually are
  S8  amounts                        outliers, echoes, amounts on non-loan instruments
  S9  addresses                      corporate addresses stored as the property
  S10 samples                        stratified CFNs for hand-reading (Tier C)

Run on the droplet:
    AMO_DB_PATH=/opt/amo-dashboard/miami_dade_amo.db \
      /opt/amo-dashboard/collector/.venv/bin/python3 accuracy_audit.py --out /tmp/audit
"""
import argparse
import csv
import functools
import json
import os
import random
import re
import sqlite3
import sys
import zlib
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
try:
    from normalize import canonicalize, load_aliases  # type: ignore
except Exception as e:  # pragma: no cover
    canonicalize = None
    load_aliases = None
    print(f'warning: pipeline canonicalize unavailable ({e}); using squash compare', file=sys.stderr)

DB_PATH = os.environ.get('AMO_DB_PATH') or '/opt/amo-dashboard/miami_dade_amo.db'
UCC = ("'FINANCING STATEMENT UCC - FST'", "'FIN'")
UCC_SQL = f"doc_type NOT IN ({', '.join(UCC)})"

# ── title lexicon ──────────────────────────────────────────────────────────
RENTS_T = re.compile(r'\b(RENTS?|LEASES?|LESSORS?|LESSEES?|TENANTS?|RENTALS?|PROFITS)\b', re.I)
DEBT_T = re.compile(r'\b(MORTGAGES?|MTG|DEED\s+OF\s+TRUST|NOTES?|LOAN|LOANS|HELOC|SECURITY\s+(?:AGREEMENT|INSTRUMENT|DEED)|'
                    r'LIEN\b(?!\s+RELEASE)|CREDIT\s+LINE|LINE\s+OF\s+CREDIT|ASSIGNMENT\s+OF\s+ASSIGNMENT)', re.I)
COLL_T = re.compile(r'\bCOLL?[AE]+T[AE]RAL\b|\bPLEDGE\b', re.I)
OTHER_T = re.compile(r'\b(JUDGMENT|CONTRACT|BID|DEVELOPMENT\s+RIGHTS?|PERMITS?|RELEASE|SATISFACTION|CLAIM\s+OF\s+LIEN|'
                     r'AGREEMENT\s+FOR\s+DEED|OPTION|MEMBERSHIP|PARTNERSHIP\s+INTEREST|PROCEEDS|INSURANCE|'
                     r'ESCROW|TAX\s+CERTIFICATE|CERTIFICATE\s+OF\s+TITLE|EASEMENT|LICENSE|TRADEMARK|'
                     r'DEPOSIT|ACCOUNT|RECEIVABLES?|UCC|FINANCING\s+STATEMENT|TERMINATION|CANCELLATION|'
                     r'SUBORDINATION|MODIFICATION|AMENDMENT|POWER\s+OF\s+ATTORNEY|AFFIDAVIT|NOTICE|'
                     r'DECLARATION|CONSENT|ESTOPPEL|WARRANTY|BILL\s+OF\s+SALE|QUIT\s*CLAIM|DEED\b(?!\s+OF\s+TRUST))\b', re.I)
ASSESS_T = re.compile(r'ASSESSMENT|LIEN\s+RIGHT', re.I)


LEAD_OTHER_T = re.compile(r'^\W*(?:PARTIAL\s+)?(?:RELEASE|RESCISSION|RESCISION|SATISFACTION|TERMINATION|CANCELLATION|NOTICE|AFFIDAVIT|'
                          r'AMENDMENT|MODIFICATION|SUBORDINATION|CONSENT|ESTOPPEL|WAIVER|RECEIPT|CERTIFICATE|MEMORANDUM|'
                          r'UCC|FINANCING\s+STATEMENT|\w+\s+AMENDMENT\s+TO)\b', re.I)
COMPANION_T = re.compile(r'ASSIGNMENT\s+OF\s+(?:\w+\s+){0,4}ASSIGNMENT\s+OF\s+(?:\w+\s+){0,3}(?:RENTS?|LEASES?)', re.I)


def expected_from_title(title: str | None) -> str:
    """Conservative reading of the recorded title. 'AMBIG' when it cannot say."""
    t = (title or '').strip()
    if not t:
        return 'NOTITLE'
    if LEAD_OTHER_T.search(t):
        return 'OTHER'               # a release/rescission/amendment OF an assignment is not an assignment
    if COMPANION_T.search(t) and not re.search(r'MORTGAGE|NOTE', t, re.I):
        return 'AMBIG'               # a lender passing on its rents instrument: companion to a mortgage assignment
    if ASSESS_T.search(t):
        return 'COLLATERAL'
    debt, rents, coll, other = DEBT_T.search(t), RENTS_T.search(t), COLL_T.search(t), OTHER_T.search(t)
    if debt and coll:
        # "ASSIGNMENT OF MORTGAGE, ... AND COLLATERAL ASSIGNMENT OF LEASES" is a mortgage assignment whose
        # ancillary documents travel with it; only a title that LEADS with collateral/pledge is a pledge.
        return 'COLLATERAL' if re.match(r'^\W*(?:\w+\s+){0,2}(?:COLL?[AE]+T[AE]RAL|PLEDGE)', t, re.I) else 'LOAN_TRANSFER'
    if debt:
        return 'LOAN_TRANSFER'          # a mortgage assignment that also sweeps rents is still a mortgage assignment
    if rents:
        return 'RENTS_LEASES'
    if other:
        return 'OTHER'
    return 'AMBIG'


# ── body-text lexicon (Miami-Dade stored OCR) ─────────────────────────────
PLEDGE_B = re.compile(r'collateral\s*(?:re-?)?\s*assign|collaterally\s+assign|as\s+collateral\s+security|'
                      r'for\s+(?:better\s+)?securing\s+the\s+(?:re)?payment|'
                      r'as\s+security\s+for\s+the\s+(?:payment|performance|obligations)\s+of\s+(?:the\s+)?assignor|'
                      r'pledge[sd]?\s+(?:and\s+assigns?\s+)?(?:to|unto)\b', re.I)
RENTS_SEC_B = re.compile(r'given\s+to\s+secure|to\s+secure\s+(?:the\s+)?(?:payment|repayment|indebtedness|obligations)|'
                         r'security\s+interest\s+in\s+[^.]{0,120}\b(?:rents|leases)\b|'
                         r'assigns?\b[^.]{0,80}\b(?:all\s+)?(?:the\s+)?(?:rents|leases)\b[^.]{0,160}\b(?:as\s+)?(?:additional\s+)?security\b', re.I)
TRANSFER_B = re.compile(r'without\s+recourse|\bforever\b|grant,?\s+bargain,?\s+sell|'
                        r'all\s+(?:of\s+)?(?:its|their|his|her)?\s*right,?\s+title,?\s+and\s+interest|'
                        r'sell,?\s+assign,?\s+transfer|assign,?\s+transfer\s+and\s+set\s+over|hereby\s+assigns?\s+(?:and\s+transfers?\s+)?(?:to|unto)', re.I)
BORROWER_B = re.compile(r'\b(?:borrower|mortgagor|grantor|debtor)\b', re.I)

CORP = re.compile(r'\b(?:INC|CORP|CORPORATION|INCORPORATED|LLC|L\.?L\.?C|LTD|LP|L\.?P|LLP|PLC|CO|COMPANY|BANK|BANKING|'
                  r'N\.?A|F\.?S\.?B|SSB|TRUST|TRUSTEE|ASSOCIATION|ASSN|FUND|FUNDING|CAPITAL|HOLDINGS?|PARTNERS?|'
                  r'PARTNERSHIP|GROUP|SERIES|SYSTEMS|MORTGAGE|SERVICING|FINANCIAL|FINANCE|LENDING|LENDERS?|REALTY|'
                  r'PROPERTIES|INVESTMENTS?|SAVINGS|CREDIT|UNION|AGENCY|AUTHORITY|SECRETARY|DEPARTMENT|BANCORP|'
                  r'BANCSHARES|ENTERPRISES?|VENTURES?|ASSOCIATES|P\.?A|CHURCH|MINISTR|CONDOMINIUM|HOMEOWNERS|HOA|'
                  r'DEVELOPMENT|MANAGEMENT|INTERNATIONAL|SOLUTIONS|SERVICES|ESTATE|LAND|MHP|APARTMENTS|PLAZA|CENTER)\b', re.I)
LENDER_MARK = re.compile(r'\b(BANK|BANC|MORTGAGE|MTG|LENDING|LENDER|FUNDING|CAPITAL|CREDIT|FINANCIAL|FINANCE|LOANS?|'
                         r'SAVINGS|FSB|TRUST\s+COMPANY|INVESTORS?|HOME\s+LOANS?|FUND)\b', re.I)


def squash(s):
    return re.sub(r'[^A-Z0-9]', '', (s or '').upper())


def canon(s):
    if canonicalize:
        try:
            return canonicalize(s or '')
        except Exception:
            pass
    return squash(s)


def looks_person(name):
    return bool(name) and not CORP.search(name)


class Report:
    def __init__(self, out):
        self.out = out
        os.makedirs(out, exist_ok=True)
        self.lines = []

    def h(self, t):
        self.lines += ['', f'## {t}', '']

    def p(self, t=''):
        self.lines.append(t)

    def table(self, header, rows, limit=None):
        rows = list(rows)
        if limit:
            rows = rows[:limit]
        self.lines.append('| ' + ' | '.join(header) + ' |')
        self.lines.append('|' + '---|' * len(header))
        for r in rows:
            self.lines.append('| ' + ' | '.join(str('' if v is None else v).replace('|', '/') for v in r) + ' |')
        self.lines.append('')

    def csv(self, name, header, rows):
        path = os.path.join(self.out, name)
        with open(path, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(header)
            for r in rows:
                w.writerow(r)
        self.p(f'_full list: `{name}` ({sum(1 for _ in open(path)) - 1} rows)_')
        self.p()

    def save(self):
        path = os.path.join(self.out, 'report.md')
        open(path, 'w').write('\n'.join(self.lines) + '\n')
        return path


def q(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()


def money(v):
    try:
        v = float(v or 0)
    except Exception:
        return ''
    return f'${v/1e9:.2f}B' if v >= 1e9 else f'${v/1e6:.1f}M' if v >= 1e6 else f'${v/1e3:.0f}K'


def section(fn):
    @functools.wraps(fn)
    def wrapped(R, conn):
        try:
            fn(R, conn)
        except Exception as e:  # keep going; the report says what failed
            R.p(f'**SECTION FAILED:** `{type(e).__name__}: {e}`')
            R.p()
    return wrapped


# ═══════════════════════════════════════════════════════════════════════════
@section
def s1_population(R, conn):
    R.h('S1. Population and coverage')
    R.table(['county', 'doc_type', 'rows', 'read (OK)', 'in clean', 'in nonloan', 'read but in neither', 'with OCR text'],
            q(conn, f"""
        SELECT COALESCE(a.county,'MIAMI-DADE'), a.doc_type, COUNT(*),
               SUM(e.status='OK'), SUM(c.cfn IS NOT NULL), SUM(nl.cfn IS NOT NULL),
               SUM(e.status='OK' AND c.cfn IS NULL AND nl.cfn IS NULL),
               SUM(d.status='OK')
        FROM assignments a
        LEFT JOIN pdf_extractions e ON e.cfn=a.cfn
        LEFT JOIN aom_events_clean c ON c.cfn=a.cfn
        LEFT JOIN aom_events_nonloan nl ON nl.cfn=a.cfn
        LEFT JOIN document_text d ON d.cfn=a.cfn
        GROUP BY 1,2 ORDER BY 1, 3 DESC"""))
    R.p('Reading: "read but in neither" = documents the AI read that reach no dashboard table. '
        'Expected for UCC types (excluded by design) and for recent rows awaiting the nightly rebuild; '
        'anything else is a lost row.')
    R.p()
    R.table(['status', 'n'], q(conn, "SELECT status, COUNT(*) FROM pdf_extractions GROUP BY 1 ORDER BY 2 DESC"))
    R.table(['read rows', 'null/empty title', 'null doc_category', 'null assignor', 'null assignee', 'both parties null'],
            q(conn, """SELECT COUNT(*), SUM(COALESCE(TRIM(doc_title),'')=''), SUM(doc_category IS NULL),
                       SUM(COALESCE(TRIM(assignor_name),'')=''), SUM(COALESCE(TRIM(assignee_name),'')=''),
                       SUM(COALESCE(TRIM(assignor_name),'')='' AND COALESCE(TRIM(assignee_name),'')='')
                       FROM pdf_extractions WHERE status='OK'"""))


@section
def s2_category_title(R, conn):
    R.h('S2. Document category vs recorded title (all read documents, UCC excluded)')
    rows = q(conn, f"""
        SELECT e.cfn, COALESCE(a.county,'MIAMI-DADE'), e.doc_category, e.doc_title, e.loan_amount,
               c.cfn IS NOT NULL, c.txn_type, c.assignor_type, e.assignor_name
        FROM pdf_extractions e JOIN assignments a ON a.cfn=e.cfn
        LEFT JOIN aom_events_clean c ON c.cfn=e.cfn
        WHERE e.status='OK' AND a.{UCC_SQL}""")
    xt = Counter()
    bad = defaultdict(list)
    for cfn, county, cat, title, amt, in_clean, txn, atype, aname in rows:
        exp = expected_from_title(title)
        xt[(county, cat, exp)] += 1
        if exp not in ('AMBIG', 'NOTITLE') and exp != cat:
            bad[(county, cat, exp)].append((cfn, title, amt, in_clean, txn, atype, aname))
    R.p('Expected category is read from the recorded title with a conservative lexicon (a title naming a mortgage/note '
        'is LOAN_TRANSFER even if it also mentions rents; COLLATERAL only when the title says collateral/pledge; '
        'AMBIG when the title settles nothing). Disagreement is a *candidate* error, confirmed in S3/S10.')
    R.p()
    counties = sorted({k[0] for k in xt})
    for county in counties:
        R.p(f'**{county}** — stored category (rows) × title says (columns)')
        cats = ['LOAN_TRANSFER', 'RENTS_LEASES', 'COLLATERAL', 'OTHER']
        exps = cats + ['AMBIG', 'NOTITLE']
        R.table(['stored \\ title'] + exps + ['agree %'],
                [[c] + [xt[(county, c, e)] for e in exps] +
                 [f"{100*xt[(county,c,c)]/max(1,sum(xt[(county,c,e)] for e in cats)):.0f}%"] for c in cats])
    R.p('**Disagreement clusters** (stored → title says), with how many reached the clean table and the stated $:')
    agg = []
    for (county, cat, exp), lst in bad.items():
        titles = Counter(re.sub(r'\s+', ' ', (t or '').upper())[:70] for _, t, *_ in lst)
        agg.append((county, cat, exp, len(lst), sum(1 for x in lst if x[3]),
                    money(sum(float(x[2] or 0) for x in lst)),
                    sum(1 for x in lst if looks_person(x[6])),
                    '; '.join(f'{t} ({n})' for t, n in titles.most_common(4))))
    agg.sort(key=lambda r: -r[3])
    R.table(['county', 'stored', 'title says', 'rows', 'in clean', 'stated $', 'assignor person-shaped', 'top titles'], agg)
    out = []
    for (county, cat, exp), lst in bad.items():
        for cfn, title, amt, in_clean, txn, atype, aname in lst:
            out.append((county, cat, exp, cfn, title, amt, int(bool(in_clean)), txn, atype, aname))
    R.csv('s2_category_title_disagreements.csv',
          ['county', 'stored', 'title_says', 'cfn', 'title', 'loan_amount', 'in_clean', 'txn_type', 'assignor_type', 'assignor'], out)


@section
def s3_category_text(R, conn):
    R.h('S3. Document category vs body text (Miami-Dade, stored OCR)')
    rows = q(conn, """
        SELECT e.cfn, e.doc_category, e.doc_title, e.loan_amount, d.text_z, c.txn_type, c.assignor_type, c.assignor, c.assignee
        FROM pdf_extractions e JOIN document_text d ON d.cfn=e.cfn
        LEFT JOIN aom_events_clean c ON c.cfn=e.cfn
        WHERE e.status='OK' AND d.status='OK' AND d.text_z IS NOT NULL""")
    R.p(f'{len(rows):,} documents with stored text (all currently LOAN_TRANSFER; the re-read covered that category only).')
    n = Counter()
    sus_pledge, sus_rents, sus_none = [], [], []
    for cfn, cat, title, amt, blob, txn, atype, asg, ase in rows:
        try:
            text = zlib.decompress(blob).decode('utf-8', 'replace')
        except Exception:
            n['undecodable'] += 1
            continue
        head = text[:6000]
        pl, rs, tr = bool(PLEDGE_B.search(head)), bool(RENTS_SEC_B.search(head)), bool(TRANSFER_B.search(head))
        n['total'] += 1
        n['pledge'] += pl
        n['rents_security'] += rs
        n['transfer_language'] += tr
        n['pledge_no_transfer'] += pl and not tr
        n['rents_no_transfer'] += rs and not tr
        n['no_signal'] += not (pl or rs or tr)
        exp = expected_from_title(title)
        if pl and not tr:
            sus_pledge.append((cfn, title, amt, txn, atype, asg, ase, PLEDGE_B.search(head).group(0)))
        if rs and not tr and exp != 'LOAN_TRANSFER':
            sus_rents.append((cfn, title, amt, txn, atype, asg, ase, RENTS_SEC_B.search(head).group(0)[:80]))
        if not (pl or rs or tr):
            sus_none.append((cfn, title, amt, txn, atype, asg, ase))
    R.table(['measure', 'documents', 'share'],
            [[k, v, f'{100*v/max(1,n["total"]):.1f}%'] for k, v in n.items()])
    R.p('Reading: a LOAN_TRANSFER whose first pages carry pledge language and **no** transfer language is a candidate '
        'COLLATERAL miss; rents-security language with no transfer language and a title that is not a mortgage '
        'assignment is a candidate RENTS_LEASES miss. "no_signal" documents are usually short-form county '
        'assignment forms or poor OCR, not errors.')
    R.p()
    R.p(f'**Candidate COLLATERAL misses: {len(sus_pledge):,}** — stated $ {money(sum(float(x[2] or 0) for x in sus_pledge))}')
    R.table(['cfn', 'title', 'amount', 'txn', 'assignor type', 'assignor', 'assignee', 'phrase'],
            sorted(sus_pledge, key=lambda r: -(r[2] or 0)), limit=15)
    R.csv('s3_candidate_collateral_misses.csv', ['cfn', 'title', 'amount', 'txn', 'assignor_type', 'assignor', 'assignee', 'phrase'], sus_pledge)
    R.p(f'**Candidate RENTS_LEASES misses: {len(sus_rents):,}** — stated $ {money(sum(float(x[2] or 0) for x in sus_rents))}')
    R.table(['cfn', 'title', 'amount', 'txn', 'assignor type', 'assignor', 'assignee', 'phrase'],
            sorted(sus_rents, key=lambda r: -(r[2] or 0)), limit=15)
    R.csv('s3_candidate_rents_misses.csv', ['cfn', 'title', 'amount', 'txn', 'assignor_type', 'assignor', 'assignee', 'phrase'], sus_rents)
    R.csv('s3_no_signal.csv', ['cfn', 'title', 'amount', 'txn', 'assignor_type', 'assignor', 'assignee'], sus_none)


@section
def s4_direction(R, conn):
    R.h('S4. Direction — who assigned to whom')
    R.p('**Miami-Dade** (the only county with a direction check; `direction_decisions`):')
    R.table(['bucket', 'action', 'text verdict', 'needs review', 'n'],
            q(conn, "SELECT bucket, action, COALESCE(text_verdict,'—'), needs_review, COUNT(*) FROM direction_decisions GROUP BY 1,2,3,4 ORDER BY 5 DESC"))
    rv = q(conn, """SELECT COUNT(*), SUM(c.reviewed_by IS NOT NULL) FROM direction_decisions dd
                    LEFT JOIN aom_events_clean c ON c.cfn=dd.cfn WHERE dd.needs_review=1""")[0]
    R.p(f'Rows flagged for review: {rv[0]:,}; of those reviewed by a person: {rv[1] or 0:,}. '
        'Unreviewed flags are rows where the document and the index disagree and nobody has settled it.')
    R.p()
    # Does the clean table honour the swap?
    chk = q(conn, """SELECT SUM(c.assignor = dd.index_assignee OR c.assignor_canon = dd.index_assignee),
                            SUM(c.assignor = dd.index_assignor OR c.assignor_canon = dd.index_assignor), COUNT(*)
                     FROM direction_decisions dd JOIN aom_events_clean c ON c.cfn=dd.cfn WHERE dd.action='SWAPPED'""")[0]
    R.p(f'Swapped rows in clean table: {chk[2]:,}; assignor now equals the index assignee (swap applied): {chk[0] or 0:,}; '
        f'still equals the index assignor (swap NOT applied): {chk[1] or 0:,}.')
    R.p()
    # Other counties: compute buckets from stored names
    for county in ('HILLSBOROUGH', 'BROWARD'):
        rows = q(conn, f"""SELECT a.cfn, a.grantor, a.grantee, e.assignor_name, e.assignee_name, c.assignor, c.assignee, c.loan_amount, e.doc_title
                           FROM assignments a JOIN pdf_extractions e ON e.cfn=a.cfn
                           LEFT JOIN aom_events_clean c ON c.cfn=a.cfn
                           WHERE a.county=? AND e.status='OK' AND e.doc_category='LOAN_TRANSFER'""", (county,))
        b = Counter()
        rev = []
        for cfn, g, ge, pa, pb, ca, ce, amt, title in rows:
            ia, ib = canon(g), canon(ge)
            da, db = canon(pa) if pa else None, canon(pb) if pb else None
            if not da or not db or da == 'UNKNOWN' or db == 'UNKNOWN':
                k = 'D0'
            else:
                fwd = (da == ia) + (db == ib)
                rv_ = (da == ib) + (db == ia)
                k = 'D5' if fwd == rv_ else 'D3' if rv_ == 2 else 'D4' if (rv_ == 1 and fwd == 0) else 'D1' if fwd == 2 else 'D2'
            b[k] += 1
            if k in ('D3', 'D4'):
                rev.append((cfn, g, ge, pa, pb, ca, ce, amt, title))
        tot = sum(b.values()) or 1
        R.p(f'**{county}** — {tot:,} loan transfers read. Index order vs the document\'s parties:')
        R.table(['bucket', 'meaning', 'n', 'share'],
                [[k, {'D1': 'same order, exact', 'D2': 'same order, variant spelling', 'D3': 'exact reverse',
                      'D4': 'reverse, one variant', 'D5': 'names do not match', 'D0': 'no document parties'}[k], b[k], f'{100*b[k]/tot:.1f}%']
                 for k in ('D1', 'D2', 'D3', 'D4', 'D5', 'D0')])
        R.p(f'D3+D4 = {b["D3"]+b["D4"]:,} rows ({100*(b["D3"]+b["D4"])/tot:.1f}%) where the document names the parties in the '
            f'opposite order to the index. **No direction correction runs for {county}**, so the clean table follows the index here.')
        R.table(['cfn', 'index grantor', 'index grantee', 'doc assignor', 'doc assignee', 'clean assignor', 'clean assignee', 'amount'],
                [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], money(r[7])) for r in sorted(rev, key=lambda r: -(r[7] or 0))], limit=12)
        R.csv(f's4_{county.lower()}_reversed_candidates.csv',
              ['cfn', 'index_grantor', 'index_grantee', 'doc_assignor', 'doc_assignee', 'clean_assignor', 'clean_assignee', 'amount', 'title'], rev)


@section
def s5_parties(R, conn):
    R.h('S5. Parties')
    R.table(['county', 'txn_type', 'rows', 'assignor person-shaped', 'assignee person-shaped', 'doc assignor missing', 'doc assignee missing'],
            q(conn, """SELECT county, txn_type, COUNT(*), 0, 0, SUM(COALESCE(TRIM(pdf_assignor),'')=''), SUM(COALESCE(TRIM(pdf_assignee),'')='')
                       FROM aom_events_clean GROUP BY 1,2 ORDER BY 1, 3 DESC"""))
    rows = q(conn, "SELECT county, txn_type, assignor, assignee FROM aom_events_clean")
    pc = Counter()
    for county, txn, a, b in rows:
        pc[(county, txn, 'a')] += looks_person(a)
        pc[(county, txn, 'b')] += looks_person(b)
    R.p('Person-shaped parties in the clean (loan transfer) table — a homeowner cannot assign a mortgage, so a '
        'person as assignor marks a rents/collateral instrument or a borrower-indexed row:')
    R.table(['county', 'txn_type', 'assignor person-shaped', 'assignee person-shaped'],
            sorted([(c, t, pc[(c, t, 'a')], pc[(c, t, 'b')]) for (c, t, s) in pc if s == 'a'], key=lambda r: -r[2]))
    R.p('**SELF_ASSIGN rows** — same canonical name on both sides. Legitimate when a servicer re-papers its own loans; an '
        'error when two different firms canonicalise to one name. Highest stated amounts first:')
    sa = q(conn, """SELECT c.cfn, c.county, c.assignor, c.assignee, c.assignor_canon, c.pdf_assignor, c.pdf_assignee, c.loan_amount, c.doc_title
                    FROM aom_events_clean c WHERE c.txn_type='SELF_ASSIGN' ORDER BY COALESCE(c.loan_amount,0) DESC""")
    R.table(['cfn', 'county', 'index assignor', 'index assignee', 'canon', 'doc assignor', 'doc assignee', 'amount'],
            [(r[0], r[1], r[2], r[3], r[4], (r[5] or '')[:40], (r[6] or '')[:40], money(r[7])) for r in sa], limit=20)
    R.table(['canonical name', 'self-assign rows', 'stated $'],
            q(conn, """SELECT assignor_canon, COUNT(*), SUM(COALESCE(loan_amount,0)) FROM aom_events_clean
                       WHERE txn_type='SELF_ASSIGN' GROUP BY 1 ORDER BY 2 DESC LIMIT 20"""))
    R.csv('s5_self_assign.csv', ['cfn', 'county', 'index_assignor', 'index_assignee', 'canon', 'doc_assignor', 'doc_assignee', 'amount', 'title'], sa)
    # Document parties that differ from index AND from clean (lost document evidence)
    R.p('**Document party ignored**: the AI read a company as assignor that is neither the index name nor what the clean table shows '
        '(the pipeline kept the index). Miami-Dade only (where direction logic runs):')
    lost = q(conn, """SELECT cfn, county, assignor, pdf_assignor, assignee, pdf_assignee, loan_amount FROM aom_events_clean
                      WHERE pdf_assignor IS NOT NULL AND TRIM(pdf_assignor)<>'' AND UPPER(assignor) NOT LIKE '%'||UPPER(substr(pdf_assignor,1,12))||'%'
                        AND UPPER(pdf_assignor) NOT LIKE '%'||UPPER(substr(assignor,1,12))||'%' ORDER BY COALESCE(loan_amount,0) DESC""")
    R.p(f'{len(lost):,} rows where the clean assignor shares no 12-character prefix with the document assignor.')
    R.table(['cfn', 'county', 'clean assignor', 'doc assignor', 'clean assignee', 'doc assignee', 'amount'],
            [(r[0], r[1], r[2], (r[3] or '')[:45], r[4], (r[5] or '')[:45], money(r[6])) for r in lost], limit=15)
    R.csv('s5_doc_party_ignored.csv', ['cfn', 'county', 'clean_assignor', 'doc_assignor', 'clean_assignee', 'doc_assignee', 'amount'], lost)


@section
def s6_entity_types(R, conn):
    R.h('S6. Entity types')
    R.table(['type', 'source', 'entities'], q(conn, "SELECT category, COALESCE(confidence_source,'(none)'), COUNT(*) FROM entity_classifications GROUP BY 1,2 ORDER BY 3 DESC"))
    rows = q(conn, """SELECT n.entity, n.entity_type, n.total_vol, n.outbound_vol, n.inbound_vol, n.degree, ec.confidence_source
                      FROM entity_nodes n LEFT JOIN entity_classifications ec ON ec.name=n.entity""")
    other_lenders = [(e, t, v, o, i, d, s) for e, t, v, o, i, d, s in rows if t == 'OTHER' and LENDER_MARK.search(e or '') and (v or 0) >= 3]
    other_lenders.sort(key=lambda r: -r[2])
    R.p(f'**Lender-named entities typed OTHER** (name carries BANK/MORTGAGE/LENDING/FUNDING/CAPITAL/CREDIT…, ≥3 filings): '
        f'{len(other_lenders):,} entities, {sum(r[2] for r in other_lenders):,} filings. Every one of their deals is typed '
        'INTO_INSTITUTION/OUT_OF_INSTITUTION/NON_INSTITUTIONAL instead of MARKET_TRANSFER.')
    R.table(['entity', 'type', 'filings', 'out', 'in', 'counterparties', 'source'], other_lenders, limit=40)
    R.csv('s6_other_typed_lenders.csv', ['entity', 'type', 'filings', 'out', 'in', 'degree', 'source'], other_lenders)
    fdic = {r[0] for r in q(conn, "SELECT DISTINCT UPPER(canonical_name) FROM fdic_institution_cache WHERE cert IS NOT NULL")} if q(conn, "SELECT name FROM sqlite_master WHERE name='fdic_institution_cache'") else set()
    banks = [(e, v, s) for e, t, v, o, i, d, s in rows if t == 'BANK' and (v or 0) >= 3]
    nb = [(e, v, s) for e, v, s in banks if e.upper() not in fdic and not re.search(r'\bBANK|BANC|N\.?A\.?$|FSB|SAVINGS|TRUST\s+CO', e, re.I)]
    R.p(f'**Typed BANK without an FDIC match or a bank word in the name** (≥3 filings): {len(nb):,}')
    R.table(['entity', 'filings', 'source'], sorted(nb, key=lambda r: -r[1]), limit=30)
    R.p('**Behavioural verdicts** (type assigned from trading pattern alone) — highest volume:')
    R.table(['entity', 'type', 'filings', 'out', 'in', 'counterparties'],
            sorted([(e, t, v, o, i, d) for e, t, v, o, i, d, s in rows if s == 'behavioral'], key=lambda r: -(r[2] or 0)), limit=30)
    R.p('**LLM verdicts** on high-volume names (enrich_entities), for spot-checking:')
    R.table(['entity', 'type', 'filings'],
            sorted([(e, t, v) for e, t, v, o, i, d, s in rows if s == 'llm' and t != 'OTHER'], key=lambda r: -(r[2] or 0)), limit=40)
    R.p('**Person-shaped names typed as institutions:**')
    R.table(['entity', 'type', 'filings', 'source'],
            sorted([(e, t, v, s) for e, t, v, o, i, d, s in rows if t in ('BANK', 'SERVICER', 'PRIVATE_CREDIT', 'TRUST', 'GSE') and looks_person(e)], key=lambda r: -(r[2] or 0)), limit=20)


@section
def s7_txn_type(R, conn):
    R.h('S7. Transaction type')
    R.p('`INTO_INSTITUTION` = non-institution → institution. In a table of mortgage **assignments** this shape is suspect: a borrower '
        'does not assign a mortgage to its lender. These rows are either rents/collateral instruments mis-categorised, or '
        'borrower-indexed rows where the real assignor was not recovered, or lenders the type classifier does not know.')
    R.table(['county', 'INTO_INSTITUTION rows', 'stated $', 'assignor person-shaped', 'title says rents/other', 'title says mortgage/note'],
            [(c, n, money(amt), 0, 0, 0) for c, n, amt in q(conn, "SELECT county, COUNT(*), SUM(COALESCE(loan_amount,0)) FROM aom_events_clean WHERE txn_type='INTO_INSTITUTION' GROUP BY 1")])
    rows = q(conn, "SELECT county, cfn, assignor, assignee, doc_title, loan_amount, assignor_type FROM aom_events_clean WHERE txn_type='INTO_INSTITUTION'")
    agg = defaultdict(Counter)
    for county, cfn, a, b, title, amt, at in rows:
        exp = expected_from_title(title)
        agg[county]['person'] += looks_person(a)
        agg[county]['title_rents_other'] += exp in ('RENTS_LEASES', 'OTHER', 'COLLATERAL')
        agg[county]['title_debt'] += exp == 'LOAN_TRANSFER'
        agg[county]['company_not_person_debt_title'] += (not looks_person(a)) and exp == 'LOAN_TRANSFER'
    R.table(['county', 'assignor person-shaped', 'title says rents/other/collateral', 'title says mortgage/note', 'company assignor + mortgage title (likely unknown lender)'],
            [(c, v['person'], v['title_rents_other'], v['title_debt'], v['company_not_person_debt_title']) for c, v in agg.items()])
    R.p('Company assignors with a mortgage title, by name — these are most likely **lenders the classifier typed OTHER**:')
    R.table(['assignor', 'INTO_INSTITUTION rows', 'stated $'],
            q(conn, """SELECT assignor_canon, COUNT(*), SUM(COALESCE(loan_amount,0)) FROM aom_events_clean
                       WHERE txn_type='INTO_INSTITUTION' GROUP BY 1 ORDER BY 2 DESC LIMIT 30"""))
    R.csv('s7_origination_rows.csv', ['county', 'cfn', 'assignor', 'assignee', 'title', 'amount', 'assignor_type'], rows)
    R.p('**MARKET_TRANSFER rows whose title is a rents/leases-only instrument** (counted as loan trades):')
    mt = q(conn, """SELECT county, cfn, assignor, assignee, doc_title, loan_amount FROM aom_events_clean WHERE txn_type='MARKET_TRANSFER'""")
    mt_r = [r for r in mt if expected_from_title(r[4]) == 'RENTS_LEASES']
    R.p(f'{len(mt_r):,} rows, stated $ {money(sum(float(r[5] or 0) for r in mt_r))}')
    R.table(['county', 'cfn', 'assignor', 'assignee', 'title', 'amount'], sorted(mt_r, key=lambda r: -(r[5] or 0)), limit=15)


@section
def s8_amounts(R, conn):
    R.h('S8. Amounts')
    R.table(['county', 'rows', 'with amount', 'median', 'p95', 'max', '> $250M', '> $1B'],
            [(c, n, w, money(med), money(p95), money(mx), big, huge) for c, n, w, med, p95, mx, big, huge in q(conn, """
            WITH x AS (SELECT county, loan_amount, ROW_NUMBER() OVER (PARTITION BY county ORDER BY loan_amount) rn,
                              COUNT(*) OVER (PARTITION BY county) cnt FROM aom_events_clean WHERE loan_amount IS NOT NULL)
            SELECT c.county, COUNT(*), SUM(c.loan_amount IS NOT NULL),
                   (SELECT loan_amount FROM x WHERE x.county=c.county AND rn=cnt/2),
                   (SELECT loan_amount FROM x WHERE x.county=c.county AND rn=cnt*95/100),
                   MAX(c.loan_amount), SUM(c.loan_amount>250e6), SUM(c.loan_amount>1e9)
            FROM aom_events_clean c GROUP BY 1""")])
    R.p('**Largest stated amounts** (each is either a genuine portfolio/CMBS figure or a mis-read):')
    R.table(['cfn', 'county', 'assignor', 'assignee', 'title', 'amount', 'consideration', 'txn'],
            [(r[0], r[1], r[2], r[3], (r[4] or '')[:50], money(r[5]), money(r[6]), r[7]) for r in q(conn, """
            SELECT cfn, county, assignor, assignee, doc_title, loan_amount, consideration_amount, txn_type
            FROM aom_events_clean ORDER BY loan_amount DESC LIMIT 25""")])
    R.p('**Repeated amounts** (same figure on many unrelated filings — an echo from the prompt or a form default):')
    R.table(['amount', 'rows', 'distinct assignors', 'example cfn'],
            [(money(a), n, d, c) for a, n, d, c in q(conn, """
            SELECT loan_amount, COUNT(*), COUNT(DISTINCT assignor_canon), MIN(cfn) FROM aom_events_clean
            WHERE loan_amount IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 25 ORDER BY 2 DESC LIMIT 20""")])
    R.table(['measure', 'rows'], [
        ('loan_amount equals consideration_amount (both set)', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE loan_amount=consideration_amount AND loan_amount IS NOT NULL")[0][0]),
        ('consideration set, loan_amount null', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE consideration_amount IS NOT NULL AND loan_amount IS NULL")[0][0]),
        ('amount < $1,000', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE loan_amount < 1000")[0][0]),
        ('amount stored on RENTS_LEASES / COLLATERAL / OTHER reads (pdf_extractions)', q(conn, "SELECT COUNT(*) FROM pdf_extractions WHERE doc_category<>'LOAN_TRANSFER' AND loan_amount IS NOT NULL")[0][0]),
    ])


@section
def s9_addresses(R, conn):
    R.h('S9. Addresses and folios')
    R.table(['measure', 'rows'], [
        ('clean rows', q(conn, "SELECT COUNT(*) FROM aom_events_clean")[0][0]),
        ('property_address present', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE COALESCE(TRIM(property_address),'')<>''")[0][0]),
        ('property_address equals sponsor_address', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE property_address IS NOT NULL AND UPPER(property_address)=UPPER(sponsor_address)")[0][0]),
        ('property_address looks corporate (SUITE/STE/FLOOR/P.O. BOX)', q(conn, r"SELECT COUNT(*) FROM aom_events_clean WHERE property_address REGEXP '(?i)\b(SUITE|STE\.?|FLOOR|FL\.? [0-9]|P\.?O\.? BOX)\b'")[0][0] if False else
         sum(1 for (a,) in q(conn, "SELECT property_address FROM aom_events_clean WHERE property_address IS NOT NULL") if re.search(r'\b(SUITE|STE\.?|FLOOR|P\.?O\.?\s*BOX)\b', a, re.I))),
        ('property_address outside Florida (state code not FL)', sum(1 for (a,) in q(conn, "SELECT property_address FROM aom_events_clean WHERE property_address IS NOT NULL") if re.search(r',\s*([A-Z]{2})\s+\d{5}', a) and not re.search(r',\s*FL\s+\d{5}', a, re.I))),
        ('folio present', q(conn, "SELECT COUNT(*) FROM aom_events_clean WHERE COALESCE(TRIM(folio_parcel),'')<>''")[0][0]),
    ])
    R.p('Examples of property_address that reads as a corporate address:')
    ex = [(c, a) for c, a in q(conn, "SELECT cfn, property_address FROM aom_events_clean WHERE property_address IS NOT NULL") if re.search(r'\b(SUITE|STE\.?|FLOOR|P\.?O\.?\s*BOX)\b', a, re.I)]
    R.table(['cfn', 'property_address'], ex, limit=12)


@section
def s10_samples(R, conn):
    R.h('S10. Stratified samples for hand-reading (Tier C)')
    rnd = random.Random(20261030)
    out = []

    def pick(label, sql, k, params=()):
        rows = q(conn, sql, params)
        rnd.shuffle(rows)
        for r in rows[:k]:
            out.append((label,) + tuple(r))
        R.p(f'- {label}: {min(k, len(rows))} of {len(rows):,}')
    base = "SELECT a.cfn, a.county, a.rec_book, a.rec_page, e.doc_category, e.doc_title, e.assignor_name, e.assignee_name, e.loan_amount FROM pdf_extractions e JOIN assignments a ON a.cfn=e.cfn WHERE e.status='OK' AND a." + UCC_SQL
    for county in ('MIAMI-DADE', 'HILLSBOROUGH', 'BROWARD'):
        for cat in ('LOAN_TRANSFER', 'RENTS_LEASES', 'COLLATERAL', 'OTHER'):
            if county == 'MIAMI-DADE' and cat == 'LOAN_TRANSFER':
                continue   # covered by S3 text
            pick(f'{county} {cat}', base + " AND a.county=? AND e.doc_category=?", 8, (county, cat))
    pick('INTO_INSTITUTION (clean)', base + " AND a.cfn IN (SELECT cfn FROM aom_events_clean WHERE txn_type='INTO_INSTITUTION')", 15)
    pick('SELF_ASSIGN (clean)', base + " AND a.cfn IN (SELECT cfn FROM aom_events_clean WHERE txn_type='SELF_ASSIGN')", 12)
    pick('amount > $100M (clean)', base + " AND a.cfn IN (SELECT cfn FROM aom_events_clean WHERE loan_amount > 100e6)", 12)
    pick('title/category disagree', base + " AND e.doc_category='LOAN_TRANSFER' AND (UPPER(e.doc_title) LIKE '%RENT%' OR UPPER(e.doc_title) LIKE '%LEASE%') AND UPPER(e.doc_title) NOT LIKE '%MORTGAGE%' AND UPPER(e.doc_title) NOT LIKE '%NOTE%'", 12)
    pick('Hillsborough reversed candidates', base + " AND a.county='HILLSBOROUGH' AND e.doc_category='LOAN_TRANSFER' AND UPPER(a.grantor)=UPPER(e.assignee_name) AND UPPER(a.grantee)=UPPER(e.assignor_name)", 10)
    R.csv('s10_samples.csv', ['stratum', 'cfn', 'county', 'rec_book', 'rec_page', 'doc_category', 'doc_title', 'assignor', 'assignee', 'loan_amount'], out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/audit')
    ap.add_argument('--only', default='', help='comma list of section numbers, e.g. 2,3')
    args = ap.parse_args()
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True, timeout=120)
    conn.execute('PRAGMA query_only=1')
    if load_aliases:
        try:
            # load_aliases does CREATE TABLE IF NOT EXISTS / ALTER on a read-only connection → would fail; use a
            # separate in-memory copy of the alias table instead.
            mem = sqlite3.connect(':memory:')
            mem.execute("CREATE TABLE entity_aliases (variant TEXT PRIMARY KEY, canonical TEXT NOT NULL, created_at TEXT, created_by TEXT, note TEXT, scope TEXT DEFAULT 'all')")
            cols = {r[1] for r in conn.execute("PRAGMA table_info(entity_aliases)")}
            sel = "SELECT variant, canonical, " + ("scope" if 'scope' in cols else "'all'") + " FROM entity_aliases"
            mem.executemany("INSERT INTO entity_aliases (variant, canonical, scope) VALUES (?,?,?)", conn.execute(sel).fetchall())
            load_aliases(mem)
        except Exception as e:
            print(f'warning: aliases not loaded ({e})', file=sys.stderr)
    R = Report(args.out)
    R.p('# Accuracy audit — SHCP Intelligence Platform')
    R.p()
    R.p(f'Database: `{DB_PATH}` (opened read-only). Generated by `collector/audit/accuracy_audit.py`.')
    sections = [s1_population, s2_category_title, s3_category_text, s4_direction, s5_parties, s6_entity_types, s7_txn_type, s8_amounts, s9_addresses, s10_samples]
    only = {int(x) for x in args.only.split(',') if x.strip()}
    for i, fn in enumerate(sections, 1):
        if only and i not in only:
            continue
        print(f'[{i}/{len(sections)}] {fn.__name__}', file=sys.stderr, flush=True)
        fn(R, conn)
    print(R.save())


if __name__ == '__main__':
    main()
