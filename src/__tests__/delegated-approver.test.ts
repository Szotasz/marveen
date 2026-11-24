// DELEGAPPROVER1123 (PR1): the delegated human approver.
//   - an approver session is never the owner: mayActAsOwner refuses it (also its cookie beside the shared token or a
//     Bridge key), the approver gate keeps it off every route but its sign-in and the approval decision, and the
//     owner-gated handlers themselves answer 403;
//   - it decides (approve or reject) a request only within a live scope (category x agent), never an owner-only
//     category, through the decision core (mode 'approver') with an approval_events 'decided' row;
//   - it signs in only with TOTP;
//   - disabling it or removing a scope deletes its sessions in the same step.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
  notifyOwner: vi.fn(async () => {}),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'marveen' }))

import {
  initDatabase, getDb, createDashboardUser, getDashboardUser, createApproval, getApproval, listApprovalEvents,
  addApproverScope,
} from '../db.js'
import { tryHandleAuth, mayActAsOwner, mayActAsOwnerOrFirstRun, FIRST_RUN_PATHS } from '../web/routes/auth.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { resolveAuth, parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { createSession, resolveSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import { _setTotpStorePathForTest, _resetTotpStateForTest } from '../web/dashboard-totp.js'
import { hotp, base32Decode, totpStepAt } from '../web/totp.js'
import { hashPassword } from '../web/password-hash.js'
import { approverGateDecision } from '../web/approver-gate.js'
import { DELEGABLE_APPROVAL_CATEGORIES, isOwnerOnlyCategory, mayApprove } from '../web/approver-access.js'
import { UPDATE_REBASE_CATEGORY } from '../update-rebase-plan.js'
import { SECOND_REVIEW_CATEGORY } from '../web/routes/review-action.js'
import { scanRoutes } from './helpers/route-owner-scan.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']

const PW = 'approver-secret-pw-1'
const OWNER: Auth = { kind: 'session', user: 'owner' }
const HASH = 'a'.repeat(64)

// Every category the seed autonomy config ships, read from the file (not a copy of it).
const SEED_CATEGORIES: string[] = (JSON.parse(readFileSync(new URL('../../seed-config/autonomy-config.json', import.meta.url), 'utf8')) as {
  categories: { key: string }[]
}).categories.map((c) => c.key)

// DELEGAPPROVER1123 (Dani's review of #3094, B1): the owner-only set is everything outside the allowlist. Sampled here:
// every seed key outside it, the categories the code itself asks for, and keys no config knows (a later or made-up one).
const OWNER_ONLY_SAMPLE: string[] = [
  ...SEED_CATEGORIES.filter((c) => !DELEGABLE_APPROVAL_CATEGORIES.includes(c)),
  UPDATE_REBASE_CATEGORY,
  SECOND_REVIEW_CATEGORY,
  'agent_create',
  'pr_merge',
  'github_issue_handling',
  'kanban_anything_new',
  'some_future_key',
]

const td = mkdtempSync(join(tmpdir(), 'delegapprover-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))

interface Out { status: number; headers: Record<string, string | string[]>; body: string; json(): any }

async function call(handler: (ctx: RouteContext) => Promise<boolean>, method: string, pathAndQuery: string, opts: { body?: unknown; auth?: Auth; cookie?: string } = {}): Promise<Out> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage
  req.headers = (opts.cookie ? { cookie: opts.cookie } : {}) as http.IncomingHttpHeaders
  ;(req as { method?: string }).method = method
  ;(req as { url?: string }).url = pathAndQuery
  const out: Out = { status: 0, headers: {}, body: '', json() { return JSON.parse(this.body || '{}') } }
  const res = {
    writeHead(s: number, h?: Record<string, string | string[]>) { out.status = s; if (h) Object.assign(out.headers, h); return res },
    setHeader(k: string, v: string) { out.headers[k] = v },
    end(c?: string) { if (c) out.body += c },
  }
  const url = new URL(`http://127.0.0.1:3420${pathAndQuery}`)
  const handled = await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth: opts.auth })
  expect(handled).toBe(true)
  return out
}

const auth = (method: string, p: string, o: Parameters<typeof call>[3] = {}) => call(tryHandleAuth, method, p, o)
const approvals = (method: string, p: string, o: Parameters<typeof call>[3] = {}) => call(tryHandleApprovals, method, p, o)

function cookieOf(o: Out): string {
  const c = o.headers['Set-Cookie']
  const line = Array.isArray(c) ? c[0]! : (c ?? '')
  return parseCookies(line.split(';')[0])[SESSION_COOKIE_NAME] ?? ''
}

