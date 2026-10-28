// notifyChannel / notifyOwner report whether the message was delivered.
//
// They used to resolve void on every path: a skipped send (no token, no owner
// chat), a send the provider refused on every retry and a delivered one all
// looked the same to the caller. A caller that records "alert sent" (to dedupe
// or retry it) therefore had to assume success. They now resolve true only
// when the message was handed to a channel in full (Slack, or every chunk on
// the channel provider), false otherwise, and still never throw.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { cfg, mockSend, settings } = vi.hoisted(() => ({
  cfg: { token: 'TEST-TOKEN', alertChat: '' },
  mockSend: vi.fn(),
  settings: {} as Record<string, string>,
}))

vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
  get CHANNEL_TOKEN() { return cfg.token },
  CHANNEL_CHAT_ID: '111222333',
  ALLOWED_CHAT_ID: '111222333',
  get ALERT_CHAT_ID() { return cfg.alertChat },
  MAIN_AGENT_ID: 'main',
  PROJECT_ROOT: '/tmp/notify-delivery-result-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    // '|' marks a chunk boundary, so a multi-chunk send is easy to build.
    splitMessage: (t: string) => t.split('|'),
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-delivery-result-test/channels',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

import { notifyChannel, notifyOwner, deliverWithSlack } from '../notify.js'

const refused = () => new Error('Telegram API 403: Forbidden')

beforeEach(() => {
  mockSend.mockReset()
  cfg.token = 'TEST-TOKEN'
  cfg.alertChat = ''
  for (const k of Object.keys(settings)) delete settings[k]
})

describe('notifyChannel / notifyOwner resolve the delivery outcome', () => {
  it('true when the provider accepted the message', async () => {
    mockSend.mockResolvedValue({ status: 200, messageId: 1 })
    expect(await notifyChannel('hello')).toBe(true)
    expect(await notifyOwner('hello')).toBe(true)
  })

  it('false when the provider refused it, plain-text retry included', async () => {
    mockSend.mockRejectedValue(refused())
    expect(await notifyChannel('hello')).toBe(false)
    expect(await notifyOwner('hello')).toBe(false)
    // Both the formatted send and the plain-text retry were tried, per call.
    expect(mockSend).toHaveBeenCalledTimes(4)
  })

  it('true when only the formatted send failed and the plain-text retry went out', async () => {
    mockSend.mockRejectedValueOnce(refused()).mockResolvedValueOnce({ status: 200, messageId: 2 })
    expect(await notifyChannel('hello')).toBe(true)
  })

  it('false when only part of a multi-chunk message went out', async () => {
    mockSend
      .mockResolvedValueOnce({ status: 200, messageId: 3 })
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
    expect(await notifyChannel('first|second')).toBe(false)
  })

  it('false when the send is skipped for want of a token', async () => {
    cfg.token = ''
    expect(await notifyChannel('hello')).toBe(false)
    expect(await notifyOwner('hello')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('the ALERT_CHAT_ID route reports too', async () => {
    cfg.alertChat = '-100444555666'
    mockSend.mockResolvedValueOnce({ status: 200, messageId: 4 })
    expect(await notifyChannel('hello')).toBe(true)
    expect(mockSend.mock.calls[0][1]).toBe('-100444555666')
    mockSend.mockRejectedValue(refused())
    expect(await notifyChannel('hello')).toBe(false)
  })

  it('never throws, even when the provider throws synchronously', async () => {
    mockSend.mockImplementation(() => { throw new Error('socket hang up') })
    await expect(notifyChannel('hello')).resolves.toBe(false)
  })
})

describe('deliverWithSlack: true when any channel took the message', () => {
  const slack = (ok: boolean) => vi.fn(async () => (ok ? { ok: true } : { ok: false, error: 'boom' }))

  it('no Slack target: the Telegram callback decides; a legacy void callback counts as sent', async () => {
    expect(await deliverWithSlack('alert', 't', async () => true)).toBe(true)
    expect(await deliverWithSlack('alert', 't', async () => false)).toBe(false)
    expect(await deliverWithSlack('alert', 't', async () => {})).toBe(true)
  })

  it('Slack OK is a delivery even when the Telegram copy beside it fails', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    expect(await deliverWithSlack('alert', 't', async () => false, slack(true) as never)).toBe(true)
    settings.NOTIFY_TELEGRAM = '0'
    const telegram = vi.fn(async () => false)
    expect(await deliverWithSlack('alert', 't', telegram, slack(true) as never)).toBe(true)
    expect(telegram).not.toHaveBeenCalled()
  })

  it('Slack failed: the Telegram fallback decides', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    expect(await deliverWithSlack('alert', 't', async () => true, slack(false) as never)).toBe(true)
    expect(await deliverWithSlack('alert', 't', async () => false, slack(false) as never)).toBe(false)
  })

  it('NOTIFY_TELEGRAM_FALLBACK=0: a message with no route left is reported lost', async () => {
    settings.NOTIFY_TELEGRAM_FALLBACK = '0'
    const telegram = vi.fn(async () => true)
    expect(await deliverWithSlack('alert', 't', telegram)).toBe(false)
    settings.NOTIFY_SLACK_TARGET = 'dm'
    expect(await deliverWithSlack('alert', 't', telegram, slack(false) as never)).toBe(false)
    expect(telegram).not.toHaveBeenCalled()
  })
})
