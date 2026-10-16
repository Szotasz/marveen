import { describe, it, expect, vi, beforeEach } from 'vitest'

// PR1655 review (delta of 82694550), ask 1: sendOwnerMessage and sendToChat
// never ran in a test -- both route-level suites mock ../notify.js whole -- so
// the two original findings could come back with the suite still green:
//   - sendToChat swallowing a failure again (early `return { sent: true }`,
//     or the `delivered === 0` / `delivered < chunks.length` checks disabled),
//   - sendOwnerMessage following ALERT_CHAT_ID to the operations chat,
//   - a successful plain-text retry not counted as a delivery.
// These cases run the REAL notify.ts against a provider spy, for every
// provider the funnel can be configured with, not only Telegram: the fix is
// that the approval request reaches the owner on whatever channel the install
// speaks, so each provider gets the same contract.

const PROVIDERS = ['telegram', 'discord', 'slack', 'googlechat', 'teams'] as const

const { cfg, mockSend, chunking } = vi.hoisted(() => ({
  cfg: { provider: 'telegram', token: 'bot-token', chatId: '111', alertChatId: '' },
  mockSend: vi.fn(async (..._args: unknown[]) => {}),
  chunking: { split: (t: string) => [t] as string[] },
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return cfg.provider },
  get CHANNEL_TOKEN() { return cfg.token },
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  get ALERT_CHAT_ID() { return cfg.alertChatId },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-send-owner-message-test',
}))

// channelStateDir points at a directory that does not exist, so the
// access.json fallback of the owner-chat resolver finds nothing: a
// placeholder owner chat stays unresolved instead of picking up a real file.
vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => chunking.split(t),
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-send-owner-message-test/no-such-dir',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { sendOwnerMessage } from '../notify.js'

/** The chat id each provider call went to, in call order. */
const sentTo = () => mockSend.mock.calls.map((c) => c[1])

beforeEach(() => {
  mockSend.mockReset()
  mockSend.mockImplementation(async () => {})
  chunking.split = (t: string) => [t]
  cfg.token = 'bot-token'
  cfg.chatId = '111'
  cfg.alertChatId = ''
})

describe.each(PROVIDERS)('sendOwnerMessage on a %s install', (provider) => {
  beforeEach(() => { cfg.provider = provider })

  it('a delivered send reports sent: true and goes to the owner chat', async () => {
    expect(await sendOwnerMessage('approval')).toEqual({ sent: true })
    expect(sentTo()).toEqual(['111'])
  })

  // Mutant 1: an early `return { sent: true }`, or `delivered === 0` disabled.
  it('every chunk throws on both attempts: send-failed', async () => {
    mockSend.mockRejectedValue(new Error('provider down'))
    expect(await sendOwnerMessage('approval')).toEqual({ sent: false, reason: 'send-failed' })
    // one formatted attempt + one plain retry, so the failure is not a skipped send
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  // Mutant 1, second half: `delivered < chunks.length` disabled.
  it('one of two chunks fails on both attempts: partial, not sent', async () => {
    chunking.split = () => ['first half', 'second half']
    mockSend.mockImplementation(async (_token: unknown, _chat: unknown, text: unknown) => {
      if (text === 'second half' || text === 'approval') throw new Error('rejected')
    })
    expect(await sendOwnerMessage('approval')).toEqual({ sent: false, reason: 'partial' })
  })

  // Mutant 3: the retry-success `delivered++` removed.
  it('the formatted attempt throws and the plain retry succeeds: sent: true', async () => {
    mockSend.mockRejectedValueOnce(new Error('parse mode rejected'))
    expect(await sendOwnerMessage('approval')).toEqual({ sent: true })
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  // Mutant 2: sendOwnerMessage following ALERT_CHAT_ID.
  it('ALERT_CHAT_ID set: the owner message still goes to CHANNEL_CHAT_ID', async () => {
    cfg.alertChatId = '222'
    expect(await sendOwnerMessage('approval')).toEqual({ sent: true })
    expect(sentTo()).toEqual(['111'])
  })

  it('no channel token: no-token, and the provider is never called', async () => {
    cfg.token = ''
    expect(await sendOwnerMessage('approval')).toEqual({ sent: false, reason: 'no-token' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('the "0" placeholder as owner chat: no-owner-chat, never a send to chat 0', async () => {
    cfg.chatId = '0'
    expect(await sendOwnerMessage('approval')).toEqual({ sent: false, reason: 'no-owner-chat' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('an empty owner chat: no-owner-chat', async () => {
    cfg.chatId = ''
    expect(await sendOwnerMessage('approval')).toEqual({ sent: false, reason: 'no-owner-chat' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('the HTML parse mode is used on Telegram only', async () => {
    await sendOwnerMessage('approval')
    expect(mockSend.mock.calls[0][3]).toBe(provider === 'telegram' ? 'HTML' : undefined)
  })
})
