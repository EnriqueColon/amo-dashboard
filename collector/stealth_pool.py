"""
StealthBrowserPool — Resilient Playwright worker pool with 4-step CAPTCHA
escalation (Stealth -> Auto-Click/Wait -> CapSolver -> 2Captcha) and a 5-layer
anti-blocking fail-safe architecture.

Fail-safes included:
  1. Persistent per-domain Circuit Breaker (`circuit_breaker.json`) — trips after
     N consecutive unresolved challenges or blocks and enters a cooldown window
     instead of hammering the target portal into an IP ban.
  2. Hard-Block vs. Soft-Challenge Classifier — distinguishes solvable challenges
     (reCAPTCHA, Turnstile, PerimeterX) from hard rate-limits/bans (HTTP 429,
     Cloudflare 1015/1006, account lockouts) which abort immediately with zero
     retries.
  3. Sticky Session-to-Proxy Binding — binds a single proxy per domain for session
     continuity and rotates only when a session fails or is retired.
  4. Captcha Solve Rate-Limiter & Budget Cap — enforces per-run and per-hour solve
     ceilings (`CAPTCHA_MAX_SOLVES_PER_RUN`, `CAPTCHA_MAX_SOLVES_PER_HOUR`) so a
     session-cookie rejection loop cannot burn API credits or flood a portal.
  5. Behavioral Telemetry & OS/UA Consistency — strips `--enable-automation`,
     aligns `User-Agent` and `navigator.platform` with the real Chromium binary,
     patches WebGL1/WebGL2/chrome runtime, and provides `human_click` / `human_type`
     with curved mouse movement and realistic keystroke cadence.
"""

import asyncio
import hashlib
import json
import logging
import math
import os
import platform as py_platform
import random
import re
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import requests

# Prefer patchright (binary-patched Playwright without CDP Runtime.enable leaks)
# if installed; fall back cleanly to standard playwright.
try:
    from patchright.async_api import (  # type: ignore
        Browser,
        BrowserContext,
        Page,
        Playwright,
        TimeoutError as PlaywrightTimeoutError,
        async_playwright,
    )
    USING_PATCHRIGHT = True
except ImportError:
    from playwright.async_api import (
        Browser,
        BrowserContext,
        Page,
        Playwright,
        TimeoutError as PlaywrightTimeoutError,
        async_playwright,
    )
    USING_PATCHRIGHT = False

logger = logging.getLogger("StealthWorkerPool")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

ExtractorCallback = Callable[[Page], Coroutine[Any, Any, Any]]


# ── Custom Exceptions ────────────────────────────────────────────────────────

class HardBlockError(RuntimeError):
    """Raised when a target server returns a hard rate-limit, IP ban, or account lock.
    Never retried; immediately trips the domain circuit breaker."""


class CircuitBreakerOpenError(RuntimeError):
    """Raised when a domain is currently in a fail-safe cooldown window."""


class CaptchaBudgetExceededError(RuntimeError):
    """Raised when the per-run or per-hour CAPTCHA solve limit is exceeded."""


# ── Fail-Safe 1: Persistent Per-Domain Circuit Breaker ───────────────────────

class DomainCircuitBreaker:
    """
    Persists per-domain failure counts and cooldown timestamps on disk so both
    in-process retries and subsequent cron invocations respect cooldown windows.
    """

    def __init__(
        self,
        state_file: str,
        max_consecutive_failures: int = 3,
        cooldown_seconds: int = 21600,  # 6 hours default
        time_fn: Callable[[], float] = time.time,
    ):
        self.state_file = state_file
        self.max_consecutive_failures = max_consecutive_failures
        self.cooldown_seconds = cooldown_seconds
        self._time = time_fn
        self._state: Dict[str, Dict[str, Any]] = self._load()

    def _load(self) -> Dict[str, Dict[str, Any]]:
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return data
            except Exception as e:
                logger.warning(f"Could not read circuit breaker state {self.state_file}: {e}")
        return {}

    def _save(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.state_file)), exist_ok=True)
        tmp = f"{self.state_file}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._state, f, indent=2, sort_keys=True)
        os.replace(tmp, self.state_file)

    @staticmethod
    def domain_key(url_or_domain: str) -> str:
        if "://" in url_or_domain:
            return (urlparse(url_or_domain).hostname or url_or_domain).lower()
        return url_or_domain.lower()

    def check(self, url_or_domain: str) -> None:
        """Raises CircuitBreakerOpenError if the domain is in an active cooldown."""
        dom = self.domain_key(url_or_domain)
        entry = self._state.get(dom)
        if not entry:
            return
        cooldown_until = float(entry.get("cooldown_until") or 0.0)
        now = self._time()
        if cooldown_until > now:
            remaining_min = max(1, int((cooldown_until - now) / 60))
            reason = entry.get("last_reason", "repeated blocks/challenges")
            raise CircuitBreakerOpenError(
                f"Circuit breaker OPEN for {dom} ({remaining_min}m remaining in cooldown; "
                f"reason: {reason})"
            )

    def record_success(self, url_or_domain: str) -> None:
        dom = self.domain_key(url_or_domain)
        if dom in self._state:
            self._state[dom] = {
                "consecutive_failures": 0,
                "cooldown_until": 0.0,
                "last_success_at": self._time(),
                "last_reason": None,
            }
            self._save()

    def record_failure(self, url_or_domain: str, reason: str, immediate_trip: bool = False) -> bool:
        """
        Records a failure for `url_or_domain`. Returns True if the circuit breaker tripped.
        """
        dom = self.domain_key(url_or_domain)
        now = self._time()
        entry = self._state.get(dom, {"consecutive_failures": 0, "cooldown_until": 0.0})
        failures = int(entry.get("consecutive_failures", 0)) + 1
        tripped = immediate_trip or (failures >= self.max_consecutive_failures)
        cooldown_until = (now + self.cooldown_seconds) if tripped else 0.0

        self._state[dom] = {
            "consecutive_failures": failures,
            "cooldown_until": cooldown_until,
            "last_failure_at": now,
            "last_reason": reason,
        }
        self._save()

        if tripped:
            logger.error(
                f"[CircuitBreaker] TRIPPED for {dom} after {failures} failure(s) "
                f"(reason: {reason}). Cooling down for {self.cooldown_seconds}s."
            )
        return tripped


