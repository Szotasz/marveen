// Error-shape tests for updates route 409 conflict responses (#672 B15).
// Covers: concurrency (already-running) and preflight (dirty-tree, detached-head) 409 branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
}))

vi.mock('../web/update-checker.js', () => ({
  getUpdateStatus: vi.fn().mockReturnValue({}),
  refreshUpdateStatus: vi.fn().mockResolvedValue({}),
}))

vi.mock('../web/update-agent-capability.js', () => ({
  claudeAgentRunnable: vi.fn().mockReturnValue(false),
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: false, error: 'not_found' }),
}))

import { checkNoConcurrentUpdate, checkUpdatePreflight } from '../update-preflight.js'

vi.mock('../update-preflight.js', () => ({
  checkUpdatePreflight: vi.fn(),
  checkNoConcurrentUpdate: vi.fn(),
  classifyLockWriteError: vi.fn().mockReturnValue('other'),
}))

let mockWriteBehavior: 'succeed' | 'eexist' = 'succeed'

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn((_p: unknown, _c: unknown, opts?: Record<string, unknown>) => {
    if (opts?.flag === 'wx' && mockWriteBehavior === 'eexist') {
      const err = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      throw err
    }
  }),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ isFile: () => false, size: 0 }),
  readFileSync: vi.fn().mockReturnValue(''),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({ on: vi.fn(), unref: vi.fn() }),
  execFileSync: vi.fn().mockReturnValue('main\n'),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  path: string,
  bodyOrRaw?: object | string | null,
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf =
    bodyOrRaw == null
      ? Buffer.alloc(0)
      : typeof bodyOrRaw === 'string'
        ? Buffer.from(bodyOrRaw)
        : Buffer.from(JSON.stringify(bodyOrRaw))
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = method
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', buf)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      const str = b ? (Buffer.isBuffer(b) ? b.toString('utf-8') : b) : ''
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

// ── Import subject under test AFTER mocks ─────────────────────────────────────

import { tryHandleUpdates } from '../web/routes/updates.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteBehavior = 'succeed'
})

describe('updates /apply -- concurrency 409 (already-running)', () => {
  it('returns conflict token when update is already running', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('exposes reason and pid as separate machine-readable fields', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.reason).toBe('already-running')
    expect(out.body.pid).toBe(9999)
  })

  it('moves prose into hint, not error', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 9999,
      message: 'Update already running (pid 9999). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.hint).toMatch(/already running/)
    expect(out.body.error).not.toMatch(/running|pid|wait/i)
  })

  it('mutation-detection: error is conflict, not already_running or already-running', async () => {
    mockWriteBehavior = 'eexist'
    vi.mocked(checkNoConcurrentUpdate).mockReturnValue({
      ok: false,
      reason: 'already-running',
      pid: 1,
      message: 'Update already running (pid 1). Wait for it to finish, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.error).toBe('conflict')
    expect(out.body.error).not.toBe('already-running')
    expect(out.body.error).not.toBe('already_running')
  })
})

describe('updates /apply -- preflight 409 (dirty-tree)', () => {
  it('returns conflict token for dirty-tree preflight failure', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('preserves reason for machine-readable distinction', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.reason).toBe('dirty-tree')
  })

  it('moves preflight prose into hint', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes. Commit or stash them, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.hint).toMatch(/uncommitted|stash/i)
    expect(out.body.error).not.toMatch(/uncommitted|stash|changes/i)
  })

  it('mutation-detection: error is conflict, not the prose message or dirty-tree', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'dirty-tree',
      message: 'Working tree has uncommitted changes.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.body.error).toBe('conflict')
    expect(out.body.error).not.toBe('dirty-tree')
    expect(out.body.error).not.toMatch(/uncommitted|changes|working/i)
  })
})

describe('updates /apply -- preflight 409 (detached-head)', () => {
  it('returns conflict token for detached-head preflight failure', async () => {
    vi.mocked(checkUpdatePreflight).mockReturnValue({
      ok: false,
      reason: 'detached-head',
      message: 'The repository is in detached HEAD state. Checkout a branch, then retry.',
    })
    const { ctx, out } = makeCtx('POST', '/api/updates/apply')
    await tryHandleUpdates(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.reason).toBe('detached-head')
    expect(out.body.hint).toMatch(/detached/i)
    expect(out.body.error).not.toMatch(/detached|head|branch/i)
  })
})
