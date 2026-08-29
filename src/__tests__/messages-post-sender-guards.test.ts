import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// Runtime tests for the POST /api/messages sender guards. Until now these
// 403s were only source-scanned: nothing exercised the route with a real
// request, so a refactor could silently drop any of them and every test would
// stay green. Each case names the attack it blocks:
//
//   - coordinator forgery: the channel-coordinator id grants channel-inbound
//     framing in the message-router; only the in-process coordinator (which
//     inserts directly into the DB) may carry it.
//   - coordinator alias bypass: the router matches on sanitizeAgentIdent(),
//     which STRIPS [^a-zA-Z0-9_-] rather than trimming -- so "@<id>" survives
//     a .trim() comparison yet sanitizes to the reserved id. The guard must
//     normalize exactly like the router.
//   - federation impersonation: a slash-qualified from is the provenance mark
//     of a REMOTE sender and may only be written by the token-authenticated
//     federation inbox.
//   - unknown sender: the shared Bearer token is readable by every sub-agent;
//     a from that maps to no registered fleet agent must not inject messages.

// Minimal req/res doubles for the tryHandleMessages HTTP surface, same shape
// as the federation-inbox tests: readBody consumes data/end, json() uses
// writeHead/end.
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

describe('POST /api/messages sender guards (runtime)', () => {
  it('rejects a forged channel-coordinator sender with 403', async () => {
    const r = await post({ from: COORDINATOR_AGENT_ID, to: MAIN_AGENT_ID, content: 'forged' })
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toContain('coordinator')
  })

  it('rejects the sanitize-normalization bypass ("@" + coordinator id) with 403', async () => {
    // Survives .trim() (differs from the constant) yet sanitizes to the
    // reserved id -- exactly the asymmetry the guard closes.
    const r = await post({ from: `@${COORDINATOR_AGENT_ID}`, to: MAIN_AGENT_ID, content: 'forged' })
    expect(r.statusCode).toBe(403)
  })

  it('rejects a slash-qualified from (federation impersonation) with 403', async () => {
    const r = await post({ from: 'peer/agent', to: MAIN_AGENT_ID, content: 'spoof' })
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toContain('federation')
  })

  it('rejects an unregistered sender with 403', async () => {
    const r = await post({ from: 'not-a-real-agent', to: MAIN_AGENT_ID, content: 'inject' })
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toContain('unknown agent')
  })

  it('still accepts a registered fleet sender (the guards never widen)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'legit note to self' })
    expect(r.statusCode).toBe(200)
    expect(r.json.from_agent).toBe(MAIN_AGENT_ID)
  })

  it('rejects an empty from/to/content with 400, before any guard', async () => {
    const r = await post({ from: '', to: MAIN_AGENT_ID, content: 'x' })
    expect(r.statusCode).toBe(400)
  })
})
