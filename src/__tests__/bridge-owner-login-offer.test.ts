// BRIDGEPWLOGIN1101 (Samu 64763, plan A): /api/auth/status says whether the owner's password session rides on the
// request (owner_session, a bool, only for a caller that could hold one), and the dashboard, opened with a full device
// key (the Bridge), offers the password login on the first owner refusal (403 owner_session_required, Samu 65968), with
// "Later". Real resolveAuth, sessions and keys for the
// server; the shipped web/app.js function, evaluated from the file, for the client.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { resolveAuth, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { createDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { _clearSessionCacheForTest, createSession, revokeSession } from '../web/auth-sessions.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = 'd'.repeat(64)
const ROOT = join(__dirname, '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

async function status(headers: Record<string, string>) {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  req.headers = headers
  const url = new URL('http://127.0.0.1:3420/api/auth/status')
  const auth = resolveAuth(req, url, url.pathname, 'GET', TOKEN) as RouteContext['auth']
  let body = ''
  const res: any = { writeHead() { return res }, setHeader() {}, end(d?: string) { if (d) body += d } }
  expect(await tryHandleAuth({ req, res, path: url.pathname, method: 'GET', url, auth } as RouteContext)).toBe(true)
  return JSON.parse(body) as Record<string, unknown>
}

let cookie = ''
beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  const out = { status: 0 }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end() {} }
  const req = Readable.from([Buffer.from(JSON.stringify({ username: 'owner', password: 'super-secret-pw' }))]) as unknown as http.IncomingMessage
  req.headers = {}
  const url = new URL('http://127.0.0.1:3420/api/auth/users')
  await tryHandleAuth({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as RouteContext)
  expect(out.status).toBe(201)
  cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: getDashboardUser('owner')!.id, username: 'owner' })}`
})

describe('owner_session in the status (a bool, only for a caller that could hold one)', () => {
  it('S1: a full key without and with the owner cookie: false, then true; method device', async () => {
    const key = createDeviceKey('Bridge').key
    expect(await status({ authorization: `Bearer ${key}` })).toMatchObject({ method: 'device', login_available: true, owner_session: false })
    expect(await status({ authorization: `Bearer ${key}`, cookie })).toMatchObject({ method: 'device', owner_session: true })
  })

  it('S2: the session itself: true; the shared token: false without the cookie, true with it', async () => {
    expect(await status({ cookie })).toMatchObject({ method: 'session', owner_session: true })
    expect(await status({ authorization: `Bearer ${TOKEN}` })).toMatchObject({ method: 'token', owner_session: false })
    expect(await status({ authorization: `Bearer ${TOKEN}`, cookie })).toMatchObject({ method: 'token', owner_session: true })
  })

  it('S3: absent for an anonymous caller and an operator key, even beside the cookie; a logged-out cookie reads false', async () => {
    expect('owner_session' in (await status({}))).toBe(false)
    const op = createDeviceKey('Op', { scope: 'operator', expiresInDays: 7 }).key
    expect('owner_session' in (await status({ authorization: `Bearer ${op}`, cookie }))).toBe(false)
    const key = createDeviceKey('Bridge').key
    revokeSession(cookie.split('=')[1]!)
    expect(await status({ authorization: `Bearer ${key}`, cookie })).toMatchObject({ owner_session: false })
  })

  it('S4: only a bool: no session id, user or expiry rides along for a device caller', async () => {
    const s = await status({ authorization: `Bearer ${createDeviceKey('Bridge').key}`, cookie })
    expect(typeof s.owner_session).toBe('boolean')
    expect(s.user).toBe(null)
    expect(JSON.stringify(s)).not.toContain(cookie.split('=')[1]!)
  })
})

// The shipped function, evaluated from web/app.js with its closure's names passed in.
function extractFn(name: string): string {
  const m = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`).exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}
