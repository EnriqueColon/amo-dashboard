/**
 * Simple single-user password gate.
 *
 * How it works:
 *   - All routes (API + static) are protected by checkAuth middleware.
 *   - On first visit the user is redirected to /login.
 *   - POST /login checks the password and sets a signed cookie (HMAC-SHA256).
 *   - POST /logout clears the cookie.
 *
 * Configuration (env variables):
 *   AMO_PASSWORD   – the password (default: "amo2024")
 *   AMO_SECRET     – HMAC signing secret (default: derived from password)
 *
 * The cookie value is:   base64(timestamp) + "." + HMAC(base64(timestamp), secret)
 * This prevents trivial forgery without requiring a session store.
 */

import type { Request, Response, NextFunction, Express } from 'express';
import crypto from 'crypto';

const PASSWORD  = process.env.AMO_PASSWORD ?? 'amo2024';
const SECRET    = process.env.AMO_SECRET   ?? `amo-secret-${PASSWORD}`;
const COOKIE    = 'amo_auth';
const MAX_AGE   = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Signing helpers ──────────────────────────────────────────────────────────

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeToken(): string {
  const payload = Buffer.from(String(Date.now())).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): boolean {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Auth check middleware ────────────────────────────────────────────────────

export function checkAuth(req: Request, res: Response, next: NextFunction) {
  // Always allow login/logout routes through
  if (req.path === '/login' || req.path === '/logout') return next();

  const token = req.cookies?.[COOKIE];
  if (token && verifyToken(token)) return next();

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
  <title>AMO Tracker — Sign In</title>
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
        <div class="logo-text">AMO Tracker</div>
        <div class="logo-sub">Miami-Dade County · Assignment of Mortgages</div>
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

// ── Route registration ───────────────────────────────────────────────────────

export function registerAuthRoutes(app: Express) {
  // Parse cookies (no extra package — manual parse)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.headers.cookie ?? '';
    req.cookies = req.cookies ?? {};
    raw.split(';').forEach((part) => {
      const [k, ...v] = part.trim().split('=');
      if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
    });
    next();
  });

  // GET /login
  app.get('/login', (req: Request, res: Response) => {
    const token = req.cookies?.[COOKIE];
    if (token && verifyToken(token)) {
      const next = (req.query.next as string) || '/';
      return res.redirect(next.startsWith('/') ? next : '/');
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(loginPage());
  });

  // POST /login
  app.post('/login', (req: Request, res: Response) => {
    const { password, next } = req.body as { password?: string; next?: string };
    if (password === PASSWORD) {
      const token = makeToken();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE / 1000}`
      );
      const dest = (next && next.startsWith('/')) ? next : '/';
      return res.redirect(dest);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(loginPage('Incorrect password. Please try again.'));
  });

  // POST /logout
  app.post('/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect('/login');
  });
}
