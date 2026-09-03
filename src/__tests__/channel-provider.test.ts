import { describe, it, expect, afterAll } from 'vitest'
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

// readChannelToken is the single parser behind the scheduler-alert token
// fallback (marveen/.env -> channel .env), agentHasChannel/hasChannel and ten
// other call sites. Its regex used to be unanchored, so a commented-out
// `# SLACK_BOT_TOKEN=old` in marveen/.env matched first and shadowed the live
// token in the channel .env -- exactly the fallback the alert path relies on
// after a token rotation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readChannelToken } from '../channel-provider.js'

describe('readChannelToken (anchored, whole-line match)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-channel-token-'))
  const envFile = (body: string): string => {
    const p = join(dir, `${Math.random().toString(36).slice(2)}.env`)
    writeFileSync(p, body)
    return p
  }
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the provider key from a plain line, tolerating indentation and CRLF', () => {
    expect(readChannelToken('slack', envFile('SLACK_BOT_TOKEN=xoxb-live\n'))).toBe('xoxb-live')
    expect(readChannelToken('telegram', envFile('  TELEGRAM_BOT_TOKEN=111:live  \r\n'))).toBe('111:live')
  })

  it('ignores a commented-out key (a dead token must not shadow the fallback)', () => {
    expect(readChannelToken('slack', envFile('# SLACK_BOT_TOKEN=xoxb-dead\n'))).toBeNull()
    expect(readChannelToken('slack', envFile('# SLACK_BOT_TOKEN=xoxb-dead\nSLACK_BOT_TOKEN=xoxb-live\n'))).toBe('xoxb-live')
    expect(readChannelToken('slack', envFile('SLACK_BOT_TOKEN=xoxb-live\n# SLACK_BOT_TOKEN=xoxb-dead\n'))).toBe('xoxb-live')
  })

  it('ignores a key that merely ends with the provider key', () => {
    expect(readChannelToken('telegram', envFile('OLD_TELEGRAM_BOT_TOKEN=111:old\n'))).toBeNull()
    expect(readChannelToken('telegram', envFile('OLD_TELEGRAM_BOT_TOKEN=111:old\nTELEGRAM_BOT_TOKEN=222:live\n'))).toBe('222:live')
  })

  it('does not confuse SLACK_APP_TOKEN with SLACK_BOT_TOKEN', () => {
    expect(readChannelToken('slack', envFile('SLACK_APP_TOKEN=xapp-1\n'))).toBeNull()
    // Neither of these two pins the anchor: on the unanchored regex both were
    // already null (`SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN_OLD` contain no
    // `SLACK_BOT_TOKEN=` substring). They guard naming drift. The case that
    // DOES pin it is `OLD_TELEGRAM_BOT_TOKEN=` above -- a key ENDING with ours.
    expect(readChannelToken('slack', envFile('SLACK_BOT_TOKEN_OLD=xoxb-old\n'))).toBeNull()
  })

  it('ignores a comment written without a space after the hash', () => {
    // `sed -i 's/^KEY=/#KEY=/'` -- the form an operator actually produces when
    // disabling a token by hand, and the one measured on the live install.
    expect(readChannelToken('telegram', envFile('#TELEGRAM_BOT_TOKEN=111:dead\n'))).toBeNull()
    expect(readChannelToken('telegram', envFile('#TELEGRAM_BOT_TOKEN=111:dead\nTELEGRAM_BOT_TOKEN=222:live\n'))).toBe('222:live')
    expect(readChannelToken('telegram', envFile('   # TELEGRAM_BOT_TOKEN=111:dead\n'))).toBeNull()
  })

  it('an empty value is not a token, so the caller falls through to the next location', () => {
    // Documents behaviour rather than guarding the anchor (`(.+)` already
    // refused an empty value before the fix): resolveSchedulerAlertToken
    // chains marveen/.env || channel .env, and a key left with no value must
    // not win that chain.
    expect(readChannelToken('telegram', envFile('TELEGRAM_BOT_TOKEN=\n'))).toBeNull()
    expect(readChannelToken('telegram', envFile('TELEGRAM_BOT_TOKEN=\nTELEGRAM_BOT_TOKEN=222:live\n'))).toBe('222:live')
  })

  it('a commented-out presence key no longer counts as a configured channel', () => {
    // hasChannel/agentHasChannel use the same reader for creds-based providers.
    expect(readChannelToken('googlechat', envFile('# GOOGLECHAT_PROJECT_ID=p1\n'))).toBeNull()
    expect(readChannelToken('googlechat', envFile('GOOGLECHAT_PROJECT_ID=p1\n'))).toBe('p1')
  })

  it('missing file -> null', () => {
    expect(readChannelToken('slack', join(dir, 'nope.env'))).toBeNull()
  })
})
