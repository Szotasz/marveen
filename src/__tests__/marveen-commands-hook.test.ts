// scripts/hooks/marveen-commands.py (ELSOKOR922 spec D-4): the main session's
// UserPromptSubmit command hook. Spawned for real against a local stub that
// plays BOTH the dashboard (/api/commands/dispatch) and the Telegram Bot API
// (/bot<token>/sendMessage), so every case measures the hook's actual exit
// code, stdout and outbound calls -- not a re-implementation of its logic.
//
// The spawn is async on purpose: a spawnSync'd python would block the event
// loop the stub server runs on, and the hook's HTTP call would never be
// answered (measured in Phase 1, nap-zaro-updated-memories.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { clearCommandsForTest, listCommands } from '../web/commands.js'
import { registerBuiltinCommands } from '../web/builtin-commands.js'

const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'marveen-commands.py')

interface Call { path: string; body: any }
let calls: Call[] = []
let dispatchReply: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: { handled: false } })
let server: http.Server
let base = ''
let install = ''
let stateDir = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      calls.push({ path: req.url ?? '', body })
      if (req.url === '/api/commands/dispatch') {
        expect(req.headers.authorization).toBe('Bearer dash-token')
        const r = dispatchReply(body)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(r.body))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: {} }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  install = mkdtempSync(join(tmpdir(), 'mcmd-install-'))
  mkdirSync(join(install, 'store'))
  mkdirSync(join(install, 'scripts'))
  writeFileSync(join(install, '.env'), 'ALLOWED_CHAT_ID=42\n')
  writeFileSync(join(install, 'store', '.dashboard-token'), 'dash-token\n')
  writeFileSync(join(install, 'scripts', 'usage-collect.py'),
    'import json\nprint(json.dumps({"claude": {"ok": True, "windows": {"five_hour": {"used_percent": 30, "resets_at": 0}}}}))\n')
  stateDir = mkdtempSync(join(tmpdir(), 'mcmd-state-'))
  writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=bot-tok\n')
})

afterAll(() => {
  server.close()
  rmSync(install, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  dispatchReply = () => ({ status: 200, body: { handled: false, outcome: 'unknown', replies: [] } })
})

function channel(body: string, attrs = 'source="plugin:telegram:telegram" chat_id="42" message_id="7" user="owner"'): string {
  return `<channel ${attrs}>${body}</channel>`
}

function runHook(prompt: string, apiBase = base, agent = 'marveen'): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', [HOOK], {
      env: {
        ...process.env,
        MARVEEN_INSTALL_DIR: install,
        MAIN_AGENT_ID: 'marveen',
        MARVEEN_AGENT_ID: agent,
        TELEGRAM_STATE_DIR: stateDir,
        MARVEEN_API_BASE: apiBase,
        TELEGRAM_API_BASE: base,
      },
    })
    let stdout = ''
    p.stdout.on('data', d => { stdout += d })
    p.on('close', code => resolve({ code, stdout }))
    p.stdin.end(JSON.stringify({ prompt, session_id: 'sid-1' }))
  })
}

const sends = () => calls.filter(c => c.path === '/botbot-tok/sendMessage').map(c => c.body)
const dispatches = () => calls.filter(c => c.path === '/api/commands/dispatch')

