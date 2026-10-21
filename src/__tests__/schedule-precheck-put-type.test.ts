// PUT /api/schedules/<name> refuses a preCheck that is not a string (#2100 follow-up).
//
// The PUT body goes to writeScheduledTask whole, so {"preCheck": true} (or a
// number, an array, an object) used to be stored in task-config.json as is.
// Since #2100 the runner and the registry hash treat such a value as "no
// script", so the stored config said something nothing acts on. The route now
// answers 400 and writes nothing. A string is stored as before, and null is
// still accepted (it clears the field). POST /api/schedules takes no preCheck
// at all, so it needs no check.
//
// SANDBOX: SCHEDULED_TASKS_DIR is fixed at import from $HOME, so HOME points
// at a throwaway directory BEFORE the route module is imported.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The registry gate is covered by schedule-source-registry.test.ts; here it is a passthrough.
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

const tmpHome = mkdtempSync(join(tmpdir(), 'schedule-precheck-put-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')
let route: typeof import('../web/routes/schedules.js')

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const TASK = 'precheck-put'
const cfgPath = () => join(io.SCHEDULED_TASKS_DIR, TASK, 'task-config.json')
const cfg = () => JSON.parse(readFileSync(cfgPath(), 'utf-8')) as Record<string, unknown>

beforeEach(() => {
  rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  mkdirSync(join(io.SCHEDULED_TASKS_DIR, TASK), { recursive: true })
  writeFileSync(join(io.SCHEDULED_TASKS_DIR, TASK, 'SKILL.md'), `---\nname: ${TASK}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(cfgPath(), JSON.stringify({ schedule: '0 * * * *', agent: 'proba-ugynok', enabled: true, preCheck: 'old.sh' }, null, 2))
})

async function put(body: unknown): Promise<{ statusCode: number; body: string }> {
  const req = new EventEmitter() as never as import('../web/routes/types.js').RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as never
  const path = `/api/schedules/${TASK}`
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const ctx = { req, res, path, method: 'PUT', url: new URL(`http://localhost${path}`), fedPeer: null } as never
  expect(await route.tryHandleSchedules(ctx)).toBe(true)
  return state
}

describe('PUT /api/schedules/<name>: preCheck must be a string or null', () => {
  it.each([[true], [1], [['pre.sh']], [{ path: 'pre.sh' }]])('%j is refused with 400 and nothing is written', async (value) => {
    const before = readFileSync(cfgPath(), 'utf-8')
    const r = await put({ preCheck: value })
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).error).toMatch(/preCheck/)
    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before)
  })

  it('a string is stored as before (control)', async () => {
    expect((await put({ preCheck: 'pre.sh' })).statusCode).toBe(200)
    expect(cfg().preCheck).toBe('pre.sh')
  })

  it('null is still accepted, and an absent preCheck leaves the stored one alone', async () => {
    expect((await put({ description: 'x' })).statusCode).toBe(200)
    expect(cfg().preCheck).toBe('old.sh')
    expect((await put({ preCheck: null })).statusCode).toBe(200)
    expect(cfg().preCheck).toBeNull()
  })
})
