// RESTARTSTOPPED1005: POST /api/agents/:name/restart must not resurrect an
// agent that was stopped on purpose (not running AND not in the desired
// run-state). Measured 2026-10-05: a fleet-wide token-swap script restarted
// every listed agent, and restartAgentProcess() started a deliberately paused
// one -- the explicit /stop that had taken it off the desired set counted for
// nothing. Only the refusal branch is exercised here: the started branches
// would launch a real tmux session, which a unit test must not do.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { getDesiredAgents, removeDesiredAgent } from '../web/agent-desired-state.js'
import { isAgentRunning } from '../web/agent-process.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

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

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
  removeDesiredAgent(THROWAWAY)
})

describe('POST /api/agents/:name/restart and a deliberately stopped agent', () => {
  it('refuses with 409 and starts nothing when the agent is stopped and not desired', async () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    mkdirSync(STORE_DIR, { recursive: true })
    removeDesiredAgent(THROWAWAY)
    // Positive control on the preconditions: if the probe were running or
    // desired, the refusal below would not be what is being tested.
    expect(isAgentRunning(THROWAWAY)).toBe(false)
    expect(getDesiredAgents().has(THROWAWAY)).toBe(false)

    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}/restart`, 'POST')
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body?.code).toBe('stopped-not-desired')
    expect(isAgentRunning(THROWAWAY)).toBe(false)
    // The refusal decides nothing about intent: it must not add the name.
    expect(getDesiredAgents().has(THROWAWAY)).toBe(false)
  })

  it('still answers 404 for an agent that does not exist', async () => {
    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}/restart`, 'POST')
    await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    expect(out.status).toBe(404)
  })
})
