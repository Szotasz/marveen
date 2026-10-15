// scripts/patch-telegram-plugin.py (ELSOKOR922 spec D-4): takes /status and
// /help away from the Telegram channel plugin so the command hook can answer
// them. Run for real on a copy of the 0.0.7 plugin excerpt (verbatim blocks,
// fixtures/telegram-plugin-0.0.7/server.ts.txt) in a scratch plugins cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'patched', patches: { d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', apv: 'patched' } }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'already', patches: { d4: 'already', fwd: 'already', evid: 'already', kbd: 'already', apv: 'already' } }])
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
    expect(readState(state).files[0].patches).toEqual({ d4: 'anchor-missing:status handler', fwd: 'patched', evid: 'patched', kbd: 'patched', apv: 'patched' })
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
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'anchor-missing:reply send options', apv: 'patched' })
  })

  it('a file patched by the previous version (d4, fwd, evid) gets kbd on the next run', () => {
    writeFileSync(server, patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(kbd\)/)
    expect(readFileSync(server, 'utf-8').split('\n').filter(l => l.includes(KBD))).toHaveLength(3)
  })
})

// The email-approval buttons. The repo module (an import-free TS file with its own tests) is copied in
// before the callback_query handler, between a BEGIN line carrying its sha256 and an END line, and one call line
// hands every apv: press to it before the perm: regex runs. The perm: branch stays byte for byte.
const APV = 'MARVEEN-PATCH(apv-buttons)'
const APV_SRC = join(ROOT, 'src', 'telegram-plugin-patches', 'approval-callback.ts')
const PERM_LINE = '  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)\n'
const CALL_LINE = "  if (data.startsWith('apv:')) { await marveenApprovalCallback(ctx, data, { stateDir: STATE_DIR, readFileSync, fetch, loadAccess, env: process.env, envAtLoad: MARVEEN_APV_ENV_AT_LOAD }); return } // MARVEEN-PATCH(apv-buttons)\n"
// The env as the plugin loaded it: bun keeps proxying after a runtime delete from process.env.
const SNAP_LINE = 'const MARVEEN_APV_ENV_AT_LOAD = { ...process.env } // MARVEEN-PATCH(apv-buttons)\n'

