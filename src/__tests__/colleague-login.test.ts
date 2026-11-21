// Colleague board login (colleague-accounts.ts, colleague-sessions.ts, colleague-gate.ts, routes/colleague.ts):
// a colleague signs in with an owner-made account and reaches only its own board cards.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'

// Every store/ file (board-access.json, colleague-accounts.json) goes to a scratch dir, never the checkout's store/.
const H = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { store: mkdtempSync(join(tmpdir(), 'colleague-login-')) }
})
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), STORE_DIR: H.store }))

import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, getKanbanCardEvents, getDb } from '../db.js'
import { gateRequest, resolveAuth, requiresAuth, type AuthResult } from '../web/auth-gate.js'
import { boardGateDecision, readBoardAccess } from '../web/board-access.js'
import { colleagueGateDecision, COLLEAGUE_STATIC_PATHS } from '../web/colleague-gate.js'
import {
  COLLEAGUE_ACCOUNTS_PATH, createColleagueAccount, readColleagueAccounts, normaliseColleagueAccounts,
  setColleagueDisabled, resetColleaguePassword, deleteColleagueAccount, _clearColleagueAccountsCacheForTest,
} from '../web/colleague-accounts.js'
import {
  COLLEAGUE_COOKIE_NAME, createColleagueSession, resolveColleagueSession, _ageColleagueSessionForTest,
  COLLEAGUE_IDLE_TTL_SEC, COLLEAGUE_ABSOLUTE_TTL_SEC,
} from '../web/colleague-sessions.js'
import { tryHandleColleague, colleagueLoginThrottle } from '../web/routes/colleague.js'
import { tryHandleBoard } from '../web/routes/board.js'
import { mayActAsOwner, ownerCookieSession } from '../web/routes/auth.js'
import { checkThrottle, _resetThrottleForTest } from '../web/login-throttle.js'
import { securityReset } from '../web/security-reset.js'
import { isBlockedCrossOriginWrite } from '../web/csrf-origin.js'
import type { RouteContext } from '../web/routes/types.js'

const BOARD_FILE = join(H.store, 'board-access.json')
const BOARD = {
  enabled: true,
  people: {
    alice: { name: 'Alice', assignees: ['alice'], role: 'self' },
    bob: { name: 'Bob', assignees: ['bob'], role: 'self' },
  },
  agents: {},
}
const writeBoard = (v: unknown): void => writeFileSync(BOARD_FILE, JSON.stringify(v))
const PW = 'correct horse battery'
const MAIN = 'm'.repeat(64)

// ---- request helpers -------------------------------------------------------------------------

interface Resp { status: number; headers: Record<string, string>; body: any }
function fakeRes(out: Resp): http.ServerResponse {
  const res = {
    writeHead(c: number, h?: Record<string, string>) { out.status = c; Object.assign(out.headers, h ?? {}); return res },
    setHeader(k: string, v: string) { out.headers[k] = v; return res },
    end(d?: unknown) { try { out.body = JSON.parse(String(d ?? '')) } catch { out.body = d } },
  } as unknown as http.ServerResponse
  return res
}
function fakeReq(headers: Record<string, string>, body?: unknown): http.IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(req as unknown as { headers: Record<string, string> }).headers = headers
  ;(req as unknown as { socket: unknown }).socket = { remoteAddress: '192.0.2.10' }
  return req
}

