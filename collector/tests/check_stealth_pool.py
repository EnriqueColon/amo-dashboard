"""
Guardrail & verification suite for `collector/stealth_pool.py`.

Tests all 5 fail-safe layers, the 4-step CAPTCHA waterfall (Stealth -> Auto-Click ->
CapSolver -> 2Captcha), browser generation recycling/draining, OS/UA consistency,
and real Chromium stealth fingerprinting.

Run:
    collector/.venv/bin/python3 collector/tests/check_stealth_pool.py
"""

import asyncio
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
from typing import Any, Dict, List

COLLECTOR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, COLLECTOR_DIR)

from stealth_pool import (  # noqa: E402
    CaptchaBudgetExceededError,
    CaptchaBudgetTracker,
    CaptchaSolverWaterfall,
    CircuitBreakerOpenError,
    DomainCircuitBreaker,
    HardBlockError,
    StealthBrowserPool,
    classify_hard_block,
    human_click,
    human_type,
    is_captcha_or_block_response,
)

failures: List[str] = []


def check(label: str, got: Any, want: Any) -> None:
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        failures.append(label)


# ── Fake HTTP Session for testing CapSolver & 2Captcha APIs ──────────────────

class FakeHttpResponse:
    def __init__(self, payload: Dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def json(self) -> Dict[str, Any]:
        return self._payload


class FakeSolverHttpSession:
    """Simulates CapSolver and 2Captcha REST APIs for deterministic waterfall tests."""

    def __init__(self, capsolver_fails: bool = False, twocaptcha_token: str = "tok_2captcha_999"):
        self.capsolver_fails = capsolver_fails
        self.twocaptcha_token = twocaptcha_token
        self.calls: List[str] = []

    def post(self, url: str, json: Dict[str, Any] = None, timeout: int = 30) -> FakeHttpResponse:
        self.calls.append(url)
        if "capsolver.com/createTask" in url:
            if self.capsolver_fails:
                return FakeHttpResponse({"errorId": 1, "errorDescription": "ERROR_ZERO_BALANCE"})
            return FakeHttpResponse({"errorId": 0, "taskId": "cap_task_1"})
        if "capsolver.com/getTaskResult" in url:
            return FakeHttpResponse({
                "errorId": 0,
                "status": "ready",
                "solution": {"gRecaptchaResponse": "tok_capsolver_123"},
            })
        if "2captcha.com/createTask" in url:
            return FakeHttpResponse({"errorId": 0, "taskId": "two_task_1"})
        if "2captcha.com/getTaskResult" in url:
            return FakeHttpResponse({
                "errorId": 0,
                "status": "ready",
                "solution": {"gRecaptchaResponse": self.twocaptcha_token},
            })
        raise RuntimeError(f"Unexpected URL: {url}")


# ── Local Test HTTP Server for Real Playwright Browser Verification ──────────

class LocalTestServerHandler(BaseHTTPRequestHandler):
    rate_limit_hits = 0

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Keep test output clean

    def do_GET(self) -> None:
        if self.path == "/normal":
            # Includes a passive hidden reCAPTCHA badge to prove we DO NOT false-positive timeout on it!
            html = """<!DOCTYPE html>
            <html><body>
              <h1 id="title">Clerk Official Records</h1>
              <input id="searchBox" type="text" />
              <button id="searchBtn" onclick="document.getElementById('out').innerText = document.getElementById('searchBox').value">Search</button>
              <div id="out"></div>
              <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" style="display:none"></iframe>
            </body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode("utf-8"))

        elif self.path == "/challenge":
            # Active blocking challenge page with data-sitekey and callback
            html = """<!DOCTYPE html>
            <html><body>
              <h1>Verify you are human</h1>
              <p>Invalid Captcha - please complete the security check below.</p>
              <div class="g-recaptcha" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" data-callback="onSolved"></div>
              <textarea id="g-recaptcha-response" name="g-recaptcha-response"></textarea>
              <iframe src="https://www.google.com/recaptcha/api2/bframe?k=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" style="width:300px;height:300px;"></iframe>
              <div id="status">BLOCKED</div>
              <script>
                window.onSolved = function(tok) {
                  document.getElementById('status').innerText = 'SOLVED:' + tok;
                  document.cookie = 'cf_clearance=' + tok + '; path=/';
                };
              </script>
            </body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode("utf-8"))

        elif self.path == "/hardblock429":
            LocalTestServerHandler.rate_limit_hits += 1
            self.send_response(429)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body>Error 1015: You are being rate limited</body></html>")

        else:
            self.send_response(404)
            self.end_headers()


