import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/agent-process.js', () => ({
  startAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  stopAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  restartAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  getAgentProcessInfo: vi.fn().mockReturnValue({ running: false, pid: null }),
}))
vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false }),
  writeAutoRestartConfig: vi.fn().mockReturnValue({ enabled: true, maxRestarts: 3 }),
}))
vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: vi.fn().mockReturnValue({ enabled: false, limitPct: 80 }),
  writeContextGuardConfig: vi.fn().mockReturnValue({ enabled: true, limitPct: 85 }),
}))
vi.mock('../web/context-guard-runner.js', () => ({
  getContextGuardStatus: vi.fn().mockReturnValue([{ name: 'marveen', phase: 'idle', contextPct: 10 }]),
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
vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped'), invalidate: vi.fn() },
    remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null), invalidate: vi.fn() },
    agentRunStateCached: vi.fn().mockReturnValue('stopped'),
  }
})
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: vi.fn().mockReturnValue({ category: 'peer', safeFrom: 'rick' }),
  wrapAgentMessageForDelivery: vi.fn().mockReturnValue('[Wrapped message]'),
}))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockReturnValue('/tmp'),
    writeAgentRemoteConfig: vi.fn().mockReturnValue({ ok: true, remote: { host: 'myhost', workdir: '/work' } }),
  }
})

import { tryHandleAgentsProcess } from '../web/routes/agents-process.js'
import { addDesiredAgent } from '../web/agent-desired-state.js'
import { startAgentProcess } from '../web/agent-process.js'

