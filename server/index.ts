import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { registerAuthRoutes, checkAuth } from "./auth";
import { createServer } from "http";
import { registerWeekendStatus } from "./weekend";
import { warnIfBankStressMissing } from "./bank-stress";
import { warnIfChatUnconfigured } from "./chat";
import { scheduleIntelWarmups } from "./intel/routes";

const app = express();
const httpServer = createServer(app);

// Production sits behind nginx on the same box (upstream 127.0.0.1:5000); trust only that
// hop's X-Forwarded-For so req.ip — and the login rate limit keyed on it — is the real client.
app.set("trust proxy", "loopback");
// Don't advertise the framework in every response.
app.disable("x-powered-by");

// gzip every compressible response over 1 KB (JSON, HTML, JS, CSS). The big
// API payloads — the National bank-stress ranking (4.5 MB) and the Market
// Intelligence national screening (1.5 MB) — shrink 5–8× on the wire; nginx on
// the droplet only gzips HTML (gzip_types is not set and gzip_proxied is off),
// so without this they crossed the network uncompressed. The 7-day response
// cache holds the parsed object, not bytes, so every hit is compressed too.
//
// Streamed responses are skipped: compression buffers output until the stream
// ends, which would hold back the chat's server-sent events until the answer
// was complete. The path check covers the route; the content-type check
// covers any future stream.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith("/api/chat")) return false;
      const type = String(res.getHeader("Content-Type") ?? "");
      if (type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ── Auth — register /login, /logout, then gate everything else ───────────────
registerAuthRoutes(app);
app.use(checkAuth);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Echo at most 200 characters of the body — whole responses can run to megabytes
        // and the PM2 log is not the place for a copy of every API answer.
        const body = JSON.stringify(capturedJsonResponse) ?? "";
        logLine += ` :: ${body.length > 200 ? body.slice(0, 200) + "…" : body}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  warnIfBankStressMissing(log);
  warnIfChatUnconfigured(log);
  registerWeekendStatus(app);
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Serve the API and the client on PORT (default 5000).
  //
  // Bind address: AMO_BIND_HOST, defaulting to loopback in production and to
  // every interface otherwise. In production nginx (:80) is the only public
  // entry point and proxies to 127.0.0.1:5000; binding Node to loopback keeps
  // direct internet connections away from the pre-auth body parsing (the
  // Brotli Content-Encoding path runs inside Node's own zlib, unpatched on the
  // EOL Node 20 the droplet runs). Set AMO_BIND_HOST=0.0.0.0 to expose it
  // directly again (rollback — see docs/ops/close-port-5000.md).
  const port = parseInt(process.env.PORT || "5000", 10);
  const host =
    process.env.AMO_BIND_HOST ||
    (process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
  httpServer.listen(
    {
      port,
      host,
      // reusePort is unsupported on macOS (ENOTSUP) — only enable on Linux
      reusePort: process.platform === "linux",
    },
    () => {
    // Intelligence section: build the Peers layers and the News day in the background so the first visitor after a deploy does not wait.
    scheduleIntelWarmups();
      log(`serving on ${host}:${port}`);
    },
  );
})();
