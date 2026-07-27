import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import {
  createDeviceKey,
  resolveDeviceKey,
  listDeviceKeys,
  revokeDeviceKey,
  revokeAllDeviceKeys,
  sweepExpiredDeviceKeys,
  _clearDeviceKeyCacheForTest,
} from '../web/auth-device-keys.js'
import type { RouteContext } from '../web/routes/types.js'

// AUTHPLAN1 #1 -- per-device keys. Contract under test:
//   - a minted key authenticates as { kind: 'device' } on the Bearer lane and
//     the SSE ?token= lane, and NOWHERE gains the dashboard token's powers on
//     access-granting endpoints (the #0 allowlists must hold against a REAL
//     device principal, not just the simulated one);
//   - only sha256(key) is stored; the raw value round-trips through mint only;
//   - zero rows = zero behavior change (fresh-install guarantee);
//   - revocation and (opt-in) expiry take effect immediately;
//   - keys survive a process restart (cache cleared -> DB rehydrates).

const TOKEN = 'a'.repeat(64)

function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

function mkUrl(path: string, query = ''): URL {
  return new URL(`http://127.0.0.1:3420${path}${query}`)
}

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth'] } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  const ctx: RouteContext = {
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  }
  const handled = await tryHandleAuth(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
})

describe('fresh-install guarantee (zero rows)', () => {
  it('an arbitrary mvdk_-shaped bearer resolves to none with no device_keys rows', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer mvdk_doesnotexist' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('the dashboard-token bearer lane is untouched', () => {
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
})

describe('mint + storage discipline', () => {
  it('mints a prefixed key and stores ONLY its sha256', () => {
    const minted = createDeviceKey('phone')
    expect(minted.key.startsWith('mvdk_')).toBe(true)
    const rows = getDb().prepare('SELECT key_hash, name FROM device_keys').all() as { key_hash: string; name: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('phone')
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]!.key_hash).not.toContain(minted.key)
  })
  it('list exposes metadata but never the raw key or its hash', () => {
    createDeviceKey('bridge')
    const keys = listDeviceKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toEqual({
      id: expect.any(Number),
      name: 'bridge',
      createdAt: expect.any(Number),
      lastUsedAt: null,
      expiresAt: null,
      installId: null,
    })
  })
})

