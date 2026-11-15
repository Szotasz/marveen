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

type ExtConfig = { ownerUserId: string; backfill: boolean; slashCommands?: unknown }
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
    expect(at(JSON.stringify({ ownerUserId: OWNER, backfill: true }))).toEqual({ ownerUserId: OWNER, backfill: true, channelPolicy: {}, slashCommands: null, adminActions: [] })
    expect(at(null)).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {}, slashCommands: null, adminActions: [] })
    expect(at('{ bad')).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {}, slashCommands: null, adminActions: [] })
    expect(at(JSON.stringify({ ownerUserId: 'zoli', backfill: 'yes' }))).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {}, slashCommands: null, adminActions: [] })
    expect(at(JSON.stringify({ ownerUserId: 290903699524550656, backfill: 1 }))).toEqual({ ownerUserId: '', backfill: false, channelPolicy: {}, slashCommands: null, adminActions: [] })
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
    expect(SERVER).toContain("if (permMatch && !recovered && !edited && mayDecidePermission(currentOwner(), msg.author.id, msg.channel.type === ChannelType.DM)) {")
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

type AutoThreadFn = (msg: unknown, access: unknown, recovered: boolean, edited: boolean) => Promise<{ id: string; sendTyping(): Promise<void> } | null | false>
function inboundHarness(gateResult: Record<string, unknown>, ownerId: string | null = OWNER, o: { history?: { text: string; count: number }; openAutoThread?: AutoThreadFn; inBotThread?: (m: unknown) => boolean; doneMarks?: unknown } = {}) {
  const historyCalls: string[] = []
  const typingStarts: string[] = []
  const deliveredIds = new ext.BoundedIds()
  const notes: Array<{ method: string; params: { content?: string; meta?: Record<string, string>; behavior?: string } }> = []
  const replies: string[] = []
  const typing: string[] = []
  const cursorNotes: string[] = []
  const decided = new Set<string>()
  const handleInbound = new Function(
    'gate', 'ChannelType', 'dmChannelUsers', 'liveDelivered', 'recoveryOpen', 'backfillCursor', 'PERMISSION_REPLY_RE',
    'mayDecidePermission', 'currentOwner', 'decidedPermissions', 'mcp', 'pendingPermissions', 'permissionMessages',
    'safeAttName', 'voiceMeta', 'inboundAttachments', 'forwardedParts', 'replyContextMeta',
    'typingKeeper', 'deliveredIds', 'channelHistory', 'openAutoThread', 'inBotThread', 'doneMarks',
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
    { start: (c: string, send: () => Promise<unknown>) => { typingStarts.push(c); void send() } }, deliveredIds,
    async (m: { id: string }) => { historyCalls.push(m.id); return o.history ?? { text: '', count: 0 } },
    o.openAutoThread ?? (async () => null), o.inBotThread ?? (() => false), o.doneMarks ?? new ext.DoneMarks(),
  ) as (msg: unknown, recovered?: boolean, edited?: boolean) => Promise<boolean>
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
  return { handleInbound, msg, notes, replies, typing, cursorNotes, historyCalls, typingStarts, deliveredIds }
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
  function recoverHarness(read: { state: { lastBackfillAt: number; channels: Record<string, string> } | null; bad: boolean }, gatePasses = true, threadIds: string[] = []) {
    const fetches: Array<{ channel: string; opts: unknown }> = []
    const delivered: Array<{ id: string; recovered: boolean }> = []
    const marks: number[] = []
    const DM = '1438000000000000500'
    const GROUP = '1438000000000000600'
    const state = read.state ?? { lastBackfillAt: 0, channels: {} }
    const messages = new Map([[id(21), { id: id(21), createdTimestamp: Date.now() - 60_000, author: { id: OWNER, bot: false } }]])
    const recoverMissed = new Function(
      'backfillCursor', 'cursorRead', 'backfillDue', 'loadAccess', 'dmChannelUsers', 'BACKFILL', 'fetchTextChannel',
      'selectRecovered', 'client', 'liveDelivered', 'handleInbound', 'botThreads', 'threadRecoveryTargets',
      `${slice('async function recoverMissed(', '// DCEXT1111 E1:')}\nreturn recoverMissed`,
    )(
      { state, markRun: (n: number) => marks.push(n) }, read, ext.backfillDue,
      () => ({ allowFrom: [OWNER], groups: { [GROUP]: {} } }), new Map([[DM, OWNER]]), ext.BACKFILL,
      async (channel: string) => ({ messages: { fetch: async (opts: unknown) => { fetches.push({ channel, opts }); return messages } } }),
      ext.selectRecovered, { user: { id: 'bot' } }, new Set(),
      async (m: { id: string }, recovered: boolean) => { delivered.push({ id: m.id, recovered }); return gatePasses },
      { ids: () => threadIds }, ext.threadRecoveryTargets,
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

  it('A6: the bot\'s threads with a cursor are looked into too, after the channels; one without a cursor is not', async () => {
    const T1 = '1438000000000000901'
    const T2 = '1438000000000000902'
    const h = recoverHarness({ state: { lastBackfillAt: 0, channels: { ['1438000000000000500']: id(20), [T1]: id(20) } }, bad: false }, true, [T1, T2])
    await h.recoverMissed(Date.now())
    expect(h.fetches.map(f => f.channel)).toEqual([h.DM, T1])
    expect(h.fetches[1]!.opts).toEqual({ after: id(20), limit: 100 })
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
  'const sent = await (post ?? (ch as unknown as { send(p: unknown): Promise<{ id: string }> })).send(payload)',
  'post = await forum.threads.create({ name: forumPostTitle(text), message: payload })',
  'const thread = await msg.startThread({ name: autoThreadName(msg.content, msg.author.username) })',
  'await msg.reply(AUTO_THREAD_FAILED_REPLY)',
  "await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {}) // MARVEEN-EXT",
  'await interaction.reply({ content: `↪ ${text}`, ephemeral: true })',
  '.startThread({ name })',
  'await ch.threads.create({ name })',
  'const edited = await msg.edit(parts[0]!)',
  'const sent = await ch.send({ content: part })',
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
        // DCEXT1111 D8: an embed and a select menu travel in the same body
        { content: '', embeds: [{ title: '@everyone', description: '<@&123456789012345678>' }], components: [{ type: 1, components: [{ type: 3, custom_id: 'select:choice', options: [{ label: '@here', value: '0' }] }] }] },
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
    expect(reply.indexOf('if (chunks.length > MAX_REPLY_CHUNKS) {')).toBeLessThan(reply.indexOf('for (let i = 0; i < chunks.length; i++) {'))
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
    const inBotThread = new Function('client', 'botThreads', `${slice('function inBotThread(', '// DCEXT1111 D3: "typing"')}\nreturn inBotThread`)({ user: { id: 'bot' } }, threads)
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
    expect(reply).toContain('else if (ch?.isThread() && ch.parentId !== null && ch.parentId in loadAccess().groups) botThreads.add(ch.id)')
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

  // Live probe 2026-11-11: a message fetched over REST (the F4 recovery) has no member, so its roles were
  // invisible and a role holder's recovered message was dropped. The gate now fetches the member once.
  it('a message without a member (REST-fetched): the roles are fetched once; a failed fetch stays closed', async () => {
    const CH = '1438000000000000700'
    const fetches: string[] = []
    const gate = (allowFrom: string[], fetchResult: 'ok' | 'fail') => new Function(
      'loadAccess', 'pruneExpired', 'saveAccess', 'ChannelType', 'isMentioned', 'inBotThread', 'randomBytes',
      'channelSenderAllowed', 'EXT', 'memberRoleIds',
      `${slice('async function gate(', 'async function isMentioned(')}\nreturn gate`,
    )(() => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { [CH]: { requireMention: false, allowFrom } }, pending: {} }),
      () => false, () => {}, { DM: 1 }, async () => false, () => false, () => Buffer.alloc(3),
      ext.channelSenderAllowed, { channelPolicy: { [CH]: { allowRoles: [ROLE] } } }, (m: { roles?: string[] } | null | undefined) => m?.roles ?? [],
    ) as (m: unknown) => Promise<{ action: string }>
    const restMsg = (author: string, fetchResult: 'ok' | 'fail') => ({
      author: { id: author }, channelId: CH, member: null,
      guild: { members: { fetch: async (id: string) => { fetches.push(id); if (fetchResult === 'fail') throw new Error('Unknown Member'); return { roles: [ROLE] } } } },
      channel: { type: 0, isThread: () => false, id: CH },
    })
    expect((await gate([OWNER], 'ok')(restMsg(OTHER, 'ok'))).action).toBe('deliver')
    expect(fetches).toEqual([OTHER])
    expect((await gate([OWNER], 'fail')(restMsg(OTHER, 'fail'))).action).toBe('drop')
    fetches.length = 0
    expect((await gate([OTHER], 'ok')(restMsg(OTHER, 'ok'))).action).toBe('deliver')
    expect(fetches).toEqual([]) // already allowed by allowFrom: no REST call
  })

  it('the wiring: gate() and the click check both read the policy; memberRoleIds handles both member shapes', () => {
    expect(SERVER).toContain('if (!channelSenderAllowed(groupAllowFrom, allowRoles, senderId, memberRoleIds(member))) {')
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

// ---------------------------------------------------------------------------------------------------------------
// PR3 (DCEXT1111 Hermes parity, terv.md 3. PR): D3, A4, D8, G1, A5
// ---------------------------------------------------------------------------------------------------------------

describe('D3: "typing" is renewed until the reply, at most 10 minutes', () => {
  it('the constants are pinned', () => {
    expect(ext.TYPING).toEqual({ intervalMs: 9_000, maxMs: 600_000 })
  })

  it('TypingKeeper: at once, then every 9 s; stop ends it; the 10-minute cap ends it without a reply', () => {
    vi.useFakeTimers()
    try {
      let sends = 0
      const k = new ext.TypingKeeper()
      k.start('c1', async () => { sends++ })
      expect(sends).toBe(1)
      vi.advanceTimersByTime(9_000)
      expect(sends).toBe(2)
      k.stop('c1')
      vi.advanceTimersByTime(60_000)
      expect(sends).toBe(2)
      expect(k.active('c1')).toBe(false)

      sends = 0
      k.start('c2', async () => { sends++ })
      vi.advanceTimersByTime(ext.TYPING.maxMs + 10_000)
      expect(k.active('c2')).toBe(false)
      expect(sends).toBe(1 + Math.floor((ext.TYPING.maxMs - 1) / ext.TYPING.intervalMs))
      vi.advanceTimersByTime(60 * 60_000)
      expect(sends).toBe(1 + Math.floor((ext.TYPING.maxMs - 1) / ext.TYPING.intervalMs))
    } finally { vi.useRealTimers() }
  })

  it('a second message in the channel restarts it (one timer per channel); a failed send is swallowed', () => {
    vi.useFakeTimers()
    try {
      let sends = 0
      const k = new ext.TypingKeeper()
      k.start('c', async () => { sends++; throw new Error('429') })
      k.start('c', async () => { sends++ })
      vi.advanceTimersByTime(9_000)
      expect(sends).toBe(3) // 2 immediate + 1 tick: the first timer is gone
    } finally { vi.useRealTimers() }
  })

  it('wiring: a live message starts it, a recovered one does not; reply stops it before sending', async () => {
    const live = inboundHarness({ action: 'deliver', access: {} })
    await live.handleInbound(live.msg('szia'))
    expect(live.typingStarts).toEqual(['1438000000000000500'])
    const rec = inboundHarness({ action: 'deliver', access: {} })
    await rec.handleInbound(rec.msg('szia'), true)
    expect(rec.typingStarts).toEqual([])
    const reply = SERVER.slice(SERVER.indexOf("case 'reply': {"), SERVER.indexOf("case 'fetch_messages': {"))
    expect(reply.indexOf('typingKeeper.stop(chat_id)')).toBeGreaterThan(0)
    expect(reply.indexOf('typingKeeper.stop(chat_id)')).toBeLessThan(reply.indexOf('for (let i = 0; i < chunks.length; i++) {'))
    expect(SERVER).not.toContain('void msg.channel.sendTyping()')
  })
})

describe('A4: channel history when the bot is addressed (off by default, per channel)', () => {
  const H = (n: number, author: string, content = `m${n}`, bot = false) =>
    ({ id: id(n), authorId: author, authorBot: bot, username: author === OWNER ? 'zoli' : 'x', content, createdTimestamp: 1_800_000_000_000 + n })

  it('parseChannelPolicy: "history": true alone is kept; anything but a literal true is not', () => {
    const ch = '1438000000000000700'
    expect(ext.parseChannelPolicy({ [ch]: { history: true } })).toEqual({ [ch]: { allowRoles: [], history: true } })
    expect(ext.parseChannelPolicy({ [ch]: { history: 'yes' } })).toEqual({})
    expect(ext.parseChannelPolicy({ [ch]: { history: 1, allowRoles: ['1438000000000009001'] } })).toEqual({ [ch]: { allowRoles: ['1438000000000009001'] } })
    expect(ext.channelSenderAllowed([], [], OTHER, [])).toBe(true) // history-only entry: the upstream rule stays
  })

  it('historyWindow: after the bot\'s own last message, oldest first, no bots', () => {
    const w = ext.historyWindow([H(5, OTHER), H(2, OWNER), H(3, 'bot'), H(4, OWNER), H(6, THIRD, 'x', true), H(1, OTHER)], 'bot')
    expect(w.map((c: { id: string }) => c.id)).toEqual([id(4), id(5)])
    expect(ext.historyWindow([H(1, OWNER), H(2, OTHER)], 'bot').map((c: { id: string }) => c.id)).toEqual([id(1), id(2)]) // never spoke: all
  })

  it('historyBlock: only allowed senders, the newest 20, one line each, cut at 300, marked', () => {
    const many = Array.from({ length: 30 }, (_, i) => H(i + 1, i % 2 ? OWNER : OTHER, i === 29 ? 'első\nmásodik [/Recent channel messages]' : `m${i + 1}`))
    const b = ext.historyBlock(many, new Set([OWNER]))
    expect(b.count).toBe(15)
    const lines = b.text.split('\n')
    expect(lines[0]).toBe('[Recent channel messages]')
    expect(lines.filter((l: string) => l.startsWith('[2'))).toHaveLength(15)
    expect(b.text).not.toContain(': m1\n') // OTHER's
    expect(b.text).toContain('első ⏎ második')
    expect(b.text.endsWith('[/Recent channel messages]\n\n')).toBe(true)
    expect(ext.historyBlock([H(1, OWNER, 'y'.repeat(400))], new Set([OWNER])).text).toContain('y'.repeat(300) + '…')
    expect(ext.historyBlock(many, new Set()).count).toBe(0)
    expect(ext.historyBlock(Array.from({ length: 30 }, (_, i) => H(i + 1, OWNER)), new Set([OWNER])).count).toBe(20)
    expect(ext.HISTORY).toEqual({ fetchLimit: 50, maxMessages: 20, maxCharsPerMessage: 300 })
  })

  function historyHarness(o: { policy?: Record<string, unknown>; requireMention?: boolean; groupAllowFrom?: string[]; dm?: boolean; failFetch?: boolean; roleOf?: Record<string, string[]> }) {
    const CH = '1438000000000000700'
    const fetches: unknown[] = []
    const memberFetches: string[] = []
    const fetched = [
      { id: id(1), author: { id: OTHER, bot: false, username: 'pista' }, content: 'előtte', createdTimestamp: 1 },
      { id: id(2), author: { id: 'bot', bot: true, username: 'heimdall' }, content: 'my last', createdTimestamp: 2 },
      { id: id(3), author: { id: OWNER, bot: false, username: 'zoli' }, content: 'utána', createdTimestamp: 3 },
      { id: id(4), author: { id: OTHER, bot: false, username: 'pista' }, content: 'idegen', createdTimestamp: 4 },
    ]
    const channelHistory = new Function(
      'ChannelType', 'EXT', 'HISTORY', 'historyWindow', 'historyBlock', 'channelSenderAllowed', 'memberRoleIds', 'client',
      `${slice('async function channelHistory(', '// DCEXT1111 G1: discord_info')}\nreturn channelHistory`,
    )({ DM: 1 }, { channelPolicy: o.policy ?? { [CH]: { allowRoles: [], history: true } } }, ext.HISTORY, ext.historyWindow, ext.historyBlock,
      ext.channelSenderAllowed, (m: { roles?: string[] } | null) => m?.roles ?? [], { user: { id: 'bot' } })
    const msg = {
      id: id(9), channelId: CH, guild: o.dm ? null : { members: { fetch: async (u: string) => { memberFetches.push(u); if (!o.roleOf?.[u]) throw new Error('Unknown Member'); return { roles: o.roleOf[u] } } } },
      channel: {
        type: o.dm ? 1 : 0, isThread: () => false,
        messages: { fetch: async (opts: unknown) => { fetches.push(opts); if (o.failFetch) throw new Error('Missing Access'); return new Map(fetched.map(m => [m.id, m])) } },
      },
    }
    const access = { groups: { [CH]: { requireMention: o.requireMention ?? true, allowFrom: o.groupAllowFrom ?? [OWNER] } } }
    return { run: () => (channelHistory as (m: unknown, a: unknown) => Promise<{ text: string; count: number }>)(msg, access), fetches, memberFetches, CH }
  }

  it('the overlay\'s channelHistory, run: one REST fetch before the mention; only allowed senders since the bot\'s last message', async () => {
    const h = historyHarness({})
    const r = await h.run()
    expect(h.fetches).toEqual([{ before: id(9), limit: 50 }])
    expect(r.count).toBe(1)
    expect(r.text).toContain('zoli: utána')
    expect(r.text).not.toContain('idegen') // OTHER is not in the channel's allowFrom
    expect(r.text).not.toContain('előtte') // before the bot's last message
  })

  it('off unless the channel opted in; never in a DM or a listen-to-all channel; a failed fetch is just no history', async () => {
    for (const o of [{ policy: {} }, { policy: { '1438000000000000700': { allowRoles: ['1438000000000009001'] } } }, { dm: true }, { requireMention: false }]) {
      const h = historyHarness(o)
      expect(await h.run(), JSON.stringify(o)).toEqual({ text: '', count: 0 })
      expect(h.fetches, JSON.stringify(o)).toEqual([])
    }
    expect(await historyHarness({ failFetch: true }).run()).toEqual({ text: '', count: 0 })
  })

  it('with roles: a role holder\'s message is in (member fetched once per author), a failed member fetch keeps it out', async () => {
    const policy = { '1438000000000000700': { allowRoles: ['1438000000000009001'], history: true } }
    const yes = historyHarness({ policy, roleOf: { [OTHER]: ['1438000000000009001'] } })
    expect((await yes.run()).text).toContain('pista: idegen')
    expect(yes.memberFetches).toEqual([OTHER]) // OWNER is in allowFrom: no fetch
    const no = historyHarness({ policy })
    expect((await no.run()).text).not.toContain('idegen')
  })

  it('handleInbound: the block goes in front of the content, channel_history counts it; never for a recovered or edited message', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} }, OWNER, { history: { text: '[Recent channel messages]\nx\n[/Recent channel messages]\n\n', count: 1 } })
    await h.handleInbound(h.msg('@bot mi a helyzet?'))
    expect(h.notes[0]!.params.content).toBe('[Recent channel messages]\nx\n[/Recent channel messages]\n\n@bot mi a helyzet?')
    expect(h.notes[0]!.params.meta!.channel_history).toBe('1')
    for (const [recovered, edited] of [[true, false], [false, true]]) {
      const q = inboundHarness({ action: 'deliver', access: {} }, OWNER, { history: { text: 'X', count: 1 } })
      await q.handleInbound(q.msg('hi'), recovered, edited)
      expect(q.historyCalls).toEqual([])
      expect(q.notes[0]!.params.content).toBe('hi')
    }
  })
})

describe('D8: embed and select menu in reply', () => {
  it('embedSpec: Discord\'s limits checked up front; junk refused', () => {
    expect(ext.embedSpec(undefined)).toBeNull()
    expect(ext.embedSpec({ title: 'T', description: 'D', color: 0x00ff00, fields: [{ name: ' n ', value: 'v', inline: true }, { name: 'a', value: 'b', inline: 'yes' }] }))
      .toEqual({ title: 'T', description: 'D', color: 0x00ff00, fields: [{ name: 'n', value: 'v', inline: true }, { name: 'a', value: 'b' }] })
    for (const bad of [
      'x', [], {}, { title: 't'.repeat(257) }, { description: 'd'.repeat(4097) }, { title: 'T', color: -1 }, { title: 'T', color: 1.5 },
      { fields: Array.from({ length: 26 }, (_, i) => ({ name: `n${i}`, value: 'v' })) }, { fields: [{ name: 'n' }] },
      { fields: [{ name: 'n', value: 'v'.repeat(1025) }] }, { title: 't'.repeat(256), description: 'd'.repeat(4096), fields: [{ name: 'n'.repeat(256), value: 'v'.repeat(1024) }, { name: 'n'.repeat(256), value: 'v'.repeat(1024) }] },
    ]) expect(() => ext.embedSpec(bad), JSON.stringify(bad).slice(0, 80)).toThrow()
    expect(ext.EMBED_LIMITS).toEqual({ title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, total: 6000 })
  })

  it('selectSpec: values are indexes, labels unique, at most 25; selectedLabel trusts only the message\'s own options', () => {
    const s = ext.selectSpec({ placeholder: 'Válassz', options: [{ label: 'Alfa' }, { label: 'Béta', description: 'második' }] })
    expect(s).toEqual({ placeholder: 'Válassz', options: [{ label: 'Alfa', value: '0' }, { label: 'Béta', value: '1', description: 'második' }] })
    for (const bad of ['x', {}, { options: [] }, { options: [{ label: 'a' }, { label: 'a' }] }, { options: [{ label: '' }] }, { options: [{ label: 'l'.repeat(101) }] },
      { options: Array.from({ length: 26 }, (_, i) => ({ label: `o${i}` })) }, { options: [{ label: 'a' }], placeholder: 'p'.repeat(151) }]) {
      expect(() => ext.selectSpec(bad), JSON.stringify(bad).slice(0, 60)).toThrow()
    }
    expect(ext.selectedLabel(s.options, ['1'])).toBe('Béta')
    expect(ext.selectedLabel(s.options, ['Béta'])).toBeNull() // a label sent as a value is not an option
    expect(ext.selectedLabel(s.options, ['7'])).toBeNull()
    expect(ext.selectedLabel(s.options, ['0', '1'])).toBeNull()
    expect(ext.SELECT_CUSTOM_ID).toBe('select:choice')
    expect(ext.MAX_COMPONENT_ROWS).toBe(5)
  })

  it('wiring: both checked before the channel is even fetched; on the last chunk; buttons + select within 5 rows', () => {
    const reply = SERVER.slice(SERVER.indexOf("case 'reply': {"), SERVER.indexOf("case 'fetch_messages': {"))
    const fetchAt = reply.indexOf('const forum = await allowedForum(chat_id)')
    for (const s of ['const embed = embedSpec(args.embed)', 'const select = selectSpec(args.select)', 'if (rows.length + (select ? 1 : 0) > MAX_COMPONENT_ROWS)']) {
      expect(reply.indexOf(s), s).toBeGreaterThan(0)
      expect(reply.indexOf(s), s).toBeLessThan(fetchAt)
    }
    expect(reply).toContain('...(i === chunks.length - 1 && components.length > 0 ? { components } : {}),')
    expect(reply).toContain('...(i === chunks.length - 1 && embed ? { embeds: [embed] } : {}),')
    expect(reply).toContain('new StringSelectMenuBuilder().setCustomId(SELECT_CUSTOM_ID).addOptions(select.options)')
    expect(SERVER).toContain("...(interaction.isStringSelectMenu() ? { select: 'true' } : { button: 'true' }),")
  })
})

describe('G1: discord_info, read-only', () => {
  it('infoRequest: known actions only, their ids checked, the query capped', () => {
    expect(ext.infoRequest({ action: 'list_guilds' })).toEqual({ action: 'list_guilds' })
    expect(ext.infoRequest({ action: 'member_info', guild_id: id(1), user_id: OWNER })).toEqual({ action: 'member_info', guild_id: id(1), user_id: OWNER })
    expect(ext.infoRequest({ action: 'search_members', guild_id: id(1), query: `  ${'q'.repeat(150)} ` }).query).toBe('q'.repeat(100))
    for (const bad of [{}, { action: 'delete_message' }, { action: 'toString' }, { action: '__proto__' }, { action: 'server_info' }, { action: 'server_info', guild_id: 'abc' }, { action: 'list_pins', channel_id: '' }]) {
      expect(() => ext.infoRequest(bad), JSON.stringify(bad)).toThrow()
    }
    for (const proto of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(() => ext.infoRequest({ action: proto }), proto).toThrow('action must be one of') // refused as unknown, not by accident
    }
    expect(Object.keys(ext.INFO_ACTIONS)).toEqual(['list_guilds', 'server_info', 'list_channels', 'channel_info', 'list_roles', 'list_pins', 'member_info', 'search_members'])
  })

  it('oneLine folds and cuts; allowedGuildIds keeps real guild ids only', () => {
    expect(ext.oneLine('a\nb\r\nc', 200)).toBe('a ⏎ b ⏎ c')
    expect(ext.oneLine('x'.repeat(5), 3)).toBe('xxx…')
    expect(ext.oneLine(null)).toBe('')
    expect([...ext.allowedGuildIds(new Map([['c1', id(1)], ['c2', null], ['c3', id(1)], ['c4', 'junk']]))]).toEqual([id(1)])
  })

  function infoHarness(o: { memberFail?: boolean } = {}) {
    const G1 = id(1)
    const G2 = id(2)
    const guildFetches: string[] = []
    const searches: unknown[] = []
    const allowedChannelCalls: string[] = []
    const guild = (gid: string) => ({
      id: gid, name: `szerver\n${gid}`, memberCount: 3, ownerId: OWNER, createdAt: new Date(0), description: null,
      channels: { fetch: async () => new Map([['a', { id: '1438000000000000700', name: 'általános', type: 0, parentId: null, rawPosition: 1 }], ['b', { id: id(8), name: 'titkos\nsor', type: 0, parentId: null, rawPosition: 0 }]]) },
      roles: { fetch: async () => new Map([['r', { id: id(9), name: 'Avengers', position: 2, managed: false, mentionable: true }]]) },
      members: {
        fetch: async () => { if (o.memberFail) throw new Error('Missing Access'); return { id: OWNER, user: { username: 'zoli', bot: false }, displayName: 'Zoli', joinedAt: new Date(0), roles: { cache: new Map([[gid, { id: gid, name: '@everyone' }], ['r', { id: id(9), name: 'Avengers' }]]) } } },
        search: async (q: unknown) => { searches.push(q); return new Map() },
      },
    })
    const client = {
      channels: { fetch: async (cid: string) => (cid === '1438000000000000700' ? { guildId: G1 } : null) },
      guilds: { fetch: async (gid: string) => { guildFetches.push(gid); return guild(gid) } },
    }
    const fetchAllowedChannel = async (cid: string) => {
      allowedChannelCalls.push(cid)
      if (cid !== '1438000000000000700') throw new Error(`channel ${cid} is not allowlisted`)
      return { id: cid, type: 0, name: 'általános', topic: 'téma\nkét sor', messages: { fetchPins: async () => ({ items: [{ pinnedAt: new Date(0), message: { id: id(5), author: { username: 'zoli' }, content: 'kitűzve\nitt' } }] }) } }
    }
    const fns = new Function(
      'client', 'loadAccess', 'allowedGuildIds', 'oneLine', 'ChannelType', 'fetchAllowedChannel', 'SEARCH_MEMBERS_LIMIT',
      `${slice('// DCEXT1111 G1: discord_info', 'const mcp = new Server(')}\nreturn { discordInfo }`,
    )(client, () => ({ groups: { '1438000000000000700': { requireMention: true, allowFrom: [] } } }), ext.allowedGuildIds, ext.oneLine, { 0: 'GuildText' }, fetchAllowedChannel, ext.SEARCH_MEMBERS_LIMIT)
    const run = (a: Record<string, unknown>) => (fns.discordInfo as (r: unknown) => Promise<string>)(ext.infoRequest(a))
    return { run, guildFetches, searches, allowedChannelCalls, G1, G2 }
  }

  it('the overlay\'s discordInfo, run: only servers with an allowed channel; another server is refused before it is fetched', async () => {
    const h = infoHarness()
    expect(await h.run({ action: 'list_guilds' })).toBe(`szerver ⏎ ${h.G1} (id: ${h.G1}, members: 3)`)
    await expect(h.run({ action: 'server_info', guild_id: h.G2 })).rejects.toThrow('has no allowed channel')
    await expect(h.run({ action: 'member_info', guild_id: h.G2, user_id: OWNER })).rejects.toThrow('has no allowed channel')
    expect(h.guildFetches).toEqual([h.G1])
    const chans = await h.run({ action: 'list_channels', guild_id: h.G1 })
    expect(chans.split('\n')).toEqual([`titkos ⏎ sor (id: ${id(8)}, type: GuildText)`, 'általános (id: 1438000000000000700, type: GuildText, allowed)'])
    expect(await h.run({ action: 'list_roles', guild_id: h.G1 })).toBe(`Avengers (id: ${id(9)}, mentionable)`)
  })

  it('channel_info and list_pins go through the outbound allowlist; text is folded to one line', async () => {
    const h = infoHarness()
    expect(await h.run({ action: 'channel_info', channel_id: '1438000000000000700' })).toContain('topic: téma ⏎ két sor')
    expect(await h.run({ action: 'list_pins', channel_id: '1438000000000000700' })).toContain('zoli: kitűzve ⏎ itt')
    await expect(h.run({ action: 'list_pins', channel_id: id(8) })).rejects.toThrow('not allowlisted')
    expect(h.allowedChannelCalls).toEqual(['1438000000000000700', '1438000000000000700', id(8)])
  })

  it('members: REST lookups, search capped at 10, a refusal explained (privileged intent)', async () => {
    const h = infoHarness()
    expect(await h.run({ action: 'member_info', guild_id: h.G1, user_id: OWNER })).toContain('roles: Avengers')
    await h.run({ action: 'search_members', guild_id: h.G1, query: 'zo' })
    expect(h.searches).toEqual([{ query: 'zo', limit: 10 }])
    await expect(infoHarness({ memberFail: true }).run({ action: 'member_info', guild_id: id(1), user_id: OWNER })).rejects.toThrow('Server Members privileged intent')
  })

  it('wiring: listed, dispatched, and the info code calls nothing that writes', () => {
    expect(SERVER).toContain("name: 'discord_info',")
    expect(SERVER).toContain("return { content: [{ type: 'text', text: await discordInfo(infoRequest(args)) }] }")
    const info = SERVER.slice(SERVER.indexOf('// DCEXT1111 G1: discord_info'), SERVER.indexOf('const mcp = new Server('))
    expect(info).not.toMatch(/\.(send|edit|delete|pin|unpin|reply|update|create|add|remove|set[A-Z]\w*|ban|kick|bulkDelete)\(/)
  })
})

describe('A5: edits and deletes', () => {
  it('BoundedIds: a delete is reported once; at most 1000, oldest dropped', () => {
    const b = new ext.BoundedIds(3)
    for (const x of ['a', 'b', 'c', 'd']) b.add(x)
    expect(b.size).toBe(3)
    expect(b.take('a')).toBe(false)
    expect(b.take('d')).toBe(true)
    expect(b.take('d')).toBe(false)
    expect(ext.DELIVERED_MAX).toBe(1000)
    const big = new ext.BoundedIds()
    for (let i = 0; i < 1500; i++) big.add(String(i))
    expect(big.size).toBe(1000)
  })

  it('editWorthDelivering: a link preview (same text) is not an edit; unknown old text is not passed on', () => {
    expect(ext.editWorthDelivering('a', 'a')).toBe(false)
    expect(ext.editWorthDelivering('a', 'b')).toBe(true)
    expect(ext.editWorthDelivering(null, 'b')).toBe(false)
    expect(ext.editWorthDelivering(undefined, 'b')).toBe(false)
    expect(ext.editWorthDelivering('a', '')).toBe(true)
  })

  it('handleInbound, edited: marked edited="1", never pairs, never decides a permission; a delivered id is remembered', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    expect(await h.handleInbound(h.msg('javítva'), false, true)).toBe(true)
    expect(h.notes[0]!.params.meta).toMatchObject({ edited: '1' })
    expect(h.deliveredIds.take(id(77))).toBe(true)
    const pair = inboundHarness({ action: 'pair', code: 'abc123', isResend: false })
    await pair.handleInbound(pair.msg('hi'), false, true)
    expect(pair.replies).toEqual([])
    const perm = inboundHarness({ action: 'deliver', access: {} })
    await perm.handleInbound(perm.msg('yes abcde'), false, true)
    expect(perm.notes.map(n => n.method)).toEqual(['notifications/claude/channel'])
    const drop = inboundHarness({ action: 'drop' })
    await drop.handleInbound(drop.msg('x'))
    expect(drop.deliveredIds.size).toBe(0)
  })

  function listeners() {
    const on: Record<string, (...a: unknown[]) => void> = {}
    const inbound: Array<[string, boolean, boolean]> = []
    const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
    const deliveredIds = new ext.BoundedIds()
    new Function('client', 'editWorthDelivering', 'handleInbound', 'deliveredIds', 'mcp',
      slice('// DCEXT1111 A5: an edit goes through', '// recovered: delivered by'))(
      { on: (ev: string, fn: (...a: unknown[]) => void) => { on[ev] = fn } }, ext.editWorthDelivering,
      async (m: { id: string }, r: boolean, e: boolean) => { inbound.push([m.id, r, e]); return true }, deliveredIds,
      { notification: async (n: (typeof notes)[0]) => { notes.push(n) } })
    return { on, inbound, notes, deliveredIds }
  }
  const upd = (content: string, o: { bot?: boolean; partial?: boolean } = {}) => ({ id: id(7), content, partial: !!o.partial, author: { bot: !!o.bot } })

  it('messageUpdate, run: only a changed text, not a bot, not a partial, goes to handleInbound as edited', () => {
    const l = listeners()
    l.on.messageUpdate!({ content: 'a' }, upd('a'))
    l.on.messageUpdate!({ content: null }, upd('b'))
    l.on.messageUpdate!({ content: 'a' }, upd('b', { bot: true }))
    l.on.messageUpdate!({ content: 'a' }, upd('b', { partial: true }))
    expect(l.inbound).toEqual([])
    l.on.messageUpdate!({ content: 'a' }, upd('b'))
    expect(l.inbound).toEqual([[id(7), false, true]])
  })

  it('messageDelete, run: reported once, deleted="1", only for a message that reached the session', async () => {
    const l = listeners()
    l.on.messageDelete!({ id: id(8), channelId: 'c' })
    expect(l.notes).toEqual([])
    l.deliveredIds.add(id(7))
    l.on.messageDelete!({ id: id(7), channelId: 'c', author: { username: 'zoli', id: OWNER } })
    l.on.messageDelete!({ id: id(7), channelId: 'c', author: { username: 'zoli', id: OWNER } })
    await new Promise(r => setTimeout(r, 0))
    expect(l.notes).toHaveLength(1)
    expect(l.notes[0]!.params.content).toBe('(message deleted)')
    expect(l.notes[0]!.params.meta).toMatchObject({ chat_id: 'c', message_id: id(7), user_id: OWNER, deleted: '1' })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// PR4 (DCEXT1111 Hermes parity, terv.md 4. PR): C1, C2, C4, F1s-F3s, A6
// ---------------------------------------------------------------------------------------------------------------

describe('C1: auto-thread when the bot is addressed (off by default, per channel)', () => {
  const CH = '1438000000000000700'

  it('parseChannelPolicy: "autoThread": true alone is kept; anything but a literal true is not', () => {
    expect(ext.parseChannelPolicy({ [CH]: { autoThread: true } })).toEqual({ [CH]: { allowRoles: [], autoThread: true } })
    for (const v of ['true', 1, 'yes', null, {}]) expect(ext.parseChannelPolicy({ [CH]: { autoThread: v } }), String(v)).toEqual({})
    expect(ext.parseChannelPolicy({ [CH]: { history: true, autoThread: true } })).toEqual({ [CH]: { allowRoles: [], history: true, autoThread: true } })
  })

  it('autoThreadWanted: only opted in, only where the bot is addressed, only a live top-level message', () => {
    const base = { autoThread: true as const, requireMention: true, isDM: false, isThread: false, recovered: false, edited: false }
    expect(ext.autoThreadWanted(base)).toBe(true)
    for (const o of [{ autoThread: undefined }, { requireMention: false }, { isDM: true }, { isThread: true }, { recovered: true }, { edited: true }]) {
      expect(ext.autoThreadWanted({ ...base, ...o }), JSON.stringify(o)).toBe(false)
    }
  })

  it('autoThreadName: the first line without mentions, else the sender; one line, at most 100', () => {
    expect(ext.autoThreadName('<@123456789012345678> mi a helyzet a kanbannal?\nmásodik sor', 'zoli')).toBe('mi a helyzet a kanbannal?')
    expect(ext.autoThreadName('<@123456789012345678>', 'zoli')).toBe('zoli')
    expect(ext.autoThreadName('\n\n  <@&1438000000000000001>  \n  harmadik  ', 'zoli')).toBe('harmadik')
    expect([...ext.autoThreadName('á'.repeat(300), 'zoli')]).toHaveLength(100)
  })

  function autoHarness(o: { autoThread?: boolean; requireMention?: boolean; dm?: boolean; inThread?: boolean; fail?: boolean; existing?: { ownerId: string } }) {
    const started: string[] = []
    const replies: string[] = []
    const added: string[] = []
    const openAutoThread = new Function(
      'ChannelType', 'EXT', 'client', 'botThreads', 'autoThreadWanted', 'autoThreadName', 'AUTO_THREAD_FAILED_REPLY',
      `${slice('async function openAutoThread(', '// DCEXT1111 C4: an allowed forum')}\nreturn openAutoThread`,
    )(
      { DM: 1 }, { channelPolicy: o.autoThread === false ? {} : { [CH]: { allowRoles: [], autoThread: true } } }, { user: { id: 'bot' } },
      { add: (t: string) => added.push(t) }, ext.autoThreadWanted, ext.autoThreadName, ext.AUTO_THREAD_FAILED_REPLY,
    ) as AutoThreadFn
    const msg = {
      id: id(9), channelId: CH, content: '<@1438000000000000999> nézd meg a mérlegjegyet', author: { username: 'zoli' },
      channel: { type: o.dm ? 1 : 0, isThread: () => !!o.inThread },
      thread: o.existing ? { id: id(9), ownerId: o.existing.ownerId, sendTyping: async () => {} } : null,
      startThread: async ({ name }: { name: string }) => { started.push(name); if (o.fail) throw new Error('Missing Permissions'); return { id: id(9), sendTyping: async () => {} } },
      reply: async (t: string) => { replies.push(t) },
    }
    const access = { groups: { [CH]: { requireMention: o.requireMention ?? true, allowFrom: [] } } }
    return { run: (recovered = false, edited = false) => openAutoThread(msg, access, recovered, edited), started, replies, added }
  }

  it('openAutoThread, run: on -> a thread on the message, named from it, recorded as the bot\'s thread', async () => {
    const h = autoHarness({})
    const t = await h.run()
    expect(t && t.id).toBe(id(9))
    expect(h.started).toEqual(['nézd meg a mérlegjegyet'])
    expect(h.added).toEqual([id(9)])
    expect(h.replies).toEqual([])
  })

  it('openAutoThread, run: off, a listen-to-all channel, a DM, a thread, a recovered or an edited message -> no thread', async () => {
    for (const [o, r, e] of [[{ autoThread: false }, false, false], [{ requireMention: false }, false, false], [{ dm: true }, false, false], [{ inThread: true }, false, false], [{}, true, false], [{}, false, true]] as Array<[Parameters<typeof autoHarness>[0], boolean, boolean]>) {
      const h = autoHarness(o)
      expect(await h.run(r, e), JSON.stringify([o, r, e])).toBeNull()
      expect(h.started).toEqual([])
    }
  })

  it('openAutoThread, run: an edit of a message the bot already threaded goes to that thread, nothing new opened', async () => {
    const h = autoHarness({ existing: { ownerId: 'bot' } })
    expect((await h.run(false, true)) as { id: string }).toMatchObject({ id: id(9) })
    expect(h.started).toEqual([])
    const other = autoHarness({ existing: { ownerId: 'someone' } })
    expect(await other.run(false, true)).toBeNull() // a thread someone else opened is not ours
  })

  it('openAutoThread, run: a failed open -> one line to the channel, false (no turn)', async () => {
    const h = autoHarness({ fail: true })
    expect(await h.run()).toBe(false)
    expect(h.replies).toEqual([ext.AUTO_THREAD_FAILED_REPLY])
    expect(h.added).toEqual([])
  })

  it('handleInbound, run: the session gets the thread as chat_id, auto_thread="1", typing in the thread; a failed open delivers nothing', async () => {
    const typed: string[] = []
    const thread = { id: id(9), sendTyping: async () => { typed.push('thread') } }
    const h = inboundHarness({ action: 'deliver', access: {} }, OWNER, { openAutoThread: async () => thread })
    expect(await h.handleInbound(h.msg('szia', { dm: false }))).toBe(true)
    expect(h.notes[0]!.params.meta).toMatchObject({ chat_id: id(9), auto_thread: '1', message_id: id(77) })
    expect(h.typingStarts).toEqual([id(9)])
    expect(typed).toEqual(['thread'])
    const off = inboundHarness({ action: 'deliver', access: {} })
    await off.handleInbound(off.msg('szia', { dm: false }))
    expect(off.notes[0]!.params.meta!.chat_id).toBe('1438000000000000500')
    expect(off.notes[0]!.params.meta!.auto_thread).toBeUndefined()
    const failed = inboundHarness({ action: 'deliver', access: {} }, OWNER, { openAutoThread: async () => false })
    expect(await failed.handleInbound(failed.msg('szia', { dm: false }))).toBe(false)
    expect(failed.notes).toEqual([])
    expect(failed.typingStarts).toEqual([])
  })
})

describe('C2: rename_thread, only the bot\'s own thread', () => {
  it('mayRenameThread', () => {
    expect(ext.mayRenameThread({ isThread: true, ownerId: 'bot' }, 'bot')).toBe(true)
    expect(ext.mayRenameThread({ isThread: true, ownerId: 'zoli' }, 'bot')).toBe(false)
    expect(ext.mayRenameThread({ isThread: false, ownerId: 'bot' }, 'bot')).toBe(false)
    expect(ext.mayRenameThread({ isThread: true, ownerId: null }, undefined)).toBe(false)
  })

  it('wiring: listed, through the outbound allowlist, the owner checked before setName', () => {
    expect(SERVER).toContain("name: 'rename_thread', // MARVEEN-EXT")
    const c = SERVER.slice(SERVER.indexOf("case 'rename_thread': {"), SERVER.indexOf("case 'discord_info': {"))
    const at = (s: string) => { const i = c.indexOf(s); expect(i, s).toBeGreaterThan(0); return i }
    expect(at('const name = threadName(args.name)')).toBeLessThan(at('await fetchAllowedChannel(args.chat_id as string)'))
    expect(at('await fetchAllowedChannel(args.chat_id as string)')).toBeLessThan(at('mayRenameThread('))
    expect(at('mayRenameThread(')).toBeLessThan(at('await ch.setName(name)'))
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const replyHarnessRef: { fn: any } = { fn: null }

describe('C4: a reply to a forum channel opens a post', () => {
  it('forumPostTitle: the first non-empty line, markdown heading marks dropped, at most 100', () => {
    expect(ext.forumPostTitle('\n# Heti jelentés\n\nrészletek')).toBe('Heti jelentés')
    expect(ext.forumPostTitle('egy sor')).toBe('egy sor')
    expect([...ext.forumPostTitle('x'.repeat(250))]).toHaveLength(100)
    expect(ext.forumPostTitle('\n\n')).toBe('Poszt')
  })

  const FORUM = '1438000000000000800'
  function allowedForumFn(groups: Record<string, unknown>, ch: unknown) {
    return new Function('client', 'ChannelType', 'loadAccess', `${slice('async function allowedForum(', '// DCEXT1111 G1: discord_info')}\nreturn allowedForum`)(
      { channels: { fetch: async () => ch } }, { GuildForum: 15 }, () => ({ groups }),
    ) as (id: string) => Promise<unknown>
  }

  it('allowedForum, run: not a forum -> null (the normal path); a forum not allowed -> refused; an allowed forum -> it', async () => {
    expect(await allowedForumFn({ [FORUM]: {} }, { type: 0 })(FORUM)).toBeNull()
    expect(await allowedForumFn({ [FORUM]: {} }, null)(FORUM)).toBeNull()
    await expect(allowedForumFn({}, { type: 15 })(FORUM)).rejects.toThrow(/not allowlisted/)
    const f = { type: 15 }
    expect(await allowedForumFn({ [FORUM]: {} }, f)(FORUM)).toBe(f)
  })

  // The reply case itself, run with fakes: what goes to Discord, in which order.
  function replyHarness(o: { forum: boolean; text: string; files?: string[]; reply_to?: string; doneMarks?: unknown; failSend?: boolean }) {
    const calls: Array<{ op: string; arg: Record<string, unknown> }> = []
    const added: string[] = []
    const post = { id: id(50), send: async (p: Record<string, unknown>) => { calls.push({ op: 'post.send', arg: p }); return { id: id(51 + calls.length) } } }
    const forum = o.forum ? { threads: { create: async (a: Record<string, unknown>) => { calls.push({ op: 'threads.create', arg: a }); return post } } } : null
    const ch = { isThread: () => false, parentId: null, send: async (p: Record<string, unknown>) => { if (o.failSend) throw new Error('Missing Access'); calls.push({ op: 'ch.send', arg: p }); return { id: id(60 + calls.length) } } }
    const chunk = new Function(`${slice('function chunk(', 'async function fetchTextChannel(')}\nreturn chunk`)()
    const raw = SERVER.slice(SERVER.indexOf("case 'reply': {"), SERVER.indexOf("case 'fetch_messages': {"))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsc = require('typescript')
    const wrapped = tsc.transpileModule(`async function replyCase(args: any) { switch ('reply') { ${raw} } }`, { compilerOptions: { target: tsc.ScriptTarget.ES2022 } }).outputText
    const run = new Function(
      'buildButtonRows', 'embedSpec', 'selectSpec', 'MAX_COMPONENT_ROWS', 'StringSelectMenuBuilder', 'ActionRowBuilder', 'allowedForum',
      'fetchAllowedChannel', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES', 'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'MAX_REPLY_CHUNKS',
      'typingKeeper', 'forumPostTitle', 'noteSent', 'botThreads', 'doneMarks', 'DONE_REACTION',
      `${wrapped}\nreturn replyCase`,
    )(
      () => [], ext.embedSpec, ext.selectSpec, 5, class {}, class {}, async () => forum,
      async () => ch, () => {}, () => ({ size: 1 }), 25 * 1024 * 1024, () => ({ groups: {} }), 2000, chunk, 8,
      { stop: () => {} }, ext.forumPostTitle, () => {}, { add: (t: string) => added.push(t) }, o.doneMarks ?? new ext.DoneMarks(), ext.DONE_REACTION,
    ) as (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
    return { go: () => run({ chat_id: '1438000000000000800', text: o.text, files: o.files, reply_to: o.reply_to }), calls, added }
  }

  it('reply, run: on a forum the first part opens the post (title, files, no quote), the rest goes into it; recorded as the bot\'s thread', async () => {
    const h = replyHarness({ forum: true, text: 'Heti jelentés\n' + 'x'.repeat(2500), files: ['/tmp/a.png'], reply_to: id(3) })
    const r = await h.go()
    expect(h.calls.map(c => c.op)).toEqual(['threads.create', 'post.send'])
    const first = h.calls[0]!.arg as { name: string; message: Record<string, unknown> }
    expect(first.name).toBe('Heti jelentés')
    expect(first.message.files).toEqual(['/tmp/a.png'])
    expect(first.message.reply).toBeUndefined()
    expect(h.calls[1]!.arg.files).toBeUndefined()
    expect(h.added).toEqual([id(50)])
    expect(r.content[0]!.text).toContain(`the post is thread ${id(50)}`)
  })

  replyHarnessRef.fn = replyHarness

  it('reply, run: not a forum -> the channel path exactly as before (quote on the first part, no post)', async () => {
    const h = replyHarness({ forum: false, text: 'szia', reply_to: id(3) })
    const r = await h.go()
    expect(h.calls.map(c => c.op)).toEqual(['ch.send'])
    expect(h.calls[0]!.arg.reply).toEqual({ messageReference: id(3), failIfNotExists: false })
    expect(h.added).toEqual([])
    expect(r.content[0]!.text).toMatch(/^sent \(id: /)
  })
})

describe('F1s-F3s: slash commands -> the dashboard command hook', () => {
  it('parseSlashCommands: the menu as Discord takes it; junk, duplicates and bad names out; null without a list', () => {
    expect(ext.parseSlashCommands(undefined)).toBeNull()
    expect(ext.parseSlashCommands('x')).toBeNull()
    expect(ext.parseSlashCommands([])).toEqual([])
    const r = ext.parseSlashCommands([
      { name: 'status', description: 'rendszer-állapot' }, { name: 'status', description: 'dupla' }, { name: 'Bad Name', description: 'x' },
      { name: 'usage', description: 'u'.repeat(300) }, { name: 'help', description: '' }, null, { name: 7 },
    ])
    expect(r.map((c: { name: string }) => c.name)).toEqual(['status', 'usage', 'help'])
    expect([...r[1].description]).toHaveLength(100)
    expect(r[2].description).toBe('help')
    expect(ext.parseSlashCommands(Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, description: 'd' })))).toHaveLength(100)
  })

  it('slashPayload: bot DMs only (contexts [1]), one optional free-text option', () => {
    expect(ext.slashPayload([{ name: 'status', description: 'állapot' }])).toEqual([{
      name: 'status', description: 'állapot', type: 1, contexts: [1], integration_types: [0],
      options: [{ type: 3, name: 'args', description: 'argumentumok, pl. ? a súgóhoz', required: false }],
    }])
  })

  it('F3s: registered again only when the list or the application changed', () => {
    const p1 = ext.slashPayload([{ name: 'status', description: 'a' }])
    const p2 = ext.slashPayload([{ name: 'status', description: 'b' }])
    const fp = ext.slashFingerprint(p1, 'app1')
    expect(ext.slashFingerprint(p1, 'app1')).toBe(fp)
    expect(ext.slashFingerprint(p2, 'app1')).not.toBe(fp)
    expect(ext.slashFingerprint(p1, 'app2')).not.toBe(fp)
    expect(ext.slashSyncDue(null, fp)).toBe(true)
    expect(ext.slashSyncDue('{bad', fp)).toBe(true)
    expect(ext.slashSyncDue(JSON.stringify({ fingerprint: fp }), fp)).toBe(false)
    expect(ext.slashSyncDue(JSON.stringify({ fingerprint: 'old' }), fp)).toBe(true)
  })

  it('slashText: the same one-line text as typed on Telegram', () => {
    expect(ext.slashText('status', null)).toBe('/status')
    expect(ext.slashText('usage', '  3 \n nap ')).toBe('/usage 3 nap')
    expect(ext.slashText('board', '')).toBe('/board')
  })

  it('slashAllowed: the owner from the SETTING, paired, in a DM; never the sole-DM fallback, another user or a server', () => {
    expect(ext.slashAllowed({ id: OWNER, source: 'setting' }, OWNER, true)).toBe(true)
    expect(ext.slashAllowed({ id: OWNER, source: 'sole-dm' }, OWNER, true)).toBe(false)
    expect(ext.slashAllowed({ id: OWNER, source: 'setting' }, OTHER, true)).toBe(false)
    expect(ext.slashAllowed({ id: OWNER, source: 'setting' }, OWNER, false)).toBe(false)
    expect(ext.slashAllowed({ id: null, reason: 'x' }, OWNER, true)).toBe(false)
  })

  function slashHandler(o: { owner?: { id: string; source: string } | { id: null; reason: string }; dmPolicy?: string; commands?: Array<{ name: string; description: string }> | null } = {}) {
    let handler: ((i: unknown) => Promise<void>) | null = null
    const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
    const dmChannelUsers = new Map<string, string>()
    new Function(
      'client', 'EXT', 'loadAccess', 'slashAllowed', 'currentOwner', 'slashText', 'SLASH_ARGS_OPTION', 'dmChannelUsers', 'mcp',
      slice('// DCEXT1111 F1s/F2s: a slash command', '// DCEXT1111 F3s:'),
    )(
      { on: (ev: string, fn: (i: unknown) => Promise<void>) => { if (ev === 'interactionCreate') handler = fn } },
      { slashCommands: o.commands === undefined ? [{ name: 'status', description: 'x' }, { name: 'usage', description: 'y' }] : o.commands },
      () => ({ dmPolicy: o.dmPolicy ?? 'allowlist' }), ext.slashAllowed, () => o.owner ?? { id: OWNER, source: 'setting' }, ext.slashText, 'args',
      dmChannelUsers, { notification: async (n: (typeof notes)[0]) => { notes.push(n) } },
    )
    const replies: Array<Record<string, unknown>> = []
    const interaction = (name: string, user = OWNER, guildId: string | null = null, args: string | null = null) => ({
      isChatInputCommand: () => true, commandName: name, guildId, channelId: '1438000000000000500', id: id(88),
      user: { id: user, username: 'zoli' }, options: { getString: () => args },
      reply: async (r: Record<string, unknown>) => { replies.push(r) },
    })
    const lines: string[] = []
    const fire = async (i: unknown) => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true })
      try { await handler!(i) } finally { spy.mockRestore() }
    }
    return { fire, interaction, notes, replies, dmChannelUsers, lines }
  }

  it('the handler, run: the owner in a DM -> a private ack at once, the same /word text to the session, slash="1"', async () => {
    const h = slashHandler()
    await h.fire(h.interaction('usage', OWNER, null, '?'))
    expect(h.replies).toEqual([{ content: '↪ /usage ?', ephemeral: true }])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]!.params.content).toBe('/usage ?')
    expect(h.notes[0]!.params.meta).toEqual({ chat_id: '1438000000000000500', message_id: id(88), user: 'zoli', user_id: OWNER, ts: expect.any(String), slash: '1' })
    expect(h.dmChannelUsers.get('1438000000000000500')).toBe(OWNER)
  })

  it('the handler, run: another user, a server, the sole-DM owner, an unlisted command, inbound off -> "Not authorized.", nothing delivered, logged', async () => {
    for (const [o, args] of [
      [{}, ['status', OTHER, null]],
      [{}, ['status', OWNER, '1438000000000000001']],
      [{ owner: { id: OWNER, source: 'sole-dm' } }, ['status', OWNER, null]],
      [{}, ['model', OWNER, null]],
      [{ commands: null }, ['status', OWNER, null]],
      [{ dmPolicy: 'disabled' }, ['status', OWNER, null]],
    ] as Array<[Parameters<typeof slashHandler>[0], [string, string, string | null]]>) {
      const h = slashHandler(o)
      await h.fire(h.interaction(...args))
      expect(h.replies, JSON.stringify([o, args])).toEqual([{ content: 'Not authorized.', ephemeral: true }])
      expect(h.notes, JSON.stringify([o, args])).toEqual([])
      expect(h.lines.join(''), JSON.stringify([o, args])).toContain(`slash /${args[0]} from ${args[1]} refused`)
    }
  })

  it('the handler ignores everything that is not a slash command (buttons and selects have their own handlers)', async () => {
    const h = slashHandler()
    await h.fire({ isChatInputCommand: () => false })
    expect(h.replies).toEqual([])
    expect(h.notes).toEqual([])
  })

  function syncHarness(o: { owner?: string; commands?: Array<{ name: string; description: string }> | null }, stateDir: string) {
    const sets: unknown[] = []
    const sync = new Function(
      'join', 'STATE_DIR', 'EXT', 'client', 'slashPayload', 'slashFingerprint', 'readFileSync', 'slashSyncDue', 'writeFileSync', 'renameSync',
      `${slice('// DCEXT1111 F3s:', "client.once('ready'")}\nreturn syncSlashCommands`,
    )(
      join, stateDir, { ownerUserId: o.owner ?? OWNER, slashCommands: o.commands === undefined ? [{ name: 'status', description: 'x' }] : o.commands },
      { application: { id: 'app1', commands: { set: async (p: unknown) => { sets.push(p) } } } },
      ext.slashPayload, ext.slashFingerprint, readFileSync, ext.slashSyncDue, writeFileSync, require('node:fs').renameSync,
    ) as () => Promise<void>
    return { sync, sets }
  }

  it('syncSlashCommands, run: once, then not again until the list changes; nothing without an owner or a list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-slash-'))
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const a = syncHarness({}, dir)
      await a.sync()
      expect(a.sets).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(dir, 'slash-sync.json'), 'utf-8'))).toMatchObject({ count: 1, fingerprint: expect.any(String) })
      const b = syncHarness({}, dir)
      await b.sync()
      expect(b.sets).toEqual([]) // a restart with the same list: no REST call
      const c = syncHarness({ commands: [{ name: 'status', description: 'x' }, { name: 'help', description: 'h' }] }, dir)
      await c.sync()
      expect(c.sets).toHaveLength(1)
      for (const o of [{ owner: '' }, { commands: null }, { commands: [] }]) {
        const d = syncHarness(o, mkdtempSync(join(tmpdir(), 'dc-slash-none-')))
        await d.sync()
        expect(d.sets, JSON.stringify(o)).toEqual([])
      }
    } finally {
      quiet.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wiring: synced at ready; the handler sits outside the button handler\'s region', () => {
    expect(SERVER).toContain('void syncSlashCommands().catch(')
    const buttons = SERVER.slice(SERVER.indexOf('const BUTTON_STYLES'), SERVER.indexOf("client.on('messageCreate'"))
    expect(buttons).not.toContain('isChatInputCommand')
  })
})

