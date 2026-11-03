// POST /api/agents/:name/start and /restart take an OPTIONAL body
// ({ "fresh": true }, { "wake": false }); a missing or unparsable body means
// "no options". A body that was cut off mid-way is a different thing: readBody()
// rejects, and the route must answer 400 instead of running the start/restart
// with the defaults (a start that asked for { "fresh": true } would otherwise
// run with --continue).
//
// The process layer is mocked, so no tmux session is ever launched.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { removeDesiredAgent } from '../web/agent-desired-state.js'
import type { RouteContext } from '../web/routes/types.js'

const start = vi.fn(async (..._a: unknown[]) => ({ ok: true }))
const restart = vi.fn(async (..._a: unknown[]) => ({ ok: true }))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentRunState: () => 'running',
    isAgentRunning: () => true,
    startAgentProcess: (...a: unknown[]) => start(...a),
    restartAgentProcess: (...a: unknown[]) => restart(...a),
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

const THROWAWAY = 'zz-incomplete-body-probe'

// A request whose body stops part-way: some bytes, then the request is
// destroyed without an 'end' (what a client disconnect leaves behind).
function cutOffRequest(partial: string): RouteContext['req'] {
  const req = Object.assign(new Readable({ read() {} }), { headers: { 'content-type': 'application/json' } })
  req.push(Buffer.from(partial))
  setImmediate(() => req.destroy())
  return req as unknown as RouteContext['req']
}

function fullRequest(body: string): RouteContext['req'] {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' } }) as unknown as RouteContext['req']
}

async function post(path: string, req: RouteContext['req']) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const handled = await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext, join(PROJECT_ROOT, 'web'))
  return { handled, out }
}

beforeEach(() => {
  mkdirSync(agentDir(THROWAWAY), { recursive: true })
  mkdirSync(STORE_DIR, { recursive: true })
  removeDesiredAgent(THROWAWAY)
  start.mockClear()
  restart.mockClear()
})

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
  removeDesiredAgent(THROWAWAY)
})

describe('POST /api/agents/:name/start with a body that did not arrive in full', () => {
  it('answers 400 incomplete-body and starts nothing', async () => {
    const { handled, out } = await post(`/api/agents/${THROWAWAY}/start`, cutOffRequest('{"fresh":tr'))
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body?.code).toBe('incomplete-body')
    expect(start).not.toHaveBeenCalled()
  })

  it('a complete { "fresh": true } body still starts fresh (control)', async () => {
    const { out } = await post(`/api/agents/${THROWAWAY}/start`, fullRequest('{"fresh":true}'))
    expect(out.status).toBe(200)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0][1]).toEqual({ fresh: true })
  })
})

describe('POST /api/agents/:name/restart with a body that did not arrive in full', () => {
  it('answers 400 incomplete-body and restarts nothing', async () => {
    const { handled, out } = await post(`/api/agents/${THROWAWAY}/restart`, cutOffRequest('{"fresh":tr'))
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body?.code).toBe('incomplete-body')
    expect(restart).not.toHaveBeenCalled()
  })

  it('an empty complete body still restarts with the defaults (control)', async () => {
    const { out } = await post(`/api/agents/${THROWAWAY}/restart`, fullRequest(''))
    expect(out.status).toBe(200)
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