describe('gate integration (Bearer + SSE lanes)', () => {
  it('a minted key authenticates as kind device on the Bearer lane', () => {
    const minted = createDeviceKey('bridge')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${minted.key}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'device', device: 'bridge', deviceId: minted.id })
  })
  it('the dashboard token still wins precedence (checked first)', () => {
    createDeviceKey('bridge')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
  it('a device key works on the SSE pane-stream ?token= lane', () => {
    const minted = createDeviceKey('phone')
    const path = '/api/agents/zara/pane/stream'
    const r = resolveAuth(mkReq(), mkUrl(path, `?token=${minted.key}`), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'device', device: 'phone', deviceId: minted.id })
  })
  it('a device key is NOT honored via ?token= on a non-SSE path', () => {
    const minted = createDeviceKey('phone')
    const r = resolveAuth(mkReq(), mkUrl('/api/memories', `?token=${minted.key}`), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('a wrong device key resolves to none', () => {
    createDeviceKey('bridge')
    const r = resolveAuth(mkReq({ authorization: 'Bearer mvdk_wrong' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('restart survival', () => {
  it('resolves a key from the DB after the in-memory cache is dropped', () => {
    const minted = createDeviceKey('bridge')
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(minted.key)).toEqual({ id: minted.id, name: 'bridge' })
  })
  it('tracks last_used on resolve', () => {
    const minted = createDeviceKey('bridge')
    resolveDeviceKey(minted.key)
    expect(listDeviceKeys()[0]!.lastUsedAt).toBeGreaterThan(0)
  })
})

describe('revocation + expiry', () => {
  it('revocation takes effect immediately, cache and DB together', () => {
    const minted = createDeviceKey('stolen-phone')
    expect(resolveDeviceKey(minted.key)).not.toBeNull()
    expect(revokeDeviceKey(minted.id)).toBe(true)
    expect(resolveDeviceKey(minted.key)).toBeNull()
    expect(listDeviceKeys()).toHaveLength(0)
  })
  it('revoking an unknown id returns false', () => {
    expect(revokeDeviceKey(99999)).toBe(false)
  })
  it('an expired key is rejected and deleted on first use', () => {
    const minted = createDeviceKey('short-lived', { expiresInDays: 1 })
    getDb().prepare('UPDATE device_keys SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, minted.id)
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(minted.key)).toBeNull()
    expect(listDeviceKeys()).toHaveLength(0)
  })
  it('a key WITHOUT expiry is never swept', () => {
    createDeviceKey('immortal')
    const mortal = createDeviceKey('mortal', { expiresInDays: 1 })
    getDb().prepare('UPDATE device_keys SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, mortal.id)
    expect(sweepExpiredDeviceKeys()).toBe(1)
    expect(listDeviceKeys().map((k) => k.name)).toEqual(['immortal'])
  })
  it('revokeAllDeviceKeys clears everything (security:reset path)', () => {
    const a = createDeviceKey('a')
    const b = createDeviceKey('b')
    expect(revokeAllDeviceKeys()).toBe(2)
    expect(resolveDeviceKey(a.key)).toBeNull()
    expect(resolveDeviceKey(b.key)).toBeNull()
  })
})

describe('management endpoints (mint/list/revoke)', () => {
  it('token mints a key; the raw value appears in the response ONCE and never in list', async () => {
    const r = await call('POST', '/api/auth/device-keys', { auth: TOKEN_AUTH, body: { name: 'MacBook Bridge' } })
    expect(r.res.statusCode).toBe(201)
    const body = r.json()
    expect(String(body.key).startsWith('mvdk_')).toBe(true)
    expect(body.expires_at).toBeNull()
    const list = await call('GET', '/api/auth/device-keys', { auth: TOKEN_AUTH })
    expect(JSON.stringify(list.json())).not.toContain(String(body.key))
  })
  it('session may mint too (operator parity with token)', async () => {
    const r = await call('POST', '/api/auth/device-keys', { auth: { kind: 'session', user: 'op' }, body: { name: 'phone' } })
    expect(r.res.statusCode).toBe(201)
  })
  it('mint validates the name', async () => {
    const r = await call('POST', '/api/auth/device-keys', { auth: TOKEN_AUTH, body: { name: '' } })
    expect(r.res.statusCode).toBe(400)
  })
  it('mint validates expires_in_days', async () => {
    const r = await call('POST', '/api/auth/device-keys', { auth: TOKEN_AUTH, body: { name: 'x', expires_in_days: -5 } })
    expect(r.res.statusCode).toBe(400)
    const r2 = await call('POST', '/api/auth/device-keys', { auth: TOKEN_AUTH, body: { name: 'x', expires_in_days: 30 } })
    expect(r2.res.statusCode).toBe(201)
    expect(r2.json().expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
  it('DELETE revokes by id; the key stops resolving', async () => {
    const minted = await call('POST', '/api/auth/device-keys', { auth: TOKEN_AUTH, body: { name: 'phone' } })
    const { id, key } = minted.json() as { id: number; key: string }
    const del = await call('DELETE', `/api/auth/device-keys/${id}`, { auth: TOKEN_AUTH })
    expect(del.res.statusCode).toBe(200)
    expect(resolveDeviceKey(key)).toBeNull()
    const again = await call('DELETE', `/api/auth/device-keys/${id}`, { auth: TOKEN_AUTH })
    expect(again.res.statusCode).toBe(404)
  })
})

describe('a REAL device principal stays locked out of access-granting endpoints', () => {
  // #0 asserted this with a simulated kind; here the principal comes from an
  // actually minted key, closing the loop end-to-end.
  function realDeviceAuth(): RouteContext['auth'] {
    const minted = createDeviceKey('real-device')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${minted.key}` }), mkUrl('/api/auth/status'), '/api/auth/status', 'GET', TOKEN)
    expect(r.kind).toBe('device')
    return r.kind === 'device' ? { kind: 'device', device: r.device } : undefined
  }

  it('device cannot mint, list, or revoke device keys (no self-propagation)', async () => {
    const auth = realDeviceAuth()
    expect((await call('POST', '/api/auth/device-keys', { auth, body: { name: 'evil' } })).res.statusCode).toBe(403)
    expect((await call('GET', '/api/auth/device-keys', { auth })).res.statusCode).toBe(403)
    expect((await call('DELETE', '/api/auth/device-keys/1', { auth })).res.statusCode).toBe(403)
    expect(listDeviceKeys().map((k) => k.name)).toEqual(['real-device'])
  })

  it('device cannot manage users or break-glass-reset a password', async () => {
    const auth = realDeviceAuth()
    expect((await call('GET', '/api/auth/users', { auth })).res.statusCode).toBe(403)
    expect((await call('POST', '/api/auth/users', { auth, body: { username: 'evil', password: 'x'.repeat(16) } })).res.statusCode).toBe(403)
    expect((await call('POST', '/api/auth/password', { auth, body: { username: 'anyone', new_password: 'x'.repeat(16) } })).res.statusCode).toBe(403)
  })

  it('status reports the device principal as authenticated with its name', async () => {
    const auth = realDeviceAuth()
    const r = await call('GET', '/api/auth/status', { auth })
    const body = r.json()
    expect(body.authenticated).toBe(true)
    expect(body.method).toBe('device')
    expect(body.device).toBe('real-device')
    expect(body.user).toBeNull()
  })
})
