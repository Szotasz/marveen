// scripts/patch-telegram-plugin.py, the switchable `topics` patch
// (TELEGRAM_TOPICS_ENABLED). Two layers:
//  - the script: on / off / on-then-off on the 0.0.7 excerpt, the setting
//    resolution, a moved anchor;
//  - the patched plugin code itself, RUN with stubbed bot/mcp objects: with the
//    switch off, and with it on but no topic in play, every Bot API call and
//    every inbound meta must be exactly what the unswitched patcher produces.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')
const TAG = 'MARVEEN-PATCH(tgtopics)'

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-topics-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[], script = SCRIPT): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [script, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function patched(topics: 'on' | 'off'): string {
  copyFileSync(FIXTURE, server)
  run(['--topics', topics])
  return readFileSync(server, 'utf-8')
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-telegram-plugin.py --topics', () => {
  it('off (the default): no topics line, and the state says so', () => {
    const state = join(cache, 'state.json')
    expect(run(['--state', state, '--topics', 'off']).status).toBe(0)
    expect(readFileSync(server, 'utf-8')).not.toContain('tgtopics')
    const s = JSON.parse(readFileSync(state, 'utf-8'))
    expect(s.topics).toBe('off')
    expect(s.files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched' })
  })

  it('on: every step applied once, the file still parses, a second run is a byte-identical no-op', () => {
    const state = join(cache, 'state.json')
    const r = run(['--state', state, '--topics', 'on'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*\(d4, fwd, evid, kbd, topics\)/)
    const once = readFileSync(server, 'utf-8')
    expect(syntaxErrors(once)).toEqual([])
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches.topics).toBe('patched')
    const again = run(['--state', state, '--topics', 'on'])
    expect(again.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0]).toMatchObject({ status: 'already', patches: { topics: 'already' } })
  })

  it('on, then off: the topics lines go and the file is byte-identical to a never-switched one', () => {
    const neverSwitched = patched('off')
    copyFileSync(FIXTURE, server)
    run(['--topics', 'on'])
    expect(readFileSync(server, 'utf-8')).toContain(TAG)
    const state = join(cache, 'state.json')
    const r = run(['--state', state, '--topics', 'off'])
    expect(r.stderr).toMatch(/patched .*\(topics removed\)/)
    expect(readFileSync(server, 'utf-8')).toBe(neverSwitched)
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches).toEqual({ d4: 'already', fwd: 'already', evid: 'already', kbd: 'already', topics: 'removed' })
  })

  it('a moved anchor: loud line, topics left out whole, the other patches still applied, exit 0', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace("const reply_to = args.reply_to != null", "const reply_to = args.reply_to !== undefined"))
    const state = join(cache, 'state.json')
    const r = run(['--state', state, '--topics', 'on'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply args not found exactly once.*the topics patch left out, replies and the typing indicator land outside the topic/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain('tgtopics')
    expect(text).toContain('elsokor922-fwd')
    expect(JSON.parse(readFileSync(state, 'utf-8')).files[0].patches.topics).toBe('anchor-missing:reply args')
  })

  describe('without --topics the install setting decides (override > .env > off)', () => {
    let install = ''
    let script = ''
    beforeEach(() => {
      install = mkdtempSync(join(tmpdir(), 'tg-topics-install-'))
      mkdirSync(join(install, 'scripts'))
      mkdirSync(join(install, 'store'))
      script = join(install, 'scripts', 'patch-telegram-plugin.py')
      copyFileSync(SCRIPT, script)
    })
    afterEach(() => rmSync(install, { recursive: true, force: true }))
    const topicsOn = () => { copyFileSync(FIXTURE, server); run([], script); return readFileSync(server, 'utf-8').includes(TAG) }

    it('nothing set: off', () => {
      expect(topicsOn()).toBe(false)
    })
    it('.env alone: on with the values src/config.ts reads as on, off with anything else', () => {
      for (const v of ['1', '"true"', 'Yes', 'on']) {
        writeFileSync(join(install, '.env'), `OTHER=1\nTELEGRAM_TOPICS_ENABLED=${v}\n`)
        expect(topicsOn()).toBe(true)
      }
      for (const v of ['0', 'false', '', 'enabled']) {
        writeFileSync(join(install, '.env'), `TELEGRAM_TOPICS_ENABLED=${v}\n`)
        expect(topicsOn()).toBe(false)
      }
    })
    it('the dashboard override wins over .env, both ways', () => {
      writeFileSync(join(install, '.env'), 'TELEGRAM_TOPICS_ENABLED=1\n')
      writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify({ TELEGRAM_TOPICS_ENABLED: '0' }))
      expect(topicsOn()).toBe(false)
      writeFileSync(join(install, '.env'), '')
      writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify({ TELEGRAM_TOPICS_ENABLED: '1' }))
      expect(topicsOn()).toBe(true)
    })
    it('an unreadable override file falls back to .env', () => {
      writeFileSync(join(install, '.env'), 'TELEGRAM_TOPICS_ENABLED=1\n')
      writeFileSync(join(install, 'store', 'config-overrides.json'), '{not json')
      expect(topicsOn()).toBe(true)
    })
  })
})

