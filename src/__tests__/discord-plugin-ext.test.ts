// DCEXT1111: Marveen's additions to the Discord plugin (vendor/discord-plugin/<ver>/overlay). The logic in
// marveen-ext.ts runs here directly; the wiring in the overlay's server.ts is checked on its text, against the
// verbatim upstream file next to it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const VENDOR = join(__dirname, '..', '..', 'vendor', 'discord-plugin', '0.0.4')
const SERVER = readFileSync(join(VENDOR, 'overlay', 'server.ts'), 'utf-8')
const UPSTREAM = readFileSync(join(VENDOR, 'upstream', 'server.ts'), 'utf-8')

type ExtConfig = { ownerUserId: string; backfill: boolean }
type Owner = { id: string; source: string } | { id: null; reason: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ext: any
beforeAll(async () => { ext = await import(pathToFileURL(join(VENDOR, 'overlay', 'marveen-ext.ts')).href) })

const OWNER = '290903699524550656'
const OTHER = '111111111111111111'
const THIRD = '222222222222222222'

describe('loadExtConfig', () => {
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dc-ext-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads what patch-discord-plugin.py writes; missing, broken or odd values fall to the safe side', () => {
    const at = (body: string | null): ExtConfig => {
      rmSync(join(dir, 'marveen-ext.json'), { force: true })
      if (body !== null) writeFileSync(join(dir, 'marveen-ext.json'), body)
      return ext.loadExtConfig(dir)
    }
    expect(at(JSON.stringify({ ownerUserId: OWNER, backfill: true }))).toEqual({ ownerUserId: OWNER, backfill: true })
    expect(at(null)).toEqual({ ownerUserId: '', backfill: false })
    expect(at('{ bad')).toEqual({ ownerUserId: '', backfill: false })
    expect(at(JSON.stringify({ ownerUserId: 'zoli', backfill: 'yes' }))).toEqual({ ownerUserId: '', backfill: false })
    expect(at(JSON.stringify({ ownerUserId: 290903699524550656, backfill: 1 }))).toEqual({ ownerUserId: '', backfill: false })
  })
})

describe('F1: who decides a tool permission from Discord', () => {
  const cfg = (ownerUserId = ''): ExtConfig => ({ ownerUserId, backfill: false })

  it('the setting, when that user is paired', () => {
    expect(ext.resolveOwner(cfg(OWNER), [OTHER, OWNER, THIRD])).toEqual({ id: OWNER, source: 'setting' })
  })

  it('a named owner who is not paired is nobody (pairing proves the account)', () => {
    const o: Owner = ext.resolveOwner(cfg(OWNER), [OTHER])
    expect(o.id).toBeNull()
    expect('reason' in o && o.reason).toContain('not a paired DM')
  })

  it('no setting: the only paired DM; several: nobody, never the first', () => {
    expect(ext.resolveOwner(cfg(), [OTHER])).toEqual({ id: OTHER, source: 'sole-dm' })
    for (const list of [[OWNER, OTHER], [OTHER, OWNER], [OWNER, OTHER, THIRD]]) {
      const o: Owner = ext.resolveOwner(cfg(), list)
      expect(o.id).toBeNull()
      expect('reason' in o && o.reason).toContain(`${list.length} paired DMs and DISCORD_OWNER_USER_ID is not set`)
    }
    expect(ext.resolveOwner(cfg(), []).id).toBeNull()
  })

  it('only the owner, only in a DM', () => {
    const owner = ext.resolveOwner(cfg(OWNER), [OWNER, OTHER])
    expect(ext.mayDecidePermission(owner, OWNER, true)).toBe(true)
    expect(ext.mayDecidePermission(owner, OWNER, false)).toBe(false) // a guild channel
    expect(ext.mayDecidePermission(owner, OTHER, true)).toBe(false) // another paired DM
    const nobody = ext.resolveOwner(cfg(), [OWNER, OTHER])
    expect(ext.mayDecidePermission(nobody, OWNER, true)).toBe(false)
    expect(ext.mayDecidePermission(nobody, OTHER, true)).toBe(false)
  })
})

