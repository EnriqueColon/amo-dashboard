import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SERVER = '/Users/enrique/Downloads/amo-dashboard-source/amo-dashboard/tools/droplet-mcp/server.mjs'

const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER] }))

const { tools } = await client.listTools()
console.log('TOOLS:', tools.map((t) => t.name).join(', '))

async function call(name, args = {}) {
  console.log(`\n${'='.repeat(60)}\n${name}(${JSON.stringify(args)})\n${'='.repeat(60)}`)
  const r = await client.callTool({ name, arguments: args })
  console.log(r.content[0].text.slice(0, 1400))
}

await call('git_state')
await call('db_query', { sql: "SELECT name FROM sqlite_master WHERE type='table' LIMIT 8;" })
await call('db_query', { sql: "UPDATE sqlite_master SET name='x';" })
await call('tail_log', { log: 'facility_tick', lines: 6 })
await call('deploy', { confirm: false })
await call('run_collector', { job: 'backup', confirm: false })

await client.close()
process.exit(0)
