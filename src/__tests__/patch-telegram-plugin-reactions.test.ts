// scripts/patch-telegram-plugin.py, the switchable `react` patch (TELEGRAM_REACTIONS_ENABLED, tgreact1119): the
// owner's emoji reactions reach the agent. Three layers:
//  - the script: off / on / on-then-off on the 0.0.7 excerpt, next to the other switches, a moved anchor, the CLI
//    switch and the install setting;
//  - the patched plugin code itself, RUN with stubbed bot/mcp objects: the reaction handler (who may react, what is
//    delivered, what is not), the reply tool keeping the excerpts, the polling asking for the reactions;
//  - /status and the registry entry.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { telegramPluginPatchStatus } from '../web/system-status.js'
import { scratchPatcher, REPO_PATCHER } from './helpers/scratch-patcher.js'

const ROOT = join(__dirname, '..', '..')
// A copy in an empty scratch install (helpers/scratch-patcher.ts): the checkout's own .env never decides a test
// (run from the checkout, a TELEGRAM_REACTIONS_ENABLED=1 there turned a case red).
const PATCHER = scratchPatcher()
const SCRIPT = PATCHER.script
afterAll(() => PATCHER.remove())
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')
const TAG = 'MARVEEN-PATCH(tgreact1119)'

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-react-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

// Every switch given; the language comes from the scratch install, which has no .env.
function run(extra: string[], script = SCRIPT): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [script, '--topics', 'off', '--buttons', 'on', '--buttons-max-age', '0', ...extra, cache],
    { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}
function patched(extra: string[]): string {
  copyFileSync(FIXTURE, server)
  expect(run(extra).status).toBe(0)
  return readFileSync(server, 'utf-8')
}
const reactLines = (text: string) => text.split('\n').filter(l => l.includes(TAG))
function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

