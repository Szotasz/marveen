import { describe, it, expect, vi, beforeEach } from 'vitest'

// #1878 (9): when one chunk of a multi-chunk alert failed, the fallback sent
// outbound.slice(0, 4096) -- the START of the whole message -- so chunk N was
// never delivered and chunk 1 arrived twice. The fallback must be the failed
// chunk itself, as plain text, and a second failure must leave a log line.
const { cfg, mockSend, mockWarn } = vi.hoisted(() => ({
  cfg: { provider: 'telegram', token: 'bot-token', chatId: '42' },
  mockSend: vi.fn(async (_token: string, _chat: string, _text: string, _mode?: string) => {}),
  mockWarn: vi.fn(),
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return cfg.provider },
  get CHANNEL_TOKEN() { return cfg.token },
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  ALERT_CHAT_ID: '',
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-chunk-fallback-test',
}))

// Three fixed chunks, whatever the text: the split itself is not under test.
const CHUNKS = ['<b>first</b> part', '<b>second</b> a &lt; b &amp; c', '<i>third</i> part']
vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: () => [...CHUNKS],
    sendMessage: mockSend,
  }),
  channelStateDir: () => '/tmp/notify-chunk-fallback-test',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, telegramHtmlToPlain } from '../notify.js'
import { formatForTelegram } from '../format.js'

const sentTexts = () => mockSend.mock.calls.map(c => c[2])

beforeEach(() => {
  mockSend.mockReset()
  mockSend.mockImplementation(async () => {})
  mockWarn.mockClear()
  cfg.provider = 'telegram'
})

describe('sendToChat: a failed chunk falls back to ITSELF, as plain text', () => {
  it('chunk 2 fails formatted: chunk 2 goes out as plain text, chunk 1 is not resent, chunk 3 still goes', async () => {
    mockSend.mockImplementation(async (_t, _c, text, mode) => {
      if (text === CHUNKS[1] && mode === 'HTML') throw new Error('Bad Request: can\'t parse entities')
    })
    await notifyChannel('a long alert')
    expect(sentTexts()).toEqual([CHUNKS[0], CHUNKS[1], 'second a < b & c', CHUNKS[2]])
    // the fallback carries no parse mode
    expect(mockSend.mock.calls[2][3]).toBeUndefined()
  })

  it('every chunk is delivered exactly once when only the formatted sends fail', async () => {
    mockSend.mockImplementation(async (_t, _c, _text, mode) => {
      if (mode === 'HTML') throw new Error('Bad Request')
    })
    await notifyChannel('a long alert')
    expect(sentTexts().filter((_, i) => mockSend.mock.calls[i][3] === undefined))
      .toEqual(['first part', 'second a < b & c', 'third part'])
  })

  it('a chunk that fails both ways is logged by index (never by text), and the rest still goes', async () => {
    mockSend.mockImplementation(async (_t, _c, text) => {
      if (text.includes('second')) throw new Error('network down')
    })
    await notifyChannel('a long alert')
    expect(sentTexts()).toContain(CHUNKS[2])
    // Two warnings: this chunk by index, then the send's partial-delivery
    // summary (#1655). Neither carries the text.
    expect(mockWarn).toHaveBeenCalledTimes(2)
    const [meta, msg] = mockWarn.mock.calls[0]
    expect(meta).toMatchObject({ chunk: 2, of: 3, err: 'network down' })
    expect(mockWarn.mock.calls[1][0]).toMatchObject({ delivered: 2, chunks: 3 })
    expect(mockWarn.mock.calls[1][1]).toBe('channel send only partially delivered')
    for (const call of mockWarn.mock.calls) expect(JSON.stringify(call)).not.toContain('second')
  })

  it('a non-HTML provider resends the failed chunk unchanged, still not the message start', async () => {
    cfg.provider = 'discord'
    let failed = false
    mockSend.mockImplementation(async (_t, _c, text) => {
      if (text === CHUNKS[1] && !failed) { failed = true; throw new Error('429') }
    })
    await notifyChannel('a long alert')
    expect(sentTexts()).toEqual([CHUNKS[0], CHUNKS[1], CHUNKS[1], CHUNKS[2]])
  })
})

describe('telegramHtmlToPlain', () => {
  it('drops the tags formatForTelegram writes and decodes its three entities', () => {
    const md = '**bold** _it_ ~~gone~~ [link](https://x.test/a?b=1&c=2) `a<b` and\n```ts\nif (a < b && c > d) {}\n```'
    const html = formatForTelegram(md)
    expect(html).toContain('<b>bold</b>') // the formatter did produce tags
    expect(telegramHtmlToPlain(html)).toBe('bold it gone link a<b and\nif (a < b && c > d) {}')
  })

  it('keeps a literal angle-bracket text that is not one of the formatter tags', () => {
    expect(telegramHtmlToPlain('wait <5 perc> then <b>go</b>')).toBe('wait <5 perc> then go')
  })

  it('decodes an escaped entity once, not twice', () => {
    expect(telegramHtmlToPlain('&amp;lt;')).toBe('&lt;')
  })
})
