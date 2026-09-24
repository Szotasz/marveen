// NOTIFYOWNERFALLBACK924 -- notifyChannel must reach the paired channel when
// ALLOWED_CHAT_ID is the installer's "0" placeholder, the same way
// resolveOwnerChatId already resolves it for the scheduler and the inbound
// prober (owner-chat.ts). Before this, notifyChannel only normalised the raw
// .env value -- a wizard install whose .env still says "0" but whose
// telegram/access.json is paired got silence instead of the alert.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const REAL = '1268077055'

const { cfg, mockSend } = vi.hoisted(() => ({
  cfg: { provider: 'telegram' as string, token: 'bot-token', chatId: '0', accessBody: null as unknown },
  mockSend: vi.fn(async () => {}),
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return cfg.provider },
  get CHANNEL_TOKEN() { return cfg.token },
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-owner-fallback-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-owner-fallback-test/channels',
}))

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

// owner-chat.ts's resolveOwnerChatId takes a reader function as its first
// (optional) arg, defaulting to node:fs readFileSync -- notify.ts calls it
// with `undefined`, so we intercept the real fs read instead of re-mocking
// owner-chat.ts itself (keeping the real resolution logic under test).
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (cfg.accessBody == null) throw new Error('ENOENT')
    return JSON.stringify(cfg.accessBody)
  },
}))

import { notifyChannel } from '../notify.js'

beforeEach(() => {
  mockSend.mockClear()
  mockWarn.mockClear()
  cfg.provider = 'telegram'
  cfg.token = 'bot-token'
  cfg.accessBody = null
})

describe('notifyChannel: owner-chat fallback (NOTIFYOWNERFALLBACK924)', () => {
  it('sends to the paired channel when ALLOWED_CHAT_ID=0 and access.json has an allowFrom entry', async () => {
    cfg.chatId = '0'
    cfg.accessBody = { allowFrom: [REAL] }
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledWith('bot-token', REAL, 'alert', 'HTML')
  })

  it('does not send and logs a reason when access.json is missing/malformed', async () => {
    cfg.chatId = '0'
    cfg.accessBody = null
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Channel ertesites kihagyva'))
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('nincs tulajdonos-chat'))
  })

  it('does not send when access.json only has the "0" placeholder in allowFrom', async () => {
    cfg.chatId = '0'
    cfg.accessBody = { allowFrom: ['0'] }
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('an explicit configured chat id still wins over access.json (unchanged behaviour)', async () => {
    cfg.chatId = REAL
    cfg.accessBody = { allowFrom: ['999999'] }
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledWith('bot-token', REAL, 'alert', 'HTML')
  })

  it('names the missing-token reason separately from the missing-owner-chat reason', async () => {
    cfg.chatId = REAL
    cfg.token = ''
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('nincs token'))
  })
})
