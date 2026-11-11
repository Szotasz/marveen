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
    expect(at(JSON.stringify({ ownerUserId: OWNER, backfill: true }))).toEqual({ ownerUserId: OWNER, backfill: true, channelPolicy: {} })
    expect(at(null)).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {} })
    expect(at('{ bad')).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {} })
    expect(at(JSON.stringify({ ownerUserId: 'zoli', backfill: 'yes' }))).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {} })
    expect(at(JSON.stringify({ ownerUserId: 290903699524550656, backfill: 1 }))).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {} })
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
    const ready = SERVER.slice(SERVER.indexOf("client.once('ready'"), SERVER.indexOf('client.login(TOKEN).catch'))
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
    'safeAttName', 'voiceMeta', 'inboundAttachments', 'forwardedParts', 'replyContextMeta',
    `${slice('async function handleInbound(', '// DCEXT1111 F4: deliver, once')}\nreturn handleInbound`,
  )(
    async () => gateResult, { DM: 1, GuildText: 0 }, new Map(), new Set(), true,
    { note: (c: string, m: string) => cursorNotes.push(`${c}:${m}`) }, PERMISSION_REPLY_RE,
    ext.mayDecidePermission, () => (ownerId ? { id: ownerId, source: 'setting' } : { id: null, reason: 'x' }), decided,
    { notification: async (n: (typeof notes)[0]) => { notes.push(n) } }, new Map(), new Map(),
    (a: { name?: string }) => a.name ?? 'f', ext.voiceMeta,
    (m: { attachments: Map<string, unknown>; messageSnapshots: Map<string, { attachments?: Map<string, unknown> }> }) =>
      [...m.attachments.values(), ...[...m.messageSnapshots.values()].flatMap(s => [...(s.attachments?.values() ?? [])])],
    ext.forwardedParts, ext.replyContextMeta,
  ) as (msg: unknown, recovered?: boolean) => Promise<boolean>
  type Snap = { content: string; attachments: Map<string, { name: string; size: number; contentType: string }> }
  const msg = (content: string, o: { dm?: boolean; author?: string; snapshots?: Snap[]; reference?: { id: string; username: string; content: string; attachments?: string[] } | 'gone' } = {}) => ({
    id: id(77), channelId: '1438000000000000500', content,
    author: { id: o.author ?? OWNER, username: 'zoli' },
    channel: { type: o.dm === false ? 0 : 1, isThread: () => false, sendTyping: async () => { typing.push('t') } },
    createdAt: new Date(0), attachments: new Map(), flags: { bitfield: 0 },
    messageSnapshots: new Map((o.snapshots ?? []).map((sn, i) => [String(i), sn])),
    reference: o.reference || o.snapshots?.length ? { messageId: id(5) } : undefined,
    fetchReference: async () => {
      if (!o.reference || o.reference === 'gone') throw new Error('Unknown Message')
      const r = o.reference
      return { id: r.id, author: { username: r.username }, content: r.content, attachments: new Map((r.attachments ?? []).map(n => [n, { name: n }])) }
    },
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
      `${slice('async function recoverMissed(', '// DCEXT1111 E1:')}\nreturn recoverMissed`,
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

// ---------------------------------------------------------------------------------------------------------------
// PR1 (DCEXT1111 Hermes parity, terv.md 1. PR): D1, A1, A2, A3, D2
// ---------------------------------------------------------------------------------------------------------------

// Every Discord call in the overlay that puts a message (or a thread) on Discord. A new one fails this list until it
// is added here: then it is known to go out with the client's allowedMentions default (D1), never its own.
const OUTBOUND_SITES = [
  'await ch.send("Paired! Say hi to Claude.")',
  'await user.send({ content: text, components: [row] })',
  'const sent = await ch.send({',
  '.startThread({ name })',
  'await ch.threads.create({ name })',
  'const edited = await msg.edit(args.text as string)',
  "await interaction.reply({ content: 'Not authorized.', ephemeral: true })",
  "await interaction.reply({ content: 'Already answered.', ephemeral: true })",
  "await interaction.reply({ content: 'Details no longer available.', ephemeral: true })",
  'await interaction.update({ content: expanded, components: [row] })',
  '.update({ content: `${interaction.message.content}\\n\\n${label}`, components: [] })',
  "await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {}) // MARVEEN-PATCH",
  "await interaction.reply({ content: 'Already answered.', ephemeral: true }).catch(() => {}) // MARVEEN-PATCH",
  '.update(answered.length <= MAX_CHUNK_LIMIT ?',
  'await msg.reply(',
  'void prompt.edit({',
]
const OUTBOUND_RE = /\.(send|reply|edit|update|followUp|startThread|editReply|deferReply)\(|threads\.create\(/g

describe('D1: no @everyone, @here or role ping from any outgoing call', () => {
  it('the overlay has exactly the known outbound call sites (a new one must be listed here first)', () => {
    const lines = SERVER.split('\n').filter(l => OUTBOUND_RE.test(l) && !(OUTBOUND_RE.lastIndex = 0))
    expect(lines).toHaveLength(OUTBOUND_SITES.length)
    for (const site of OUTBOUND_SITES) expect(SERVER, site).toContain(site)
  })

  it('allowedMentions is set ONCE, as the client default; no call site overrides it', () => {
    expect(SERVER.match(/allowedMentions/g)).toHaveLength(1)
    const client = SERVER.slice(SERVER.indexOf('const client = new Client({'), SERVER.indexOf('})', SERVER.indexOf('const client = new Client({')) + 2)
    expect(client).toContain('allowedMentions: SAFE_MENTIONS,')
    expect(ext.SAFE_MENTIONS).toEqual({ parse: ['users'], repliedUser: true })
  })

  // The real discord.js (the plugin's own node_modules): every send, edit, reply and update goes through
  // MessagePayload.resolveBody, one branch for every target type (MessagePayload.js:177-180).
  const NM = process.env.DISCORD_PLUGIN_NODE_MODULES ?? join(require('node:os').homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'discord', '0.0.4', 'node_modules')
  const haveDjs = require('node:fs').existsSync(join(NM, 'discord.js', 'package.json'))
  if (!haveDjs) console.warn(`D1 runtime check SKIPPED: no discord.js at ${NM} (set DISCORD_PLUGIN_NODE_MODULES)`)
  it.skipIf(!haveDjs)('with the overlay\'s client default, the request body never parses everyone or roles', () => {
    const req = require('node:module').createRequire(join(NM, 'discord.js', 'package.json'))
    const { Client, MessagePayload } = req('discord.js')
    const client = new Client({ intents: [], allowedMentions: ext.SAFE_MENTIONS })
    try {
      for (const options of [
        { content: '@everyone @here <@&123456789012345678> hi' },
        { content: 'x', components: [] },
        { content: 'y', reply: { messageReference: '1', failIfNotExists: false } },
        { content: 'z', ephemeral: true },
      ]) {
        const body = new MessagePayload({ client, messages: { resolveId: (r: string) => r } }, options).resolveBody().body
        expect(body.allowed_mentions, JSON.stringify(options)).toEqual({ parse: ['users'], replied_user: true })
      }
      // control: an override would win -- which is why no call site may pass one (test above)
      const over = new MessagePayload({ client }, { content: 'x', allowedMentions: { parse: ['everyone'] } }).resolveBody().body
      expect(over.allowed_mentions).toEqual({ parse: ['everyone'] })
    } finally { client.destroy() }
  })
})

describe('D2: a reply too long for 8 messages is refused before anything is sent', () => {
  it('the cap is 8, checked before the send loop', () => {
    expect(ext.MAX_REPLY_CHUNKS).toBe(8)
    const reply = SERVER.slice(SERVER.indexOf("case 'reply': {"), SERVER.indexOf("case 'fetch_messages': {"))
    expect(reply.indexOf('if (chunks.length > MAX_REPLY_CHUNKS) {')).toBeGreaterThan(0)
    expect(reply.indexOf('if (chunks.length > MAX_REPLY_CHUNKS) {')).toBeLessThan(reply.indexOf('const sent = await ch.send({'))
    expect(reply).toContain('nothing sent -- shorten it, or attach it as a file')
  })
})

describe('A1: a follow-up in the bot\'s thread needs no @mention -- only under an opted-in channel', () => {
  const NOW = 1_800_000_000_000
  it('BotThreads: add, has, age-out, cap, and junk ignored', () => {
    let now = NOW
    const saved: Array<Record<string, number>> = []
    const t = new ext.BotThreads(ext.BotThreads.parse(JSON.stringify({ [id(1)]: NOW - 1000, bad: 5, [id(2)]: NOW - 31 * 86400_000 })), (s: Record<string, number>) => saved.push(s), () => now)
    expect(t.has(id(1))).toBe(true)
    expect(t.has(id(2))).toBe(false) // older than 30 days
    t.add(id(3))
    expect(t.has(id(3))).toBe(true)
    expect(Object.keys(saved.at(-1)!)).toEqual([id(1), id(3)])
    t.add('not-an-id')
    expect(saved).toHaveLength(1)
    now += 31 * 86400_000
    expect(t.has(id(3))).toBe(false)
    expect(ext.BotThreads.parse('{ bad')).toEqual({})
    expect(ext.BotThreads.parse('[1]')).toEqual({})
  })

  it('BotThreads keeps at most 500, dropping the oldest', () => {
    const t = new ext.BotThreads({}, () => {}, () => NOW)
    for (let i = 0; i < 510; i++) t.add(id(1000 + i))
    expect(t.has(id(1000))).toBe(false)
    expect(t.has(id(1509))).toBe(true)
  })

  // The overlay's own gate(), run: who gets through in a thread.
  function gateHarness(o: { groups: Record<string, { requireMention?: boolean; allowFrom?: string[] }>; listed?: string[]; channelPolicy?: Record<string, { allowRoles: string[] }> }) {
    const threads = new ext.BotThreads(Object.fromEntries((o.listed ?? []).map(t => [t, Date.now()])), () => {})
    const inBotThread = new Function('client', 'botThreads', `${slice('function inBotThread(', 'function noteSent(')}\nreturn inBotThread`)({ user: { id: 'bot' } }, threads)
    const gate = new Function(
      'loadAccess', 'pruneExpired', 'saveAccess', 'ChannelType', 'isMentioned', 'inBotThread', 'randomBytes',
      'channelSenderAllowed', 'EXT', 'memberRoleIds',
      `${slice('async function gate(', 'async function isMentioned(')}\nreturn gate`,
    )(() => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: o.groups, pending: {} }), () => false, () => {}, { DM: 1 },
      async (m: { mentioned?: boolean }) => !!m.mentioned, inBotThread, () => Buffer.alloc(3),
      ext.channelSenderAllowed, { channelPolicy: o.channelPolicy ?? {} }, (m: { roles?: string[] } | null | undefined) => m?.roles ?? [])
    const threadMsg = (parent: string, thread: string, owner: string | null, author = OWNER, mentioned = false) => ({
      author: { id: author }, channelId: thread, mentioned,
      channel: { type: 11, isThread: () => true, parentId: parent, id: thread, ownerId: owner },
    })
    return { gate: gate as (m: unknown) => Promise<{ action: string }>, threadMsg }
  }
  const CH = '1438000000000000700'
  const OTHER_CH = '1438000000000000800'

  it('a thread the bot opened, under an opted-in channel: delivered without @mention', async () => {
    const h = gateHarness({ groups: { [CH]: { requireMention: true, allowFrom: [] } } })
    expect((await h.gate(h.threadMsg(CH, id(50), 'bot'))).action).toBe('deliver')
  })

  it('a thread the bot wrote in (listed): delivered without @mention; an unlisted foreign thread is not', async () => {
    const h = gateHarness({ groups: { [CH]: { requireMention: true, allowFrom: [] } }, listed: [id(51)] })
    expect((await h.gate(h.threadMsg(CH, id(51), 'someone'))).action).toBe('deliver')
    expect((await h.gate(h.threadMsg(CH, id(52), 'someone'))).action).toBe('drop')
    expect((await h.gate(h.threadMsg(CH, id(52), 'someone', OWNER, true))).action).toBe('deliver') // control: a mention still works
  })

  it('a bot thread whose parent is NOT opted in is never followed (Etelka 7021)', async () => {
    const h = gateHarness({ groups: { [CH]: { requireMention: true, allowFrom: [] } }, listed: [id(53)] })
    expect((await h.gate(h.threadMsg(OTHER_CH, id(53), 'bot'))).action).toBe('drop')
  })

  it('the channel\'s own allowFrom still applies inside the bot\'s thread', async () => {
    const h = gateHarness({ groups: { [CH]: { requireMention: true, allowFrom: [OWNER] } } })
    expect((await h.gate(h.threadMsg(CH, id(54), 'bot', OTHER))).action).toBe('drop')
  })

  it('reply records a thread only when its parent channel is opted in', () => {
    const reply = SERVER.slice(SERVER.indexOf("case 'reply': {"), SERVER.indexOf("case 'fetch_messages': {"))
    expect(reply).toContain('if (ch.isThread() && ch.parentId !== null && ch.parentId in loadAccess().groups) botThreads.add(ch.id)')
    expect(SERVER).toContain('if (requireMention && !inBotThread(msg) && !(await isMentioned(msg, access.mentionPatterns))) {')
  })
})

describe('A2 + A3: reply context and forwarded messages (the overlay\'s handleInbound, run)', () => {
  it('a reply carries what it answers, folded to one line and cut at 500', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    const long = 'első sor\nmásodik ' + 'x'.repeat(600)
    await h.handleInbound(h.msg('igen', { reference: { id: id(5), username: 'heimdall', content: long, attachments: ['a.png'] } }))
    const meta = h.notes[0]!.params.meta!
    expect(meta.reply_to_message_id).toBe(id(5))
    expect(meta.reply_to_user).toBe('heimdall')
    expect(meta.reply_to_text).not.toContain('\n')
    expect([...meta.reply_to_text!]).toHaveLength(501) // 500 + the ellipsis
    expect(meta.reply_to_attachments).toBe('a.png')
    expect(h.notes[0]!.params.content).toBe('igen')
  })

  it('a reply whose target is gone just has no reply context', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    expect(await h.handleInbound(h.msg('igen', { reference: 'gone' }))).toBe(true)
    expect(h.notes[0]!.params.meta!.reply_to_message_id).toBeUndefined()
  })

  it('a forwarded message is not empty: its text, its files, forwarded="1", and no reply context from the source', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    await h.handleInbound(h.msg('', {
      snapshots: [{ content: 'továbbított szöveg', attachments: new Map([['1', { name: 'doc.pdf', size: 2048, contentType: 'application/pdf' }]]) }],
      reference: { id: id(6), username: 'source', content: 'the source message' }, // a forward also has a reference
    }))
    const p = h.notes[0]!.params
    expect(p.content).toBe('továbbított szöveg')
    expect(p.meta).toMatchObject({ forwarded: '1', attachment_count: '1' })
    expect(p.meta!.attachments).toContain('doc.pdf')
    expect(p.meta!.reply_to_message_id).toBeUndefined()
  })

  it('forwardedParts / replyContextMeta in isolation', () => {
    expect(ext.forwardedParts([])).toBeNull()
    expect(ext.forwardedParts([{ content: ' a ', attachmentCount: 1 }, { content: '', attachmentCount: 2 }])).toEqual({ text: 'a', attachmentCount: 3 })
    expect(ext.replyContextMeta({ id: '1', username: 'u', content: 'a\r\nb', attachments: [] })).toEqual({ reply_to_message_id: '1', reply_to_user: 'u', reply_to_text: 'a ⏎ b' })
  })

  it('download_attachment also takes a forward\'s files', () => {
    const dl = SERVER.slice(SERVER.indexOf("case 'download_attachment': {"), SERVER.indexOf("default:", SERVER.indexOf("case 'download_attachment': {")))
    expect(dl).toContain('const all = inboundAttachments(msg)')
    expect(dl).toContain('for (const att of all) {')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// PR2 (terv.md 2. PR): B1 role-based access, E1 liveness
// ---------------------------------------------------------------------------------------------------------------
const ROLE = '1438000000000009001'
const ROLE2 = '1438000000000009002'

describe('B1: roles per channel (DISCORD_CHANNEL_POLICY)', () => {
  it('parseChannelPolicy keeps only well-formed entries', () => {
    expect(ext.parseChannelPolicy({ [id(1)]: { allowRoles: [ROLE, 'x', 5] }, bad: { allowRoles: [ROLE] }, [id(2)]: { allowRoles: [] }, [id(3)]: 'no' }))
      .toEqual({ [id(1)]: { allowRoles: [ROLE] } })
    for (const junk of [null, [], 'x', 7]) expect(ext.parseChannelPolicy(junk)).toEqual({})
  })

  it('channelSenderAllowed: without roles the upstream rule; with roles, allowFrom OR a role (empty allowFrom = role holders only)', () => {
    const f = ext.channelSenderAllowed
    expect(f([], undefined, OTHER, [])).toBe(true) // upstream: empty allowFrom = anyone
    expect(f([OWNER], undefined, OTHER, [ROLE])).toBe(false)
    expect(f([OWNER], [ROLE], OTHER, [ROLE])).toBe(true)
    expect(f([OWNER], [ROLE], OTHER, [ROLE2])).toBe(false)
    expect(f([OWNER], [ROLE], OWNER, [])).toBe(true)
    expect(f([], [ROLE], OTHER, [])).toBe(false) // roles configured: no longer anyone
    expect(f([], [ROLE], OTHER, [ROLE2, ROLE])).toBe(true)
  })

  it('the overlay\'s gate(), run: a role holder speaks in the channel; DMs are not touched by roles', async () => {
    const CH = '1438000000000000700'
    const h = (channelPolicy: Record<string, { allowRoles: string[] }>) => {
      const gate = new Function(
        'loadAccess', 'pruneExpired', 'saveAccess', 'ChannelType', 'isMentioned', 'inBotThread', 'randomBytes',
        'channelSenderAllowed', 'EXT', 'memberRoleIds',
        `${slice('async function gate(', 'async function isMentioned(')}\nreturn gate`,
      )(() => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { [CH]: { requireMention: false, allowFrom: [OWNER] } }, pending: {} }),
        () => false, () => {}, { DM: 1 }, async () => false, () => false, () => Buffer.alloc(3),
        ext.channelSenderAllowed, { channelPolicy }, (m: { roles?: string[] } | null | undefined) => m?.roles ?? [])
      return gate as (m: unknown) => Promise<{ action: string }>
    }
    const msg = (author: string, roles: string[] | null, dm = false) => ({
      author: { id: author }, channelId: dm ? 'dm' : CH, member: roles === null ? null : { roles },
      channel: { type: dm ? 1 : 0, isThread: () => false, id: dm ? 'dm' : CH },
    })
    expect((await h({})(msg(OTHER, [ROLE]))).action).toBe('drop') // control: no policy, not in allowFrom
    expect((await h({ [CH]: { allowRoles: [ROLE] } })(msg(OTHER, [ROLE]))).action).toBe('deliver')
    expect((await h({ [CH]: { allowRoles: [ROLE] } })(msg(OTHER, [ROLE2]))).action).toBe('drop')
    expect((await h({ [CH]: { allowRoles: [ROLE] } })(msg(OTHER, null))).action).toBe('drop')
    expect((await h({ [CH]: { allowRoles: [ROLE] } })(msg(OTHER, [ROLE], true))).action).toBe('drop') // a DM: allowFrom only
  })

  it('the wiring: gate() and the click check both read the policy; memberRoleIds handles both member shapes', () => {
    expect(SERVER).toContain('if (!channelSenderAllowed(groupAllowFrom, EXT.channelPolicy[channelId]?.allowRoles, senderId, memberRoleIds(msg.member))) {')
    expect(SERVER).toContain('if (roles && roles.length > 0) return groupAllowFrom.includes(userId) || memberRoleIds(interaction.member).some(r => roles.includes(r))')
    const memberRoleIds = new Function(`${slice('function memberRoleIds(', '// DCEXT1111 A3: the message')}\nreturn memberRoleIds`)()
    expect(memberRoleIds({ roles: { cache: new Map([[ROLE, {}], [ROLE2, {}]]) } })).toEqual([ROLE, ROLE2])
    expect(memberRoleIds({ roles: [ROLE, 5] })).toEqual([ROLE])
    expect(memberRoleIds(null)).toEqual([])
  })
})

describe('E1: liveness and the IDENTIFY-aware reconnect governor (#1965)', () => {
  it('the constants are pinned: a silent change fails here', () => {
    expect(ext.LIVENESS).toEqual({
      probeIntervalMs: 15_000, failThreshold: 2, heartbeatMaxLatencyMs: 30_000, eventSilenceMaxMs: 4 * 3600_000,
      notReadyMaxMs: 120_000, reconnectMinIntervalMs: 5 * 60_000, backoffMs: [5, 10, 20, 40, 60].map(m => m * 60_000),
      backoffWindowMs: 2 * 3600_000, maxReconnectsPer24h: 20,
    })
  })

  it('assessHealth: event silence alone is healthy (a quiet server); only with a bad heartbeat is it bad (Etelka 7021)', () => {
    const s = (o: Partial<{ ready: boolean; notReadyForMs: number; pingMs: number; eventSilenceMs: number }>) =>
      ext.assessHealth({ ready: true, notReadyForMs: 0, pingMs: 80, eventSilenceMs: 0, ...o })
    expect(s({}).bad).toBe(false)
    expect(s({ eventSilenceMs: 10 * 3600_000 }).bad).toBe(false) // 10 h of silence, fresh heartbeat
    expect(s({ eventSilenceMs: 10 * 3600_000, pingMs: -1 }).bad).toBe(true) // silence AND no heartbeat
    expect(s({ eventSilenceMs: 60_000, pingMs: -1 }).bad).toBe(false) // no heartbeat yet, not silent long
    expect(s({ pingMs: 31_000 }).bad).toBe(true)
    expect(s({ ready: false, notReadyForMs: 60_000 }).bad).toBe(false) // discord.js resuming
    expect(s({ ready: false, notReadyForMs: 120_000 }).bad).toBe(true)
  })

  it('reconnectDecision: first at once, never sooner than 5 min, growing backoff, at most 20 in 24 h', () => {
    const NOW = 1_800_000_000_000
    expect(ext.reconnectDecision([], NOW).allowed).toBe(true)
    expect(ext.reconnectDecision([NOW - 4 * 60_000], NOW).allowed).toBe(false)
    expect(ext.reconnectDecision([NOW - 6 * 60_000], NOW).allowed).toBe(false) // 1 recent -> 10 min
    expect(ext.reconnectDecision([NOW - 11 * 60_000], NOW).allowed).toBe(true)
    const day = Array.from({ length: 20 }, (_, i) => NOW - (23 - i) * 3600_000)
    expect(ext.reconnectDecision(day, NOW)).toMatchObject({ allowed: false, reason: expect.stringContaining('20 reconnects in 24 h') })
  })

  it('loop simulation: a gateway bad for 24 h straight costs at most 20 logins, at most 3 in the first hour', () => {
    const start = 1_800_000_000_000
    const history: number[] = []
    let bad = 0
    for (let t = start; t < start + 24 * 3600_000; t += ext.LIVENESS.probeIntervalMs) {
      bad++
      if (bad < ext.LIVENESS.failThreshold) continue
      if (ext.reconnectDecision(history, t).allowed) { history.push(t); bad = 0 }
    }
    expect(history.length).toBeLessThanOrEqual(20)
    expect(history.filter(t => t < start + 3600_000).length).toBeLessThanOrEqual(3)
    for (let i = 1; i < history.length; i++) expect(history[i]! - history[i - 1]!).toBeGreaterThanOrEqual(5 * 60_000)
  })

  // The overlay's own readReconnects + livenessTick, run with a fake client and an in-memory file.
  function tickHarness(o: { ready?: boolean; ping?: number; silenceMs?: number; file?: string | null; writeFails?: boolean } = {}) {
    const files: Record<string, string> = {}
    if (o.file) files['R'] = o.file
    const calls: string[] = []
    const now = Date.now()
    const client = { isReady: () => o.ready ?? true, ws: { ping: o.ping ?? -1 }, destroy: async () => { calls.push('destroy') }, login: async () => { calls.push('login') } }
    const code = `let lastEventAt = ${now - (o.silenceMs ?? 5 * 3600_000)}; let notReadySince = null; let badSamples = 0; let reconnecting = false; let lastHeldReason = ''; const shuttingDown = false;\n` +
      `${slice('function readReconnects(', 'setInterval(() => { void livenessTick() }')}\nreturn livenessTick`
    const tick = new Function('RECONNECT_FILE', 'client', 'assessHealth', 'LIVENESS', 'reconnectDecision', 'readFileSync', 'writeFileSync', 'TOKEN', code)(
      'R', client, ext.assessHealth, ext.LIVENESS, ext.reconnectDecision,
      (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p] },
      (p: string, d: string) => { if (o.writeFails) throw new Error('EACCES'); files[p] = d },
      't') as () => Promise<void>
    return { tick, calls, files }
  }

  it('run: two bad samples -> the reconnect is recorded FIRST, then destroy + login, once', async () => {
    const h = tickHarness()
    await h.tick()
    expect(h.calls).toEqual([]) // one bad sample is not enough
    await h.tick()
    expect(h.calls).toEqual(['destroy', 'login'])
    expect(JSON.parse(h.files['R']!)).toHaveLength(1)
  })

  it('run: a quiet server with a live heartbeat never reconnects', async () => {
    const h = tickHarness({ ping: 90, silenceMs: 12 * 3600_000 })
    for (let i = 0; i < 10; i++) await h.tick()
    expect(h.calls).toEqual([])
  })

  it('run: a recent reconnect in the history holds the next one; an unwritable history blocks it', async () => {
    const held = tickHarness({ file: JSON.stringify([Date.now() - 60_000]) })
    await held.tick(); await held.tick(); await held.tick()
    expect(held.calls).toEqual([])
    const nofile = tickHarness({ writeFails: true })
    await nofile.tick(); await nofile.tick()
    expect(nofile.calls).toEqual([]) // no record, no IDENTIFY
  })

  it('the wiring: raw events feed the silence clock, the probe runs on the pinned interval', () => {
    expect(SERVER).toContain("client.on('raw', () => { lastEventAt = Date.now() })")
    expect(SERVER).toContain('setInterval(() => { void livenessTick() }, LIVENESS.probeIntervalMs).unref()')
  })
})
