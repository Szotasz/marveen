import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { agentDir } from '../web/agent-config.js'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// The queue state is only worth anything if it reaches the sender, and
// POST /api/messages has THREE success responses: the plain one, the
// "recipient is stopped" warning and the homoglyph warning. getRecipientQueueState
// is unit-tested on its own (recipient-queue-state.test.ts); these tests run the
// real route handler so a branch that forgets to carry `queue` fails here.

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

type Queue = { queueDepth: number; oldestPendingSec: number; estimatedDelaySec: number | null }

const CYR_E = 'е'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/messages returns the recipient queue on every success path', () => {
  it('plain success: the queue grows with each message to the same recipient', async () => {
    const first = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'first' })
    const second = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'second' })
    expect(first.statusCode).toBe(200)
    expect(first.json.warning).toBeUndefined()
    expect(first.json.homoglyph_warning).toBeUndefined()
    const q1 = first.json.queue as Queue
    const q2 = second.json.queue as Queue
    expect(q2.queueDepth).toBe(q1.queueDepth + 1)
    // No delivery history yet: unknown, not "instant".
    expect(q2.estimatedDelaySec).toBeNull()
  })

  const STOPPED = 'stopped-test-agent-queuefield'
  beforeAll(() => { mkdirSync(agentDir(STOPPED), { recursive: true }) })
  afterAll(() => { rmSync(agentDir(STOPPED), { recursive: true, force: true }) })

  it('stopped-recipient warning still carries the queue', async () => {
    // No tmux in the test env, so a sub-agent reads as stopped.
    const r = await post({ from: MAIN_AGENT_ID, to: STOPPED, content: 'ping' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect((r.json.queue as Queue).queueDepth).toBe(1)
  })

  it('homoglyph warning still carries the queue', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: `mer${CYR_E}s kesz` })
    expect(r.statusCode).toBe(200)
    expect(r.json.homoglyph_warning).toBeDefined()
    expect((r.json.queue as Queue).queueDepth).toBeGreaterThanOrEqual(1)
  })
})