# ── Fail-Safe 2: Hard-Block vs. Soft-Challenge Classifier ────────────────────

_HARD_BLOCK_PATTERNS = (
    re.compile(r"error\s*1015", re.I),                   # Cloudflare rate limit
    re.compile(r"error\s*1006", re.I),                   # Cloudflare IP ban
    re.compile(r"error\s*1007", re.I),
    re.compile(r"your\s+ip\s+(address\s+)?has\s+been\s+(blocked|banned)", re.I),
    re.compile(r"account\s+(is\s+)?locked", re.I),
    re.compile(r"maximum\s+login\s+attempts\s+exceeded", re.I),
    re.compile(r"you\s+have\s+been\s+rate\s+limited", re.I),
)

_SOFT_CHALLENGE_PATTERNS = (
    re.compile(r"challenges\.cloudflare\.com", re.I),
    re.compile(r"cf-turnstile", re.I),
    re.compile(r"g-recaptcha", re.I),
    re.compile(r"recaptcha/api2", re.I),
    re.compile(r"recaptcha/enterprise", re.I),
    re.compile(r"px-captcha", re.I),
    re.compile(r"_pxCaptcha", re.I),
    re.compile(r"invalid\s+captcha", re.I),
    re.compile(r"verify\s+you\s+are\s+(a\s+)?human", re.I),
)


def classify_hard_block(status_code: Optional[int], body_text: str) -> Optional[str]:
    """
    Returns a human-readable reason if the response is a HARD block / rate-limit
    that must NOT be retried, or None if it is normal or a solvable soft challenge.
    """
    if status_code == 429:
        return "HTTP 429 Too Many Requests (rate limit)"
    snippet = (body_text or "")[:20000]
    for pat in _HARD_BLOCK_PATTERNS:
        m = pat.search(snippet)
        if m:
            return f"Hard block pattern matched: '{m.group(0)}'"
    return None


def is_captcha_or_block_response(status_code: Optional[int], body_text: str) -> bool:
    """
    Used by HTTP (`requests.Session`) collectors to detect when a response is
    blocked by a CAPTCHA or anti-bot wall and needs `StealthBrowserPool`.
    """
    if classify_hard_block(status_code, body_text):
        return True
    snippet = (body_text or "")[:30000]
    for pat in _SOFT_CHALLENGE_PATTERNS:
        if pat.search(snippet):
            return True
    if status_code in (403, 503) and ("cloudflare" in snippet.lower() or "captcha" in snippet.lower()):
        return True
    return False


# ── Fail-Safe 4: Captcha Solve Rate-Limiter & Budget Tracker ─────────────────

class CaptchaBudgetTracker:
    """
    Enforces per-run and per-hour CAPTCHA solve ceilings and tracks estimated USD cost.
    """

    PRICE_PER_SOLVE = {
        "capsolver": 0.0008,   # $0.80 / 1,000 solves
        "2captcha": 0.0015,    # $1.50 / 1,000 solves
    }

    def __init__(
        self,
        max_solves_per_run: Optional[int] = None,
        max_solves_per_hour: Optional[int] = None,
        time_fn: Callable[[], float] = time.time,
    ):
        self.max_solves_per_run = (
            max_solves_per_run
            if max_solves_per_run is not None
            else int(os.environ.get("CAPTCHA_MAX_SOLVES_PER_RUN", "20"))
        )
        self.max_solves_per_hour = (
            max_solves_per_hour
            if max_solves_per_hour is not None
            else int(os.environ.get("CAPTCHA_MAX_SOLVES_PER_HOUR", "10"))
        )
        self._time = time_fn
        self.solve_timestamps: List[float] = []
        self.solves_by_provider: Dict[str, int] = {"capsolver": 0, "2captcha": 0}
        self.estimated_cost_usd: float = 0.0

    def check_can_solve(self) -> None:
        now = self._time()
        total_run = len(self.solve_timestamps)
        if total_run >= self.max_solves_per_run:
            raise CaptchaBudgetExceededError(
                f"Reached per-run CAPTCHA solve cap ({total_run}/{self.max_solves_per_run}). "
                "Stopping to prevent a session-rejection loop."
            )
        one_hour_ago = now - 3600.0
        recent = [t for t in self.solve_timestamps if t >= one_hour_ago]
        if len(recent) >= self.max_solves_per_hour:
            raise CaptchaBudgetExceededError(
                f"Reached hourly CAPTCHA solve cap ({len(recent)}/{self.max_solves_per_hour} in 60m). "
                "Stopping to protect portal reputation."
            )

    def record_solve(self, provider: str) -> None:
        self.solve_timestamps.append(self._time())
        self.solves_by_provider[provider] = self.solves_by_provider.get(provider, 0) + 1
        self.estimated_cost_usd += self.PRICE_PER_SOLVE.get(provider, 0.0015)


