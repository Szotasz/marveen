import { describe, it, expect } from 'vitest'
import {
  getProvider,
  getProviderType,
  getChannelToken,
  getChannelChatId,
  channelStateDir,
  type ChannelProviderType,
} from '../channel-provider.js'

describe('getProviderType', () => {
  it('returns telegram by default', () => {
    expect(getProviderType(undefined)).toBe('telegram')
    expect(getProviderType('')).toBe('telegram')
    expect(getProviderType('anything')).toBe('telegram')
  })

  it('returns slack when explicitly set', () => {
    expect(getProviderType('slack')).toBe('slack')
  })
})

describe('getProvider', () => {
  it('returns telegram provider with correct pluginId', () => {
    const p = getProvider('telegram')
    expect(p.type).toBe('telegram')
    expect(p.pluginId).toBe('telegram@claude-plugins-official')
    expect(p.envKeys).toContain('TELEGRAM_BOT_TOKEN')
    expect(p.stateDir).toBe('telegram')
  })

  it('returns slack provider with correct pluginId', () => {
    const p = getProvider('slack')
    expect(p.type).toBe('slack')
    expect(p.pluginId).toBe('slack-channel@marveen-marketplace')
    expect(p.envKeys).toContain('SLACK_BOT_TOKEN')
    expect(p.stateDir).toBe('slack')
  })
})

describe('getChannelToken', () => {
  it('reads TELEGRAM_BOT_TOKEN for telegram', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tg-tok-123' }
    expect(getChannelToken('telegram', env)).toBe('tg-tok-123')
  })

  it('reads SLACK_BOT_TOKEN for slack', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-123' }
    expect(getChannelToken('slack', env)).toBe('xoxb-123')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelToken('telegram', {})).toBe('')
    expect(getChannelToken('slack', {})).toBe('')
  })
})

describe('getChannelChatId', () => {
  it('reads ALLOWED_CHAT_ID for telegram', () => {
    const env = { ALLOWED_CHAT_ID: '1268077055' }
    expect(getChannelChatId('telegram', env)).toBe('1268077055')
  })

  it('reads SLACK_CHANNEL_ID for slack', () => {
    const env = { SLACK_CHANNEL_ID: 'C01234ABCDE' }
    expect(getChannelChatId('slack', env)).toBe('C01234ABCDE')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelChatId('telegram', {})).toBe('')
    expect(getChannelChatId('slack', {})).toBe('')
  })
})

describe('channelStateDir', () => {
  it('uses telegram subdirectory for telegram', () => {
    const dir = channelStateDir('telegram')
    expect(dir).toMatch(/\.claude\/channels\/telegram$/)
  })

  it('uses slack subdirectory for slack', () => {
    const dir = channelStateDir('slack')
    expect(dir).toMatch(/\.claude\/channels\/slack$/)
  })

  it('uses agent dir when provided', () => {
    const dir = channelStateDir('telegram', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/telegram')
  })
})

describe('formatMessage per provider', () => {
  it('telegram: converts markdown headers to bold', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('# Hello')).toContain('<b>Hello</b>')
  })

  it('telegram: converts **bold** to HTML', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('**bold**')).toBe('<b>bold</b>')
  })

  it('slack: converts markdown headers to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('# Hello')).toBe('*Hello*')
  })

  it('slack: converts **bold** to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('**bold**')).toBe('*bold*')
  })

  it('slack: converts links to mrkdwn format', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('slack: converts strikethrough', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('~~deleted~~')).toBe('~deleted~')
  })

  it('slack: converts checkboxes', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('- [ ] todo')).toContain(':white_square:')
    expect(p.formatMessage('- [x] done')).toContain(':white_check_mark:')
  })
})

describe('splitMessage per provider', () => {
  it('telegram: uses 4096 char limit', () => {
    const p = getProvider('telegram')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('slack: uses 4000 char limit', () => {
    const p = getProvider('slack')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000)
    }
  })
})

// MCPTOKEN807: busy-token probe -- a valid token that a webhook or another
// running install already owns must be rejected at save time with a human
// remedy, not die later as an opaque plugin -32000.
import { checkTelegramTokenBusy } from '../channel-provider.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url)
    const key = Object.keys(routes).find((k) => u.includes(k))
    const r = key ? routes[key] : {}
    return {
      status: r.status ?? 200,
      json: async () => r.body ?? {},
    } as Response
  }) as typeof fetch
}

describe('checkTelegramTokenBusy', () => {
  const TOKEN = '123456:TESTSECRETVALUE'

  it('reports webhook-bound tokens with the deleteWebhook remedy, without leaking the token', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: 'https://old-install.example/hook' } } },
    }))
    expect(r.busy).toBe(true)
    expect(r.reason).toBe('webhook')
    expect(r.error).toContain('deleteWebhook')
    expect(r.error).toContain('BotFather')
    expect(r.error).not.toContain(TOKEN)
    expect(r.error).not.toContain('TESTSECRETVALUE')
  })

  it('reports a competing poller on getUpdates 409 with the stop-or-new-bot remedy', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: '' } } },
      getUpdates: { status: 409 },
    }))
    expect(r.busy).toBe(true)
    expect(r.reason).toBe('poller')
    expect(r.error).toContain('409')
    expect(r.error).toContain('BotFather')
    expect(r.error).not.toContain(TOKEN)
  })

  it('passes a free token', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: '' } } },
      getUpdates: { status: 200, body: { ok: true, result: [] } },
    }))
    expect(r).toEqual({ busy: false })
  })

  it('is advisory: a probe network error lets the save through (getMe already proved connectivity)', async () => {
    const failing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const r = await checkTelegramTokenBusy(TOKEN, failing)
    expect(r.busy).toBe(false)
  })

  // The renderer-wiring lesson (INSTNODE806): the helper being correct proves
  // nothing about the route actually calling it. Lock the wiring structurally:
  // the setup handler must call the probe, and must skip it for a re-saved
  // identical token (its own live poller reads as busy).
  it('the channel setup route wires the busy probe in, gated on a token change', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(src).toMatch(/checkTelegramTokenBusy\(botToken\.trim\(\)\)/)
    expect(src).toMatch(/botToken\.trim\(\) !== currentToken/)
    expect(src.indexOf('checkTelegramTokenBusy(botToken')).toBeGreaterThan(src.indexOf('findBotTokenDuplicate'))
  })
})
