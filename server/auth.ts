/**
 * Simple single-user password gate.
 *
 * How it works:
 *   - All routes (API + static) are protected by checkAuth middleware.
 *   - On first visit the user is redirected to /login.
 *   - POST /login checks the password and sets a signed cookie (HMAC-SHA256).
 *   - POST /logout clears the cookie.
 *
 * Configuration (env variables) — BOTH REQUIRED since 26 Oct 2026:
 *   AMO_PASSWORD   – the password. Never defaulted; the server refuses to start without it.
 *   AMO_SECRET     – HMAC signing secret. Required in production (NODE_ENV=production).
 *                    In development only, a missing secret is replaced by a random one for
 *                    the life of the process, so cookies stop working across restarts.
 *
 * The cookie value is:   base64url(timestamp) + "." + HMAC(base64url(timestamp), secret)
 * This prevents trivial forgery without requiring a session store. The timestamp is
 * checked on every request, so a token stops working MAX_AGE after it was issued even
 * if the browser kept the cookie.
 *
 * POST /login is rate-limited per client IP (express-rate-limit) and every failed
 * attempt is logged with the IP. `app.set('trust proxy', 'loopback')` in index.ts makes
 * req.ip the real client behind the droplet's nginx (upstream 127.0.0.1:5000).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const COOKIE    = 'amo_auth';
const MAX_AGE   = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Credentials (fail fast when unset) ───────────────────────────────────────

function loadCredentials(): { password: string; secret: string } {
  const production = process.env.NODE_ENV === 'production';
  const password = process.env.AMO_PASSWORD;
  let secret = process.env.AMO_SECRET;

  const missing: string[] = [];
  if (!password) missing.push('AMO_PASSWORD');
  if (!secret && production) missing.push('AMO_SECRET');

  if (missing.length) {
    console.error(
      `[auth] FATAL: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
      'The dashboard has no built-in password any more. Set the variable(s) in the ' +
      'environment the server starts with (on the droplet: /opt/amo-dashboard/.env, then ' +
      '`pm2 restart amo-dashboard --update-env`) and start again.'
    );
    process.exit(1);
  }

  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    console.warn(
      '[auth] AMO_SECRET is not set — using a random secret for this process (development only). ' +
      'Existing sign-ins will not survive a restart.'
    );
  }

  return { password: password as string, secret };
}

const { password: PASSWORD, secret: SECRET } = loadCredentials();

// ── Signing helpers ──────────────────────────────────────────────────────────

/** Constant-time string compare that returns false (not throws) on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Compare the submitted password against the configured one without leaking its length. */
function passwordMatches(submitted: unknown): boolean {
  if (typeof submitted !== 'string') return false;
  const a = crypto.createHash('sha256').update(submitted).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeToken(): string {
  const payload = Buffer.from(String(Date.now())).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Tolerance for a token stamped slightly ahead of the verifying clock. */
const CLOCK_SKEW_MS = 60 * 1000;

function verifyToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  if (!safeEqual(sig, sign(payload))) return false;

  // Signature is genuine — now enforce the age carried in the payload.
  const issued = Number(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isFinite(issued)) return false;
  const age = Date.now() - issued;
  return age > -CLOCK_SKEW_MS && age <= MAX_AGE;
}

// ── Redirect target guard ────────────────────────────────────────────────────

/**
 * A `next` target must be a same-origin path: it starts with a single "/" that is not
 * followed by another "/" or a backslash (browsers read "//evil.com" and "/\evil.com" as
 * protocol-relative URLs). Anything else falls back to the dashboard root.
 */
const SAFE_NEXT = /^\/(?![\/\\])/;

function safeNext(next: unknown): string {
  return typeof next === 'string' && SAFE_NEXT.test(next) ? next : '/';
}

// ── Auth check middleware ────────────────────────────────────────────────────

export function checkAuth(req: Request, res: Response, next: NextFunction) {
  // Always allow login/logout routes through
  if (req.path === '/login' || req.path === '/logout') return next();

  const token = req.cookies?.[COOKIE];
  if (typeof token === 'string' && verifyToken(token)) return next();

  // API calls get 401 JSON instead of a redirect
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Everything else → redirect to login, preserving the intended destination
  const dest = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login?next=${dest}`);
}

// ── Login page HTML ──────────────────────────────────────────────────────────

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SHCP Intelligence Platform — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e6ea;
      border-radius: 12px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.07);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 1.75rem;
    }
    .logo svg { flex-shrink: 0; }
    .logo-text { font-size: 1.125rem; font-weight: 600; color: #1a2236; }
    .logo-sub { font-size: 0.7rem; color: #6b7280; margin-top: 1px; }
    h1 { font-size: 1rem; font-weight: 600; color: #1a2236; margin-bottom: 0.25rem; }
    p.sub { font-size: 0.8125rem; color: #6b7280; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8125rem; font-weight: 500; color: #374151; margin-bottom: 0.4rem; }
    input[type=password] {
      width: 100%;
      padding: 0.6rem 0.875rem;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 0.875rem;
      color: #1a2236;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type=password]:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
    .error {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #b91c1c;
      font-size: 0.8rem;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      margin-bottom: 1rem;
    }
    button {
      margin-top: 1rem;
      width: 100%;
      padding: 0.65rem 1rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
    .footer { margin-top: 1.5rem; font-size: 0.7rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
        <rect x="2" y="2" width="28" height="28" rx="4" fill="rgba(37,99,235,0.1)" stroke="#2563eb" stroke-width="1.5"/>
        <path d="M7 24 L12 10 L16 19 L20 14 L25 24" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <circle cx="16" cy="19" r="2" fill="#2563eb"/>
      </svg>
      <div>
        <div class="logo-text">SHCP Intelligence Platform</div>
        <!-- County-neutral: Broward went live 10 Aug 2026. The 11 Aug copy sweep
             covered the React app but not this server-rendered page, so this was
             still asserting a single county on the first screen anyone sees. -->
        <div class="logo-sub">Public county records · Assignment of Mortgages</div>
      </div>
    </div>
    <h1>Sign in to continue</h1>
    <p class="sub">Enter your access password to view the dashboard.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="" id="next-input" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" autofocus autocomplete="current-password" />
      <button type="submit">Sign In</button>
    </form>
    <p class="footer">Restricted access · Internal use only</p>
  </div>
  <script>
    // Carry the ?next= param into the form's hidden field
    const params = new URLSearchParams(window.location.search);
    document.getElementById('next-input').value = params.get('next') || '/';
  </script>
</body>
</html>`;
}

// ── Login rate limit ─────────────────────────────────────────────────────────

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_MAX_ATTEMPTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    console.warn(`[auth] login rate limit hit — ip=${req.ip} (${LOGIN_MAX_ATTEMPTS} attempts / 15 min)`);
    res.status(429).setHeader('Content-Type', 'text/html');
    res.send(loginPage('Too many sign-in attempts. Please wait 15 minutes and try again.'));
  },
});