describe('marveen-commands.py', () => {
  it('a registry command: dispatched, reply sent on the main bot, turn blocked (exit 2, no stdout)', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['minden rendben'] } })
    const r = await runHook(channel('/status'))
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(dispatches()[0].body).toEqual({ text: '/status', chatId: '42' })
    expect(sends()).toEqual([{ chat_id: '42', text: 'minden rendben' }])
  })

  it('a reply over 4096 chars goes out in Telegram-sized chunks', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `${i}`.padEnd(40, '.')).join('\n')
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: [long] } })
    const r = await runHook(channel('/queue'))
    expect(r.code).toBe(2)
    const parts = sends().map(s => s.text as string)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(p => p.length <= 4096)).toBe(true)
    expect(parts.join('\n')).toBe(long)
  })

  it('/usage: Claude quota and the token bookkeeping in ONE reply', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['Token-könyvelés: 123'] } })
    const r = await runHook(channel('/usage'))
    expect(r.code).toBe(2)
    const s = sends()
    expect(s).toHaveLength(1)
    expect(s[0].text).toMatch(/^Claude keret-allapot:\n- 5 orás: 70% van hatra/)
    expect(s[0].text).toMatch(/Token-könyvelés: 123$/)
  })

  it('handled:false (a non-registry /word): exit 0, empty stdout, nothing sent', async () => {
    const r = await runHook(channel('/kanban'))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(dispatches()).toHaveLength(1)
    expect(sends()).toHaveLength(0)
  })

  it.each([
    ['a batch of two channel blocks', channel('/status') + '\n' + channel('szia')],
    ['a non-telegram source', channel('/status', 'source="plugin:slack:slack" chat_id="42"')],
    ['a foreign chat', channel('/status', 'source="plugin:telegram:telegram" chat_id="43"')],
    ['plain text', channel('mi a helyzet?')],
    ['a command followed by more lines', channel('/status\nés még valami')],
    ['no channel block at all', '/status'],
  ])('%s: exit 0, empty stdout, no dashboard call, nothing sent', async (_label, prompt) => {
    const r = await runHook(prompt)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(dispatches()).toHaveLength(0)
    expect(sends()).toHaveLength(0)
  })

  it('dashboard unreachable + builtin command: one-line error reply, still blocked (exit 2)', async () => {
    const r = await runHook(channel('/status'), 'http://127.0.0.1:1')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    const s = sends()
    expect(s).toHaveLength(1)
    expect(s[0].text).toMatch(/^Nem futott: \/status -- a dashboard nem érhető el/)
    expect(s[0].text).not.toContain('bot-tok')
  })

  it('dashboard answers 500 + builtin command: error reply names the HTTP status, blocked', async () => {
    dispatchReply = () => ({ status: 500, body: { error: 'boom' } })
    const r = await runHook(channel('/queue'))
    expect(r.code).toBe(2)
    expect(sends()[0].text).toContain('HTTP 500')
  })

  it('dashboard unreachable + unknown /word: passed to the model (exit 0), nothing sent', async () => {
    const r = await runHook(channel('/ujchat'), 'http://127.0.0.1:1')
    expect(r.code).toBe(0)
    expect(sends()).toHaveLength(0)
  })

  it('a sub-agent session: only /usage is answered, every other command goes to its model', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    let r = await runHook(channel('/status'), base, 'nova')
    expect(r.code).toBe(0)
    expect(dispatches()).toHaveLength(0)
    expect(sends()).toHaveLength(0)
    r = await runHook(channel('/usage'), base, 'nova')
    expect(r.code).toBe(2)
    expect(sends()).toHaveLength(1)
  })

  it('clears a telegram_progress placeholder posted for the blocked turn', async () => {
    mkdirSync(join(stateDir, 'progress'), { recursive: true })
    writeFileSync(join(stateDir, 'progress', 'sid-1.json'), JSON.stringify([{ chat_id: '42', message_id: 99 }]))
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    await runHook(channel('/help'))
    expect(calls.some(c => c.path === '/botbot-tok/deleteMessage' && c.body.message_id === 99)).toBe(true)
  })

  it('BUILTIN_NAMES (the dashboard-down fallback) matches the registry builtins', () => {
    const src = readFileSync(HOOK, 'utf-8')
    const block = src.match(/BUILTIN_NAMES = frozenset\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    const names = new Set([...block.matchAll(/"([a-z_]+)"/g)].map(m => m[1]))
    clearCommandsForTest()
    registerBuiltinCommands()
    const builtin = listCommands().filter(e => e.source !== 'custom')
    const runnable = new Set(builtin.filter(e => !e.planned).map(e => e.name))
    const all = new Set(builtin.map(e => e.name))
    for (const n of runnable) expect(names.has(n), `/${n} missing from BUILTIN_NAMES`).toBe(true)
    for (const n of names) expect(all.has(n), `/${n} is not a registry builtin`).toBe(true)
  })
})
