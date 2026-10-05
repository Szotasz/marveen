// RESTARTSTOPPED1005: POST /api/agents/:name/restart must not resurrect an
// agent that was stopped on purpose (not running AND not in the desired
// run-state). Measured 2026-10-05: a fleet-wide token-swap script restarted
// every listed agent, and restartAgentProcess() started a deliberately paused
// one -- the explicit /stop that had taken it off the desired set counted for
// nothing.
//
// Every branch of the guard is pinned here, with the run state and the restart
// mocked so no tmux session is ever launched:
//   running, not desired  -> restarts (the guard must not block a live agent)
//   stopped, desired      -> starts (it should be up; the reconciler would too)
//   stopped, not desired  -> 409 stopped-not-desired, nothing started
//   remote, unreachable   -> 503 host-unreachable, nothing attempted
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { addDesiredAgent, getDesiredAgents, removeDesiredAgent } from '../web/agent-desired-state.js'
import type { RouteContext } from '../web/routes/types.js'

const runState = vi.fn<() => 'running' | 'stopped' | 'unreachable'>(() => 'stopped')
const restart = vi.fn(async () => ({ ok: true }))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentRunState: () => runState(),
    isAgentRunning: () => runState() === 'running',
    restartAgentProcess: (...a: unknown[]) => restart(...(a as [])),
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

const THROWAWAY = 'zz-restart-stopped-probe'

function fakeCtx(path: string, method: string): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req: {} as RouteContext['req'], res, path: url.pathname, method, url } as RouteContext,
    out,
  }
}

async function post() {
  const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}/restart`, 'POST')
  const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
  return { handled, out }
}

beforeEach(() => {
  mkdirSync(agentDir(THROWAWAY), { recursive: true })
  mkdirSync(STORE_DIR, { recursive: true })
  removeDesiredAgent(THROWAWAY)
  runState.mockReset()
  restart.mockReset()
  restart.mockResolvedValue({ ok: true })
})

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
  removeDesiredAgent(THROWAWAY)
})

describe('POST /api/agents/:name/restart and the desired run-state', () => {
  it('restarts a RUNNING agent even when it is not desired (the guard must not block a live agent)', async () => {
    runState.mockReturnValue('running')
    expect(getDesiredAgents().has(THROWAWAY)).toBe(false)
    const { handled, out } = await post()
    expect(handled).toBe(true)
    expect(out.status).not.toBe(409)
    expect(out.body?.ok).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('starts a STOPPED agent that is still desired', async () => {
    runState.mockReturnValue('stopped')
    addDesiredAgent(THROWAWAY)
    const { out } = await post()
    expect(out.status).not.toBe(409)
    expect(out.body?.ok).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('refuses with 409 and starts nothing when the agent is stopped and not desired', async () => {
    runState.mockReturnValue('stopped')
    const { handled, out } = await post()
    expect(handled).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body?.code).toBe('stopped-not-desired')
    expect(restart).not.toHaveBeenCalled()
    // The refusal decides nothing about intent: it must not add the name.
    expect(getDesiredAgents().has(THROWAWAY)).toBe(false)
  })

  it('answers 503 host-unreachable (not "stopped on purpose") for a remote agent whose host does not answer', async () => {
    runState.mockReturnValue('unreachable')
    const { out } = await post()
    expect(out.status).toBe(503)
    expect(out.body?.code).toBe('host-unreachable')
    expect(restart).not.toHaveBeenCalled()
  })

  it('still answers 404 for an agent that does not exist', async () => {
    rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
    const { out } = await post()
    expect(out.status).toBe(404)
    expect(restart).not.toHaveBeenCalled()
  })
})