describe('F2: paired DM channels resolve after a restart', () => {
  function resolver(dms: Record<string, string>, failing: string[] = []) {
    const known = new Map<string, string>()
    const calls: string[] = []
    const warnings: string[] = []
    const r = new ext.DmResolver(async (userId: string) => {
      calls.push(userId)
      if (failing.includes(userId)) throw new Error('Unknown User')
      return dms[userId]
    }, known, (m: string) => warnings.push(m))
    return { r, known, calls, warnings }
  }

  it('warm() maps every paired DM channel to its user', async () => {
    const t = resolver({ [OWNER]: 'dm-owner', [OTHER]: 'dm-other' })
    await t.r.warm([OWNER, OTHER])
    expect([...t.known.entries()]).toEqual([['dm-owner', OWNER], ['dm-other', OTHER]])
  })

  it('an unknown DM channel of a paired user resolves lazily; a stranger\'s does not', async () => {
    const t = resolver({ [OWNER]: 'dm-owner', [OTHER]: 'dm-other' })
    expect(await t.r.resolve('dm-other', [OWNER, OTHER])).toBe(OTHER)
    expect(await t.r.resolve('dm-stranger', [OWNER, OTHER])).toBeUndefined()
  })

  it('REST load stays bounded: each unknown channel is looked up once, known users are skipped', async () => {
    const t = resolver({ [OWNER]: 'dm-owner', [OTHER]: 'dm-other' })
    await t.r.warm([OWNER, OTHER])
    expect(t.calls).toEqual([OWNER, OTHER])
    for (let i = 0; i < 5; i++) expect(await t.r.resolve('dm-stranger', [OWNER, OTHER])).toBeUndefined()
    expect(t.calls).toEqual([OWNER, OTHER]) // both users already mapped: no further call, ever
    expect(await t.r.resolve('dm-owner', [OWNER, OTHER])).toBe(OWNER)
    expect(t.calls).toHaveLength(2)
  })

  it('a user that cannot be opened (left Discord) is a warning, not a crash', async () => {
    const t = resolver({ [OTHER]: 'dm-other' }, [OWNER])
    await t.r.warm([OWNER, OTHER])
    expect(t.known.get('dm-other')).toBe(OTHER)
    expect(t.warnings.join('\n')).toContain(`cannot open the DM of paired user ${OWNER}`)
  })
})

