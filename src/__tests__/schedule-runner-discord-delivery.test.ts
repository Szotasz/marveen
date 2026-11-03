// #2390 (part 2): on Discord a scheduled task's delivery target must be a CHANNEL id. The
// access.json allowFrom entries are USER ids, and the Discord plugin's reply fails on a user
// id with "Unknown Channel" (its outbound gate fetches the id as a channel). Reported on a
// Discord install (2026-10-31): a main-agent task with one allowFrom entry and no pin was
// prefixed with that user id as chat_id. These tests pin what is resolved from disk.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = {
  tmpRoot: mkdtempSync(join(tmpdir(), 'discord-delivery-')),
  provider: 'discord' as 'telegram' | 'slack' | 'discord',
}

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, agentDir: (name: string) => join(h.tmpRoot, 'agents', name) }
})
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...real, resolveAgentProvider: () => h.provider }
})

const { resolveBoundChannel, resolveTaskChannelTarget, discordBoundChannelFromAccess, discordNoChannelNotice } =
  await import('../web/schedule-runner.js')
const { MAIN_AGENT_ID } = await import('../config.js')

const USER_ID = '111111111111111111' // a Discord user (snowflake) id
const GUILD_CHANNEL = '222222222222222222'
const AGENT = 'zara'

function writeAgentAccess(provider: string, body: unknown): void {
  const dir = join(h.tmpRoot, 'agents', AGENT, '.claude', 'channels', provider)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'access.json'), JSON.stringify(body))
}

const savedStateDir = process.env.DISCORD_STATE_DIR
beforeEach(() => {
  rmSync(join(h.tmpRoot, 'agents'), { recursive: true, force: true })
  h.provider = 'discord'
})
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})
afterAll(() => rmSync(h.tmpRoot, { recursive: true, force: true }))

describe('discordBoundChannelFromAccess (pure)', () => {
  it('a user id alone is not a target: no chat id, flagged', () => {
    expect(discordBoundChannelFromAccess({ allowFrom: [USER_ID] })).toEqual({ chatId: null, discordNoChannel: true })
  })
  it('a guild channel (groups key) is the target, even next to user ids', () => {
    expect(discordBoundChannelFromAccess({ allowFrom: [USER_ID], groups: { [GUILD_CHANNEL]: {} } })).toEqual({ chatId: GUILD_CHANNEL })
  })
  it('two or more guild channels are an ambiguity, never the first key (WRONGRECIP819, Dani 64034)', () => {
    const second = '444444444444444444'
    expect(discordBoundChannelFromAccess({ allowFrom: [], groups: { [GUILD_CHANNEL]: {}, [second]: {} } })).toEqual({ chatId: null, ambiguousCandidates: 2 })
    expect(discordBoundChannelFromAccess({ allowFrom: [USER_ID], groups: { [second]: {}, [GUILD_CHANNEL]: {} } })).toEqual({ chatId: null, ambiguousCandidates: 2 })
  })
  it('nothing at all is a plain config gap, not flagged', () => {
    expect(discordBoundChannelFromAccess({ allowFrom: [], groups: {} })).toEqual({ chatId: null })
    expect(discordBoundChannelFromAccess(null)).toEqual({ chatId: null })
  })
})

describe('resolveBoundChannel on Discord (on-disk access.json)', () => {
  it('the reported case: the MAIN agent with one allowFrom user id gets no chat id, flagged', () => {
    const dir = join(h.tmpRoot, 'main-discord')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [USER_ID], groups: {}, pending: {} }))
    process.env.DISCORD_STATE_DIR = dir
    expect(resolveBoundChannel(MAIN_AGENT_ID, 'discord')).toEqual({ provider: 'discord', chatId: null, discordNoChannel: true })
  })

  it('a sub-agent with user ids only: never a user id as chat id', () => {
    writeAgentAccess('discord', { allowFrom: [USER_ID] })
    const got = resolveBoundChannel(AGENT)
    expect(got.chatId).toBeNull()
    expect(got.discordNoChannel).toBe(true)
  })

  it('two user ids are not an "ambiguous contact" on Discord: still no channel id', () => {
    writeAgentAccess('discord', { allowFrom: [USER_ID, '333333333333333333'] })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'discord', chatId: null, discordNoChannel: true })
  })

  it('an allowed guild channel resolves', () => {
    writeAgentAccess('discord', { allowFrom: [USER_ID], groups: { [GUILD_CHANNEL]: { requireMention: false } } })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'discord', chatId: GUILD_CHANNEL })
  })

  it('two allowed guild channels on disk: no chat id, the ambiguity reported, no Discord gap flag', () => {
    writeAgentAccess('discord', { allowFrom: [USER_ID], groups: { [GUILD_CHANNEL]: { requireMention: false }, '555555555555555555': { requireMention: false } } })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'discord', chatId: null, ambiguousCandidates: 2 })
  })

  it('an explicit task pin still wins (the documented workaround keeps working)', () => {
    writeAgentAccess('discord', { allowFrom: [USER_ID] })
    expect(resolveTaskChannelTarget({ agent: AGENT, channelProvider: 'discord', telegramChatId: GUILD_CHANNEL }, null))
      .toEqual({ provider: 'discord', chatId: GUILD_CHANNEL })
  })

  it('control: Telegram keeps the allowFrom entry as its chat id (there a DM chat id IS the user id)', () => {
    h.provider = 'telegram'
    writeAgentAccess('telegram', { allowFrom: ['1268077055'] })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'telegram', chatId: '1268077055' })
  })
})

describe('the Discord no-channel notice and its branch', () => {
  it('names the task, the agent and the exact way to fix it, with accents', () => {
    const t = discordNoChannelNotice('napi-osszefoglalo', MAIN_AGENT_ID, 'napi-osszefoglalo')
    expect(t).toContain('"napi-osszefoglalo" ütemezett feladat')
    expect(t).toContain('nincs Discord csatorna-azonosító')
    expect(t).toContain('PUT /api/schedules/napi-osszefoglalo')
    expect(t).toContain('"channelProvider": "discord"')
    expect(t).toContain('SCHEDULED_DELIVERY_CHANNEL')
    expect(t).not.toContain(USER_ID)
    expect(t).not.toContain('—')
  })

  // The prompt builder is a large async path; like the ambiguous branch next to it, the
  // wiring is pinned on the source: the flag skips the delivery (bare tag), reports once
  // per task, and a later clean resolution re-arms the report.
  it('the branch skips delivery, reports once per task, and re-arms on a clean resolution', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
    const at = src.indexOf('} else if (bound.discordNoChannel) {')
    expect(at).toBeGreaterThan(0)
    const branch = src.slice(at, src.indexOf('} else {', at))
    expect(branch).toContain('if (!discordNoChannelAlerted.has(task.name)) {')
    expect(branch).toContain('discordNoChannelAlerted.add(task.name)')
    expect(branch).toContain('createAgentMessage(\'system\', MAIN_AGENT_ID, discordNoChannelNotice(')
    expect(branch).toContain('prefix = `[Utemezett feladat: ${task.name}] `')
    expect(branch).not.toContain('taskDeliveryPrefix(')
    const clean = src.slice(src.indexOf('if (bound.chatId) {'), at)
    expect(clean).toContain('discordNoChannelAlerted.delete(task.name)')
  })
})
