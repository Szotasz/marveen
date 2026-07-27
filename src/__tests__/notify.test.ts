import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSendMessage, mockFormatMessage, mockSplitMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockFormatMessage: vi.fn().mockImplementation((t: string) => t),
  mockSplitMessage: vi.fn().mockImplementation((t: string) => [t]),
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    CHANNEL_TOKEN: 'test-bot-token',
    CHANNEL_CHAT_ID: '12345',
    CHANNEL_PROVIDER: 'telegram',
  }
})

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    getProvider: vi.fn().mockReturnValue({
      sendMessage: mockSendMessage,
      formatMessage: mockFormatMessage,
      splitMessage: mockSplitMessage,
    }),
  }
})

import { notifyChannel, notifySecurityEvent } from '../notify.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockSendMessage.mockResolvedValue({ ok: true })
  mockFormatMessage.mockImplementation((t: string) => t)
  mockSplitMessage.mockImplementation((t: string) => [t])
})

describe('notifyChannel', () => {
  it('sends a message when token and chat_id are configured', async () => {
    await notifyChannel('hello world')
    expect(mockSendMessage).toHaveBeenCalledWith('test-bot-token', '12345', 'hello world', 'HTML')
  })

  it('splits long messages and sends each chunk', async () => {
    mockSplitMessage.mockReturnValue(['chunk1', 'chunk2'])
    await notifyChannel('long text')
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('falls back to plain text on send error', async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error('formatted send failed'))
      .mockResolvedValue({ ok: true })
    await notifyChannel('fallback test')
    // Second call is the fallback plain text send
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('silently gives up when both sends fail', async () => {
    mockSendMessage.mockRejectedValue(new Error('all sends failed'))
    await expect(notifyChannel('totally broken')).resolves.toBeUndefined()
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })
})

describe('notifySecurityEvent', () => {
  it('sends notification when channel is configured', async () => {
    await notifySecurityEvent('security alert')
    expect(mockSendMessage).toHaveBeenCalled()
  })

  it('does not throw when notifyChannel itself throws', async () => {
    mockSendMessage.mockRejectedValue(new Error('channel dead'))
    await expect(notifySecurityEvent('alert')).resolves.toBeUndefined()
  })
})
