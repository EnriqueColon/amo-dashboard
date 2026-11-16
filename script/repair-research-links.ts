/**
 * One-off (re-runnable): check every saved Market Research link in intel.db's
 * research_feed_cache and repair or remove the dead ones, with the same rules
 * the daily feed now applies (server/intel/research/link-check.ts).
 *
 *   npx tsx script/repair-research-links.ts            # dry run: prints what it would change
 *   npx tsx script/repair-research-links.ts --apply    # writes the changes
 *
 * Run from /opt/amo-dashboard on the droplet (intel.db sits next to the main DB;
 * AMO_INTEL_DB_PATH overrides). Only the `url` column of changed rows is written.
 * Afterwards: pm2 restart amo-dashboard (the feed response is cached for the day).
 */
import { getIntelDb } from "../server/intel/db"
import { siteForPublisher } from "../server/intel/research/feed"
import { checkReportLinks, summarize } from "../server/intel/research/link-check"

async function main() {
  const apply = process.argv.includes("--apply")
  const db = getIntelDb()
  const rows = db
    .prepare("SELECT report_key, title, publisher, COALESCE(url, '') AS url FROM research_feed_cache ORDER BY fetched_at DESC")
    .all() as Array<{ report_key: string; title: string; publisher: string; url: string }>

  console.log(`${rows.length} saved reports; checking links${apply ? "" : " (dry run)"}…`)
  const checked = await checkReportLinks(rows, siteForPublisher)

  const changes = checked.filter(({ report, result }) => result.url !== report.url)
  for (const { report, result } of changes) {
    console.log(`${result.status.toUpperCase().padEnd(8)} ${report.publisher}: ${report.title}\n         was ${report.url || "(none)"}\n         now ${result.url || "(no link)"}`)
  }
  const s = summarize(checked)
  console.log(`\nok ${s.ok} · fixed ${s.fixed} · removed ${s.dropped} · not checkable (site refuses checks) ${s.unverified}`)

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to save.")
    return
  }
  const up = db.prepare("UPDATE research_feed_cache SET url = ? WHERE report_key = ?")
  db.transaction(() => {
    for (const { report, result } of changes) up.run(result.url || null, report.report_key)
  })()
  console.log(`Wrote ${changes.length} link change(s). Now: pm2 restart amo-dashboard`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
