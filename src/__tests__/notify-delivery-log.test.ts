import { describe, it, expect, vi, beforeEach } from 'vitest'

// Card 68cb6715 (ii): every alert send leaves one delivery line -- sent, partly
// sent, failed or skipped -- with who and which case when the caller says so,
// and the recipient as a role. Measured gap it closes (2026-09-26): about 30
// evening alerts were reported by the owner, and dashboard.log held none of
// them, so their sources could not be measured afterwards. The line must carry
// neither the chat id nor the text.
const { cfg, mockSend, split } = vi.hoisted(() => ({
  cfg: { chatId: '111', alertChatId: '' },
  mockSend: vi.fn(async (_token: string, _chat: string, _text: string, _mode?: string) => {}),
  split: { fn: (t: string) => [t] as string[] },
}))

vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
  CHANNEL_TOKEN: 'bot-token',
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  get ALERT_CHAT_ID() { return cfg.alertChatId },
  MAIN_AGENT_ID: 'main-agent',
  PROJECT_ROOT: '/tmp/notify-delivery-log-test',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => split.fn(t),
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-delivery-log-test',
}))

const { mockInfo, mockWarn } = vi.hoisted(() => ({ mockInfo: vi.fn(), mockWarn: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: mockInfo, warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, notifyOwner } from '../notify.js'

type Line = { level: 'info' | 'warn'; fields: Record<string, unknown> }
function deliveryLines(): Line[] {
  const pick = (level: Line['level'], calls: unknown[][]) =>
    calls.filter((c) => c[1] === 'alert delivery').map((c) => ({ level, fields: c[0] as Record<string, unknown> }))
  return [...pick('info', mockInfo.mock.calls), ...pick('warn', mockWarn.mock.calls)]
}

beforeEach(() => {
  mockSend.mockReset()
  mockSend.mockImplementation(async () => {})
  mockInfo.mockClear()
  mockWarn.mockClear()
  cfg.chatId = '111'
  cfg.alertChatId = ''
  split.fn = (t: string) => [t]
})

describe('alert delivery line (card 68cb6715)', () => {
  it('a successful send logs one info line with agent, case, recipient role and outcome', async () => {
    await notifyChannel('the alert text', { agent: 'agent-x', kind: 'permission-prompt' })
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(deliveryLines()).toEqual([{
      level: 'info',
      fields: { agent: 'agent-x', kind: 'permission-prompt', recipient: 'owner', outcome: 'sent', chunks: 1, failedChunks: 0 },
    }])
  })

  it('the line carries neither the chat id nor the text', async () => {
    await notifyChannel('the alert text', { agent: 'agent-x', kind: 'permission-prompt' })
    const logged = JSON.stringify(deliveryLines())
    expect(logged).not.toContain('111')
    expect(logged).not.toContain('the alert text')
  })

  it('a send that fails on both attempts logs a warn line with outcome failed', async () => {
    mockSend.mockImplementation(async () => { throw new Error('Telegram API 400: chat not found') })
    await notifyChannel('x', { agent: 'agent-x', kind: 'permission-prompt' })
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(deliveryLines()).toEqual([{
      level: 'warn',
      fields: { agent: 'agent-x', kind: 'permission-prompt', recipient: 'owner', outcome: 'failed', chunks: 1, failedChunks: 1 },
    }])
  })

  it('the plain-text retry that lands counts as sent', async () => {
    mockSend.mockImplementationOnce(async () => { throw new Error('Telegram API 400: bad HTML') })
    await notifyChannel('x', { kind: 'routine' })
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(deliveryLines()).toEqual([{
      level: 'info',
      fields: { agent: null, kind: 'routine', recipient: 'owner', outcome: 'sent', chunks: 1, failedChunks: 0 },
    }])
  })

  it('a multi-chunk send with one lost chunk is partial', async () => {
    split.fn = () => ['part one', 'part two']
    mockSend.mockImplementation(async (_t: string, _c: string, text: string) => {
      if (text === 'part two' || text.startsWith('x')) throw new Error('Telegram API 400')
    })
    await notifyChannel('x long', { kind: 'routine' })
    expect(deliveryLines()).toEqual([{
      level: 'warn',
      fields: { agent: null, kind: 'routine', recipient: 'owner', outcome: 'partial', chunks: 2, failedChunks: 1 },
    }])
  })

  it('a redirected alert names the alert-chat role', async () => {
    cfg.alertChatId = '222'
    await notifyChannel('x', { kind: 'routine' })
    expect(deliveryLines().map((l) => l.fields.recipient)).toEqual(['alert-chat'])
  })

  it('a skipped send (no owner chat) logs a warn line with outcome skipped, and nothing is sent', async () => {
    cfg.chatId = '0'
    await notifyChannel('x', { agent: 'agent-x', kind: 'permission-prompt' })
    expect(mockSend).not.toHaveBeenCalled()
    expect(deliveryLines()).toEqual([{
      level: 'warn',
      fields: { agent: 'agent-x', kind: 'permission-prompt', recipient: 'owner', outcome: 'skipped', chunks: 0, failedChunks: 0 },
    }])
  })

  it('a caller without meta still gets the line, with agent and case null', async () => {
    await notifyOwner('digest')
    expect(deliveryLines()).toEqual([{
      level: 'info',
      fields: { agent: null, kind: null, recipient: 'owner', outcome: 'sent', chunks: 1, failedChunks: 0 },
    }])
  })

  // notifyChannel reaches the owner chat through telegramOwner, not notifyOwner
  // (the Slack wrapper of #1745), so notifyOwner's own meta pass and the
  // redirected leg's agent and case each need a case of their own.
  it('notifyOwner passes its meta to the line', async () => {
    await notifyOwner('digest', { agent: 'agent-x', kind: 'security' })
    expect(deliveryLines()).toEqual([{
      level: 'info',
      fields: { agent: 'agent-x', kind: 'security', recipient: 'owner', outcome: 'sent', chunks: 1, failedChunks: 0 },
    }])
  })

  it('a redirected alert keeps its agent and case', async () => {
    cfg.alertChatId = '222'
    await notifyChannel('x', { agent: 'agent-x', kind: 'permission-prompt' })
    expect(deliveryLines()).toEqual([{
      level: 'info',
      fields: { agent: 'agent-x', kind: 'permission-prompt', recipient: 'alert-chat', outcome: 'sent', chunks: 1, failedChunks: 0 },
    }])
  })
})
