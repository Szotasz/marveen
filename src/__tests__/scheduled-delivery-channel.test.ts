import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SLACKFOCSATORNA1007C (owner, 2026-10-07: the Slack DM is the main channel).
// The main agent is bound to Telegram, so every one of its scheduled tasks was
// told "Az eredmenyt kuldd el Telegramon", and task-config.json could not say
// otherwise. These tests call the real resolver with an explicit install
// default, so no host .env is read; a sub-agent's channel binding lives in a
// throwaway directory (agentDir is mocked for that one fixture name only).
let FIXTURE_DIR = ''
const SUB = 'delivery-fixture-sub-1007'
// What the install .env holds for SCHEDULED_DELIVERY_CHANNEL in this test;
// every other readEnvFile call reaches the real implementation.
let ENV_FILE_VALUE: string | undefined
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) =>
      keys && keys.length === 1 && keys[0] === 'SCHEDULED_DELIVERY_CHANNEL'
        ? (ENV_FILE_VALUE === undefined ? {} : { SCHEDULED_DELIVERY_CHANNEL: ENV_FILE_VALUE })
        : actual.readEnvFile(keys),
  }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => (name === SUB ? FIXTURE_DIR : actual.agentDir(name)) }
})

const runner = await import('../web/schedule-runner.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { logger } = await import('../logger.js')
const { resolveAgentProvider } = await import('../web/agent-process.js')
const { resolveTaskChannelTarget, resolveBoundChannel, parseDeliveryDefault, readScheduledDeliveryDefault, deliveryFallbackClause } = runner

const SLACK_DM = { provider: 'slack' as const, chatId: 'D0C74N9SAF6' }

function bindSub(provider: string, allowFrom: string[]) {
  const dir = join(FIXTURE_DIR, '.claude', 'channels', provider)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom }))
}

beforeEach(() => { FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'delivery-channel-')) })
afterEach(() => { rmSync(FIXTURE_DIR, { recursive: true, force: true }); FIXTURE_DIR = ''; vi.restoreAllMocks() })

describe('parseDeliveryDefault: "<provider>:<chat id>" or nothing', () => {
  it('reads a provider and a chat id', () => {
    expect(parseDeliveryDefault('slack:D0C74N9SAF6')).toEqual(SLACK_DM)
    expect(parseDeliveryDefault('  slack : D0C74N9SAF6 ')).toEqual(SLACK_DM)
    expect(parseDeliveryDefault('telegram:1268077055')).toEqual({ provider: 'telegram', chatId: '1268077055' })
  })

  it('anything unusable is null -- no override, never a guess', () => {
    for (const bad of [undefined, null, '', '   ', 'slack:', 'slack:   ', 'D0C74N9SAF6', ':D0C74N9SAF6',
      'whatsapp:123', 'Slack:D0C74N9SAF6', 'telegram:0', 'slack:none']) {
      expect(parseDeliveryDefault(bad), String(bad)).toBeNull()
    }
  })
})

describe('readScheduledDeliveryDefault: a set but bad value is warned about and ignored', () => {
  it('a bad value -> null + ONE warn per distinct value', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(readScheduledDeliveryDefault(() => 'slack:')).toBeNull()
    expect(readScheduledDeliveryDefault(() => 'slack:')).toBeNull()
    expect(readScheduledDeliveryDefault(() => 'nosuch:123')).toBeNull()
    const lines = warn.mock.calls.filter((c) => String(c[1]).includes('SCHEDULED_DELIVERY_CHANNEL'))
    expect(lines.length).toBe(2)
  })

  it('a good value -> parsed, unset -> null, neither warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    expect(readScheduledDeliveryDefault(() => 'slack:D0C74N9SAF6')).toEqual(SLACK_DM)
    expect(readScheduledDeliveryDefault(() => undefined)).toBeNull()
    expect(readScheduledDeliveryDefault(() => '')).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('SCHEDULED_DELIVERY_CHANNEL')).length).toBe(0)
  })

  it('the default reader reads the install .env (launchd: the .env never reaches process.env)', () => {
    const before = process.env.SCHEDULED_DELIVERY_CHANNEL
    delete process.env.SCHEDULED_DELIVERY_CHANNEL
    ENV_FILE_VALUE = 'slack:DENVFILE1'
    try {
      expect(readScheduledDeliveryDefault()).toEqual({ provider: 'slack', chatId: 'DENVFILE1' })
      ENV_FILE_VALUE = undefined
      expect(readScheduledDeliveryDefault()).toBeNull()
    } finally {
      ENV_FILE_VALUE = undefined
      if (before !== undefined) process.env.SCHEDULED_DELIVERY_CHANNEL = before
    }
  })

  it('the default reader takes process.env first (operator/test override)', () => {
    const before = process.env.SCHEDULED_DELIVERY_CHANNEL
    process.env.SCHEDULED_DELIVERY_CHANNEL = 'slack:DPROCESS1'
    try {
      expect(readScheduledDeliveryDefault()).toEqual({ provider: 'slack', chatId: 'DPROCESS1' })
    } finally {
      if (before === undefined) delete process.env.SCHEDULED_DELIVERY_CHANNEL
      else process.env.SCHEDULED_DELIVERY_CHANNEL = before
    }
  })
})

