// The Channels tab's toasts come from the language files: connecting a channel, the connection
// test, the Channel-MCP reconnect, the Slack smoke test, and the pairing, allow-list, invite and
// channel-request actions; so do the labels of the reconnect and smoke-test buttons and the
// "connecting" spinner. They used to be Hungarian strings in app.js and index.html, so an English
// dashboard showed them in Hungarian.
// The real handlers run here against the real t() and both language files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
const HU_SRC = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN_SRC = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const I18N = (() => {
  const window: { _i18n?: Record<string, Record<string, string>> } = {}
  new Function('window', `${HU_SRC}\n${EN_SRC}`)(window)
  return window._i18n!
})()

// The real t() from the top of app.js, with the language picked per call.
const T_SRC = (() => {
  const i = APP.indexOf('window.t = function t(')
  const end = APP.indexOf('\n  }\n', i)
  return APP.slice(APP.indexOf('function t(', i), end + 4)
})()
function makeT(lang: 'hu' | 'en') {
  const window = { _lang: lang, _i18n: I18N, _brandTokens: { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' } }
  return new Function('window', 'localStorage', `return ${T_SRC}`)(window, { getItem: () => null }) as (k: string, p?: Record<string, unknown>) => string
}

// From `anchor` (where `opener` starts) up to the matching closing brace.
function block(anchor: string, opener: string): string {
  const i = APP.indexOf(anchor)
  if (i < 0) return ''
  const start = APP.indexOf(opener, i)
  let depth = 0
  for (let j = APP.indexOf('{', start); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1)
  }
  return ''
}
const arrowAfter = (anchor: string) => block(anchor, 'async () => {')
const fn = (name: string) => block(`\nasync function ${name}(`, 'async function')

const CONNECT = arrowAfter("document.getElementById('chConnectBtn').addEventListener('click', ")
const TEST = arrowAfter("document.getElementById('chTestBtn').addEventListener('click', ")
const RECONNECT = arrowAfter("document.getElementById('chReconnectBtn').addEventListener('click', ")
const SMOKE = arrowAfter("document.getElementById('chSmokeTestBtn').addEventListener('click', ")
const APPROVE_PAIRING = fn('approvePairing')
const REMOVE_ALLOWED = fn('removeAllowed')
const GENERATE_INVITE = fn('generateInvite')
const REVOKE_INVITE = fn('revokeInviteToken')
const SUBMIT_APPROVE = fn('submitApproveModal')
const DENY_REQUEST = fn('denyChannelRequest')
const HANDLERS = {
  CONNECT, TEST, RECONNECT, SMOKE, APPROVE_PAIRING, REMOVE_ALLOWED,
  GENERATE_INVITE, REVOKE_INVITE, SUBMIT_APPROVE, DENY_REQUEST,
}

const btn = () => {
  const part = { hidden: false }
  return { disabled: false, hidden: false, textContent: 'label', value: '', focus() {}, querySelector: () => part }
}
const doc = { getElementById: () => btn() }

describe('the Channels tab toasts come from the language files', () => {
  it('the handlers were found, and none of them holds a Hungarian string any more', () => {
    for (const [name, src] of Object.entries(HANDLERS)) {
      expect(src, name).not.toBe('')
      const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code, name).not.toMatch(/[áéíóöőúüű]/i)
      expect(code, name).not.toMatch(/'Hiba|`Hiba|Sikertelen|sikertelen|sikeres|rendben|Kapcsolod|reconnect hiba|Smoke-test/)
    }
  })

  it('an error is shown as "<common.error>: <message>" at all seven places', () => {
    for (const src of [CONNECT, APPROVE_PAIRING, REMOVE_ALLOWED, GENERATE_INVITE, REVOKE_INVITE, SUBMIT_APPROVE, DENY_REQUEST]) {
      expect(src).toContain("showToast(`${t('common.error')}: ${err.message}`)")
    }
  })

  describe('connecting a channel', () => {
    async function connect(lang: 'hu' | 'en', reply: { status: number; data: Record<string, unknown> }) {
      const toasts: string[] = []
      const field = { ...btn(), value: '123:abc' }
      const handler = new Function(
        'currentAgent', 'document', 'currentChannelProvider', 'channelApiBase', 'fetch', 'showSudoModal', 't', 'showToast',
        'getProviderLabel', 'mainAgentId', 'refreshMainChannelUnconfBanner', 'openAgentDetail', 'loadAgents', `return ${CONNECT}`,
      )(
        { name: 'anna' }, { getElementById: (id: string) => (id === 'chTokenInput' ? field : btn()) }, 'telegram',
        () => '/api/agents/anna/channel',
        async () => ({ status: reply.status, ok: reply.status < 300, json: async () => reply.data }),
        () => {}, makeT(lang), (m: string) => { toasts.push(m) },
        () => 'Telegram', () => 'marveen', async () => {}, async () => {}, () => {},
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('says the channel is connected, in both languages', async () => {
      expect(await connect('hu', { status: 200, data: {} })).toEqual(['Telegram sikeresen csatlakoztatva!'])
      expect(await connect('en', { status: 200, data: {} })).toEqual(['Telegram connected successfully!'])
    })

    it('a failure without a server error says "connection error"; the server error still wins', async () => {
      expect(await connect('hu', { status: 500, data: {} })).toEqual(['Hiba: Kapcsolódási hiba'])
      expect(await connect('en', { status: 500, data: {} })).toEqual(['Error: Connection error'])
      expect(await connect('en', { status: 400, data: { error: 'Invalid token' } })).toEqual(['Error: Invalid token'])
    })
  })

  describe('the connection test', () => {
    async function test(lang: 'hu' | 'en', data: Record<string, unknown>) {
      const toasts: string[] = []
      const handler = new Function('currentAgent', 'channelApiBase', 'fetch', 't', 'showToast', `return ${TEST}`)(
        { name: 'anna' }, () => '/api/agents/anna/channel',
        async () => ({ ok: true, json: async () => data }),
        makeT(lang), (m: string) => { toasts.push(m) },
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('says the connection is OK, in both languages, with the Teams note after it', async () => {
      expect(await test('hu', {})).toEqual(['Kapcsolat rendben!'])
      expect(await test('en', {})).toEqual(['Connection OK!'])
      expect(await test('en', { secretExpiry: { state: 'expired', date: '2026-01-01' } }))
        .toEqual([`Connection OK! ${makeT('en')('channel.toast.teams_secret_expiry_expired', { date: '2026-01-01' })}`])
    })
  })

  describe('the Channel-MCP reconnect', () => {
    async function reconnect(lang: 'hu' | 'en', reply: Record<string, unknown> | 'throw') {
      const toasts: string[] = []
      const handler = new Function('currentAgent', 'document', 't', 'fetch', 'showToast', `return ${RECONNECT}`)(
        { name: 'anna' }, doc, makeT(lang),
        async () => {
          if (reply === 'throw') throw new Error('net')
          return { json: async () => reply }
        },
        (m: string) => { toasts.push(m) },
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('done, failed and the error, in both languages; the server message still wins', async () => {
      expect(await reconnect('hu', { ok: true })).toEqual(['Channel-MCP újracsatlakoztatva'])
      expect(await reconnect('en', { ok: true })).toEqual(['Channel-MCP reconnected'])
      expect(await reconnect('hu', { ok: false })).toEqual(['Az újracsatlakozás sikertelen'])
      expect(await reconnect('en', { ok: false })).toEqual(['Reconnect failed'])
      expect(await reconnect('en', { ok: false, message: 'Session not running' })).toEqual(['Session not running'])
      expect(await reconnect('hu', 'throw')).toEqual(['Hiba az újracsatlakozás során'])
      expect(await reconnect('en', 'throw')).toEqual(['Error while reconnecting'])
    })
  })

  describe('the Slack smoke test', () => {
    async function smoke(lang: 'hu' | 'en', reply: { status: number; data: Record<string, unknown> } | 'throw') {
      const toasts: string[] = []
      const handler = new Function('currentAgent', 'document', 't', 'fetch', 'showToast', 'showSmokeTestResult', `return ${SMOKE}`)(
        { name: 'anna' }, doc, makeT(lang),
        async () => {
          if (reply === 'throw') throw new Error('net')
          return { ok: reply.status < 300, json: async () => reply.data }
        },
        (m: string) => { toasts.push(m) }, () => {},
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('failed and the error, in both languages; the server error still wins', async () => {
      expect(await smoke('hu', { status: 500, data: {} })).toEqual(['A smoke-test sikertelen'])
      expect(await smoke('en', { status: 500, data: {} })).toEqual(['Smoke test failed'])
      expect(await smoke('en', { status: 500, data: { error: 'Script missing' } })).toEqual(['Script missing'])
      expect(await smoke('hu', 'throw')).toEqual(['Hiba a smoke-test során'])
      expect(await smoke('en', 'throw')).toEqual(['Error while running the smoke test'])
    })
  })

  describe('the fallbacks without a server error read "<error>: <unknown>"', () => {
    it.each([
      ['hu', 'Hiba: Ismeretlen'],
      ['en', 'Error: Unknown'],
    ] as const)('generating an invite and denying a request (%s)', async (lang, want) => {
      const toasts: string[] = []
      const refused = async () => ({ ok: false, json: async () => ({}) })
      const gen = new Function('currentAgent', 'document', 't', 'fetch', 'channelApiBase', 'showToast', 'refreshInvites', 'navigator', `return ${GENERATE_INVITE}`)(
        { name: 'anna' }, doc, makeT(lang), refused, () => '/api/agents/anna/channel', (m: string) => { toasts.push(m) }, () => {}, {},
      ) as () => Promise<void>
      await gen()
      const deny = new Function('currentAgent', 't', 'fetch', 'showToast', 'refreshChannelRequests', `return ${DENY_REQUEST}`)(
        { name: 'anna' }, makeT(lang), refused, (m: string) => { toasts.push(m) }, () => {},
      ) as (id: number, el?: unknown) => Promise<void>
      await deny(1)
      expect(toasts).toEqual([want, want])
    })
  })

  it('the reconnect and smoke-test buttons and the "connecting" spinner are labelled from the language files', () => {
    const t = { hu: makeT('hu'), en: makeT('en') }
    const reconnect = /<button [^>]*id="chReconnectBtn"[^>]*>/.exec(HTML)?.[0] ?? ''
    const smoke = /<button [^>]*id="chSmokeTestBtn"[^>]*>/.exec(HTML)?.[0] ?? ''
    const connectBtn = /<button [^>]*id="chConnectBtn"[^>]*>[\s\S]*?<\/button>/.exec(HTML)?.[0] ?? ''
    expect(reconnect).toContain('data-i18n="channel.reconnect_btn"')
    expect(smoke).toContain('data-i18n="channel.smoke_test_btn"')
    expect(connectBtn).toMatch(/class="btn-loading"[^>]*>.*data-i18n="channel\.connecting"/)
    expect(connectBtn).not.toMatch(/Csatlakozas/)
    for (const [key, hu, en] of [
      ['channel.reconnect_btn', 'Channel-MCP újracsatlakoztatása', 'Reconnect Channel-MCP'],
      ['channel.smoke_test_btn', 'Slack-csatorna smoke-test', 'Slack channel smoke test'],
      ['channel.connecting', 'Csatlakozás...', 'Connecting...'],
    ]) {
      expect(t.hu(key), key).toBe(hu)
      expect(t.en(key), key).toBe(en)
    }
  })
})
