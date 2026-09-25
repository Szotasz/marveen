import { describe, it, expect, vi, beforeEach } from 'vitest'

// CHATID0. The installer writes ALLOWED_CHAT_ID=0 when the operator has not
// bound a chat yet. Every guard on this path tested truthiness, and "0" is
// neither empty nor falsy, so the guard passed and the send went out with
// chat_id=0 -- a guaranteed Bot API 400, discarded by notifyChannel's two
// nested catches. Measured on a live install (2026-09-05): the fleet's alerts
// had been dropping for weeks with ZERO "kihagyva" lines in dashboard.log,
// because the branch that prints that line was never reached. These tests pin
// the placeholder as "not configured" so the operator gets the warning instead
// of silence.
const { cfg, mockSend } = vi.hoisted(() => ({
  cfg: { provider: 'telegram', token: 'bot-token', chatId: '0' },
  mockSend: vi.fn(async () => {}),
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return cfg.provider },
  get CHANNEL_TOKEN() { return cfg.token },
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-placeholder-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-placeholder-test',
}))

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, notifySecurityEvent } from '../notify.js'

beforeEach(() => {
  mockSend.mockClear()
  mockWarn.mockClear()
  cfg.provider = 'telegram'
  cfg.token = 'bot-token'
})

describe('notifyChannel: the ALLOWED_CHAT_ID=0 placeholder', () => {
  it('does NOT send when the chat id is the "0" placeholder', async () => {
    cfg.chatId = '0'
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
  })

  // The whole point: an install in this state must SAY so. Before the fix the
  // guard was skipped, so this line never appeared and the failure was mute.
  it('logs the "kihagyva" warning for the placeholder', async () => {
    cfg.chatId = '0'
    await notifyChannel('alert')
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Channel ertesites kihagyva'))
  })

  it('treats a padded placeholder the same way', async () => {
    cfg.chatId = '  0  '
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('still skips an empty chat id (unchanged behaviour)', async () => {
    cfg.chatId = ''
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalled()
  })

  it('still skips when the token is missing', async () => {
    cfg.chatId = '5040302010'
    cfg.token = ''
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
  })

  // A real id must be unaffected -- and must arrive at the provider verbatim,
  // not via the module-level constant the guard no longer trusts.
  it('sends with a real chat id, passing it through unchanged', async () => {
    cfg.chatId = '5040302010'
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('bot-token', '5040302010', 'alert', 'HTML')
  })

  // "0" is a valid-looking id only for Telegram's numeric space; a Slack
  // channel id is a string. The helper is provider-agnostic on purpose.
  it('does not treat a legitimate non-numeric id as a placeholder', async () => {
    cfg.provider = 'slack'
    cfg.chatId = 'C01ABCDEF'
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledWith('bot-token', 'C01ABCDEF', 'alert', undefined)
  })
})

describe('notifySecurityEvent: same placeholder rule', () => {
  // This path is deliberately silent about missing config (a channel-less
  // install is expected here), so the assertion is only that nothing is sent.
  it('does not send to the "0" placeholder', async () => {
    cfg.chatId = '0'
    await notifySecurityEvent('security event')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends with a real chat id', async () => {
    cfg.chatId = '5040302010'
    await notifySecurityEvent('security event')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})