// ── Route registration ───────────────────────────────────────────────────────

export function registerAuthRoutes(app: Express) {
  // Parse cookies (no extra package — manual parse). A pair whose value is not valid
  // percent-encoding (e.g. `amo_auth=%`) is skipped instead of throwing before auth runs.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.headers.cookie ?? '';
    req.cookies = req.cookies ?? {};
    raw.split(';').forEach((part) => {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1);
      if (!k) return;
      try {
        req.cookies[k] = decodeURIComponent(v);
      } catch {
        // malformed cookie value — ignore this pair
      }
    });
    next();
  });

  // GET /login
  app.get('/login', (req: Request, res: Response) => {
    const token = req.cookies?.[COOKIE];
    if (typeof token === 'string' && verifyToken(token)) {
      return res.redirect(safeNext(req.query.next));
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(loginPage());
  });

  // POST /login
  app.post('/login', loginLimiter, (req: Request, res: Response) => {
    const { password, next } = (req.body ?? {}) as { password?: unknown; next?: unknown };
    if (passwordMatches(password)) {
      const token = makeToken();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}`
      );
      return res.redirect(safeNext(next));
    }
    console.warn(`[auth] failed login — ip=${req.ip}`);
    res.setHeader('Content-Type', 'text/html');
    res.send(loginPage('Incorrect password. Please try again.'));
  });

  // POST /logout
  app.post('/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect('/login');
  });
}
