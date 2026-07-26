import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, createDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { securityReset } from '../web/security-reset.js'
import {
  createDeviceKey,
  resolveDeviceKey,
  listDeviceKeys,
  _clearDeviceKeyCacheForTest,
} from '../web/auth-device-keys.js'
import {
  createSession,
  resolveSession,
  _clearSessionCacheForTest,
} from '../web/auth-sessions.js'
import type { RouteContext } from '../web/routes/types.js'

// AUTHPLAN1 #5 -- recovery paths. Contract under test:
//   - securityReset revokes every device key AND every browser session in one
//     step, leaves users/passwords in place, and writes an audit row;
//   - the HTTP break-glass password reset (token, no current_password) writes
//     an audit row carrying the target username, never the password;
//   - out-of-band revocation (a different process deleting rows, as the CLI
//     does) is honored by a LIVE process's cache within the 60s debounce:
//     the debounced write doubles as an existence check.

function mkRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    end(data?: string) {
      if (data !== undefined) this.body += data
    },
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth'] } = {},
): Promise<{ statusCode: number; body: string }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  await tryHandleAuth({
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  })
  return { statusCode: res.statusCode, body: res.body }
}

const GOOD_PW = 'super-secret-pw-123'

function auditRows(key: string): Array<{ key: string; new_value: string | null; actor: string }> {
  return getDb()
    .prepare('SELECT key, new_value, actor FROM config_change_log WHERE key = ? ORDER BY id')
    .all(key) as Array<{ key: string; new_value: string | null; actor: string }>
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  _clearSessionCacheForTest()
  const db = getDb()
  db.prepare('DELETE FROM device_keys').run()
  db.prepare('DELETE FROM auth_sessions').run()
  db.prepare('DELETE FROM dashboard_users').run()
  db.prepare('DELETE FROM config_change_log').run()
})

describe('securityReset', () => {
  it('revokes all device keys and sessions, keeps users, audits the counts', async () => {
    const u = createDashboardUser('op', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const key = createDeviceKey('phone')
    const cookie = createSession({ userId: u.id, username: u.username })
    expect(resolveDeviceKey(key.key)).not.toBeNull()
    expect(resolveSession(cookie)).not.toBeNull()

    const r = securityReset('test')
    expect(r).toEqual({ deviceKeysRevoked: 1, sessionsCleared: 1 })
    expect(resolveDeviceKey(key.key)).toBeNull()
    expect(resolveSession(cookie)).toBeNull()
    expect(listDeviceKeys()).toHaveLength(0)
    // The user (and their password hash) survive: this is not a factory reset.
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM dashboard_users').get()).toEqual({ c: 1 })

    const rows = auditRows('security.reset')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('test')
    expect(rows[0]!.new_value).toBe('device_keys=1 sessions=1')
  })

  it('is a safe no-op on an empty install', () => {
    expect(securityReset('test')).toEqual({ deviceKeysRevoked: 0, sessionsCleared: 0 })
  })
})

describe('HTTP break-glass password reset audit', () => {
  it('writes an audit row with the target username on the token path', async () => {
    const mk = await call('POST', '/api/auth/users', { auth: { kind: 'token' }, body: { username: 'alice', password: GOOD_PW } })
    expect(mk.statusCode).toBe(201)
    const r = await call('POST', '/api/auth/password', { auth: { kind: 'token' }, body: { username: 'alice', new_password: GOOD_PW + 'x' } })
    expect(r.statusCode).toBe(200)
    const rows = auditRows('security.break_glass_password_reset')
    expect(rows).toHaveLength(1)
    expect(rows[0]!).toEqual({ key: 'security.break_glass_password_reset', new_value: 'alice', actor: 'token' })
    // Never credential material in the trail.
    const all = JSON.stringify(getDb().prepare('SELECT * FROM config_change_log').all())
    expect(all).not.toContain(GOOD_PW)
  })

  it('does NOT audit a normal session-path password change as break-glass', async () => {
    await call('POST', '/api/auth/users', { auth: { kind: 'token' }, body: { username: 'bob', password: GOOD_PW } })
    getDb().prepare('DELETE FROM config_change_log').run()
    const r = await call('POST', '/api/auth/password', {
      auth: { kind: 'session', user: 'bob' },
      body: { current_password: GOOD_PW, new_password: GOOD_PW + 'y' },
    })
    expect(r.statusCode).toBe(200)
    expect(auditRows('security.break_glass_password_reset')).toHaveLength(0)
  })
})

describe('out-of-band revocation reaches a live cache (CLI -> running server)', () => {
  it('a cached device key stops resolving once its row is gone and the debounce fires', () => {
    const minted = createDeviceKey('phone')
    expect(resolveDeviceKey(minted.key)).not.toBeNull() // cached, last_used stamped

    // Simulate the CLI process: delete the row directly, bypassing the cache.
    getDb().prepare('DELETE FROM device_keys').run()

    // Age the cached last_used past the debounce so the next resolve writes --
    // and the write's 0-changes result must evict + reject.
    getDb() // (cache holds lastUsedAt=now; rewind it via the test seam below)
    // No seam for the cache timestamp: emulate the >=60s gap by clearing the
    // cache's knowledge of the stamp through a fresh entry -- a cache MISS also
    // goes to the DB and must reject.
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(minted.key)).toBeNull()
  })

  it('a WARM cache entry is evicted by the debounced existence check (no restart, no cache clear)', () => {
    const minted = createDeviceKey('phone')
    expect(resolveDeviceKey(minted.key)).not.toBeNull() // cache warm, last_used stamped now
    // Out-of-band delete with the cache warm and its stamp fresh...
    getDb().prepare('DELETE FROM device_keys').run()
    // ...a resolve within the debounce window still serves the cache (the documented <=60s staleness):
    expect(resolveDeviceKey(minted.key)).not.toBeNull()
    // ...but once the stamp is old enough that the debounced write fires, the
    // 0-changes result must evict and reject:
    ageDeviceKeyCacheStamp(minted.key, 120)
    expect(resolveDeviceKey(minted.key)).toBeNull()
    expect(resolveDeviceKey(minted.key)).toBeNull() // stays evicted
  })

  it('a cached session stops resolving after its row is deleted out-of-band', () => {
    const u = createDashboardUser('op2', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    expect(resolveSession(cookie)).not.toBeNull()
    getDb().prepare('DELETE FROM auth_sessions').run()
    ageSessionCacheStamp(cookie, 120)
    expect(resolveSession(cookie)).toBeNull()
  })
})

// --- helpers reaching into the modules' storage representation ---

import { createHash } from 'node:crypto'
function sha256hexOf(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

// Age an in-memory cache stamp so the next resolve crosses the 60s debounce
// without sleeping, via the modules' exported cache seams.
import { _cacheForTest as deviceKeyCache } from '../web/auth-device-keys.js'
import { _cacheForTest as sessionCache } from '../web/auth-sessions.js'

function ageDeviceKeyCacheStamp(rawKey: string, seconds: number): void {
  const e = deviceKeyCache.get(sha256hexOf(rawKey))
  if (!e) throw new Error('device key not in cache')
  if (e.lastUsedAt !== null) e.lastUsedAt -= seconds
}

function ageSessionCacheStamp(cookie: string, seconds: number): void {
  const e = sessionCache.get(sha256hexOf(cookie))
  if (!e) throw new Error('session not in cache')
  e.lastSeenAt -= seconds
}