/** gateRequest + the colleague gate + the board gate, as web.ts composes them, then the two route modules. */
async function http_(method: string, path: string, opts: { cookie?: string; bearer?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Resp> {
  const out: Resp = { status: 0, headers: {}, body: undefined }
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  const req = fakeReq(headers, opts.body)
  const res = fakeRes(out)
  const url = new URL(`http://127.0.0.1${path}`)
  const auth = await gateRequest(req, res, url, url.pathname, method, { dashboardToken: MAIN, mainAgentId: 'main' })
  if (!auth) return out
  const c = colleagueGateDecision(auth, url.pathname, method)
  if (c) { out.status = c.status; out.body = c; return out }
  if (requiresAuth(url.pathname, method) && boardGateDecision(auth, url.pathname, () => readBoardAccess())) { out.status = 403; out.body = { rule: 'board-scope' }; return out }
  const ctxAuth = auth.kind === 'none' ? undefined : (auth as RouteContext['auth'])
  const ctx: RouteContext = { req, res, path: url.pathname, method, url, auth: ctxAuth }
  if (await tryHandleColleague(ctx, '/nonexistent-webdir')) return out
  if (await tryHandleBoard(ctx)) return out
  out.status = 200
  out.body = { reached: 'some-other-handler', auth: auth.kind }
  return out
}

function cookieFrom(r: Resp): string {
  const sc = r.headers['Set-Cookie'] ?? ''
  const m = new RegExp(`${COLLEAGUE_COOKIE_NAME}=([^;]*)`).exec(sc)
  return m ? `${COLLEAGUE_COOKIE_NAME}=${m[1]}` : ''
}

async function login(username: string, password = PW): Promise<Resp> {
  return http_('POST', '/api/colleague/login', { body: { username, password } })
}

// Every /api path the server handles, from the source (as board-access.test.ts / operator-scope-gate.test.ts do).
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!.replace(/\([^)]*\)/g, 'x').replace(/\[[^\]]*\][+*]?/g, 'x').replace(/\\\//g, '/').replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

// ---- the gate (pure) -------------------------------------------------------------------------

describe('colleagueGateDecision: default deny by prefix', () => {
  const colleague = { kind: 'colleague' }

  it('every enumerated /api path outside /api/board and /api/colleague/ is 403, with every method', () => {
    const paths = enumerateApiPaths()
    expect(paths.length).toBeGreaterThan(150)
    const outside = paths.filter((p) => !p.startsWith('/api/board') && !p.startsWith('/api/colleague/'))
    expect(outside).toEqual(expect.arrayContaining(['/api/kanban', '/api/memories', '/api/agents', '/api/schedules', '/api/messages', '/api/settings', '/api/auth/login', '/api/colleague-accounts']))
    for (const p of outside) {
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(colleagueGateDecision(colleague, p, m)?.status, `${m} ${p}`).toBe(403)
      }
    }
  })

  it('a route added later, and every spelling variant of an allowed one, is 403', () => {
    for (const p of ['/api/brand-new', '/api/kanban/x/move', '/api/kanban-projects', '/api//board/cards', '/api/%62oard/cards', '/API/BOARD/cards',
      '/api/board%2fcards', '/api/Colleague/me', '/api/colleague-accounts/alice/password', '/api', '/api/']) {
      expect(colleagueGateDecision(colleague, p, 'POST')?.status, p).toBe(403)
    }
  })

  it('/api/board* and /api/colleague/* pass', () => {
    for (const p of ['/api/board/cards', '/api/board/cards/abc', '/api/board/cards/abc/move', '/api/board/report', '/api/colleague/me', '/api/colleague/logout', '/api/colleague/login']) {
      expect(colleagueGateDecision(colleague, p, 'GET'), p).toBeNull()
    }
  })

  it('pages are redirected to the colleague page; static files are a closed set; a non-api write is 403', () => {
    for (const p of ['/', '/index.html', '/operator', '/video-review.html', '/app.js', '/.well-known/fleetq', '/avatars/x.png', '/Colleague']) {
      expect(colleagueGateDecision(colleague, p, 'GET'), p).toEqual({ status: 302, location: '/colleague' })
    }
    for (const p of COLLEAGUE_STATIC_PATHS) expect(colleagueGateDecision(colleague, p, 'GET'), p).toBeNull()
    expect(colleagueGateDecision(colleague, '/', 'POST')?.status).toBe(403)
  })

  it('no other principal is touched', () => {
    for (const a of [{ kind: 'token' }, { kind: 'session' }, { kind: 'device' }, { kind: 'federation' }, { kind: 'none' }]) {
      expect(colleagueGateDecision(a, '/api/kanban', 'POST'), a.kind).toBeNull()
    }
  })

  it('web.ts runs the colleague gate for every path, right after gateRequest and before any route or other gate', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const gate = src.indexOf('colleagueGateDecision(auth, path, method)')
    expect(gate).toBeGreaterThan(src.indexOf('if (auth === null) return'))
    expect(gate).toBeLessThan(src.indexOf('operatorGateDecision(auth, path'))
    expect(gate).toBeLessThan(src.indexOf("if (path === '/api/network-info'"))
    expect(gate).toBeLessThan(src.indexOf('await tryHandleAuth(routeCtx)'))
    // Not nested in the requiresAuth() block: public paths and pages are fenced too.
    const between = src.slice(src.indexOf('if (auth === null) return'), gate)
    expect(between).not.toMatch(/requiresAuth\(/)
    expect(src.indexOf('await tryHandleColleague(routeCtx, WEB_DIR)')).toBeGreaterThan(0)
  })
})

