// SETUPTOKENWIZ1022: the /api/claude-plans/login/* routes. The relay is a fake
// (setup-token-login.test.ts and setup-token-pty-relay.test.ts cover it), the
// live probe is a stub, the vault an in-memory Map; the owner gate is the REAL
// mayIssueCredentials over an in-memory database.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-login-test-'))

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot }))

const vaultSecrets = new Map<string, string>()
vi.mock('../web/vault.js', () => ({
  setSecret: (id: string, _label: string, value: string) => { vaultSecrets.set(id, value) },
  deleteSecret: (id: string) => vaultSecrets.delete(id),
  getSecret: (id: string) => vaultSecrets.get(id) ?? null,
}))

// Every argument of every log call, to prove the token never reaches a log line.
const logged: unknown[] = []
vi.mock('../logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args) }
  return { logger: { info: rec, warn: rec, error: rec, debug: rec, child: () => ({ info: rec, warn: rec, error: rec, debug: rec }) } }
})

const { initDatabase, getDb } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { tryHandleClaudePlansLogin, setClaudePlanLoginDepsForTest } = await import('../web/routes/claude-plans-login.js')
const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { CLAUDE_PLANS_PATH } = await import('../web/claude-plans.js')
import type { LaunchResult, RelayProcess } from '../web/setup-token-login.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = 'sk-ant-oat01-' + 'Qw7_-p'.repeat(16)
const LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=' + 's'.repeat(43)
const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }

type Handler = (ctx: RouteContext) => Promise<boolean>
const responses: string[] = []
async function call(method: string, path: string, auth: RouteContext['auth'], body?: unknown, handler: Handler = tryHandleClaudePlansLogin) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth })).toBe(true)
  responses.push(out.body)
  return { status: out.status, json: JSON.parse(out.body || '{}') as Record<string, any> }
}

// A fake relay that shows the link at once and prints the token after Enter.
let launches = 0
function fakeLaunch(): LaunchResult {
  launches++
  const dataCbs: Array<(s: string) => void> = []
  const exitCbs: Array<() => void> = []
  const relay: RelayProcess = {
    write: (d) => { if (d === '\r') setTimeout(() => dataCbs.forEach((cb) => cb(`\r\r\n\x1b[33m${TOKEN}\x1b[39m\r\r\n`)), 5) },
    end: () => { setTimeout(() => exitCbs.forEach((cb) => cb()), 1) },
    kill: () => {},
    onData: (cb) => { dataCbs.push(cb) },
    onExit: (cb) => { exitCbs.push(cb) },
  }
  setTimeout(() => dataCbs.forEach((cb) => cb(`\x1b]8;;${LOGIN_URL}\x07${LOGIN_URL}\x1b]8;;\x07\r\r\n`)), 5)
  return { ok: true, relay, cleanup: () => {} }
}

let probeResult: 'ok' | 'auth-rejected' | 'inconclusive' = 'ok'
const probed: string[] = []

const START = { id: 'second', label: 'Second Max', planType: 'personal', channelsAllowed: true }
const CODE = { code: 'AbCdEf123_xyz#state789' }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

afterAll(() => {
  setClaudePlanLoginDepsForTest(null)
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
  vaultSecrets.clear()
  logged.length = 0
  responses.length = 0
  launches = 0
  probed.length = 0
  probeResult = 'ok'
  setClaudePlanLoginDepsForTest({
    launch: fakeLaunch,
    probe: async (t) => { probed.push(t); return probeResult },
    timeouts: { urlMs: 2000, codeMs: 5000, tokenMs: 2000, killMs: 100 },
  })
})

async function addOwner() {
  const r = await call('POST', '/api/auth/users', TOKEN_AUTH, { username: 'owner', password: 'super-secret-pw' }, tryHandleAuth)
  expect(r.status).toBe(201)
}

function noTokenAnywhere() {
  for (const body of responses) expect(body).not.toContain(TOKEN)
  expect(JSON.stringify(logged)).not.toContain(TOKEN)
  expect(JSON.stringify(logged)).not.toContain(CODE.code)
}

