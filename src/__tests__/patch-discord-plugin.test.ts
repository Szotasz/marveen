// scripts/patch-discord-plugin.py (DCEXT1111): Marveen's version of the Discord
// channel plugin (vendor/discord-plugin/<ver>/overlay) put over the cached
// official one, only when that is the vendored upstream file. Run for real on a
// copy of the verbatim upstream 0.0.4 server.ts in a scratch plugins cache; the
// overlay's button code is then run with fake discord.js builders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-discord-plugin.py')
const VENDOR = join(ROOT, 'vendor', 'discord-plugin', '0.0.4')
const UPSTREAM = join(VENDOR, 'upstream', 'server.ts')
const OVERLAY = join(VENDOR, 'overlay')
const TAG = 'MARVEEN-PATCH(dcbtn1023)'
const UPSTREAM_SHA = '6edc17d9e9d04930967361ba51c8e03b8f8508647a1dfc11d79ee6a0eb1010b7'

let cache = ''
let dir = ''
let server = ''
let install = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'dc-plugin-cache-'))
  dir = join(cache, 'claude-plugins-official', 'discord', '0.0.4')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(UPSTREAM, server)
  install = mkdtempSync(join(tmpdir(), 'dc-install-'))
  mkdirSync(join(install, 'store'))
})
afterEach(() => {
  rmSync(cache, { recursive: true, force: true })
  rmSync(install, { recursive: true, force: true })
})

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

function run(extra: string[] = [], root = cache): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, '--install', install, ...extra, root], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

// The owner's overrides (the dashboard settings store) and the install's .env.
function setOverrides(o: Record<string, string>) { writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify(o)) }
function setEnvFile(lines: string) { writeFileSync(join(install, '.env'), lines) }