// The fixture patched by the script without the named patches.
function patchedWithout(text: string, ...names: string[]): string {
  const code = [
    'import importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    "skip = json.loads(sys.argv[2])",
    "m.PATCHES = [p for p in m.PATCHES if p['name'] not in skip]",
    'sys.stdout.write(m.patch_text(sys.stdin.read())[0])',
  ].join('\n')
  const r = spawnSync('python3', ['-c', code, SCRIPT, JSON.stringify(names)], { input: text, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

// The callback_query handler, from its opening line to its closing `})` at column 0.
function callbackHandler(text: string): string {
  const m = /^bot\.on\('callback_query:data', async ctx => \{\n[\s\S]*?^\}\)\n/m.exec(text)
  expect(m).not.toBeNull()
  return m![0]
}

function sha16(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

// A scratch install: the script beside its own src/ tree, so the module source can be varied
// (the script reads <install>/src/telegram-plugin-patches/approval-callback.ts).
function scratchInstall(source: string | null): string {
  const inst = join(cache, 'install')
  mkdirSync(join(inst, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(inst, 'scripts', 'patch-telegram-plugin.py'))
  mkdirSync(join(inst, 'src', 'telegram-plugin-patches'), { recursive: true })
  const src = join(inst, 'src', 'telegram-plugin-patches', 'approval-callback.ts')
  rmSync(src, { force: true })
  if (source !== null) writeFileSync(src, source)
  return join(inst, 'scripts', 'patch-telegram-plugin.py')
}

function runWith(script: string, extra: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [script, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

type CbCall = [string, ...unknown[]]

// Runs the PATCHED block + callback_query handler with a fake bot: which branch a press takes, and what it calls.
function callbackRunner(patched: string, allowFrom: string[], stateDir: string, env: Record<string, string> = {}) {
  const start = patched.indexOf(`// ${APV} BEGIN`)
  expect(start).toBeGreaterThan(0)
  const handler = callbackHandler(patched)
  const end = patched.indexOf(handler) + handler.length
  const js = ts.transpileModule(patched.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let registered: ((ctx: unknown) => Promise<void>) | undefined
  const bot = { on: (ev: string, fn: (ctx: unknown) => Promise<void>) => { expect(ev).toBe('callback_query:data'); registered = fn } }
  const notes: unknown[] = []
  const fetches: Array<[string, RequestInit]> = []
  const fakeFetch = async (url: string, init: RequestInit) => {
    fetches.push([url, init])
    const status = JSON.parse(String(init.body)).status
    return new Response(JSON.stringify({ ok: true, approval: { status }, outcome_text: 'OK' }), { status: 200 })
  }
  // `process` is the plugin's: a fake one with no proxy variable, so the runner's own env cannot leak in
  const names = ['bot', 'STATE_DIR', 'readFileSync', 'fetch', 'loadAccess', 'mcp', 'pendingPermissions', 'InlineKeyboard', 'process']
  new Function(...names, js)(bot, stateDir, readFileSync, fakeFetch, () => ({ allowFrom }),
    { notification: (n: unknown) => { notes.push(n); return Promise.resolve() } }, new Map(), class {}, { env })
  expect(registered).toBeDefined()
  const press = async (data: string, from = 42) => {
    const calls: CbCall[] = []
    const ctx = {
      from: { id: from },
      callbackQuery: { data, message: { message_id: 77, chat: { id: from, type: 'private' }, text: 'Jóváhagyás' } },
      answerCallbackQuery: async (...a: unknown[]) => { calls.push(['answerCallbackQuery', ...a]) },
      editMessageText: async (...a: unknown[]) => { calls.push(['editMessageText', ...a]) },
      editMessageReplyMarkup: async (...a: unknown[]) => { calls.push(['editMessageReplyMarkup', ...a]) },
    }
    await registered!(ctx)
    return calls
  }
  return { press, notes, fetches }
}

describe('apv: email-approval buttons', () => {
  it('1st run: one marked block before the handler, the call line right before the perm: regex, the file parses', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state]).status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    expect(readState(state).files[0].patches.apv).toBe('patched')
    expect(text.split(APV)).toHaveLength(5)
    expect(text).toContain(`// ${APV} BEGIN src-sha256:${sha16(APV_SRC)}\n`)
    expect(text).toContain(`// ${APV} END\n${SNAP_LINE}bot.on('callback_query:data', async ctx => {\n  const data = ctx.callbackQuery.data\n${CALL_LINE}${PERM_LINE}`)
    const begin = text.indexOf(`// ${APV} BEGIN`)
    const block = text.slice(text.indexOf('\n', begin) + 1, text.indexOf(`// ${APV} END`))
    // the module verbatim, only its line-leading `export ` cut
    expect(block).toBe(readFileSync(APV_SRC, 'utf-8').replace(/^export /gm, ''))
    expect(block).not.toMatch(/^export /m)
    expect(block).not.toMatch(/\bimport\b|\bmcp\b|notification/)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('the perm: branch is byte-identical, and taking the patch back (BEGIN..END, snapshot and call line) gives the file patched without it', () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(callbackHandler(text).replace(CALL_LINE, '')).toBe(callbackHandler(readFileSync(FIXTURE, 'utf-8')))
    const back = text.replace(/^\/\/ MARVEEN-PATCH\(apv-buttons\) BEGIN[^\n]*\n[\s\S]*?^\/\/ MARVEEN-PATCH\(apv-buttons\) END\n/m, '').replace(SNAP_LINE, '').replace(CALL_LINE, '')
    expect(back).not.toContain(APV)
    expect(back).toBe(patchedWithout(readFileSync(FIXTURE, 'utf-8'), 'apv'))
  })

  it('the patched handler: apv: goes to the block (one POST to the Telegram endpoint, no model notification), perm: and anything else as before', async () => {
    run()
    const inst = mkdtempSync(join(tmpdir(), 'tg-apv-inst-'))
    try {
      const stateDir = join(inst, '.claude', 'channels', 'telegram')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(join(inst, 'store'))
      writeFileSync(join(inst, 'store', '.dashboard-token'), 'test-token\n')
      const p = callbackRunner(readFileSync(server, 'utf-8'), ['42'], stateDir)
      const id32 = '0123456789abcdef0123456789abcdef'
      const nonce = 'AAAAAAAAAAAAAAAAAAAAAA'
      const ok = await p.press(`apv:a:${id32}:${nonce}`)
      expect(p.fetches).toHaveLength(1)
      expect(p.fetches[0][0]).toBe('http://127.0.0.1:3420/api/approvals/01234567-89ab-cdef-0123-456789abcdef/telegram')
      expect(p.fetches[0][1].method).toBe('POST')
      expect(JSON.parse(String(p.fetches[0][1].body))).toMatchObject({ status: 'approved', resolved_by: 'owner:telegram:42', telegram_message_id: 77, callback_nonce: nonce })
      expect(ok.at(-1)).toEqual(['answerCallbackQuery', { text: '✅ Jóváhagyva.' }])
      // a stranger's press: refused in the block, no request, and still not the perm: branch
      expect(await p.press(`apv:r:${id32}:${nonce}`, 99)).toEqual([['answerCallbackQuery', { text: 'Nem engedélyezett.' }]])
      // a malformed apv: press is answered by the block, never by the perm: branch
      expect(await p.press('apv:a:nope')).toEqual([['answerCallbackQuery', { text: 'Érvénytelen gomb.' }]])
      expect(p.fetches).toHaveLength(1)
      expect(p.notes).toEqual([])
      // perm: exactly as before: the model is notified, no HTTP
      expect(await p.press('perm:allow:abcde')).toEqual([['answerCallbackQuery', { text: '✅ Allowed' }], ['editMessageText', 'Jóváhagyás\n\n✅ Allowed']])
      expect(p.notes).toEqual([{ method: 'notifications/claude/channel/permission', params: { request_id: 'abcde', behavior: 'allow' } }])
      // anything else: the plugin's silent acknowledgement
      expect(await p.press('something-else')).toEqual([['answerCallbackQuery']])
      expect(p.fetches).toHaveLength(1)
    } finally { rmSync(inst, { recursive: true, force: true }) }
  })

  it('the patched handler passes the plugin env: with HTTP_PROXY set an apv: press sends nothing', async () => {
    run()
    const inst = mkdtempSync(join(tmpdir(), 'tg-apv-inst-'))
    try {
      const stateDir = join(inst, '.claude', 'channels', 'telegram')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(join(inst, 'store'))
      writeFileSync(join(inst, 'store', '.dashboard-token'), 'test-token\n')
      const data = `apv:a:${'0123456789abcdef'.repeat(2)}:${'A'.repeat(22)}`
      const refused = [['answerCallbackQuery', { text: 'A gomb most nem működik, dönts a dashboardon.' }]]
      const p = callbackRunner(readFileSync(server, 'utf-8'), ['42'], stateDir, { HTTP_PROXY: 'http://proxy.test:8080' })
      expect(await p.press(data)).toEqual(refused)
      expect(p.fetches).toEqual([])
      // set at load, deleted later: the snapshot still has it (bun would still proxy)
      const loadEnv: Record<string, string> = { HTTP_PROXY: 'http://proxy.test:8080' }
      const q = callbackRunner(readFileSync(server, 'utf-8'), ['42'], stateDir, loadEnv)
      delete loadEnv.HTTP_PROXY
      expect(await q.press(data)).toEqual(refused)
      expect(q.fetches).toEqual([])
      // clean at load, set later: the current env has it
      const runEnv: Record<string, string> = {}
      const r = callbackRunner(readFileSync(server, 'utf-8'), ['42'], stateDir, runEnv)
      runEnv.http_proxy = 'http://proxy.test:8080'
      expect(await r.press(data)).toEqual(refused)
      expect(r.fetches).toEqual([])
      // clean at load and now: the request goes out
      const ok = callbackRunner(readFileSync(server, 'utf-8'), ['42'], stateDir, {})
      expect((await ok.press(data)).at(-1)).toEqual(['answerCallbackQuery', { text: '✅ Jóváhagyva.' }])
      expect(ok.fetches).toHaveLength(1)
    } finally { rmSync(inst, { recursive: true, force: true }) }
  })

  it('2nd run is a byte-identical no-op', () => {
    run()
    const once = readFileSync(server, 'utf-8')
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files[0].patches.apv).toBe('already')
  })

  it.each([
    ['perm regex', (t: string) => t.replace('const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)', 'const m = /^perm:(allow|deny|more|info):([a-km-z]{5})$/.exec(data)')],
    ['callback_query handler', (t: string) => t.replace("bot.on('callback_query:data', async ctx => {", "bot.on('callback_query:data', async (ctx) => {")],
    ['callback_query handler', (t: string) => `${t}\nbot.on('callback_query:data', async ctx => {\n})\n`],
    ['callback data line', (t: string) => t.replace('  const data = ctx.callbackQuery.data\n', '  const data = ctx.callbackQuery.data\n  const extra = 1\n')],
    ['fs readFileSync import', (t: string) => t.replace("import { readFileSync, writeFileSync,", "import { writeFileSync,")],
    ['STATE_DIR', (t: string) => t.replace('const STATE_DIR = ', 'const STATE_DIRECTORY = ')],
    ['loadAccess', (t: string) => t.replace('function loadAccess()', 'function loadAccessFile()')],
  ])('a moved or doubled anchor (%s): loud line, apv left out whole, the other patches still applied', (name, change) => {
    writeFileSync(server, change(readFileSync(FIXTURE, 'utf-8')))
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`LOUD: ${name} not found exactly once`)
    expect(r.stderr).toMatch(/the apv patch left out, the email-approval buttons do nothing/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain(APV)
    expect(text).not.toContain('marveenApprovalCallback')
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', apv: `anchor-missing:${name}` })
  })

  it('a plugin that already has one of the block\'s names: nothing inserted, loudly', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8') + '\nconst MARVEEN_APV_TOAST = 1\n')
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/LOUD: conflict:apv names in .*the apv patch not applied/)
    expect(readFileSync(server, 'utf-8')).not.toContain(APV)
    expect(readState(state).files[0].patches.apv).toBe('conflict:apv names')
  })

  it('a changed module source replaces the old block: one block, the new sha, one call line; then a no-op', () => {
    run()
    const changed = readFileSync(APV_SRC, 'utf-8') + '\n// a later revision\n'
    const script = scratchInstall(changed)
    const state = join(cache, 'state.json')
    const r = runWith(script, ['--state', state])
    expect(r.stderr).toMatch(/patched .*\(apv\)/)
    const text = readFileSync(server, 'utf-8')
    expect(text.split(APV)).toHaveLength(5)
    expect(text).toContain(`BEGIN src-sha256:${createHash('sha256').update(changed).digest('hex').slice(0, 16)}\n`)
    expect(text).toContain('// a later revision\n')
    expect(text).not.toContain(`src-sha256:${sha16(APV_SRC)}`)
    expect(text.split(CALL_LINE)).toHaveLength(2)
    expect(syntaxErrors(text)).toEqual([])
    expect(readState(state).files[0].patches.apv).toBe('patched')
    const again = runWith(script, ['--state', state])
    expect(again.stderr).toBe('')
    expect(readState(state).files[0].patches.apv).toBe('already')
  })

  const fn = (body: string) => `export async function marveenApprovalCallback() { ${body} }\n`
  it.each([
    ['missing', null],
    ['denied import', "import { x } from 'y'\n" + fn('')],
    ['denied import', fn("await import('fs')")],
    ['denied require', fn("require('fs')")],
    // The module test's denylist, run by the patcher too
    ['denied mcp', fn("void mcp.send({})")],
    ['denied notification', fn("void x.notification({})")],
    ['denied console', fn("console.error('x')")],
    ['denied process', fn("process.stderr.write('x')")],
    ['denied process', fn("const e = process")],
    ['denied eval', fn("eval('1')")],
    ['denied Function', fn("new Function('return 1')()")],
    ['denied Bun', fn("Bun.spawn(['ls'])")],
    ['denied child process', fn("const cp = 'child_process'")],
    ['denied child process', fn("execFile('ls')")],
    ['denied child process', fn("spawn('ls')")],
    ['denied globalThis', fn("globalThis.x = 1")],
    ['denied notification', "// sends a notification\n" + fn('')],
    // every top-level name prefixed: a plain `const STATE_DIR` would stop bun from loading the plugin at all
    ['top-level name', 'const STATE_DIR = 1\n' + fn('')],
    ['top-level name', 'export const TOAST = 1\n' + fn('')],
    ['top-level name', 'function helper() {}\n' + fn('')],
    ['top-level name', 'const { marveenApvA, b } = { marveenApvA: 1, b: 2 }\n' + fn('')],
    ['top-level name', 'marveenApvRun()\n' + fn('')],
    ['top-level name', 'let marveenApv = 1\n' + fn('')],
    ['marker or CR in the source', '// MARVEEN-PATCH(apv-buttons) END\n' + fn('')],
    ['export form', 'export default 1\n' + fn('')],
    ['no marveenApprovalCallback', 'export async function somethingElse() {}\n'],
  ])('an unusable module source (%s): nothing inserted, loudly, the other patches applied', (why, source) => {
    const script = scratchInstall(source)
    const state = join(cache, 'state.json')
    const r = runWith(script, ['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain(`LOUD: source-unusable:${why} in`)
    expect(readFileSync(server, 'utf-8')).not.toContain(APV)
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', apv: `source-unusable:${why}` })
  })

  it('the denylist covers the whole source, comments included; prefixed names, comments and closers pass', () => {
    const ok = runWith(scratchInstall([
      '// a module that loads nothing',
      '/**',
      ' * doc',
      ' */',
      'export const MARVEEN_APV_X = {',
      '  a: 1,',
      '} as const',
      'type MarveenApvT = number',
      'export interface MarveenApvI {',
      '  a: number',
      '}',
      'async function marveenApvHelper(): Promise<void> {}',
      'export async function marveenApprovalCallback() { await marveenApvHelper() }',
      '',
    ].join('\n')))
    expect(ok.stderr).toMatch(/patched .*\(d4, fwd, evid, kbd, apv\)/)
    copyFileSync(FIXTURE, server)
    const bad = runWith(scratchInstall("// an import-free module\nexport async function marveenApprovalCallback() {}\n"))
    expect(bad.stderr).toContain('LOUD: source-unusable:denied import in')
    expect(readFileSync(server, 'utf-8')).not.toContain(APV)
  })

  it('the real module source passes every source check', () => {
    const r = spawnSync('python3', ['-c', [
      'import importlib.util, sys',
      "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'block, sha = m.apv_source()',
      "print('ok' if block else 'unusable:' + sha)",
    ].join('\n'), SCRIPT], { encoding: 'utf-8' })
    expect(r.stdout.trim()).toBe('ok')
  })

  // A matching sha label is not enough -- the block and the call line are compared with what the
  // source gives now, and a hand edit is replaced (loudly), then the next run is a no-op again.
  it.each<[string, (t: string) => string]>([
    ['the block', t => t.replace("redirect: 'manual'", "redirect: 'follow'")],
    ['the call line', t => t.replace('env: process.env, envAtLoad', 'env: {}, envAtLoad')],
    ['the snapshot line', t => t.replace('MARVEEN_APV_ENV_AT_LOAD = { ...process.env } //', 'MARVEEN_APV_ENV_AT_LOAD = {} //')],
    ['the snapshot line (removed)', t => t.replace(SNAP_LINE, '')],
    ['a line added inside the block', t => t.replace(`// ${APV} END\n`, `const injected = 1\n// ${APV} END\n`)],
  ])('a hand edit of %s under the matching label is replaced, loudly', (_name, edit) => {
    run()
    const clean = readFileSync(server, 'utf-8')
    const edited = edit(clean)
    expect(edited).not.toBe(clean)
    writeFileSync(server, edited)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: the apv block or a marked apv line differs from its source under a matching label/)
    expect(readFileSync(server, 'utf-8')).toBe(clean)
    expect(readState(state).files[0].patches.apv).toBe('patched')
    const again = run(['--state', state])
    expect(again.stderr).toBe('')
    expect(readState(state).files[0].patches.apv).toBe('already')
  })

  it('the module source gone later: the block in place is kept (not refreshed), loudly', () => {
    run()
    const once = readFileSync(server, 'utf-8')
    const state = join(cache, 'state.json')
    const r = runWith(scratchInstall(null), ['--state', state])
    expect(r.stderr).toMatch(/LOUD: source-unusable:missing in .*not applied or not refreshed/)
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files[0].patches.apv).toBe('source-unusable:missing')
  })

  it.each([
    ['END line gone', (t: string) => t.replace(`// ${APV} END\n`, '')],
    ['call line gone', (t: string) => t.replace(CALL_LINE, '')],
    ['snapshot line doubled', (t: string) => t.replace(SNAP_LINE, SNAP_LINE + SNAP_LINE)],
    ['snapshot line inside the block', (t: string) => t.replace(SNAP_LINE, '').replace(`// ${APV} END\n`, `${SNAP_LINE}// ${APV} END\n`)],
    ['block doubled', (t: string) => t.replace(/^\/\/ MARVEEN-PATCH\(apv-buttons\) BEGIN[^\n]*\n[\s\S]*?^\/\/ MARVEEN-PATCH\(apv-buttons\) END\n/m, b => b + b)],
  ])('damaged markers (%s): the file is not touched, loudly', (_name, damage) => {
    run()
    const damaged = damage(readFileSync(server, 'utf-8'))
    writeFileSync(server, damaged)
    const state = join(cache, 'state.json')
    const r = runWith(scratchInstall(readFileSync(APV_SRC, 'utf-8') + '\n// newer\n'), ['--state', state])
    expect(r.stderr).toMatch(/LOUD: damaged:apv markers in /)
    expect(readFileSync(server, 'utf-8')).toBe(damaged)
    expect(readState(state).files[0]).toMatchObject({ status: 'damaged:apv markers', patches: { apv: 'damaged:apv markers' } })
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