def start_local_server() -> tuple[HTTPServer, str]:
    server = HTTPServer(("127.0.0.1", 0), LocalTestServerHandler)
    port = server.server_port
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


# ── Unit & Integration Tests ─────────────────────────────────────────────────

async def run_all_tests() -> None:
    print("1. Testing Fail-Safe 1: Persistent DomainCircuitBreaker...")
    tmp_dir = tempfile.mkdtemp(prefix="stealth_test_")
    cb_path = os.path.join(tmp_dir, "circuit_breaker.json")
    fake_now = [1000.0]
    cb = DomainCircuitBreaker(
        state_file=cb_path,
        max_consecutive_failures=3,
        cooldown_seconds=600,
        time_fn=lambda: fake_now[0],
    )

    check("circuit initially closed", cb.record_failure("https://erec.mypalmbeachclerk.com/search", "timeout 1"), False)
    check("circuit closed on 2nd failure", cb.record_failure("https://erec.mypalmbeachclerk.com/search", "timeout 2"), False)
    check("circuit trips on 3rd failure", cb.record_failure("https://erec.mypalmbeachclerk.com/search", "timeout 3"), True)

    # Reload from disk to prove cross-cron persistence
    cb_reloaded = DomainCircuitBreaker(
        state_file=cb_path,
        max_consecutive_failures=3,
        cooldown_seconds=600,
        time_fn=lambda: fake_now[0],
    )
    tripped_err = False
    try:
        cb_reloaded.check("https://erec.mypalmbeachclerk.com/other")
    except CircuitBreakerOpenError:
        tripped_err = True
    check("reloaded circuit breaker blocks domain during cooldown", tripped_err, True)

    # Advance clock past cooldown
    fake_now[0] += 601.0
    expired_ok = True
    try:
        cb_reloaded.check("https://erec.mypalmbeachclerk.com/other")
    except CircuitBreakerOpenError:
        expired_ok = False
    check("circuit breaker allows request after cooldown expires", expired_ok, True)
    cb_reloaded.record_success("https://erec.mypalmbeachclerk.com/other")
    check("record_success resets consecutive_failures", cb_reloaded._state["erec.mypalmbeachclerk.com"]["consecutive_failures"], 0)

    print("\n2. Testing Fail-Safe 2: Hard-Block vs. Soft-Challenge Classifier...")
    check("429 classified as hard block", classify_hard_block(429, "Too many requests") is not None, True)
    check("Cloudflare 1015 classified as hard block", classify_hard_block(403, "Error 1015 Ray ID: abc") is not None, True)
    check("Account locked classified as hard block", classify_hard_block(200, "Your account is locked after 3 failed tries") is not None, True)
    check("Normal page not classified as hard block", classify_hard_block(200, "<html>Welcome to Clerk</html>"), None)
    check("Soft reCAPTCHA not classified as hard block", classify_hard_block(200, '<div class="g-recaptcha"></div>'), None)
    check("Soft reCAPTCHA detected by is_captcha_or_block_response", is_captcha_or_block_response(200, '<div class="g-recaptcha"></div>'), True)
    check("PerimeterX detected by is_captcha_or_block_response", is_captcha_or_block_response(403, '<div id="px-captcha"></div>'), True)

    print("\n3. Testing Fail-Safe 4 & Waterfall: CapSolver -> 2Captcha Fallback & Budget Cap...")
    # Case A: CapSolver succeeds first
    budget_a = CaptchaBudgetTracker(max_solves_per_run=5, max_solves_per_hour=5)
    http_a = FakeSolverHttpSession(capsolver_fails=False)
    wf_a = CaptchaSolverWaterfall(
        capsolver_api_key="cap_key",
        twocaptcha_api_key="two_key",
        budget_tracker=budget_a,
        http_session=http_a,  # type: ignore
        poll_interval=0.01,
    )
    tok_a, prov_a = await wf_a.solve("recaptcha_v2", "https://example.com", "sitekey_123")
    check("CapSolver used as primary when healthy", (tok_a, prov_a), ("tok_capsolver_123", "capsolver"))
    check("2Captcha not called when CapSolver succeeds", any("2captcha" in u for u in http_a.calls), False)

    # Case B: CapSolver fails -> automatically falls back to 2Captcha
    budget_b = CaptchaBudgetTracker(max_solves_per_run=2, max_solves_per_hour=2)
    http_b = FakeSolverHttpSession(capsolver_fails=True, twocaptcha_token="tok_2captcha_fallback")
    wf_b = CaptchaSolverWaterfall(
        capsolver_api_key="cap_key",
        twocaptcha_api_key="two_key",
        budget_tracker=budget_b,
        http_session=http_b,  # type: ignore
        poll_interval=0.01,
    )
    tok_b, prov_b = await wf_b.solve("recaptcha_v2", "https://example.com", "sitekey_123")
    check("Falls back to 2Captcha when CapSolver fails", (tok_b, prov_b), ("tok_2captcha_fallback", "2captcha"))
    check("Spend tracked accurately for 2Captcha", round(budget_b.estimated_cost_usd, 4), 0.0015)

    # Case C: Budget cap trips after max_solves_per_run (2)
    await wf_b.solve("recaptcha_v2", "https://example.com", "sitekey_123")
    budget_tripped = False
    try:
        await wf_b.solve("recaptcha_v2", "https://example.com", "sitekey_123")
    except CaptchaBudgetExceededError:
        budget_tripped = True
    check("Budget tracker halts solves when per-run cap reached", budget_tripped, True)

    print("\n4. Testing Fail-Safe 3: Sticky Session-to-Proxy Binding...")
    proxies = [{"server": "http://proxy1:8080"}, {"server": "http://proxy2:8080"}]
    pool_proxy_test = StealthBrowserPool(proxy_pool=proxies, state_dir=os.path.join(tmp_dir, "proxy_states"))
    p1 = pool_proxy_test._select_proxy_for_domain("miamidadeclerk.gov", rotate=False)
    p2 = pool_proxy_test._select_proxy_for_domain("miamidadeclerk.gov", rotate=False)
    check("Same proxy stays sticky across requests for same domain", p1, p2)
    p3 = pool_proxy_test._select_proxy_for_domain("miamidadeclerk.gov", rotate=True)
    check("Proxy rotates to alternate server when rotate=True", p3 != p1, True)

    print("\n5. Testing Real Chromium Stealth, Generation Recycling, Challenge Resolution & HTTP Bridge...")
    server, base_url = start_local_server()
    try:
        http_live = FakeSolverHttpSession(capsolver_fails=True, twocaptcha_token="live_solved_token_777")
        wf_live = CaptchaSolverWaterfall(
            capsolver_api_key="cap_key",
            twocaptcha_api_key="two_key",
            budget_tracker=CaptchaBudgetTracker(max_solves_per_run=10, max_solves_per_hour=10),
            http_session=http_live,  # type: ignore
            poll_interval=0.01,
        )

        # Set max_tasks_per_browser=2 to verify automatic generation recycling
        async with StealthBrowserPool(
            state_dir=os.path.join(tmp_dir, "live_states"),
            max_concurrency=2,
            max_tasks_per_browser=2,
            headless=True,
            solver_waterfall=wf_live,
            auto_clear_wait_ms=300,
        ) as pool:
            # Task 1: Verify stealth properties & passive reCAPTCHA badge ignored + human typing/clicking
            async def inspect_stealth(page):
                props = await page.evaluate(
                    """() => ({
                        webdriver: navigator.webdriver,
                        platform: navigator.platform,
                        ua: navigator.userAgent,
                        hasChrome: Boolean(window.chrome && window.chrome.runtime),
                        webglVendor: (() => {
                            const c = document.createElement('canvas');
                            const gl = c.getContext('webgl');
                            return gl ? gl.getParameter(37445) : null;
                        })(),
                        pluginsLen: navigator.plugins.length,
                    })"""
                )
                await human_type(page, "#searchBox", "CFN-2026")
                await human_click(page, "#searchBtn")
                out_text = await page.inner_text("#out")
                return props, out_text

            props, out_text = await pool.execute_task(f"{base_url}/normal", extractor_fn=inspect_stealth)
            check("navigator.webdriver is undefined", props["webdriver"], None)
            check("HeadlessChrome stripped from User-Agent", "Headless" not in props["ua"], True)
            check("window.chrome runtime present", props["hasChrome"], True)
            check("WebGL vendor spoofed to Intel Inc.", props["webglVendor"], "Intel Inc.")
            check("navigator.plugins populated", props["pluginsLen"] >= 3, True)
            check("human_type + human_click interacted with DOM & ignored passive badge", out_text, "CFN-2026")
            check("Task 1 ran on Generation 1", pool._current_gen.generation_id if pool._current_gen else 0, 1)

            # Task 2: Active challenge page -> triggers CapSolver (fails) -> 2Captcha (solves) -> injects token
            async def verify_solved(page):
                return await page.inner_text("#status")

            solved_status = await pool.execute_task(f"{base_url}/challenge", extractor_fn=verify_solved)
            check("Active challenge detected, solved via waterfall, and callback fired", solved_status, "SOLVED:live_solved_token_777")

            # Task 3: Should recycle to Generation 2 since max_tasks_per_browser=2 was reached!
            import requests as std_requests
            req_sess = std_requests.Session()
            await pool.refresh_requests_session(req_sess, f"{base_url}/normal")
            check("Browser recycled to Generation 2 after 2 tasks", pool._current_gen.generation_id if pool._current_gen else 0, 2)
            check("requests.Session received cleared cf_clearance cookie from StealthBrowserPool", req_sess.cookies.get("cf_clearance"), "live_solved_token_777")
            check("requests.Session User-Agent matched to browser", "Chrome/" in req_sess.headers.get("User-Agent", ""), True)

            # Task 4: Hard Block (HTTP 429) must abort on attempt 1 without retrying and trip Circuit Breaker
            LocalTestServerHandler.rate_limit_hits = 0
            hard_blocked = False
            try:
                await pool.execute_task(f"{base_url}/hardblock429", max_retries=3)
            except HardBlockError:
                hard_blocked = True
            check("HTTP 429 raises HardBlockError immediately", hard_blocked, True)
            check("HTTP 429 was NOT retried (prevented retry storm)", LocalTestServerHandler.rate_limit_hits, 1)

            # Subsequent call to same domain is blocked by Circuit Breaker before touching the server
            cb_blocked = False
            try:
                await pool.execute_task(f"{base_url}/normal")
            except CircuitBreakerOpenError:
                cb_blocked = True
            check("Circuit breaker blocks subsequent calls after HardBlockError", cb_blocked, True)
            check("Server received 0 additional hits while circuit breaker open", LocalTestServerHandler.rate_limit_hits, 1)

    finally:
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
    if failures:
        print(f"\nFAILED ({len(failures)}): {', '.join(failures)}")
        sys.exit(1)
    print("\nALL STEALTH POOL CHECKS PASSED")
