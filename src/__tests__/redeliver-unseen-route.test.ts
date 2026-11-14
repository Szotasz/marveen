// REPLAYNOENVELOPE1114: POST /api/agents/:name/redeliver-unseen. The watchdog calls it after it restarted a
// sub-agent's session; the caller passes ONLY the agent name. The server chooses the rows
// (requeueDeliveredUnseenForAgent) and the router delivers them. Pinned: 200 with the ids; unknown agent 404; the
// main agent 400; any body (ids, `{}`, whitespace) 400 and nothing put back; any query string 400 and nothing put
// back; called twice in a row, the second answers requeued 0. The database is the real one, in memory; nothing is
// delivered or typed by this route.
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

const KNOWN = 'zz-redeliver-known'

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return { ...actual, isKnownAgent: (name: string) => name === KNOWN || name === MAIN_AGENT_ID }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { initDatabase, getDb, createAgentMessage, markMessageDelivered } = await import('../db.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')

function request(body: string | null): RouteContext['req'] {
  const chunks = body === null ? [] : [Buffer.from(body)]
  return Object.assign(Readable.from(chunks), { headers: {} }) as unknown as RouteContext['req']
}

async function post(pathAndQuery: string, body: string | null = null) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const req = request(body)
  ;(req as unknown as { url: string }).url = pathAndQuery
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const handled = await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext, join(PROJECT_ROOT, 'web'))
  return { handled, ...out }
}

function deliveredUnseen(to: string, from = 'carol'): number {
  const id = createAgentMessage(from, to, `task for ${to}`).id
  markMessageDelivered(id)
  return id
}
const status = (id: number) => (getDb().prepare('SELECT status FROM agent_messages WHERE id = ?').get(id) as { status: string }).status

const PATH = `/api/agents/${KNOWN}/redeliver-unseen`

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/agents/:name/redeliver-unseen', () => {
  it('200 with the ids the server chose; the rows are pending again', async () => {
    const a = deliveredUnseen(KNOWN, 'carol')
    const b = deliveredUnseen(KNOWN, 'dave')
    const r = await post(PATH)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, requeued: 2, ids: [a, b] })
    expect([status(a), status(b)]).toEqual(['pending', 'pending'])
  })

  it('called twice in a row, the second answers requeued 0', async () => {
    const a = deliveredUnseen(KNOWN)
    expect((await post(PATH)).body).toEqual({ ok: true, requeued: 1, ids: [a] })
    expect((await post(PATH)).body).toEqual({ ok: true, requeued: 0, ids: [] })
  })

  it('an unknown agent is 404, and nothing is put back', async () => {
    const a = deliveredUnseen('zz-redeliver-unknown')
    const r = await post('/api/agents/zz-redeliver-unknown/redeliver-unseen')
    expect(r.status).toBe(404)
    expect(status(a)).toBe('delivered')
  })

  it('the main agent is 400, and nothing is put back', async () => {
    const a = deliveredUnseen(MAIN_AGENT_ID)
    const r = await post(`/api/agents/${MAIN_AGENT_ID}/redeliver-unseen`)
    expect(r.status).toBe(400)
    expect(status(a)).toBe('delivered')
  })

  it('a body is 400 and nothing is put back: ids, an id, a filter, an empty object, whitespace, anything', async () => {
    const a = deliveredUnseen(KNOWN)
    for (const body of [JSON.stringify({ ids: [a] }), JSON.stringify({ id: a }), JSON.stringify({ from: 'carol' }), '{}', ' ', '\n', String(a)]) {
      const r = await post(PATH, body)
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400])
      expect(status(a)).toBe('delivered')
    }
    // control: the same request with no body puts it back
    expect((await post(PATH)).body).toEqual({ ok: true, requeued: 1, ids: [a] })
  })

  it('a query string is 400 and nothing is put back', async () => {
    const a = deliveredUnseen(KNOWN)
    for (const q of [`?id=${a}`, `?ids=${a}`, '?maxAgeSec=999999', '?x', '?']) {
      const r = await post(PATH + q)
      expect([q, r.status]).toEqual([q, 400])
      expect(status(a)).toBe('delivered')
    }
  })

  it('a system row is not put back through the route either', async () => {
    const sys = deliveredUnseen(KNOWN, 'system')
    expect((await post(PATH)).body).toEqual({ ok: true, requeued: 0, ids: [] })
    expect(status(sys)).toBe('delivered')
  })
})
