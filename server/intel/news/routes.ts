/**
 * News — routes for the morning page ported from Market Intelligence.
 *
 * Each route runs the ported action; the actions keep their own daily cache
 * (intel.db, via ../cache-shim), so a warm day answers from a row and a cold
 * one fetches the feeds or calls OpenAI. The daily warm-up below is the
 * tool's two Vercel crons (05:00 warm-cache, 05:15 warm-briefs) as one
 * in-process job, so the first visitor of the morning never pays.
 */
import type { Express, Request, Response } from "express"
import { fetchPublicMentions, type PublicMentionItem } from "./fetch-public-mentions"
import { fetchInvestingNews } from "./fetch-investing-news"
import { fetchSubscriberSources } from "./fetch-subscriber-sources"
import { summarizeNewsItem } from "./fetch-news-summary"
import { fetchTrdArticle } from "./fetch-trd-article"
import { digestFromFile, digestFromText, digestFromUrl } from "./fetch-article-digest"
import { getCachedIndustryOutlook } from "./industry-outlook/getCachedOutlook"
import { sweepExpired } from "../cache-shim"

type Level = "national" | "florida" | "miami"
const LEVELS: readonly Level[] = ["national", "florida", "miami"]
const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v)

function sendError(res: Response, err: unknown, status = 502) {
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) })
}

export function registerNewsRoutes(app: Express): void {
  app.get("/api/intel/news/public-mentions", async (req: Request, res: Response) => {
    const level = req.query.level ?? "national"
    if (!isLevel(level)) return void res.status(400).json({ error: "level must be national, florida or miami" })
    try {
      res.json(await fetchPublicMentions(level))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get("/api/intel/news/investing-news", async (req: Request, res: Response) => {
    const level = req.query.level ?? "national"
    if (!isLevel(level)) return void res.status(400).json({ error: "level must be national, florida or miami" })
    try {
      res.json(await fetchInvestingNews(level))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get("/api/intel/news/subscriber-sources", async (_req: Request, res: Response) => {
    try {
      res.json(await fetchSubscriberSources())
    } catch (err) {
      sendError(res, err)
    }
  })

  // The tool's POST /api/industry-outlook: today's memo from cache, or generated.
  app.post("/api/intel/news/outlook", async (_req: Request, res: Response) => {
    try {
      res.json({ text: await getCachedIndustryOutlook() })
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post("/api/intel/news/brief", async (req: Request, res: Response) => {
    const input = req.body ?? {}
    if (typeof input !== "object" || (!input.url && !input.title)) {
      return void res.status(400).json({ error: "A url or title is required." })
    }
    try {
      res.json(await summarizeNewsItem(input))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get("/api/intel/news/trd-article", async (req: Request, res: Response) => {
    try {
      res.json(await fetchTrdArticle(Number(req.query.postId)))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post("/api/intel/news/digest/url", async (req: Request, res: Response) => {
    try {
      res.json(await digestFromUrl(String(req.body?.url ?? "")))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post("/api/intel/news/digest/text", async (req: Request, res: Response) => {
    try {
      res.json(await digestFromText(String(req.body?.text ?? ""), req.body?.label ? String(req.body.label) : undefined))
    } catch (err) {
      sendError(res, err)
    }
  })

  // The file arrives as base64 JSON (client/src/lib/intel/news-api.ts) and is
  // rebuilt as the File the action expects; the action enforces the 15 MB cap.
  app.post("/api/intel/news/digest/file", async (req: Request, res: Response) => {
    try {
      const { name, type, base64 } = req.body ?? {}
      if (typeof base64 !== "string" || !base64) return void res.status(400).json({ error: "No file." })
      const file = new File([Buffer.from(base64, "base64")], String(name || "upload"), { type: String(type || "") })
      const form = new FormData()
      form.append("file", file)
      res.json(await digestFromFile(form))
    } catch (err) {
      sendError(res, err)
    }
  })

  app.post("/api/intel/news/warm", async (_req: Request, res: Response) => {
    res.json(await warmNews())
  })
}

/**
 * The tool's warm-cache + warm-briefs, in order: outlook, the three levels of
 * both feeds, the subscriber picks, then a brief for the rows the page shows
 * first. Each step is individually caught so one dead feed never stops the
 * rest; failures are reported, not thrown.
 */
export async function warmNews(): Promise<Record<string, string>> {
  const results: Record<string, string> = {}
  const step = async (label: string, run: () => Promise<unknown>) => {
    const started = Date.now()
    try {
      await run()
      results[label] = `ok ${((Date.now() - started) / 1000).toFixed(1)}s`
    } catch (err) {
      results[label] = `FAILED ${err instanceof Error ? err.message : String(err)}`
    }
  }
  await step("outlook", () => getCachedIndustryOutlook())
  for (const level of LEVELS) await step(`publicMentions:${level}`, () => fetchPublicMentions(level))
  for (const level of LEVELS) await step(`investingNews:${level}`, () => fetchInvestingNews(level))
  await step("subscriberSources", () => fetchSubscriberSources())

  // Briefs for what the page shows first: the tool warmed the top rows of
  // each feed per level; the morning page shows eight per list, so eight.
  const BRIEFS_PER_FEED = 8
  const seen = new Set<string>()
  for (const level of LEVELS) {
    const feeds: Array<{ name: string; items: PublicMentionItem[] }> = []
    try {
      feeds.push({ name: "mentions", items: (await fetchPublicMentions(level)).news })
    } catch {
      /* reported above */
    }
    try {
      feeds.push({ name: "investing", items: (await fetchInvestingNews(level)).news })
    } catch {
      /* reported above */
    }
    for (const feed of feeds) {
      for (const item of feed.items.slice(0, BRIEFS_PER_FEED)) {
        const url = (item.resolved_url || item.url || "").trim()
        const key = `${level}:${url || item.title}`
        if (seen.has(key)) continue
        seen.add(key)
        await step(`brief:${feed.name}:${level}:${item.title.slice(0, 40)}`, () =>
          summarizeNewsItem({ title: item.title, url, source: item.source, date: item.date, summary: item.snippet, level })
        )
      }
    }
  }
  results.swept = `${sweepExpired()} expired rows`
  return results
}

/** Daily at 05:00 UTC (the tool's cron hour), plus once shortly after start. */
export function scheduleNewsWarmup(startDelayMs = 60_000, hourUtc = 5): void {
  const run = () =>
    warmNews()
      .then((r) => {
        const failed = Object.entries(r).filter(([, v]) => v.startsWith("FAILED"))
        console.log(`[intel] news warm-up: ${Object.keys(r).length - 1} steps, ${failed.length} failed${failed.length ? " — " + failed.map(([k, v]) => `${k}: ${v}`).join("; ") : ""}`)
      })
      .catch((err) => console.warn("[intel] news warm-up failed:", err))
  setTimeout(run, startDelayMs).unref()
  const tick = () => {
    const now = new Date()
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0))
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
    setTimeout(() => {
      run()
      tick()
    }, next.getTime() - now.getTime()).unref()
  }
  tick()
}
