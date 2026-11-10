"""Signed-in Duval Clerk CORE session for the foreclosure-complaints pipeline.

CORE (https://core.duvalclerk.com) is an ASP.NET AJAX app. After sign-in the server hands back a
session token; every later call is a JSON POST to /internal/CoreWebSvc.asmx/<Method> carrying that
token, and the page HTML for a search or a case comes back inside the JSON as `BodyHtml`. Documents are
plain GETs of /court/case/<caseID>/docket/<docID>/content.pdf with the session cookie.

Sign-in is the same call the site's own login form makes (InteractiveLogin); there is no captcha on it.
Credentials come from the environment (DUVAL_CORE_USER / DUVAL_CORE_PASS, in /opt/amo-dashboard/.env)
and are never logged.

The server can answer any call with a reCAPTCHA "Bot Check" (CaptchaChallenge). This client never
solves or works around one: it raises BotCheckError and the run stops. See
docs/DUVAL_COMPLAINTS.md.

Usage (check only):  DUVAL_CORE_USER=... DUVAL_CORE_PASS=... python duval_session.py
"""
import os
import re
import sys
import time

import requests
import proxy_config

BASE = "https://core.duvalclerk.com"
SVC = f"{BASE}/internal/CoreWebSvc.asmx"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


class BotCheckError(RuntimeError):
    """The Clerk asked for a reCAPTCHA. We stop; we never solve or bypass it."""


class LoginError(RuntimeError):
    pass


class Core:
    """Signed-in CORE session. Signs in again if the Clerk drops it (LoginOk false / 401)."""

    def __init__(self, user: str | None = None, password: str | None = None):
        self._user = user or os.environ.get("DUVAL_CORE_USER")
        self._pass = password or os.environ.get("DUVAL_CORE_PASS")
        if not self._user or not self._pass:
            raise LoginError("DUVAL_CORE_USER / DUVAL_CORE_PASS are not set")
        self.s = requests.Session()
        proxy_config.apply_to_requests_session(self.s, session_key="duval_core")
        self.s.headers["User-Agent"] = UA
        self.token = ""
        self._tab = 0
        self.login()

    # ------------------------------------------------------------------ sign-in
    def login(self) -> None:
        self.s.get(f"{BASE}/CoreCms.aspx", timeout=60)
        r = self.s.post(f"{SVC}/InteractiveLogin", timeout=60, json={
            "username": self._user, "password": self._pass},
            headers={"Content-Type": "application/json; charset=utf-8"})
        r.raise_for_status()
        d = r.json().get("d") or {}
        if not d.get("LoginSuccess") or not d.get("Token"):
            # report the reason the site gives, never the credentials
            raise LoginError(f"CORE sign-in refused (AccessType={d.get('AccessType')!r})")
        self.token = d["Token"]
        self.access_type = d.get("AccessType")
        # The site's own page script (persistToCookieBackup) stores the login in cookies after a successful sign-in,
        # and the document handler may read them. A browser has them; a bare HTTP session does not, so set the same ones.
        for name, value in (("displayName", d.get("DisplayName") or ""), ("accessType", self.access_type or ""),
                            ("token", self.token), ("isPublicComputer", "false")):
            self.s.cookies.set(name, value, domain="core.duvalclerk.com", path="/")

    # ------------------------------------------------------------------ calls
    def _next_tab(self) -> int:
        self._tab += 1
        return 100 + self._tab

    def _svc(self, method: str, body: dict) -> dict:
        """POST one CoreWebSvc method; returns the CoreWebTabPackage dict. Raises BotCheckError on a captcha."""
        for attempt in range(3):
            payload = {"token": self.token, "returnTabId": self._next_tab(), **body}
            r = self.s.post(f"{SVC}/{method}", json=payload, timeout=120,
                            headers={"Content-Type": "application/json; charset=utf-8"})
            if r.status_code in (401, 403) or (r.status_code == 500 and attempt == 0 and "Authentication" in r.text):
                self.login()
                continue
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            d = r.json().get("d") or {}
            if d.get("CaptchaChallenge"):
                raise BotCheckError(f"{method}: the Clerk returned a reCAPTCHA Bot Check; stopping, not solving it")
            if d.get("LoginOk") is False:
                self.login()
                continue
            return d
        raise RuntimeError(f"{method}: no usable response after 3 attempts")

    def search(self, case_type: str, case_type_list: str, file_date: str) -> dict:
        """First page of a Circuit Civil search. file_date is 'MM/DD/YYYY-MM/DD/YYYY'."""
        return self._svc("CaseSearchBegin", {
            "inputs": {"__type": "DuvalClerk.Web.Core.UserSearchInput", "CaseType": case_type,
                       "CaseTypeList": case_type_list, "UseNamePhoneticMatchOption": False,
                       "UseNameBeginsWithOption": True, "FileDate": file_date, "CaseMemberFilter": ""},
            "captcha": "captchaPH"})

    def search_page(self, request_state: str, page: int) -> dict:
        return self._svc("CaseSearchUpdate", {
            "operation": f"page:{page}", "requestState": request_state, "captcha": "captchaPH"})

    def case(self, case_id: int | str) -> dict:
        return self._svc("GetCaseById", {"caseID": int(case_id), "simCtrl": 0})

    def pdf(self, href: str) -> bytes:
        """Fetch a document by the /court/case/.../content.pdf path taken from the case page."""
        hdr = {"Referer": f"{BASE}/CoreCms.aspx", "Accept": "application/pdf,*/*"}
        r = self.s.get(f"{BASE}{href}", timeout=180, headers=hdr)
        if r.status_code in (401, 403) or not r.content.startswith(b"%PDF"):
            self.login()
            r = self.s.get(f"{BASE}{href}", timeout=180, headers=hdr)
        r.raise_for_status()
        if not r.content.startswith(b"%PDF"):
            sample = re.sub(r"\s+", " ", r.text[:300]) if "text" in r.headers.get("Content-Type", "") or r.content[:1] == b"<" else repr(r.content[:40])
            raise RuntimeError(f"document request did not return a PDF: HTTP {r.status_code}, "
                               f"content-type {r.headers.get('Content-Type')!r}, final URL {r.url}, "
                               f"redirects {[h.status_code for h in r.history]}, starts: {sample}")
        return r.content


if __name__ == "__main__":
    try:
        c = Core()
    except Exception as e:  # report the reason, never the credentials
        print(f"LOGIN FAILED: {e}")
        sys.exit(1)
    print(f"LOGIN OK: signed-in CORE session (access type: {c.access_type})")
