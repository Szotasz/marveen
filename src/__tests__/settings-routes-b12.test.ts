import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  validateSettingValue: vi.fn().mockReturnValue({ ok: true, value: true }),
  getEffectiveSettingValue: vi.fn().mockReturnValue(false),
  setOverride: vi.fn(),
  logConfigChange: vi.fn(),
  setStoreWriteActor: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Paths resolved from src/__tests__/ perspective
vi.mock('../config-registry.js', () => ({
  SETTINGS_REGISTRY: [{ key: 'test.key', type: 'boolean', default: false, description: 'Test', module: 'test', requiresRestart: false, valueSet: undefined, min: undefined, max: undefined, secret: false }],
  validateSettingValue: mocks.validateSettingValue,
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mocks.getEffectiveSettingValue,
  setOverride: mocks.setOverride,
}))
vi.mock('../db.js', () => ({ logConfigChange: mocks.logConfigChange }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: mocks.setStoreWriteActor }))
vi.mock('../logger.js', () => ({ logger: mocks.logger }))

import { tryHandleSettings } from '../web/routes/settings.js'

function makeCtx(opts: { method: string; path: string; body?: object }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body ? JSON.stringify(opts.body) : ''
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('settings route POST /api/settings -- setOverride failure (B12)', () => {
  it('returns 500 when setOverride fails (internal_error, unreachable key/value checks precede it)', async () => {
    // setOverride is only reached after key-found + value-valid checks pass.
    // Its failure is a server-side atomic-write error -> 500, not a client error.
    mocks.validateSettingValue.mockReturnValueOnce({ ok: true, value: true })
    mocks.setOverride.mockReturnValueOnce({ ok: false, error: 'Atomic write failed' })
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/settings',
      body: { key: 'test.key', value: true },
    })
    await tryHandleSettings(ctx)
    expect(status()).toBe(500)
    expect((body() as any).error).toBe('internal_error')
    // mutation guard: changing 500 -> 400 in settings.ts:68 turns this RED
  })

  it('returns 400 for missing key (required, client error not server error)', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/settings',
      body: { value: true },
    })
    await tryHandleSettings(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('required')
    // mutation guard: changing 400 -> 500 in settings.ts:38 turns this RED
  })

  it('returns 400 for invalid value (invalid_value, client error not server error)', async () => {
    mocks.validateSettingValue.mockReturnValueOnce({ ok: false, error: 'Value must be a boolean' })
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/settings',
      body: { key: 'test.key', value: 'notabool' },
    })
    await tryHandleSettings(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
    // mutation guard: changing 400 -> 500 in settings.ts:59 turns this RED
  })
})
