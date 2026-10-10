// scripts/patch-telegram-plugin.py (ELSOKOR922 spec D-4): takes /status and
// /help away from the Telegram channel plugin so the command hook can answer
// them. Run for real on a copy of the 0.0.7 plugin excerpt (verbatim blocks,
// fixtures/telegram-plugin-0.0.7/server.ts.txt) in a scratch plugins cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-plugin-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { root: string; files: Array<{ version: string; path: string; status: string; patches: Record<string, string> }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-telegram-plugin.py', () => {
  it('1st run patches: /help, /status handlers and the plugin menu gone, /start kept, still parses', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*server\.ts/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain("bot.command('help'")
    expect(text).not.toContain("bot.command('status'")
    expect(text).not.toContain('bot.api.setMyCommands(')
    expect(text).not.toContain('Paired as')
    expect(text).toContain("bot.command('start'")
    expect(text.match(/MARVEEN-PATCH\(elsokor922-d4\)/g)).toHaveLength(3)
    expect(text).toMatch(/ +user_id: String\(from\.id\),\n +\.\.\.\(ctx\.message\?\.forward_origin \? \{ forwarded: '1' \} : \{\}\), \/\/ MARVEEN-PATCH\(elsokor922-fwd\)/)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('2nd run is a no-op: returns `already`, byte-identical, silent', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'patched', patches: { d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', perm: 'patched', 'perm-off': 'not-needed' } }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'already', patches: { d4: 'already', fwd: 'already', evid: 'already', kbd: 'already', perm: 'already', 'perm-off': 'not-needed' } }])
  })

  it('a changed anchor (plugin update): loud line, THAT patch left out, the other still applied, exit 0', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace("bot.command('status', async ctx => {", "bot.command('status', async (ctx) => {")
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: status handler not found exactly once.*the d4 patch left out/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain('elsokor922-d4')
    expect(text).toContain("bot.command('help', async ctx => {")
    expect(text).toContain('elsokor922-fwd')
    expect(syntaxErrors(text)).toEqual([])
    expect(readState(state).files[0].patches).toEqual({ d4: 'anchor-missing:status handler', fwd: 'patched', evid: 'patched', kbd: 'patched', perm: 'patched', 'perm-off': 'not-needed' })
  })

  // #1530 review: owner write commands need evidence the owner's chat sent
  // them. The plugin records every inbound message just before handing it to
  // Claude Code -- the one place only a real Telegram update reaches.
  it('evid: one inbound-log line right before the channel notification, and it really writes the record', () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(text.match(/MARVEEN-PATCH\(cmd920-evid\)/g)).toHaveLength(1)
    const lines = text.split('\n')
    const i = lines.findIndex(l => l.includes('MARVEEN-PATCH(cmd920-evid)'))
    expect(lines[i + 1]).toMatch(/^ *mcp\.notification\(\{$/)
    expect(lines[i + 2]).toMatch(/method: 'notifications\/claude\/channel',$/)
    expect(syntaxErrors(text)).toEqual([])
    // Run the inserted line with the handler's own names in scope.
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-evid-'))
    try {
      const fs = require('node:fs')
      const fn = new Function('writeFileSync', 'statSync', 'renameSync', 'join', 'STATE_DIR', 'chat_id', 'msgId', 'text', lines[i])
      fn(fs.writeFileSync, fs.statSync, fs.renameSync, join, stateDir, '42', 901, '/model opus')
      fn(fs.writeFileSync, fs.statSync, fs.renameSync, join, stateDir, '42', undefined, 'szia')
      const recs = readFileSync(join(stateDir, 'inbound-evidence.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
      expect(recs.map(r => [r.chat_id, r.message_id, r.text])).toEqual([['42', '901', '/model opus'], ['42', null, 'szia']])
      expect(typeof recs[0].at).toBe('number')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('evid: the permission notification (a different method) is not an anchor; a moved anchor leaves evid out loudly', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace("method: 'notifications/claude/channel',", "method: 'notifications/claude/channel/v2',")
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/LOUD: channel notification not found exactly once.*the evid patch left out, no inbound evidence is recorded/)
    expect(readState(state).files[0].patches.evid).toBe('anchor-missing:channel notification')
    expect(readFileSync(server, 'utf-8')).not.toContain('cmd920-evid')
  })

  it('a file patched by the d4-only version gets the forward patch on the next run', () => {
    run()
    const d4only = readFileSync(server, 'utf-8').replace(/\n +\.\.\.\(ctx\.message\?\.forward_origin[^\n]*/, '')
    writeFileSync(server, d4only)
    expect(d4only).not.toContain('elsokor922-fwd')
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(fwd\)/)
    expect(readFileSync(server, 'utf-8').match(/elsokor922-fwd/g)).toHaveLength(1)
  })

  it('writes exactly one cache: $CLAUDE_CONFIG_DIR when set, the user-level ~/.claude never on top', () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-plugin-home-'))
    try {
      const userDir = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(userDir, { recursive: true })
      const userServer = join(userDir, 'server.ts')
      copyFileSync(FIXTURE, userServer)
      // cache = <cfg>/plugins/cache, so its config dir is two levels up
      const cfg = join(cache, 'cfg')
      const cfgDir = join(cfg, 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(cfgDir, { recursive: true })
      const cfgServer = join(cfgDir, 'server.ts')
      copyFileSync(FIXTURE, cfgServer)
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg }
      const r = spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env })
      expect(r.status).toBe(0)
      expect(readFileSync(cfgServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
      expect(readFileSync(userServer, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
      // without CLAUDE_CONFIG_DIR the user-level cache IS the launch cache
      const { CLAUDE_CONFIG_DIR: _unset, ...noCfg } = env
      spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env: noCfg })
      expect(readFileSync(userServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const r = spawnSync('python3', [SCRIPT, join(cache, 'does-not-exist')], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })

  it('an unwritable file: named in the log, exit 0 (the channel still starts)', () => {
    const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
    spawnSync('chmod', ['a-w', dir])
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write .*left unpatched/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    } finally {
      spawnSync('chmod', ['u+w', dir])
    }
  })
})

// c67f5f34: one-tap answer buttons (a reply keyboard) on the reply tool. The inbound side needs nothing: a tapped
// text-only button arrives as the user's ordinary text message. So three marked lines in the reply tool: the schema
// field, its check before anything is sent, and the keyboard on the LAST text chunk.
const KBD = 'MARVEEN-PATCH(c67f5f34-kbd)'

// The fixture patched by the script WITHOUT the kbd patch (the state a file had before this change).
function patchedWithoutKbd(text: string): string {
  const code = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    "m.PATCHES = [p for p in m.PATCHES if p['name'] != 'kbd']",
    'sys.stdout.write(m.patch_text(sys.stdin.read())[0])',
  ].join('\n')
  const r = spawnSync('python3', ['-c', code, SCRIPT], { input: text, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

type Sent = { chat: string; text: string; opts: Record<string, unknown> }

// Runs the PATCHED tool-call handler of the fixture (the verbatim 0.0.7 block) with a fake bot: what the reply tool
// really passes to sendMessage. Only the reply case runs; the names the other cases use are never evaluated.
function replyHandler(patched: string): { call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>; sent: Sent[] } {
  const start = patched.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  expect(start).toBeGreaterThan(0)
  const js = ts.transpileModule(patched.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: Sent[] = []
  let handler: ((req: unknown) => Promise<never>) | undefined
  const mcp = { setRequestHandler: (_schema: unknown, fn: (req: unknown) => Promise<never>) => { handler = fn } }
  const bot = { api: { sendMessage: async (chat: string, text: string, opts: Record<string, unknown>) => { sent.push({ chat, text, opts }); return { message_id: sent.length } } } }
  const names = ['mcp', 'CallToolRequestSchema', 'assertAllowedChat', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES',
    'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'bot', 'extname', 'InputFile', 'PHOTO_EXTS']
  new Function(...names, js)(mcp, {}, () => {}, () => {}, () => ({ size: 0 }), 50 * 1024 * 1024,
    () => ({}), 4096, (text: string) => text.split('|'), bot, () => '', class {}, new Set())
  expect(handler).toBeDefined()
  return { call: args => handler!({ params: { name: 'reply', arguments: args } }), sent }
}

describe('kbd: reply-keyboard buttons (c67f5f34)', () => {
  it('three marked lines, the buttons field inside the reply tool schema, and the file still parses', () => {
    expect(run().status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    const lines = text.split('\n').filter(l => l.includes(KBD))
    expect(lines).toHaveLength(3)
    const reply = text.indexOf("name: 'reply'")
    const react = text.indexOf("name: 'react'")
    const field = text.indexOf("buttons: { type: 'array'")
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(react).toBeGreaterThan(field)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('the reply sends the keyboard on the LAST chunk only, one label per row, hidden after one tap', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const res = await h.call({ chat_id: '42', text: 'Első rész|A: elfogadod, B: már megoldva, C: más megoldás?', buttons: ['A. Elfogadom', 'B. Már megoldva', 'C. Valami más lesz a megoldás'] })
    expect(res.isError).toBeUndefined()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0].opts).not.toHaveProperty('reply_markup')
    expect(h.sent[1].opts.reply_markup).toEqual({
      keyboard: [[{ text: 'A. Elfogadom' }], [{ text: 'B. Már megoldva' }], [{ text: 'C. Valami más lesz a megoldás' }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    })
  })

  it('an empty list removes a keyboard shown earlier; no buttons means no reply_markup at all', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: 'Köszönöm, rögzítettem.', buttons: [] })
    expect(h.sent[0].opts.reply_markup).toEqual({ remove_keyboard: true })
    await h.call({ chat_id: '42', text: 'Sima válasz|két részben' })
    expect(h.sent.slice(1).map(s => 'reply_markup' in s.opts)).toEqual([false, false])
  })

  it('a bad buttons value is a tool error BEFORE anything is sent', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const bad: unknown[] = ['A', [''], ['   '], [1], ['x'.repeat(65)], Array.from({ length: 13 }, (_, i) => `${i}`)]
    for (const buttons of bad) {
      const res = await h.call({ chat_id: '42', text: 'Kérdés', buttons })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/^reply failed: buttons: /)
    }
    expect(h.sent).toHaveLength(0)
    // the limits themselves are accepted
    const ok = await h.call({ chat_id: '42', text: 'Kérdés', buttons: [...Array.from({ length: 11 }, (_, i) => `${i}`), 'x'.repeat(64)] })
    expect(ok.isError).toBeUndefined()
  })

  it('taking it back = deleting the marked lines: byte-identical to the file patched without kbd', () => {
    run()
    const withKbd = readFileSync(server, 'utf-8')
    const back = withKbd.split('\n').filter(l => !l.includes(KBD)).join('\n')
    expect(back).toBe(patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    expect(back).not.toContain(KBD)
  })

  it('all or nothing: one moved kbd anchor leaves all three lines out, loudly; the other patches still applied', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('...(parseMode ? { parse_mode: parseMode } : {}),', '...(parseMode ? { parse_mode: parseMode } : undefined),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply send options not found exactly once.*the kbd patch left out, the reply tool has no buttons/)
    expect(readFileSync(server, 'utf-8')).not.toContain(KBD)
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'anchor-missing:reply send options', perm: 'patched', 'perm-off': 'not-needed' })
  })

  it('a file patched by the previous version (d4, fwd, evid) gets kbd on the next run', () => {
    writeFileSync(server, patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(kbd\)/)
    expect(readFileSync(server, 'utf-8').split('\n').filter(l => l.includes(KBD))).toHaveLength(3)
  })
})

describe('channels.sh wiring (review #1529, point 1)', () => {
  const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

  it('calls the patcher for Telegram, with the state file, before the session (and so the plugin) is spawned', () => {
    const call = code.indexOf('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"')
    const spawn = code.indexOf('$TMUX new-session -d -s "$SESSION"')
    expect(call).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(call)
    // guarded by the Telegram provider check, directly: no other block in between
    const cond = code.lastIndexOf('if [ "$CHANNEL_PROVIDER" = "telegram" ]; then', call)
    expect(cond).toBeGreaterThan(0)
    expect(code.slice(cond, call).split('\n').length).toBeLessThanOrEqual(3)
    // both branches (own config dir / inherited one) write the state file
    expect(code.split('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"').length - 1).toBe(2)
  })

  it('an isolated/explicit config dir is handed to the patcher, so it writes the cache the session launches from', () => {
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_cfg_dir" python3 "\$INSTALL_DIR\/scripts\/patch-telegram-plugin\.py"/)
  })
})

// fc8629d7: the plugin relayed the main agent's tool-permission request to EVERY allowlisted chat, with Allow / Deny
// buttons, and took an answer (a button or a "yes <id>" text) from any of them. Allowlisted means "may talk to the
// agent", not "may approve its tool calls". The patch reads an approver list (TELEGRAM_PERMISSION_APPROVERS, chat ids)
// and checks it on all three paths; an empty list leaves the capability undeclared (fail-closed). The blocks below
// run the PATCHED plugin code (the verbatim 0.0.7 blocks of the fixture) with a fake server, bot and environment; the
// unpatched fixture is the negative control: it is what the plugin does today.
const PERM = 'MARVEEN-PATCH(fc8629d7-perm)'
const PERM_OFF = 'MARVEEN-PATCH(fc8629d7-perm-off)'
const ALLOWED = ['111', '222', '333']

type PermRun = {
  wire: string
  relay: (params: Record<string, string>) => Promise<string[]>
  button: (fromId: number, data: string) => Promise<{ answered: unknown[]; events: unknown[] }>
}

// The server construction, the permission_request relay and the inline-button handler, run once per call.
function permBlocks(text: string, approvers: string | undefined): PermRun {
  const start = text.includes('const PERMISSION_APPROVERS') ? text.indexOf('const PERMISSION_APPROVERS') : text.indexOf('const mcp = new Server(')
  const end = text.indexOf('mcp.setRequestHandler(ListToolsRequestSchema')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const js = ts.transpileModule(text.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: string[] = []
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {}
  class FakeServer {
    capabilities: unknown
    relay: ((n: unknown) => Promise<void>) | undefined
    events: unknown[] = []
    constructor(_info: unknown, opts: { capabilities: unknown }) { this.capabilities = opts.capabilities; servers.push(this) }
    setNotificationHandler(_schema: unknown, fn: (n: unknown) => Promise<void>) { this.relay = fn }
    notification(n: unknown) { this.events.push(n); return Promise.resolve() }
  }
  const servers: FakeServer[] = []
  class FakeKeyboard { text() { return this } }
  const z = { object: (x: unknown) => x, literal: (x: unknown) => x, string: () => 'string' }
  const bot = {
    api: { sendMessage: async (chat: string) => { sent.push(chat); return {} } },
    on: (event: string, fn: (ctx: unknown) => Promise<void>) => { handlers[event] = fn },
  }
  const env: Record<string, string> = approvers === undefined ? {} : { TELEGRAM_PERMISSION_APPROVERS: approvers }
  const fakeProcess = { env, stderr: { write: () => true } }
  new Function('Server', 'z', 'InlineKeyboard', 'loadAccess', 'bot', 'process', js)(
    FakeServer, z, FakeKeyboard, () => ({ allowFrom: ALLOWED }), bot, fakeProcess)
  const server = servers[0]
  expect(server).toBeDefined()
  return {
    wire: JSON.stringify(server.capabilities),
    relay: async params => {
      sent.length = 0
      await server.relay!({ params: { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: '{}', ...params } })
      await new Promise(r => setTimeout(r, 0))
      return [...sent]
    },
    button: async (fromId, data) => {
      server.events.length = 0
      const answered: unknown[] = []
      await handlers['callback_query:data']({
        callbackQuery: { data, message: { text: '🔐 Permission: Bash' } },
        from: { id: fromId },
        answerCallbackQuery: async (a?: unknown) => { answered.push(a ?? null) },
        editMessageText: async () => {},
      })
      return { answered, events: [...server.events] }
    },
  }
}

// The inbound handler's "yes <id>" intercept: what an allowlisted sender's text does.
async function permText(text: string, approvers: string, fromId: number, message: string): Promise<unknown[]> {
  const start = text.indexOf('async function handleInbound(')
  const js = ts.transpileModule(text.slice(start, text.indexOf('\n}\n', start) + 3), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const events: unknown[] = []
  const mcp = { notification: (n: unknown) => { events.push(n); return Promise.resolve() } }
  const bot = { api: { setMessageReaction: () => Promise.resolve(), sendChatAction: () => Promise.resolve() } }
  const PERMISSION_APPROVERS = approvers.split(',').map(s => s.trim()).filter(Boolean)
  const handleInbound = new Function('gate', 'mcp', 'bot', 'PERMISSION_REPLY_RE', 'PERMISSION_APPROVERS', `${js}; return handleInbound`)(
    () => ({ action: 'deliver', access: { allowFrom: ALLOWED } }), mcp, bot, /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i, PERMISSION_APPROVERS)
  await handleInbound({ from: { id: fromId }, chat: { id: fromId }, message: { message_id: 7 } }, message, undefined).catch(() => {})
  return events
}

describe('perm: permission requests only for the approver list (fc8629d7)', () => {
  it('five marked lines, one per anchor, no fallback line, and the file still parses', () => {
    expect(run().status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    expect(text.split('\n').filter(l => l.includes(PERM))).toHaveLength(5)
    expect(text).not.toContain(PERM_OFF)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('the capability is declared only with a non-empty list: no list, an empty one or blanks keep it off the wire', () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(permBlocks(text, '111').wire).toContain('claude/channel/permission')
    for (const list of [undefined, '', ' , ']) expect(permBlocks(text, list).wire).not.toContain('claude/channel/permission')
    // NEGATIVE CONTROL, today's plugin: declared whatever the environment says.
    expect(permBlocks(readFileSync(FIXTURE, 'utf-8'), undefined).wire).toContain('claude/channel/permission')
  })

  it('the relay: only the approvers among the allowlisted chats get the buttons, nobody with an empty list', async () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(await permBlocks(text, '111').relay({})).toEqual(['111'])
    expect(await permBlocks(text, '111, 444').relay({})).toEqual(['111'])
    expect(await permBlocks(text, '').relay({})).toEqual([])
    // NEGATIVE CONTROL: today every allowlisted chat gets them.
    expect(await permBlocks(readFileSync(FIXTURE, 'utf-8'), undefined).relay({})).toEqual(ALLOWED)
  })

  it('a button answer counts only from an approver: Allow, Deny and See more from anyone else are refused', async () => {
    run()
    const text = readFileSync(server, 'utf-8')
    for (const data of ['perm:allow:abcde', 'perm:deny:abcde', 'perm:more:abcde']) {
      const other = await permBlocks(text, '111').button(222, data)
      expect(other.events).toEqual([])
      expect(other.answered).toEqual([{ text: 'Not authorized.' }])
    }
    expect((await permBlocks(text, '111').button(111, 'perm:allow:abcde')).events).toEqual([
      { method: 'notifications/claude/channel/permission', params: { request_id: 'abcde', behavior: 'allow' } }])
    // NEGATIVE CONTROL: today an allowlisted non-approver's Allow goes through.
    expect((await permBlocks(readFileSync(FIXTURE, 'utf-8'), undefined).button(222, 'perm:allow:abcde')).events).toHaveLength(1)
  })

  it('a "yes <id>" text answer counts only from an approver; from anyone else it is dropped, no event', async () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(await permText(text, '111', 222, 'yes abcde')).toEqual([])
    expect(await permText(text, '111', 111, 'yes abcde')).toEqual([
      { method: 'notifications/claude/channel/permission', params: { request_id: 'abcde', behavior: 'allow' } }])
    // NEGATIVE CONTROL: today an allowlisted non-approver's "yes" approves.
    expect(await permText(readFileSync(FIXTURE, 'utf-8'), '', 222, 'yes abcde')).toHaveLength(1)
  })

  it('fail-closed on a plugin update: one moved anchor leaves perm out loudly, perm-off takes the capability away for good', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace('  if (permMatch) {', '  if (permMatch != null) {'))
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: permission text answer not found exactly once.*the perm patch left out, the perm-off line takes the permission relay away/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain(PERM)
    expect(text.split('\n').filter(l => l.includes(PERM_OFF))).toHaveLength(1)
    expect(syntaxErrors(text)).toEqual([])
    expect(permBlocks(text, '111').wire).not.toContain('claude/channel/permission')
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', perm: 'anchor-missing:permission text answer', 'perm-off': 'patched' })
  })

  it('taking it back = deleting the perm-marked lines: byte-identical to the file patched without perm', () => {
    run()
    const back = readFileSync(server, 'utf-8').split('\n').filter(l => !l.includes(PERM)).join('\n')
    const code = [
      'import importlib.util, sys',
      "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      "m.PATCHES = [p for p in m.PATCHES if p['name'] not in ('perm', 'perm-off')]",
      'sys.stdout.write(m.patch_text(sys.stdin.read())[0])',
    ].join('\n')
    const r = spawnSync('python3', ['-c', code, SCRIPT], { input: readFileSync(FIXTURE, 'utf-8'), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(back).toBe(r.stdout)
  })
})