# ── Step 3 & 4 Waterfall: CapSolver (Primary) -> 2Captcha (Fallback) ─────────

class CaptchaSolverWaterfall:
    """
    Executes the external solver waterfall when a visual/token challenge does not
    auto-clear:
      1. CapSolver (fast AI solver, ~$0.80/1k)
      2. 2Captcha (human + AI hybrid fallback, ~$1.50/1k)
    """

    CAPSOLVER_CREATE_URL = "https://api.capsolver.com/createTask"
    CAPSOLVER_RESULT_URL = "https://api.capsolver.com/getTaskResult"
    TWOCAPTCHA_CREATE_URL = "https://api.2captcha.com/createTask"
    TWOCAPTCHA_RESULT_URL = "https://api.2captcha.com/getTaskResult"

    def __init__(
        self,
        capsolver_api_key: Optional[str] = None,
        twocaptcha_api_key: Optional[str] = None,
        budget_tracker: Optional[CaptchaBudgetTracker] = None,
        http_session: Optional[requests.Session] = None,
        poll_interval: float = 3.0,
        max_wait_seconds: float = 90.0,
    ):
        try:
            import proxy_config
            proxy_config.load_dotenv_if_present()
        except Exception:
            pass
        self.capsolver_api_key = (
            capsolver_api_key
            if capsolver_api_key is not None
            else os.environ.get("CAPSOLVER_API_KEY", "").strip()
        )
        self.twocaptcha_api_key = (
            twocaptcha_api_key
            if twocaptcha_api_key is not None
            else os.environ.get("TWOCAPTCHA_API_KEY", "").strip()
        )
        self.budget = budget_tracker or CaptchaBudgetTracker()
        self.http = http_session or requests.Session()
        self.poll_interval = poll_interval
        self.max_wait_seconds = max_wait_seconds

    @property
    def has_any_solver(self) -> bool:
        return bool(self.capsolver_api_key or self.twocaptcha_api_key)

    async def solve(
        self,
        challenge_kind: str,
        page_url: str,
        sitekey: str,
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Attempts to solve `challenge_kind` ('recaptcha_v2' or 'turnstile') using
        CapSolver first, then falling back to 2Captcha.
        Returns (token, provider_name) or (None, None).
        """
        if not sitekey:
            logger.warning(f"[Solver] Cannot call solver API for {page_url}: no sitekey found on page.")
            return None, None

        if not self.has_any_solver:
            logger.info("[Solver] Neither CAPSOLVER_API_KEY nor TWOCAPTCHA_API_KEY is set; skipping paid solvers.")
            return None, None

        # Enforce Fail-Safe 4 before spending credits
        self.budget.check_can_solve()

        # Primary: CapSolver
        if self.capsolver_api_key:
            try:
                logger.info(f"[Solver] Trying primary solver (CapSolver) for {challenge_kind} on {page_url}...")
                token = await self._solve_with_capsolver(challenge_kind, page_url, sitekey)
                if token:
                    self.budget.record_solve("capsolver")
                    logger.info(
                        f"[Solver] CapSolver succeeded (run solves: {len(self.budget.solve_timestamps)}, "
                        f"est. spend: ${self.budget.estimated_cost_usd:.4f})"
                    )
                    return token, "capsolver"
            except Exception as e:
                logger.warning(f"[Solver] CapSolver failed ({e}); falling back to 2Captcha...")

        # Fallback: 2Captcha
        if self.twocaptcha_api_key:
            try:
                self.budget.check_can_solve()
                logger.info(f"[Solver] Trying fallback solver (2Captcha) for {challenge_kind} on {page_url}...")
                token = await self._solve_with_twocaptcha(challenge_kind, page_url, sitekey)
                if token:
                    self.budget.record_solve("2captcha")
                    logger.info(
                        f"[Solver] 2Captcha succeeded (run solves: {len(self.budget.solve_timestamps)}, "
                        f"est. spend: ${self.budget.estimated_cost_usd:.4f})"
                    )
                    return token, "2captcha"
            except Exception as e:
                logger.warning(f"[Solver] 2Captcha failed: {e}")

        return None, None

    async def _solve_with_capsolver(self, challenge_kind: str, page_url: str, sitekey: str) -> Optional[str]:
        task_type = (
            "AntiTurnstileTaskProxyLess"
            if challenge_kind == "turnstile"
            else "ReCaptchaV2TaskProxyLess"
        )
        create_payload = {
            "clientKey": self.capsolver_api_key,
            "task": {
                "type": task_type,
                "websiteURL": page_url,
                "websiteKey": sitekey,
            },
        }
        resp = await asyncio.to_thread(
            self.http.post, self.CAPSOLVER_CREATE_URL, json=create_payload, timeout=30
        )
        data = resp.json()
        if data.get("errorId", 0) != 0:
            raise RuntimeError(f"CapSolver createTask error: {data.get('errorDescription') or data}")

        task_id = data.get("taskId")
        if not task_id:
            raise RuntimeError("CapSolver returned no taskId")

        deadline = time.monotonic() + self.max_wait_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(self.poll_interval)
            poll_resp = await asyncio.to_thread(
                self.http.post,
                self.CAPSOLVER_RESULT_URL,
                json={"clientKey": self.capsolver_api_key, "taskId": task_id},
                timeout=30,
            )
            poll_data = poll_resp.json()
            if poll_data.get("errorId", 0) != 0:
                raise RuntimeError(f"CapSolver poll error: {poll_data.get('errorDescription') or poll_data}")
            status = poll_data.get("status")
            if status == "ready":
                sol = poll_data.get("solution") or {}
                return sol.get("gRecaptchaResponse") or sol.get("token")
            if status in ("failed", "error"):
                raise RuntimeError(f"CapSolver task status: {status}")

        raise TimeoutError(f"CapSolver timed out after {self.max_wait_seconds}s")

    async def _solve_with_twocaptcha(self, challenge_kind: str, page_url: str, sitekey: str) -> Optional[str]:
        task_type = (
            "TurnstileTaskProxyless"
            if challenge_kind == "turnstile"
            else "RecaptchaV2TaskProxyless"
        )
        create_payload = {
            "clientKey": self.twocaptcha_api_key,
            "task": {
                "type": task_type,
                "websiteURL": page_url,
                "websiteKey": sitekey,
            },
        }
        resp = await asyncio.to_thread(
            self.http.post, self.TWOCAPTCHA_CREATE_URL, json=create_payload, timeout=30
        )
        data = resp.json()
        if data.get("errorId", 0) != 0:
            raise RuntimeError(f"2Captcha createTask error: {data.get('errorDescription') or data}")

        task_id = data.get("taskId")
        if not task_id:
            raise RuntimeError("2Captcha returned no taskId")

        deadline = time.monotonic() + self.max_wait_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(self.poll_interval)
            poll_resp = await asyncio.to_thread(
                self.http.post,
                self.TWOCAPTCHA_RESULT_URL,
                json={"clientKey": self.twocaptcha_api_key, "taskId": task_id},
                timeout=30,
            )
            poll_data = poll_resp.json()
            if poll_data.get("errorId", 0) != 0:
                raise RuntimeError(f"2Captcha poll error: {poll_data.get('errorDescription') or poll_data}")
            status = poll_data.get("status")
            if status == "ready":
                sol = poll_data.get("solution") or {}
                return sol.get("gRecaptchaResponse") or sol.get("token")
            if status in ("failed", "error"):
                raise RuntimeError(f"2Captcha task status: {status}")

        raise TimeoutError(f"2Captcha timed out after {self.max_wait_seconds}s")


# ── Behavioral Telemetry Helpers (Curved Mouse + Human Typing) ───────────────

async def human_move(
    page: Page,
    target_x: float,
    target_y: float,
    steps: int = 12,
    start_pos: Optional[Tuple[float, float]] = None,
) -> None:
    """
    Moves the mouse along a slightly curved path with micro-jitter so reCAPTCHA v3
    and PerimeterX observe natural acceleration/deceleration events.
    """
    sx, sy = start_pos or (random.uniform(120, 480), random.uniform(120, 380))
    ctrl_x = (sx + target_x) / 2.0 + random.uniform(-45, 45)
    ctrl_y = (sy + target_y) / 2.0 + random.uniform(-35, 35)

    for i in range(1, steps + 1):
        t = i / steps
        # Quadratic Bezier curve
        x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * ctrl_x + t ** 2 * target_x
        y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * ctrl_y + t ** 2 * target_y
        await page.mouse.move(x + random.uniform(-1.2, 1.2), y + random.uniform(-1.2, 1.2))
        await asyncio.sleep(random.uniform(0.006, 0.018))


async def human_click(page: Page, selector: str, timeout: int = 10000) -> None:
    """Scrolls element into view, moves cursor along a curve, pauses briefly, and clicks."""
    loc = page.locator(selector).first
    await loc.wait_for(state="visible", timeout=timeout)
    box = await loc.bounding_box()
    if box:
        tx = box["x"] + box["width"] * random.uniform(0.3, 0.7)
        ty = box["y"] + box["height"] * random.uniform(0.3, 0.7)
        await human_move(page, tx, ty)
        await asyncio.sleep(random.uniform(0.05, 0.14))
        await page.mouse.down()
        await asyncio.sleep(random.uniform(0.04, 0.09))
        await page.mouse.up()
    else:
        await loc.click(delay=random.randint(45, 95))


async def human_type(page: Page, selector: str, text: str, clear_first: bool = True) -> None:
    """Clicks a field naturally and types character-by-character with human cadence."""
    await human_click(page, selector)
    if clear_first:
        await page.fill(selector, "")
    for ch in text:
        await page.keyboard.type(ch, delay=random.randint(38, 95))


# ── Browser Generation Tracker ───────────────────────────────────────────────

class _BrowserGeneration:
    """
    Tracks the lifecycle and active task reference count of a single Chromium instance.
    Allows old browser instances to drain in-flight tasks before closing.
    """

    def __init__(self, browser: Browser, generation_id: int, user_agent: str, nav_platform: str):
        self.browser = browser
        self.generation_id = generation_id
        self.user_agent = user_agent
        self.nav_platform = nav_platform
        self.total_spawns = 0
        self.active_tasks = 0
        self.retired = False
        self._drain_event = asyncio.Event()
        self._drain_event.set()  # Initially no active tasks

    def acquire(self):
        self.total_spawns += 1
        self.active_tasks += 1
        self._drain_event.clear()

    async def release(self):
        self.active_tasks -= 1
        if self.active_tasks == 0:
            self._drain_event.set()
            if self.retired:
                logger.info(f"[Gen {self.generation_id}] Drained final task. Closing retired Chromium instance.")
                await self.browser.close()

    async def close_when_drained(self):
        self.retired = True
        if self.active_tasks == 0:
            logger.info(f"[Gen {self.generation_id}] No active tasks. Closing Chromium instance immediately.")
            await self.browser.close()
        else:
            logger.info(
                f"[Gen {self.generation_id}] Marked for retirement. "
                f"Waiting for {self.active_tasks} in-flight task(s) to drain..."
            )
            await self._drain_event.wait()


# ── Main StealthBrowserPool ──────────────────────────────────────────────────

def _build_os_consistent_profile(browser_version: str) -> Tuple[str, str]:
    """
    Builds a User-Agent and matching `navigator.platform` string aligned with
    both the real OS kernel and the actual launched Chromium binary version.
    Prevents the classic Linux-droplet-claiming-Windows-Chrome-124 mismatch.
    """
    ver = browser_version or "131.0.0.0"
    sys_name = py_platform.system().lower()
    if sys_name == "darwin":
        ua = (
            f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"
        )
        nav_plat = "MacIntel"
    elif sys_name == "windows":
        ua = (
            f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"
        )
        nav_plat = "Win32"
    else:
        ua = (
            f"Mozilla/5.0 (X11; Linux x86_64) "
            f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"
        )
        nav_plat = "Linux x86_64"
    return ua, nav_plat


def _parse_env_proxy_pool() -> Optional[List[Dict[str, str]]]:
    """
    Parses optional comma-separated proxy URLs from STEALTH_PROXY_POOL in .env,
    or falls back to `proxy_config.playwright_proxy_dict()` (`IPROYAL_PROXY_URL` /
    `IPROYAL_USER` + `IPROYAL_PASS`).
    """
    raw = os.environ.get("STEALTH_PROXY_POOL", "").strip()
    if raw:
        pool: List[Dict[str, str]] = []
        for item in raw.split(","):
            item = item.strip()
            if not item:
                continue
            if "://" not in item:
                item = f"http://{item}"
            parsed = urlparse(item)
            entry: Dict[str, str] = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
            if parsed.username:
                entry["username"] = parsed.username
            if parsed.password:
                entry["password"] = parsed.password
            pool.append(entry)
        if pool:
            return pool

    try:
        import proxy_config
        single = proxy_config.playwright_proxy_dict()
        if single:
            return [single]
    except Exception:
        pass
    return None


class StealthBrowserPool:
    """
    Persistent asynchronous Playwright worker pool with automatic browser recycling,
    concurrency throttling, sticky proxy-bound session persistence, 4-step CAPTCHA
    escalation, and 5-layer anti-blocking fail-safes.
    """

    BROWSER_ARGS = [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-service-autorun",
        "--password-store=basic",
        "--use-mock-keychain",
        "--window-size=1920,1080",
        "--enforce-webrtc-ip-permission-check",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]

    # Strips Playwright's default --enable-automation flag
    IGNORE_DEFAULT_ARGS = ["--enable-automation"]

    @staticmethod
    def build_stealth_init_script(nav_platform: str) -> str:
        return f"""
        (() => {{
            Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
            Object.defineProperty(navigator, 'platform', {{ get: () => {json.dumps(nav_platform)} }});
            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => 8 }});
            Object.defineProperty(navigator, 'deviceMemory', {{ get: () => 8 }});
            Object.defineProperty(navigator, 'languages', {{ get: () => ['en-US', 'en'] }});
            Object.defineProperty(navigator, 'plugins', {{
                get: () => [
                    {{ name: 'PDF Viewer', filename: 'internal-pdf-viewer' }},
                    {{ name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' }},
                    {{ name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' }}
                ]
            }});

            if (!window.chrome) {{
                window.chrome = {{ runtime: {{}}, loadTimes: () => ({{}}), csi: () => ({{}}) }};
            }}

            if (navigator.permissions && navigator.permissions.query) {{
                const origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (parameters) => (
                    parameters && parameters.name === 'notifications'
                        ? Promise.resolve({{ state: Notification.permission }})
                        : origQuery(parameters)
                );
            }}

            const patchWebGL = (proto) => {{
                if (!proto || !proto.getParameter) return;
                const orig = proto.getParameter;
                proto.getParameter = function(parameter) {{
                    if (parameter === 37445) return 'Intel Inc.';
                    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                    return orig.apply(this, arguments);
                }};
            }};
            if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype);
            if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);
        }})();
        """

    def __init__(
        self,
        proxy_pool: Optional[List[Dict[str, str]]] = None,
        state_dir: str = "./session_states",
        max_concurrency: int = 5,
        max_tasks_per_browser: int = 250,
        headless: bool = True,
        circuit_breaker: Optional[DomainCircuitBreaker] = None,
        solver_waterfall: Optional[CaptchaSolverWaterfall] = None,
        auto_clear_wait_ms: int = 4000,
    ):
        """
        :param max_concurrency: Maximum simultaneous BrowserContexts open at once.
        :param max_tasks_per_browser: Number of contexts spawned before recycling the Chromium binary.
        """
        self.proxy_pool = proxy_pool if proxy_pool is not None else _parse_env_proxy_pool()
        self.state_dir = state_dir
        self.headless = headless
        self.max_tasks_per_browser = max_tasks_per_browser
        self.auto_clear_wait_ms = auto_clear_wait_ms

        self.semaphore = asyncio.Semaphore(max_concurrency)
        self._recycle_lock = asyncio.Lock()

        self._playwright: Optional[Playwright] = None
        self._current_gen: Optional[_BrowserGeneration] = None
        self._generation_counter = 0
        self._background_drains: set[asyncio.Task] = set()

        # Sticky proxy map: domain -> proxy dict
        self._sticky_proxies: Dict[str, Dict[str, str]] = {}

        os.makedirs(self.state_dir, exist_ok=True)

        self.circuit_breaker = circuit_breaker or DomainCircuitBreaker(
            state_file=os.path.join(self.state_dir, "circuit_breaker.json"),
            max_consecutive_failures=int(os.environ.get("STEALTH_MAX_CONSECUTIVE_FAILURES", "3")),
            cooldown_seconds=int(os.environ.get("STEALTH_COOLDOWN_SECONDS", "21600")),
        )
        self.solver = solver_waterfall or CaptchaSolverWaterfall()

    def _select_proxy_for_domain(self, domain: str, rotate: bool = False) -> Optional[Dict[str, str]]:
        """
        Fail-Safe 3: Sticky Session-to-Proxy Binding.
        Keeps the same proxy IP for a domain across requests and only rotates when
        `rotate=True` (after a timeout or failed challenge).
        """
        if not self.proxy_pool:
            return None
        if not rotate and domain in self._sticky_proxies:
            return self._sticky_proxies[domain]

        current = self._sticky_proxies.get(domain)
        candidates = [p for p in self.proxy_pool if p != current] or self.proxy_pool
        chosen = random.choice(candidates)
        self._sticky_proxies[domain] = chosen
        return chosen

    async def _spawn_new_generation(self) -> _BrowserGeneration:
        """Launches a fresh Chromium binary wrapped in a generation tracker."""
        if not self._playwright:
            raise RuntimeError("Playwright is not initialized.")

        self._generation_counter += 1
        gen_id = self._generation_counter

        launch_kwargs: Dict[str, Any] = {
            "headless": self.headless,
            "args": self.BROWSER_ARGS,
            "ignore_default_args": self.IGNORE_DEFAULT_ARGS,
        }
        exec_path = os.environ.get("STEALTH_EXECUTABLE_PATH", "").strip()
        if exec_path and os.path.exists(exec_path):
            launch_kwargs["executable_path"] = exec_path
        if self.proxy_pool:
            launch_kwargs["proxy"] = {"server": "http://per-context"}

        logger.info(
            f"[Gen {gen_id}] Launching fresh Chromium instance "
            f"({'patchright' if USING_PATCHRIGHT else 'playwright'})..."
        )
        try:
            browser = await self._playwright.chromium.launch(**launch_kwargs)
        except Exception as launch_err:
            # Handle macOS Rosetta (x64 shell on arm64 Mac where arm64 Playwright browser is installed)
            err_msg = str(launch_err)
            if "-mac-x64/" in err_msg and "Executable doesn't exist at " in err_msg:
                m = re.search(r"Executable doesn't exist at ([^\n]+)", err_msg)
                if m:
                    arm_candidate = m.group(1).strip().replace("-mac-x64/", "-mac-arm64/")
                    if os.path.exists(arm_candidate):
                        launch_kwargs["executable_path"] = arm_candidate
                        browser = await self._playwright.chromium.launch(**launch_kwargs)
                    else:
                        raise
                else:
                    raise
            else:
                raise
        ua, nav_plat = _build_os_consistent_profile(browser.version)
        return _BrowserGeneration(
            browser=browser,
            generation_id=gen_id,
            user_agent=ua,
            nav_platform=nav_plat,
        )

    async def _acquire_generation(self) -> _BrowserGeneration:
        """
        Returns the active browser generation, rotating to a fresh Chromium instance
        if the task limit has been reached or if the browser crashed unexpectedly.
        """
        async with self._recycle_lock:
            needs_recycle = (
                self._current_gen is None
                or not self._current_gen.browser.is_connected()
                or self._current_gen.total_spawns >= self.max_tasks_per_browser
            )

            if needs_recycle:
                old_gen = self._current_gen
                if old_gen:
                    logger.info(
                        f"[Gen {old_gen.generation_id}] Reached {old_gen.total_spawns} tasks "
                        f"(limit: {self.max_tasks_per_browser}). Recycling browser..."
                    )
                    old_gen.retired = True
                    if old_gen.active_tasks == 0:
                        drain_task = asyncio.create_task(old_gen.browser.close())
                        self._background_drains.add(drain_task)
                        drain_task.add_done_callback(self._background_drains.discard)

                self._current_gen = await self._spawn_new_generation()

            self._current_gen.acquire()
            return self._current_gen

    async def __aenter__(self) -> "StealthBrowserPool":
        mac_cache = os.path.expanduser("~/Library/Caches/ms-playwright")
        cur_pw_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
        if os.path.isdir(mac_cache) and (not cur_pw_path or not os.path.isdir(cur_pw_path)):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = mac_cache
        self._playwright = await async_playwright().start()
        async with self._recycle_lock:
            self._current_gen = await self._spawn_new_generation()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        logger.info("Shutting down StealthBrowserPool...")
        if self._current_gen:
            await self._current_gen.close_when_drained()
        if self._background_drains:
            await asyncio.gather(*self._background_drains, return_exceptions=True)
        if self._playwright:
            await self._playwright.stop()

    # ── Smart Challenge Detection & 4-Step Resolution ────────────────────────

    async def _detect_active_challenge(self, page: Page) -> Optional[str]:
        """
        Detects whether `page` is currently blocked by an ACTIVE challenge.
        Critically ignores hidden/passive reCAPTCHA v2/v3 corner badges (`api2/anchor`)
        unless an actual challenge popup (`api2/bframe`), Turnstile challenge, or
        PerimeterX block is visible.
        """
        # 1. Cloudflare Turnstile / Challenge page
        cf_sel = "iframe[src*='challenges.cloudflare.com'], #challenge-running, #cf-challenge-running"
        if await page.locator(cf_sel).count() > 0:
            return "turnstile"

        # 2. PerimeterX / HUMAN block
        px_sel = "#px-captcha, iframe[src*='captcha.px-cloud.net']"
        if await page.locator(px_sel).count() > 0:
            return "perimeterx"

        # 3. Active visible reCAPTCHA challenge frame (`bframe`) or explicit blocking form
        bframe_loc = page.locator(
            "iframe[src*='recaptcha/api2/bframe'], iframe[src*='recaptcha/enterprise/bframe']"
        )
        for i in range(await bframe_loc.count()):
            try:
                if await bframe_loc.nth(i).is_visible():
                    return "recaptcha_v2"
            except Exception:
                pass

        # 4. Standalone blocking reCAPTCHA gate (e.g., page with no content except a visible checkbox)
        body_text = ""
        try:
            body_text = (await page.inner_text("body"))[:4000].lower()
        except Exception:
            pass
        if ("invalid captcha" in body_text or "verify you are human" in body_text) and (
            await page.locator("iframe[src*='recaptcha'], .g-recaptcha").count() > 0
        ):
            return "recaptcha_v2"

        return None

    async def _extract_sitekey(self, page: Page) -> str:
        """Extracts the public `sitekey` (`data-sitekey` or iframe `k=`) from the page."""
        try:
            el = page.locator("[data-sitekey]").first
            if await el.count() > 0:
                val = await el.get_attribute("data-sitekey")
                if val:
                    return val.strip()
        except Exception:
            pass

        try:
            frames = page.locator(
                "iframe[src*='recaptcha'], iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile']"
            )
            for i in range(await frames.count()):
                src = await frames.nth(i).get_attribute("src") or ""
                parsed = urlparse(src)
                qs = parse_qs(parsed.query)
                for key in ("k", "sitekey"):
                    if key in qs and qs[key]:
                        return qs[key][0].strip()
                # Cloudflare turnstile sometimes embeds 0x... sitekey in path
                m = re.search(r"/(0x[0-9a-zA-Z_-]{10,})/", src)
                if m:
                    return m.group(1)
        except Exception:
            pass

        return ""

    async def _inject_solved_token(self, page: Page, token: str) -> None:
        """Injects the solved CAPTCHA token into the DOM and triggers page callbacks."""
        await page.evaluate(
            """(token) => {
                const selectors = [
                    '#g-recaptcha-response',
                    'textarea[name="g-recaptcha-response"]',
                    'input[name="cf-turnstile-response"]',
                    'textarea[name="cf-turnstile-response"]'
                ];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach((el) => {
                        el.value = token;
                        el.innerHTML = token;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                }
                // Trigger registered g-recaptcha data-callback if present
                const widget = document.querySelector('[data-callback]');
                if (widget) {
                    const cbName = widget.getAttribute('data-callback');
                    if (cbName && typeof window[cbName] === 'function') {
                        window[cbName](token);
                    }
                }
            }""",
            token,
        )

    async def handle_challenge_if_present(self, page: Page, challenge_timeout: int = 20000) -> bool:
        """
        Runs the 4-step CAPTCHA escalation if an active challenge is detected on `page`.
        Returns True if no challenge was present or if the challenge was resolved.
        Raises TimeoutError / RuntimeError if the challenge could not be cleared.
        """
        kind = await self._detect_active_challenge(page)
        if not kind:
            return True

        logger.warning(f"[{page.url}] Active '{kind}' challenge detected. Starting 4-step resolution...")

        # Step 2: Free stealth click / brief wait for auto-clearing challenges
        try:
            anchor = page.locator("iframe[src*='recaptcha/api2/anchor'], iframe[src*='challenges.cloudflare.com']").first
            if await anchor.count() > 0 and await anchor.is_visible():
                box = await anchor.bounding_box()
                if box:
                    await human_move(page, box["x"] + 28, box["y"] + box["height"] / 2)
                    await page.mouse.click(box["x"] + 28, box["y"] + box["height"] / 2, delay=random.randint(50, 110))
        except Exception:
            pass

        wait_sec = min(self.auto_clear_wait_ms, challenge_timeout) / 1000.0
        deadline = time.monotonic() + wait_sec
        while time.monotonic() < deadline:
            if not await self._detect_active_challenge(page):
                logger.info(f"[{page.url}] Challenge '{kind}' cleared automatically via stealth!")
                return True
            await asyncio.sleep(0.4)

        # Step 3 & 4: CapSolver -> 2Captcha waterfall
        sitekey = await self._extract_sitekey(page)
        token, provider = await self.solver.solve(kind, page.url, sitekey)
        if token:
            await self._inject_solved_token(page, token)
            await asyncio.sleep(1.0)
            return True

        # Final fallback: wait remainder of challenge_timeout in case frame detaches
        remaining_ms = max(1000, challenge_timeout - self.auto_clear_wait_ms)
        challenge_selector = (
            "iframe[src*='challenges.cloudflare.com'], "
            "iframe[src*='recaptcha/api2/bframe'], "
            "iframe[src*='recaptcha/enterprise/bframe'], "
            "#px-captcha"
        )
        await page.wait_for_selector(challenge_selector, state="detached", timeout=remaining_ms)
        return True

    # ── Task Execution with 5-Layer Fail-Safes ───────────────────────────────

    async def execute_task(
        self,
        target_url: str,
        extractor_fn: Optional[ExtractorCallback] = None,
        max_retries: int = 3,
        base_delay: float = 2.0,
        navigation_timeout: int = 30000,
        challenge_timeout: int = 20000,
    ) -> Any:
        if not self._playwright:
            raise RuntimeError("StealthBrowserPool must be used within an 'async with' block.")

        domain = DomainCircuitBreaker.domain_key(target_url)
        # Fail-Safe 1: Check circuit breaker before acquiring browser slot
        self.circuit_breaker.check(domain)

        async with self.semaphore:
            rotate_proxy = False
            for attempt in range(1, max_retries + 1):
                self.circuit_breaker.check(domain)

                proxy = self._select_proxy_for_domain(domain, rotate=rotate_proxy)
                proxy_id = hashlib.md5(proxy["server"].encode()).hexdigest()[:8] if proxy else "direct"
                state_file = os.path.join(self.state_dir, f"state_{domain}_{proxy_id}.json")

                gen: Optional[_BrowserGeneration] = None
                context: Optional[BrowserContext] = None

                try:
                    gen = await self._acquire_generation()
                    logger.info(
                        f"[{target_url}] Attempt {attempt}/{max_retries} "
                        f"(Gen: {gen.generation_id}, Task #{gen.total_spawns}, Proxy: {proxy_id})"
                    )

                    context_options: Dict[str, Any] = {
                        "viewport": {"width": 1920, "height": 1080},
                        "user_agent": gen.user_agent,
                        "locale": "en-US",
                        "timezone_id": "America/New_York",
                        "device_scale_factor": 1,
                    }

                    if proxy:
                        context_options["proxy"] = proxy

                    if os.path.exists(state_file):
                        context_options["storage_state"] = state_file

                    context = await gen.browser.new_context(**context_options)
                    await context.add_init_script(self.build_stealth_init_script(gen.nav_platform))

                    page = await context.new_page()
                    response = await page.goto(
                        target_url, wait_until="domcontentloaded", timeout=navigation_timeout
                    )

                    status_code = response.status if response else None
                    body_content = await page.content()

                    # Fail-Safe 2: Check for Hard Block (429 / Cloudflare 1015 / Account Lock)
                    hard_reason = classify_hard_block(status_code, body_content)
                    if hard_reason:
                        self.circuit_breaker.record_failure(domain, hard_reason, immediate_trip=True)
                        raise HardBlockError(f"[{target_url}] {hard_reason}")

                    # Detect and resolve soft challenges (Stealth -> Click -> CapSolver -> 2Captcha)
                    await self.handle_challenge_if_present(page, challenge_timeout=challenge_timeout)

                    # Save updated session state back to disk
                    await context.storage_state(path=state_file)

                    result = await extractor_fn(page) if extractor_fn else await page.content()
                    self.circuit_breaker.record_success(domain)
                    return result

                except (HardBlockError, CircuitBreakerOpenError, CaptchaBudgetExceededError):
                    # Never retry hard blocks, open circuit breakers, or budget caps
                    raise

                except PlaywrightTimeoutError as te:
                    logger.warning(f"[{target_url}] Timeout on attempt {attempt} (Proxy: {proxy_id}): {te}")
                    if os.path.exists(state_file):
                        os.remove(state_file)
                    rotate_proxy = True
                    self.circuit_breaker.record_failure(domain, f"Timeout: {te}")
                    if attempt == max_retries:
                        raise

                except Exception as e:
                    logger.error(f"[{target_url}] Error on attempt {attempt} (Proxy: {proxy_id}): {e}")
                    rotate_proxy = True
                    self.circuit_breaker.record_failure(domain, str(e))
                    if attempt == max_retries:
                        raise

                finally:
                    if context:
                        try:
                            await context.close()
                        except Exception as close_err:
                            logger.debug(f"Context close warning: {close_err}")
                    if gen:
                        await gen.release()

                backoff = base_delay * (2 ** (attempt - 1)) + random.uniform(0.5, 1.5)
                await asyncio.sleep(backoff)

    # ── HTTP `requests.Session` Escalation Bridge ────────────────────────────

    async def refresh_requests_session(
        self,
        http_session: requests.Session,
        target_url: str,
        auth_callback: Optional[ExtractorCallback] = None,
    ) -> requests.Session:
        """
        Opens `target_url` in `StealthBrowserPool`, resolves any active CAPTCHA or
        challenge (and optionally runs `auth_callback(page)`), then copies all cleared
        cookies and the exact browser `User-Agent` into `http_session`.
        """
        async def _harvest(page: Page) -> Tuple[List[Dict[str, Any]], str]:
            if auth_callback:
                await auth_callback(page)
            cookies = await page.context.cookies()
            ua = await page.evaluate("() => navigator.userAgent")
            return cookies, ua

        cookies, ua = await self.execute_task(target_url, extractor_fn=_harvest)
        http_session.headers["User-Agent"] = ua
        for c in cookies:
            http_session.cookies.set(
                c["name"],
                c["value"],
                domain=c.get("domain"),
                path=c.get("path", "/"),
            )
        return http_session