function makeCtx(opts: { method: string; path: string; body?: string; headers?: Record<string, string> }): {
  ctx: RouteContext; statusCode: () => number; responseBody: () => unknown
} {
  const { method, path, body = '', headers = {} } = opts
  const em = new EventEmitter()
  Object.assign(em, { headers: { ...headers }, method, url: path })
  setImmediate(() => {
    if (body) em.emit('data', Buffer.from(body))
    em.emit('end')
  })
  let code = 200
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
  return { ctx, statusCode: () => code, responseBody: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

describe('agents-process routes -- extended coverage', () => {
  describe('PUT /api/agents/:name/auto-restart', () => {
    it('returns 200 for main agent with valid body', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/marveen/auto-restart',
        body: JSON.stringify({ enabled: true, mode: 'continue' }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('returns 200 for sub-agent with valid body', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/auto-restart',
        body: JSON.stringify({ enabled: true }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('returns 400 for invalid JSON body', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'PUT',
        path: '/api/agents/marveen/auto-restart',
        body: 'not-json',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
    })
  })

  describe('GET/PUT /api/agents/:name/context-guard', () => {
    it('GET returns 200 for sub-agent', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'GET',
        path: '/api/agents/rick/context-guard',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('PUT returns 200 for main agent with valid body', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/marveen/context-guard',
        body: JSON.stringify({ enabled: true, actPct: 0.85 }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('PUT returns 200 for sub-agent with valid body', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/context-guard',
        body: JSON.stringify({ enabled: false }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
    })

    it('PUT returns 400 for invalid JSON', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'PUT',
        path: '/api/agents/marveen/context-guard',
        body: '{bad',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
    })
  })

  describe('GET /api/context-guard', () => {
    it('returns 200 with agents array', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'GET',
        path: '/api/context-guard',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
      expect(Array.isArray((responseBody() as any).agents)).toBe(true)
    })
  })

  describe('PUT /api/agents/:name/remote', () => {
    it('returns 400 when setting remote on main agent', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'PUT',
        path: '/api/agents/marveen/remote',
        body: JSON.stringify({ host: 'remote.host', workdir: '/work' }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
    })

    it('returns 200 for sub-agent with host and workdir', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/remote',
        body: JSON.stringify({ host: 'myhost', workdir: '/work' }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
      expect((responseBody() as any).remoteHost).toBe('myhost')
    })

    it('returns 400 for invalid JSON', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/remote',
        body: 'not-json',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
    })
  })

  describe('POST /api/agents/:name/start', () => {
    it('returns 200 for sub-agent (happy path)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/start',
        body: '{}',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('returns 200 for sub-agent with fresh:true flag', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/start',
        body: JSON.stringify({ fresh: true }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
    })
  })

  describe('POST /api/agents/:name/stop', () => {
    it('returns 200 for sub-agent', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/stop',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })
  })

  describe('POST /api/agents/:name/drain-inbox', () => {
    it('returns 400 for non-main agent', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/drain-inbox',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
      expect((responseBody() as any).error).toBe('not_supported')
      expect((responseBody() as any).hint).toContain('main-agent only')
    })

    it('returns 200 for main agent with empty inbox', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/marveen/drain-inbox',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).count).toBe(0)
    })
  })

  describe('POST /api/agents/:name/restart', () => {
    it('restarts main channels agent via hardRestart', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/marveen/restart',
        body: '{}',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('restarts sub-agent (happy path)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/restart',
        body: '{}',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
      expect((responseBody() as any).ok).toBe(true)
    })

    it('restarts sub-agent with fresh:true flag', async () => {
      const { ctx, statusCode } = makeCtx({
        method: 'POST',
        path: '/api/agents/rick/restart',
        body: JSON.stringify({ fresh: true }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
    })
  })

  describe('GET /api/agents/:name/status', () => {
    it('returns 200 for sub-agent with process info', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'GET',
        path: '/api/agents/rick/status',
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(200)
    })
  })

  describe('unrelated paths', () => {
    it('returns false for unknown route', async () => {
      const { ctx } = makeCtx({ method: 'GET', path: '/api/totally/unknown' })
      expect(await tryHandleAgentsProcess(ctx)).toBe(false)
    })
  })

  // Guard: the start handler must call addDesiredAgent on the conflict path so the
  // monitor resurrects the agent on reboot/tmux-restart even when it was already
  // running at request time. Without this the operator's intent is silently lost.
  describe('POST /api/agents/:name/start -- addDesiredAgent desired-state guard', () => {
    beforeEach(() => {
      vi.mocked(addDesiredAgent).mockClear()
      // Reset to the happy-path default between tests in this block.
      vi.mocked(startAgentProcess).mockReturnValue({ ok: true })
    })

    it('calls addDesiredAgent when startAgentProcess returns conflict', async () => {
      vi.mocked(startAgentProcess).mockReturnValueOnce({
        ok: false,
        error: 'conflict',
        hint: 'Agent is already running',
      })
      const { ctx } = makeCtx({ method: 'POST', path: '/api/agents/agent-b/start', body: '{}' })
      await tryHandleAgentsProcess(ctx)
      expect(vi.mocked(addDesiredAgent)).toHaveBeenCalledWith('agent-b')
    })

    it('does NOT call addDesiredAgent when startAgentProcess returns a non-conflict error', async () => {
      vi.mocked(startAgentProcess).mockReturnValueOnce({ ok: false, error: 'not_found' })
      const { ctx } = makeCtx({ method: 'POST', path: '/api/agents/agent-b/start', body: '{}' })
      await tryHandleAgentsProcess(ctx)
      expect(vi.mocked(addDesiredAgent)).not.toHaveBeenCalled()
    })
  })

  // Regression guard: PUT auto-restart and context-guard error codes must be
  // stable machine tokens. Before this fix the routes passed cgFields.message /
  // arFields.message (prose) as `error`, plus bespoke `rejected`+`known` arrays.
  // Strict equality so reverting the fix fails immediately.
  describe('error codes are snake_case machine tokens', () => {
    it('auto-restart unknown field → unsupported_field (not a prose sentence)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/auto-restart',
        body: JSON.stringify({ enabled: true, noSuchField: 42 }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
      const body = responseBody() as any
      expect(body.error).toBe('unsupported_field')
      expect(body.field).toBe('noSuchField')
      expect(typeof body.hint).toBe('string')
      // Old-shape fields must not appear.
      expect(body.rejected).toBeUndefined()
      expect(body.known).toBeUndefined()
    })

    it('context-guard unknown field → unsupported_field (not a prose sentence)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/rick/context-guard',
        body: JSON.stringify({ enabled: true, actPct: 0.8, noSuchField: 99 }),
      })
      expect(await tryHandleAgentsProcess(ctx)).toBe(true)
      expect(statusCode()).toBe(400)
      const body = responseBody() as any
      expect(body.error).toBe('unsupported_field')
      expect(body.field).toBe('noSuchField')
      expect(typeof body.hint).toBe('string')
      expect(body.rejected).toBeUndefined()
      expect(body.known).toBeUndefined()
    })
  })
})
