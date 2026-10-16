// scripts/hooks/inbox-drain.py must not drain INTO an owner command prompt.
// The command hook (marveen-commands.py) blocks that prompt with exit 2, so
// whatever a parallel UserPromptSubmit hook prints into it never reaches the
// model. Measured on the test bot (2026-09-23): agent message #10 (a custom
// /osszefoglalo prompt) was marked delivered into a blocked /osszefoglalo and
// lost. Spawned for real against a stub dashboard, from a scratch install dir
// (the hook finds store/.dashboard-token relative to its own location).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

const HOOKS = join(__dirname, '..', '..', 'scripts', 'hooks')
let server: http.Server
let port = 0
let install = ''
let drains = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('/drain-inbox')) drains++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '<channel source="owner-command">a beküldött prompt</channel>' }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  install = mkdtempSync(join(tmpdir(), 'drain-install-'))
  mkdirSync(join(install, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(install, 'store'))
  for (const f of ['inbox-drain.py', 'ledger_lib.py', 'command_prompt.py']) copyFileSync(join(HOOKS, f), join(install, 'scripts', 'hooks', f))
  writeFileSync(join(install, 'store', '.dashboard-token'), 'tok\n')
})
afterAll(() => { server.close(); rmSync(install, { recursive: true, force: true }) })
beforeEach(() => { drains = 0 })

function run(prompt: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const p = spawn('python3', [join(install, 'scripts', 'hooks', 'inbox-drain.py')], {
      env: { ...process.env, WEB_PORT: String(port), MAIN_AGENT_ID: 'marveen', MARVEEN_AGENT_ID: 'marveen', LEDGER_DB_PATH: join(install, 'store', 'x.db') },
    })
    let stdout = ''
    p.stdout.on('data', d => { stdout += d })
    p.on('close', code => resolve({ code, stdout }))
    p.stdin.end(JSON.stringify({ prompt, session_id: 's', cwd: install }))
  })
}

const cmd = (body: string) => `<channel source="plugin:telegram:telegram" chat_id="42" message_id="7" user="o">${body}</channel>`

describe('inbox-drain.py and an owner command prompt', () => {
  it('a Telegram /command prompt: no drain call, nothing printed (the message stays pending)', async () => {
    const r = await run(cmd('/osszefoglalo'))
    expect(r.code).toBe(0)
    expect(drains).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('an ordinary owner message: drained and printed as before', async () => {
    const r = await run(cmd('szia, mi a helyzet?'))
    expect(r.code).toBe(0)
    expect(drains).toBe(1)
    expect(r.stdout).toContain('a beküldött prompt')
  })

  it('a scheduled-task prompt that merely MENTIONS a channel block is drained (not a command)', async () => {
    const r = await run('SCHEDULED TASK NOTICE\n' + cmd('/status') + '\nmásik ' + cmd('x'))
    expect(drains).toBe(1)
    expect(r.code).toBe(0)
  })
})