describe('boardGateDecision for a colleague session', () => {
  const colleague = { kind: 'colleague' }
  it('board on: /api/board passes; off or broken: refused', () => {
    const on = () => readBoardAccess(BOARD_FILE)
    writeBoard(BOARD)
    expect(boardGateDecision(colleague, '/api/board/cards', on)).toBeNull()
    // Off the board the colleague gate (not this one) decides; /api/kanban is refused there.
    expect(boardGateDecision(colleague, '/api/colleague/me', on)).toBeNull()
    expect(colleagueGateDecision(colleague, '/api/kanban', 'GET')?.status).toBe(403)
    writeBoard({ ...BOARD, enabled: false })
    expect(boardGateDecision(colleague, '/api/board/cards', on)).not.toBeNull()
    writeFileSync(BOARD_FILE, '{ broken')
    expect(boardGateDecision(colleague, '/api/board/cards', on)).not.toBeNull()
  })
})

// ---- accounts, sessions and routes over a real (in-memory) database ----------------------------

describe('colleague login end to end', () => {
  beforeAll(async () => {
    initDatabase(':memory:')
    writeBoard(BOARD)
    rmSync(COLLEAGUE_ACCOUNTS_PATH, { force: true })
    const exists = (pid: string) => readBoardAccess().people.has(pid)
    await createColleagueAccount({ username: 'alice', person: 'alice', password: PW }, exists)
    await createColleagueAccount({ username: 'Bob', person: 'bob', password: PW }, exists)
  }, 30_000)

  beforeEach(() => {
    writeBoard(BOARD)
    colleagueLoginThrottle.reset()
    _resetThrottleForTest()
    getDb().prepare('DELETE FROM kanban_comments').run()
    getDb().prepare('DELETE FROM kanban_cards').run()
    createKanbanCard({ id: 'c-alice', title: 'Alice task', assignee: 'alice' })
    createKanbanCard({ id: 'c-bob', title: 'Bob task', assignee: 'bob' })
    createKanbanCard({ id: 'c-none', title: 'Unassigned' })
  })

  it('the account file holds only a scrypt hash, at 0600; the username is lower-cased', () => {
    const raw = readFileSync(COLLEAGUE_ACCOUNTS_PATH, 'utf-8')
    expect(raw).not.toContain(PW)
    expect(raw).toContain('$scrypt$')
    expect(statSync(COLLEAGUE_ACCOUNTS_PATH).mode & 0o777).toBe(0o600)
    expect([...readColleagueAccounts().accounts.keys()].sort()).toEqual(['alice', 'bob'])
  })

  it('login sets an HttpOnly SameSite=Strict mv_colleague cookie, never mv_session', async () => {
    const r = await login('alice')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, username: 'alice', person: { id: 'alice', name: 'Alice' } })
    const sc = r.headers['Set-Cookie']!
    expect(sc).toMatch(/^mv_colleague=[A-Za-z0-9_-]{40,};/)
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('SameSite=Strict')
    expect(sc).not.toContain('mv_session')
    expect(JSON.stringify(r.body)).not.toContain('$scrypt$')
  })

  it('wrong password, unknown user and a disabled account are all 401 Invalid credentials', async () => {
    expect((await login('alice', 'wrong password!')).status).toBe(401)
    expect((await login('nobody')).status).toBe(401)
    setColleagueDisabled('bob', true)
    const r = await login('bob')
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Invalid credentials' })
    setColleagueDisabled('bob', false)
    expect((await login('BOB')).status).toBe(200)
  })

  it('login is throttled after 5 failures, on its own counter (the owner login is not locked)', async () => {
    for (let i = 0; i < 5; i++) expect((await login('alice', `wrong-${i}-xxxxxx`)).status).toBe(401)
    const r = await login('alice')
    expect(r.status).toBe(429)
    expect(Number(r.headers['Retry-After'])).toBeGreaterThan(0)
    expect(checkThrottle('alice').locked).toBe(false)
  }, 20_000)

  it('the session resolves to kind colleague, which no owner check accepts', async () => {
    const cookie = cookieFrom(await login('alice'))
    const req = fakeReq({ cookie })
    const url = new URL('http://127.0.0.1/api/kanban')
    const auth = resolveAuth(req, url, '/api/kanban', 'GET', MAIN)
    expect(auth).toEqual({ kind: 'colleague', colleague: 'alice', person: 'alice' })
    expect(mayActAsOwner(auth as RouteContext['auth'], req)).toBe(false)
    expect(ownerCookieSession(req)).toBeNull()
    // Even a forged mv_session cookie carrying the colleague value is not an owner session.
    const forged = fakeReq({ cookie: cookie.replace(COLLEAGUE_COOKIE_NAME, 'mv_session') })
    expect(ownerCookieSession(forged)).toBeNull()
    expect(resolveAuth(forged, url, '/api/kanban', 'GET', MAIN).kind).toBe('none')
  })

  it('a colleague session cannot reach owner routes, /api/kanban* or the account admin', async () => {
    const cookie = cookieFrom(await login('alice'))
    for (const [m, p] of [['GET', '/api/kanban'], ['POST', '/api/kanban'], ['POST', '/api/kanban/c-bob/move'], ['GET', '/api/kanban-projects'],
      ['GET', '/api/memories'], ['GET', '/api/agents'], ['GET', '/api/settings'], ['GET', '/api/schedules'], ['POST', '/api/messages'],
      ['GET', '/api/colleague-accounts'], ['POST', '/api/colleague-accounts'], ['POST', '/api/auth/device-keys'], ['GET', '/api/network-info']]) {
      const r = await http_(m!, p!, { cookie })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
    expect((await http_('GET', '/', { cookie })).status).toBe(302)
  })

  it('sees only its own cards; the person is the session\'s, never a header\'s', async () => {
    const cookie = cookieFrom(await login('alice'))
    const list = await http_('GET', '/api/board/cards', { cookie, headers: { 'x-board-person': 'bob', 'x-board-sender': '1' } })
    expect(list.status).toBe(200)
    expect(list.body.person).toEqual({ id: 'alice', name: 'Alice' })
    expect(list.body.cards.map((c: { id: string }) => c.id)).toEqual(['c-alice'])
    expect((await http_('GET', '/api/board/cards/c-bob', { cookie, headers: { 'x-board-person': 'bob' } })).status).toBe(404)
    expect((await http_('POST', '/api/board/cards/c-bob/move', { cookie, headers: { 'x-board-person': 'bob' }, body: { status: 'done' } })).status).toBe(404)
    expect(getKanbanCard('c-bob')!.status).toBe('planned')
    expect((await http_('POST', '/api/board/cards/c-none/comments', { cookie, body: { content: 'x' } })).status).toBe(404)
  })

  it('creates, comments on and moves its own card; a card for someone else is refused', async () => {
    const cookie = cookieFrom(await login('alice'))
    const created = await http_('POST', '/api/board/cards', { cookie, headers: { 'x-board-person': 'bob' }, body: { title: 'New one', priority: 'high' } })
    expect(created.status).toBe(200)
    expect(getKanbanCard(created.body.id)!.assignee).toBe('alice')
    expect((await http_('POST', '/api/board/cards', { cookie, body: { title: 'For bob', assignee: 'bob' } })).status).toBe(403)
    const c = await http_('POST', '/api/board/cards/c-alice/comments', { cookie, body: { content: 'on it' } })
    expect(c.status).toBe(200)
    expect(getKanbanComments('c-alice').map((x) => x.author)).toEqual(['Alice'])
    const mv = await http_('POST', '/api/board/cards/c-alice/move', { cookie, body: { status: 'waiting' } })
    expect(mv.status).toBe(200)
    expect(getKanbanCard('c-alice')!.status).toBe('waiting')
  })

  it('a colleague session closes its own card to done without evidence; the status event names the account', async () => {
    // Maintainer decision on #2929 (option a): a colleague session is a human writer, so the board's done-gate,
    // which holds an AGENT's close at testing (board-access.test.ts pins that side), does not hold it.
    // The account is 'bob' and its person's display name is 'Bob', so the actor assertion tells the two apart;
    // the colleague: prefix keeps an account named like an agent or the owner from reading as them (#2929 review).
    const cookie = cookieFrom(await login('bob'))
    const mv = await http_('POST', '/api/board/cards/c-bob/move', { cookie, body: { status: 'done' } })
    expect(mv.status).toBe(200)
    expect(mv.body).toMatchObject({ ok: true, status: 'done' })
    expect(mv.body.evidence_required).toBeUndefined()
    expect(getKanbanCard('c-bob')!.status).toBe('done')
    const last = getKanbanCardEvents('c-bob').at(-1)!
    expect(last).toMatchObject({ from_status: 'planned', to_status: 'done', actor: 'colleague:bob' })
  })

  it('the colleague page treats a 200 with ok:false on a move as a refusal, not a success', () => {
    // #2929 review: move() decided success by the HTTP status alone, so a soft refusal (200, ok:false) was a silent
    // reload. The page now shows the answer and puts the select back, before the success path's load().
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'colleague.js'), 'utf-8')
    const start = src.indexOf('async function move(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n  }\n', start))
    const refusal = body.indexOf('r.data.ok === false')
    expect(refusal).toBeGreaterThan(-1)
    const branch = body.slice(refusal, body.indexOf('return', refusal))
    expect(branch).toContain('sel.value = card.status')
    expect(branch).not.toContain('load()')
    expect(refusal).toBeLessThan(body.lastIndexOf('load()'))
    for (const lang of ['en', 'hu']) {
      expect(readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf-8')).toContain("'colleague.err.refused':")
    }
  })

  it('me names the session\'s person; logout ends the session', async () => {
    const cookie = cookieFrom(await login('alice'))
    const me = await http_('GET', '/api/colleague/me', { cookie })
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ username: 'alice', person: { id: 'alice', name: 'Alice', role: 'self' }, board_available: true })
    const out = await http_('POST', '/api/colleague/logout', { cookie })
    expect(out.status).toBe(200)
    expect(out.headers['Set-Cookie']).toContain('Max-Age=0')
    expect((await http_('GET', '/api/board/cards', { cookie })).status).toBe(401)
  })

  it('disable, password reset and delete end open sessions on the next request', async () => {
    const a = cookieFrom(await login('alice'))
    setColleagueDisabled('alice', true)
    expect((await http_('GET', '/api/board/cards', { cookie: a })).status).toBe(401)
    setColleagueDisabled('alice', false)
    // Re-enabling does not revive the old session (the generation moved on).
    expect((await http_('GET', '/api/board/cards', { cookie: a })).status).toBe(401)

    const b = cookieFrom(await login('alice'))
    await resetColleaguePassword('alice', 'another long password')
    expect((await http_('GET', '/api/board/cards', { cookie: b })).status).toBe(401)
    expect((await login('alice')).status).toBe(401)
    const c = cookieFrom(await login('alice', 'another long password'))
    await resetColleaguePassword('alice', PW)
    expect((await http_('GET', '/api/board/cards', { cookie: c })).status).toBe(401)

    const d = cookieFrom(await login('bob'))
    deleteColleagueAccount('bob')
    expect((await http_('GET', '/api/board/cards', { cookie: d })).status).toBe(401)
    await createColleagueAccount({ username: 'bob', person: 'bob', password: PW }, () => true)
  }, 30_000)

  it('a person removed from board-access.json, or the board turned off, closes the board to the session', async () => {
    const cookie = cookieFrom(await login('alice'))
    writeBoard({ ...BOARD, people: { bob: BOARD.people.bob } })
    expect((await http_('GET', '/api/board/cards', { cookie })).status).toBe(403)
    expect((await login('alice')).status).toBe(403)
    writeBoard({ ...BOARD, enabled: false })
    expect((await http_('GET', '/api/board/cards', { cookie })).status).toBe(403)
  })

  it('idle and absolute TTLs are enforced server-side', async () => {
    const now = Math.floor(Date.now() / 1000)
    const t1 = createColleagueSession('alice', readColleagueAccounts().accounts.get('alice')!.generation)
    expect(resolveColleagueSession(t1)).not.toBeNull()
    _ageColleagueSessionForTest(t1, { lastSeenAt: now - COLLEAGUE_IDLE_TTL_SEC - 5 })
    expect(resolveColleagueSession(t1)).toBeNull()
    const t2 = createColleagueSession('alice', readColleagueAccounts().accounts.get('alice')!.generation)
    _ageColleagueSessionForTest(t2, { createdAt: now - COLLEAGUE_ABSOLUTE_TTL_SEC - 5 })
    expect(resolveColleagueSession(t2)).toBeNull()
  })

  it('an unreadable account file signs nobody in and ends every session (fail closed), and is never overwritten', async () => {
    const cookie = cookieFrom(await login('alice'))
    const good = readFileSync(COLLEAGUE_ACCOUNTS_PATH, 'utf-8')
    try {
      writeFileSync(COLLEAGUE_ACCOUNTS_PATH, '{ not json')
      _clearColleagueAccountsCacheForTest()
      expect((await http_('GET', '/api/board/cards', { cookie })).status).toBe(401)
      expect((await login('alice')).status).toBe(401)
      expect(() => setColleagueDisabled('alice', true)).toThrow(/unreadable/)
      expect(readFileSync(COLLEAGUE_ACCOUNTS_PATH, 'utf-8')).toBe('{ not json')
    } finally {
      writeFileSync(COLLEAGUE_ACCOUNTS_PATH, good)
      _clearColleagueAccountsCacheForTest()
    }
  })

  it('a malformed account entry cannot sign in; only literal disabled:false keeps an account usable', () => {
    const r = normaliseColleagueAccounts({ accounts: {
      ok: { person: 'alice', passwordHash: '$scrypt$x', disabled: false },
      typo: { person: 'alice', passwordHash: '$scrypt$x', disabled: 'no' },
      Upper: { person: 'alice', passwordHash: '$scrypt$x', disabled: false },
      nohash: { person: 'alice', disabled: false },
    } })
    expect(r.broken).toBe(false)
    expect(r.accounts.get('ok')!.disabled).toBe(false)
    expect(r.accounts.get('typo')!.disabled).toBe(true)
    expect(r.accounts.has('Upper') || r.accounts.has('upper')).toBe(false)
    expect(r.accounts.has('nohash')).toBe(false)
    expect(normaliseColleagueAccounts([]).broken).toBe(true)
  })

  it('the owner API needs the owner session; the shared token alone, a colleague or a device key is refused', async () => {
    const cookie = cookieFrom(await login('alice'))
    const call = async (auth: RouteContext['auth'], method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> => {
      const out: Resp = { status: 0, headers: {}, body: undefined }
      const url = new URL(`http://127.0.0.1${path}`)
      await tryHandleColleague({ req: fakeReq(headers, body), res: fakeRes(out), path, method, url, auth }, '/x')
      return out
    }
    for (const auth of [{ kind: 'token' as const }, { kind: 'token' as const, agent: 'main' }, { kind: 'colleague' as const, colleague: 'alice', person: 'alice' },
      { kind: 'device' as const, device: 'd', deviceId: 1, scope: 'full' as const }, undefined]) {
      expect((await call(auth, 'GET', '/api/colleague-accounts', undefined, { cookie })).status, JSON.stringify(auth)).toBe(403)
      expect((await call(auth, 'POST', '/api/colleague-accounts/alice/disable', undefined, { cookie })).status, JSON.stringify(auth)).toBe(403)
    }
    expect(readColleagueAccounts().accounts.get('alice')!.disabled).toBe(false)

    const owner = { kind: 'session' as const, user: 'owner' }
    const list = await call(owner, 'GET', '/api/colleague-accounts')
    expect(list.status).toBe(200)
    expect(list.body.accounts.map((a: { username: string }) => a.username)).toEqual(['alice', 'bob'])
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt|passwordHash|password_hash/)
    expect(Object.keys(list.body.accounts[0]).sort()).toEqual(['createdAt', 'disabled', 'person', 'updatedAt', 'username'])

    const created = await call(owner, 'POST', '/api/colleague-accounts', { username: 'carol', person: 'bob', password: PW })
    expect(created.status).toBe(200)
    expect(JSON.stringify(created.body)).not.toMatch(/scrypt|passwordHash/)
    expect((await call(owner, 'POST', '/api/colleague-accounts', { username: 'carol', person: 'bob', password: PW })).status).toBe(409)
    expect((await call(owner, 'POST', '/api/colleague-accounts', { username: 'dave', person: 'ghost', password: PW })).status).toBe(400)
    expect((await call(owner, 'POST', '/api/colleague-accounts', { username: 'dave', person: 'bob', password: 'short' })).status).toBe(400)
    const reset = await call(owner, 'POST', '/api/colleague-accounts/carol/password', { password: 'yet another password' })
    expect(reset.status).toBe(200)
    expect(JSON.stringify(reset.body)).not.toMatch(/scrypt|passwordHash/)
    expect((await call(owner, 'POST', '/api/colleague-accounts/carol/disable')).body.account.disabled).toBe(true)
    expect((await call(owner, 'POST', '/api/colleague-accounts/carol/enable')).body.account.disabled).toBe(false)
    expect((await call(owner, 'DELETE', '/api/colleague-accounts/carol')).status).toBe(200)
    expect((await call(owner, 'DELETE', '/api/colleague-accounts/carol')).status).toBe(404)
  }, 30_000)

  it('security:reset clears colleague sessions too', async () => {
    const cookie = cookieFrom(await login('alice'))
    const r = securityReset('test')
    expect(r.colleagueSessionsCleared).toBeGreaterThanOrEqual(1)
    expect((await http_('GET', '/api/board/cards', { cookie })).status).toBe(401)
  })

  it('the CSRF origin gate covers colleague writes (it runs before auth for every request)', () => {
    const allowed = new Set(['http://localhost:3420'])
    expect(isBlockedCrossOriginWrite('POST', 'https://evil.example', '192.168.1.10:3420', undefined, allowed)).toBe(true)
    expect(isBlockedCrossOriginWrite('POST', 'http://192.168.1.10:3420', '192.168.1.10:3420', undefined, allowed)).toBe(false)
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    expect(src.indexOf('isBlockedCrossOriginWrite(method, origin')).toBeLessThan(src.indexOf('await gateRequest('))
  })
})

// The colleague kind is a closed shape: AuthResult carries no owner fields for it.
describe('AuthResult colleague kind', () => {
  it('carries the account and the person only', () => {
    const a: AuthResult = { kind: 'colleague', colleague: 'alice', person: 'alice' }
    expect(Object.keys(a).sort()).toEqual(['colleague', 'kind', 'person'])
  })
})
