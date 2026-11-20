// LAN colleague-only mode (web/lan-colleague-only.ts): a non-loopback connection reaches the colleague board
// surface only, decided on the socket address before CORS, CSRF, auth and every handler.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isLoopbackBindHost, isLoopbackRemote, lanColleagueOnlyActive, lanPathDecision, lanPrincipalDecision,
  parseLanColleagueOnlySetting,
} from '../web/lan-colleague-only.js'
import { COLLEAGUE_STATIC_PATHS } from '../web/colleague-gate.js'

describe('parseLanColleagueOnlySetting', () => {
  it('1/0 and their spellings; anything else is auto', () => {
    for (const v of ['1', 'true', 'ON', ' yes ']) expect(parseLanColleagueOnlySetting(v)).toBe('on')
    for (const v of ['0', 'false', 'Off', 'no']) expect(parseLanColleagueOnlySetting(v)).toBe('off')
    for (const v of [undefined, '', 'auto', '2', 'maybe']) expect(parseLanColleagueOnlySetting(v)).toBe('auto')
  })
})

describe('loopback detection', () => {
  it('bind host: localhost, 127/8 and ::1 are loopback; LAN addresses and 0.0.0.0 are not', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackBindHost(h)).toBe(true)
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.8.0.1', 'myhost.lan']) expect(isLoopbackBindHost(h)).toBe(false)
  })
  it('remote address: 127/8, ::1 and the IPv4-mapped form are loopback; a missing address is not (fail closed)', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) expect(isLoopbackRemote(a)).toBe(true)
    for (const a of [undefined, null, '', '192.168.1.20', '::ffff:192.168.1.20', '10.8.0.6', 'fe80::1', '172.17.0.1', '128.0.0.1'])
      expect(isLoopbackRemote(a)).toBe(false)
  })
})

describe('lanColleagueOnlyActive', () => {
  const yes = () => true
  const no = () => false
  it('auto: on only when the bind is network-facing AND colleague accounts exist', () => {
    expect(lanColleagueOnlyActive('auto', '0.0.0.0', yes)).toBe(true)
    expect(lanColleagueOnlyActive('auto', '192.168.1.10', yes)).toBe(true)
    // A VPS install on 0.0.0.0 without colleague accounts keeps working as before.
    expect(lanColleagueOnlyActive('auto', '0.0.0.0', no)).toBe(false)
    expect(lanColleagueOnlyActive('auto', '127.0.0.1', yes)).toBe(false)
  })
  it('the explicit setting wins', () => {
    expect(lanColleagueOnlyActive('on', '0.0.0.0', no)).toBe(true)
    expect(lanColleagueOnlyActive('off', '0.0.0.0', yes)).toBe(false)
  })
  it('auto does not stat the accounts file for a loopback bind', () => {
    let called = false
    lanColleagueOnlyActive('auto', '127.0.0.1', () => { called = true; return true })
    expect(called).toBe(false)
  })
})

describe('lanPathDecision: only the colleague surface, default deny', () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE']
  it('the owner login, the owner pages and every other API are refused before auth', () => {
    const api = [
      '/api/auth/login', '/api/auth/login/totp', '/api/auth/status', '/api/auth/setup-code', '/api/operator/login',
      '/api/memories', '/api/kanban', '/api/messages', '/api/colleague-accounts', '/api/colleague-accounts/x',
      '/api/boardx', '/api/network-info', '/api/video-review/file', '/api/approvals/teams-card-action', '/api',
      '/api/avatars/x.png',
    ]
    for (const p of api) for (const m of methods) expect(lanPathDecision(p, m)).toMatchObject({ status: 403 })
  })
  it('spelling variants of the allowed paths are refused', () => {
    const variants = [
      '/API/BOARD/cards', '/api/%62oard/cards', '/api//board/cards', '/api/board/../kanban', '/api/colleague/%2e%2e/auth/login',
      '/api/Colleague/me', '/api/%63olleague/login', '//api/board', '/Colleague', '/COLLEAGUE.JS', '/colleague.js%00',
    ]
    for (const p of variants) {
      const d = lanPathDecision(p, 'POST')
      expect(d, p).not.toBeNull()
    }
  })
  it('the board, the colleague API and the colleague static files pass', () => {
    for (const p of ['/api/board', '/api/board/cards', '/api/board/cards/abc/move', '/api/colleague/login', '/api/colleague/me', '/api/colleague/logout'])
      for (const m of methods) expect(lanPathDecision(p, m)).toBeNull()
    for (const p of COLLEAGUE_STATIC_PATHS) expect(lanPathDecision(p, 'GET')).toBeNull()
  })
  it('any other page is redirected to the colleague page; a non-api write is 403', () => {
    for (const p of ['/', '/index.html', '/app.js', '/login', '/operator']) {
      expect(lanPathDecision(p, 'GET')).toEqual({ status: 302, location: '/colleague' })
      expect(lanPathDecision(p, 'HEAD')).toEqual({ status: 302, location: '/colleague' })
      expect(lanPathDecision(p, 'POST')).toMatchObject({ status: 403 })
    }
  })
})

describe('lanPrincipalDecision', () => {
  it('only a colleague session or no principal (the colleague login) passes from the network', () => {
    expect(lanPrincipalDecision('colleague')).toBeNull()
    expect(lanPrincipalDecision('none')).toBeNull()
    for (const k of ['token', 'session', 'device', 'federation', 'setup']) expect(lanPrincipalDecision(k)).toMatchObject({ status: 403 })
  })
})

describe('web.ts wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  it('the path check runs before CORS, CSRF, auth and every handler', () => {
    const pathCheck = src.indexOf('lanPathDecision(path, method)')
    expect(pathCheck).toBeGreaterThan(src.indexOf('const server = http.createServer(async (req, res) => {'))
    expect(pathCheck).toBeLessThan(src.indexOf("res.setHeader('Access-Control-Allow-Origin', origin)"))
    expect(pathCheck).toBeLessThan(src.indexOf('isBlockedCrossOriginWrite(method, origin'))
    expect(pathCheck).toBeLessThan(src.indexOf('await gateRequest(req, res, url, path, method'))
    expect(pathCheck).toBeLessThan(src.indexOf('await tryHandleAuth(routeCtx)'))
  })
  it('the principal check runs right after the auth gate, before the colleague gate and the handlers', () => {
    const principal = src.indexOf('lanPrincipalDecision(auth.kind)')
    expect(principal).toBeGreaterThan(src.indexOf('if (auth === null) return'))
    expect(principal).toBeLessThan(src.indexOf('colleagueGateDecision(auth, path, method)'))
    expect(principal).toBeLessThan(src.indexOf('await tryHandleAuth(routeCtx)'))
  })
  it('the confinement is decided on the socket address, never a forwarded header; the public listener is exempt', () => {
    const fn = src.slice(src.indexOf('const lanConfinedRequest'), src.indexOf('const sendLanRefusal'))
    expect(fn).toMatch(/isLoopbackRemote\(req\.socket\?\.remoteAddress\)/)
    expect(fn).toMatch(/isPublicRequest\(req\)/)
    expect(fn).not.toMatch(/x-forwarded|headers/i)
  })
})
