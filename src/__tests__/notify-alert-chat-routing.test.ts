import { describe, it, expect, vi, beforeEach } from 'vitest'

// ALERT_CHAT_ID: operational alerts (watchdog respawns, stuck sessions) go to
// the person who runs the system, not the owner. Measured 2026-09-23: a stale
// keep-alive loop sent the owner 16 respawn alerts in one morning that only the
// operator could act on. Owner-facing content must NOT follow the override.
const { cfg, mockSend } = vi.hoisted(() => ({
  cfg: { chatId: '111', alertChatId: '' },
  mockSend: vi.fn(async () => {}),
}))

vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
  CHANNEL_TOKEN: 'bot-token',
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  get ALERT_CHAT_ID() { return cfg.alertChatId },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-alert-routing-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-alert-routing-test',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, notifyOwner, notifySecurityEvent } from '../notify.js'

const sentTo = () => (mockSend.mock.calls as unknown as unknown[][]).map((c) => c[1])

beforeEach(() => {
  mockSend.mockClear()
  cfg.chatId = '111'
  cfg.alertChatId = ''
})

describe('ALERT_CHAT_ID routing', () => {
  it('sends operational alerts to the owner chat when unset', async () => {
    await notifyChannel('alert')
    expect(sentTo()).toEqual(['111'])
  })

  it('sends operational alerts to ALERT_CHAT_ID when set', async () => {
    cfg.alertChatId = '222'
    await notifyChannel('alert')
    expect(sentTo()).toEqual(['222'])
  })

  it('keeps owner-facing content on the owner chat', async () => {
    cfg.alertChatId = '222'
    await notifyOwner('digest')
    await notifySecurityEvent('reset')
    expect(sentTo()).toEqual(['111', '111'])
  })
})