// ---- the patched plugin code, run ----------------------------------------

type Call = [string, ...unknown[]]

interface Plugin {
  calls: Call[]
  notes: Array<{ method: string; params: { content: string; meta: Record<string, string> } }>
  inbound: (ctx: unknown, text: string) => Promise<void>
  reply: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  tools: () => Promise<{ tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }>
  instructions: string
}

// Executes the excerpt with stand-ins for everything it does not define itself.
// Only the Bot API calls and the MCP notifications are observed.
function load(source: string): Plugin {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const calls: Call[] = []
  const notes: Plugin['notes'] = []
  const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>()
  let nextId = 100
  const record = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return { message_id: nextId++ } }
  const bot = {
    command: () => {},
    start: async () => {},
    api: {
      sendChatAction: record('sendChatAction'),
      setMessageReaction: record('setMessageReaction'),
      sendMessage: record('sendMessage'),
      sendPhoto: record('sendPhoto'),
      sendDocument: record('sendDocument'),
      setMyCommands: record('setMyCommands'),
    },
  }
  let opts: { instructions: string } = { instructions: '' }
  class Server {
    constructor(_info: unknown, o: { instructions: string }) { opts = o }
    setRequestHandler(schema: unknown, fn: (req: unknown) => Promise<unknown>) { handlers.set(schema, fn) }
    notification(n: Plugin['notes'][number]) { notes.push(n); return Promise.resolve() }
  }
  const ListTools = Symbol('list')
  const CallTool = Symbol('call')
  class InputFile { constructor(public path: string) {} }
  const stubs: Record<string, unknown> = {
    bot, Server, ListToolsRequestSchema: ListTools, CallToolRequestSchema: CallTool, InputFile, extname,
    dmCommandGate: () => null,
    gate: () => ({ action: 'deliver', access: {} }),
    PERMISSION_REPLY_RE: /^\b$/,
    chunk: (t: string) => t.split('|'),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    statSync: () => ({ size: 1 }),
    MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,
    MAX_CHUNK_LIMIT: 4096,
    loadAccess: () => ({}),
    PHOTO_EXTS: new Set(['.png', '.jpg']),
    writeFileSync: () => {}, renameSync: () => {}, join, STATE_DIR: '/nonexistent',
  }
  const names = Object.keys(stubs)
  const factory = new Function(...names, `${js}\nreturn { handleInbound }`)
  const { handleInbound } = factory(...names.map(n => stubs[n])) as { handleInbound: (ctx: unknown, text: string, d: undefined) => Promise<void> }
  return {
    calls, notes,
    inbound: (ctx, text) => handleInbound(ctx, text, undefined),
    reply: (args) => handlers.get(CallTool)!({ params: { name: 'reply', arguments: args } }) as ReturnType<Plugin['reply']>,
    tools: () => handlers.get(ListTools)!({}) as ReturnType<Plugin['tools']>,
    instructions: opts.instructions,
  }
}

function ctx(message: Record<string, unknown>) {
  return { from: { id: 42, username: 'owner' }, chat: { id: 42 }, message: { message_id: 7, date: 1_700_000_000, ...message } }
}

const flush = () => new Promise(r => setTimeout(r, 0))

// sendPhoto/sendDocument get an InputFile; compare its path.
const withFilePath = ([method, chat, payload, opts]: Call) =>
  [method, chat, typeof payload === 'string' ? payload : (payload as { path: string }).path, opts]

async function inboundTrace(source: string, message: Record<string, unknown>) {
  const p = load(source)
  await p.inbound(ctx(message), 'szia')
  await flush()
  return { calls: p.calls, meta: p.notes.find(n => n.method === 'notifications/claude/channel')!.params.meta }
}

async function replyTrace(source: string, args: Record<string, unknown>) {
  const p = load(source)
  const result = await p.reply({ chat_id: '42', ...args })
  // The tool-call handler turns a throw into a tool error, so an on/off
  // comparison of two failed sends would pass; a trace is of a send that worked.
  expect(result.isError).toBeUndefined()
  return { calls: p.calls, result }
}

