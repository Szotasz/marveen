// Tests for HTTP error response shapes in the schedules route after
// snake_case normalisation (#672 B3a). Each test confirms that the error
// token, field and status code are correct; happy-path behaviour is not
// duplicated here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  currentBotName: () => 'Agent A',
  PROJECT_ROOT: '/tmp/mock-root',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn().mockReturnValue('{}'),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/mock-tasks',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 10_000,
  listScheduledTasks: vi.fn().mockReturnValue([]),
  writeScheduledTask: vi.fn(),
}))

vi.mock('../web/sanitize.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/sanitize.js')>()
  return { ...orig }
})

vi.mock('../web/cron.js', () => ({
  isValidCronShape: vi.fn().mockReturnValue(false),
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true, result: 'done' }),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  listPendingTaskRetries: vi.fn().mockReturnValue([]),
  deletePendingTaskRetryById: vi.fn().mockReturnValue(false),
  listTaskRunHistory: vi.fn().mockReturnValue([]),
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn().mockRejectedValue(new Error('mocked')),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  path: string,
  body?: object,
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => {
    req.emit('data', buf)
    req.emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

// ── POST /api/schedules input validation ──────────────────────────────────────

import { tryHandleSchedules } from '../web/routes/schedules.js'
import { existsSync } from 'node:fs'
import { deletePendingTaskRetryById } from '../db.js'
import { isValidCronShape } from '../web/cron.js'

const mockExistsSync = vi.mocked(existsSync)
const mockDeletePending = vi.mocked(deletePendingTaskRetryById)
const mockIsValidCron = vi.mocked(isValidCronShape)

beforeEach(() => {
  vi.clearAllMocks()
  mockIsValidCron.mockReturnValue(false)
})

describe('POST /api/schedules -- input validation error shapes', () => {
  it('returns required+name when name is empty', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: '',
      prompt: 'do something',
      schedule: '* * * * *',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('name')
  })

  it('returns required+prompt when prompt is empty', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: 'my-task',
      prompt: '',
      schedule: '* * * * *',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('prompt')
  })

  it('returns limit_exceeded+prompt when prompt is too large', async () => {
    const { MAX_SCHEDULED_TASK_PROMPT_LEN } = await import('../web/scheduled-tasks-io.js')
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: 'my-task',
      prompt: 'x'.repeat(MAX_SCHEDULED_TASK_PROMPT_LEN + 1),
      schedule: '* * * * *',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(413)
    expect(out.body.error).toBe('limit_exceeded')
    expect(out.body.field).toBe('prompt')
  })

  it('returns required+schedule when schedule is empty', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: 'my-task',
      prompt: 'do something',
      schedule: '',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('schedule')
  })

  it('returns invalid_value+schedule for bad cron', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: 'my-task',
      prompt: 'do something',
      schedule: 'not-a-cron',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('schedule')
  })

  it('returns conflict when schedule directory already exists', async () => {
    mockIsValidCron.mockReturnValue(true)
    mockExistsSync.mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/schedules', {
      name: 'existing-task',
      prompt: 'do something',
      schedule: '* * * * *',
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })
})

describe('PUT/DELETE /api/schedules/:name -- not_found error shape', () => {
  it('DELETE returns not_found when schedule does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/missing-task')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('PUT returns not_found when schedule does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/schedules/missing-task', {})
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('POST /toggle returns not_found when schedule does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/schedules/missing-task/toggle')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('GET /runs returns not_found when schedule does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const { ctx, out } = makeCtx('GET', '/api/schedules/missing-task/runs')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})

describe('POST /api/schedules/:name/run -- disabled schedule returns 409', () => {
  it('returns disabled + 409 when runScheduledTaskNow reports disabled', async () => {
    mockExistsSync.mockReturnValue(true)
    const { runScheduledTaskNow } = await import('../web/schedule-runner.js')
    vi.mocked(runScheduledTaskNow).mockResolvedValueOnce({ ok: false, error: 'disabled', hint: 'Schedule is disabled' })
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/run')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('disabled')
    expect(out.body.hint).toMatch(/disabled/i)
  })

  it('returns not_found + 404 when runScheduledTaskNow reports not_found', async () => {
    mockExistsSync.mockReturnValue(true)
    const { runScheduledTaskNow } = await import('../web/schedule-runner.js')
    vi.mocked(runScheduledTaskNow).mockResolvedValueOnce({ ok: false, error: 'not_found', hint: 'Schedule not found' })
    const { ctx, out } = makeCtx('POST', '/api/schedules/missing-task/run')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})

describe('DELETE /api/schedules/pending/:id -- error shapes', () => {
  it('returns invalid_value for non-numeric id', async () => {
    // The regex requires digits so non-numeric path won't match at all;
    // confirm the pending cancel path is not reached (handled=false).
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/pending/abc')
    const handled = await tryHandleSchedules(ctx)
    expect(handled).toBe(false)
  })

  it('returns not_found when pending retry does not exist', async () => {
    mockDeletePending.mockReturnValue(false)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/pending/999')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})
