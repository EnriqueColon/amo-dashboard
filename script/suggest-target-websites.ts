/**
 * Firm logos, phase 2: ask an OpenAI web search for the website of every target that
 * has none (server/entity-website-suggest.ts). Suggestions wait for a person on the
 * Targets page ("Suggested websites"); nothing is accepted automatically.
 *
 *   npx tsx script/suggest-target-websites.ts --limit 10            # first 10 only
 *   npx tsx script/suggest-target-websites.ts --budget 20           # stop at ~$20 (estimate)
 *   npx tsx script/suggest-target-websites.ts --redo                # also re-ask firms already suggested
 *
 * Run on the droplet from /opt/amo-dashboard with .env loaded (needs OPENAI_API_KEY), e.g.
 *   set -a; . ./.env; set +a; nohup npx tsx script/suggest-target-websites.ts > collector/website_suggest.log 2>&1 &
 * Safe to stop and re-run: firms already suggested are skipped.
 */
import { getDb } from "../server/db"
import { EST_COST_PER_CALL_USD, suggestWebsite, targetsNeedingSuggestion } from "../server/entity-website-suggest"

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

async function main() {
  const limit = Number(arg("--limit") ?? Infinity)
  const budget = Number(arg("--budget") ?? 20)
  const db = getDb()
  const all = targetsNeedingSuggestion(db, process.argv.includes("--redo"))
  const todo = all.slice(0, limit)
  const maxCalls = Math.floor(budget / EST_COST_PER_CALL_USD)
  console.log(`${all.length} targets without a website or suggestion; doing ${todo.length}; budget ~$${budget} (~${maxCalls} searches at ~$${EST_COST_PER_CALL_USD} each)`)
  let i = 0, calls = 0, found = 0, none = 0, errors = 0
  const worker = async () => {
    while (i < todo.length && calls < maxCalls) {
      const entity = todo[i++]
      calls++
      try {
        const s = await suggestWebsite(db, entity)
        if (s.domain) found++; else none++
        console.log(`${s.domain ? "FOUND" : "NONE "} ${entity} -> ${s.domain ?? "-"} | ${s.confidence ?? "?"} | name match ${s.name_match == null ? "n/a" : Math.round(s.name_match * 100) + "%"} | ${s.company_name ?? ""}`)
      } catch (err) {
        errors++
        console.log(`ERROR ${entity}: ${err instanceof Error ? err.message : err}`)
        if (errors >= 5 && found + none === 0) { console.log("Stopping: every call is failing."); process.exit(2) }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  console.log(`\nDone: ${calls} searches (~$${(calls * EST_COST_PER_CALL_USD).toFixed(2)} estimated), ${found} websites suggested, ${none} not found, ${errors} errors.`)
  // Let queued logo fetches finish.
  await new Promise(r => setTimeout(r, 30_000))
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
