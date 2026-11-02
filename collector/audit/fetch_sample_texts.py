#!/usr/bin/env python3
"""
Fetch and OCR the documents listed in an audit sample CSV, writing one text file
per CFN under --out. Reuses the pipeline's own download/OCR helpers so the text
is what the extractor would have seen. Writes NOTHING to the database.

    AMO_DB_PATH=... ../.venv/bin/python3 fetch_sample_texts.py /tmp/audit/s10_samples.csv --out /tmp/audit/texts
    ... --cfns 2026R740622,121180426        fetch specific CFNs (looked up in assignments)
"""
import argparse
import csv
import os
import sqlite3
import sys
import tempfile
import zlib
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from extract_pdfs import fetch_document_text  # noqa: E402

DB_PATH = os.environ.get('AMO_DB_PATH') or '/opt/amo-dashboard/miami_dade_amo.db'


def one(row, out):
    cfn, county, book, page = row
    dest = os.path.join(out, f'{cfn}.txt')
    if os.path.exists(dest):
        return cfn, 'cached'
    try:
        with tempfile.TemporaryDirectory() as wd:
            text = fetch_document_text(county, cfn, book or '', page or '', wd)
        open(dest, 'w').write(text)
        return cfn, f'ok {len(text)} chars'
    except Exception as e:
        open(dest + '.err', 'w').write(str(e))
        return cfn, f'ERR {e}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv', nargs='?')
    ap.add_argument('--cfns', default='')
    ap.add_argument('--out', default='/tmp/audit/texts')
    ap.add_argument('--workers', type=int, default=3)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True, timeout=60)
    cfns = [c.strip() for c in a.cfns.split(',') if c.strip()]
    if a.csv:
        with open(a.csv, newline='') as f:
            cfns += [r['cfn'] for r in csv.DictReader(f)]
    seen, rows = set(), []
    for cfn in cfns:
        if cfn in seen:
            continue
        seen.add(cfn)
        # stored OCR first — no portal round trip
        t = conn.execute("SELECT text_z FROM document_text WHERE cfn=? AND status='OK'", (cfn,)).fetchone()
        if t and t[0]:
            open(os.path.join(a.out, f'{cfn}.txt'), 'w').write(zlib.decompress(t[0]).decode('utf-8', 'replace'))
            print(cfn, 'stored text', flush=True)
            continue
        r = conn.execute("SELECT cfn, COALESCE(county,'MIAMI-DADE'), rec_book, rec_page FROM assignments WHERE cfn=?", (cfn,)).fetchone()
        if r:
            rows.append(tuple(r))
        else:
            print(cfn, 'not in assignments', flush=True)
    with ThreadPoolExecutor(a.workers) as ex:
        for cfn, status in ex.map(lambda r: one(r, a.out), rows):
            print(cfn, status, flush=True)


if __name__ == '__main__':
    main()
