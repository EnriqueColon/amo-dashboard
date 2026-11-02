"""Stage 3 of the Clerk-complaints pipeline: turn a complaint PDF into page-numbered text.

See docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md (section 12, 18). Every page is
checked for a usable text layer; pages without one (scanned exhibits, scrambled font
encoding) are OCR'd. There is no page cap, because exhibit fields (mortgage address,
reinstatement clause) sit deep in long complaints.

Usage: python complaints_reader.py file.pdf [out.json]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MIN_READABLE = 0.60  # share of tokens that look like words, below which a page is OCR'd
MIN_WORDS = 15       # fewer words than this on a page also means "no usable text layer"
WORD = re.compile(r"^[A-Za-z][a-z]{2,}$|^[A-Z]{3,}$|^[\d,.$%/-]+$")


def readable_ratio(text: str) -> tuple[float, int]:
    toks = [t.strip(".,;:()\"'") for t in text.split()]
    toks = [t for t in toks if t]
    if not toks:
        return 0.0, 0
    return sum(1 for t in toks if WORD.match(t)) / len(toks), len(toks)


def ocr_page(pdf_path: Path, page_no: int) -> str:
    """OCR one page (1-based) with pdftoppm + tesseract. One tesseract thread (several threads fight each other
    on a busy box: a single page once took over four minutes on the droplet) and a time limit; a page that
    times out is retried once at lower resolution, then given up on (empty text) rather than stalling the run."""
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    for dpi, limit in ((200, 120), (140, 120)):
        with tempfile.TemporaryDirectory() as tmp:
            stem = Path(tmp) / "p"
            subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page_no), "-l", str(page_no),
                            "-png", str(pdf_path), str(stem)], check=True, capture_output=True)
            png = next(Path(tmp).glob("p*.png"))
            try:
                out = subprocess.run(["tesseract", str(png), "-", "--psm", "6"], check=True,
                                     capture_output=True, text=True, timeout=limit, env=env)
                return out.stdout
            except subprocess.TimeoutExpired:
                continue
    return ""


def page_count(pdf_path: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf_path)], check=True, capture_output=True, text=True).stdout
    return int(re.search(r"^Pages:\s+(\d+)", out, re.M).group(1))


def text_layer(pdf_path: Path, page_no: int) -> str:
    return subprocess.run(["pdftotext", "-f", str(page_no), "-l", str(page_no), "-layout",
                           str(pdf_path), "-"], check=True, capture_output=True, text=True).stdout


def read_complaint(pdf_path: str | Path) -> dict:
    pdf_path = Path(pdf_path)
    if not all(shutil.which(t) for t in ("pdftoppm", "pdftotext", "pdfinfo", "tesseract")):
        raise RuntimeError("poppler (pdftoppm, pdftotext, pdfinfo) and tesseract are required")
    pages = []
    for i in range(1, page_count(pdf_path) + 1):
        text = text_layer(pdf_path, i)
        ratio, n = readable_ratio(text)
        method = "text"
        if ratio < MIN_READABLE or n < MIN_WORDS:
            text, method = ocr_page(pdf_path, i), "ocr"
            ratio, n = readable_ratio(text)
        pages.append({"page": i, "method": method, "words": n,
                      "readable": round(ratio, 2), "text": text})
    return {"file": pdf_path.name, "page_count": len(pages),
            "ocr_pages": sum(p["method"] == "ocr" for p in pages), "pages": pages}


if __name__ == "__main__":
    res = read_complaint(sys.argv[1])
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(res))
    print(f"{res['file']}: {res['page_count']} pages, {res['ocr_pages']} OCR'd")
