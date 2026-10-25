import { JsonRpcProcess } from './lib/codex-rpc.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MODEL, escalationTool, economyInstructions, EconomySession } from './lib/codex-economy.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { message, cwd, allowTools } = JSON.parse(input)
const bin = process.env.MARVEEN_CODEX_BIN ?? join(homedir(), '.local/lib/marveen-codex/node_modules/.bin/codex')
const rpc = new JsonRpcProcess(bin, ['app-server', '-c', 'forced_login_method="chatgpt"'], {cwd, detached: process.platform !== 'win32'})
process.on('SIGTERM', () => { rpc.close(); process.exit(1) })
try {
  await rpc.request('initialize', {clientInfo: {name: 'marveen-worker', version: '1.1.0'}, capabilities: {experimentalApi: true}})
  rpc.notify('initialized')
  const auth = await rpc.request('account/read', {refreshToken: false})
  if (auth.account?.type !== 'chatgpt') throw new Error('ChatGPT login required')
  const session = new EconomySession({
    open: async () => rpc, close: async () => rpc.close(),
    callTool: async () => {throw new Error('External dynamic tools unavailable in worker')},
    thread: async () => {
      const result = await rpc.request('thread/start', {
        cwd, ephemeral: true, model: DEFAULT_MODEL, approvalPolicy: 'never', sandbox: allowTools ? 'workspace-write' : 'read-only',
        developerInstructions: (allowTools ? 'Complete the requested task.' : 'Generate only the requested text. Do not use external tools or modify files; only the model-upgrade control is available.') + economyInstructions,
        dynamicTools: [escalationTool],
        config: { 'features.shell_tool': allowTools, mcp_servers: {}, forced_login_method: 'chatgpt' },
      })
      return result.thread.id
    },
  })
  const result = await session.run([{type: 'text', text: message}])
  console.log(JSON.stringify({text: result.text}))
} catch { process.exitCode = 1 }
finally { rpc.close() }
