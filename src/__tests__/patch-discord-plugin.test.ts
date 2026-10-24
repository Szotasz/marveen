// scripts/patch-discord-plugin.py (DCBTN1023): answer buttons on the Discord
// channel plugin's reply tool. Run for real on a copy of the complete 0.0.4
// plugin (fixtures/discord-plugin-0.0.4/server.ts.txt) in a scratch plugins
// cache; the inserted functions are then run with fake discord.js builders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-discord-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'discord-plugin-0.0.4', 'server.ts.txt')
const TAG = 'MARVEEN-PATCH(dcbtn1023)'

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'dc-plugin-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'discord', '0.0.4')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = [], root = cache): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, root], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { root: string; files: Array<{ version: string; path: string; status: string }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-discord-plugin.py', () => {
  it('1st run patches: every added line tagged, buttons inside the reply schema, still parses', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*server\.ts \(buttons\)/)
    const text = readFileSync(server, 'utf-8')
    const fixture = readFileSync(FIXTURE, 'utf-8')
    expect(text.split('\n').length - fixture.split('\n').length).toBe(text.split('\n').filter(l => l.endsWith(TAG)).length)
    const reply = text.indexOf("name: 'reply'")
    const field = text.indexOf('buttons: {', reply)
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(text.indexOf("name: 'react'")).toBeGreaterThan(field)
    expect(text).toMatch(/const files = \(args\.files as string\[\] \| undefined\) \?\? \[\]\n +const rows = buildButtonRows\(args\.buttons\) \/\/ MARVEEN-PATCH/)
    expect(text).toMatch(/\.\.\.\(i === 0 && files\.length > 0 \? \{ files \} : \{\}\),\n +\.\.\.\(i === chunks\.length - 1 && rows\.length > 0 \? \{ components: rows \} : \{\}\), \/\/ MARVEEN-PATCH/)
    expect(text.indexOf('function clickAllowed(')).toBeLessThan(text.indexOf("client.on('messageCreate'"))
    expect(syntaxErrors(text)).toEqual([])
  })

  it('2nd run is a no-op: `already`, byte-identical, silent', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files).toEqual([{ version: '0.0.4', path: server, status: 'patched' }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.4', path: server, status: 'already' }])
  })

  it('a file patched by an older version of the script gets the current code ("upgraded"), once', () => {
    run()
    const current = readFileSync(server, 'utf-8')
    // the 2026-10-23 first version had no dmPolicy line in clickAllowed
    const older = current.split('\n').filter(l => !(l.includes("access.dmPolicy === 'disabled'") && l.endsWith(TAG))).join('\n')
    expect(older).not.toBe(current)
    writeFileSync(server, older)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/upgraded .*server\.ts \(buttons\)/)
    expect(readFileSync(server, 'utf-8')).toBe(current)
    expect(readState(state).files[0].status).toBe('upgraded')
    expect(run().stderr).toBe('')
  })

  it('taking it back = deleting the tagged lines: byte-identical to the plugin', () => {
    run()
    const back = readFileSync(server, 'utf-8').split('\n').filter(l => !l.endsWith(TAG)).join('\n')
    expect(back).toBe(readFileSync(FIXTURE, 'utf-8'))
  })

  it('all or nothing: one moved anchor (plugin update) leaves the file untouched, loudly, exit 0', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('...(i === 0 && files.length > 0 ? { files } : {}),', '...(i === 0 && files.length ? { files } : {}),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply send files option not found exactly once.*the buttons patch left out, the reply tool has no buttons/)
    expect(readFileSync(server, 'utf-8')).toBe(changed)
    expect(readState(state).files[0].status).toBe('anchor-missing:reply send files option')
  })

  it('a plugin whose reply tool already has buttons (upstream took it) is left alone', () => {
    const native = readFileSync(FIXTURE, 'utf-8').replace("        required: ['chat_id', 'text'],", "          buttons: {\n            type: 'array',\n          },\n        required: ['chat_id', 'text'],")
    writeFileSync(server, native)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/already has buttons -- left alone/)
    expect(readFileSync(server, 'utf-8')).toBe(native)
    expect(readState(state).files[0].status).toBe('native')
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dc-empty-'))
    try {
      const r = run([], empty)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })

  it('an unwritable file: named in the log, exit 0 (the channel still starts)', () => {
    if (process.getuid?.() === 0) return // root writes anyway
    const dir = join(cache, 'claude-plugins-official', 'discord', '0.0.4')
    chmodSync(dir, 0o555)
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write .*server\.ts: PermissionError -- left unpatched/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    } finally { chmodSync(dir, 0o755) }
  })

  // #2212 review: the anchors prove the code next to the insertion is there,
  // not the names the inserted code uses. A plugin without the ButtonStyle
  // import would be patched into one that throws ReferenceError on load.
  it('a name the inserted code uses is gone (plugin update): left out loudly, the file untouched', () => {
    const fixture = readFileSync(FIXTURE, 'utf-8')
    const cases: Array<[string, string]> = [
      [fixture.replace('  ButtonStyle,\n', ''), 'discord.js imports ButtonBuilder, ButtonStyle, ActionRowBuilder, Interaction'],
      [fixture.replace('  type Interaction,\n', ''), 'discord.js imports ButtonBuilder, ButtonStyle, ActionRowBuilder, Interaction'],
      [fixture.replace('function loadAccess(', 'function readAccess('), 'function loadAccess'],
      [fixture.replace('const dmChannelUsers = ', 'const dmUsers = '), 'const dmChannelUsers'],
      [fixture.replace('const MAX_CHUNK_LIMIT = ', 'const MAX_CHUNK = '), 'const MAX_CHUNK_LIMIT'],
    ]
    const state = join(cache, 'state.json')
    for (const [changed, name] of cases) {
      expect(changed).not.toBe(fixture)
      writeFileSync(server, changed)
      const r = run(['--state', state])
      expect(r.status).toBe(0)
      expect(r.stderr).toContain(`LOUD: ${name} not found exactly once`)
      expect(readFileSync(server, 'utf-8')).toBe(changed)
      expect(readState(state).files[0].status).toBe(`anchor-missing:${name}`)
    }
  })

  it('an unexpected error (unreadable plugin directory): logged, exit 0, nothing patched', () => {
    if (process.getuid?.() === 0) return // root reads anyway
    const base = join(cache, 'claude-plugins-official', 'discord')
    chmodSync(base, 0o000)
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/unexpected PermissionError, nothing patched/)
    } finally { chmodSync(base, 0o755) }
    expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
  })
})

