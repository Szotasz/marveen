// COLLANLOCK1120 (Refs #2929): while the colleague LAN lock is active, a non-loopback peer on the plain listener is
// decided before authentication (Samu 82477, Dani 82480): the colleague surface passes with only its mv_colleague
// cookie (COLLCOOKIE1121), the browser login routes are refused, and every other request reaches the gate with all its cookies dropped, so only a header or query credential
// can authenticate it. auto locks only while the colleague login is in use (WEB_HOST
// not loopback, an enabled colleague account, the board on), so an install that opened WEB_HOST for its own remote
// access (Docker, a VPS) changes nothing. The peer is the socket's address, never a header.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const H = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { store: mkdtempSync(join(tmpdir(), 'colleague-lan-lock-')) }
})
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), STORE_DIR: H.store }))

const L = await import('../web/colleague-lan-lock.js')
const { createColleagueAccount, setColleagueDisabled, _clearColleagueAccountsCacheForTest } = await import('../web/colleague-accounts.js')
const { createColleagueSession, COLLEAGUE_COOKIE_NAME } = await import('../web/colleague-sessions.js')
const { SETTINGS_REGISTRY, isOverridesOnly, envValueTightens } = await import('../config-registry.js')
const { initDatabase, createDashboardUser } = await import('../db.js')
const { createSession } = await import('../web/auth-sessions.js')
const { gateRequest, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { createDeviceKey } = await import('../web/auth-device-keys.js')
const { createOperatorSession, OPERATOR_COOKIE_NAME } = await import('../web/operator-sessions.js')

const BOARD_FILE = join(H.store, 'board-access.json')
const ACCOUNTS_FILE = join(H.store, 'colleague-accounts.json')
const board = (enabled: boolean) => writeFileSync(BOARD_FILE, JSON.stringify({
  enabled, people: { alice: { name: 'Alice', assignees: ['alice'], role: 'self' } }, agents: {},
}))
const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as any

afterAll(() => rmSync(H.store, { recursive: true, force: true }))

describe('who is loopback', () => {
  it.each([
    ['127.0.0.1', true], ['127.5.6.7', true], ['::1', true], ['::ffff:127.0.0.1', true],
    ['192.168.1.20', false], ['10.0.0.5', false], ['172.17.0.1', false], ['::ffff:192.168.1.20', false], ['fe80::1', false], ['', false],
  ])('peer %s -> %s', (addr, loop) => {
    expect(L.isLoopbackPeer(addr)).toBe(loop)
  })
  it('a missing socket address is not loopback', () => {
    expect(L.isLoopbackPeer(undefined)).toBe(false)
  })
  it.each([
    ['127.0.0.1', true], ['localhost', true], ['::1', true], ['0.0.0.0', false], ['::', false], ['192.168.1.20', false],
  ])('bind %s -> %s', (host, loop) => {
    expect(L.isLoopbackHost(host)).toBe(loop)
  })
})

describe('when the lock is active', () => {
  const all = { mode: 'auto' as const, webHost: '0.0.0.0', colleagueInUse: true, boardOn: true }
  it('auto: all three conditions -> active', () => {
    expect(L.lanLockActive(all)).toBe(true)
  })
  it('auto: any one missing -> not active (a loopback bind, no enabled account, the board off)', () => {
    expect(L.lanLockActive({ ...all, webHost: '127.0.0.1' })).toBe(false)
    expect(L.lanLockActive({ ...all, colleagueInUse: false })).toBe(false)
    expect(L.lanLockActive({ ...all, boardOn: false })).toBe(false)
  })
  it('on is always active, off never', () => {
    expect(L.lanLockActive({ mode: 'on', webHost: '127.0.0.1', colleagueInUse: false, boardOn: false })).toBe(true)
    expect(L.lanLockActive({ ...all, mode: 'off' })).toBe(false)
  })
  it('the setting reads auto for an empty or unknown value', () => {
    expect(L.readLanLockMode(() => 'on')).toBe('on')
    expect(L.readLanLockMode(() => ' OFF ')).toBe('off')
    expect(L.readLanLockMode(() => 'auto')).toBe('auto')
    expect(L.readLanLockMode(() => '')).toBe('auto')
    expect(L.readLanLockMode(() => 'nope')).toBe('auto')
    expect(L.readLanLockMode(() => undefined)).toBe('auto')
  })
})

describe('the decision before authentication, with the lock active (plain listener)', () => {
  const lan = req('192.168.1.20')
  const active = () => true
  const at = (r: any, m: string, p: string, publicListener = false) => L.lanLockPreAuth({ req: r, path: p, method: m, publicListener }, active)

  it.each([
    ['POST', '/api/colleague/login'], ['GET', '/api/colleague/me'], ['POST', '/api/colleague/logout'],
    ['GET', '/api/board/cards'], ['POST', '/api/board/cards/abc/move'], ['GET', '/api/board/report'],
    ['GET', '/colleague'], ['GET', '/colleague.html'], ['GET', '/colleague.js'], ['GET', '/style.css'], ['GET', '/lang/hu.js'], ['GET', '/lang/en.js'],
  ])('LAN %s %s: the colleague surface passes with only its own cookie (COLLCOOKIE1121)', (m, p) => {
    expect(at(lan, m, p)).toEqual({ action: 'colleague-cookie-only' })
  })

  it('keepOnlyColleagueCookie: the mv_colleague pair alone stays (the first, as the gate reads it); none -> no header', () => {
    const h: any = { cookie: 'mv_session=own; mv_colleague=col1; mv_operator=op; mv_colleague=col2; mv_setup=s' }
    L.keepOnlyColleagueCookie(h)
    expect(h.cookie).toBe('mv_colleague=col1')
    const none: any = { cookie: 'mv_session=own; mv_operator=op' }
    L.keepOnlyColleagueCookie(none)
    expect('cookie' in none).toBe(false)
    const empty: any = { cookie: 'mv_colleague=' }
    L.keepOnlyColleagueCookie(empty)
    expect('cookie' in empty).toBe(false)
    const absent: any = {}
    L.keepOnlyColleagueCookie(absent)
    expect('cookie' in absent).toBe(false)
  })

  it.each([['POST', '/api/auth/login'], ['POST', '/api/auth/login/totp'], ['POST', '/api/auth/setup-code'], ['POST', '/api/operator/login']])(
    'LAN %s %s: a browser login route is refused with 403', (m, p) => {
      const d = at(lan, m, p)
      expect(d.action).toBe('deny')
      expect(d.action === 'deny' && d.result.status).toBe(403)
    })

  it.each([
    ['GET', '/api/kanban'], ['POST', '/api/messages'], ['GET', '/.well-known/fleetq'], ['POST', '/api/approvals/teams-card-action'],
    ['GET', '/api/auth/status'], ['GET', '/'], ['GET', '/api/colleague-accounts'], ['GET', '/api//board/cards'], ['GET', '/API/BOARD/cards'],
  ])('LAN %s %s: goes on to the gate with every cookie dropped', (m, p) => {
    expect(at(lan, m, p)).toEqual({ action: 'strip-cookies' })
  })

  it('the WEB_PUBLIC_PORT listener (HTTPS, its own protection) is not locked, the owner login included', () => {
    expect(at(lan, 'POST', '/api/auth/login', true)).toEqual({ action: 'pass' })
    expect(at(lan, 'GET', '/api/kanban', true)).toEqual({ action: 'pass' })
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('loopback %s: everything as today, and the lock state is not even read', (addr) => {
    const spy = vi.fn(() => true)
    for (const [m, p] of [['POST', '/api/auth/login'], ['GET', '/'], ['GET', '/api/kanban'], ['POST', '/api/operator/login']]) {
      expect(L.lanLockPreAuth({ req: req(addr), path: p, method: m, publicListener: false }, spy)).toEqual({ action: 'pass' })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('a LAN request that claims loopback in X-Forwarded-For (or X-Real-IP, Forwarded) is still a LAN request', () => {
    const forged = req('192.168.1.20', { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' })
    expect(at(forged, 'POST', '/api/auth/login').action).toBe('deny')
    expect(at(forged, 'GET', '/api/kanban').action).toBe('strip-cookies')
  })

  it('lock not active: a LAN request is untouched', () => {
    for (const [m, p] of [['POST', '/api/auth/login'], ['GET', '/api/kanban']]) {
      expect(L.lanLockPreAuth({ req: lan, path: p, method: m, publicListener: false }, () => false)).toEqual({ action: 'pass' })
    }
  })
})

describe('end to end with the real gate: the order web.ts runs (lock, drop cookies, gateRequest)', () => {
  const MAIN = 'main-dashboard-token-' + 'x'.repeat(24)
  let ownerCookie = ''
  let operatorCookie = ''
  let deviceKey = ''
  let colleagueCookie = ''

  beforeAll(async () => {
    initDatabase(':memory:')
    const owner = createDashboardUser('owner', 'x'.repeat(60))
    ownerCookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: owner.id, username: 'owner' })}`
    const op = createDeviceKey('ops-laptop', { scope: 'operator', expiresInDays: 1 })
    operatorCookie = `${OPERATOR_COOKIE_NAME}=${createOperatorSession(op.id, null).token}`
    deviceKey = createDeviceKey('bridge', {}).key
    await createColleagueAccount({ username: 'bob', person: 'alice', password: 'correct horse battery' }, () => true)
    _clearColleagueAccountsCacheForTest()
    colleagueCookie = `${COLLEAGUE_COOKIE_NAME}=${createColleagueSession('bob', 1)}`
  })

  /** What the handler would see: the 403 of the lock, the 401 of the gate, or the principal's kind. */
  async function lanRequest(peer: string, method: string, path: string, headers: Record<string, string>): Promise<number | string> {
    const r: any = { socket: { remoteAddress: peer }, headers: { ...headers }, method, url: path }
    const lan = L.lanLockPreAuth({ req: r, path, method, publicListener: false }, () => true)
    if (lan.action === 'deny') return 403
    if (lan.action === 'strip-cookies') delete r.headers.cookie
    if (lan.action === 'colleague-cookie-only') L.keepOnlyColleagueCookie(r.headers)
    let status = 0
    const res: any = { writeHead(c: number) { status = c; return res }, setHeader() {}, end() {} }
    const url = new URL(`http://localhost${path}`)
    const auth = await gateRequest(r, res, url, path, method, { dashboardToken: MAIN, mainAgentId: 'main' })
    return auth === null ? status : auth.kind
  }

  it('positive control: on loopback the owner cookie and the operator cookie DO authenticate', async () => {
    expect(await lanRequest('127.0.0.1', 'GET', '/api/kanban', { cookie: ownerCookie })).toBe('session')
    expect(await lanRequest('127.0.0.1', 'GET', '/api/kanban', { cookie: operatorCookie })).toBe('device')
  })

  it('LAN + a valid machine credential: passes (the dashboard Bearer, a device key)', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/kanban', { authorization: `Bearer ${MAIN}` })).toBe('token')
    expect(await lanRequest('192.168.1.20', 'GET', '/api/kanban', { authorization: `Bearer ${deviceKey}` })).toBe('device')
  })

  it('LAN + the owner cookie and an invalid Bearer: not authenticated (401)', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/kanban', { cookie: ownerCookie, authorization: 'Bearer not-a-real-token-at-all' })).toBe(401)
  })

  it('LAN + only the owner cookie: not authenticated (401)', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/kanban', { cookie: ownerCookie })).toBe(401)
  })

  it('LAN + only the operator page cookie: not authenticated (401), though it is a device principal on loopback', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/kanban', { cookie: operatorCookie })).toBe(401)
  })

  it('colleague surface, positive control: on loopback the owner cookie DOES resolve as the owner there', async () => {
    expect(await lanRequest('127.0.0.1', 'GET', '/api/board/cards', { cookie: ownerCookie })).toBe('session')
    expect(await lanRequest('127.0.0.1', 'GET', '/api/board/cards', { cookie: `${ownerCookie}; ${colleagueCookie}` })).toBe('session')
  })

  it('colleague surface, LAN + only the owner cookie (or the operator cookie): not authenticated (401) (COLLCOOKIE1121)', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/board/cards', { cookie: ownerCookie })).toBe(401)
    expect(await lanRequest('192.168.1.20', 'GET', '/api/board/cards', { cookie: operatorCookie })).toBe(401)
  })

  it('colleague surface, LAN + the colleague cookie: the colleague, also next to an owner and an operator cookie', async () => {
    expect(await lanRequest('192.168.1.20', 'GET', '/api/board/cards', { cookie: colleagueCookie })).toBe('colleague')
    expect(await lanRequest('192.168.1.20', 'GET', '/api/board/cards', { cookie: `${ownerCookie}; ${operatorCookie}; ${colleagueCookie}` })).toBe('colleague')
  })

  it('LAN owner login: refused by the lock (403) before the password is ever checked', async () => {
    expect(await lanRequest('192.168.1.20', 'POST', '/api/auth/login', { cookie: ownerCookie })).toBe(403)
  })
})

describe('the live state: the setting, the accounts file and the board config', () => {
  beforeEach(() => {
    rmSync(ACCOUNTS_FILE, { force: true })
    rmSync(BOARD_FILE, { force: true })
    _clearColleagueAccountsCacheForTest()
  })
  it('auto with a non-loopback bind: active only with an enabled account AND the board on', async () => {
    expect(L.lanLockActiveNow('0.0.0.0')).toBe(false) // no accounts, no board: an install that opened WEB_HOST for itself
    board(true)
    expect(L.lanLockActiveNow('0.0.0.0')).toBe(false) // board on, still no colleague account
    await createColleagueAccount({ username: 'alice', person: 'alice', password: 'correct horse battery' }, () => true)
    _clearColleagueAccountsCacheForTest()
    expect(L.lanLockActiveNow('0.0.0.0')).toBe(true)
    board(false)
    expect(L.lanLockActiveNow('0.0.0.0')).toBe(false) // board off
    board(true)
    setColleagueDisabled('alice', true)
    _clearColleagueAccountsCacheForTest()
    expect(L.lanLockActiveNow('0.0.0.0')).toBe(false) // the only account disabled
  })
  it('auto with a loopback bind: never active', async () => {
    board(true)
    await createColleagueAccount({ username: 'alice', person: 'alice', password: 'correct horse battery' }, () => true)
    _clearColleagueAccountsCacheForTest()
    expect(L.lanLockActiveNow('127.0.0.1')).toBe(false)
    expect(readFileSync(ACCOUNTS_FILE, 'utf-8')).toContain('alice')
  })
})

describe('the setting: off loosens, so only the owner sets it and a .env line cannot', () => {
  const def = SETTINGS_REGISTRY.find((d) => d.key === 'COLLEAGUE_LAN_LOCK')!
  it('exists with auto as the default and the three values', () => {
    expect(def.default).toBe('auto')
    expect(def.valueSet).toEqual(['auto', 'on', 'off'])
    expect(def.requiresRestart).toBe(false)
  })
  it('loosening is any step down on -> auto -> off; a step up is not', () => {
    expect(def.loosens?.('auto', 'off')).toBe(true)
    expect(def.loosens?.('on', 'auto')).toBe(true)
    expect(def.loosens?.('on', 'off')).toBe(true)
    expect(def.loosens?.('off', 'auto')).toBe(false)
    expect(def.loosens?.('auto', 'on')).toBe(false)
    expect(def.loosens?.('auto', 'auto')).toBe(false)
  })
  it('it is overrides-only: a .env off is ignored, a .env on counts', () => {
    expect(isOverridesOnly(def)).toBe(true)
    expect(envValueTightens(def, 'off')).toBe(false)
    expect(envValueTightens(def, 'on')).toBe(true)
  })
})

describe('wiring: web.ts decides the lock before the gate and drops the cookies', () => {
  it('lanLockPreAuth runs before gateRequest; deny answers 403 with its rule; strip-cookies deletes the cookie header', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const lock = src.indexOf('    const lan = lanLockPreAuth({ req, path, method, publicListener: isPublicRequest(req) }, () => lanLockActiveNow(WEB_HOST))')
    const gate = src.indexOf('await gateRequest(req, res, url, path, method')
    expect(lock).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(lock)
    const between = src.slice(lock, gate)
    expect(between).toContain("if (lan.action === 'deny') {")
    expect(between).toContain("rule: 'colleague-lan-lock'")
    expect(between).toContain("    if (lan.action === 'strip-cookies') delete req.headers.cookie\n")
    expect(between).toContain("    if (lan.action === 'colleague-cookie-only') keepOnlyColleagueCookie(req.headers)\n")
  })
})