describe('owner gate (mayIssueCredentials)', () => {
  it('with a dashboard login, the shared token gets 403 on every login route and nothing starts', async () => {
    await addOwner()
    for (const [m, p, b] of [
      ['POST', '/api/claude-plans/login/start', START],
      ['POST', '/api/claude-plans/login/code', CODE],
      ['POST', '/api/claude-plans/login/cancel', undefined],
      ['GET', '/api/claude-plans/login/status', undefined],
    ] as const) {
      const r = await call(m, p, TOKEN_AUTH, b)
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.json.code).toBe('owner_session_required')
    }
    expect(launches).toBe(0)
  })

  it('the owner session gets through', async () => {
    await addOwner()
    const r = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    expect(r.status).toBe(200)
    expect(r.json.url).toBe(LOGIN_URL)
    await call('POST', '/api/claude-plans/login/cancel', SESSION_AUTH)
  })

  it('before any login exists (first-run setup), the token is the owner', async () => {
    expect((await call('GET', '/api/claude-plans/login/status', TOKEN_AUTH)).status).toBe(200)
  })
})

// SETUPTOKENHU1023 (owner decision): the owner adds plans from the Bridge, which signs every
// request with its paired device key. Real gate (resolveAuth) and real keys over the in-memory db.
describe('a paired Bridge device key (SETUPTOKENHU1023)', () => {
  const GATE_TOKEN = 'g'.repeat(64)
  const path = '/api/claude-plans/login/status'
  async function asBearer(bearer: string, handler: Handler = tryHandleClaudePlansLogin, method = 'GET', p = path, body?: unknown) {
    const { resolveAuth } = await import('../web/auth-gate.js')
    const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as http.IncomingMessage
    const auth = resolveAuth(req, new URL(`http://127.0.0.1:3420${p}`), p, method, GATE_TOKEN)
    return { kind: auth.kind, ...(await call(method, p, auth as RouteContext['auth'], body, handler)) }
  }
  beforeEach(async () => {
    const { _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
    getDb().exec('DELETE FROM device_keys')
    _clearDeviceKeyCacheForTest()
    await addOwner()
  })

  it('a full-scope key from Bridge pairing reaches the login routes, and a login starts', async () => {
    const { mintBridgeDeviceKey } = await import('../web/auth-device-keys.js')
    const { minted } = mintBridgeDeviceKey('Macbookom', '0b3c8a9e-2f41-4c55-9d1e-7a6f5e4d3c2b')
    const r = await asBearer(minted.key)
    expect(r.kind).toBe('device')
    expect(r.status).toBe(200)
    const start = await asBearer(minted.key, tryHandleClaudePlansLogin, 'POST', '/api/claude-plans/login/start', START)
    expect(start.status).toBe(200)
    expect(start.json.url).toBe(LOGIN_URL)
    await asBearer(minted.key, tryHandleClaudePlansLogin, 'POST', '/api/claude-plans/login/cancel')
  })

  it('the shared fleet token still gets 403, with or without a paired Bridge around: an agent cannot add a subscription', async () => {
    const { mintBridgeDeviceKey } = await import('../web/auth-device-keys.js')
    mintBridgeDeviceKey('Macbookom', '0b3c8a9e-2f41-4c55-9d1e-7a6f5e4d3c2b')
    const r = await asBearer(GATE_TOKEN, tryHandleClaudePlansLogin, 'POST', '/api/claude-plans/login/start', START)
    expect(r.kind).toBe('token')
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('owner_session_required')
    expect(launches).toBe(0)
  })

  it('a full-scope key minted from the device-key list (no install id, e.g. an MCP) gets 403', async () => {
    const { createDeviceKey } = await import('../web/auth-device-keys.js')
    const machine = createDeviceKey('mac-mini hang-MCP', { scope: 'full' })
    const r = await asBearer(machine.key)
    expect(r.kind).toBe('device')
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('owner_session_required')
  })

  it('a narrower key gets 403 even with an install id', async () => {
    const { createDeviceKey } = await import('../web/auth-device-keys.js')
    const op = createDeviceKey('operator', { scope: 'operator', expiresInDays: 1, installId: '1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a' })
    const r = await asBearer(op.key)
    expect(r.kind).toBe('device')
    expect(r.status).toBe(403)
  })

  it('a revoked Bridge key does not resolve, so it gets 403', async () => {
    const { mintBridgeDeviceKey, revokeDeviceKey } = await import('../web/auth-device-keys.js')
    const { minted } = mintBridgeDeviceKey('Macbookom', '0b3c8a9e-2f41-4c55-9d1e-7a6f5e4d3c2b')
    expect(revokeDeviceKey(minted.id)).toBe(true)
    const r = await asBearer(minted.key)
    expect(r.kind).toBe('none')
    expect(r.status).toBe(403)
  })

  it('the other owner-only routes stay closed to the paired key (minting a key, adding a user)', async () => {
    const { mintBridgeDeviceKey, listDeviceKeys } = await import('../web/auth-device-keys.js')
    const { minted } = mintBridgeDeviceKey('Macbookom', '0b3c8a9e-2f41-4c55-9d1e-7a6f5e4d3c2b')
    const mint = await asBearer(minted.key, tryHandleAuth, 'POST', '/api/auth/device-keys', { name: 'second' })
    expect(mint.status).toBe(403)
    expect(listDeviceKeys()).toHaveLength(1)
    const user = await asBearer(minted.key, tryHandleAuth, 'POST', '/api/auth/users', { username: 'mallory', password: 'super-secret-pw' })
    expect(user.status).toBe(403)
  })
})

describe('the login flow', () => {
  it('start -> link, code -> the plan is stored through the same write path as a pasted token', async () => {
    const start = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    expect(start).toEqual({ status: 200, json: { url: LOGIN_URL } })
    const status = await call('GET', '/api/claude-plans/login/status', SESSION_AUTH)
    expect(status.json).toEqual({ active: true, phase: 'waiting-code', error: null, url: LOGIN_URL })

    const done = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(done.status).toBe(201)
    expect(done.json).toMatchObject({ id: 'second', label: 'Second Max', tokenSecretId: 'claude-plan-token-second', verified: true })
    expect(probed).toEqual([TOKEN])
    expect(vaultSecrets.get('claude-plan-token-second')).toBe(TOKEN)

    const list = await call('GET', '/api/claude-plans', SESSION_AUTH, undefined, tryHandleClaudePlans)
    expect(JSON.parse(responses[responses.length - 1]).map((p: { id: string }) => p.id)).toEqual(['second'])
    expect(list.status).toBe(200)
    noTokenAnywhere()
  })

  it('a token the live probe rejects is not stored', async () => {
    probeResult = 'auth-rejected'
    await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    const r = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('verify-failed')
    expect(vaultSecrets.size).toBe(0)
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
    noTokenAnywhere()
  })

  it('an inconclusive probe stores the plan as verified:false', async () => {
    probeResult = 'inconclusive'
    await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    const r = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(r.status).toBe(201)
    expect(r.json.verified).toBe(false)
    expect(vaultSecrets.get('claude-plan-token-second')).toBe(TOKEN)
  })

  it('the same token already stored under another plan is refused, without the token in the error', async () => {
    const first = await call('POST', '/api/claude-plans', SESSION_AUTH,
      { id: 'first', label: 'First', planType: 'personal', channelsAllowed: true, token: TOKEN }, tryHandleClaudePlans)
    expect(first.status).toBe(201)
    responses.length = 0
    logged.length = 0
    await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    const r = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(r.status).toBe(409)
    expect(r.json.error).toContain('first')
    expect(vaultSecrets.has('claude-plan-token-second')).toBe(false)
    noTokenAnywhere()
  })

  it('a taken id or invalid fields are refused at start, before claude is launched', async () => {
    await call('POST', '/api/claude-plans', SESSION_AUTH,
      { id: 'second', label: 'Taken', configDir: '/opt/claude-x', planType: 'personal', channelsAllowed: true }, tryHandleClaudePlans)
    const taken = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    expect(taken.status).toBe(409)
    expect(taken.json.code).toBe('id-taken')
    const invalid = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, { ...START, id: 'bad id!' })
    expect(invalid.status).toBe(400)
    expect(invalid.json.code).toBe('invalid-plan')
    const noType = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, { ...START, id: 'third', planType: 'enterprise' })
    expect(noType.status).toBe(400)
    expect(launches).toBe(0)
  })

  it('one login at a time; cancel frees the slot and a late code is refused', async () => {
    expect((await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)).status).toBe(200)
    const busy = await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, { ...START, id: 'other' })
    expect(busy.status).toBe(409)
    expect(busy.json.code).toBe('busy')
    expect((await call('POST', '/api/claude-plans/login/cancel', SESSION_AUTH)).status).toBe(200)
    expect((await call('GET', '/api/claude-plans/login/status', SESSION_AUTH)).json.active).toBe(false)
    const late = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(late.status).toBe(409)
    expect(late.json.code).toBe('wrong-phase')
    expect((await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)).status).toBe(200)
    await call('POST', '/api/claude-plans/login/cancel', SESSION_AUTH)
    expect(launches).toBe(2)
    expect(vaultSecrets.size).toBe(0)
  })

  it('a malformed code is refused and the login keeps waiting for a good one', async () => {
    await call('POST', '/api/claude-plans/login/start', SESSION_AUTH, START)
    const bad = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, { code: 'x\r' })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('bad-code')
    const good = await call('POST', '/api/claude-plans/login/code', SESSION_AUTH, CODE)
    expect(good.status).toBe(201)
  })
})
