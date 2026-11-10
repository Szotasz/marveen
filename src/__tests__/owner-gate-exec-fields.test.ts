// OWNEREXEC1109: the owner gate on what makes the dashboard execute or import something.
//
//  - Scheduled tasks: setting or changing what a task EXECUTES (type 'command', command, timeoutMs, preCheck,
//    preCheckTimeoutSeconds) is an owner action, on PUT and (type 'command') on POST. Prompt, cron, enabled and the
//    other fields stay on the shared token, and re-sending an exec field with its stored value is no change.
//  - Migration: /api/migrate/scan and /api/migrate/run are owner-only, refused before the body is read.
//  - Updates: /api/updates/apply with autoStash is owner-only; a plain apply is unchanged (the operator surface
//    forwards it with an empty body).
//
// Owner = mayActAsOwner: a session, or the shared token (never a sub-agent's) beside a valid owner session cookie.
//
// SANDBOX: SCHEDULED_TASKS_DIR is fixed at import from $HOME, and PROJECT_ROOT is a throwaway non-git directory, so
// nothing here touches a real install and no update can start.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRmTmp } from './helpers/safe-rm-tmp.js'

// Under a git hook GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would point the update route's git calls at a real
// repository (the same guard as updates-preflight-async.test.ts).
const savedGitEnv: Record<string, string> = {}
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k] }
}
afterAll(() => { Object.assign(process.env, savedGitEnv) })

// The registry gate is covered by schedule-source-registry.test.ts; here it is a passthrough.
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir` }
})

const tmpHome = mkdtempSync(join(tmpdir(), 'owner-exec-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'owner-exec-root-'))
H.root = tmpRoot
const realHome = process.env.HOME
process.env.HOME = tmpHome

type RouteContext = import('../web/routes/types.js').RouteContext
let io: typeof import('../web/scheduled-tasks-io.js')
let schedules: typeof import('../web/routes/schedules.js')
let migrate: typeof import('../web/routes/migrate.js')
let updates: typeof import('../web/routes/updates.js')
let db: typeof import('../db.js')
let sessions: typeof import('../web/auth-sessions.js')
let COOKIE_NAME = ''

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  db = await import('../db.js')
  db.initDatabase(':memory:')
  sessions = await import('../web/auth-sessions.js')
  COOKIE_NAME = (await import('../web/auth-gate.js')).SESSION_COOKIE_NAME
  io = await import('../web/scheduled-tasks-io.js')
  schedules = await import('../web/routes/schedules.js')
  migrate = await import('../web/routes/migrate.js')
  updates = await import('../web/routes/updates.js')
  const config = await import('../config.js')
  if (config.PROJECT_ROOT !== tmpRoot) throw new Error('refusing to run: PROJECT_ROOT is not the temporary root')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

const TOKEN: RouteContext['auth'] = { kind: 'token' }
const SUB_AGENT: RouteContext['auth'] = { kind: 'token', agent: 'helper', tokenAgent: 'helper' }
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }

function ownerCookie(): string {
  const u = db.getDashboardUser('owner') ?? db.createDashboardUser('owner', 'x-not-a-real-hash')
  return `${COOKIE_NAME}=${sessions.createSession({ userId: u.id, username: u.username })}`
}

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', ...headers }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string | Buffer) { if (d !== undefined) out.body += d.toString() },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

const TASK = 'owner-exec-task'
const CMD_TASK = 'owner-exec-cmd'
const cfgPath = (t: string) => join(io.SCHEDULED_TASKS_DIR, t, 'task-config.json')
const cfgText = (t: string) => readFileSync(cfgPath(t), 'utf-8')
const cfg = (t: string) => JSON.parse(cfgText(t)) as Record<string, unknown>
const put = (t: string, auth: RouteContext['auth'], body: unknown, headers: Record<string, string> = {}) =>
  call(schedules.tryHandleSchedules, 'PUT', `/api/schedules/${t}`, auth, JSON.stringify(body), headers)
const create = (auth: RouteContext['auth'], body: Record<string, unknown>) =>
  call(schedules.tryHandleSchedules, 'POST', '/api/schedules', auth, JSON.stringify({ description: 'd', prompt: 'p', schedule: '0 8 * * *', ...body }))

beforeEach(() => {
  db.getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  sessions._clearSessionCacheForTest()
  safeRmTmp(io.SCHEDULED_TASKS_DIR)
  mkdirSync(join(io.SCHEDULED_TASKS_DIR, TASK), { recursive: true })
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, TASK, 'SKILL.md'), `---\nname: ${TASK}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(cfgPath(TASK), JSON.stringify({ schedule: '0 * * * *', agent: 'proba-ugynok', enabled: true, preCheck: 'old.sh' }, null, 2))
  mkdirSync(join(io.SCHEDULED_TASKS_DIR, CMD_TASK), { recursive: true })
  writeFileSync(cfgPath(CMD_TASK), JSON.stringify({ schedule: '0 * * * *', agent: 'proba-ugynok', enabled: true, type: 'command', command: 'true', timeoutMs: 10000 }, null, 2))
})

