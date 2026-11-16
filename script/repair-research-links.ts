/**
 * One-off (re-runnable): apply the daily feed's link rules to what is already
 * saved in intel.db (server/intel/research/link-check.ts):
 *   - reports whose link is a publisher's sales/product page are deleted;
 *   - every other link is checked and repaired from the publisher's sitemap, or removed.
 * The same changes are made to the day's cached feed (intel_cache "research-feed-v2"),
 * which the page reads and which survives a restart.
 *
 *   npx tsx script/repair-research-links.ts            # dry run: prints what it would change
 *   npx tsx script/repair-research-links.ts --apply    # writes the changes
 *
 * Run from /opt/amo-dashboard on the droplet (intel.db sits next to the main DB;
 * AMO_INTEL_DB_PATH overrides). Afterwards: pm2 restart amo-dashboard.
 */
import { getIntelDb } from "../server/intel/db"
import { siteForPublisher } from "../server/intel/research/feed"
import { checkReportLinks, isProductPage, summarize } from "../server/intel/research/link-check"

type Row = { report_key: string; title: string; publisher: string; url: string }
type CachedReport = { title?: string; publisher?: string; url?: string }

async function main() {
  const apply = process.argv.includes("--apply")
  const db = getIntelDb()
  const all = db
    .prepare("SELECT report_key, title, publisher, COALESCE(url, '') AS url FROM research_feed_cache ORDER BY fetched_at DESC")
    .all() as Row[]

  const products = all.filter((r) => r.url && isProductPage(r.url))
  const rows = all.filter((r) => !(r.url && isProductPage(r.url)))
  for (const r of products) console.log(`PRODUCT  ${r.publisher}: ${r.title}\n         ${r.url} -> delete`)

  console.log(`${all.length} saved reports (${products.length} product pages); checking ${rows.length} links${apply ? "" : " (dry run)"}…`)
  const checked = await checkReportLinks(rows, siteForPublisher)

  const changes = checked.filter(({ report, result }) => result.url !== report.url)
  for (const { report, result } of changes) {
    console.log(`${result.status.toUpperCase().padEnd(8)} ${report.publisher}: ${report.title}\n         was ${report.url || "(none)"}\n         now ${result.url || "(no link)"}`)
  }
  const s = summarize(checked)
  console.log(`\nok ${s.ok} · fixed ${s.fixed} · link removed ${s.dropped} · not checkable (site refuses checks) ${s.unverified} · product pages deleted ${products.length}`)

  // Same changes to the cached daily feed(s).
  const urlChange = new Map(changes.map(({ report, result }) => [`${report.publisher}::${report.title}`.toLowerCase(), result.url]))
  const fixList = (list: unknown): { list: unknown; n: number } => {
    if (!Array.isArray(list)) return { list, n: 0 }
    let n = 0
    const out = (list as CachedReport[])
      .filter((r) => {
        const drop = !!r.url && isProductPage(r.url)
        if (drop) n++
        return !drop
      })
      .map((r) => {
        const k = `${r.publisher ?? ""}::${r.title ?? ""}`.toLowerCase()
        if (urlChange.has(k) && urlChange.get(k) !== r.url) {
          n++
          return { ...r, url: urlChange.get(k) }
        }
        return r
      })
    return { list: out, n }
  }
  const cacheRows = db.prepare(`SELECT key, value FROM intel_cache WHERE key LIKE '[["research-feed-v2"%'`).all() as Array<{ key: string; value: string }>
  const cacheUpdates: Array<{ key: string; value: string }> = []
  for (const c of cacheRows) {
    const v = JSON.parse(c.value) as Record<string, unknown>
    const a = fixList(v.reports)
    const b = fixList(v.archive)
    if (a.n + b.n > 0) {
      cacheUpdates.push({ key: c.key, value: JSON.stringify({ ...v, reports: a.list, archive: b.list }) })
      console.log(`cached feed ${c.key}: ${a.n} change(s) in today's reports, ${b.n} in the archive list`)
    }
  }

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to save.")
    return
  }
  const up = db.prepare("UPDATE research_feed_cache SET url = ? WHERE report_key = ?")
  const del = db.prepare("DELETE FROM research_feed_cache WHERE report_key = ?")
  const upCache = db.prepare("UPDATE intel_cache SET value = ? WHERE key = ?")
  db.transaction(() => {
    for (const { report, result } of changes) up.run(result.url || null, report.report_key)
    for (const r of products) del.run(r.report_key)
    for (const c of cacheUpdates) upCache.run(c.value, c.key)
  })()
  console.log(`Wrote ${changes.length} link change(s), deleted ${products.length} product page(s), updated ${cacheUpdates.length} cached feed(s). Now: pm2 restart amo-dashboard`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