describe('patch-telegram-plugin.py --reactions', () => {
  // The same guard as in patch-telegram-plugin.test.ts (#2964): the script is the copy, not the checkout's.
  it('runs from a copy in an empty scratch install, so the checkout\'s own .env never decides a test', () => {
    expect(SCRIPT.startsWith(ROOT)).toBe(false)
    expect(existsSync(join(PATCHER.install, '.env'))).toBe(false)
    expect(existsSync(join(PATCHER.install, 'store'))).toBe(false)
    expect(readFileSync(SCRIPT, 'utf-8')).toBe(readFileSync(REPO_PATCHER, 'utf-8'))
  })

  it('off (the default): no line of it, the file is what it was without the switch, the state says off', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state]).status).toBe(0)
    const plain = readFileSync(server, 'utf-8')
    expect(plain).not.toContain('tgreact')
    expect(plain).not.toContain('message_reaction')
    copyFileSync(FIXTURE, server)
    expect(run(['--reactions', 'off']).status).toBe(0)
    expect(readFileSync(server, 'utf-8')).toBe(plain)
    const s = JSON.parse(readFileSync(state, 'utf-8'))
    expect(s.reactions).toBe('off')
    expect(s.files[0].patches).not.toHaveProperty('react')
  })

  it('on: the three steps once each, every line ends with the tag, the file parses; a rerun is a byte-identical no-op', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state, '--reactions', 'on']).status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    const lines = reactLines(text)
    expect(lines).toHaveLength(15)
    for (const l of lines) expect(l.endsWith(' // ' + TAG)).toBe(true)
    expect(syntaxErrors(text)).toEqual([])
    // the polling line sits inside bot.start({ ... }), right before onStart
    const all = text.split('\n')
    const onStart = all.findIndex(l => l.trim() === 'onStart: info => {')
    expect(all[onStart - 1]).toBe(`        allowed_updates: [...(await import('grammy')).API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'message_reaction'], // ${TAG}`)
    expect(all[onStart - 2].trim()).toBe('await bot.start({')
    // the excerpt line right before the files comment, inside the reply tool
    const files = all.findIndex(l => l.trim().startsWith('// Files go as separate messages'))
    expect(all[files - 1]).toMatch(/^ +for \(let n = 0; n < sentIds\.length; n\+\+\) \{/)
    // the handler at module level, right before the polling loop
    const loop = all.findIndex(l => l === 'void (async () => {')
    expect(all[loop - 1]).toBe(`}) // ${TAG}`)
    expect(all.findIndex(l => l.startsWith("bot.on('message_reaction'"))).toBeLessThan(loop)
    expect(JSON.parse(readFileSync(state, 'utf-8'))).toMatchObject({ reactions: 'on', files: [{ patches: { react: 'patched' } }] })
    expect(run(['--state', state, '--reactions', 'on']).status).toBe(0)
    expect(readFileSync(server, 'utf-8')).toBe(text)
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches.react).toBe('already')
  })

  it('on then off gives back the file patched without it, byte for byte, next to topics on, buttons off and a max age', () => {
    for (const other of [[], ['--topics', 'on'], ['--buttons', 'off', '--buttons-max-age', '24']]) {
      const off = patched([...other, '--reactions', 'off'])
      const on = patched([...other, '--reactions', 'on'])
      expect(on, other.join(' ')).not.toBe(off)
      expect(syntaxErrors(on)).toEqual([])
      const state = join(cache, 'state.json')
      expect(run([...other, '--state', state, '--reactions', 'off']).status).toBe(0)
      expect(readFileSync(server, 'utf-8'), other.join(' ')).toBe(off)
      expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches.react).toBe('removed')
      // and on again from there is the fresh "on" file: no order between the switches matters
      expect(run([...other, '--reactions', 'on']).status).toBe(0)
      expect(readFileSync(server, 'utf-8'), other.join(' ')).toBe(on)
    }
    // switching another patch while this one is on keeps the same file as patching both fresh
    patched(['--reactions', 'on'])
    expect(run(['--reactions', 'on', '--topics', 'on', '--buttons-max-age', '24']).status).toBe(0)
    expect(readFileSync(server, 'utf-8')).toBe(patched(['--reactions', 'on', '--topics', 'on', '--buttons-max-age', '24']))
  })

  it('a moved anchor: nothing of it applied, one LOUD line, the other patches still on, exit 0', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace('// Files go as separate messages', '// Files are sent one by one'))
    const state = join(cache, 'state.json')
    const r = run(['--state', state, '--reactions', 'on'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply files comment not found exactly once .* the react patch left out, reactions do not reach the agent/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain(TAG)
    expect(text).toContain('MARVEEN-PATCH(c67f5f34-kbd)')
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches.react).toBe('anchor-missing:reply files comment')
  })

  it('a --reactions value other than on or off: exit 2, nothing patched', () => {
    for (const bad of ['yes', '1', '']) {
      const r = run(['--reactions', bad])
      expect(r.status, bad).toBe(2)
      expect(r.stderr).toMatch(/--reactions takes on or off/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    }
  })

  it("the install's TELEGRAM_REACTIONS_ENABLED decides with no switch, as channels.sh runs it (.env, overrides over it)", () => {
    const install = mkdtempSync(join(tmpdir(), 'tg-react-install-'))
    try {
      mkdirSync(join(install, 'scripts'))
      mkdirSync(join(install, 'store'))
      copyFileSync(SCRIPT, join(install, 'scripts', 'patch-telegram-plugin.py'))
      const bare = (env: string, overrides: Record<string, string> | null) => {
        writeFileSync(join(install, '.env'), env)
        if (overrides) writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify(overrides))
        copyFileSync(FIXTURE, server)
        const st = join(install, 'store', 'telegram-plugin-patch.json')
        const r = spawnSync('python3', [join(install, 'scripts', 'patch-telegram-plugin.py'), '--state', st, cache],
          { encoding: 'utf-8', timeout: 30_000 })
        expect(r.status, r.stderr).toBe(0)
        return { text: readFileSync(server, 'utf-8'), reactions: JSON.parse(readFileSync(st, 'utf-8')).reactions }
      }
      const unset = bare('', null)
      expect(unset.reactions).toBe('off')
      expect(unset.text).not.toContain(TAG)
      const on = bare('TELEGRAM_REACTIONS_ENABLED=1\n', null)
      expect(on.reactions).toBe('on')
      expect(reactLines(on.text)).toHaveLength(15)
      const off = bare('TELEGRAM_REACTIONS_ENABLED=1\n', { TELEGRAM_REACTIONS_ENABLED: '0' })
      expect(off.reactions).toBe('off')
      expect(off.text).toBe(unset.text)
    } finally {
      rmSync(install, { recursive: true, force: true })
    }
  })
})

// ---- the patched code, run ------------------------------------------------------------------------------------------

