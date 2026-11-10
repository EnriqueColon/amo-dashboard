"""
Optional IPRoyal / HTTP proxy configuration for collector sessions (`proxy_config.py`).

Supports two ways to configure IPRoyal in `.env` (never logged, never committed):

  Option A — Full proxy URL (`IPROYAL_PROXY_URL` or first entry in `STEALTH_PROXY_POOL`):
    IPROYAL_PROXY_URL="http://USER:PASS_country-us_state-florida_session-amo1_lifetime-30m@geo.iproyal.com:12321"

  Option B — Component variables (builds the sticky Florida residential URL automatically):
    IPROYAL_USER="your_proxy_username"
    IPROYAL_PASS="your_proxy_password"
    IPROYAL_HOST="geo.iproyal.com"        # default: geo.iproyal.com
    IPROYAL_PORT="12321"                  # default: 12321
    IPROYAL_STATE="florida"               # default: florida
    IPROYAL_LIFETIME="30m"                # default: 30m

Usage:
  python proxy_config.py --check          # prints masked status (never prints credentials)
  python proxy_config.py --test           # checks outbound IP/state via https://ipv4.icanhazip.com
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import quote, urlparse, urlunparse

import requests


_DOTENV_LOADED = False


def load_dotenv_if_present(env_path: Optional[str] = None) -> None:
    """
    Loads `.env` directly in Python once at startup (without shell expansion) so
    special characters like `!` or `$` in passwords are never mangled by bash/zsh.
    """
    global _DOTENV_LOADED
    if _DOTENV_LOADED and env_path is None:
        return
    _DOTENV_LOADED = True
    if os.environ.get("PROXY_CONFIG_IGNORE_DOTENV") == "1":
        return
    candidates = [
        Path(env_path) if env_path else None,
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",
        Path("/opt/amo-dashboard/.env"),
    ]
    for p in candidates:
        if p and p.is_file():
            for raw_line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].strip()
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                    v = v[1:-1]
                os.environ.setdefault(k, v)
            break


def build_proxy_url(session_key: str = "amo") -> Optional[str]:
    """
    Returns the configured HTTP/HTTPS proxy URL from environment variables, or
    None if no proxy is configured.
    """
    load_dotenv_if_present()
    explicit = (
        os.environ.get("IPROYAL_PROXY_URL", "").strip()
        or os.environ.get("STEALTH_PROXY_POOL", "").split(",")[0].strip()
    )
    if explicit:
        if "://" not in explicit:
            explicit = f"http://{explicit}"
        return explicit

    user = os.environ.get("IPROYAL_USER", "").strip()
    pw = os.environ.get("IPROYAL_PASS", "").strip()
    if not user or not pw:
        return None
    # Strip any accidental trailing '!' appended to the 16-char alphanumeric IPRoyal proxy password
    if len(pw) == 17 and pw.endswith("!") and pw[:-1].isalnum():
        pw = pw[:-1]

    host = os.environ.get("IPROYAL_HOST", "geo.iproyal.com").strip() or "geo.iproyal.com"
    port = os.environ.get("IPROYAL_PORT", "12321").strip() or "12321"
    country = os.environ.get("IPROYAL_COUNTRY", "us").strip() or "us"
    state = os.environ.get("IPROYAL_STATE", "florida").strip() or "florida"
    lifetime = os.environ.get("IPROYAL_LIFETIME", "30m").strip() or "30m"

    # IPRoyal requires an 8-character alphanumeric session id when _session- is used
    sid = hashlib.md5(session_key.encode("utf-8")).hexdigest()[:8]

    # If the user already included _country- in IPROYAL_PASS, keep it as-is
    if "_country-" in pw:
        formatted_pw = pw
    else:
        formatted_pw = f"{pw}_country-{country}_state-{state}_session-{sid}_lifetime-{lifetime}"

    safe_user = quote(user, safe="_-")
    safe_pw = quote(formatted_pw, safe="_-")
    return f"http://{safe_user}:{safe_pw}@{host}:{port}"


def mask_proxy_url(url: Optional[str]) -> str:
    """Returns a safe-to-log version of `url` with username/password redacted."""
    if not url:
        return "none (direct connection)"
    parsed = urlparse(url)
    host_port = f"{parsed.hostname}:{parsed.port}" if parsed.port else (parsed.hostname or "")
    if parsed.username or parsed.password:
        return urlunparse((parsed.scheme, f"***:***@{host_port}", parsed.path, "", "", ""))
    return urlunparse((parsed.scheme, host_port, parsed.path, "", "", ""))


def requests_proxies(session_key: str = "amo") -> Optional[Dict[str, str]]:
    """Returns `{'http': url, 'https': url}` for `requests.Session.proxies`, or None."""
    url = build_proxy_url(session_key=session_key)
    if not url:
        return None
    return {"http": url, "https": url}


def apply_to_requests_session(
    session: requests.Session, session_key: str = "amo", enabled: bool = True
) -> Optional[str]:
    """
    Attaches the configured IPRoyal proxy to `session` if `enabled` is True and
    a proxy is configured in the environment. Returns the masked proxy string
    (or None if direct).
    """
    if not enabled:
        return None
    proxies = requests_proxies(session_key=session_key)
    if not proxies:
        return None
    session.proxies.update(proxies)
    return mask_proxy_url(proxies["https"])


def playwright_proxy_dict(session_key: str = "amo") -> Optional[Dict[str, str]]:
    """
    Returns `{ 'server': 'http://host:port', 'username': ..., 'password': ... }`
    suitable for Playwright `new_context(proxy=...)` or `StealthBrowserPool`.
    """
    url = build_proxy_url(session_key=session_key)
    if not url:
        return None
    parsed = urlparse(url)
    if not parsed.hostname:
        return None
    server = f"{parsed.scheme or 'http'}://{parsed.hostname}"
    if parsed.port:
        server = f"{server}:{parsed.port}"
    out: Dict[str, str] = {"server": server}
    if parsed.username:
        out["username"] = parsed.username
    if parsed.password:
        out["password"] = parsed.password
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Check or test IPRoyal proxy configuration")
    ap.add_argument("--check", action="store_true", help="Print masked proxy configuration status")
    ap.add_argument("--test", action="store_true", help="Verify outbound IP through the configured proxy")
    args = ap.parse_args()

    url = build_proxy_url()
    print(f"Configured proxy: {mask_proxy_url(url)}")
    if not url:
        print(
            "No proxy configured. Set IPROYAL_PROXY_URL (or IPROYAL_USER + IPROYAL_PASS) in .env."
        )
        if args.test:
            sys.exit(1)
        return

    if args.test:
        s = requests.Session()
        apply_to_requests_session(s)
        try:
            r = s.get("https://ipv4.icanhazip.com", timeout=20)
            r.raise_for_status()
            print(f"PROXY OK: outbound IP is {r.text.strip()}")
        except Exception as e:
            print(f"PROXY FAILED: {type(e).__name__}")
            sys.exit(1)


if __name__ == "__main__":
    main()
