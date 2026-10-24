// DEVKEYFOLLOW1022: the rest of the credential-issuing routes follow DEVKEYMINT1022.
// Once a dashboard login exists, issuing a federation peer's inbound token (add,
// full-document PUT, rotate), revealing it, editing a peer (it re-points the
// peer's outbound token), switching federation on, widening the operator switches and
// listing the usernames take the owner's session; the bearer token keeps them
// only for the first-run setup (no user yet).
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ operatorAccess: null as unknown }))
vi.mock('../web/operator-access.js', async (orig) => {
  const real = await orig<typeof import('../web/operator-access.js')>()
  return {
    ...real,
    readOperatorAccess: () => (h.operatorAccess ?? real.defaultOperatorAccess()),
    writeOperatorAccess: (next: unknown) => { h.operatorAccess = next },
  }
})

import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleFederation, _resetInboxDedupForTest } from '../web/routes/federation.js'
import { tryHandleOperatorAccess } from '../web/routes/operator-access.js'
import { _setFederationStoreDirForTest, reloadFederationForTest, getFederationConfig } from '../web/federation/config.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'devkeyfollow-test-'))
const IN_TOKEN = 'a'.repeat(64)
const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const DEVICE_AUTH: RouteContext['auth'] = { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }
const GOOD_PW = 'super-secret-pw'

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

const addUser = (auth: RouteContext['auth'], username: string) => call(tryHandleAuth, 'POST', '/api/auth/users', auth, { username, password: GOOD_PW })
const addPeer = (auth: RouteContext['auth'], id = 'teodor', headers: Record<string, string> = {}) =>
  call(tryHandleFederation, 'POST', '/api/federation/peers', auth, { id, baseUrl: 'https://teodor.example' }, headers)
const putDoc = (auth: RouteContext['auth']) => call(tryHandleFederation, 'PUT', '/api/federation/peers', auth, {
  enabled: false, systemId: 'marveen',
  peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: '', inboundToken: 'c'.repeat(64), trust: 'untrusted' }],
})
const rotate = (auth: RouteContext['auth']) => call(tryHandleFederation, 'POST', '/api/federation/peers/teodor/rotate-inbound-token', auth)
const reveal = (auth: RouteContext['auth']) => call(tryHandleFederation, 'GET', '/api/federation/peers/teodor/inbound-token', auth)
const patchPeer = (auth: RouteContext['auth'], body: Record<string, unknown>) => call(tryHandleFederation, 'PATCH', '/api/federation/peers/teodor', auth, body)
const setEnabled = (auth: RouteContext['auth'], enabled: boolean) => call(tryHandleFederation, 'POST', '/api/federation/enabled', auth, { enabled })
const putOperator = (auth: RouteContext['auth']) => call(tryHandleOperatorAccess, 'PUT', '/api/operator-access', auth, { enabled: true, agentControl: true })
const listUsers = (auth: RouteContext['auth'], headers: Record<string, string> = {}) => call(tryHandleAuth, 'GET', '/api/auth/users', auth, undefined, headers)

function seedPeer(): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
    enabled: false, systemId: 'marveen',
    peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: '', inboundToken: IN_TOKEN, trust: 'untrusted' }],
  }))
  reloadFederationForTest()
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
  h.operatorAccess = null
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('first-run setup (no dashboard user yet): the token still issues', () => {
  it('adds a peer, rotates and reveals its token, writes the switches and lists users', async () => {
    const added = await addPeer(TOKEN_AUTH)
    expect(added.status).toBe(201)
    expect(typeof added.json().inboundToken).toBe('string')
    expect((await rotate(TOKEN_AUTH)).status).toBe(200)
    expect((await reveal(TOKEN_AUTH)).status).toBe(200)
    expect((await putDoc(TOKEN_AUTH)).status).toBe(200)
    expect((await putOperator(TOKEN_AUTH)).status).toBe(200)
    expect((await listUsers(TOKEN_AUTH)).status).toBe(200)
  })
})