type Notification = { method: string; params: { content: string; meta: Record<string, string> } }
type Reaction = { type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string } | { type: 'paid' }

// The handler as patched: the module-level lines from the Map to the closing `})`, run with stubbed plugin objects.
function reactionHarness(text: string, o: { allowFrom?: string[]; gate?: string; notifyFails?: boolean } = {}) {
  const lines = text.split('\n')
  const from = lines.findIndex(l => l.startsWith('const marveenReactSent = '))
  const to = lines.findIndex((l, i) => i > from && l === `}) // ${TAG}`)
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const notifications: Notification[] = []
  const gateCalls: unknown[] = []
  const stderr: string[] = []
  let handler: ((ctx: unknown) => Promise<void>) | undefined
  let event = ''
  const bot = { on: (ev: string, fn: (ctx: unknown) => Promise<void>) => { event = ev; handler = fn } }
  const mcp = { notification: (n: Notification) => { notifications.push(n); return o.notifyFails ? Promise.reject(new Error('closed')) : Promise.resolve() } }
  const proc = { stderr: { write: (s: string) => { stderr.push(s) } } }
  const sent = new Function('bot', 'mcp', 'loadAccess', 'gate', 'process',
    transpile(lines.slice(from, to + 1).join('\n')) + '\nreturn marveenReactSent')(
    bot, mcp, () => ({ allowFrom: o.allowFrom ?? ['42'] }),
    (ctx: unknown) => { gateCalls.push(ctx); return { action: o.gate ?? 'deliver' } }, proc) as Map<string, string>
  expect(event).toBe('message_reaction')
  const react = async (r: { old?: Reaction[]; now: Reaction[]; messageId?: number; chat?: { id: number; type: string }; user?: { id: number; username?: string } | null; date?: number }) => {
    const user = r.user === null ? undefined : (r.user ?? { id: 42, username: 'owner' })
    const messageReaction = { chat: r.chat ?? { id: 42, type: 'private' }, message_id: r.messageId ?? 901, ...(user ? { user } : {}),
      date: r.date ?? 1795000000, old_reaction: r.old ?? [], new_reaction: r.now }
    await handler!({ messageReaction, update: { message_reaction: messageReaction } })
    await new Promise(res => setImmediate(res))
  }
  return { react, notifications, gateCalls, sent, stderr }
}
const emoji = (e: string): Reaction => ({ type: 'emoji', emoji: e })

