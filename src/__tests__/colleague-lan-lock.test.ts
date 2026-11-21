// COLLANLOCK1120 (Refs #2929): while the colleague LAN lock is active, a non-loopback peer on the plain listener
// passes only to the colleague surface or with a machine credential (Dani); the owner's password login and cookie
// session are refused, so the owner login cannot be tried from the LAN. auto locks only while the colleague login is in use (WEB_HOST
// not loopback, an enabled colleague account, the board on), so an install that opened WEB_HOST for its own remote
// access (Docker, a VPS) changes nothing. The peer is the socket's address, never a header.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
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
const { SETTINGS_REGISTRY, isOverridesOnly, envValueTightens } = await import('../config-registry.js')

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

describe('route by route, with the lock active (plain listener)', () => {
  const lan = req('192.168.1.20')
  const active = () => true
  const at = (r: any, m: string, p: string, authKind = 'none', publicListener = false) =>
    L.lanLockDecision({ req: r, path: p, method: m, authKind, publicListener }, active)

  it.each([
    ['POST', '/api/colleague/login'], ['GET', '/api/colleague/me'], ['POST', '/api/colleague/logout'],
    ['GET', '/api/board/cards'], ['POST', '/api/board/cards/abc/move'], ['GET', '/api/board/report'],
    ['GET', '/colleague'], ['GET', '/colleague.html'], ['GET', '/colleague.js'], ['GET', '/style.css'], ['GET', '/lang/hu.js'], ['GET', '/lang/en.js'],
  ])('LAN, no principal, %s %s: the colleague surface passes', (m, p) => {
    expect(at(lan, m, p)).toBeNull()
  })

  it.each([
    ['POST', '/api/auth/login'], ['POST', '/api/auth/login/totp'], ['GET', '/api/auth/status'], ['POST', '/api/auth/setup-code'],
    ['POST', '/api/operator/login'], ['GET', '/api/marveen/avatar'], ['GET', '/api/video-review/file'],
    ['GET', '/api//board/cards'], ['GET', '/API/BOARD/cards'], ['GET', '/api/%62oard/cards'], ['POST', '/'],
  ])('LAN, no principal, %s %s: refused with 403 (the owner login is never tried)', (m, p) => {
    expect(at(lan, m, p)?.status).toBe(403)
  })

  it.each([['GET', '/'], ['GET', '/index.html'], ['HEAD', '/app.js']])('LAN, no principal, %s %s (an owner page): redirected to /colleague', (m, p) => {
    expect(at(lan, m, p)).toEqual({ status: 302, location: '/colleague' })
  })

  it.each([['GET', '/api/kanban'], ['POST', '/api/settings'], ['GET', '/api/memories'], ['GET', '/']])('LAN, the owner cookie session, %s %s: refused', (m, p) => {
    expect(at(lan, m, p, 'session')).not.toBeNull()
  })

  it.each([
    ['token', 'GET', '/api/kanban'], ['token', 'POST', '/api/messages'], ['device', 'GET', '/api/agents'],
    ['federation', 'GET', '/.well-known/fleetq'], ['federation', 'POST', '/api/federation/inbound'],
  ])('LAN, a machine credential (%s) %s %s: passes', (kind, m, p) => {
    expect(at(lan, m, p, kind)).toBeNull()
  })

  it('LAN, the Teams card webhook (no principal at the gate, the handler checks its Bot Framework token): passes', () => {
    expect(at(lan, 'POST', '/api/approvals/teams-card-action')).toBeNull()
  })

  it('LAN, a colleague session: passes here (the colleague gate fences it right after)', () => {
    expect(at(lan, 'GET', '/api/kanban', 'colleague')).toBeNull()
  })

  it('the WEB_PUBLIC_PORT listener (HTTPS, its own protection) is not locked, the owner login included', () => {
    expect(at(lan, 'POST', '/api/auth/login', 'none', true)).toBeNull()
    expect(at(lan, 'GET', '/', 'session', true)).toBeNull()
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('loopback %s: everything as today, and the lock state is not even read', (addr) => {
    const spy = vi.fn(() => true)
    for (const [m, p, k] of [['POST', '/api/auth/login', 'none'], ['GET', '/', 'session'], ['GET', '/api/kanban', 'session'], ['GET', '/api/auth/status', 'none']]) {
      expect(L.lanLockDecision({ req: req(addr), path: p, method: m, authKind: k, publicListener: false }, spy)).toBeNull()
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('a LAN request that claims loopback in X-Forwarded-For (or X-Real-IP, Forwarded) is still a LAN request', () => {
    const forged = req('192.168.1.20', { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' })
    expect(at(forged, 'POST', '/api/auth/login')?.status).toBe(403)
  })

  it('lock not active: a LAN request is untouched', () => {
    const off = (m: string, p: string, k: string) => L.lanLockDecision({ req: lan, path: p, method: m, authKind: k, publicListener: false }, () => false)
    expect(off('POST', '/api/auth/login', 'none')).toBeNull()
    expect(off('GET', '/', 'session')).toBeNull()
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

describe('wiring: web.ts decides the lock after the principal is resolved, before any handler', () => {
  it('lanLockDecision runs right after gateRequest, with the auth kind and the public-listener flag, before every route', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const gate = src.indexOf('await gateRequest(req, res, url, path, method')
    const lock = src.indexOf('lanLockDecision(\n      { req, path, method, authKind: auth.kind, publicListener: isPublicRequest(req) },')
    const firstRoute = src.indexOf('if (await tryHandleAuth(routeCtx)) return')
    expect(gate).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(gate)
    expect(firstRoute).toBeGreaterThan(lock)
    expect(src.slice(lock, firstRoute)).toContain("rule: 'colleague-lan-lock'")
  })
})
