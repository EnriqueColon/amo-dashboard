"""Signed-in Miami-Dade Clerk OCS session for the foreclosure-complaints pipeline.

Login is a plain form on the Clerk's user-management site (no captcha on that page):
POST /usermanagementservices/Home/LoginOrRegister with userName, password and
ApplicationCallID=OCS, then it redirects back into /ocs. Credentials come from the
environment (CLERK_OCS_USER / CLERK_OCS_PASS, in /opt/amo-dashboard/.env); they are
never logged. See docs/MIAMI_DADE_COMPLAINTS_REVERSE_ENGINEERING.md section 18.

Usage (check only): python clerk_session.py
"""
import os
import sys

import requests
import proxy_config
import stealth_pool

BASE = "https://www2.miamidadeclerk.gov"
UMS = f"{BASE}/usermanagementservices"


def login(user: str | None = None, password: str | None = None) -> requests.Session:
    user = user or os.environ.get("CLERK_OCS_USER")
    password = password or os.environ.get("CLERK_OCS_PASS")
    if not user or not password:
        raise RuntimeError("CLERK_OCS_USER / CLERK_OCS_PASS are not set")
    s = requests.Session()
    proxy_config.apply_to_requests_session(s, session_key="miami_dade_ocs")
    s.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    r0 = s.get(f"{UMS}/?hs=OCS", timeout=30)
    if stealth_pool.is_captcha_or_block_response(r0.status_code, r0.text):
        stealth_pool.refresh_requests_session_sync(s, f"{UMS}/?hs=OCS")
    r = s.post(f"{UMS}/Home/LoginOrRegister", timeout=30, allow_redirects=True,
               data={"ApplicationCallID": "OCS", "userName": user,
                     "password": password, "ServicesType": "Individual", "btnCall": "Login"})
    if stealth_pool.is_captcha_or_block_response(r.status_code, r.text):
        stealth_pool.refresh_requests_session_sync(s, f"{UMS}/?hs=OCS")
        r = s.post(f"{UMS}/Home/LoginOrRegister", timeout=30, allow_redirects=True,
                   data={"ApplicationCallID": "OCS", "userName": user,
                         "password": password, "ServicesType": "Individual", "btnCall": "Login"})
    r.raise_for_status()
    s.get(f"{BASE}/ocs/", timeout=30)
    if not is_logged_in(s):
        raise RuntimeError("Clerk sign-in did not produce a signed-in OCS session")
    return s


def is_logged_in(s: requests.Session) -> bool:
    r = s.get(f"{BASE}/ocs/api/settings/loggedin", timeout=30)
    return r.ok and r.text.strip().lower() == "true"


if __name__ == "__main__":
    try:
        sess = login()
    except Exception as e:  # report the reason, never the credentials
        print(f"LOGIN FAILED: {e}")
        sys.exit(1)
    print("LOGIN OK: signed-in OCS session")