describe('the wiring in the overlay server.ts', () => {
  it('the permission prompt goes to the owner only, not to every paired DM', () => {
    expect(UPSTREAM).toContain('for (const userId of access.allowFrom) {')
    expect(SERVER).not.toContain('for (const userId of access.allowFrom) {')
    const handler = SERVER.slice(SERVER.indexOf("notifications/claude/channel/permission_request'"), SERVER.indexOf('mcp.setRequestHandler(ListToolsRequestSchema'))
    expect(handler).toContain('const owner = currentOwner()')
    expect(handler).toMatch(/if \(owner\.id === null\) \{[^]*?it stays in the terminal[^]*?return \/\/ MARVEEN-EXT\n\s*\} \/\/ MARVEEN-EXT\n\s*const userId = owner\.id/)
    expect(handler).toContain('await client.users.fetch(userId)')
    expect(handler.match(/user\.send\(/g)).toHaveLength(1)
  })

  it('a permission button and a typed "yes abcde" decide only for the owner in a DM', () => {
    expect(SERVER).not.toContain('if (!access.allowFrom.includes(interaction.user.id)) {')
    expect(SERVER).toContain("if (!mayDecidePermission(currentOwner(), interaction.user.id, interaction.guildId === null)) {")
    expect(SERVER).toContain("if (permMatch && !recovered && mayDecidePermission(currentOwner(), msg.author.id, msg.channel.type === ChannelType.DM)) {")
    expect(SERVER).not.toMatch(/^\s*if \(permMatch\) \{/m)
  })

  it('a decided request cannot be decided again, and a typed decision takes the buttons away', () => {
    expect(SERVER).toMatch(/if \(behavior !== 'more' && decidedPermissions\.has\(request_id!\)\) \{[^]*?Already answered\./)
    expect(SERVER).toMatch(/if \(!decidedPermissions\.has\(request_id\)\) \{[^]*?decidedPermissions\.add\(request_id\)[^]*?prompt\.edit\(\{[^\n]*components: \[\] \}\)/)
  })

  it('the outbound gate asks the resolver for a DM it has not seen; the paired DMs are warmed at ready', () => {
    expect(SERVER).toContain('const userId = ch.recipientId ?? dmChannelUsers.get(id) ?? (await dmResolver.resolve(id, access.allowFrom))')
    const ready = SERVER.slice(SERVER.indexOf("client.once('ready'"), SERVER.indexOf('client.login(TOKEN)'))
    // warm first (F2), then the recovery (F4), which needs the DM channels warm() found
    expect(ready).toMatch(/await dmResolver\.warm\(loadAccess\(\)\.allowFrom\) \/\/ MARVEEN-EXT\n\s*await recoverMissed\(readyAt\)/)
    expect(ready).toContain('.finally(() => { recoveryOpen = false; liveDelivered.clear() })')
  })
})

describe('F3: a recorded voice message is marked', () => {
  it('voice="true" only for the IsVoiceMessage flag (8192), whatever else is set', () => {
    expect(ext.voiceMeta(8192)).toEqual({ voice: 'true' })
    expect(ext.voiceMeta(8192 | 4 | 64)).toEqual({ voice: 'true' })
    for (const f of [0, 4, 64, 4096, 16384]) expect(ext.voiceMeta(f)).toEqual({})
  })

  it('the inbound meta carries it, and the instructions say what to do with it', () => {
    expect(SERVER).toMatch(/attachments: atts\.join\('; '\) \} : \{\}\),\n\s*\.\.\.voiceMeta\(msg\.flags\.bitfield\), \/\/ MARVEEN-EXT/)
    expect(SERVER).toContain('A message with voice="true" is a recorded voice message')
  })
})

describe('F5: paging and threads', () => {
  it('fetch_messages takes before OR after, as a message id', () => {
    expect(ext.pagingOptions({})).toEqual({})
    expect(ext.pagingOptions({ before: '1438123456789012345' })).toEqual({ before: '1438123456789012345' })
    expect(ext.pagingOptions({ after: '1438123456789012345', before: '' })).toEqual({ after: '1438123456789012345' })
    for (const bad of [{ before: 'abc' }, { after: 12 }, { before: '1'.repeat(25) }]) expect(() => ext.pagingOptions(bad)).toThrow(/must be a message id/)
    expect(() => ext.pagingOptions({ before: '1438123456789012345', after: '1438123456789012346' })).toThrow(/not both/)
  })

  it('a thread name: one line, 1-100 characters', () => {
    expect(ext.threadName('  Napi  jelentés\n11-11 ')).toBe('Napi jelentés 11-11')
    expect(ext.threadName('é'.repeat(150))).toHaveLength(100)
    for (const bad of ['', '   ', undefined, 7]) expect(() => ext.threadName(bad)).toThrow(/name is required/)
  })

  it('the tools are wired: paging into fetch, create_thread behind the outbound gate, never in a DM', () => {
    expect(SERVER).toContain('const msgs = await ch.messages.fetch({ limit, ...pagingOptions(args) })')
    expect(SERVER).toMatch(/name: 'create_thread',/)
    const handler = SERVER.slice(SERVER.indexOf("case 'create_thread': {"), SERVER.indexOf("case 'react': {"))
    expect(handler).toContain('const name = threadName(args.name)')
    expect(handler).toContain('await fetchAllowedChannel(args.chat_id as string)')
    expect(handler.indexOf('fetchAllowedChannel')).toBeLessThan(handler.indexOf('threads.create'))
    expect(handler).toContain("if (ch.type === ChannelType.DM) throw new Error('threads do not exist in DMs')")
  })
})

describe('F4: recovery logic', () => {
  const NOW = 1_800_000_000_000
  const id = (n: number) => String(1438000000000000000n + BigInt(n))

  it('first start and a damaged file recover nothing; then at most every 10 minutes', () => {
    expect(ext.backfillDue({ state: null, bad: false }, NOW)).toMatchObject({ due: false, reason: expect.stringContaining('first start') })
    expect(ext.backfillDue({ state: null, bad: true }, NOW)).toMatchObject({ due: false, reason: expect.stringContaining('unreadable') })
    const at = (ago: number) => ext.backfillDue({ state: { lastBackfillAt: NOW - ago, channels: {} }, bad: false }, NOW)
    expect(at(9 * 60_000).due).toBe(false)
    expect(at(9 * 60_000).reason).toContain('9 min ago (at most every 10 min)')
    expect(at(10 * 60_000).due).toBe(true)
  })

  it('the cursor file: read back strictly, anything odd is "bad", a missing file is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-cursor-'))
    try {
      const p = join(dir, 'c.json')
      expect(ext.readCursor(p)).toEqual({ state: null, bad: false })
      writeFileSync(p, JSON.stringify({ lastBackfillAt: 5, channels: { [id(1)]: id(2) } }))
      expect(ext.readCursor(p)).toEqual({ state: { lastBackfillAt: 5, channels: { [id(1)]: id(2) } }, bad: false })
      for (const body of ['{ bad', '[]', JSON.stringify({ channels: {} }), JSON.stringify({ lastBackfillAt: 1, channels: { x: id(1) } }), JSON.stringify({ lastBackfillAt: 1, channels: { [id(1)]: 7 } })]) {
        writeFileSync(p, body)
        expect(ext.readCursor(p), body).toEqual({ state: null, bad: true })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the cursor only moves forward, saves debounced, and flushes on markRun', async () => {
    const saved: string[] = []
    const c = new ext.BackfillCursor({ lastBackfillAt: 0, channels: {} }, (s: unknown) => saved.push(JSON.stringify(s)), 20)
    c.note(id(1), id(10))
    c.note(id(1), id(9)) // older: ignored
    c.note(id(1), id(11))
    c.note('not-a-channel', id(12)) // ignored
    expect(saved).toEqual([])
    await new Promise(r => setTimeout(r, 40))
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]!)).toEqual({ lastBackfillAt: 0, channels: { [id(1)]: id(11) } })
    c.markRun(NOW)
    expect(JSON.parse(saved[1]!).lastBackfillAt).toBe(NOW)
  })

  it('selectRecovered: after the cursor, before the start, 24 h, no bots, the paired user only in a DM, no live duplicates, newest 50', () => {
    const c = (n: number, o: Partial<{ ageMs: number; author: string; bot: boolean }> = {}) =>
      ({ id: id(n), createdTimestamp: NOW - (o.ageMs ?? 60_000), authorId: o.author ?? OWNER, authorBot: o.bot ?? false })
    const base = { cursorId: id(10), cutoffMs: NOW - 1000, nowMs: NOW, selfId: 'bot' }
    const pick = (cs: unknown[], o = {}) => ext.selectRecovered(cs, { ...base, ...o }).take.map((x: { id: string }) => x.id)
    expect(pick([c(12), c(11), c(10), c(9)])).toEqual([id(11), id(12)])
    expect(pick([c(11, { ageMs: 0 })])).toEqual([]) // after the start: it comes live
    expect(pick([c(11, { ageMs: 25 * 3600_000 })])).toEqual([])
    expect(pick([c(11, { bot: true }), c(12, { author: 'bot' })])).toEqual([])
    expect(pick([c(11, { author: OTHER }), c(12)], { onlyAuthor: OWNER })).toEqual([id(12)])
    expect(pick([c(11), c(12)], { exclude: new Set([id(11)]) })).toEqual([id(12)])
    const many = Array.from({ length: 70 }, (_, i) => c(11 + i))
    const r = ext.selectRecovered(many, base)
    expect(r.skipped).toBe(20)
    expect(r.take).toHaveLength(50)
    expect(r.take[0].id).toBe(id(31))
  })
})

