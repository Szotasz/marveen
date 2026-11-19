// The agent package credential and catalog routes (MIOAGENTINSTALL1114, PR-I2; plan 6, 6.4, 6.5, 10.2 (3)).
//
// Through tryHandleAgentPackages with its deps: the Remote is makeRemote(TEST_ORIGIN) over the in-memory fake server
// (helpers/agent-package-fake-server.ts), the store is a temp dir, the owner gate is the REAL one over an in-memory
// database. Mutant rows 11, 12, 13, 14, 16 and 45 of plan 10.4 are pinned here.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-routes-'))
const STORE = join(tmpRoot, 'store')
mkdirSync(STORE, { recursive: true })
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }))

const logged: unknown[][] = []
vi.mock('../logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args) }
  const l: any = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec }
  l.child = () => l
  return { logger: l }
})

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAgentPackages, normalizeLinkCode, RELEASED_DEPS } = await import('../web/routes/agent-packages.js')
const remote = await import('../web/agent-package/remote.js')
const { makeRemote, refusalFor, removeCredentialTmpLeftovers, CATALOG_MAX_BYTES, REDEEM_TIMEOUT_MS, REQUEST_TIMEOUT_MS } = remote
import { TEST_DEVICE_ID, TEST_ORIGIN, TEST_TOKEN, callRoute, makeFakeServer, type FakeServer } from './helpers/agent-package-fake-server.js'
import type { PackageDeps } from '../web/routes/agent-packages.js'
import type { RouteContext } from '../web/routes/types.js'

const CRED = join(STORE, 'agent-package-credential.json')
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const TOKEN_ONLY: RouteContext['auth'] = { kind: 'token' }
const NOW = new Date('2026-11-16T10:00:00.000Z')
const CODE = 'ABCD-EFGH2345'
const STORED = { schema: 1, token: TEST_TOKEN, deviceTokenId: TEST_DEVICE_ID, label: 'Office Mac', connectedAt: '2026-11-01T08:00:00.000Z' }
const NEW_ID = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4'
const REDEEM_OK = { token: TEST_TOKEN, device_token_id: NEW_ID, label: 'Home Mac', idle_expiry_days: 90 }
const CATALOG = { access: 'trial', trial_pick: null, packages: [{ slug: 'invoice-helper', version: '1.2.0' }] }

let fake: FakeServer
let deps: PackageDeps
const call = (method: string, path: string, auth: RouteContext['auth'] = SESSION, body?: unknown, d: PackageDeps = deps, headers?: Record<string, string>) =>
  callRoute((ctx) => tryHandleAgentPackages(ctx, d), method, path, auth, body, headers).then((r) => { expect(r.handled).toBe(true); return r.out })
const storeCredential = (c: unknown = STORED) => { writeFileSync(CRED, typeof c === 'string' ? c : JSON.stringify(c), { mode: 0o600 }); chmodSync(CRED, 0o600) }
const credBytes = () => (existsSync(CRED) ? readFileSync(CRED, 'utf8') : null)

