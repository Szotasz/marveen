import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// MSGWARN908: POST /api/messages warned "'<to>' nem fut -- ... elveszik" for
// the MAIN agent on every send, because isAgentRunning() probes the
// `agent-<name>` session and the main agent lives in `${MAIN_AGENT_ID}-channels`.
// The claim was false twice over: the router never abandons a main-agent
// message (pull model), so nothing is ever lost. On 2026-09-08 the false
// "not running" state was relayed to the owner as a system-down report; the
// reaction it invites -- starting a second main instance -- is exactly what
// the pull model must never see. These tests run the real route handler: in a
// test environment no tmux session exists at all, so isAgentRunning() is
// false for EVERY name -- which is precisely the condition that used to
// trigger the false warning for the main agent.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  const handled = await tryHandleMessages(ctx)
  expect(handled).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/messages to the main agent (MSGWARN908)', () => {
  it('never carries the "not running -- will be lost" warning', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'status probe' })
    expect(r.statusCode).toBe(200)
    expect(r.json.warning).toBeUndefined()
    expect(r.json.targetRunning).toBeUndefined()
    expect(r.json.to_agent).toBe(MAIN_AGENT_ID)
  })

  it('still warns for a genuinely stopped sub-agent (the gate is not loosened)', async () => {
    // No tmux in the test env, so any sub-agent id reads as stopped -- the
    // exemption must be main-only, not a blanket removal of the warning.
    const r = await post({ from: MAIN_AGENT_ID, to: 'no-such-agent-session', content: 'ping' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect(String(r.json.warning)).toContain('nem fut')
  })
})