function reqWithCookie(cookie: string | null, extra: Record<string, string> = {}): http.IncomingMessage {
  return { headers: { ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}), ...extra }, url: '/x', method: 'GET' } as unknown as http.IncomingMessage
}

function resolveAs(cookie: string): ReturnType<typeof resolveAuth> {
  const req = reqWithCookie(cookie)
  return resolveAuth(req, new URL('http://127.0.0.1:3420/api/approvals/x'), '/api/approvals/x', 'GET', 'dashboard-token-xyz')
}

/** Creates an approver through the owner's API; returns its TOTP secret. */
async function createApprover(username = 'anna'): Promise<string> {
  const r = await auth('POST', '/api/auth/approvers', { auth: OWNER, body: { username, password: PW } })
  expect(r.status).toBe(201)
  return String(r.json().totp.secret)
}

/** The full sign-in (password, then the code); returns the session cookie value. */
async function signIn(username: string, secret: string): Promise<string> {
  const p = await auth('POST', '/api/auth/login', { body: { username, password: PW } })
  expect(p.status).toBe(401)
  expect(p.json().code).toBe('totp_required')
  const code = hotp(base32Decode(secret), totpStepAt(Date.now()))
  const t = await auth('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code } })
  expect(t.status).toBe(200)
  const c = cookieOf(t)
  expect(c).not.toBe('')
  return c
}

async function addScope(username: string, category: string, agent: string): Promise<Out> {
  return auth('POST', `/api/auth/approvers/${username}/scopes`, { auth: OWNER, body: { category, agent } })
}

let approvalNo = 0
function newApproval(category: string, agent = 'samu', contentHash: string | null = HASH): string {
  const id = `appr-test-${++approvalNo}`
  createApproval({ id, agent_id: agent, category, action_description: `test ${approvalNo}`, action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: contentHash })
  return id
}

const APPROVER = (user = 'anna'): Auth => ({ kind: 'approver', user })

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  const store = join(td, 'store'); mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'autonomy-config.json'), JSON.stringify({ categories: [] }))
  initDatabase(join(store, 'claudeclaw.db'))
  _setTotpStorePathForTest(join(store, '.dashboard-totp.json'))
})

beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM approver_scopes; DELETE FROM dashboard_users; DELETE FROM approval_events; DELETE FROM approvals')
  _clearSessionCacheForTest()
  _resetThrottleForTest()
  _resetTotpStateForTest()
  rmSync(join(td, 'store', '.dashboard-totp.json'), { force: true })
  createDashboardUser('owner', await hashPassword('owner-secret-pw-1'))
})

describe('role and migration', () => {
  it('a login created the old ways is an owner; the approver API creates role approver with TOTP on', async () => {
    expect(getDashboardUser('owner')!.role).toBe('owner')
    await createApprover('anna')
    const a = getDashboardUser('anna')!
    expect(a.role).toBe('approver')
    expect(a.totp_enabled).toBe(1)
  })

  it('only the owner creates, lists and changes approvers', async () => {
    for (const who of [{ kind: 'token' } as Auth, { kind: 'token', tokenAgent: 'samu', agent: 'samu' } as Auth, APPROVER(), undefined]) {
      expect((await auth('POST', '/api/auth/approvers', { auth: who, body: { username: 'x1', password: PW } })).status).toBe(403)
      expect((await auth('GET', '/api/auth/approvers', { auth: who })).status).toBe(403)
    }
    await createApprover('anna')
    for (const who of [{ kind: 'token' } as Auth, APPROVER()]) {
      expect((await auth('POST', '/api/auth/approvers/anna/scopes', { auth: who, body: { category: 'kanban_restructure', agent: '*' } })).status).toBe(403)
      expect((await auth('POST', '/api/auth/approvers/anna/disable', { auth: who })).status).toBe(403)
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approver_scopes').get()).toEqual({ n: 0 })
    const list = await auth('GET', '/api/auth/approvers', { auth: OWNER })
    expect(list.status).toBe(200)
    expect(list.json().approvers.map((u: { username: string }) => u.username)).toEqual(['anna'])
  })

  it('the API refuses an owner-only category as a scope', async () => {
    await createApprover('anna')
    for (const c of OWNER_ONLY_SAMPLE) {
      const r = await addScope('anna', c, '*')
      expect(r.status, c).toBe(400)
      expect(r.json().code).toBe('owner_only_category')
    }
  })
})

describe('TOTP is mandatory for an approver', () => {
  it('signs in with password + code, and the session resolves to the approver kind', async () => {
    const secret = await createApprover('anna')
    const c = await signIn('anna', secret)
    expect(resolveAs(c)).toEqual({ kind: 'approver', user: 'anna' })
  })

  it('an approver without TOTP enrolled gets no session, and a session minted around it resolves to nothing', async () => {
    const u = createDashboardUser('bob', await hashPassword(PW), 'approver')
    const p = await auth('POST', '/api/auth/login', { body: { username: 'bob', password: PW } })
    expect(p.status).toBe(403)
    expect(p.json().code).toBe('approver_totp_required')
    expect(p.headers['Set-Cookie']).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(u.id)).toEqual({ n: 0 })
    const c = createSession({ userId: u.id, username: 'bob' })
    expect(resolveAs(c)).toEqual({ kind: 'none' })
  })
})

