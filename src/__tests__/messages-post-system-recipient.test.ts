import { describe, it, expect, beforeAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// card 9fc6dc3e: the UNKNOWNTO924 gate rejects a local recipient that is not a
// registered fleet agent. A SYSTEM_SENDER_IDS entry is not unknown: it names a
// neighbouring system that talks to the fleet over this API, and the fleet
// answers it over the same POST. These run the real route with one listed
// system; the negative controls keep the gate closed for everything else.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  // 'system' is listed on purpose: the reserved directive sender must stay
  // unaddressable even when an operator lists it (review of #1827).
  SYSTEM_SENDER_IDS: 'cortex,system',
}))

import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal req/res doubles, the same shape as messages-post-sender-guards.test.ts.
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
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/messages: a SYSTEM_SENDER_IDS id is a valid recipient (card 9fc6dc3e)', () => {
  it('accepts a reply to a listed system with 200 and a stored id', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: 'cortex', content: 'reply to the neighbouring system' })
    expect(r.statusCode).toBe(200)
    expect(r.json.id).toBeTruthy()
    expect(r.json.to_agent).toBe('cortex')
  })

  it('still rejects a recipient that is neither a registered agent nor a listed system', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: 'not-a-listed-system', content: 'x' })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('unknown recipient')
  })

  it('does not widen a listed id to a longer lookalike', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: 'cortex-router', content: 'x' })
    expect(r.statusCode).toBe(400)
  })

  it('keeps the reserved system directive id closed as a recipient even when it is listed', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: 'system', content: 'x' })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('unknown recipient')
  })

  it('rejects a near-miss that only sanitises to a listed id (it would be stored under a name nobody reads)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: 'cort ex', content: 'x' })
    expect(r.statusCode).toBe(400)
    expect(String(r.json.error)).toContain('unknown recipient')
  })

  it('accepts the listed id surrounded by whitespace, stored trimmed', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: '  cortex  ', content: 'x' })
    expect(r.statusCode).toBe(200)
    expect(r.json.to_agent).toBe('cortex')
  })
})