describe('the reaction handler (patched, run)', () => {
  let text = ''
  beforeEach(() => { text = patched(['--reactions', 'on']) })

  it('an added emoji from the paired owner: "(reaction 👍)", the message it is on and its excerpt, the reaction date', async () => {
    const h = reactionHarness(text)
    h.sent.set('42:901', 'Kész a frissítés, mehet a próba?')
    await h.react({ now: [emoji('👍')], date: 1795000000 })
    expect(h.notifications).toEqual([{
      method: 'notifications/claude/channel',
      params: {
        content: '(reaction 👍)',
        meta: { chat_id: '42', user: 'owner', user_id: '42', reaction: '👍', reply_to_message_id: '901',
          reply_to_text: 'Kész a frissítés, mehet a próba?', ts: new Date(1795000000 * 1000).toISOString() },
      },
    }])
    // no message id of its own: it can never be write-command evidence, and the ledger keys nothing on it
    expect(h.notifications[0].params.meta).not.toHaveProperty('message_id')
    expect(h.gateCalls).toHaveLength(1)
  })

  it('a message not in the map (sent before a restart, or the owner\'s own): the id only; no username: the id as user', async () => {
    const h = reactionHarness(text)
    await h.react({ now: [emoji('❤')], messageId: 77, user: { id: 42 } })
    expect(h.notifications[0].params.meta).toEqual({ chat_id: '42', user: '42', user_id: '42', reaction: '❤',
      reply_to_message_id: '77', ts: new Date(1795000000 * 1000).toISOString() })
  })

  it('only what this update ADDED goes on: a change, two at once, a custom emoji; a removal or the same set says nothing', async () => {
    const h = reactionHarness(text)
    await h.react({ old: [emoji('👍')], now: [] })
    await h.react({ old: [emoji('👍')], now: [emoji('👍')] })
    await h.react({ old: [{ type: 'custom_emoji', custom_emoji_id: '5' }], now: [{ type: 'custom_emoji', custom_emoji_id: '5' }] })
    expect(h.notifications).toHaveLength(0)
    await h.react({ old: [emoji('👍')], now: [emoji('❤')] })
    await h.react({ old: [emoji('❤')], now: [emoji('❤'), emoji('🔥'), emoji('🎉')] })
    await h.react({ old: [{ type: 'custom_emoji', custom_emoji_id: '5' }], now: [{ type: 'custom_emoji', custom_emoji_id: '6' }] })
    await h.react({ now: [{ type: 'paid' }] })
    expect(h.notifications.map(n => n.params.content)).toEqual(['(reaction ❤)', '(reaction 🔥 🎉)', '(reaction (custom emoji))', '(reaction (paid))'])
    expect(h.notifications[1].params.meta.reaction).toBe('🔥 🎉')
  })

  it('nobody else: a stranger, a group, another chat, an anonymous actor, a gate that drops; none reaches the gate but the last', async () => {
    const h = reactionHarness(text)
    await h.react({ now: [emoji('👍')], user: { id: 7 }, chat: { id: 7, type: 'private' } })
    await h.react({ now: [emoji('👍')], chat: { id: -1001234567890, type: 'supergroup' } })
    await h.react({ now: [emoji('👍')], chat: { id: 43, type: 'private' } })
    await h.react({ now: [emoji('👍')], user: null })
    expect(h.gateCalls).toHaveLength(0)
    const dropped = reactionHarness(text, { gate: 'drop' })
    await dropped.react({ now: [emoji('👍')] })
    expect(dropped.gateCalls).toHaveLength(1)
    expect([...h.notifications, ...dropped.notifications]).toHaveLength(0)
    // a pairing answer (a stranger in pairing mode) would be a side effect: the allowFrom check comes first
    const pairing = reactionHarness(text, { allowFrom: [], gate: 'pair' })
    await pairing.react({ now: [emoji('👍')] })
    expect(pairing.gateCalls).toHaveLength(0)
  })

  it('a notification that fails is one stderr line, not a throw', async () => {
    const h = reactionHarness(text, { notifyFails: true })
    await expect(h.react({ now: [emoji('👍')] })).resolves.toBeUndefined()
    expect(h.stderr).toEqual(['telegram channel: failed to deliver a reaction to Claude: Error: closed\n'])
  })

  it('the handler never goes through handleInbound and writes no evidence line', () => {
    const handlerText = reactLines(text).join('\n')
    expect(handlerText).not.toContain('handleInbound')
    expect(handlerText).not.toContain('inbound-evidence')
    expect(handlerText).not.toContain('writeFileSync')
  })
})

type Sent = { chat: string; text: string; opts: Record<string, unknown> }

// The reply tool as patched (the tool-call handler to the end of the file), with the excerpt map passed in.
function replyHarness(text: string, map: Map<string, string>) {
  const start = text.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  expect(start).toBeGreaterThan(0)
  const sent: Sent[] = []
  let handler: ((req: unknown) => Promise<unknown>) | undefined
  const mcp = { setRequestHandler: (_s: unknown, fn: (req: unknown) => Promise<unknown>) => { handler = fn } }
  const bot = { api: {
    sendMessage: async (chat: string, t: string, opts: Record<string, unknown>) => { sent.push({ chat, text: t, opts }); return { message_id: sent.length } },
    sendDocument: async (chat: string) => { sent.push({ chat, text: '(file)', opts: {} }); return { message_id: sent.length } },
  } }
  const names = ['mcp', 'CallToolRequestSchema', 'assertAllowedChat', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES',
    'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'bot', 'extname', 'InputFile', 'PHOTO_EXTS', 'PERMISSION_REPLY_RE',
    'marveenKbdAnswered', 'marveenKbdOpen', 'marveenReactSent']
  new Function(...names, transpile(text.slice(start)))(mcp, {}, () => {}, () => {}, () => ({ size: 0 }), 50 * 1024 * 1024,
    () => ({ allowFrom: ['42'] }), 4096, (t: string) => t.split('|'), bot, () => '.pdf', class {}, new Set(),
    /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i, new Set(), new Map(), map)
  return { call: (args: Record<string, unknown>) => handler!({ params: { name: 'reply', arguments: args } }), sent }
}

