// NOTIFYSENDLOG930 -- a channel send leaves one line in the channel log, in
// both directions: the outcome, the HTTP status of the answer and the id the
// Bot API gave the new message. Before this, notify.ts swallowed every outcome,
// so a delivered alert and a lost one looked the same in store/dashboard.log.
// The line never carries the token, the text or the raw chat id -- a Bot API
// error description can quote the text it rejected, so a failure keeps only
// the status.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { K, cfg, mockSend, mockInfo, mockWarn } = vi.hoisted(() => ({
  K: {
    token: 'TOKEN-NE-KERULJON-NAPLOBA',
    chat: '1268077055',
    alertChat: '-1009876543210',
    text: 'SZOVEG-NE-KERULJON-NAPLOBA',
  },
  cfg: { alertChat: '' },
  mockSend: vi.fn(),
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
}))

vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
  CHANNEL_TOKEN: K.token,
  CHANNEL_CHAT_ID: K.chat,
  ALLOWED_CHAT_ID: K.chat,
  get ALERT_CHAT_ID() { return cfg.alertChat },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-send-outcome-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-send-outcome-test/channels',
}))

vi.mock('../logger.js', () => ({
  logger: { info: mockInfo, warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, notifyOwner } from '../notify.js'

// Everything the logger received, read as one string: a leak anywhere in a
// payload or a message fails the check.
function expectNothingSensitiveLogged(): void {
  const all = JSON.stringify([...mockInfo.mock.calls, ...mockWarn.mock.calls])
  expect(all).not.toContain(K.token)
  expect(all).not.toContain(K.chat)
  expect(all).not.toContain(K.alertChat)
  expect(all).not.toContain(K.text)
}

const refusal = () => new Error(`Telegram API 400: ok:false Bad Request: can't parse entities in "${K.text}"`)

beforeEach(() => {
  mockSend.mockReset()
  mockInfo.mockClear()
  mockWarn.mockClear()
  cfg.alertChat = ''
})

describe('notify: every send leaves an outcome line (NOTIFYSENDLOG930)', () => {
  it('a delivered alert is logged with the status and the message id, directly or after the plain-text retry', async () => {
    mockSend.mockResolvedValueOnce({ status: 200, messageId: '4242' })
    await notifyOwner(K.text)
    expect(mockSend).toHaveBeenCalledWith(K.token, K.chat, K.text, 'HTML')
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'telegram', target: 'owner', chunk: 1, chunks: 1, status: 200, messageId: '4242' }),
      'Channel ertesites elkuldve',
    )

    // The HTML attempt is refused and the plain-text retry gets through: still
    // a delivery, and the refusal's status stays on the line.
    cfg.alertChat = K.alertChat
    mockSend.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ status: 200, messageId: '4243' })
    await notifyChannel(K.text)
    expect(mockSend).toHaveBeenLastCalledWith(K.token, K.alertChat, K.text)
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'alert', status: 200, messageId: '4243', plainTextRetry: true, firstStatus: 400 }),
      'Channel ertesites elkuldve',
    )
    expect(mockWarn).not.toHaveBeenCalled()
    expectNothingSensitiveLogged()
  })

  it('a lost alert is logged with both statuses, and without the token, the text or the chat id', async () => {
    mockSend
      .mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(new Error('Telegram API 403: Forbidden: bot was blocked by the user'))
    await notifyOwner(K.text)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'telegram', target: 'owner', chunk: 1, chunks: 1, firstStatus: 400, retryStatus: 403 }),
      'Channel ertesites SIKERTELEN',
    )
    expect(mockInfo).not.toHaveBeenCalledWith(expect.anything(), 'Channel ertesites elkuldve')

    // A send that never got an HTTP answer (timeout, network) is logged too, with no status.
    mockSend
      .mockRejectedValueOnce(new Error('Telegram sendMessage timed out after 10000ms'))
      .mockRejectedValueOnce(new Error('socket hang up'))
    await notifyOwner(K.text)
    expect(mockWarn).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 'owner', firstStatus: null, retryStatus: null }),
      'Channel ertesites SIKERTELEN',
    )
    expectNothingSensitiveLogged()
  })
})
