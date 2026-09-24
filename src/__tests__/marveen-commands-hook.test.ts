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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { clearCommandsForTest, listCommands } from '../web/commands.js'
import { registerBuiltinCommands } from '../web/builtin-commands.js'
import Database from 'better-sqlite3'

const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'marveen-commands.py')

interface Call { path: string; body: any }
let calls: Call[] = []
let dispatchReply: (body: any) => { status: number; body: unknown; delayMs?: number } = () => ({ status: 200, body: { handled: false } })
let server: http.Server
let menuStatus = 200
let failSends = 0
let base = ''
let install = ''
let stateDir = ''
let ledgerDb = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      calls.push({ path: req.url ?? '', body })
      if (req.url === '/api/commands/menu') {
        res.writeHead(menuStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ commands: [{ command: 'status', description: 'x' }, { command: 'gyors', description: 'y' }] }))
        return
      }
      if (req.url === '/api/commands/dispatch') {
        expect(req.headers.authorization).toBe('Bearer dash-token')
        const r = dispatchReply(body)
        setTimeout(() => {
          res.writeHead(r.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(r.body))
        }, r.delayMs ?? 0)
        return
      }
      if ((req.url ?? '').endsWith('/sendMessage') && failSends > 0) {
        failSends--
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // sendMessage answers with a message id (telegram_progress.py stores it)
      res.end(JSON.stringify({ ok: true, result: (req.url ?? '').endsWith('/sendMessage') ? { message_id: 555 } : {} }))
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
  // Isolates the conversation-continuity ledger from the worktree's own
  // store/claudeclaw.db -- ledger_lib.db_path() resolves from THIS repo
  // checkout's own scripts/hooks/ dir (not from MARVEEN_INSTALL_DIR), so
  // without this override every hook spawn here would write real rows into
  // the checkout's live store (gitignored, but still cross-run shared state).
  ledgerDb = join(mkdtempSync(join(tmpdir(), 'mcmd-ledger-')), 'claudeclaw.db')
})