describe('the reply tool keeps an excerpt of what it sent (patched, run)', () => {
  it('each text part under its own id: whitespace collapsed, at most 300 code points; a file is not kept', async () => {
    const map = new Map<string, string>()
    const h = replyHarness(patched(['--reactions', 'on']), map)
    const long = '🙂'.repeat(310)
    await h.call({ chat_id: '42', text: 'Első\n\n  rész|' + long, files: ['/tmp/x.pdf'] })
    expect(h.sent.map(s => s.text)).toEqual(['Első\n\n  rész', long, '(file)'])
    expect([...map.keys()]).toEqual(['42:1', '42:2'])
    expect(map.get('42:1')).toBe('Első rész')
    expect(Array.from(map.get('42:2')!)).toHaveLength(300)
  })

  it('bounded at 500: the oldest goes first', async () => {
    const map = new Map<string, string>()
    for (let i = 0; i < 500; i++) map.set('42:old' + i, 'x')
    const h = replyHarness(patched(['--reactions', 'on']), map)
    await h.call({ chat_id: '42', text: 'Új' })
    expect(map.size).toBe(500)
    expect(map.has('42:old0')).toBe(false)
    expect(map.get('42:1')).toBe('Új')
  })
})

describe('the polling asks for the reactions (patched, run)', () => {
  it("grammY's own default list plus message_reaction, passed to bot.start", async () => {
    const text = patched(['--reactions', 'on'])
    const start = text.indexOf('void (async () => {\n  for (let attempt = 1; ; attempt++) {')
    expect(start).toBeGreaterThan(0)
    // The one substitution: the dynamic import of grammy (not installed here) becomes a stub with its constant.
    const end = text.indexOf('\n})()\n', start)
    expect(end).toBeGreaterThan(start)
    const loop = text.slice(start, end + '\n})()\n'.length).replace("import('grammy')", '__grammy()')
    expect(loop).not.toContain("import('grammy')")
    let options: { allowed_updates?: string[] } = {}
    const bot = { start: async (o: typeof options) => { options = o }, api: { setMyCommands: () => ({ catch: () => {} }) } }
    const DEFAULTS = ['message', 'edited_message', 'callback_query', 'poll']
    new Function('bot', '__grammy', 'process', 'botUsername', transpile(loop))(
      bot, async () => ({ API_CONSTANTS: { DEFAULT_UPDATE_TYPES: DEFAULTS } }), { stderr: { write: () => {} } }, '')
    await new Promise(res => setImmediate(res))
    expect(options.allowed_updates).toEqual([...DEFAULTS, 'message_reaction'])
  })
})

describe('/status and the registry', () => {
  it('/status expects the patch only while the last start ran with the switch on', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state, '--reactions', 'on']).status).toBe(0)
    expect(telegramPluginPatchStatus(state)).toBe('rendben (0.0.7)')
    // the file lost the lines since the start (a plugin update put the original back)
    writeFileSync(server, readFileSync(server, 'utf-8').split('\n').filter(l => !l.includes(TAG)).join('\n'))
    expect(telegramPluginPatchStatus(state)).toBe('HIÁNYZIK (reakciók): 0.0.7 (a fájl az indítás óta cserélődött) · a reakciók nem jutnak el az ügynökhöz')
    expect(run(['--state', state, '--reactions', 'off']).status).toBe(0)
    expect(telegramPluginPatchStatus(state)).toBe('rendben (0.0.7)')
  })

  it('the registry entry: boolean, off by default, channels module, restart; both reference docs describe it', () => {
    const reg = readFileSync(join(ROOT, 'src', 'config-registry.ts'), 'utf-8')
    const entry = reg.slice(reg.indexOf("key: 'TELEGRAM_REACTIONS_ENABLED'"))
    expect(entry.slice(0, 120)).toMatch(/type: 'boolean',\s+default: '0',/)
    expect(entry.slice(0, entry.indexOf('},'))).toMatch(/module: 'channels',\s+secret: false,\s+requiresRestart: true,/)
    expect(readFileSync(SCRIPT, 'utf-8')).toContain('REACT_SETTING = "TELEGRAM_REACTIONS_ENABLED"')
    for (const doc of ['docs/config-reference.md', 'docs/en/config-reference.md']) {
      const d = readFileSync(join(ROOT, doc), 'utf-8')
      expect(d, doc).toContain('#### `TELEGRAM_REACTIONS_ENABLED`')
      expect(d, doc).toMatch(/\| `TELEGRAM_REACTIONS_ENABLED` \| boolean \| `0` /)
    }
  })
})