let ownerId = 0
beforeAll(() => {
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  for (const f of readdirSync(STORE)) rmSync(join(STORE, f), { recursive: true, force: true })
  logged.length = 0
  fake = makeFakeServer()
  deps = { keys: [], fetchImpl: fake.fetchImpl, now: () => NOW, remote: makeRemote(TEST_ORIGIN) }
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

describe('the released build', () => {
  it('RELEASED_DEPS: no origin yet (N3), so every outgoing call answers not_configured without a request', async () => {
    expect(remote.PACKAGE_ORIGIN).toBe('')
    const d = { ...RELEASED_DEPS, fetchImpl: fake.fetchImpl }
    expect(await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE }, d))
      .toMatchObject({ status: 502, body: { error: 'redeem_failed', reason: 'not_configured' } })
    storeCredential()
    expect(await call('GET', '/api/agent-packages/catalog', SESSION, undefined, d))
      .toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'not_configured' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('(11) the origin is the Remote\'s own, whatever the environment says', async () => {
    const names = ['PACKAGE_ORIGIN', 'AGENT_PACKAGE_ORIGIN', 'MARVEEN_PACKAGE_ORIGIN']
    const before = names.map((n) => process.env[n])
    for (const n of names) process.env[n] = 'https://elsewhere.test'
    try {
      storeCredential()
      fake.answer({ status: 200, body: JSON.stringify(CATALOG) })
      const d = { ...deps, remote: makeRemote(TEST_ORIGIN) }
      expect((await call('GET', '/api/agent-packages/catalog', SESSION, undefined, d)).status).toBe(200)
      fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
      expect((await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE }, d)).status).toBe(200)
      expect(fake.requests.map((r) => r.url)).toEqual([`${TEST_ORIGIN}/functions/v1/agent-packages`, `${TEST_ORIGIN}/functions/v1/device-link-redeem`])
    } finally {
      names.forEach((n, i) => { if (before[i] === undefined) delete process.env[n]; else process.env[n] = before[i] })
    }
  })
})

describe('(45) the route takes its Remote from deps', () => {
  it('positive control: the deps Remote is used (the fake server gets the request)', async () => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(CATALOG) })
    expect((await call('GET', '/api/agent-packages/catalog')).status).toBe(200)
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    expect((await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })).status).toBe(200)
    expect(fake.requests.length).toBe(2)
  })
})

