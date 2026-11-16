"""
Read one complaint uploaded on Data -> Manual Complaint Intake (any county) and store its extraction.

The server runs this right after an upload:
  python complaints_read_case.py BR:CACE-26-018434
Same reader, address repair and $500,000 test as every county (complaints_extract.process_pending).
Exit 1 when the read fails, so the page can show "Read failed" and offer Try again.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import complaints_collect  # noqa: E402
import complaints_extract  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    case_id = sys.argv[1]
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("OPENAI_API_KEY is not set")
        return 1
    model = os.environ.get("COMPLAINTS_MODEL", "gpt-5.5")
    budget = float(os.environ.get("COMPLAINTS_DAILY_BUDGET_USD", "15"))
    conn = complaints_collect.connect()
    complaints_collect.ensure_county_schema(conn)
    res = complaints_extract.process_pending(conn, model, key, budget_usd=budget, case_ids=[case_id])
    print(res)
    if res.get("stopped_for_budget"):
        print(f"Daily reading budget (${budget}) reached; it will be read tomorrow")
        return 1
    return 1 if res.get("failed") or not res.get("extracted") else 0


if __name__ == "__main__":
    sys.exit(main())