function readState(file: string): { root: string; mode: string; owner_set: boolean; backfill: boolean; files: Array<{ version: string; path: string; status: string }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

const overlayFiles = () => readdirSync(OVERLAY).sort()
const ext = () => JSON.parse(readFileSync(join(dir, 'marveen-ext.json'), 'utf-8'))

// What the live cache held before DCEXT1111: upstream + the DCBTN1023 anchor patch (the old script's output,
// sha256 9a3fe104..., byte-identical to the live cache measured 2026-11-11).
function dcbtnPatched(): string {
  return readFileSync(join(__dirname, 'fixtures', 'discord-plugin-0.0.4', 'server.dcbtn.ts.txt'), 'utf-8')
}

describe('the vendored plugin', () => {
  it('upstream/server.ts is the verbatim 0.0.4 file (pinned sha256)', () => {
    expect(sha(readFileSync(UPSTREAM))).toBe(UPSTREAM_SHA)
  })

  it('the overlay parses, and every line it adds or changes is marked', () => {
    const up = readFileSync(UPSTREAM, 'utf-8').split('\n')
    const ov = readFileSync(join(OVERLAY, 'server.ts'), 'utf-8')
    expect(syntaxErrors(ov)).toEqual([])
    const upSet = new Set(up)
    const unmarked = ov.split('\n').filter(l => !upSet.has(l) && !/MARVEEN-(PATCH|EXT)/.test(l))
    expect(unmarked).toEqual([])
  })
})

describe('patch-discord-plugin.py', () => {
  it('the upstream file gets the overlay: byte-identical files, settings file, manifest, state', () => {
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/overlaid .*server\.ts \(Marveen's Discord plugin 0\.0\.4, from upstream\)/)
    for (const n of overlayFiles()) expect(readFileSync(join(dir, n), 'utf-8')).toBe(readFileSync(join(OVERLAY, n), 'utf-8'))
    expect(ext()).toEqual({ backfill: true, ownerUserId: '', channelPolicy: {} })
    const manifest = JSON.parse(readFileSync(join(dir, '.marveen-overlay.json'), 'utf-8'))
    expect(manifest.upstream).toBe(UPSTREAM_SHA)
    expect(manifest.files['server.ts']).toBe(sha(readFileSync(server)))
    expect(readState(state)).toMatchObject({ mode: 'on', owner_set: false, backfill: true, files: [{ version: '0.0.4', path: server, status: 'overlaid' }] })
  })

  it('2nd run is a no-op: `already`, byte-identical, silent', () => {
    run()
    const once = readFileSync(server, 'utf-8')
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files[0].status).toBe('already')
  })

  it('the live DCBTN1023-patched file is taken over like the upstream one', () => {
    writeFileSync(server, dcbtnPatched())
    expect(dcbtnPatched()).toContain(TAG)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/overlaid .*from dcbtn/)
    expect(readState(state).files[0].status).toBe('overlaid')
    expect(existsSync(join(dir, '.marveen-overlay.json'))).toBe(true)
    // an older DCBTN version (lines missing) is recognised too: the tagged lines are stripped before the match
    writeFileSync(server, dcbtnPatched().split('\n').filter(l => !(l.includes("access.dmPolicy === 'disabled'") && l.endsWith(TAG))).join('\n'))
    rmSync(join(dir, '.marveen-overlay.json'))
    expect(run().stderr).toMatch(/overlaid .*from dcbtn/)
  })

  it('our own earlier output gets the current overlay ("upgraded"), once', () => {
    run()
    const older = readFileSync(server, 'utf-8').replace('Not authorized.', 'Nope.')
    writeFileSync(server, older)
    const m = JSON.parse(readFileSync(join(dir, '.marveen-overlay.json'), 'utf-8'))
    m.files['server.ts'] = sha(older)
    writeFileSync(join(dir, '.marveen-overlay.json'), JSON.stringify(m))
    const r = run()
    expect(r.stderr).toMatch(/upgraded .*from ours/)
    expect(readFileSync(server, 'utf-8')).toBe(readFileSync(join(OVERLAY, 'server.ts'), 'utf-8'))
    expect(run().stderr).toBe('')
  })

  it('a settings change rewrites marveen-ext.json ("upgraded")', () => {
    run()
    setOverrides({ DISCORD_OWNER_USER_ID: '290903699524550656', DISCORD_BACKFILL: '0' })
    const state = join(cache, 'state.json')
    expect(run(['--state', state]).stderr).toMatch(/upgraded/)
    expect(ext()).toEqual({ backfill: false, ownerUserId: '290903699524550656', channelPolicy: {} })
    expect(readState(state)).toMatchObject({ owner_set: true, backfill: false })
  })

  it('the owner and the switch are overrides-only: a .env line never names an owner or turns the overlay off', () => {
    setEnvFile('DISCORD_OWNER_USER_ID=111111111111111111\nDISCORD_PLUGIN_EXT=0\nDISCORD_BACKFILL=0\n')
    const r = run()
    expect(r.stderr).toMatch(/overlaid/)
    expect(ext().ownerUserId).toBe('')
    // DISCORD_BACKFILL is a plain flag: its .env line counts, and an override beats it
    expect(ext().backfill).toBe(false)
    setOverrides({ DISCORD_BACKFILL: '1' })
    run()
    expect(ext().backfill).toBe(true)
  })

  it('DISCORD_CHANNEL_POLICY (overrides-only) goes to marveen-ext.json; bad JSON is dropped loudly; .env never counts', () => {
    const policy = { '1438000000000000700': { allowRoles: ['1438000000000009001'] } }
    setOverrides({ DISCORD_CHANNEL_POLICY: JSON.stringify(policy) })
    run()
    expect(ext().channelPolicy).toEqual(policy)
    for (const bad of ['{ bad', '[1]', '"x"']) {
      setOverrides({ DISCORD_CHANNEL_POLICY: bad })
      const r = run()
      expect(r.stderr).toContain('DISCORD_CHANNEL_POLICY is set but is not a JSON object -- NOT used')
      expect(ext().channelPolicy).toEqual({})
    }
    setOverrides({})
    setEnvFile(`DISCORD_CHANNEL_POLICY=${JSON.stringify(policy)}\n`)
    run()
    expect(ext().channelPolicy).toEqual({})
  })

  it('an owner id that is not a Discord user id is not used, loudly', () => {
    for (const bad of ['0', '-290903699524550656', 'zoli', '1234', '2909036995245505561234']) {
      setOverrides({ DISCORD_OWNER_USER_ID: bad })
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('DISCORD_OWNER_USER_ID is set but is not a Discord user id -- NOT used')
      expect(ext().ownerUserId).toBe('')
    }
  })

  it('DISCORD_PLUGIN_EXT=off: the verbatim upstream file back, everything we wrote removed', () => {
    run()
    setOverrides({ DISCORD_PLUGIN_EXT: '0' })
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/restored .*server\.ts to the official plugin 0\.0\.4/)
    expect(sha(readFileSync(server))).toBe(UPSTREAM_SHA)
    expect(readdirSync(dir)).toEqual(['server.ts'])
    expect(readState(state)).toMatchObject({ mode: 'off', files: [{ status: 'restored' }] })
    // off again: nothing to do, silent
    const again = run(['--state', state])
    expect(again.stderr).toBe('')
    expect(readState(state).files[0].status).toBe('upstream')
    // on again: back to ours
    setOverrides({ DISCORD_PLUGIN_EXT: '1' })
    expect(run().stderr).toMatch(/overlaid .*from upstream/)
  })

  it('DISCORD_PLUGIN_EXT=off on the live DCBTN-patched file: the upstream file, without the buttons', () => {
    writeFileSync(server, dcbtnPatched())
    setOverrides({ DISCORD_PLUGIN_EXT: '0' })
    expect(run().stderr).toMatch(/restored/)
    expect(sha(readFileSync(server))).toBe(UPSTREAM_SHA)
  })

  it('a file this install does not know (plugin update) is left as shipped, loudly, in both modes', () => {
    const changed = readFileSync(UPSTREAM, 'utf-8').replace('const MAX_CHUNK_LIMIT = 2000', 'const MAX_CHUNK_LIMIT = 1900')
    for (const mode of ['1', '0']) {
      writeFileSync(server, changed)
      setOverrides({ DISCORD_PLUGIN_EXT: mode })
      const state = join(cache, 'state.json')
      const r = run(['--state', state])
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/LOUD: .*server\.ts is not a plugin version this install knows/)
      expect(readFileSync(server, 'utf-8')).toBe(changed)
      expect(readdirSync(dir)).toEqual(['server.ts'])
      expect(readState(state).files[0].status).toBe('unknown')
    }
  })

  it('a manifest does not make a file ours unless its hash matches', () => {
    run()
    const tampered = readFileSync(server, 'utf-8') + '\n// edited by hand\n'
    writeFileSync(server, tampered)
    const r = run()
    expect(r.stderr).toMatch(/LOUD: .*not a plugin version this install knows/)
    expect(readFileSync(server, 'utf-8')).toBe(tampered)
  })

  it('the switch reads as the settings store reads a flag (true/1/yes/on), absent = on', () => {
    for (const [v, on] of [['true', true], ['on', true], ['1', true], ['false', false], ['0', false], ['', false]] as Array<[string, boolean]>) {
      copyFileSync(UPSTREAM, server)
      for (const f of readdirSync(dir)) if (f !== 'server.ts') rmSync(join(dir, f))
      setOverrides({ DISCORD_PLUGIN_EXT: v })
      run()
      expect(existsSync(join(dir, '.marveen-overlay.json')), v).toBe(on)
    }
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dc-empty-'))
    try {
      const r = run([], empty)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })

  it('an unwritable plugin folder: named in the log, exit 0, the file untouched', () => {
    if (process.getuid?.() === 0) return // root writes anyway
    chmodSync(dir, 0o555)
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write in .*0\.0\.4: PermissionError -- left as it was/)
      expect(sha(readFileSync(server))).toBe(UPSTREAM_SHA)
    } finally { chmodSync(dir, 0o755) }
  })

  it('an unexpected error (unreadable plugin directory): logged, exit 0, nothing changed', () => {
    if (process.getuid?.() === 0) return // root reads anyway
    const base = join(cache, 'claude-plugins-official', 'discord')
    chmodSync(base, 0o000)
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/unexpected PermissionError, nothing changed/)
    } finally { chmodSync(base, 0o755) }
    expect(sha(readFileSync(server))).toBe(UPSTREAM_SHA)
  })
})


