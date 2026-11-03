import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { agentDir, readAgentPullDelivery } from '../web/agent-config.js'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// POST /api/messages answers a send to a stopped LOCAL agent with a "not running, the message waits in the queue"
// warning. A PULL-delivery agent (#1448) is exempt: it runs on its own machine and claims its rows over the API, so
// isAgentRunning() (a local tmux probe) reads it as stopped forever, the router never abandons its rows, and the
// suggested fix (start it here) is not even possible. The router side of #1448 has its own test
// (router-pull-delivery.test.ts); the route-side exemption, `!readAgentPullDelivery(...)` in routes/messages.ts, had
// none, so a merge or a refactor could drop it silently (a20f5430, second read of the routes/messages.ts merge).
// These tests run the real route handler with real agent-config.json files, as messages-main-agent-no-false-warning
// does: no tmux session exists in a test run, so every sub-agent reads as stopped.

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

// Three registered, stopped stand-ins that differ ONLY in their pullDelivery flag.
const PULL = 'pull-test-agent-msgwarn'
const PUSH = 'push-twin-agent-msgwarn'
const PULL_STRING = 'pull-string-agent-msgwarn'
function standIn(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true })
  writeFileSync(join(agentDir(name), 'agent-config.json'), JSON.stringify(config))
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  standIn(PULL, { pullDelivery: true })
  standIn(PUSH, {})
  standIn(PULL_STRING, { pullDelivery: 'true' })
})
afterAll(() => {
  for (const name of [PULL, PUSH, PULL_STRING]) rmSync(agentDir(name), { recursive: true, force: true })
})

describe('POST /api/messages to a PULL-delivery agent (#1448)', () => {
  it('the fixtures are what they claim: only the literal true is a pull agent', () => {
    expect(readAgentPullDelivery(PULL)).toBe(true)
    expect(readAgentPullDelivery(PUSH)).toBe(false)
    expect(readAgentPullDelivery(PULL_STRING)).toBe(false)
  })

  it('carries no "not running" warning and no queue fields: the row simply waits for the agent to claim it', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: PULL, content: 'handoff' })
    expect(r.statusCode).toBe(200)
    expect(r.json.to_agent).toBe(PULL)
    expect(r.json.status).toBe('pending')
    expect(r.json.warning).toBeUndefined()
    expect(r.json.targetRunning).toBeUndefined()
    expect(r.json.queued).toBeUndefined()
    expect(r.json.abandonAt).toBeUndefined()
  })

  it('CONTROL: the same stopped agent without pullDelivery still gets the queued warning (the exemption is pull-only)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: PUSH, content: 'handoff' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect(r.json.queued).toBe(true)
    expect(String(r.json.warning)).toContain('SORBAN VÁR')
  })

  it('CONTROL: pullDelivery "true" as a string is not a pull agent, so the warning stays', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: PULL_STRING, content: 'handoff' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect(String(r.json.warning)).toContain('SORBAN VÁR')
  })
})