describe('A6: the bot\'s threads are recovered too, with the same time-lock and caps', () => {
  it('threadRecoveryTargets: only threads with a cursor, the most recently delivered first, at most 20', () => {
    const cursor: Record<string, string> = {}
    const ids = Array.from({ length: 45 }, (_, i) => id(100 + i)) // 30 of them with a cursor: more than the cap
    ids.forEach((t, i) => { if (i % 3 !== 0) cursor[t] = id(1000 + i) })
    const r = ext.threadRecoveryTargets(ids, cursor)
    expect(r).toHaveLength(ext.THREAD_RECOVERY_MAX)
    expect(ext.THREAD_RECOVERY_MAX).toBe(20)
    expect(r[0]).toBe(id(144)) // newest cursor
    expect(r.every((t: string) => cursor[t] !== undefined)).toBe(true)
    expect(ext.threadRecoveryTargets([id(5)], {})).toEqual([])
  })

  it('BotThreads.ids: live ones only', () => {
    let now = 1_800_000_000_000
    const b = new ext.BotThreads({ [id(1)]: now - ext.BOT_THREADS.ttlMs - 1, [id(2)]: now }, () => {}, () => now)
    expect(b.ids()).toEqual([id(2)])
    now += ext.BOT_THREADS.ttlMs + 1
    expect(b.ids()).toEqual([])
  })

  it('handleInbound, run: a message in the bot\'s thread moves its cursor; in another thread it does not', async () => {
    for (const [ours, want] of [[true, 1], [false, 0]] as Array<[boolean, number]>) {
      const h = inboundHarness({ action: 'deliver', access: {} }, OWNER, { inBotThread: () => ours })
      const m = h.msg('szia', { dm: false }) as { channel: { isThread: () => boolean } }
      m.channel.isThread = () => true
      await h.handleInbound(m)
      expect(h.cursorNotes, String(ours)).toHaveLength(want)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// PR5 (DCEXT1111, terv.md 5. PR, Zoli 2026-11-11 12:52): A9 bot-to-bot on an explicit mention only, G2 pin/unpin
// ---------------------------------------------------------------------------------------------------------------

describe('A9: another bot\'s message, only on an explicit mention, within the loop guard', () => {
  const SELF = '1438000000000000999'
  const BOT = '1438000000000000777'
  const CH = '1438000000000000700'
  const ROLE = '1438000000000009001'

  it('explicitlyAddressed: <@id> or <@!id> in the text only; @everyone, @here, a role, someone else are not', () => {
    expect(ext.explicitlyAddressed(`<@${SELF}> nézd meg`, SELF)).toBe(true)
    expect(ext.explicitlyAddressed(`hé <@!${SELF}>`, SELF)).toBe(true)
    for (const t of ['@everyone nézd', '@here', `<@&${ROLE}>`, `<@${BOT}>`, 'heimdall, nézd meg', '']) expect(ext.explicitlyAddressed(t, SELF), t).toBe(false)
    expect(ext.explicitlyAddressed(`<@${SELF}>`, undefined)).toBe(false)
  })

  it('botSenderAllowed: named in allowFrom or holding a channel role; an empty allowFrom never lets a bot in', () => {
    expect(ext.botSenderAllowed([BOT], undefined, BOT, [])).toBe(true)
    expect(ext.botSenderAllowed([], [ROLE], BOT, [ROLE])).toBe(true)
    expect(ext.botSenderAllowed([], undefined, BOT, [])).toBe(false) // humans: anyone; bots: nobody
    expect(ext.botSenderAllowed([OWNER], [ROLE], BOT, [])).toBe(false)
  })

  it('the loop constants are pinned', () => {
    expect(ext.BOT_LOOP).toEqual({ cooldownMs: 30_000, maxPerWindow: 3, windowMs: 600_000 })
  })

  it('BotLoopGuard: 30 s cooldown, 3 per 10 min, per channel; one log line per over-limit stretch', () => {
    const logs: string[] = []
    const g = new ext.BotLoopGuard((m: string) => logs.push(m))
    const t0 = 1_800_000_000_000
    expect(g.allow(CH, t0)).toBe(true)
    expect(g.allow(CH, t0 + 29_999)).toBe(false) // cooldown
    expect(g.allow('1438000000000000701', t0 + 1)).toBe(true) // another channel is its own
    expect(g.allow(CH, t0 + 30_000)).toBe(true)
    expect(g.allow(CH, t0 + 60_000)).toBe(true)
    expect(g.allow(CH, t0 + 90_000)).toBe(false) // 4th in the window
    expect(g.allow(CH, t0 + 300_000)).toBe(false)
    expect(logs).toHaveLength(1)
    expect(g.allow(CH, t0 + 600_001)).toBe(true) // the first left the window
  })

  it('loop simulation: two bots name each other every second for a minute -> at most 3 deliveries per channel', () => {
    const g = new ext.BotLoopGuard()
    const t0 = 1_800_000_000_000
    let delivered = 0
    for (let s = 0; s < 60; s++) for (const _ of [0, 1]) if (g.allow(CH, t0 + s * 1000)) delivered++
    expect(delivered).toBeLessThanOrEqual(ext.BOT_LOOP.maxPerWindow)
    // and for an hour: at most 3 per 10 minutes
    const h = new ext.BotLoopGuard()
    let hour = 0
    for (let s = 0; s < 3600; s++) if (h.allow(CH, t0 + s * 1000)) hour++
    expect(hour).toBeLessThanOrEqual(6 * ext.BOT_LOOP.maxPerWindow)
  })

  function botGate(o: { groups?: Record<string, { allowFrom?: string[] }>; policy?: Record<string, { allowRoles: string[] }> } = {}) {
    const guard = new ext.BotLoopGuard()
    const fn = new Function(
      'client', 'ChannelType', 'explicitlyAddressed', 'loadAccess', 'botSenderAllowed', 'EXT', 'memberRoleIds', 'botLoop',
      `${slice('function botMessageMayPass(', '// DCEXT1111 F1s/F2s:')}\nreturn botMessageMayPass`,
    )(
      { user: { id: SELF } }, { DM: 1 }, ext.explicitlyAddressed, () => ({ groups: o.groups ?? { [CH]: { allowFrom: [OWNER, BOT] } } }),
      ext.botSenderAllowed, { channelPolicy: o.policy ?? {} }, (m: { roles?: string[] } | null) => m?.roles ?? [], guard,
    ) as (m: unknown) => boolean
    // replyToUs: Discord puts the replied-to author (us) into the mention list although the text names nobody.
    const msg = (content: string, x: { author?: string; dm?: boolean; channel?: string; roles?: string[]; thread?: string; replyToUs?: boolean } = {}) => ({
      author: { id: x.author ?? BOT, bot: true }, content, guild: x.dm ? null : {}, channelId: x.thread ?? x.channel ?? CH,
      mentions: { users: new Map(x.replyToUs ? [[SELF, {}]] : []), everyone: false },
      reference: x.replyToUs ? { messageId: id(3) } : undefined,
      member: x.roles ? { roles: x.roles } : null,
      channel: { type: x.dm ? 1 : 0, isThread: () => !!x.thread, parentId: x.thread ? (x.channel ?? CH) : null },
    })
    return { pass: fn, msg }
  }

  it('the overlay\'s gate, run: a listed bot naming us passes; not named, not listed, in a DM, our own, an unlisted channel do not', () => {
    const g = botGate()
    expect(g.pass(g.msg(`<@${SELF}> kész a mentés`))).toBe(true)
    const h = botGate()
    for (const [m, why] of [
      [h.msg('@everyone kész'), 'everyone'],
      [h.msg(`<@&${ROLE}> kész`), 'role'],
      [h.msg('kész a mentés', { replyToUs: true }), 'a reply to our message (we are in the mention list, not in the text)'],
      [h.msg(`<@${SELF}> x`, { author: '1438000000000000555' }), 'unlisted bot'],
      [h.msg(`<@${SELF}> x`, { dm: true }), 'DM'],
      [h.msg(`<@${SELF}> x`, { author: SELF }), 'self'],
      [h.msg(`<@${SELF}> x`, { channel: '1438000000000000701' }), 'channel not allowed'],
    ] as Array<[unknown, string]>) expect(h.pass(m), why).toBe(false)
  })

  it('the overlay\'s gate, run: a channel role lets a bot in; an empty allowFrom does not; a thread counts with its parent', () => {
    const r = botGate({ groups: { [CH]: { allowFrom: [] } }, policy: { [CH]: { allowRoles: [ROLE] } } })
    expect(r.pass(r.msg(`<@${SELF}> x`, { roles: [ROLE] }))).toBe(true)
    const e = botGate({ groups: { [CH]: { allowFrom: [] } } })
    expect(e.pass(e.msg(`<@${SELF}> x`))).toBe(false)
    const t = botGate()
    expect(t.pass(t.msg(`<@${SELF}> x`, { thread: '1438000000000000800' }))).toBe(true)
    expect(t.pass(t.msg(`<@${SELF}> y`))).toBe(false) // same parent channel: the cooldown holds across the thread
  })

  it('wiring: messageCreate drops a bot unless the gate passes; the meta says is_bot="1"; edits and recovery still skip bots', () => {
    expect(SERVER).toContain('  if (msg.author.bot && !botMessageMayPass(msg)) return // DCEXT1111 A9 // MARVEEN-EXT')
    expect(SERVER).not.toMatch(/^  if \(msg\.author\.bot\) return$/m)
    expect(SERVER).toContain("...(msg.author.bot ? { is_bot: '1' } : {}),")
    expect(SERVER).toContain('if (msg.partial || msg.author.bot || !editWorthDelivering(old.content, msg.content)) return')
    expect(ext.selectRecovered([{ id: id(30), createdTimestamp: 1, authorId: BOT, authorBot: true }], { cursorId: id(1), cutoffMs: 2, nowMs: 2, selfId: SELF }).take).toEqual([])
  })

  it('handleInbound, run: a bot\'s message is marked is_bot="1", a human\'s is not', async () => {
    const h = inboundHarness({ action: 'deliver', access: {} })
    const m = h.msg(`<@${SELF}> kész`, { dm: false }) as { author: { bot?: boolean } }
    m.author.bot = true
    await h.handleInbound(m)
    expect(h.notes[0]!.params.meta!.is_bot).toBe('1')
    const human = inboundHarness({ action: 'deliver', access: {} })
    await human.handleInbound(human.msg('szia', { dm: false }))
    expect(human.notes[0]!.params.meta!.is_bot).toBeUndefined()
  })
})

describe('G2: pin_message / unpin_message, only with DISCORD_ADMIN_ACTIONS=pin', () => {
  it('parseAdminActions: only "pin"; anything else is dropped', () => {
    expect(ext.parseAdminActions(['pin'])).toEqual(['pin'])
    expect(ext.parseAdminActions(['pin', 'delete', 'roles'])).toEqual(['pin'])
    expect(ext.parseAdminActions('pin')).toEqual([])
    expect(ext.parseAdminActions(undefined)).toEqual([])
    expect(ext.ADMIN_ACTIONS).toEqual(['pin'])
  })

  it('without the key the tools are not listed at all; with it, exactly pin and unpin', () => {
    expect(ext.adminTools([])).toEqual([])
    expect(ext.adminTools(['pin']).map((t: { name: string }) => t.name)).toEqual(['pin_message', 'unpin_message'])
    expect(SERVER).toContain('...adminTools(EXT.adminActions),')
  })

  function pinCase(adminActions: string[], allowed = true) {
    const calls: string[] = []
    const raw = SERVER.slice(SERVER.indexOf("      case 'pin_message': // MARVEEN-EXT"), SERVER.indexOf("      case 'discord_info': { // MARVEEN-EXT"))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsc = require('typescript')
    const js = tsc.transpileModule(`async function call(req: any, args: any) { switch (req.params.name) { ${raw} } }`, { compilerOptions: { target: tsc.ScriptTarget.ES2022 } }).outputText
    const call = new Function('EXT', 'fetchAllowedChannel', `${js}\nreturn call`)(
      { adminActions },
      async (cid: string) => {
        if (!allowed) throw new Error(`channel ${cid} is not allowlisted`)
        return { messages: { fetch: async (mid: string) => ({ id: mid, pin: async () => { calls.push(`pin ${mid}`) }, unpin: async () => { calls.push(`unpin ${mid}`) } }) } }
      },
    ) as (req: unknown, args: unknown) => Promise<{ content: Array<{ text: string }> }>
    return { run: (name: string) => call({ params: { name } }, { chat_id: '1438000000000000700', message_id: id(5) }), calls }
  }

  it('the tool cases, run: switched on -> pin/unpin through the outbound allowlist; off or a not allowed channel -> refused, nothing done', async () => {
    const on = pinCase(['pin'])
    expect((await on.run('pin_message')).content[0]!.text).toBe(`pinned (id: ${id(5)})`)
    expect((await on.run('unpin_message')).content[0]!.text).toBe(`unpinned (id: ${id(5)})`)
    expect(on.calls).toEqual([`pin ${id(5)}`, `unpin ${id(5)}`])
    const off = pinCase([])
    await expect(off.run('pin_message')).rejects.toThrow(/not switched on/)
    expect(off.calls).toEqual([])
    const closed = pinCase(['pin'], false)
    await expect(closed.run('pin_message')).rejects.toThrow(/not allowlisted/)
    expect(closed.calls).toEqual([])
  })

  it('inventory: the overlay makes no deleting and no role-changing Discord call', () => {
    expect(SERVER).not.toMatch(/\broles\.(add|remove|set)\(/)
    expect(SERVER).not.toMatch(/\bbulkDelete\(|\.setPermissions\(|\.kick\(|\.ban\(/)
    // every .delete( in the file is on one of our own Maps/Sets, never on a message, channel or thread
    const receivers = [...SERVER.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.delete\(/g)].map(m => m[1])
    const OURS = new Set(['recentSentIds', 'pendingPermissions', 'permissionMessages', 'liveDelivered', 'answeredChoices', 'decidedPermissions', 'pending', 'running', 'seen', 'reported', 'ids', 'dmChannelUsers'])
    expect(receivers.filter(r => !OURS.has(r!))).toEqual([])
    expect(SERVER).not.toMatch(/delete_message|add_role|remove_role/)
  })
})

describe('D4: the "done" mark next to the ack', () => {
  it('DoneMarks: per chat the last acked message, taken once; bounded', () => {
    const d = new ext.DoneMarks(2)
    d.note('a', 'm1'); d.note('a', 'm2'); d.note('b', 'm3')
    expect(d.take('a')).toBe('m2')
    expect(d.take('a')).toBeUndefined()
    d.note('c', 'm4'); d.note('d', 'm5') // b dropped as the oldest
    expect(d.take('b')).toBeUndefined()
    expect(ext.DONE_REACTION).toBe('✅')
  })

  it('handleInbound, run: with an ack reaction the message is noted for its chat; without one nothing is', async () => {
    const marks = new ext.DoneMarks()
    const h = inboundHarness({ action: 'deliver', access: { ackReaction: '👀' } }, OWNER, { doneMarks: marks })
    const m = h.msg('szia')
    await h.handleInbound(m)
    expect(marks.take('1438000000000000500')).toBe(m)
    const none = new ext.DoneMarks()
    const q = inboundHarness({ action: 'deliver', access: {} }, OWNER, { doneMarks: none })
    await q.handleInbound(q.msg('szia'))
    expect(none.take('1438000000000000500')).toBeUndefined()
  })

  it('reply, run: after the reply went out the noted message gets ✅, once; a failed reply marks nothing', async () => {
    const reacted: string[] = []
    const marks = new ext.DoneMarks()
    marks.note('1438000000000000800', { react: async (e: string) => { reacted.push(e) } })
    const h = replyHarnessRef.fn({ forum: false, text: 'kész', doneMarks: marks })
    await h.go()
    expect(reacted).toEqual(['✅'])
    await replyHarnessRef.fn({ forum: false, text: 'még egy', doneMarks: marks }).go()
    expect(reacted).toEqual(['✅'])
    const failed = new ext.DoneMarks()
    failed.note('1438000000000000800', { react: async (e: string) => { reacted.push(`fail-${e}`) } })
    await expect(replyHarnessRef.fn({ forum: false, text: 'x', doneMarks: failed, failSend: true }).go()).rejects.toThrow()
    expect(reacted).toEqual(['✅'])
  })
})

describe('D5: edit_message over 2000 characters', () => {
  function editHarness(o: { textChunkLimit?: number } = {}) {
    const calls: Array<{ op: string; arg: unknown }> = []
    const raw = SERVER.slice(SERVER.indexOf("      case 'edit_message': {"), SERVER.indexOf("      case 'download_attachment': {"))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsc = require('typescript')
    const js = tsc.transpileModule(`async function call(args: any) { switch ('edit_message') { ${raw} } }`, { compilerOptions: { target: tsc.ScriptTarget.ES2022 } }).outputText
    const chunk = new Function(`${slice('function chunk(', 'async function fetchTextChannel(')}\nreturn chunk`)()
    const ch = {
      send: async (p: { content: string }) => { calls.push({ op: 'send', arg: p.content.length }); return { id: id(90 + calls.length) } },
      messages: { fetch: async (mid: string) => ({ id: mid, edit: async (t: string) => { calls.push({ op: 'edit', arg: t.length }); return { id: mid } } }) },
    }
    const call = new Function('fetchAllowedChannel', 'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'MAX_REPLY_CHUNKS', 'noteSent', `${js}\nreturn call`)(
      async () => ch, () => ({ textChunkLimit: o.textChunkLimit }), 2000, chunk, 8, () => {},
    ) as (a: unknown) => Promise<{ content: Array<{ text: string }> }>
    return { run: (text: string) => call({ chat_id: '1438000000000000500', message_id: id(5), text }), calls }
  }

  it('the case, run: 2500 characters -> the edit takes the first 2000, the rest is one new message after it', async () => {
    const h = editHarness()
    const r = await h.run('x'.repeat(2500))
    expect(h.calls).toEqual([{ op: 'edit', arg: 2000 }, { op: 'send', arg: 500 }])
    expect(r.content[0]!.text).toMatch(/^edited \(id: \d+\), the rest in 1 new message\(s\)/)
  })

  it('the case, run: a short edit is one edit, as before; more than 8 parts is refused before anything changes', async () => {
    const short = editHarness()
    expect((await short.run('rövid')).content[0]!.text).toBe(`edited (id: ${id(5)})`)
    expect(short.calls).toEqual([{ op: 'edit', arg: 5 }])
    const long = editHarness()
    await expect(long.run('y'.repeat(2000 * 8 + 1))).rejects.toThrow(/9 messages \(max 8\): nothing changed/)
    expect(long.calls).toEqual([])
  })
})