// The inserted rows builder and click check, run with fake discord.js builders.
type Access = { dmPolicy?: string; allowFrom: string[]; groups: Record<string, { requireMention?: boolean; allowFrom?: string[] }> }
function inserted(channelPolicy: Record<string, { allowRoles: string[] }> = {}): {
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
  return new Function('ButtonBuilder', 'ActionRowBuilder', 'ButtonStyle', 'EXT', 'memberRoleIds', `${js}\nreturn { buildButtonRows, clickAllowed }`)(
    ButtonBuilder, ActionRowBuilder, ButtonStyle, { channelPolicy }, (m: { roles?: string[] } | null) => m?.roles ?? [])
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

  it('B1: with roles for the channel, a role holder may click; without the role, not even in an open channel', () => {
    const CH = 'team'
    const { clickAllowed } = inserted({ [CH]: { allowRoles: ['R1'] } })
    const access: Access = { allowFrom: ['1'], groups: { [CH]: { requireMention: false, allowFrom: [] } } }
    const click = (user: string, roles: string[] | null) => ({ user: { id: user }, guildId: 'g', member: roles === null ? null : { roles }, channel: { isThread: () => false, id: CH } })
    expect(clickAllowed(click('2', ['R1']), access)).toBe(true)
    expect(clickAllowed(click('2', ['R2']), access)).toBe(false) // roles configured: an open channel is no longer open to all
    expect(clickAllowed(click('2', null), access)).toBe(false)
    expect(inserted().clickAllowed(click('2', null), access)).toBe(true) // control: no policy, the old rule
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
  new Function('ButtonBuilder', 'ActionRowBuilder', 'ButtonStyle', 'client', 'loadAccess', 'MAX_CHUNK_LIMIT', 'dmChannelUsers', 'mcp', 'EXT', 'memberRoleIds', js)(
    class {}, class {}, { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, client, () => access, 2000, dmChannelUsers, mcp, { channelPolicy: {} }, () => [])
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
    // MAINCFGDIRUNSET1107: the _cfg_* names are unset before the patchers run, so they read a stable copy that is
    // set where the config dir is decided (the old pin held the empty $_cfg_dir in place).
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_MAIN_CFG_DIR" python3 "\$INSTALL_DIR\/scripts\/patch-discord-plugin\.py"/)
    const setAt = code.indexOf('_MAIN_CFG_DIR="$_cfg_dir"')
    expect(setAt).toBeGreaterThan(-1)
    expect(setAt).toBeLessThan(code.indexOf('unset _cfg_raw _cfg_line _cfg_mode _cfg_dir'))
  })
})