type Offer = () => Promise<void>
function makeOffer(env: { token: string; status: Record<string, unknown> | null; later?: string | null; fetchThrows?: boolean }) {
  const shown: unknown[] = []
  const fetched: Array<{ url: string; init: any }> = []
  const store = new Map<string, string>(env.later ? [['mv-login-later', env.later]] : [])
  const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
  const originalFetch = async (url: string, init: any) => {
    fetched.push({ url, init })
    if (env.fetchThrows) throw new Error('offline')
    return { ok: env.status !== null, json: async () => env.status }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const offer = new Function('sessionToken', 'originalFetch', 'showLoginOverlay', 'sessionStorage', 'LOGIN_LATER_KEY',
    `${extractFn('offerOwnerLoginOnce')}; return offerOwnerLoginOnce`)(env.token, originalFetch, (o: unknown) => shown.push(o), sessionStorage, 'mv-login-later') as Offer
  return { offer, shown, fetched, store }
}

describe('the offer on opening the Bridge (web/app.js offerOwnerLoginOnce)', () => {
  const bridge = { authenticated: true, method: 'device', login_available: true, owner_session: false }

  it('O1: a device window with a login and no owner session: the overlay once, cancellable, as "Later"; the status asked with the key', async () => {
    const w = makeOffer({ token: 'mvdk_x', status: bridge })
    await w.offer()
    expect(w.shown).toEqual([{ cancellable: true, later: true }])
    expect(w.fetched).toHaveLength(1)
    expect(w.fetched[0]!.url).toBe('/api/auth/status')
    expect(w.fetched[0]!.init.headers.Authorization).toBe('Bearer mvdk_x')
  })

  it('O2: no offer when the owner session is there, when no login exists, outside a device window, or when the field is absent (an operator key)', async () => {
    for (const s of [
      { ...bridge, owner_session: true },
      { ...bridge, login_available: false },
      { ...bridge, method: 'token' },
      { ...bridge, method: 'session', owner_session: true },
      { authenticated: true, method: 'device', login_available: true },
    ]) {
      const w = makeOffer({ token: 'mvdk_x', status: s })
      await w.offer()
      expect([s, w.shown]).toEqual([s, []])
    }
  })

  it('O3: "Later" earlier in this run, no stored key, or a failed status: no offer and, without a key or with Later, no request', async () => {
    let w = makeOffer({ token: 'mvdk_x', status: bridge, later: '1' })
    await w.offer()
    expect([w.shown, w.fetched]).toEqual([[], []])
    w = makeOffer({ token: '', status: bridge })
    await w.offer()
    expect([w.shown, w.fetched]).toEqual([[], []])
    w = makeOffer({ token: 'mvdk_x', status: null })
    await w.offer()
    expect(w.shown).toEqual([])
    w = makeOffer({ token: 'mvdk_x', status: bridge, fetchThrows: true })
    await w.offer()
    expect(w.shown).toEqual([])
  })

  it('O4: the overlay keeps the key (no removeItem), "Later" writes the run-only flag, both languages carry the texts, and nothing is offered on load', () => {
    const overlay = extractFn('showLoginOverlay')
    expect(overlay).not.toContain('removeItem')
    expect(overlay).toMatch(/if \(opts\.later\) \{ try \{ sessionStorage\.setItem\(LOGIN_LATER_KEY, '1'\)/)
    expect(overlay).toContain("tr('auth.login.later', 'Later')")
    for (const [f, later] of [['hu.js', 'Később'], ['en.js', 'Later']] as const) {
      const src = readFileSync(join(ROOT, 'web', 'lang', f), 'utf-8')
      expect(src).toContain(`'auth.login.later':             '${later}'`)
      expect(src).toContain("'auth.login.bridge_desc':")
    }
    // Samu 65968: nothing on load; the fetch wrapper offers it on a 403
    expect(APP).not.toMatch(/DOMContentLoaded', \(\) => \{ void offerOwnerLoginOnce/)
    expect(APP).not.toMatch(/^\s*(?:else )?void offerOwnerLoginOnce\(\)/m)
    expect(APP).toMatch(/const res = await originalFetch\(input, init\)\n(?:\s*\/\/.*\n)*\s*if \(res\.status === 403\) void maybeOfferOnOwnerRefusal\(res, isSameOriginApi\)/)
  })

  // Samu 65968: the moment is the first refusal of an owner action, not the opening of the window.
  it('O5: a 403 owner_session_required offers it once per page; another 403, a non-API call or a body that is not JSON does not', async () => {
    const mk = () => {
      const state = { seen: false }
      let offers = 0
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('ownerOffer', 'offerOwnerLoginOnce', `${extractFn('maybeOfferOnOwnerRefusal')}; return maybeOfferOnOwnerRefusal`)(
        state, async () => { offers++ }) as (res: unknown, isApi: boolean) => Promise<void>
      return { fn, state, count: () => offers }
    }
    const resp = (status: number, body: unknown) => ({ status, clone: () => ({ json: async () => { if (body === 'not json') throw new Error('bad'); return body } }) })
    let w = mk()
    await w.fn(resp(403, { code: 'owner_session_required' }), true)
    await w.fn(resp(403, { code: 'owner_session_required' }), true)
    expect(w.count()).toBe(1)
    expect(w.state.seen).toBe(true)
    w = mk()
    await w.fn(resp(403, { code: 'forbidden_credential' }), true)
    await w.fn(resp(401, { code: 'owner_session_required' }), true)
    await w.fn(resp(403, { code: 'owner_session_required' }), false)
    await w.fn(resp(403, 'not json'), true)
    expect(w.count()).toBe(0)
    expect(w.state.seen).toBe(false)
  })

  // Dani 65975 (2): after the login the refused write is NOT sent again by the client; the owner presses it again.
  it('O6: no automatic resend: the offer path issues no request but the status, and a login reloads the page', async () => {
    const realFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (u: unknown) => { seen.push(String(u)); return { ok: false, json: async () => ({}) } }) as typeof fetch
    try {
      const state = { seen: false }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('ownerOffer', 'offerOwnerLoginOnce', `${extractFn('maybeOfferOnOwnerRefusal')}; return maybeOfferOnOwnerRefusal`)(
        state, async () => {}) as (res: unknown, isApi: boolean) => Promise<void>
      await fn({ status: 403, url: '/api/settings', clone: () => ({ json: async () => ({ code: 'owner_session_required' }) }) }, true)
      expect(seen).toEqual([])
    } finally {
      globalThis.fetch = realFetch
    }
    const offer = extractFn('maybeOfferOnOwnerRefusal')
    expect(offer).not.toMatch(/fetch\(|res\.url|input/)
    // the overlay's login: success is a reload, nothing re-sent
    const overlay = extractFn('showLoginOverlay')
    expect(overlay).toMatch(/if \(r\.ok\) \{ window\.location\.reload\(\); return \}/)
    expect((overlay.match(/originalFetch\(/g) ?? []).length).toBe(1)
  })
})
