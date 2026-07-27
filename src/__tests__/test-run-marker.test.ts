import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Regression guard for 2026-07-27: the auth-recovery suite drove a REAL
// break-glass alert to the owner, indistinguishable from production. The
// requirement is labelling, not suppression: under a test runner every
// outbound owner notification carries a leading [TESZT] marker; in production
// it must NOT.

// Wire a fake channel so notifyChannel actually sends (config reads env at
// module load, and the work rule blanks CHANNEL_TOKEN/CHANNEL_CHAT_ID).
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, CHANNEL_PROVIDER: 'telegram', CHANNEL_TOKEN: 'fake-token', CHANNEL_CHAT_ID: '42' }
})

const sent: string[] = []
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: () => ({
      formatMessage: (t: string) => t,
      splitMessage: (t: string) => [t],
      sendMessage: async (_token: string, _chatId: string, text: string) => { sent.push(text) },
    }),
  }
})

import { markIfTestRun, TEST_RUN_PREFIX } from '../test-run-marker.js'
import { notifyChannel, notifySecurityEvent } from '../notify.js'
import { sendTelegramMessage } from '../web/telegram.js'

const savedVitest = process.env['VITEST']
const savedNodeEnv = process.env['NODE_ENV']

function enterProductionEnv(): void {
  delete process.env['VITEST']
  delete process.env['NODE_ENV']
}

function restoreEnv(): void {
  if (savedVitest === undefined) delete process.env['VITEST']
  else process.env['VITEST'] = savedVitest
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = savedNodeEnv
}

beforeEach(() => { sent.length = 0 })
afterEach(() => { restoreEnv(); vi.unstubAllGlobals() })

describe('markIfTestRun', () => {
  it('prefixes under a test runner and is idempotent', () => {
    expect(markIfTestRun('riasztas')).toBe(`${TEST_RUN_PREFIX}riasztas`)
    expect(markIfTestRun(`${TEST_RUN_PREFIX}riasztas`)).toBe(`${TEST_RUN_PREFIX}riasztas`)
  })

  it('does not prefix in production (no VITEST, no NODE_ENV=test)', () => {
    enterProductionEnv()
    expect(markIfTestRun('riasztas')).toBe('riasztas')
  })
})

describe('notifyChannel / notifySecurityEvent funnel', () => {
  it('sends the message WITH the [TESZT] prefix under a test runner', async () => {
    await notifyChannel('valami esemeny')
    expect(sent).toEqual([`${TEST_RUN_PREFIX}valami esemeny`])
  })

  it('security events (break-glass reset path) are prefixed too', async () => {
    await notifySecurityEvent('Break-glass jelszo-reset: "alice"')
    expect(sent).toEqual([`${TEST_RUN_PREFIX}Break-glass jelszo-reset: "alice"`])
  })

  it('sends WITHOUT prefix in production', async () => {
    enterProductionEnv()
    await notifyChannel('eles riasztas')
    expect(sent).toEqual(['eles riasztas'])
  })
})

describe('getProvider wrapper (every provider send, not only notifyChannel)', () => {
  // Uses the REAL getProvider (vi.importActual bypasses the mock above) with a
  // stubbed fetch: agent-process / channel-monitor / agent routes all send
  // through providers directly, so the marking must live at this level too.
  it('marks provider.sendMessage under a test runner', async () => {
    const real = await vi.importActual<typeof import('../channel-provider.js')>('../channel-provider.js')
    const bodies: any[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'))
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' }
    })
    await real.getProvider('slack').sendMessage('fake-token', 'C123', 'provider szintu uzenet')
    expect(bodies[0].text).toBe(`${TEST_RUN_PREFIX}provider szintu uzenet`)
  })

  it('does not mark provider.sendMessage in production', async () => {
    enterProductionEnv()
    const real = await vi.importActual<typeof import('../channel-provider.js')>('../channel-provider.js')
    const bodies: any[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'))
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' }
    })
    await real.getProvider('slack').sendMessage('fake-token', 'C123', 'eles uzenet')
    expect(bodies[0].text).toBe('eles uzenet')
  })
})

describe('sendTelegramMessage direct Bot API funnel (schedule-runner path)', () => {
  // This path reads its token from .env FILES, so blanking the channel env
  // does not stop it -- the marker must be applied here independently.
  function stubFetch(): { bodies: any[] } {
    const captured: { bodies: any[] } = { bodies: [] }
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      captured.bodies.push(JSON.parse(init?.body ?? '{}'))
      return { ok: true, text: async () => '' }
    })
    return captured
  }

  it('prefixes under a test runner', async () => {
    const captured = stubFetch()
    await sendTelegramMessage('fake-token', '42', 'scheduler riasztas')
    expect(captured.bodies[0].text).toBe(`${TEST_RUN_PREFIX}scheduler riasztas`)
  })

  it('does not prefix in production', async () => {
    enterProductionEnv()
    const captured = stubFetch()
    await sendTelegramMessage('fake-token', '42', 'scheduler riasztas')
    expect(captured.bodies[0].text).toBe('scheduler riasztas')
  })
})