afterAll(() => {
  server.close()
  rmSync(install, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(join(ledgerDb, '..'), { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  menuStatus = 200
  failSends = 0
  dispatchReply = () => ({ status: 200, body: { handled: false, outcome: 'unknown', replies: [] } })
})

function channel(body: string, attrs = 'source="plugin:telegram:telegram" chat_id="42" message_id="7" user="owner"'): string {
  return `<channel ${attrs}>${body}</channel>`
}

function runHook(prompt: string, apiBase = base, agent = 'marveen', args: string[] = [], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', [HOOK, ...args], {
      env: {
        ...process.env,
        MARVEEN_INSTALL_DIR: install,
        MAIN_AGENT_ID: 'marveen',
        MARVEEN_AGENT_ID: agent,
        TELEGRAM_STATE_DIR: stateDir,
        MARVEEN_API_BASE: apiBase,
        TELEGRAM_API_BASE: base,
        LEDGER_DB_PATH: ledgerDb,
        MARVEEN_CMD_SEND_RETRY_SECONDS: '0.01',
        ...extraEnv,
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
    expect(dispatches()[0].body).toEqual({ text: '/status', chatId: '42', mainSession: true, deferWrites: true, forwarded: false })
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

  // ELSOKOR922 fix-forward (2): the container-measured case (usage-collect.py
  // falls back to the estimate path with no window data, HTTP 403 (env_file
  // token) recorded in auth_error) used to render as a silent, reason-free
  // "(nincs elerheto adat)". The quota line must now name the reason, and the
  // token bookkeeping (the dashboard's own reply) must never be dropped.
  it('/usage: quota unmeasurable (403 auth_error) names the reason, bookkeeping still present', async () => {
    const usageScript = join(install, 'scripts', 'usage-collect.py')
    const original = readFileSync(usageScript, 'utf-8')
    writeFileSync(usageScript,
      'import json\nprint(json.dumps({"claude": {"ok": True, "source": "estimate", "auth_error": "HTTP 403 (env_file token)"}}))\n')
    try {
      dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['Token-könyvelés: 456'] } })
      const r = await runHook(channel('/usage'))
      expect(r.code).toBe(2)
      const s = sends()
      expect(s).toHaveLength(1)
      expect(s[0].text).toMatch(/^Kvóta: nem mérhető \(HTTP 403 \(env_file token\)\)\./)
      expect(s[0].text).toMatch(/Token-könyvelés: 456$/)
    } finally {
      writeFileSync(usageScript, original)
    }
  })

  it('/usage: usage-collect.py reports ok:false, quota line names the reason, bookkeeping still present', async () => {
    const usageScript = join(install, 'scripts', 'usage-collect.py')
    const original = readFileSync(usageScript, 'utf-8')
    writeFileSync(usageScript,
      'import json\nprint(json.dumps({"claude": {"ok": False, "error": "boom", "source": "estimate"}}))\n')
    try {
      dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['Token-könyvelés: 789'] } })
      const r = await runHook(channel('/usage'))
      expect(r.code).toBe(2)
      const s = sends()
      expect(s[0].text).toBe('Kvóta: nem mérhető (boom).\n\nToken-könyvelés: 789')
    } finally {
      writeFileSync(usageScript, original)
    }
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

  it('a sub-agent session: every command still dispatches, mainSession:false in the body', async () => {
    // ELSOKOR922 fix-forward (3): the hook no longer decides read/write
    // itself -- it always dispatches and tells the server which session it
    // is; the server (dispatchForChat, commands-dispatch-route.test.ts)
    // decides whether a WRITE runs or gets refused. This test only checks
    // the hook's own contract: it dispatches (0 model tokens) and relays
    // whatever the (stubbed) server answers, for reads and writes alike.
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    let r = await runHook(channel('/status'), base, 'nova')
    expect(r.code).toBe(2)
    expect(dispatches()[0].body).toEqual({ text: '/status', chatId: '42', mainSession: false, deferWrites: true, forwarded: false })
    expect(sends()).toHaveLength(1)
    r = await runHook(channel('/usage'), base, 'nova')
    expect(r.code).toBe(2)
    expect(dispatches()[1].body).toEqual({ text: '/usage', chatId: '42', mainSession: false, deferWrites: true, forwarded: false })
    expect(sends()).toHaveLength(2)
  })
  // ELSOKOR922 Phase 7 A-smoke: a write checked from inside the hook always
  // saw its own live turn as "pane-busy". The server answers `deferred`; the
  // hook exits at once, and a detached watcher re-sends the command exactly
  // once, after THIS hook process has exited.
  it('a deferred write: hook exits without replying, the watcher re-sends once after the hook exits', async () => {
    dispatchReply = (body) => body.deferWrites
      ? { status: 200, body: { handled: true, outcome: 'deferred', replies: [] } }
      : { status: 200, body: { handled: true, outcome: 'ran', replies: ['átváltva'] } }
    const exitedAt = await runHook(channel('/model opus 5m')).then(r => { expect(r.code).toBe(2); return Date.now() })
    expect(sends()).toHaveLength(0)
    const deadline = Date.now() + 5000
    while (sends().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(sends()).toEqual([{ chat_id: '42', text: 'átváltva' }])
    const d = dispatches()
    expect(d).toHaveLength(2)
    expect(d[0].body.deferWrites).toBe(true)
    expect(d[1].body).toEqual({ text: '/model opus 5m', chatId: '42', mainSession: true, deferWrites: false, forwarded: false })
    expect(Date.now() - exitedAt).toBeGreaterThanOrEqual(400) // the settle wait ran after the exit
  })

  it('the main session dispatches with mainSession:true', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    const r = await runHook(channel('/status'), base, 'marveen')
    expect(r.code).toBe(2)
    expect(dispatches()[0].body).toEqual({ text: '/status', chatId: '42', mainSession: true, deferWrites: true, forwarded: false })
  })

  it('clears a telegram_progress placeholder posted for the blocked turn', async () => {
    mkdirSync(join(stateDir, 'progress'), { recursive: true })
    writeFileSync(join(stateDir, 'progress', 'sid-1.json'), JSON.stringify([{ chat_id: '42', message_id: 99 }]))
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    await runHook(channel('/help'))
    expect(calls.some(c => c.path === '/botbot-tok/deleteMessage' && c.body.message_id === 99)).toBe(true)
  })

  // ELSOKOR922 Phase 7 A-smoke: "Dolgozom rajta..." hung after a /model. The
  // two UserPromptSubmit hooks run in parallel; when this one cleared BEFORE
  // telegram_progress.py stored its placeholder, nothing was left to delete it.
  // The handshake: this hook leaves a marker; progress looks for it after it
  // stores, and removes its own placeholder.
  it('placeholder stored AFTER the command hook cleared: telegram_progress.py removes it via the marker', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    await runHook(channel('/status', 'source="plugin:telegram:telegram" chat_id="42" message_id="31" user="owner"'))
    expect(existsSync(join(stateDir, 'progress', 'cmd-sid-1-31.handled'))).toBe(true)
    calls = []
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn('python3', [join(ROOT, 'scripts', 'hooks', 'telegram_progress.py')], {
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_API_BASE: base },
      })
      p.on('close', c => resolve(c))
      p.stdin.end(JSON.stringify({ prompt: channel('/status', 'source="plugin:telegram:telegram" chat_id="42" message_id="31" user="owner"'), session_id: 'sid-1' }))
    })
    expect(code).toBe(0)
    expect(calls.some(c => c.path === '/botbot-tok/sendMessage')).toBe(true)
    expect(calls.some(c => c.path === '/botbot-tok/deleteMessage' && c.body.message_id === 555)).toBe(true)
    expect(existsSync(join(stateDir, 'progress', 'sid-1.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'progress', 'cmd-sid-1-31.handled'))).toBe(false)
  })

  it('an ordinary turn (no marker): telegram_progress.py keeps its placeholder for the Stop hook', async () => {
    calls = []
    await new Promise<void>((resolve) => {
      const p = spawn('python3', [join(ROOT, 'scripts', 'hooks', 'telegram_progress.py')], {
        env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_API_BASE: base },
      })
      p.on('close', () => resolve())
      p.stdin.end(JSON.stringify({ prompt: channel('mesélj', 'source="plugin:telegram:telegram" chat_id="42" message_id="32" user="owner"'), session_id: 'sid-2' }))
    })
    expect(calls.some(c => c.path === '/botbot-tok/deleteMessage')).toBe(false)
    expect(JSON.parse(readFileSync(join(stateDir, 'progress', 'sid-2.json'), 'utf-8'))).toEqual([{ chat_id: '42', message_id: 555, src_mid: '32' }])
    rmSync(join(stateDir, 'progress', 'sid-2.json'), { force: true })
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

// ELSOKOR922 Phase 7 A-smoke, live-measured 2026-09-22: this hook answers
// over the raw Bot API, never through the mcp__plugin_telegram_telegram__reply
// tool -- so ledger-outbound.py (the PostToolUse hook that closes the
// conversation-continuity ledger's "open question" on a real reply-tool call)
// never sees it. Without mark_answered(), EVERY hook-answered command stayed
// open forever, and ledger-live-drain.py (~every 2 min) surfaced it as lost
// and paid for a full model turn to answer it AGAIN -- measured live: /board
// and /context both got answered twice, once free (the hook) and once at
// full token cost (the drain), 3-20 minutes apart.
// --stop (Stop hook): a model hold that expired while the session was busy
// gets one revert retry when the turn ends. Ordinary turn ends cost nothing.
describe('marveen-commands.py --stop', () => {
  function runStop(agent = 'marveen'): Promise<number | null> {
    return new Promise((resolve) => {
      const p = spawn('python3', [HOOK, '--stop'], {
        env: { ...process.env, MARVEEN_INSTALL_DIR: install, MAIN_AGENT_ID: 'marveen', MARVEEN_AGENT_ID: agent, TELEGRAM_STATE_DIR: stateDir, MARVEEN_API_BASE: base, LEDGER_DB_PATH: ledgerDb },
      })
      p.on('close', code => resolve(code))
      p.stdin.end(JSON.stringify({ session_id: 'sid-1', hook_event_name: 'Stop' }))
    })
  }
  const holdFile = () => join(install, 'store', 'main-model-hold.json')
  const turnEnded = () => calls.filter(c => c.path === '/api/commands/turn-ended')

  it('an expired hold: the dashboard is told the turn ended; exit 0', async () => {
    writeFileSync(holdFile(), JSON.stringify({ model: 'm', revert_to: 'b', until: Date.now() - 60_000 }))
    try {
      expect(await runStop()).toBe(0)
      expect(turnEnded()).toHaveLength(1)
    } finally { rmSync(holdFile(), { force: true }) }
  })

  it('no hold, a hold not yet expired, or a sub-agent session: no call at all', async () => {
    expect(await runStop()).toBe(0)
    writeFileSync(holdFile(), JSON.stringify({ model: 'm', revert_to: 'b', until: Date.now() + 60_000 }))
    try {
      expect(await runStop()).toBe(0)
      writeFileSync(holdFile(), JSON.stringify({ model: 'm', revert_to: 'b', until: Date.now() - 60_000 }))
      expect(await runStop('nova')).toBe(0)
      expect(turnEnded()).toHaveLength(0)
    } finally { rmSync(holdFile(), { force: true }) }
  })
})

describe('marveen-commands.py: closes the conversation-continuity ledger', () => {
  function seedOpenQuestion(agentId: string, chatId: string, messageId: string, text: string) {
    const db = new Database(ledgerDb)
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')), message_id TEXT, text TEXT,
      ts TEXT, created_at INTEGER NOT NULL, attachment_kind TEXT, attachment_file_id TEXT,
      reply_to_message_id TEXT,
      UNIQUE(agent_id, chat_id, direction, message_id))`)
    // created_at is "now", not the past: isStillOpen() below only cares that
    // this row is the LATEST for the agent (it does not replicate the
    // live-drain's own 60s grace window, which is a separate, already-tested
    // concern in ledger-live-drain -- this file only proves the hook closes
    // what it answers).
    db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
       VALUES (?, ?, 'in', ?, ?, ?, ?)`,
    ).run(agentId, chatId, messageId, text, new Date().toISOString(), Math.floor(Date.now() / 1000))
    db.close()
  }

  function isStillOpen(agentId: string): boolean {
    const db = new Database(ledgerDb)
    try {
      const last = db.prepare(
        `SELECT id, created_at, direction FROM conversation_log WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(agentId) as { id: number; created_at: number; direction: string } | undefined
      return last?.direction === 'in'
    } finally {
      db.close()
    }
  }

  it('a hook-answered command closes the open question (no later drain re-answer)', async () => {
    seedOpenQuestion('marveen', '42', 'oq-1', '/status')
    expect(isStillOpen('marveen')).toBe(true)
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['minden rendben'] } })
    const r = await runHook(channel('/status'), base, 'marveen')
    expect(r.code).toBe(2)
    expect(isStillOpen('marveen')).toBe(false)
  })

  it('a dashboard-down error reply also closes the open question', async () => {
    seedOpenQuestion('marveen', '42', 'oq-2', '/status')
    const r = await runHook(channel('/status'), 'http://127.0.0.1:1')
    expect(r.code).toBe(2)
    expect(isStillOpen('marveen')).toBe(false)
  })

  it('handled:false (passed to the model) leaves the ledger untouched -- the model answers through the real reply tool', async () => {
    seedOpenQuestion('marveen', '42', 'oq-3', '/kanban')
    const r = await runHook(channel('/kanban'), base, 'marveen')
    expect(r.code).toBe(0)
    expect(isStillOpen('marveen')).toBe(true)
  })
})

// CMDHOOKMIDROUND (ELSOKOR922 Phase 7, 2026-09-23): a command that arrives
// mid-turn never reaches UserPromptSubmit; the dashboard answers it from the
// transcript (src/web/midturn-commands.ts). The SessionStart branch tells the
// main session which commands those are, so it does not answer them again.
describe('marveen-commands.py --session-start', () => {
  it('main session: additionalContext names every registry command from the menu', async () => {
    const r = await runHook('', base, 'marveen', ['--session-start'])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toMatch(/NE válaszolj/)
    expect(out.hookSpecificOutput.additionalContext).toMatch(/A lista: \/gyors, \/status\./)
  })

  it('dashboard down: falls back to the builtin names, logs why, still exit 0', async () => {
    const r = await runHook('', 'http://127.0.0.1:1', 'marveen', ['--session-start'])
    expect(r.code).toBe(0)
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toMatch(/\/status/)
    expect(ctx).toMatch(/\/board/)
    expect(ctx).not.toMatch(/\/gyors/)
    const log = readFileSync(join(stateDir, 'progress', 'commands-hook.log'), 'utf-8')
    expect(log).toMatch(/session-start: command menu unavailable/)
  })

  it('a sub-agent session gets nothing (the watcher reads only the main transcript)', async () => {
    const r = await runHook('', base, 'samu', ['--session-start'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('marveen-commands.py reply logging (for the command harness)', () => {
  it('the answered line carries the reply text', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['sor1\nsor2'] } })
    await runHook(channel('/status'))
    const log = readFileSync(join(stateDir, 'progress', 'commands-hook.log'), 'utf-8').trim().split('\n').pop()
    expect(log).toMatch(/\/status answered \(ran\).* reply="sor1\\nsor2"$/)
  })
})

describe('marveen-commands.py send retry', () => {
  it('a transient Bot API failure is retried; the reply still goes out once', async () => {
    failSends = 2
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    const r = await runHook(channel('/runs'))
    expect(r.code).toBe(2)
    // two 502s, then the one that went out: the same message, three calls
    expect(sends()).toEqual([1, 2, 3].map(() => ({ chat_id: '42', text: 'ok' })))
    expect(readFileSync(join(stateDir, 'progress', 'commands-hook.log'), 'utf-8')).toMatch(/attempt 2\/3\)[^\n]*\n[^\n]*\/runs answered/)
  })

  it('three failures: gives up, logged, turn still blocked', async () => {
    failSends = 3
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['ok'] } })
    const r = await runHook(channel('/runs'))
    expect(r.code).toBe(2)
    expect(calls.filter(c => c.path === '/botbot-tok/sendMessage')).toHaveLength(3)
    expect(readFileSync(join(stateDir, 'progress', 'commands-hook.log'), 'utf-8')).toMatch(/sendMessage failed \(attempt 3\/3\)/)
  })
})

// A forwarded message carries forwarded="1" in the channel meta once the
// plugin patch runs (scripts/patch-telegram-plugin.py, elsokor922-fwd).
describe('marveen-commands.py forwarded messages', () => {
  it('forwards the flag to the dashboard, which decides; its refusal is sent and the turn blocked', async () => {
    dispatchReply = (b) => ({ status: 200, body: b.forwarded
      ? { handled: true, outcome: 'forwarded-refused', replies: ['Továbbított üzenetből nem futtatok parancsot: /model.'] }
      : { handled: true, outcome: 'ran', replies: ['x'] } })
    const r = await runHook(channel('/model opus keep', 'source="plugin:telegram:telegram" chat_id="42" message_id="9" user="owner" forwarded="1"'))
    expect(r.code).toBe(2)
    expect(dispatches()[0].body).toEqual({ text: '/model opus keep', chatId: '42', mainSession: true, deferWrites: true, forwarded: true })
    expect(sends()).toEqual([{ chat_id: '42', text: 'Továbbított üzenetből nem futtatok parancsot: /model.' }])
  })
})

// Measured on the test bot (2026-09-23): /new runs a soft clear that waits for
// the session restart and the wake nudge -- 26 s -- and the deferred re-send
// gave up at 20 s: a clear that WORKED was answered "a dashboard nem érhető el".
describe('marveen-commands.py deferred write, slow dashboard', () => {
  it('a timeout says "maybe it ran", never "the dashboard is down"', async () => {
    dispatchReply = (b) => b.deferWrites
      ? { status: 200, body: { handled: true, outcome: 'deferred', replies: [] } }
      : { status: 200, body: { handled: true, outcome: 'ran', replies: ['kész'] }, delayMs: 1500 }
    await runHook(channel('/new'), base, 'marveen', [], { MARVEEN_CMD_DEFERRED_TIMEOUT: '0.5' })
    const deadline = Date.now() + 6000
    while (sends().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(sends()).toEqual([{ chat_id: '42', text: '/new: elküldtem, de a dashboard 0 mp alatt sem válaszolt, lehet, hogy lefutott. Nézd meg /status-szal, mielőtt újra kiadod.' }])
  })

  it('a slow but answering dashboard (1.5 s) gets its reply through at the default timeout', async () => {
    dispatchReply = (b) => b.deferWrites
      ? { status: 200, body: { handled: true, outcome: 'deferred', replies: [] } }
      : { status: 200, body: { handled: true, outcome: 'ran', replies: ['kész'] }, delayMs: 1500 }
    await runHook(channel('/new'))
    const deadline = Date.now() + 8000
    while (sends().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    expect(sends()).toEqual([{ chat_id: '42', text: 'kész' }])
    expect(readFileSync(HOOK, 'utf-8')).toMatch(/MARVEEN_CMD_DEFERRED_TIMEOUT", "90"/)
  })
})

describe('marveen-commands.py pass-through logging', () => {
  it('a slash word the registry does not know goes to the model AND leaves a log line', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: false, outcome: 'unknown', replies: [] } })
    const r = await runHook(channel('/xyzproba'))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(sends()).toEqual([])
    const last = readFileSync(join(stateDir, 'progress', 'commands-hook.log'), 'utf-8').trim().split('\n').pop()
    expect(last).toMatch(/\/xyzproba: not a registry command \(unknown\), passed to the model chat=42/)
  })
})

describe('marveen-commands.py and "?"', () => {
  it('/usage ? gets the help only, no quota line in front', async () => {
    dispatchReply = () => ({ status: 200, body: { handled: true, outcome: 'ran', replies: ['/usage\n/usage [<nap>] - token'] } })
    const r = await runHook(channel('/usage ?'))
    expect(r.code).toBe(2)
    expect(sends()).toEqual([{ chat_id: '42', text: '/usage\n/usage [<nap>] - token' }])
  })
})

