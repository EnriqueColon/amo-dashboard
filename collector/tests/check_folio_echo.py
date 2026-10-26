"""
Guardrails for the 26 Oct 2026 model switch and the folio echo.

  1. folio_placeholder_reason catches every echo shape seen in production
     (the prompt example, its re-hyphenated and first-pair variants, X masks,
     placeholder words, one-digit repeats) and leaves real folios — Miami-Dade,
     Broward, Hillsborough, multi-parcel lists — alone.
  2. postprocess_extraction nulls an echoed folio.
  3. model_request_params sends what each model family accepts: the GPT-5
     family gets max_completion_tokens + reasoning_effort and never max_tokens;
     gpt-5-nano gets no temperature; gpt-5.4 gets temperature 0 and 'none';
     the 4.1 family keeps max_tokens + temperature 0.
  4. chat_completion_body (also the Batch API input) carries exactly one output
     cap, and model_prices tracks the configured model.

Run:  collector/.venv/bin/python3 collector/tests/check_folio_echo.py
"""
import os
import sys

COLLECTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, COLLECTOR)
os.environ.setdefault('AMO_DB_PATH', os.path.join(COLLECTOR, 'tests', 'nonexistent.db'))

import extract_pdfs as ep  # noqa: E402

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got == want:
        print(f'  ok   {label}')
    else:
        print(f'  FAIL {label}: got {got!r}, want {want!r}')
        failures.append(label)


ECHOES = {
    '01-3124-020-0340': 'prompt example',
    '01-31-24-020-0340': 'prompt example',
    '01-31-24-02-03-40': 'prompt example',
    '01-31-24-02-0-340': 'prompt example',
    '01 3124 020 0340': 'prompt example',
    '11-31-24-020-0340': 'prompt example variant',
    '13-3124-020-0340': 'prompt example variant',
    '01-30-24-020-0340': 'prompt example variant',
    '01-3244-02-0340': 'prompt example variant',
    '01-3024-02-0340': 'prompt example variant',
    'XX-XXXX-XXX-XXXX': 'X mask',
    'XX-XXX-XX-XXXX': 'X mask',
    '01-3137-037-XXXX': 'X mask',
    'xx-xxxx-xxx-xxxx': 'X mask',
    'Not found': 'placeholder word',
    'NOT PRESENT': 'placeholder word',
    'null': 'placeholder word',
    'N/A': 'placeholder word',
    '11-11-11-11-111-1111': 'repeated digits',
    '48-48-48-48-48-48-48-48-48-48-48-48-48': 'repeated digits',
}
REAL = [
    '04-3002-185-0010',                       # Miami-Dade
    '30-2123-013-0010',
    '4841-25-04-0190',                        # Broward
    '494125040190',
    'A-01-29-19-ZZZ-000000-12345.0',          # Hillsborough
    '20-43-46-09-03-000-0111',
    '04-3002-185-0010, 04-3002-185-0020',     # multi-parcel list
    '01-3124-020-0341',                       # one digit off the example is real
    '01-3124-021-0340',
    '12-1212-121-2121',                       # a 13-digit "pattern" is a real folio shape
    None, '', 7,
]


def main() -> int:
    print('1. placeholder shapes are recognised, real folios are not')
    for val, reason in ECHOES.items():
        check(f'  {val!r} -> {reason}', ep.folio_placeholder_reason(val), reason)
    for val in REAL:
        check(f'  {val!r} kept', ep.folio_placeholder_reason(val), None)

    print('2. postprocess_extraction nulls an echoed folio and keeps a real one')
    out = ep.postprocess_extraction({'doc_category': 'LOAN_TRANSFER',
                                     'folio_parcel': '01-3124-020-0340'})
    check('  echo -> None', out['folio_parcel'], None)
    out = ep.postprocess_extraction({'doc_category': 'LOAN_TRANSFER',
                                     'folio_parcel': ' 04-3002-185-0010 '})
    check('  real folio kept (stripped)', out['folio_parcel'], '04-3002-185-0010')

    print('3. request parameters per model family')
    check('  gpt-5-nano', ep.model_request_params('gpt-5-nano'),
          {'max_completion_tokens': 4096, 'reasoning_effort': 'minimal'})
    check('  gpt-5-nano-2025-08-07 (dated snapshot)',
          ep.model_request_params('gpt-5-nano-2025-08-07'),
          {'max_completion_tokens': 4096, 'reasoning_effort': 'minimal'})
    check('  gpt-5.4-nano', ep.model_request_params('gpt-5.4-nano'),
          {'max_completion_tokens': 4096, 'reasoning_effort': 'none', 'temperature': 0})
    check('  gpt-4.1-mini keeps the old shape', ep.model_request_params('gpt-4.1-mini'),
          {'max_tokens': 4096, 'temperature': 0})

    print('4. the shared request body and the budget prices')
    body = ep.chat_completion_body('some ocr text', ep.SYSTEM_PROMPT)
    caps = [k for k in ('max_tokens', 'max_completion_tokens') if k in body]
    check('  exactly one output cap', len(caps), 1)
    check('  cap is 4096', body[caps[0]], 4096)
    check('  json_object response format', body['response_format'], {'type': 'json_object'})
    check('  body model is the configured model', body['model'], ep.OPENAI_MODEL)
    check('  the prompt no longer carries the example folio',
          '01-3124-020-0340' in ep.SYSTEM_PROMPT, False)
    check('  gpt-5-nano prices', ep.model_prices('gpt-5-nano'), (0.05, 0.40))
    check('  gpt-5.4-nano prices', ep.model_prices('gpt-5.4-nano'), (0.20, 1.25))
    check('  unknown model -> dearest row', ep.model_prices('gpt-9-nano'), (0.20, 1.25))
    check('  module prices follow OPENAI_MODEL',
          (ep.PRICE_INPUT_PER_M, ep.PRICE_OUTPUT_PER_M), ep.model_prices(ep.OPENAI_MODEL))

    print()
    if failures:
        print(f'❌ {len(failures)} check(s) failed')
        return 1
    print('✅ all checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