// The inserted rows builder and click check, run with fake discord.js builders.
type Access = { dmPolicy?: string; allowFrom: string[]; groups: Record<string, { requireMention?: boolean; allowFrom?: string[] }> }
function inserted(): {
  buildButtonRows: (raw: unknown) => Array<{ buttons: Array<{ id: string; label: string; style: string }> }>
  clickAllowed: (interaction: unknown, access: Access) => boolean
} {
  run()
  const text = readFileSync(server, 'utf-8')
  const from = text.indexOf('const BUTTON_STYLES')
  const to = text.indexOf('const answeredChoices')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const js = ts.transpileModule(text.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  class ButtonBuilder {
    id = ''; label = ''; style = ''
    setCustomId(v: string) { this.id = v; return this }
    setLabel(v: string) { this.label = v; return this }
    setStyle(v: string) { this.style = v; return this }
  }
  class ActionRowBuilder {
    buttons: ButtonBuilder[] = []
    addComponents(b: ButtonBuilder[]) { this.buttons.push(...b); return this }
  }
  const ButtonStyle = { Primary: 'P', Secondary: 'S', Success: 'OK', Danger: 'D' }
  return new Function('ButtonBuilder', 'ActionRowBuilder', 'ButtonStyle', `${js}\nreturn { buildButtonRows, clickAllowed }`)(ButtonBuilder, ActionRowBuilder, ButtonStyle)
}

describe('the inserted code', () => {
  it('buttons: 5 per row, choice:<n> ids, default style secondary, nothing when absent', () => {
    const { buildButtonRows } = inserted()
    expect(buildButtonRows(undefined)).toEqual([])
    const rows = buildButtonRows([{ label: 'Igen', style: 'success' }, { label: 'Nem', style: 'danger' }, ...['A', 'B', 'C', 'D', 'E'].map(label => ({ label }))])
    expect(rows.map(r => r.buttons.length)).toEqual([5, 2])
    expect(rows[0].buttons.slice(0, 3)).toEqual([{ id: 'choice:0', label: 'Igen', style: 'OK' }, { id: 'choice:1', label: 'Nem', style: 'D' }, { id: 'choice:2', label: 'A', style: 'S' }])
  })

  it('a bad buttons value throws (a tool error before anything is sent)', () => {
    const { buildButtonRows } = inserted()
    const bad: unknown[] = ['Igen', [{}], [{ label: '  ' }], [{ label: 'x'.repeat(81) }], [{ label: 'A' }, { label: 'A' }], [{ label: 'A', style: 'link' }], Array.from({ length: 26 }, (_, i) => ({ label: `${i}` }))]
    for (const b of bad) expect(() => buildButtonRows(b)).toThrow()
    expect(buildButtonRows([{ label: 'x'.repeat(80) }])).toHaveLength(1)
  })

  it('a click passes the same check as a message', () => {
    const { clickAllowed } = inserted()
    const owner = '1', other = '2'
    const access: Access = {
      allowFrom: [owner],
      groups: { mention: {}, open: { requireMention: false, allowFrom: [] }, team: { requireMention: false, allowFrom: [other] } },
    }
    const click = (user: string, channel: string | null, thread = false) => ({
      user: { id: user },
      guildId: channel === null ? null : 'g',
      channel: channel === null ? {} : { isThread: () => thread, parentId: channel, id: thread ? 'thread-id' : channel },
    })
    // DM: allowFrom only
    expect(clickAllowed(click(owner, null), access)).toBe(true)
    expect(clickAllowed(click(other, null), access)).toBe(false)
    // a channel that is not opted in: nobody
    expect(clickAllowed(click(owner, 'elsewhere'), access)).toBe(false)
    // mention-only channel: a click carries no mention, so allowFrom only
    expect(clickAllowed(click(owner, 'mention'), access)).toBe(true)
    expect(clickAllowed(click(other, 'mention'), access)).toBe(false)
    // a channel that listens to every message: anyone there
    expect(clickAllowed(click(other, 'open'), access)).toBe(true)
    // the channel's own allowFrom wins
    expect(clickAllowed(click(other, 'team'), access)).toBe(true)
    expect(clickAllowed(click(owner, 'team'), access)).toBe(false)
    // a thread is judged by its parent channel
    expect(clickAllowed(click(other, 'open', true), access)).toBe(true)
    // inbound switched off (gate() drops every message): every click too
    const off: Access = { ...access, dmPolicy: 'disabled' }
    for (const [user, channel] of [[owner, null], [owner, 'mention'], [owner, 'open'], [other, 'open'], [other, 'team']] as Array<[string, string | null]>) {
      expect(clickAllowed(click(user, channel), off)).toBe(false)
    }
    for (const policy of ['pairing', 'allowlist']) {
      expect(clickAllowed(click(owner, null), { ...access, dmPolicy: policy })).toBe(true)
    }
  })
})

// The whole inserted click handler, run with a fake client and interaction:
// what reaches the session (mcp.notification) and what the clicker sees.
type Sent = { content: string; meta: Record<string, string> }
function clickHandler(access: Access) {
  run()
  const text = readFileSync(server, 'utf-8')
  const from = text.indexOf('const BUTTON_STYLES')
  const to = text.indexOf("client.on('messageCreate'")
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  const js = ts.transpileModule(text.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const handlers: Array<(i: unknown) => Promise<void>> = []
  const client = { user: { id: 'bot' }, on: (ev: string, fn: (i: unknown) => Promise<void>) => { if (ev === 'interactionCreate') handlers.push(fn) } }
  const sent: Sent[] = []
  const mcp = { notification: async (n: { params: Sent }) => { sent.push(n.params) } }
  const dmChannelUsers = new Map<string, string>()
  new Function('ButtonBuilder', 'ActionRowBuilder', 'ButtonStyle', 'client', 'loadAccess', 'MAX_CHUNK_LIMIT', 'dmChannelUsers', 'mcp', js)(
    class {}, class {}, { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, client, () => access, 2000, dmChannelUsers, mcp)
  expect(handlers).toHaveLength(1)
  let n = 0
  const click = (o: { user?: string; customId?: string; author?: string; guildId?: string | null; messageId?: string } = {}) => {
    const replies: string[] = []
    const updates: Array<{ content?: string; components: unknown[] }> = []
    const interaction = {
      isButton: () => true,
      customId: o.customId ?? 'choice:0',
      message: { id: o.messageId ?? `m${++n}`, author: { id: o.author ?? 'bot' }, content: 'Mehet?' },
      user: { id: o.user ?? '1', username: 'mdylan', displayName: 'Molnár Dávid' },
      member: null,
      guildId: o.guildId ?? null,
      channel: {},
      channelId: 'dm1',
      component: { label: 'Igen' },
      reply: async (r: { content: string }) => { replies.push(r.content) },
      update: async (u: { content?: string; components: unknown[] }) => { updates.push(u) },
    }
    return { run: () => handlers[0](interaction), replies, updates }
  }
  return { click, sent, dmChannelUsers }
}

describe('the inserted click handler', () => {
  const access: Access = { allowFrom: ['1'], groups: {} }

  it('an allowed click: buttons replaced by the answer, the label delivered with button="true"', async () => {
    const h = clickHandler(access)
    const c = h.click()
    await c.run()
    expect(c.updates).toEqual([{ content: 'Mehet?\n\n➡️ Igen (Molnár Dávid)', components: [] }])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].content).toBe('Igen')
    expect(h.sent[0].meta).toMatchObject({ chat_id: 'dm1', user: 'mdylan', user_id: '1', button: 'true' })
    expect(h.dmChannelUsers.get('dm1')).toBe('1')
  })

  it('a refused click: "Not authorized." to the clicker, nothing delivered, buttons stay', async () => {
    const h = clickHandler(access)
    const c = h.click({ user: '2' })
    await c.run()
    expect(c.replies).toEqual(['Not authorized.'])
    expect(c.updates).toEqual([])
    expect(h.sent).toEqual([])
    const off = clickHandler({ ...access, dmPolicy: 'disabled' })
    const d = off.click()
    await d.run()
    expect(d.replies).toEqual(['Not authorized.'])
    expect(off.sent).toEqual([])
  })

  it('a second click on the same message: "Already answered.", delivered once', async () => {
    const h = clickHandler(access)
    await h.click({ messageId: 'same' }).run()
    const second = h.click({ messageId: 'same' })
    await second.run()
    expect(second.replies).toEqual(['Already answered.'])
    expect(h.sent).toHaveLength(1)
  })

  it('not ours: the plugin\'s own perm: buttons and another bot\'s message are left alone', async () => {
    const h = clickHandler(access)
    for (const c of [h.click({ customId: 'perm:allow:abcde' }), h.click({ author: 'someone-else' })]) {
      await c.run()
      expect(c.replies).toEqual([])
      expect(c.updates).toEqual([])
    }
    expect(h.sent).toEqual([])
  })
})

describe('channels.sh wiring', () => {
  const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const CALL = 'scripts/patch-discord-plugin.py" --state "$INSTALL_DIR/store/discord-plugin-patch.json"'

  it('calls the patcher when Discord is the provider or co-listened, before the session is spawned', () => {
    const call = code.indexOf(CALL)
    const spawn = code.indexOf('$TMUX new-session -d -s "$SESSION"')
    expect(call).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(call)
    const cond = code.lastIndexOf('case " $CHANNEL_PROVIDER $CHANNEL_PLUGINS_EXTRA " in', call)
    expect(cond).toBeGreaterThan(0)
    expect(code.slice(cond, call).split('\n').length).toBeLessThanOrEqual(4)
    expect(code.split(CALL).length - 1).toBe(2)
    // a failed patch must never stop the channel: both calls end in || true
    for (const line of code.split('\n').filter(l => l.includes(CALL))) {
      expect(line.trimEnd()).toMatch(/\|\| true$/)
    }
  })

  it('the guard matches discord as provider and discord@... as an extra plugin, nothing else', () => {
    const m = code.match(/case " \$CHANNEL_PROVIDER \$CHANNEL_PLUGINS_EXTRA " in\n\s*(.+)\)\n/)
    expect(m).not.toBeNull()
    const test = (provider: string, extra: string) =>
      spawnSync('bash', ['-c', `case " $1 $2 " in ${m![1]}) echo yes ;; *) echo no ;; esac`, '_', provider, extra], { encoding: 'utf-8' }).stdout.trim()
    expect(test('discord', '')).toBe('yes')
    expect(test('telegram', 'discord@claude-plugins-official')).toBe('yes')
    expect(test('telegram', '')).toBe('no')
    expect(test('slack', 'slack-channel@x')).toBe('no')
    expect(test('telegram', 'mydiscord@x')).toBe('no')
  })

  it('an isolated/explicit config dir is handed to the patcher', () => {
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_cfg_dir" python3 "\$INSTALL_DIR\/scripts\/patch-discord-plugin\.py"/)
  })
})