describe('PUT /api/schedules/<name>: what a task executes is the owner\'s', () => {
  it('the shared token cannot turn a task into a command task; nothing is written', async () => {
    const before = cfgText(TASK)
    const r = await put(TASK, TOKEN, { type: 'command', command: 'echo hi' })
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(r.json().fields).toEqual(['type', 'command'])
    expect(cfgText(TASK)).toBe(before)
  })

  it.each([
    ['preCheck', { preCheck: 'new.sh' }],
    ['preCheck cleared', { preCheck: null }],
    ['preCheckTimeoutSeconds', { preCheckTimeoutSeconds: 120 }],
  ])('the shared token cannot change %s', async (_label, body) => {
    const before = cfgText(TASK)
    expect((await put(TASK, TOKEN, body)).status).toBe(403)
    expect(cfgText(TASK)).toBe(before)
  })

  it.each([
    ['command', { command: 'echo changed' }],
    ['timeoutMs', { timeoutMs: 600000 }],
    ['type away from command', { type: 'task' }],
  ])('on a command task the shared token cannot change %s', async (_label, body) => {
    const before = cfgText(CMD_TASK)
    expect((await put(CMD_TASK, TOKEN, body)).status).toBe(403)
    expect(cfgText(CMD_TASK)).toBe(before)
  })

  it('a sub-agent token is refused too, even beside an owner cookie', async () => {
    expect((await put(TASK, SUB_AGENT, { preCheck: 'new.sh' }, { cookie: ownerCookie() })).status).toBe(403)
  })

  it('the fleet keeps its edits: prompt, cron, enabled and description pass on the shared token', async () => {
    const r = await put(TASK, TOKEN, { prompt: 'new prompt', schedule: '30 9 * * *', enabled: false, description: 'x' })
    expect(r.status).toBe(200)
    expect(cfg(TASK).schedule).toBe('30 9 * * *')
    expect(cfg(TASK).preCheck).toBe('old.sh')
  })

  it('re-sending the stored exec values is no change: a full re-save passes on the shared token', async () => {
    expect((await put(TASK, TOKEN, { type: 'task', preCheck: 'old.sh', description: 'resave' })).status).toBe(200)
    expect((await put(CMD_TASK, TOKEN, { type: 'command', command: 'true', timeoutMs: 10000 })).status).toBe(200)
  })

  it('task <-> heartbeat is not an exec change (both run the prompt)', async () => {
    expect((await put(TASK, TOKEN, { type: 'heartbeat' })).status).toBe(200)
    expect(cfg(TASK).type).toBe('heartbeat')
  })

  it('the owner can: a session', async () => {
    expect((await put(TASK, SESSION, { type: 'command', command: 'echo hi' })).status).toBe(200)
    expect(cfg(TASK).command).toBe('echo hi')
  })

  it('the owner can: the shared token beside a valid owner session cookie', async () => {
    expect((await put(TASK, TOKEN, { preCheck: 'new.sh' }, { cookie: ownerCookie() })).status).toBe(200)
    expect(cfg(TASK).preCheck).toBe('new.sh')
  })

  it('unit: changedScheduleOwnerFields', () => {
    const f = schedules.changedScheduleOwnerFields
    const stored = io.readScheduledTask(TASK)
    expect(f({ description: 'x' }, stored)).toEqual([])
    expect(f({ preCheck: 'old.sh', type: 'task' }, stored)).toEqual([])
    expect(f({ preCheck: 'other.sh' }, stored)).toEqual(['preCheck'])
    // No readable stored task: every exec field the body names counts (fail closed), an explicit null does not.
    expect(f({ type: 'task', preCheck: null }, null)).toEqual(['type'])
  })
})

