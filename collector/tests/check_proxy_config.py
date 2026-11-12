"""
Guardrail & verification suite for `collector/proxy_config.py`.

Asserts:
  1. Direct mode when no proxy env vars are set.
  2. Component mode (`IPROYAL_USER` + `IPROYAL_PASS`) builds a sticky Florida
     residential proxy URL (`_country-us_state-florida_session-<8hex>_lifetime-30m@geo.iproyal.com:12321`).
  3. Full URL mode (`IPROYAL_PROXY_URL` and `STEALTH_PROXY_POOL`).
  4. Credential masking (`mask_proxy_url`) never leaks usernames or passwords in logs.
  5. `apply_to_requests_session` and `playwright_proxy_dict` produce the exact
     structures expected by `requests.Session` and Playwright / `StealthBrowserPool`.

Run:
    collector/.venv/bin/python3 collector/tests/check_proxy_config.py
"""

import os
import sys
from typing import Any, List
import requests

COLLECTOR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, COLLECTOR_DIR)

import proxy_config  # noqa: E402
import stealth_pool  # noqa: E402

failures: List[str] = []


def check(label: str, got: Any, want: Any) -> None:
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures.append(label)


def clear_proxy_env() -> None:
    os.environ["PROXY_CONFIG_IGNORE_DOTENV"] = "1"
    for k in (
        "IPROYAL_PROXY_URL",
        "STEALTH_PROXY_POOL",
        "IPROYAL_USER",
        "IPROYAL_PASS",
        "IPROYAL_HOST",
        "IPROYAL_PORT",
        "IPROYAL_COUNTRY",
        "IPROYAL_STATE",
        "IPROYAL_LIFETIME",
        "PROXY_SESSION_KEYS",
    ):
        os.environ.pop(k, None)


def run_tests() -> None:
    print("1. Testing unconfigured (direct) state...")
    clear_proxy_env()
    check("build_proxy_url is None when unconfigured", proxy_config.build_proxy_url(), None)
    check("requests_proxies is None when unconfigured", proxy_config.requests_proxies(), None)
    check("playwright_proxy_dict is None when unconfigured", proxy_config.playwright_proxy_dict(), None)

    print("\n2. Testing IPRoyal component env vars (IPROYAL_USER + IPROYAL_PASS)...")
    os.environ["IPROYAL_USER"] = "testuser123"
    os.environ["IPROYAL_PASS"] = "secretpass456"
    os.environ["PROXY_SESSION_KEYS"] = "hillsborough,amo"  # opt these keys in for the structure checks
    url = proxy_config.build_proxy_url(session_key="hillsborough")
    check("Starts with http://testuser123:", url is not None and url.startswith("http://testuser123:"), True)
    check("Includes Florida targeting and 30m sticky lifetime", "_country-us_state-florida_session-" in (url or "") and "_lifetime-30m@geo.iproyal.com:12321" in (url or ""), True)

    masked = proxy_config.mask_proxy_url(url)
    check("mask_proxy_url hides username and password", "testuser123" not in masked and "secretpass456" not in masked, True)
    check("mask_proxy_url preserves host and port", masked, "http://***:***@geo.iproyal.com:12321")

    s = requests.Session()
    applied = proxy_config.apply_to_requests_session(s, session_key="hillsborough")
    check("apply_to_requests_session sets https proxy", s.proxies.get("https"), url)
    check("apply_to_requests_session returns masked string", applied, "http://***:***@geo.iproyal.com:12321")

    pw_dict = proxy_config.playwright_proxy_dict(session_key="hillsborough")
    check("playwright_proxy_dict server", pw_dict and pw_dict.get("server"), "http://geo.iproyal.com:12321")
    check("playwright_proxy_dict username", pw_dict and pw_dict.get("username"), "testuser123")
    check("playwright_proxy_dict password has sticky state", pw_dict is not None and "_state-florida_" in pw_dict.get("password", ""), True)

    # Verify StealthBrowserPool picks up IPRoyal component vars automatically
    pool_list = stealth_pool._parse_env_proxy_pool()
    check("StealthBrowserPool._parse_env_proxy_pool inherits IPRoyal config", pool_list is not None and len(pool_list) == 1, True)

    print("\n3. Testing explicit IPROYAL_PROXY_URL override...")
    clear_proxy_env()
    os.environ["IPROYAL_PROXY_URL"] = "http://myuser:mypass_country-us_state-florida@geo.iproyal.com:12321"
    check(
        "Explicit IPROYAL_PROXY_URL used verbatim",
        proxy_config.build_proxy_url(),
        "http://myuser:mypass_country-us_state-florida@geo.iproyal.com:12321",
    )
    clear_proxy_env()

    print("\n4. Proxy is opt-in per session key (12 Nov 2026 incident: IPRoyal refuses .gov)...")
    os.environ["IPROYAL_USER"] = "testuser123"
    os.environ["IPROYAL_PASS"] = "secretpass456"
    check("default: leon_courts uses the proxy", proxy_config.requests_proxies("leon_courts") is not None, True)
    for key in ("miami_dade_or", "miami_dade_ocs", "duval_core", "hillsborough_civil", "nyc_acris", "amo"):
        check(f"default: {key} connects directly", proxy_config.requests_proxies(key), None)
    check("default: Miami-Dade Playwright session connects directly", proxy_config.playwright_proxy_dict("miami_dade_or"), None)
    s = requests.Session()
    check("apply_to_requests_session returns None for Miami-Dade", proxy_config.apply_to_requests_session(s, session_key="miami_dade_ocs"), None)
    check("...and leaves the session without a proxy", s.proxies.get("https"), None)
    os.environ["PROXY_SESSION_KEYS"] = "duval_core"
    check("PROXY_SESSION_KEYS overrides the default (duval in)", proxy_config.requests_proxies("duval_core") is not None, True)
    check("PROXY_SESSION_KEYS overrides the default (leon out)", proxy_config.requests_proxies("leon_courts"), None)
    clear_proxy_env()


if __name__ == "__main__":
    run_tests()
    if failures:
        print(f"\nFAILED ({len(failures)}): {', '.join(failures)}")
        sys.exit(1)
    print("\nALL PROXY CONFIG CHECKS PASSED")