describe('resolveTaskChannelTarget with the install default and the task-level provider', () => {
  it('WITHOUT a default the main agent is unchanged: its own provider and binding', () => {
    const got = resolveTaskChannelTarget({ agent: MAIN_AGENT_ID }, null)
    expect(got).toEqual(resolveBoundChannel(MAIN_AGENT_ID))
    expect(got.provider).toBe(resolveAgentProvider(MAIN_AGENT_ID))
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, telegramChatId: '1268077055' }, null))
      .toEqual({ provider: resolveAgentProvider(MAIN_AGENT_ID), chatId: '1268077055' })
  })

  it('WITH a default the main agent delivers there: slack + the DM id', () => {
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID }, SLACK_DM)).toEqual(SLACK_DM)
    expect(resolveTaskChannelTarget({ agent: '' }, SLACK_DM)).toEqual(SLACK_DM)
  })

  it('a task that pins its own chat keeps it: the default does not override an author pin', () => {
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, telegramChatId: '1268077055' }, SLACK_DM))
      .toEqual({ provider: resolveAgentProvider(MAIN_AGENT_ID), chatId: '1268077055' })
  })

  it('a task-level channelProvider wins over the default', () => {
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, channelProvider: 'telegram', telegramChatId: '1268077055' }, SLACK_DM))
      .toEqual({ provider: 'telegram', chatId: '1268077055' })
  })

  it('a task-level channelProvider without a chat takes the default chat when it names the same provider', () => {
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, channelProvider: 'slack' }, SLACK_DM)).toEqual(SLACK_DM)
  })

  it('...but NOT a default for another provider: a Slack DM id is never handed to Telegram', () => {
    const got = resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, channelProvider: 'telegram' }, SLACK_DM)
    expect(got.provider).toBe('telegram')
    expect(got.chatId).not.toBe(SLACK_DM.chatId)
    expect(got).toEqual(resolveBoundChannel(MAIN_AGENT_ID, 'telegram'))
  })

  it('"none" wins over everything', () => {
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, telegramChatId: 'none' }, SLACK_DM).chatId).toBeNull()
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID, telegramChatId: 'none', channelProvider: 'slack' }, SLACK_DM))
      .toEqual({ provider: 'slack', chatId: null })
  })

  it('a sub-agent task is NOT touched by the install default', () => {
    bindSub('telegram', ['111111'])
    expect(resolveTaskChannelTarget({ agent: SUB }, SLACK_DM)).toEqual({ provider: resolveAgentProvider(SUB), chatId: '111111' })
    expect(resolveTaskChannelTarget({ agent: SUB, telegramChatId: '222222' }, SLACK_DM).chatId).toBe('222222')
  })

  it('a sub-agent task that NAMES a provider resolves the agent\'s own binding on it, never the main default', () => {
    bindSub('slack', ['DSUB0001'])
    expect(resolveTaskChannelTarget({ agent: SUB, channelProvider: 'slack' }, SLACK_DM)).toEqual({ provider: 'slack', chatId: 'DSUB0001' })
  })

  it('...and with 2+ contacts on that provider it refuses to guess (WRONGRECIP819)', () => {
    bindSub('slack', ['DSUB0001', 'DSUB0002'])
    const got = resolveTaskChannelTarget({ agent: SUB, channelProvider: 'slack' }, SLACK_DM)
    expect(got.chatId).toBeNull()
    expect(got.ambiguousCandidates).toBe(2)
    expect(got.provider).toBe('slack')
  })

  it('a bad install value behaves exactly like no default', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const bad = readScheduledDeliveryDefault(() => 'slack:')
    expect(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID }, bad)).toEqual(resolveTaskChannelTarget({ agent: MAIN_AGENT_ID }, null))
  })
})

describe('deliveryFallbackClause: the main agent falls back to the owner Telegram chat, nobody else does', () => {
  it('main agent told to deliver on Slack: names the Telegram fallback with the owner chat, and forbids guessing', () => {
    const c = deliveryFallbackClause('slack', true, '1268077055')
    expect(c).toContain('Slacken')
    expect(c).toContain('Telegramon (chat_id: 1268077055, reply tool)')
    expect(c).toContain('ne tippelj')
  })

  it('no clause on Telegram itself, for a sub-agent, or without an owner chat', () => {
    expect(deliveryFallbackClause('telegram', true, '1268077055')).toBe('')
    expect(deliveryFallbackClause('slack', false, '1268077055')).toBe('')
    expect(deliveryFallbackClause('slack', true, null)).toBe('')
  })
})

describe('the binding: the delivery prompt line carries the fallback clause', () => {
  // The clause is pure and tested above; this pins that the ONE place that
  // builds the delivery instruction actually appends it, for the agent the
  // prompt goes to. A source pin, because the prefix is built inside the
  // fire path, which needs a live tmux session to reach.
  it('the resolved-chat prefix interpolates deliveryFallbackClause(bound.provider, <is main>)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/Az eredmenyt kuldd el \$\{channelDeliveryName\(bound\.provider\)\} \(chat_id: \$\{bound\.chatId\}, reply tool\)\. \$\{deliveryFallbackClause\(bound\.provider, agentName === MAIN_AGENT_ID\)\}`/)
  })
})