describe('PUT /api/schedules/<name>: where a prompt is typed and where output goes are the owner\'s', () => {
  it.each([
    ['targetSession', { targetSession: 'agent-other' }],
    ['telegramChatId to a chat', { telegramChatId: '123456' }],
    ['channelProvider', { channelProvider: 'slack' }],
  ])('the shared token cannot set %s; nothing is written', async (_label, body) => {
    const before = cfgText(TASK)
    const r = await put(TASK, TOKEN, body)
    expect(r.status).toBe(403)
    expect(cfgText(TASK)).toBe(before)
  })

  it('telegramChatId "none" (no chat delivery) only narrows where output goes: allowed on the token', async () => {
    expect((await put(TASK, TOKEN, { telegramChatId: 'none' })).status).toBe(200)
    expect(cfg(TASK).telegramChatId).toBe('none')
  })

  it('forceSend and skipIfBusy stay on the token (the task\'s own session; the runner guards the target)', async () => {
    expect((await put(TASK, TOKEN, { forceSend: true, skipIfBusy: true })).status).toBe(200)
  })

  it('the owner sets them', async () => {
    expect((await put(TASK, SESSION, { targetSession: 'agent-other', telegramChatId: '123456', channelProvider: 'slack' })).status).toBe(200)
    expect(cfg(TASK).targetSession).toBe('agent-other')
  })
})

describe('POST /api/schedules: a task typed into another session needs the owner', () => {
  it('the shared token with a targetSession gets 403 and no task directory', async () => {
    const r = await create(TOKEN, { name: 'new-target', targetSession: 'agent-other' })
    expect(r.status).toBe(403)
    expect(existsSync(join(io.SCHEDULED_TASKS_DIR, 'new-target'))).toBe(false)
  })

  it('forceSend on create stays on the token', async () => {
    expect((await create(TOKEN, { name: 'new-force', forceSend: true })).status).toBe(200)
  })

  it('the owner creates one', async () => {
    expect((await create(SESSION, { name: 'new-target-owner', targetSession: 'agent-other' })).status).toBe(200)
  })
})

describe('POST /api/schedules: a command task is created only by the owner', () => {
  it('the shared token gets 403 and no task directory', async () => {
    const r = await create(TOKEN, { name: 'new-cmd', type: 'command' })
    expect(r.status).toBe(403)
    expect(existsSync(join(io.SCHEDULED_TASKS_DIR, 'new-cmd'))).toBe(false)
  })

  it('a prompt task stays on the shared token (control)', async () => {
    expect((await create(TOKEN, { name: 'new-task' })).status).toBe(200)
    expect((await create(TOKEN, { name: 'new-hb', type: 'heartbeat' })).status).toBe(200)
  })

  it('the owner creates a command task', async () => {
    expect((await create(SESSION, { name: 'new-cmd-owner', type: 'command' })).status).toBe(200)
  })
})

describe('/api/migrate/scan and /run are owner-only, refused before the body is read', () => {
  // An unparseable body: a handler that read it would throw, so a clean 403 shows the refusal came first.
  it.each(['/api/migrate/scan', '/api/migrate/run'])('%s: the shared token gets 403', async (p) => {
    const r = await call(migrate.tryHandleMigrate, 'POST', p, TOKEN, '{not json')
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
  })

  it('a sub-agent token gets 403', async () => {
    expect((await call(migrate.tryHandleMigrate, 'POST', '/api/migrate/scan', SUB_AGENT, '{}')).status).toBe(403)
  })

  it('the owner passes the gate (the handler\'s own 400 for an empty path)', async () => {
    expect((await call(migrate.tryHandleMigrate, 'POST', '/api/migrate/scan', SESSION, JSON.stringify({ sourcePath: '' }))).status).toBe(400)
    const viaCookie = await call(migrate.tryHandleMigrate, 'POST', '/api/migrate/scan', TOKEN, JSON.stringify({ sourcePath: '' }), { cookie: ownerCookie() })
    expect(viaCookie.status).toBe(400)
  })
})

describe('/api/updates/apply: autoStash is the owner\'s, a plain apply is unchanged', () => {
  it('the shared token with autoStash gets 403', async () => {
    const r = await call(updates.tryHandleUpdates, 'POST', '/api/updates/apply', TOKEN, JSON.stringify({ autoStash: true }))
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
  })

  it('a plain apply on the shared token is not refused by the owner gate (control; the throwaway root fails later)', async () => {
    const r = await call(updates.tryHandleUpdates, 'POST', '/api/updates/apply', TOKEN, '')
    expect(r.json().code).not.toBe('owner_session_required')
  })

  it('the owner with autoStash passes the gate', async () => {
    const r = await call(updates.tryHandleUpdates, 'POST', '/api/updates/apply', SESSION, JSON.stringify({ autoStash: true }))
    expect(r.json().code).not.toBe('owner_session_required')
  })
})
