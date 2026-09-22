#!/usr/bin/env node
/**
 * amo-droplet-mcp
 *
 * Exposes the amo-dashboard production droplet to Claude as a small set of
 * named, bounded tools instead of raw shell access.
 *
 * Design rules:
 *  - There is deliberately NO "run any command" tool. Every remote command is
 *    built from fixed strings plus validated enum/integer arguments.
 *  - db_query opens SQLite with -readonly, so it cannot mutate production data.
 *  - deploy refuses to run without confirm:true, because on this box a bare
 *    `git pull` is not live: the build + pm2 restart are what ship the change.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFile, execFileSync } from 'node:child_process'

/**
 * MCP clients spawn servers with a stripped environment, so SSH_AUTH_SOCK is
 * usually missing and ssh-agent auth fails with "Permission denied (publickey)".
 * The key on disk is passphrase-protected, so falling back to -i does not help.
 * On macOS the user's agent socket can be recovered from launchd instead, which
 * keeps the passphrase protection and adds no new credentials.
 */
function ensureSshAgent() {
  if (process.env.SSH_AUTH_SOCK) return
  if (process.platform !== 'darwin') return
  try {
    const sock = execFileSync('launchctl', ['getenv', 'SSH_AUTH_SOCK'], {
      encoding: 'utf8',
    }).trim()
    if (sock) process.env.SSH_AUTH_SOCK = sock
  } catch {
    // No agent recoverable; ssh will report the auth failure itself.
  }
}
ensureSshAgent()

const HOST = process.env.AMO_DROPLET_HOST || '165.22.35.75'
const USER = process.env.AMO_DROPLET_USER || 'root'
const APP_DIR = process.env.AMO_DROPLET_PATH || '/opt/amo-dashboard'
const PM2_APP = process.env.AMO_PM2_APP || 'amo-dashboard'
const DB_PATH = `${APP_DIR}/miami_dade_amo.db`

const SSH_BASE = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  `${USER}@${HOST}`,
]

/** Named logs -> absolute paths. Callers pick a key; they never pass a path. */
const LOGS = {
  app_out: '/root/.pm2/logs/amo-dashboard-out.log',
  app_error: '/root/.pm2/logs/amo-dashboard-error.log',
  weekly: `${APP_DIR}/collector/cron.log`,
  facility_tick: `${APP_DIR}/collector/batch/tick.log`,
  normalize_nightly: `${APP_DIR}/collector/batch/normalize_nightly.log`,
  broward_daily: `${APP_DIR}/collector/broward_daily.log`,
  broward_collector: `${APP_DIR}/collector/broward_collector.log`,
  backup: `${APP_DIR}/collector/backup.log`,
}

/** Collector entrypoints that are safe to trigger by hand. */
const COLLECTORS = {
  weekly: `${APP_DIR}/collector/run_weekly.sh`,
  facility_tick: `${APP_DIR}/collector/run_facility_tick.sh`,
  normalize_nightly: `${APP_DIR}/collector/run_nightly_normalize.sh`,
  broward_daily: `BROWARD_INGEST_INDEX=1 ${APP_DIR}/collector/run_broward_daily.sh`,
  backup: `${APP_DIR}/collector/run_backup.sh`,
}

/** Run a command on the droplet. `stdin` is optional text piped to it. */
function ssh(remoteCommand, { timeout = 120_000, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      [...SSH_BASE, remoteCommand],
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').trim()
        if (err && err.killed) {
          return resolve(`TIMED OUT after ${timeout / 1000}s.\n${out}`)
        }
        if (err && !out) return resolve(`ERROR: ${err.message}`)
        resolve(out || '(no output)')
      },
    )
    if (stdin !== null) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })

