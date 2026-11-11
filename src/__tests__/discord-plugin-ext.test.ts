// DCEXT1111: Marveen's additions to the Discord plugin (vendor/discord-plugin/<ver>/overlay). The logic in
// marveen-ext.ts runs here directly; the wiring in the overlay's server.ts is checked on its text, against the
// verbatim upstream file next to it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
    expect(SERVER).toContain("if (permMatch && mayDecidePermission(currentOwner(), msg.author.id, msg.channel.type === ChannelType.DM)) {")
    expect(SERVER).not.toMatch(/^\s*if \(permMatch\) \{/m)
  })

  it('a decided request cannot be decided again, and a typed decision takes the buttons away', () => {
    expect(SERVER).toMatch(/if \(behavior !== 'more' && decidedPermissions\.has\(request_id!\)\) \{[^]*?Already answered\./)
    expect(SERVER).toMatch(/if \(!decidedPermissions\.has\(request_id\)\) \{[^]*?decidedPermissions\.add\(request_id\)[^]*?prompt\.edit\(\{[^\n]*components: \[\] \}\)/)
  })

  it('the outbound gate asks the resolver for a DM it has not seen; the paired DMs are warmed at ready', () => {
    expect(SERVER).toContain('const userId = ch.recipientId ?? dmChannelUsers.get(id) ?? (await dmResolver.resolve(id, access.allowFrom))')
    const ready = SERVER.slice(SERVER.indexOf("client.once('ready'"), SERVER.indexOf('client.login(TOKEN)'))
    expect(ready).toContain('void dmResolver.warm(loadAccess().allowFrom)')
  })
})
