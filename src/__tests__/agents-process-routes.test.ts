import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Mock the heavy/side-effectful modules that agents-process.ts imports.
// The tests only exercise the routing guard logic; the underlying
// process-management functions are never reached.

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/agent-process.js', () => ({
  startAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  stopAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  restartAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  getAgentProcessInfo: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false }),
  writeAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false }),
}))
vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: vi.fn().mockReturnValue({ enabled: false }),
  writeContextGuardConfig: vi.fn().mockReturnValue({ enabled: false }),
}))
vi.mock('../web/context-guard-runner.js', () => ({
  getContextGuardStatus: vi.fn().mockReturnValue({ phase: 'idle', contextPct: 0 }),
}))
vi.mock('../store-watcher.js', () => ({
  setStoreWriteActor: vi.fn(),
  clearStoreWriteActor: vi.fn(),
  startStoreWatcher: vi.fn(),
  stopStoreWatcher: vi.fn(),
}))
vi.mock('../web/agent-desired-state.js', () => ({
  addDesiredAgent: vi.fn(),
  removeDesiredAgent: vi.fn(),
  getDesiredAgents: vi.fn().mockReturnValue(new Set()),
}))
vi.mock('../db.js', () => ({
  claimPendingForAgent: vi.fn().mockReturnValue([]),
  markMessageFailed: vi.fn(),
  getDb: vi.fn(),
}))
vi.mock('../web/routes/agents-helpers.js', () => ({
  remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped') },
  remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null) },
  agentRunStateCached: vi.fn().mockReturnValue('stopped'),
}))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: vi.fn(),
  wrapAgentMessageForDelivery: vi.fn().mockReturnValue(''),
}))

import { tryHandleAgentsProcess } from '../web/routes/agents-process.js'

// Build a minimal RouteContext for the tests.
function makeCtx(opts: {
  method: string
  path: string
  body?: string
}): { ctx: RouteContext; statusCode: () => number; responseBody: () => string } {
  const { method, path, body = '' } = opts

  const em = new EventEmitter()
  Object.assign(em, { headers: {}, method, url: path })
  // Emit body asynchronously so readBody()'s stream reads work.
  setImmediate(() => {
    if (body) em.emit('data', Buffer.from(body))
    em.emit('end')
  })

  let code = 0
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }

  const ctx: RouteContext = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
  }
  return { ctx, statusCode: () => code, responseBody: () => resBody }
}

describe('agents-process routes -- main-agent lifecycle guard', () => {
  it('POST /api/agents/marveen/start returns 400 (service-managed)', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'POST', path: '/api/agents/marveen/start' })
    const handled = await tryHandleAgentsProcess(ctx)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(400)
    expect(JSON.parse(responseBody())).toMatchObject({ error: 'not_supported', hint: expect.stringContaining('service-managed') })
  })

  it('POST /api/agents/marveen/stop returns 400 (service-managed)', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'POST', path: '/api/agents/marveen/stop' })
    const handled = await tryHandleAgentsProcess(ctx)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(400)
    expect(JSON.parse(responseBody())).toMatchObject({ error: 'not_supported', hint: expect.stringContaining('service-managed') })
  })

  it('GET /api/agents/marveen/context-guard returns 200', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/marveen/context-guard' })
    const handled = await tryHandleAgentsProcess(ctx)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(200)
  })

  it('unrelated path returns false (not handled)', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/completely/unrelated' })
    const handled = await tryHandleAgentsProcess(ctx)
    expect(handled).toBe(false)
  })
})
