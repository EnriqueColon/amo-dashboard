// The Real Deal relay — one serverless function on Vercel's free tier.
//
// therealdeal.com sits behind CloudFront bot control, which refuses the
// droplet's DigitalOcean address with an empty 202 before any request is
// read. Vercel's egress is accepted, so the server asks this function and the
// function asks the site (docs/MARKET_INTEL_MERGE_SESSION.md). It forwards
// GET requests to therealdeal.com only, requires a shared key, carries no
// credentials of any kind, and returns the upstream status and body as-is.
//
// Deploy:   cd tools/trd-relay && vercel deploy --prod
// Env:      RELAY_KEY (Vercel project), TRD_RELAY_URL + TRD_RELAY_KEY (droplet)
// Call:     GET /api/trd?url=<encoded https://therealdeal.com/...>  with  x-relay-key: <key>

const ALLOWED_HOSTS = new Set(["therealdeal.com", "www.therealdeal.com"])
const TIMEOUT_MS = 20_000
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

export const config = { runtime: "nodejs" }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" })
  const key = process.env.RELAY_KEY || ""
  if (!key || req.headers["x-relay-key"] !== key) return res.status(401).json({ error: "unauthorized" })

  let target
  try {
    target = new URL(String(req.query.url || ""))
  } catch {
    return res.status(400).json({ error: "url must be absolute" })
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: "only https://therealdeal.com is relayed" })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
    })
    const body = await upstream.text()
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/octet-stream")
    res.setHeader("x-upstream-status", String(upstream.status))
    res.setHeader("cache-control", "no-store")
    return res.status(upstream.status).send(body)
  } catch (err) {
    const timedOut = err && err.name === "AbortError"
    return res.status(timedOut ? 504 : 502).json({ error: timedOut ? `upstream timed out after ${TIMEOUT_MS} ms` : String(err && err.message ? err.message : err) })
  } finally {
    clearTimeout(timer)
  }
}