describe('(14) the owner gate, before the body and before any request', () => {
  const cases: Array<[string, string, unknown]> = [
    ['GET', '/api/agent-packages/credential', undefined],
    ['POST', '/api/agent-packages/credential', { code: CODE }],
    ['DELETE', '/api/agent-packages/credential', undefined],
    ['GET', '/api/agent-packages/catalog', undefined],
  ]
  it.each(cases)('%s %s: the shared token without the owner cookie is refused with 403 owner_session_required', async (method, path, body) => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(path.endsWith('catalog') ? CATALOG : REDEEM_OK) })
    const out = await call(method, path, TOKEN_ONLY, body)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('owner_session_required')
    expect(out.raw).not.toContain('Office Mac')
    expect(fake.requests).toHaveLength(0)
    expect(credBytes()).toBe(JSON.stringify(STORED))
  })

  it.each(cases)('%s %s: a sub-agent\'s own token is refused too', async (method, path, body) => {
    storeCredential()
    const out = await call(method, path, { kind: 'token', tokenAgent: 'samu', agent: 'samu' }, body)
    expect(out.status).toBe(403)
    expect(fake.requests).toHaveLength(0)
  })

  it.each(cases)('%s %s: positive control, the shared token WITH the owner cookie passes', async (method, path, body) => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(path.endsWith('catalog') ? CATALOG : REDEEM_OK) })
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}`
    const out = await call(method, path, TOKEN_ONLY, body, deps, { cookie })
    expect(out.status).toBe(200)
  })
})

describe('GET /api/agent-packages/credential', () => {
  it('no file: connected false', async () => {
    expect(await call('GET', '/api/agent-packages/credential')).toMatchObject({ status: 200, body: { connected: false } })
  })

  it('a stored credential: its label, id and time, never the token', async () => {
    storeCredential()
    const out = await call('GET', '/api/agent-packages/credential')
    expect(out.body).toEqual({ connected: true, label: 'Office Mac', deviceTokenId: TEST_DEVICE_ID, connectedAt: STORED.connectedAt })
  })

  it.each([
    ['not JSON', TEST_TOKEN],
    ['a cut-off object', JSON.stringify(STORED).slice(0, 40)],
    ['another schema', JSON.stringify({ ...STORED, schema: 2 })],
    ['a token of another shape', JSON.stringify({ ...STORED, token: TEST_TOKEN.slice(0, 40) })],
    ['a device id that is not a uuid', JSON.stringify({ ...STORED, deviceTokenId: 'x' })],
    ['an array', '[]'],
  ])('a corrupt file (%s): connected false', async (_n, content) => {
    storeCredential(content)
    expect((await call('GET', '/api/agent-packages/credential')).body).toEqual({ connected: false })
  })

  it.skipIf(process.platform === 'win32')('a file readable by others (0644, 0640) is not used: connected false', async () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      storeCredential()
      chmodSync(CRED, mode)
      expect((await call('GET', '/api/agent-packages/credential')).body).toEqual({ connected: false })
    }
  })
})

describe('POST /api/agent-packages/credential', () => {
  it('redeems the normalized code, stores the credential 0600 and answers the GET shape', async () => {
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: ' abcd-efgh2345 ' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ connected: true, label: 'Home Mac', deviceTokenId: NEW_ID, connectedAt: NOW.toISOString(), replaced: false, replacedDeviceTokenId: null })
    expect(fake.requests).toHaveLength(1)
    const r = fake.requests[0]
    expect(r.url).toBe(`${TEST_ORIGIN}/functions/v1/device-link-redeem`)
    expect(r.method).toBe('POST')
    expect(JSON.parse(r.body!)).toEqual({ code: CODE })
    expect(r.headers.authorization).toBeUndefined()
    if (process.platform !== 'win32') expect(statSync(CRED).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(CRED, 'utf8'))).toEqual({ schema: 1, token: TEST_TOKEN, deviceTokenId: NEW_ID, label: 'Home Mac', connectedAt: NOW.toISOString() })
    expect((await call('GET', '/api/agent-packages/credential')).body).toMatchObject({ connected: true, deviceTokenId: NEW_ID })
  })

  it('over a stored credential: replaced, with the replaced id read from the old file', async () => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out.body).toMatchObject({ deviceTokenId: NEW_ID, replaced: true, replacedDeviceTokenId: TEST_DEVICE_ID })
  })

  it('over an unreadable old file: replaced, replacedDeviceTokenId null', async () => {
    storeCredential('{"schema":1,')
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out.body).toMatchObject({ replaced: true, replacedDeviceTokenId: null })
  })

  it.each([
    ['not JSON', 'code=ABCD-EFGH2345'],
    ['an array', '["ABCD-EFGH2345"]'],
    ['an unknown key beside the code', { code: CODE, label: 'x' }],
    ['no code', {}],
    ['a code that is not a string', { code: 12345678 }],
    ['a short code', { code: 'ABCD-EFGH234' }],
    ['a code with a letter outside Crockford base32', { code: 'ABCD-EFGH234U' }],
  ])('a bad body (%s): 400 bad_request, no request', async (_n, body) => {
    const out = await call('POST', '/api/agent-packages/credential', SESSION, body)
    expect(out).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('a body over 4 KiB: 413 body-too-large, no request', async () => {
    const out = await call('POST', '/api/agent-packages/credential', SESSION, JSON.stringify({ code: CODE, pad: 'x'.repeat(4096) }))
    expect(out.status).toBe(413)
    expect(out.body.code).toBe('body-too-large')
    expect(fake.requests).toHaveLength(0)
  })

  it.each([
    ['404 invalid_code', { status: 404, body: '{"error":"invalid_code"}' }, 404, { error: 'invalid_code' }],
    ['409 token_limit', { status: 409, body: '{"error":"token_limit"}' }, 409, { error: 'token_limit' }],
    ['429 with Retry-After', { status: 429, headers: { 'retry-after': '120' }, body: '{"error":"rate_limited"}' }, 429, { error: 'rate_limited', retryAfterSeconds: 120 }],
    ['404 with another error', { status: 404, body: '{"error":"not_found"}' }, 502, { error: 'redeem_failed', reason: 'upstream' }],
    ['500', { status: 500, body: 'oops' }, 502, { error: 'redeem_failed', reason: 'upstream' }],
    ['401', { status: 401, body: '{"error":"invalid_token"}' }, 502, { error: 'redeem_failed', reason: 'upstream' }],
    ['302', { status: 302, headers: { location: 'https://elsewhere.test/' } }, 502, { error: 'redeem_failed', reason: 'redirect' }],
  ])('an A-side %s: mapped by the table, nothing stored', async (_n, answer, status, body) => {
    fake.answer(answer)
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out.status).toBe(status)
    expect(out.body).toEqual(body)
    expect(existsSync(CRED)).toBe(false)
  })

  it.each([
    ['token of 42 characters', { ...REDEEM_OK, token: TEST_TOKEN.slice(0, -1) }],
    ['token without the mdt_ prefix', { ...REDEEM_OK, token: 'mdx_' + TEST_TOKEN.slice(4) }],
    ['device_token_id not a uuid', { ...REDEEM_OK, device_token_id: '42' }],
    ['label not a string', { ...REDEEM_OK, label: 7 }],
    ['an array', [REDEEM_OK]],
  ])('a 200 of the wrong shape (%s): 502 redeem_failed, nothing stored', async (_n, body) => {
    fake.answer({ status: 200, body: JSON.stringify(body) })
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out).toMatchObject({ status: 502, body: { error: 'redeem_failed', reason: 'upstream' } })
    expect(existsSync(CRED)).toBe(false)
  })

  it('redeemed but not stored: 500 credential_store_failed, the log names the device token id', async () => {
    mkdirSync(join(CRED, 'blocker'), { recursive: true }) // a directory where the file goes: the rename fails
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out).toMatchObject({ status: 500, body: { error: 'credential_store_failed' } })
    expect(logged.some((a) => (a[0] as { deviceTokenId?: string })?.deviceTokenId === NEW_ID)).toBe(true)
  })

  it('timeouts: 15 s on the redeem call; a timeout is the timeout reason', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    fake.fail(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const out = await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    expect(out.body).toEqual({ error: 'redeem_failed', reason: 'timeout' })
    expect(spy).toHaveBeenCalledWith(REDEEM_TIMEOUT_MS)
    expect(REDEEM_TIMEOUT_MS).toBe(15_000)
    expect(fake.requests[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('a network error is the network reason', async () => {
    fake.fail(new TypeError('fetch failed'))
    expect((await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })).body).toEqual({ error: 'redeem_failed', reason: 'network' })
  })
})

describe('DELETE /api/agent-packages/credential', () => {
  it('removes the local copy and says the remote one was not revoked; idempotent', async () => {
    storeCredential()
    for (let i = 0; i < 2; i++) {
      const out = await call('DELETE', '/api/agent-packages/credential')
      expect(out).toMatchObject({ status: 200, body: { ok: true, connected: false, remoteRevoked: false } })
      expect(existsSync(CRED)).toBe(false)
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('a directory in the file\'s place is not a credential: 200, and it stays', async () => {
    mkdirSync(join(CRED, 'x'), { recursive: true })
    expect((await call('DELETE', '/api/agent-packages/credential')).status).toBe(200)
    expect(existsSync(join(CRED, 'x'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a file that cannot be removed: 500 credential_delete_failed, not a false connected:false', async () => {
    storeCredential()
    chmodSync(STORE, 0o500)
    try {
      expect(await call('DELETE', '/api/agent-packages/credential')).toMatchObject({ status: 500, body: { error: 'credential_delete_failed' } })
    } finally {
      chmodSync(STORE, 0o700)
    }
    expect(credBytes()).toBe(JSON.stringify(STORED))
  })
})

describe('GET /api/agent-packages/catalog', () => {
  it('not connected: 409 not_connected, no request', async () => {
    expect(await call('GET', '/api/agent-packages/catalog')).toMatchObject({ status: 409, body: { error: 'not_connected' } })
    storeCredential('garbage')
    expect(await call('GET', '/api/agent-packages/catalog')).toMatchObject({ status: 409, body: { error: 'not_connected' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('passes the A-side object on unchanged; the token rides in Authorization, to the fixed origin only', async () => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(CATALOG) })
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out).toMatchObject({ status: 200, body: { catalog: CATALOG } })
    expect(fake.requests).toHaveLength(1)
    const r = fake.requests[0]
    expect(r.url).toBe(`${TEST_ORIGIN}/functions/v1/agent-packages`)
    expect(r.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(spy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    expect(REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it.each([
    ['not JSON', 'hello'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
  ])('a 200 that is not a JSON object (%s): 502 upstream', async (_n, body) => {
    storeCredential()
    fake.answer({ status: 200, body })
    expect(await call('GET', '/api/agent-packages/catalog')).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'upstream' } })
  })

  it('T4: the stored token in the A-side body: 502 upstream, and the body does not go out', async () => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify({ ...CATALOG, note: `x${TEST_TOKEN}y` }) })
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'upstream' } })
    expect(out.raw).not.toContain('note')
  })

  it('(16) an A-side 401 goes out as 409 credential_rejected with its reason, and the stored credential stays', async () => {
    for (const reason of ['token_expired', 'invalid_token']) {
      storeCredential()
      fake.answer({ status: 401, body: JSON.stringify({ error: reason }) })
      const out = await call('GET', '/api/agent-packages/catalog')
      expect(out.status).toBe(409)
      expect(out.body).toEqual({ error: 'credential_rejected', reason })
      expect(credBytes()).toBe(JSON.stringify(STORED))
    }
  })

  it('(12) redirect manual: a 302 is the redirect reason, and there is no second request', async () => {
    storeCredential()
    fake.answer({ status: 302, headers: { location: `${TEST_ORIGIN}/elsewhere` } })
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'redirect' } })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0].redirect).toBe('manual')
  })

  it('(12) every request asks for redirect manual (redeem too)', async () => {
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    fake.answer({ status: 200, body: JSON.stringify(CATALOG) })
    await call('GET', '/api/agent-packages/catalog')
    expect(fake.requests.map((r) => r.redirect)).toEqual(['manual', 'manual'])
  })

  it('(12) an http origin is refused: not_configured, no request', async () => {
    storeCredential()
    for (const origin of ['http://packages.test', 'https://packages.test/', 'https://packages.test/x', 'https://u:p@packages.test', 'packages.test']) {
      const d = { ...deps, remote: makeRemote(origin) }
      expect((await call('GET', '/api/agent-packages/catalog', SESSION, undefined, d)).body).toEqual({ error: 'download_failed', reason: 'not_configured' })
      expect((await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE }, d)).body).toEqual({ error: 'redeem_failed', reason: 'not_configured' })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('(12) Authorization only on requests to the fixed origin', async () => {
    storeCredential()
    fake.answer({ status: 200, body: JSON.stringify(CATALOG) })
    await call('GET', '/api/agent-packages/catalog')
    fake.answer({ status: 302, headers: { location: 'https://elsewhere.test/' } })
    await call('GET', '/api/agent-packages/catalog')
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })
    const withAuth = fake.requests.filter((r) => r.headers.authorization !== undefined)
    expect(withAuth.length).toBe(2)
    for (const r of withAuth) expect(r.url.startsWith(`${TEST_ORIGIN}/`)).toBe(true)
    for (const r of fake.requests) expect(new URL(r.url).origin).toBe(TEST_ORIGIN)
  })

  it('(13) a body over 256 KiB is cut off while it streams, not read whole and measured', async () => {
    storeCredential()
    const chunk = Buffer.alloc(16 * 1024, 0x20)
    const chunks = Array.from({ length: 64 }, () => chunk) // 1 MiB, no Content-Length
    fake.answer({ status: 200, chunks })
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'too_large' } })
    const s = fake.streams[0]
    expect(s.total).toBe(64)
    expect(s.pulled).toBeLessThanOrEqual(CATALOG_MAX_BYTES / chunk.length + 2)
    expect(s.cancelled).toBe(true)
  })

  it('(13) an error body over 4 KiB is cut off too', async () => {
    storeCredential()
    fake.answer({ status: 403, chunks: Array.from({ length: 16 }, () => Buffer.alloc(1024, 0x20)) })
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out.body).toEqual({ error: 'download_failed', reason: 'too_large' })
    expect(fake.streams[0].pulled).toBeLessThanOrEqual(6)
  })

  it('a catalog body of exactly 256 KiB passes', async () => {
    storeCredential()
    const text = JSON.stringify({ access: 'none', pad: '' })
    const body = JSON.stringify({ access: 'none', pad: 'x'.repeat(CATALOG_MAX_BYTES - text.length) })
    expect(Buffer.byteLength(body)).toBe(CATALOG_MAX_BYTES)
    fake.answer({ status: 200, body })
    expect((await call('GET', '/api/agent-packages/catalog')).status).toBe(200)
  })

  it.each([
    ['403 not_entitled free', { status: 403, body: '{"error":"not_entitled","reason":"free","trial_pick":null}' }, 409, { error: 'not_entitled', reason: 'free', trialPick: null }],
    ['403 not_entitled trial_limit', { status: 403, body: '{"error":"not_entitled","reason":"trial_limit","trial_pick":"other-slug"}' }, 409, { error: 'not_entitled', reason: 'trial_limit', trialPick: 'other-slug' }],
    ['403 not_entitled with a bad pick', { status: 403, body: '{"error":"not_entitled","reason":"trial_limit","trial_pick":"Bad Slug"}' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['403 not_entitled with an unknown reason', { status: 403, body: '{"error":"not_entitled","reason":"other","trial_pick":null}' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['404 not_found', { status: 404, body: '{"error":"not_found"}' }, 404, { error: 'package_not_found' }],
    ['409 incompatible', { status: 409, body: '{"error":"incompatible","min_marveen_version":"1.4.0"}' }, 409, { error: 'incompatible', minMarveenVersion: '1.4.0' }],
    ['409 incompatible with a bad version', { status: 409, body: '{"error":"incompatible","min_marveen_version":"1.4"}' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['429 Retry-After 3600', { status: 429, headers: { 'retry-after': '3600' }, body: '{"error":"rate_limited"}' }, 429, { error: 'rate_limited', retryAfterSeconds: 3600 }],
    ['429 Retry-After over a day', { status: 429, headers: { 'retry-after': '999999' } }, 429, { error: 'rate_limited', retryAfterSeconds: 86400 }],
    ['429 without Retry-After', { status: 429 }, 429, { error: 'rate_limited', retryAfterSeconds: null }],
    ['429 with a date Retry-After', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }, 429, { error: 'rate_limited', retryAfterSeconds: null }],
    ['503', { status: 503, body: '{"error":"temporarily_unavailable"}' }, 503, { error: 'temporarily_unavailable' }],
    ['400', { status: 400, body: '{"error":"bad_request"}' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['405', { status: 405 }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['401 with an unknown error', { status: 401, body: '{"error":"nope"}' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['500 not JSON', { status: 500, body: '<html>' }, 502, { error: 'download_failed', reason: 'upstream' }],
    ['201', { status: 201, body: JSON.stringify(CATALOG) }, 502, { error: 'download_failed', reason: 'upstream' }],
  ])('the closed table: A-side %s', async (_n, answer, status, body) => {
    storeCredential()
    fake.answer(answer)
    const out = await call('GET', '/api/agent-packages/catalog')
    expect(out.status).toBe(status)
    expect(out.body).toEqual(body)
  })

  it('a timeout and a network error', async () => {
    storeCredential()
    fake.fail(new DOMException('timed out', 'TimeoutError'))
    expect((await call('GET', '/api/agent-packages/catalog')).body).toEqual({ error: 'download_failed', reason: 'timeout' })
    fake.fail(new TypeError('fetch failed'))
    expect((await call('GET', '/api/agent-packages/catalog')).body).toEqual({ error: 'download_failed', reason: 'network' })
  })
})

describe('the other paths', () => {
  it('another method on a known path is 405 with Allow', async () => {
    const out = await call('PUT', '/api/agent-packages/credential')
    expect(out.status).toBe(405)
    expect(out.headers.some((h) => /^allow: GET, POST, DELETE$/i.test(h))).toBe(true)
    expect((await call('POST', '/api/agent-packages/catalog')).status).toBe(405)
  })

  it('an unrelated path is not handled', async () => {
    const r = await callRoute((ctx) => tryHandleAgentPackages(ctx, deps), 'GET', '/api/agents', SESSION)
    expect(r.handled).toBe(false)
  })
})

describe('normalizeLinkCode', () => {
  it.each([
    ['ABCD-EFGH2345', 'ABCD-EFGH2345'],
    ['abcd-efgh2345', 'ABCD-EFGH2345'],
    ['  ABCDEFGH2345 ', 'ABCD-EFGH2345'],
    ['ab cd-ef gh 23 45', 'ABCD-EFGH2345'],
    ['OIL0-0000ILO1', '0110-00001101'],
  ])('%s -> %s', (raw, want) => { expect(normalizeLinkCode(raw)).toBe(want) })

  it.each([['ABCD-EFGH234'], ['ABCD-EFGH23456'], ['ABCD-EFGH234U'], ['ABCD_EFGH2345'], [''], ['x'.repeat(65)]])('%s -> null', (raw) => {
    expect(normalizeLinkCode(raw)).toBeNull()
  })

  it('a non-string is null', () => {
    for (const v of [null, undefined, 1, {}, []]) expect(normalizeLinkCode(v)).toBeNull()
  })
})

describe('refusalFor (the closed table, unit)', () => {
  it('maps the download call like the catalog call', () => {
    const h = new Headers()
    expect(refusalFor('package', 404, h, { error: 'not_found' })).toEqual({ status: 404, body: { error: 'package_not_found' } })
    expect(refusalFor('package', 418, h, undefined)).toEqual({ status: 502, body: { error: 'download_failed', reason: 'upstream' } })
    expect(refusalFor('redeem', 503, h, undefined)).toEqual({ status: 502, body: { error: 'redeem_failed', reason: 'upstream' } })
  })
})

describe('T3: interrupted-write leftovers of the credential file', () => {
  it('removes the credential tmp files only', () => {
    const keep = ['agent-package-credential.json', 'agent-package-credential.json.bak', 'vault.json.1.2.ab.tmp', 'other.tmp', 'agent-package-credential.jsonx']
    const gone = ['agent-package-credential.json.123.1700000000000.deadbeef.tmp', 'agent-package-credential.json.tmp']
    for (const f of [...keep, ...gone]) writeFileSync(join(STORE, f), 'x')
    expect(removeCredentialTmpLeftovers()).toBe(gone.length)
    expect(readdirSync(STORE).sort()).toEqual([...keep].sort())
  })

  it('the tmp name atomicWriteFileSync really leaves behind is one of them', async () => {
    mkdirSync(join(CRED, 'blocker'), { recursive: true })
    fake.answer({ status: 200, body: JSON.stringify(REDEEM_OK) })
    expect((await call('POST', '/api/agent-packages/credential', SESSION, { code: CODE })).status).toBe(500)
    const left = readdirSync(STORE).filter((f) => f !== 'agent-package-credential.json')
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(/^agent-package-credential\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/)
    expect(removeCredentialTmpLeftovers()).toBe(1)
    expect(readdirSync(STORE)).toEqual(['agent-package-credential.json'])
  })

  it('a store without the dir: 0, no throw', () => {
    rmSync(STORE, { recursive: true, force: true })
    try {
      expect(removeCredentialTmpLeftovers()).toBe(0)
    } finally {
      mkdirSync(STORE, { recursive: true })
    }
  })
})