describe('an approver session is never the owner', () => {
  it('mayActAsOwner refuses it, and its cookie beside the shared token or a Bridge key', async () => {
    const secret = await createApprover('anna')
    const c = await signIn('anna', secret)
    const req = reqWithCookie(c)
    expect(mayActAsOwner(APPROVER(), req)).toBe(false)
    expect(mayActAsOwner({ kind: 'token' }, req)).toBe(false)
    expect(mayActAsOwner({ kind: 'device', device: 'bridge', deviceId: 1, scope: 'full' }, req)).toBe(false)
    for (const why of FIRST_RUN_PATHS) expect(mayActAsOwnerOrFirstRun(APPROVER(), req, why), why).toBe(false)
    // control: the owner's own cookie beside the token still counts
    const owner = getDashboardUser('owner')!
    const oc = createSession({ userId: owner.id, username: 'owner' })
    expect(mayActAsOwner({ kind: 'token' }, reqWithCookie(oc))).toBe(true)
    expect(mayActAsOwner(OWNER, reqWithCookie(oc))).toBe(true)
  })

  // Every path literal the route files test, every method: the approver gate refuses all of them except its sign-in
  // routes and the approval decision. Enumerated from the sources, so a route added later is covered.
  const ROUTE_DIR = join(process.cwd(), 'src', 'web', 'routes')
  const literalPaths = [...new Set(readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...readFileSync(join(ROUTE_DIR, f), 'utf8').matchAll(/path === '(\/api\/[^']+)'/g)].map((m) => m[1]!)))].sort()
  const ALLOWED = new Set(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/login/totp', 'POST /api/auth/logout'])

  it('the enumeration sees the route surface', () => {
    expect(literalPaths.length).toBeGreaterThan(150)
  })

  it('the approver gate refuses every enumerated route and method except its sign-in', () => {
    const leaked: string[] = []
    for (const p of literalPaths) {
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const allowed = approverGateDecision({ kind: 'approver' }, p, m) === null
        if (allowed !== ALLOWED.has(`${m} ${p}`)) leaked.push(`${m} ${p}`)
      }
    }
    expect(leaked).toEqual([])
    // the decision route (a match route, so not in the literal list): GET and PATCH only, canonical spelling only
    expect(approverGateDecision({ kind: 'approver' }, '/api/approvals/abc-1', 'PATCH')).toBeNull()
    expect(approverGateDecision({ kind: 'approver' }, '/api/approvals/abc-1', 'GET')).toBeNull()
    for (const [p, m] of [['/api/approvals/abc-1', 'POST'], ['/api/approvals/abc-1', 'DELETE'], ['/api/approvals/abc-1/consume', 'POST'],
      ['/api/approvals', 'GET'], ['/api/approvals', 'POST'], ['/API/approvals/abc-1', 'PATCH'], ['/api/approvals/%61bc', 'PATCH'],
      ['/api/approvals/teams-card-action', 'PATCH'], ['/api/agents/samu', 'DELETE'], ['/api/schedules/1', 'PUT'], ['/api/vault/x', 'GET']]) {
      expect(approverGateDecision({ kind: 'approver' }, p!, m!), `${m} ${p}`).not.toBeNull()
    }
    // other principals are untouched
    expect(approverGateDecision({ kind: 'session' }, '/api/agents/samu', 'DELETE')).toBeNull()
  })

  it('every owner-gated state-changing route (the ROUTEPIN scan) is refused by the gate wherever its path is a literal', () => {
    const scan = scanRoutes(process.cwd())
    const gated = scan.routes.filter((r) => r.gated && r.pathKey.startsWith('/api/'))
    expect(gated.length).toBeGreaterThan(30)
    const open: string[] = []
    for (const r of gated) {
      for (const p of r.pathKey.split('|')) {
        if (p.endsWith('*')) continue
        for (const m of r.methods) if (approverGateDecision({ kind: 'approver' }, p, m) === null) open.push(`${m} ${p} (${r.key})`)
      }
    }
    expect(open).toEqual([])
  })

  it('owner-gated handlers answer 403 to an approver session themselves (without the gate in front)', async () => {
    await createApprover('anna')
    const a = APPROVER()
    for (const [m, p, body] of [
      ['GET', '/api/auth/users', undefined],
      ['POST', '/api/auth/users', { username: 'evil', password: PW }],
      ['GET', '/api/auth/approvers', undefined],
      ['POST', '/api/auth/approvers', { username: 'evil2', password: PW }],
      ['POST', '/api/auth/approvers/anna/scopes', { category: 'kanban_restructure', agent: '*' }],
      ['POST', '/api/auth/approvers/anna/disable', undefined],
      ['GET', '/api/auth/totp', undefined],
      ['POST', '/api/auth/totp/setup', undefined],
      ['POST', '/api/auth/device-keys', { name: 'x' }],
    ] as const) {
      const r = await auth(m, p, { auth: a, body })
      expect(r.status, `${m} ${p}`).toBe(403)
    }
    expect(getDashboardUser('evil')).toBeUndefined()
    // born-approved POST on the approvals route: the owner gate refuses it
    const born = await approvals('POST', '/api/approvals', { auth: a, body: { agent_id: 'marveen', category: 'kanban_restructure', action_description: 'x', owner_approved_message_id: 5 } })
    expect([400, 403]).toContain(born.status)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'approved'").get()).toEqual({ n: 0 })
  })
})

describe('mayApprove on the decide route', () => {
  it('an in-scope, non-owner-only request: approved through the core, mode approver, with a decided event', async () => {
    await createApprover('anna')
    expect((await addScope('anna', 'kanban_restructure', 'samu')).status).toBe(201)
    const id = newApproval('kanban_restructure', 'samu')
    const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })
    expect(r.status).toBe(200)
    const row = getApproval(id)!
    expect(row.status).toBe('approved')
    expect(row.resolved_by).toBe('dashboard_approver:anna')
    const ev = listApprovalEvents(id)
    expect(ev.map((e) => [e.event, e.actor, e.reason, e.ref])).toEqual([['decided', 'anna', 'approved scope=kanban_restructure:samu', HASH]])
  })

  it('a reject goes the same way; the wildcard agent scope covers every agent', async () => {
    await createApprover('anna')
    await addScope('anna', 'kanban_restructure', '*')
    const id = newApproval('kanban_restructure', 'bence', null)
    const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'rejected', resolved_by: 'anna' } })
    expect(r.status).toBe(200)
    expect(getApproval(id)!.status).toBe('rejected')
    expect(listApprovalEvents(id).map((e) => [e.event, e.reason, e.ref])).toEqual([['decided', 'rejected scope=kanban_restructure:*', null]])
  })

  it('a hash-bound request needs the hash shown, and the right one', async () => {
    await createApprover('anna')
    await addScope('anna', 'kanban_restructure', 'samu')
    const id = newApproval('kanban_restructure', 'samu')
    expect((await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna' } })).status).toBe(400)
    expect((await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: 'b'.repeat(64) } })).status).toBe(409)
    expect(getApproval(id)!.status).toBe('pending')
    expect(listApprovalEvents(id)).toEqual([])
  })

  it('refused for a category outside the scope', async () => {
    await createApprover('anna')
    await addScope('anna', 'kanban_restructure', '*')
    const id = newApproval('memory_maintenance', 'samu')
    const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })
    expect(r.status).toBe(403)
    expect(getApproval(id)!.status).toBe('pending')
    expect((await approvals('GET', `/api/approvals/${id}`, { auth: APPROVER() })).status).toBe(404)
  })

  it('refused for an agent outside the scope', async () => {
    await createApprover('anna')
    await addScope('anna', 'kanban_restructure', 'samu')
    const id = newApproval('kanban_restructure', 'bence')
    const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })
    expect(r.status).toBe(403)
    expect(getApproval(id)!.status).toBe('pending')
  })

  it('refused for another approver\'s scope', async () => {
    await createApprover('anna')
    await createApprover('bea')
    await addScope('bea', 'kanban_restructure', '*')
    const id = newApproval('kanban_restructure', 'samu')
    expect((await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER('anna'), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })).status).toBe(403)
  })

  it('refused for EVERY owner-only category, even with a scope row written past the API', async () => {
    await createApprover('anna')
    const anna = getDashboardUser('anna')!
    expect(DELEGABLE_APPROVAL_CATEGORIES).toEqual(['kanban_archive_done', 'kanban_stuck_nudge', 'kanban_restructure', 'memory_maintenance', 'routine_trivial_fix'])
    for (const c of OWNER_ONLY_SAMPLE) {
      addApproverScope(anna.id, c, '*', 'test')
      const id = newApproval(c, 'samu')
      expect(mayApprove(APPROVER(), getApproval(id)), c).toBe(false)
      const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })
      expect(r.status, c).toBe(403)
      expect(getApproval(id)!.status, c).toBe('pending')
    }
    // the owner still decides them
    const id = newApproval('email_send', 'samu')
    expect(mayApprove(OWNER, getApproval(id))).toBe(true)
  })

  it('refused for a request already decided', async () => {
    await createApprover('anna')
    await addScope('anna', 'kanban_restructure', '*')
    const id = newApproval('kanban_restructure', 'samu')
    getDb().prepare("UPDATE approvals SET status = 'rejected', resolved_by = 'owner' WHERE id = ?").run(id)
    expect((await approvals('PATCH', `/api/approvals/${id}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })).status).toBe(403)
    expect(getApproval(id)!.status).toBe('rejected')
  })

  it('the owner decides as before (no routing change)', async () => {
    const id = newApproval('kanban_restructure', 'samu')
    const owner = getDashboardUser('owner')!
    const c = createSession({ userId: owner.id, username: 'owner' })
    const r = await approvals('PATCH', `/api/approvals/${id}`, { auth: OWNER, cookie: `${SESSION_COOKIE_NAME}=${c}`, body: { status: 'approved', resolved_by: 'owner' } })
    expect(r.status).toBe(200)
    expect(getApproval(id)!.resolved_by).toBe('owner')
  })
})

describe('immediate revocation', () => {
  it('disabling an approver deletes its sessions in the same step', async () => {
    const secret = await createApprover('anna')
    const c = await signIn('anna', secret)
    const id = getDashboardUser('anna')!.id
    expect((await auth('POST', '/api/auth/approvers/anna/disable', { auth: OWNER })).status).toBe(200)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(id)).toEqual({ n: 0 })
    expect(resolveSession(c)).toBeNull()
    expect(resolveAs(c)).toEqual({ kind: 'none' })
    // and it cannot sign in again
    const p = await auth('POST', '/api/auth/login', { body: { username: 'anna', password: PW } })
    expect(p.status).toBe(401)
  })

  it('removing a scope deletes the approver\'s sessions in the same step', async () => {
    const secret = await createApprover('anna')
    await addScope('anna', 'kanban_restructure', 'samu')
    const c = await signIn('anna', secret)
    const id = getDashboardUser('anna')!.id
    const r = await auth('DELETE', '/api/auth/approvers/anna/scopes?category=kanban_restructure&agent=samu', { auth: OWNER })
    expect(r.status).toBe(200)
    expect(r.json().removed).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(id)).toEqual({ n: 0 })
    expect(resolveSession(c)).toBeNull()
    // signed in again, the removed scope no longer decides
    const ap = newApproval('kanban_restructure', 'samu')
    expect((await approvals('PATCH', `/api/approvals/${ap}`, { auth: APPROVER(), body: { status: 'approved', resolved_by: 'anna', content_hash: HASH } })).status).toBe(403)
  })
})

describe('the delegable categories are an allowlist (DELEGAPPROVER1123, B1)', () => {
  it('every allowlisted key is a real seed category, and none of them is locked', () => {
    const seed = (JSON.parse(readFileSync(new URL('../../seed-config/autonomy-config.json', import.meta.url), 'utf8')) as {
      categories: { key: string; locked?: boolean }[]
    }).categories
    for (const c of DELEGABLE_APPROVAL_CATEGORIES) {
      const row = seed.find((r) => r.key === c)
      expect(row, c).toBeDefined()
      expect(row!.locked, c).not.toBe(true)
      expect(isOwnerOnlyCategory(c), c).toBe(false)
    }
  })

  it('every other seed key, every code-owned category and any unknown key is owner-only', () => {
    expect(OWNER_ONLY_SAMPLE).toContain('deploy_retry')
    expect(OWNER_ONLY_SAMPLE).toContain('skill_patch')
    expect(OWNER_ONLY_SAMPLE).toContain('external_skill_adoption')
    for (const c of OWNER_ONLY_SAMPLE) expect(isOwnerOnlyCategory(c), c).toBe(true)
  })
})
