#!/usr/bin/env python3
"""
Pipeline monitor — shows a live progress bar for extract_pdfs.py runs.

Usage:
    python3 monitor.py                  # watches /tmp/redo.log by default
    python3 monitor.py /tmp/pipeline.log
    python3 monitor.py --interval 30    # refresh every 30 s (default: 15)
"""
import argparse
import os
import re
import sys
import time

PROGRESS_RE = re.compile(
    r'\[(\d+)/(\d+)\]\s+ok=(\d+)\s+dl_err=(\d+)\s+ocr_err=(\d+)\s+llm_err=(\d+)'
)
DONE_RE = re.compile(r"^Done\.\s*\{")

BAR_WIDTH = 45


def parse_progress(line: str):
    m = PROGRESS_RE.search(line)
    if m:
        return tuple(int(x) for x in m.groups())  # current, total, ok, dl, ocr, llm
    return None


def bar(current: int, total: int) -> str:
    if total == 0:
        return '░' * BAR_WIDTH
    filled = int(BAR_WIDTH * current / total)
    return '█' * filled + '░' * (BAR_WIDTH - filled)


def read_log(log_file: str):
    try:
        with open(log_file) as f:
            return f.readlines()
    except FileNotFoundError:
        return []


def render(log_file: str):
    lines = read_log(log_file)

    # Find the last progress line
    last_prog = None
    for line in reversed(lines):
        parsed = parse_progress(line)
        if parsed:
            last_prog = parsed
            break

    # Check if fully done
    done_line = next((l.strip() for l in reversed(lines) if DONE_RE.match(l.strip())), None)

    # Collect all progress snapshots for rate estimation
    snapshots = [parse_progress(l) for l in lines if parse_progress(l)]

    os.system('clear')
    W = 60
    print()
    print(f"  ┌{'─' * (W - 2)}┐")
    print(f"  │{'  AMO Pipeline Monitor':^{W-2}}│")
    print(f"  │{'  ' + log_file:^{W-2}}│")
    print(f"  └{'─' * (W - 2)}┘")
    print()

    if not lines:
        print(f"  ⏳  Waiting for log file to appear…")
        print(f"\n  {time.strftime('%H:%M:%S')} — refreshing every {args.interval}s  (Ctrl+C to quit)")
        return

    if last_prog is None:
        print("  ⏳  Waiting for first progress update…")
        print()
        print("  Recent log output:")
        for l in lines[-6:]:
            print(f"    {l.rstrip()}")
        print(f"\n  {time.strftime('%H:%M:%S')} — refreshing every {args.interval}s  (Ctrl+C to quit)")
        return

    current, total, ok, dl_err, ocr_err, llm_err = last_prog
    pct = current / total * 100 if total else 0
    remaining = total - current
    total_errors = dl_err + ocr_err + llm_err

    # Progress bar
    print(f"  [{bar(current, total)}]")
    print(f"  {pct:5.1f}%  —  {current:,} / {total:,} documents")
    print()

    # Counters
    print(f"  {'✅  Successful':<22} {ok:>7,}")
    print(f"  {'⬇️   Download errors':<22} {dl_err:>7,}")
    print(f"  {'🔍  OCR errors':<22} {ocr_err:>7,}")
    print(f"  {'🤖  LLM errors':<22} {llm_err:>7,}")
    print(f"  {'─' * 32}")
    print(f"  {'Total errors':<22} {total_errors:>7,}")
    print()

    if done_line:
        print(f"  🎉  COMPLETE!")
        print(f"  {done_line}")
    else:
        # Rough ETA: each batch of 25 docs writes one log line
        # Use mtime delta for last-batch timing
        if len(snapshots) >= 2:
            try:
                mtime = os.path.getmtime(log_file)
                secs_since_last = time.time() - mtime
                # Average seconds per batch across the run
                # (we don't store timestamps, so use elapsed from first entry)
                # Use a simpler heuristic: last known rate from recent batches
                if len(snapshots) >= 3:
                    recent = snapshots[-3:]
                    docs_in_window = recent[-1][0] - recent[0][0]  # docs processed
                    # Can't know exact time, use 3 batches × ~3–4 min each as proxy
                    # Just show remaining count and "~X min per 25 docs" hint
                    pass
                # Fallback: simple remaining count
                batches_left = remaining / 25
                print(f"  ⏱   ~{remaining:,} docs remaining  (~{batches_left:.0f} batches of 25)")
            except Exception:
                pass
        print()

    print(f"  {time.strftime('%H:%M:%S')} — refreshing every {args.interval}s  (Ctrl+C to quit)")
    print()


parser = argparse.ArgumentParser(description='Monitor AMO pipeline log')
parser.add_argument('log_file', nargs='?', help='Path to log file')
parser.add_argument('--interval', type=int, default=15, help='Refresh interval in seconds')
args = parser.parse_args()

# Auto-detect log file
if not args.log_file:
    for candidate in ('/tmp/redo.log', '/tmp/pipeline.log', '/tmp/normalize.log'):
        if os.path.exists(candidate):
            args.log_file = candidate
            break
    if not args.log_file:
        args.log_file = '/tmp/redo.log'  # will wait for it to appear

print(f"Monitoring {args.log_file} — press Ctrl+C to stop")
time.sleep(1)

try:
    while True:
        render(args.log_file)
        time.sleep(args.interval)
except KeyboardInterrupt:
    print("\n\nMonitor stopped.")
    sys.exit(0)