// The overlay's own handleInbound and recoverMissed, run with fakes for discord.js and the MCP server.
function slice(from: string, to: string): string {
  const a = SERVER.indexOf(from)
  const b = SERVER.indexOf(to, a)
  expect(a).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript')
  return ts.transpileModule(SERVER.slice(a, b), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
const PERMISSION_REPLY_RE = new RegExp(SERVER.match(/const PERMISSION_REPLY_RE = \/(.*)\/i\n/)![1]!, 'i')

function inboundHarness(gateResult: Record<string, unknown>, ownerId: string | null = OWNER) {
  const notes: Array<{ method: string; params: { content?: string; meta?: Record<string, string>; behavior?: string } }> = []
  const replies: string[] = []
  const typing: string[] = []
  const cursorNotes: string[] = []
  const decided = new Set<string>()
  const handleInbound = new Function(
    'gate', 'ChannelType', 'dmChannelUsers', 'liveDelivered', 'recoveryOpen', 'backfillCursor', 'PERMISSION_REPLY_RE',
    'mayDecidePermission', 'currentOwner', 'decidedPermissions', 'mcp', 'pendingPermissions', 'permissionMessages',
    'safeAttName', 'voiceMeta',
    `${slice('async function handleInbound(', '// DCEXT1111 F4: deliver, once')}\nreturn handleInbound`,
  )(
    async () => gateResult, { DM: 1, GuildText: 0 }, new Map(), new Set(), true,
    { note: (c: string, m: string) => cursorNotes.push(`${c}:${m}`) }, PERMISSION_REPLY_RE,
    ext.mayDecidePermission, () => (ownerId ? { id: ownerId, source: 'setting' } : { id: null, reason: 'x' }), decided,
    { notification: async (n: (typeof notes)[0]) => { notes.push(n) } }, new Map(), new Map(),
    () => 'f', ext.voiceMeta,
  ) as (msg: unknown, recovered?: boolean) => Promise<void>
  const msg = (content: string, o: { dm?: boolean; author?: string } = {}) => ({
    id: id(77), channelId: '1438000000000000500', content,
    author: { id: o.author ?? OWNER, username: 'zoli' },
    channel: { type: o.dm === false ? 0 : 1, isThread: () => false, sendTyping: async () => { typing.push('t') } },
    createdAt: new Date(0), attachments: new Map(), flags: { bitfield: 0 },
    reply: async (t: string) => { replies.push(t) }, react: async () => {},
  })
  return { handleInbound, msg, notes, replies, typing, cursorNotes }
}
const id = (n: number) => String(1438000000000000000n + BigInt(n))

describe('F4: a recovered message (the overlay\'s handleInbound, run)', () => {
  it('never answers with a pairing code', async () => {
    const live = inboundHarness({ action: 'pair', code: 'abc123', isResend: false })
    await live.handleInbound(live.msg('hello'))
    expect(live.replies).toHaveLength(1) // control: a live one does
    const h = inboundHarness({ action: 'pair', code: 'abc123', isResend: false })
    await h.handleInbound(h.msg('hello'), true)
    expect(h.replies).toEqual([])
    expect(h.notes).toEqual([])
  })

  it('never decides a permission, even the owner\'s "yes abcde" in a DM: it is delivered as text, marked', async () => {
    const live = inboundHarness({ action: 'deliver', access: {} })
    await live.handleInbound(live.msg('yes abcde'))
    expect(live.notes.map(n => n.method)).toEqual(['notifications/claude/channel/permission']) // control
    const h = inboundHarness({ action: 'deliver', access: {} })
    await h.handleInbound(h.msg('yes abcde'), true)
    expect(h.notes.map(n => n.method)).toEqual(['notifications/claude/channel'])
    expect(h.notes[0]!.params.meta).toMatchObject({ recovered: 'true' })
    expect(h.typing).toEqual([])
  })

  it('a live message: no recovered mark, typing shown, the cursor noted', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    await h.handleInbound(h.msg('szia'))
    expect(h.notes[0]!.params.meta!.recovered).toBeUndefined()
    expect(h.typing).toEqual(['t'])
    expect(h.cursorNotes).toEqual([`1438000000000000500:${id(77)}`])
  })

  it('F1 on the live path: a non-owner\'s or a guild channel\'s "yes abcde" is only text', async () => {
    for (const o of [{ author: OTHER }, { dm: false }]) {
      const h = inboundHarness({ action: 'deliver', access: {} })
      await h.handleInbound(h.msg('yes abcde', o))
      expect(h.notes.map(n => n.method), JSON.stringify(o)).toEqual(['notifications/claude/channel'])
    }
  })
})

describe('F4: recoverMissed (the overlay\'s, run): REST only when due, through handleInbound', () => {
  function recoverHarness(read: { state: { lastBackfillAt: number; channels: Record<string, string> } | null; bad: boolean }, gatePasses = true) {
    const fetches: Array<{ channel: string; opts: unknown }> = []
    const delivered: Array<{ id: string; recovered: boolean }> = []
    const marks: number[] = []
    const DM = '1438000000000000500'
    const GROUP = '1438000000000000600'
    const state = read.state ?? { lastBackfillAt: 0, channels: {} }
    const messages = new Map([[id(21), { id: id(21), createdTimestamp: Date.now() - 60_000, author: { id: OWNER, bot: false } }]])
    const recoverMissed = new Function(
      'backfillCursor', 'cursorRead', 'backfillDue', 'loadAccess', 'dmChannelUsers', 'BACKFILL', 'fetchTextChannel',
      'selectRecovered', 'client', 'liveDelivered', 'handleInbound',
      `${slice('async function recoverMissed(', "client.once('ready'")}\nreturn recoverMissed`,
    )(
      { state, markRun: (n: number) => marks.push(n) }, read, ext.backfillDue,
      () => ({ allowFrom: [OWNER], groups: { [GROUP]: {} } }), new Map([[DM, OWNER]]), ext.BACKFILL,
      async (channel: string) => ({ messages: { fetch: async (opts: unknown) => { fetches.push({ channel, opts }); return messages } } }),
      ext.selectRecovered, { user: { id: 'bot' } }, new Set(),
      async (m: { id: string }, recovered: boolean) => { delivered.push({ id: m.id, recovered }); return gatePasses },
    ) as (readyAt: number) => Promise<void>
    return { recoverMissed, fetches, delivered, marks, DM, GROUP }
  }

  it('first start: no fetch at all, the file is started', async () => {
    const h = recoverHarness({ state: null, bad: false })
    await h.recoverMissed(Date.now())
    expect(h.fetches).toEqual([])
    expect(h.marks).toHaveLength(1)
  })

  it('within 10 minutes of the last run (a respawn loop): no fetch, the time-lock is not moved', async () => {
    const h = recoverHarness({ state: { lastBackfillAt: Date.now() - 60_000, channels: { ['1438000000000000500']: id(20) } }, bad: false })
    await h.recoverMissed(Date.now())
    expect(h.fetches).toEqual([])
    expect(h.marks).toEqual([])
  })

  it('a missed message the access check drops is counted as missed, not as recovered', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true })
    try {
      const h = recoverHarness({ state: { lastBackfillAt: 0, channels: { ['1438000000000000500']: id(20) } }, bad: false }, false)
      await h.recoverMissed(Date.now())
    } finally { spy.mockRestore() }
    expect(lines.join('')).toContain('recovered 0 message(s) (1 missed, the rest dropped by the access check as live ones would be)')
  })

  it('due: one fetch per channel that has a cursor, after it; each message through handleInbound as recovered', async () => {
    const h = recoverHarness({ state: { lastBackfillAt: 0, channels: { ['1438000000000000500']: id(20) } }, bad: false })
    await h.recoverMissed(Date.now())
    expect(h.fetches).toEqual([{ channel: h.DM, opts: { after: id(20), limit: 100 } }]) // the group has no cursor: skipped
    expect(h.delivered).toEqual([{ id: id(21), recovered: true }])
    expect(h.marks).toHaveLength(1)
  })
})

describe('F4: what the recovery reports is what reached the session (live probe 2026-11-11: "recovered 5", 0 arrived)', () => {
  it('handleInbound tells whether the message reached the session', async () => {
    for (const [gate, text, recovered, want] of [
      [{ action: 'drop' }, 'hi', false, false],
      [{ action: 'pair', code: 'abc123', isResend: false }, 'hi', false, false],
      [{ action: 'pair', code: 'abc123', isResend: false }, 'hi', true, false],
      [{ action: 'deliver', access: {} }, 'yes abcde', false, false],
      [{ action: 'deliver', access: {} }, 'yes abcde', true, true],
      [{ action: 'deliver', access: {} }, 'hi', false, true],
    ] as Array<[Record<string, unknown>, string, boolean, boolean]>) {
      const h = inboundHarness(gate)
      expect(await h.handleInbound(h.msg(text), recovered), JSON.stringify([gate.action, text, recovered])).toBe(want)
    }
  })

})