const TOOLS = [
  {
    name: 'pipeline_status',
    description:
      'Health check for the droplet: pm2 process state, disk and memory, ' +
      'the installed crontab, and the last-modified time of every collector ' +
      'log so you can see which jobs actually ran recently. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deploy',
    description:
      'Ship the current origin/main to production: git pull, npm run build, ' +
      'pm2 restart, then verify the app answers. On this box a git pull alone ' +
      'does NOT go live — the build step is what updates dist/index.cjs. ' +
      'Requires confirm:true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true. Guards against an accidental production deploy.',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'restart_app',
    description:
      'pm2 restart the dashboard without pulling or rebuilding. Use when the ' +
      'process is wedged but the code on disk is already correct.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tail_log',
    description:
      'Tail one of the known log files on the droplet. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        log: {
          type: 'string',
          enum: Object.keys(LOGS),
          description: 'Which log to read.',
        },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'How many trailing lines (default 100).',
        },
        grep: {
          type: 'string',
          description: 'Optional case-insensitive filter applied to those lines.',
        },
      },
      required: ['log'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_query',
    description:
      'Run a read-only SQL query against the production SQLite database. ' +
      'Opened with -readonly, so writes are rejected by SQLite itself. ' +
      'Results come back as a text table.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A SELECT (or other read-only) statement.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Row cap applied on the client side (default 100).',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_collector',
    description:
      'Trigger one collector script by hand, outside its cron schedule. ' +
      'Runs detached with nohup and returns immediately — follow it with ' +
      'tail_log to watch progress, since these take minutes to hours.',
    inputSchema: {
      type: 'object',
      properties: {
        job: {
          type: 'string',
          enum: Object.keys(COLLECTORS),
          description: 'Which collector to run.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true. These jobs write to production data.',
        },
      },
      required: ['job', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_state',
    description:
      'Show what code the droplet is actually running: current commit, ' +
      'whether it is behind origin/main, uncommitted changes, and the build ' +
      'timestamp of dist/index.cjs versus the commit date. This is how you ' +
      'tell "pulled" apart from "deployed". Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const handlers = {
  async pipeline_status() {
    const lsLogs = Object.entries(LOGS)
      .map(([k, p]) => `printf '%-20s ' ${k}; stat -c '%y  %s bytes' ${p} 2>/dev/null || echo 'missing'`)
      .join('; ')
    return text(
      await ssh(
        `echo '=== PM2 ==='; pm2 list; ` +
          `echo; echo '=== DISK ==='; df -h ${APP_DIR} | tail -n +1; ` +
          `echo; echo '=== MEMORY ==='; free -h; ` +
          `echo; echo '=== CRONTAB ==='; crontab -l; ` +
          `echo; echo '=== LOG FRESHNESS ==='; ${lsLogs}`,
        { timeout: 45_000 },
      ),
    )
  },

  async deploy({ confirm }) {
    if (confirm !== true) {
      return text(
        'Refused: deploy requires confirm:true. This restarts production. ' +
          'Run git_state first if you want to see what would ship.',
      )
    }
    return text(
      await ssh(
        `set -e; cd ${APP_DIR}; ` +
          `echo '=== BEFORE ==='; git rev-parse --short HEAD; ` +
          `echo; echo '=== PULL ==='; git pull --ff-only; ` +
          `echo; echo '=== BUILD ==='; npm run build; ` +
          `echo; echo '=== RESTART ==='; pm2 restart ${PM2_APP} --update-env; ` +
          `sleep 4; ` +
          `echo; echo '=== AFTER ==='; git rev-parse --short HEAD; pm2 list; ` +
          `echo; echo '=== HTTP CHECK ==='; curl -s -o /dev/null -w 'localhost:5000 -> %{http_code}\\n' http://localhost:5000/ || echo 'curl failed'`,
        { timeout: 600_000 },
      ),
    )
  },

  async restart_app() {
    return text(
      await ssh(
        `pm2 restart ${PM2_APP} --update-env; sleep 4; pm2 list; ` +
          `curl -s -o /dev/null -w 'localhost:5000 -> %{http_code}\\n' http://localhost:5000/ || echo 'curl failed'`,
        { timeout: 90_000 },
      ),
    )
  },

  async tail_log({ log, lines = 100, grep }) {
    const path = LOGS[log]
    if (!path) return text(`Unknown log "${log}". Known: ${Object.keys(LOGS).join(', ')}`)
    const n = Math.min(Math.max(parseInt(lines, 10) || 100, 1), 2000)
    // grep pattern is passed as a positional arg to a shell function so it is
    // never spliced into the command line itself.
    if (grep) {
      const encoded = Buffer.from(String(grep), 'utf8').toString('base64')
      return text(
        await ssh(
          `PAT=$(echo ${encoded} | base64 -d); tail -n ${n} ${path} | grep -i -- "$PAT" | tail -n ${n}`,
          { timeout: 45_000 },
        ),
      )
    }
    return text(await ssh(`tail -n ${n} ${path}`, { timeout: 45_000 }))
  },

  async db_query({ sql, limit = 100 }) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000)
    // SQL goes in over stdin, so no quoting or escaping happens on the command
    // line. -readonly makes any write fail at the SQLite level.
    const out = await ssh(
      `sqlite3 -readonly -header -column -cmd '.timeout 5000' ${DB_PATH}`,
      { timeout: 120_000, stdin: `${sql}\n` },
    )
    const rows = out.split('\n')
    if (rows.length > n + 2) {
      return text(
        `${rows.slice(0, n + 2).join('\n')}\n\n... truncated at ${n} rows (${rows.length - 2} returned).`,
      )
    }
    return text(out)
  },

  async run_collector({ job, confirm }) {
    if (confirm !== true) {
      return text('Refused: run_collector requires confirm:true. These jobs write to production data.')
    }
    const script = COLLECTORS[job]
    if (!script) return text(`Unknown job "${job}". Known: ${Object.keys(COLLECTORS).join(', ')}`)
    const out = await ssh(
      `cd ${APP_DIR} && nohup sh -c '${script}' >> ${APP_DIR}/collector/manual_${job}.log 2>&1 & echo "started pid $!"`,
      { timeout: 30_000 },
    )
    return text(
      `${out}\n\nRunning detached. Output: ${APP_DIR}/collector/manual_${job}.log\n` +
        `Use tail_log to follow the matching job log.`,
    )
  },

  async git_state() {
    return text(
      await ssh(
        `cd ${APP_DIR}; ` +
          `echo '=== HEAD ==='; git log --oneline -1; ` +
          `echo; echo '=== FETCH / BEHIND ==='; git fetch -q origin 2>/dev/null; ` +
          `echo "local:  $(git rev-parse --short HEAD)"; ` +
          `echo "origin: $(git rev-parse --short origin/main)"; ` +
          `echo "behind by: $(git rev-list --count HEAD..origin/main) commit(s)"; ` +
          `echo; echo '=== UNCOMMITTED ==='; git status --porcelain | head -20; ` +
          `echo; echo '=== BUILT ARTIFACT vs COMMIT ==='; ` +
          `echo "dist/index.cjs built: $(stat -c '%y' dist/index.cjs 2>/dev/null || echo missing)"; ` +
          `echo "HEAD committed:       $(git log -1 --format=%cd --date=iso)"; ` +
          `echo; echo "If dist is OLDER than the commit, the code is pulled but NOT live."`,
        { timeout: 60_000 },
      ),
    )
  },
}

const server = new Server(
  { name: 'amo-droplet', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = handlers[req.params.name]
  if (!handler) return text(`Unknown tool: ${req.params.name}`)
  try {
    return await handler(req.params.arguments ?? {})
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