describe('once a login exists, the token cannot issue a peer token or widen the operator', () => {
  beforeEach(async () => {
    expect((await addUser(TOKEN_AUTH, 'owner')).status).toBe(201)
    seedPeer()
  })

  it('adding a peer is refused and nothing is written', async () => {
    const r = await addPeer(TOKEN_AUTH, 'mallory')
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(r.json()).not.toHaveProperty('inboundToken')
    expect(getFederationConfig().peers.map((p) => p.id)).toEqual(['teodor'])
  })

  it('the full-document PUT cannot install an inbound token', async () => {
    const r = await putDoc(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(getFederationConfig().peers[0]!.inboundToken).toBe(IN_TOKEN)
  })

  it('rotation and reveal are refused, the stored token is unchanged and not returned', async () => {
    const rot = await rotate(TOKEN_AUTH)
    expect(rot.status).toBe(403)
    const rev = await reveal(TOKEN_AUTH)
    expect(rev.status).toBe(403)
    expect(rev.json()).not.toHaveProperty('inboundToken')
    expect(getFederationConfig().peers[0]!.inboundToken).toBe(IN_TOKEN)
  })

  it('a full device key is refused too (it never was the owner)', async () => {
    expect((await addPeer(DEVICE_AUTH, 'mallory')).status).toBe(403)
    expect((await rotate(DEVICE_AUTH)).status).toBe(403)
    expect((await reveal(DEVICE_AUTH)).status).toBe(403)
  })

  it('the operator switches cannot be widened, reading them stays open', async () => {
    const r = await putOperator(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.operatorAccess).toBeNull()
    expect((await call(tryHandleOperatorAccess, 'GET', '/api/operator-access', TOKEN_AUTH)).status).toBe(200)
  })

  it('the username list is refused to the token', async () => {
    const r = await listUsers(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json()).not.toHaveProperty('users')
  })

  it('editing a peer cannot re-point its credential to another host (Samu, #2175 review)', async () => {
    const r = await patchPeer(TOKEN_AUTH, { baseUrl: 'https://attacker.example', shareCapabilitySummaries: true })
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    const peer = getFederationConfig().peers[0]!
    expect(peer.baseUrl).toBe('https://teodor.example')
    expect(peer.shareCapabilitySummaries).toBeUndefined()
    expect((await patchPeer(DEVICE_AUTH, { baseUrl: 'https://attacker.example' })).status).toBe(403)
  })

  it('switching federation on is refused, switching it off stays open (Marveen, #2175 review)', async () => {
    const on = await setEnabled(TOKEN_AUTH, true)
    expect(on.status).toBe(403)
    expect(on.json().code).toBe('owner_session_required')
    expect(getFederationConfig().enabled).toBe(false)
    expect((await setEnabled(DEVICE_AUTH, true)).status).toBe(403)
    expect(getFederationConfig().enabled).toBe(false)
    expect((await setEnabled(SESSION_AUTH, true)).status).toBe(200)
    expect(getFederationConfig().enabled).toBe(true)
    expect((await setEnabled(TOKEN_AUTH, false)).status).toBe(200)
    expect(getFederationConfig().enabled).toBe(false)
  })

  it('reading the peers and removing one stay open: they grant nothing', async () => {
    expect((await call(tryHandleFederation, 'GET', '/api/federation/peers', TOKEN_AUTH)).status).toBe(200)
    expect((await call(tryHandleFederation, 'DELETE', '/api/federation/peers/teodor', TOKEN_AUTH)).status).toBe(200)
  })

  it('the owner session issues and manages (positive control)', async () => {
    const patched = await patchPeer(SESSION_AUTH, { baseUrl: 'https://teodor2.example' })
    expect(patched.status).toBe(200)
    expect(getFederationConfig().peers[0]!.baseUrl).toBe('https://teodor2.example')
    expect((await rotate(SESSION_AUTH)).status).toBe(200)
    expect((await reveal(SESSION_AUTH)).status).toBe(200)
    expect((await addPeer(SESSION_AUTH, 'zeta')).status).toBe(201)
    expect((await putDoc(SESSION_AUTH)).status).toBe(200)
    expect((await putOperator(SESSION_AUTH)).status).toBe(200)
    expect((await listUsers(SESSION_AUTH)).status).toBe(200)
  })

  it('the owner\'s browser that also keeps the token: a valid session cookie alongside it is the owner', async () => {
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    expect((await addPeer(TOKEN_AUTH, 'zeta', { cookie })).status).toBe(201)
    expect((await listUsers(TOKEN_AUTH, { cookie })).status).toBe(200)
    expect((await addPeer(TOKEN_AUTH, 'eta', { cookie: `${SESSION_COOKIE_NAME}=forged` })).status).toBe(403)
  })
})
