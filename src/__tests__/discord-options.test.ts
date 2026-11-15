// /options (owner request 2026-11-15): the Discord channel's switches, read-only, Discord only.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discordOptionsText, readDiscordAccess, OPTIONS_DISCORD_ONLY_REPLY, type OptionsDeps, type SettingRead } from '../web/discord-options.js'
import { clearCommandsForTest, dispatchCommand, renderHelp, botCommandList } from '../web/commands.js'
import { registerBuiltinCommands } from '../web/builtin-commands.js'

const USER_A = '290903699524550656'
const USER_B = '791682069566455859'
const ROLE = '1438000000000009001'
const CH1 = '1509116773574643754'
const CH2 = '1524378048051544214'

function deps(access: OptionsDeps['readAccess'] extends () => infer R ? R : never, settings: Record<string, SettingRead>): OptionsDeps {
  return { readAccess: () => access, setting: k => (k in settings ? settings[k]! : null) }
}

const LIVE_LIKE = deps(
  { state: 'ok', access: { dmPolicy: 'allowlist', allowFrom: [USER_A, USER_B], groups: { [CH1]: { requireMention: true, allowFrom: [USER_A, USER_B] }, [CH2]: { allowFrom: [] } }, pending: {} } },
  {
    DISCORD_PLUGIN_EXT: { value: '1', source: 'default' },
    DISCORD_OWNER_USER_ID: { value: USER_A, source: 'override' },
    DISCORD_ADMIN_ACTIONS: { value: '', source: 'default' },
    DISCORD_CHANNEL_POLICY: { value: JSON.stringify({ [CH1]: { history: true, allowRoles: [ROLE] }, [CH2]: { autoThread: true } }), source: 'override' },
  },
)

describe('discordOptionsText', () => {
  it('lists both sources with their values, defaults marked "(alap)", and where each is set', () => {
    expect(discordOptionsText(LIVE_LIKE)).toBe([
      'Discord-kapcsolók',
      '',
      'Discord plugin (access.json) · állítás: terminál, /discord:access set <kulcs> <érték>',
      'dmPolicy: allowlist',
      'ackReaction: nincs (alap)',
      'replyToMode: first (alap)',
      'textChunkLimit: 2000 (alap)',
      'chunkMode: length (alap)',
      'mentionPatterns: nincs (alap)',
      'csatornák: 2',
      `  · ${CH1}: megszólítás kell igen, allowFrom 2 fő`,
      `  · ${CH2}: megszólítás kell igen (alap), allowFrom 0 fő`,
      '',
      'Marveen-bővítés · állítás: dashboard, Beállítások, Csatornák',
      'DISCORD_PLUGIN_EXT: be (alap)',
      'DISCORD_OWNER_USER_ID: beállítva',
      'DISCORD_ADMIN_ACTIONS: nincs (alap)',
      'DISCORD_CHANNEL_POLICY: 2 csatorna',
      `  · ${CH1}: history be, autoThread ki, allowRoles 1`,
      `  · ${CH2}: history ki, autoThread be, allowRoles 0`,
    ].join('\n'))
  })

  it('no person or role id, ever: counts only', () => {
    const t = discordOptionsText(LIVE_LIKE)
    for (const id of [USER_A, USER_B, ROLE]) expect(t).not.toContain(id)
  })

  it('set values are shown as set (no "(alap)"); a non-default switch reads off; pin shows', () => {
    const t = discordOptionsText(deps(
      { state: 'ok', access: { dmPolicy: 'pairing', ackReaction: '👀', replyToMode: 'all', textChunkLimit: 1500, chunkMode: 'newline', mentionPatterns: ['heimdall', 'hd'], groups: { [CH1]: { requireMention: false, allowFrom: [] } } } },
      { DISCORD_PLUGIN_EXT: { value: '0', source: 'override' }, DISCORD_OWNER_USER_ID: { value: '', source: 'default' }, DISCORD_ADMIN_ACTIONS: { value: 'pin', source: 'override' }, DISCORD_CHANNEL_POLICY: { value: '', source: 'default' } },
    ))
    for (const line of ['ackReaction: 👀', 'replyToMode: all', 'textChunkLimit: 1500', 'chunkMode: newline', 'mentionPatterns: 2 minta',
      `  · ${CH1}: megszólítás kell nem, allowFrom 0 fő`, 'DISCORD_PLUGIN_EXT: ki', 'DISCORD_OWNER_USER_ID: nincs beállítva (alap)',
      'DISCORD_ADMIN_ACTIONS: pin', 'DISCORD_CHANNEL_POLICY: nincs (alap)']) expect(t).toContain(line)
  })

  it('no access.json, an unreadable one, a key this version does not know, a broken policy: said, never thrown', () => {
    const t = discordOptionsText(deps({ state: 'missing' }, { DISCORD_CHANNEL_POLICY: { value: '{ bad', source: 'override' } }))
    expect(t).toContain('nincs access.json')
    expect(t).toContain('DISCORD_ADMIN_ACTIONS: ez a verzió még nem ismeri')
    expect(t).toContain('hibás JSON')
    expect(discordOptionsText(deps({ state: 'unreadable' }, {}))).toContain('az access.json nem olvasható')
  })

  it('readDiscordAccess: the file in the state dir; missing and broken are told apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-options-'))
    try {
      expect(readDiscordAccess(dir)).toEqual({ state: 'missing' })
      writeFileSync(join(dir, 'access.json'), '{ bad')
      expect(readDiscordAccess(dir)).toEqual({ state: 'unreadable' })
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist' }))
      expect(readDiscordAccess(dir)).toEqual({ state: 'ok', access: { dmPolicy: 'allowlist' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('/options, the command', () => {
  afterEach(() => clearCommandsForTest())

  it('from Discord: the options; from anywhere else: one line; in /help and in the menu the slash list is built from', async () => {
    clearCommandsForTest()
    registerBuiltinCommands()
    const out: string[] = []
    expect(await dispatchCommand('/options', { reply: async t => { out.push(t) }, ownerId: 1, now: Date.now(), channel: 'discord' })).toBe('ran')
    expect(out[0]).toMatch(/^Discord-kapcsolók\n/)
    const tg: string[] = []
    await dispatchCommand('/options', { reply: async t => { tg.push(t) }, ownerId: 1, now: Date.now() })
    expect(tg).toEqual([OPTIONS_DISCORD_ONLY_REPLY])
    expect(renderHelp()).toContain('/options')
    expect(botCommandList().map(c => c.command)).toContain('options')
  })
})