describe('the patched plugin, run', () => {
  let off = ''
  let on = ''
  beforeEach(() => {
    off = patched('off')
    on = patched('on')
  })

  // The switch-off guarantee, at the layer where the bytes are sent.
  describe('without a topic, on behaves exactly like off', () => {
    const inbound: Array<[string, Record<string, unknown>]> = [
      ['a plain private message', {}],
      ['a reply thread that is not a topic (message_thread_id without is_topic_message)', { message_thread_id: 5 }],
      ['is_topic_message without an id', { is_topic_message: true }],
    ]
    for (const [name, message] of inbound) {
      it(`inbound: ${name}`, async () => {
        expect(await inboundTrace(on, message)).toEqual(await inboundTrace(off, message))
      })
    }

    const replies: Array<[string, Record<string, unknown>]> = [
      ['one chunk', { text: 'hello' }],
      ['three chunks with reply_to', { text: 'a|b|c', reply_to: '7' }],
      ['files without reply_to', { text: 'x', files: ['/f/a.png', '/f/b.pdf'] }],
      ['files with reply_to', { text: 'x', reply_to: '7', files: ['/f/a.png', '/f/b.pdf'] }],
      ['markdownv2', { text: 'x', format: 'markdownv2' }],
      ['an empty message_thread_id counts as none', { text: 'x', message_thread_id: '' }],
    ]
    for (const [name, args] of replies) {
      it(`reply: ${name}`, async () => {
        const fromOn = await replyTrace(on, args)
        const { message_thread_id: _ignored, ...offArgs } = args
        expect(fromOn).toEqual(await replyTrace(off, offArgs))
      })
    }
  })

  it('inbound in a topic: the meta carries message_thread_id and the typing indicator goes into the topic', async () => {
    const { calls, meta } = await inboundTrace(on, { is_topic_message: true, message_thread_id: 12 })
    expect(meta.message_thread_id).toBe('12')
    expect(calls).toContainEqual(['sendChatAction', '42', 'typing', { message_thread_id: 12 }])
    const offTrace = await inboundTrace(off, { is_topic_message: true, message_thread_id: 12 })
    expect(offTrace.meta).not.toHaveProperty('message_thread_id')
  })

  it('reply into a topic: every text chunk and every file goes there, reply_to kept', async () => {
    const { calls } = await replyTrace(on, { text: 'a|b', reply_to: '7', message_thread_id: '12', files: ['/f/a.png', '/f/b.pdf'] })
    expect(calls.map(withFilePath)).toEqual([
      ['sendMessage', '42', 'a', { reply_parameters: { message_id: 7 }, message_thread_id: 12 }],
      ['sendMessage', '42', 'b', { message_thread_id: 12 }],
      ['sendPhoto', '42', '/f/a.png', { reply_parameters: { message_id: 7 }, message_thread_id: 12 }],
      ['sendDocument', '42', '/f/b.pdf', { reply_parameters: { message_id: 7 }, message_thread_id: 12 }],
    ])
  })

  it('reply into a topic without reply_to: the files still get the topic', async () => {
    const { calls } = await replyTrace(on, { text: 'x', message_thread_id: '12', files: ['/f/b.pdf'] })
    expect(calls.map(withFilePath)).toEqual([
      ['sendMessage', '42', 'x', { message_thread_id: 12 }],
      ['sendDocument', '42', '/f/b.pdf', { message_thread_id: 12 }],
    ])
  })

  it('reply into a topic with buttons: the keyboard rides on the last chunk, the topic on every chunk', async () => {
    const { calls } = await replyTrace(on, { text: 'a|b', message_thread_id: '12', buttons: ['Igen', 'Nem'] })
    expect(calls).toEqual([
      ['sendMessage', '42', 'a', { message_thread_id: 12 }],
      ['sendMessage', '42', 'b', { message_thread_id: 12, reply_markup: { keyboard: [[{ text: 'Igen' }], [{ text: 'Nem' }]], one_time_keyboard: true, resize_keyboard: true } }],
    ])
  })

  for (const bad of ['abc', '0', '-3', '1.5']) {
    it(`an invalid message_thread_id (${bad}) is refused before anything is sent`, async () => {
      const p = load(on)
      const res = await p.reply({ chat_id: '42', text: 'x', message_thread_id: bad })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/invalid message_thread_id/)
      expect(p.calls).toEqual([])
    })
  }

  it('the reply tool advertises message_thread_id, and the instructions say to pass it back, only when on', async () => {
    const schema = async (src: string) => (await load(src).tools()).tools.find(t => t.name === 'reply')!.inputSchema.properties
    expect(await schema(on)).toHaveProperty('message_thread_id')
    expect(await schema(off)).not.toHaveProperty('message_thread_id')
    expect(load(on).instructions).toMatch(/pass it back to reply as message_thread_id/)
    expect(load(off).instructions).not.toMatch(/message_thread_id/)
  })
})
