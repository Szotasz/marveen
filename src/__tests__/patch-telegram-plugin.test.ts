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
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'patched', patches: { d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched' } }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'already', patches: { d4: 'already', fwd: 'already', evid: 'already', kbd: 'already' } }])
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
    expect(readState(state).files[0].patches).toEqual({ d4: 'anchor-missing:status handler', fwd: 'patched', evid: 'patched', kbd: 'patched' })
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

// c67f5f34: one-tap answer buttons on the reply tool, as an INLINE keyboard under the message. A tap comes back as the
// label in an ordinary text message. Six marked insertions: the schema field, its check before anything is sent, the
// inline keyboard on the LAST text chunk, the Set of answered messages, the kbd branch of the callback handler, and the
// ts / message_id of the inbound meta of a tap. (The behaviour of the callback branch itself: the callback tests below
// the patch mechanics.)
const KBD = 'MARVEEN-PATCH(c67f5f34-kbd)'
const KBD_MARKER = '// MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons'
// The live apv patch (PR #1964) line, word for word: it must sit right after the `const data` line.
const APV_LINE = "  if (data.startsWith('apv:')) { await marveenApprovalCallback(ctx, data, { stateDir: STATE_DIR, readFileSync, fetch, loadAccess, env: process.env, envAtLoad: MARVEEN_APV_ENV_AT_LOAD }); return } // MARVEEN-PATCH(345f34e2-apv)"
const CALLBACK_OPEN = "bot.on('callback_query:data', async ctx => {"

// The three lines of the FIRST version (the reply keyboard, commit 6eec41a2), as the old script wrote them into the
// fixture. Kept as literals, not generated from the script.
const OLD_KBD_SCHEMA = "          buttons: { type: 'array', items: { type: 'string' }, description: 'Optional one-tap answer buttons, shown as a keyboard under the input field and hidden after one tap; the tapped label comes back as an ordinary text message from the user. Also write the options into text, so the question can be answered by typing. An empty list removes a keyboard shown earlier. At most 12 labels, each non-empty and at most 64 characters.' }, // MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons"
const OLD_KBD_CHECK = "        const kbdButtons = args.buttons == null ? undefined : Array.isArray(args.buttons) && args.buttons.length <= 12 && args.buttons.every(b => typeof b === 'string' && b.trim() !== '' && b.length <= 64) ? (args.buttons as string[]) : (() => { throw new Error('buttons: a list of at most 12 non-empty labels, each at most 64 characters') })() // MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons"
const OLD_KBD_SEND = "              ...(kbdButtons && i === chunks.length - 1 ? { reply_markup: kbdButtons.length ? { keyboard: kbdButtons.map(label => [{ text: label }]), one_time_keyboard: true, resize_keyboard: true } : { remove_keyboard: true as const } } : {}), // MARVEEN-PATCH(c67f5f34-kbd): one-tap answer buttons"

const kbdLines = (text: string): string[] => text.split('\n').filter(l => l.includes(KBD))

// The fixture patched by the script WITHOUT the kbd patch (the state a file had before this change).
function patchedWithoutKbd(text: string, topics = false): string {
  const code = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    "m.PATCHES = [p for p in m.PATCHES if p['name'] != 'kbd']",
    "sys.stdout.write(m.patch_text(sys.stdin.read(), sys.argv[2] == 'on')[0])",
  ].join('\n')
  const r = spawnSync('python3', ['-c', code, SCRIPT, topics ? 'on' : 'off'], { input: text, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

// The file as the FIRST kbd version left it: the three old lines put after the same anchors.
function withOldKbd(text: string): string {
  const lines = patchedWithoutKbd(text).split('\n')
  const after = (re: RegExp, extra: number, add: string) => {
    const i = lines.findIndex(l => re.test(l))
    expect(i).toBeGreaterThan(0)
    lines.splice(i + 1 + extra, 0, add)
  }
  after(/^ *description: 'Absolute file paths to attach\. /, 1, OLD_KBD_SCHEMA) // after the `},` that closes `files`
  after(/^ *assertAllowedChat\(chat_id\)$/, 0, OLD_KBD_CHECK)
  after(/^ *\.\.\.\(parseMode \? \{ parse_mode: parseMode \} : \{\}\),$/, 0, OLD_KBD_SEND)
  return lines.join('\n')
}

type Sent = { chat: string; text: string; opts: Record<string, unknown> }

// Runs the PATCHED tool-call handler of the fixture (the verbatim 0.0.7 block) with a fake bot: what the reply tool
// really passes to sendMessage. Only the reply case runs; the names the other cases use are never evaluated.
// `allowFrom` is what loadAccess() says: the chat ids (= user ids) the buttons may go to.
function replyHandler(patched: string, allowFrom: string[] = ['42']): { call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>; sent: Sent[] } {
  const start = patched.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  expect(start).toBeGreaterThan(0)
  const js = ts.transpileModule(patched.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: Sent[] = []
  let handler: ((req: unknown) => Promise<never>) | undefined
  const mcp = { setRequestHandler: (_schema: unknown, fn: (req: unknown) => Promise<never>) => { handler = fn } }
  const bot = { api: { sendMessage: async (chat: string, text: string, opts: Record<string, unknown>) => { sent.push({ chat, text, opts }); return { message_id: sent.length } } } }
  const names = ['mcp', 'CallToolRequestSchema', 'assertAllowedChat', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES',
    'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'bot', 'extname', 'InputFile', 'PHOTO_EXTS', 'PERMISSION_REPLY_RE']
  new Function(...names, js)(mcp, {}, () => {}, () => {}, () => ({ size: 0 }), 50 * 1024 * 1024,
    () => ({ allowFrom }), 4096, (text: string) => text.split('|'), bot, () => '', class {}, new Set(),
    /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i)
  expect(handler).toBeDefined()
  return { call: args => handler!({ params: { name: 'reply', arguments: args } }), sent }
}

describe('kbd: inline answer buttons (c67f5f34)', () => {
  it('every inserted line carries the marker at its end; the buttons field is inside the reply tool schema; the file still parses', () => {
    expect(run().status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    const lines = kbdLines(text)
    expect(lines).toHaveLength(22)
    for (const l of lines) expect(l.endsWith(' ' + KBD_MARKER)).toBe(true)
    const reply = text.indexOf("name: 'reply'")
    const react = text.indexOf("name: 'react'")
    const field = text.indexOf("buttons: { type: 'array'")
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(react).toBeGreaterThan(field)
    expect(text).not.toContain('one_time_keyboard')
    expect(text).not.toContain('resize_keyboard')
    expect(text).toContain("callback_data: 'kbd:' + n")
    expect(syntaxErrors(text)).toEqual([])
  })

  it('the Set sits right after PERMISSION_REPLY_RE; the callback branch right after the perm regex, before `if (!m) {`', () => {
    run()
    const lines = readFileSync(server, 'utf-8').split('\n')
    const re = lines.findIndex(l => l.startsWith('const PERMISSION_REPLY_RE = '))
    expect(lines[re + 1]).toBe(`const marveenKbdAnswered = new Set<string>() ${KBD_MARKER}`)
    const perm = lines.findIndex(l => l.startsWith('  const m = /^perm:'))
    expect(lines[perm + 1]).toBe(`  if (data.startsWith('kbd:')) { ${KBD_MARKER}`)
    const close = lines.findIndex((l, i) => i > perm && l === `  } ${KBD_MARKER}`)
    expect(lines[close + 1]).toBe('  if (!m) {')
    for (let i = perm + 1; i <= close; i++) expect(lines[i].endsWith(KBD_MARKER)).toBe(true)
  })

  it('the reply sends the inline keyboard on the LAST chunk only, one label per row, callback_data kbd:<index>', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const res = await h.call({ chat_id: '42', text: 'Első rész|A: elfogadod, B: már megoldva, C: más megoldás?', buttons: ['A. Elfogadom', 'B. Már megoldva', 'C. Valami más lesz a megoldás'] })
    expect(res.isError).toBeUndefined()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0].opts).not.toHaveProperty('reply_markup')
    expect(h.sent[1].opts.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'A. Elfogadom', callback_data: 'kbd:0' }],
        [{ text: 'B. Már megoldva', callback_data: 'kbd:1' }],
        [{ text: 'C. Valami más lesz a megoldás', callback_data: 'kbd:2' }],
      ],
    })
  })

  it('markdownv2: the parse_mode stays in the same options object as the keyboard', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: '*Kérdés*', format: 'markdownv2', buttons: ['Igen', 'Nem'] })
    expect(h.sent[0].opts.parse_mode).toBe('MarkdownV2')
    expect(h.sent[0].opts.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Igen', callback_data: 'kbd:0' }], [{ text: 'Nem', callback_data: 'kbd:1' }]] })
  })

  it('an empty list removes a keyboard shown earlier; no buttons means no reply_markup at all', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: 'Köszönöm, rögzítettem.', buttons: [] })
    expect(h.sent[0].opts.reply_markup).toEqual({ remove_keyboard: true })
    await h.call({ chat_id: '42', text: 'Sima válasz|két részben' })
    expect(h.sent.slice(1).map(s => 'reply_markup' in s.opts)).toEqual([false, false])
  })

  it('a bad buttons value is a tool error BEFORE anything is sent; the limits themselves are accepted', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const bad: unknown[] = ['A', [''], ['   '], [1], ['x'.repeat(65)], Array.from({ length: 13 }, (_, i) => `${i}`)]
    for (const buttons of bad) {
      const res = await h.call({ chat_id: '42', text: 'Kérdés', buttons })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/^reply failed: buttons: /)
    }
    expect(h.sent).toHaveLength(0)
    const ok = await h.call({ chat_id: '42', text: 'Kérdés', buttons: [...Array.from({ length: 11 }, (_, i) => `${i}`), 'x'.repeat(64)] })
    expect(ok.isError).toBeUndefined()
  })

  it('a label that could pass for a command, a control character or a permission reply is refused before sending; A/B and 1/2 are fine', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const ch = (code: number) => String.fromCharCode(code)
    const bad = ['/model opus', ' /x', '\t/x', ch(0x200b) + '/x', ch(0xfeff) + '/x', ch(0x1c) + '/x', '(/x', 'a\nb', 'a' + ch(0) + 'b', 'a' + ch(0x85) + 'b',
      'yes abcde', 'No abcde', '  y abcde  ']
    for (const label of bad) {
      const res = await h.call({ chat_id: '42', text: 'Kérdés', buttons: ['Rendben', label] })
      expect(res.isError, JSON.stringify(label)).toBe(true)
      expect(res.content[0].text, JSON.stringify(label)).toMatch(/^reply failed: buttons: /)
    }
    expect(h.sent).toHaveLength(0)
    for (const label of ['A/B', '1/2', 'Igen / nem', 'yes', 'no abc']) {
      const res = await h.call({ chat_id: '42', text: 'Kérdés', buttons: [label] })
      expect(res.isError, JSON.stringify(label)).toBeUndefined()
    }
    expect(h.sent).toHaveLength(5)
  })

  it('buttons go to a private chat of a paired user only; a group (or an unknown chat) gets a tool error, an empty list is still fine', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'), ['42'])
    for (const chat_id of ['-1001234567890', '77']) {
      const res = await h.call({ chat_id, text: 'Kérdés', buttons: ['Igen'] })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/^reply failed: buttons: /)
    }
    expect(h.sent).toHaveLength(0)
    const ok = await h.call({ chat_id: '-1001234567890', text: 'Szöveg', buttons: [] })
    expect(ok.isError).toBeUndefined()
    expect(h.sent).toHaveLength(1)
  })

  it('the inbound meta of a tap: a fresh ts and the id of the question; a typed message keeps its meta (the line adds nothing)', () => {
    run()
    const line = kbdLines(readFileSync(server, 'utf-8')).find(l => l.includes('ts: new Date().toISOString()'))
    expect(line).toBeDefined()
    const meta = new Function('ctx', `return {\n${line}\n}`)
    const tap = meta({ callbackQuery: { message: { message_id: 901 } } })
    expect(tap.message_id).toBe('901')
    expect(Math.abs(Date.now() - Date.parse(tap.ts))).toBeLessThan(5000)
    expect(meta({ message: { message_id: 5, date: 1 } })).toEqual({})
    expect(meta({ callbackQuery: {} })).toEqual({})
  })

  it('taking it back = deleting the marked lines: byte-identical to the file patched without kbd', () => {
    run()
    const withKbd = readFileSync(server, 'utf-8')
    const back = withKbd.split('\n').filter(l => !l.includes(KBD)).join('\n')
    expect(back).toBe(patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    expect(back).not.toContain(KBD)
  })

  it('all or nothing: one moved kbd anchor leaves every kbd line out, loudly; the other patches still applied', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('...(parseMode ? { parse_mode: parseMode } : {}),', '...(parseMode ? { parse_mode: parseMode } : undefined),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply send options not found exactly once.*the kbd patch left out, the reply tool has no buttons/)
    expect(readFileSync(server, 'utf-8')).not.toContain(KBD)
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'anchor-missing:reply send options' })
  })

  it('each of the three new anchors, when moved, leaves every kbd line out on a fresh file', () => {
    const moved: Array<[string, string, string]> = [
      ['permission reply regex', 'const PERMISSION_REPLY_RE = ', 'const PERMISSION_REPLY_RE_2 = '],
      ['callback perm regex', 'const m = /^perm:', 'const mm = /^perm:'],
      ['inbound meta imagePath', '...(imagePath ? { image_path: imagePath } : {}),', '...(imagePath ? { image_path: imagePath } : undefined),'],
    ]
    for (const [name, from, to] of moved) {
      const changed = readFileSync(FIXTURE, 'utf-8').replace(from, to)
      expect(changed).not.toBe(readFileSync(FIXTURE, 'utf-8'))
      writeFileSync(server, changed)
      const state = join(cache, `state-${name.replace(/ /g, '-')}.json`)
      const r = run(['--state', state])
      expect(r.stderr).toMatch(new RegExp(`LOUD: ${name} not found exactly once.*the kbd patch left out`))
      expect(readFileSync(server, 'utf-8')).not.toContain(KBD)
      expect(readState(state).files[0].patches.kbd).toBe(`anchor-missing:${name}`)
    }
  })

  it('a file patched by the previous version (d4, fwd, evid) gets kbd on the next run', () => {
    writeFileSync(server, patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(kbd\)/)
    expect(kbdLines(readFileSync(server, 'utf-8'))).toHaveLength(22)
  })

  it('a file with the FIRST kbd version (reply keyboard) is rebuilt in place: byte-identical to a fresh patching, no old line left', () => {
    run()
    const fresh = readFileSync(server, 'utf-8')
    const old = withOldKbd(readFileSync(FIXTURE, 'utf-8'))
    expect(kbdLines(old)).toHaveLength(3)
    expect(old).toContain('one_time_keyboard')
    writeFileSync(server, old)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*\(kbd\)/)
    const text = readFileSync(server, 'utf-8')
    expect(text).toBe(fresh)
    expect(text).not.toContain('one_time_keyboard')
    expect(text).not.toContain('resize_keyboard')
    expect(readState(state).files[0].patches.kbd).toBe('patched')
    // and the next run leaves it alone
    const again = run()
    expect(again.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(fresh)
  })

  it('a file with the first kbd version and a moved new anchor keeps the old lines untouched, loudly', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('const m = /^perm:', 'const mm = /^perm:')
    const old = withOldKbd(changed)
    writeFileSync(server, old)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: callback perm regex not found exactly once.*the kbd patch left out/)
    expect(readFileSync(server, 'utf-8')).toBe(old)
    expect(readState(state).files[0].patches.kbd).toBe('anchor-missing:callback perm regex')
  })

  it('a kbd marker not at the end of a line: damaged, the file is not touched, loudly', () => {
    run()
    const text = readFileSync(server, 'utf-8')
    const damaged = text.replace(`${KBD_MARKER}\n`, `${KBD_MARKER} (edited)\n`)
    expect(damaged).not.toBe(text)
    writeFileSync(server, damaged)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: kbd markers damaged in .*the kbd patch left alone/)
    expect(readFileSync(server, 'utf-8')).toBe(damaged)
    const file = readState(state).files[0]
    expect(file.patches.kbd).toBe('damaged:kbd markers')
    expect(file.status).toBe('damaged:kbd markers')
  })

  it('topics on, off and on again: kbd is `already` every time after the first run, and the ts override stays right before the imagePath line', () => {
    const state = join(cache, 'state.json')
    run(['--topics', 'on', '--state', state])
    const withTopics = readFileSync(server, 'utf-8')
    const lines = withTopics.split('\n')
    const i = lines.findIndex(l => l.includes('ts: new Date().toISOString()') && l.includes(KBD))
    expect(lines[i + 1].trim()).toBe('...(imagePath ? { image_path: imagePath } : {}),')
    expect(withTopics).toContain('MARVEEN-PATCH(tgtopics)')
    const again = run(['--topics', 'on', '--state', state])
    expect(again.stderr).toBe('')
    expect(readState(state).files[0].patches.kbd).toBe('already')
    expect(readFileSync(server, 'utf-8')).toBe(withTopics)
    run(['--topics', 'off', '--state', state])
    expect(readState(state).files[0].patches.kbd).toBe('already')
    const off = readFileSync(server, 'utf-8')
    expect(off).not.toContain('MARVEEN-PATCH(tgtopics)')
    expect(kbdLines(off)).toHaveLength(22)
    const offAgain = run(['--topics', 'off', '--state', state])
    expect(offAgain.stderr).toBe('')
    run(['--topics', 'on', '--state', state])
    expect(readFileSync(server, 'utf-8')).toBe(withTopics)
    expect(readState(state).files[0].patches.kbd).toBe('already')
  })

  it('topics first, kbd second gives the same file as kbd first, topics second', () => {
    run(['--topics', 'on'])
    const kbdFirst = readFileSync(server, 'utf-8')
    writeFileSync(server, patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8'), true))
    run(['--topics', 'on'])
    expect(readFileSync(server, 'utf-8')).toBe(kbdFirst)
  })

  it('with the apv hook line (PR #1964) after `const data`: kbd goes in after the perm regex and leaves that stretch alone, in both patch orders', () => {
    const hook = (text: string) => {
      const lines = text.split('\n')
      const open = lines.indexOf(CALLBACK_OPEN)
      expect(open).toBeGreaterThan(0)
      return { lines, open }
    }
    const fixtureText = readFileSync(FIXTURE, 'utf-8')
    // apv first, kbd second
    const withApv = fixtureText.replace(`${CALLBACK_OPEN}\n  const data = ctx.callbackQuery.data\n`, `${CALLBACK_OPEN}\n  const data = ctx.callbackQuery.data\n${APV_LINE}\n`)
    expect(withApv).not.toBe(fixtureText)
    writeFileSync(server, withApv)
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(.*kbd.*\)/)
    const first = readFileSync(server, 'utf-8')
    const a = hook(first)
    expect(a.lines.slice(a.open + 1, a.open + 4)).toEqual([
      '  const data = ctx.callbackQuery.data',
      APV_LINE,
      expect.stringMatching(/^ {2}const m = \/\^perm:/),
    ])
    expect(a.lines[a.open + 4]).toBe(`  if (data.startsWith('kbd:')) { ${KBD_MARKER}`)
    expect(syntaxErrors(first)).toEqual([])
    // kbd first, the apv line put in afterwards (as the apv patch does): the next kbd run changes nothing
    writeFileSync(server, fixtureText)
    run()
    const kbdOnly = readFileSync(server, 'utf-8')
    const b = hook(kbdOnly)
    expect(b.lines[b.open + 2]).toMatch(/^ {2}const m = \/\^perm:/)
    const lines = [...b.lines]
    lines.splice(b.open + 2, 0, APV_LINE)
    writeFileSync(server, lines.join('\n'))
    const state = join(cache, 'state.json')
    const r2 = run(['--state', state])
    expect(r2.stderr).toBe('')
    expect(readState(state).files[0].patches.kbd).toBe('already')
    expect(readFileSync(server, 'utf-8')).toBe(first)
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
