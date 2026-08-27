import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  createBackgroundTaskAtomic: vi.fn(),
  getBackgroundTasks: vi.fn().mockReturnValue([]),
  getBackgroundTask: vi.fn().mockReturnValue(null),
  finishBackgroundTask: vi.fn(),
  markMessageFailed: vi.fn(),
  claimPendingForAgent: vi.fn().mockReturnValue([]),
  getDb: vi.fn(),
  execFileSync: vi.fn(),
  resolveFromPath: vi.fn().mockReturnValue('/usr/bin/tmux'),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../platform.js', () => ({ resolveFromPath: mocks.resolveFromPath }))
vi.mock('../../logger.js', () => ({ logger: mocks.logger }))
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFileSync: mocks.execFileSync }
})
vi.mock('../db.js', () => ({
  createBackgroundTaskAtomic: mocks.createBackgroundTaskAtomic,
  getBackgroundTasks: mocks.getBackgroundTasks,
  getBackgroundTask: mocks.getBackgroundTask,
  finishBackgroundTask: mocks.finishBackgroundTask,
  markMessageFailed: mocks.markMessageFailed,
  claimPendingForAgent: mocks.claimPendingForAgent,
  getDb: mocks.getDb,
}))

import { tryHandleBackgroundTasks } from '../web/routes/background-tasks.js'

function makeCtx(opts: { method: string; path: string; body?: object | string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('background-tasks routes -- status dispatch (B11b)', () => {
  it('returns 429 when concurrent limit hit (limit_exceeded)', async () => {
    // createBackgroundTaskAtomic returns null -> spawnBackgroundTask returns limit_exceeded
    mocks.createBackgroundTaskAtomic.mockReturnValueOnce(null)
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: 'agent-a', prompt: 'do something' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(429)
    expect((body() as any).error).toBe('limit_exceeded')
  })

  it('returns 500 when tmux spawn fails (internal_error)', async () => {
    // createBackgroundTaskAtomic returns a task, execFileSync throws -> internal_error
    mocks.createBackgroundTaskAtomic.mockReturnValueOnce({
      id: 'ABCD1234', agent_id: 'agent-a', prompt: 'do something',
      status: 'running', tmux_session: 'bg-ABCD1234',
      started_at: Math.floor(Date.now() / 1000), finished_at: null, output: null,
    })
    mocks.execFileSync.mockImplementationOnce(() => { throw new Error('tmux not found') })
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/background-tasks',
      body: { agent_id: 'agent-a', prompt: 'do something' },
    })
    await tryHandleBackgroundTasks(ctx)
    expect(status()).toBe(500)
    expect((body() as any).error).toBe('internal_error')
  })
})
