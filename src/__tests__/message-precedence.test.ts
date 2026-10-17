import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { agentDir } from '../web/agent-config.js'
import { initDatabase, getDb, createAgentMessage, getPendingMessages, claimPendingForAgent, countHighForPairSince } from '../db.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { selectTickWindow, STOP_PREFIX } from '../web/message-router-window.js'
import type { RouteContext } from '../web/routes/types.js'

// #1835 + #1808 together (the precedence the review stated): an authenticated STOP, then an urgent row,
// then a system or owner row, then a granted peer high, then the rest, FIFO inside each class; and an
// urgent row never spends the per-pair high budget. Measured on the real SQLite and the real POST route.

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MESSAGE_URGENT_DEVICE_IDS: '7',
}))

type Auth = RouteContext['auth']
const TOKEN: Auth = { kind: 'token' } as Auth
const LISTED_KEY: Auth = { kind: 'device', device: 'kulcsvalto', deviceId: 7, scope: 'full' } as Auth
const PEER = 'precedencia-kuldo'
const TARGET = 'precedencia-cel'

function fakeCtx(body: unknown, auth: Auth): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
    getHeader() { return undefined },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null, auth } as RouteContext, res: state }
}
async function post(body: unknown, auth: Auth): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body, auth)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}
const nowSec = () => Math.floor(Date.now() / 1000)
const setCreated = (id: number, sec: number) => getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?').run(sec, id)
const storedPriority = (id: number) => (getDb().prepare('SELECT priority FROM agent_messages WHERE id = ?').get(id) as { priority: number }).priority

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  for (const a of [PEER, TARGET]) mkdirSync(agentDir(a), { recursive: true })
})
afterAll(() => { for (const a of [PEER, TARGET]) rmSync(agentDir(a), { recursive: true, force: true }) })
beforeEach(() => { getDb().prepare('DELETE FROM agent_messages').run() })
afterEach(() => { delete process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR })

describe('STOP, urgent, system/owner, high, then the rest', () => {
  it('the whole precedence on one queue, FIFO inside each class: the queue order and the main agent\'s claim', () => {
    // Two rows per class, written in REVERSE class order (the lowest class oldest), so every class
    // boundary is crossed against age: a FIFO-only order, or any two classes sharing a rank, fails.
    const base = nowSec() - 600
    let t = base
    const row = (from: string, content: string, opts?: Parameters<typeof createAgentMessage>[5]) => {
      const m = createAgentMessage(from, MAIN_AGENT_ID, content, null, null, opts)
      setCreated(m.id, (t += 10))
      return m.id
    }
    const normal = [row(PEER, 'normal 1'), row(PEER, 'normal 2')]
    const high = [row(PEER, 'high 1', { priority: 1 }), row(PEER, 'high 2', { priority: 1 })]
    const owner = [row('system', 'rendszer'), row(OWNER_NAME, 'a tulajdonos')]
    const urgent = [row(PEER, 'urgent 1', { urgent: true }), row(PEER, 'urgent 2', { urgent: true })]
    const stop = [
      row(MAIN_AGENT_ID, `${STOP_PREFIX} 1`, { stopAuthorized: true }),
      row(MAIN_AGENT_ID, `${STOP_PREFIX} 2`, { stopAuthorized: true }),
    ]
    const want = [...stop, ...urgent, ...owner, ...high, ...normal]
    expect(getPendingMessages(MAIN_AGENT_ID).map((m) => m.id)).toEqual(want)
    expect(claimPendingForAgent(MAIN_AGENT_ID, 20).map((m) => m.id)).toEqual(want)
  })

  it('the router window: urgent rows first, then the recipients in delivery order (a high row brings its recipient first)', () => {
    const base = nowSec() - 600
    const a1 = createAgentMessage(PEER, 'a-cel', 'a normal');                              setCreated(a1.id, base)
    const b1 = createAgentMessage(PEER, 'b-cel', 'b high', null, null, { priority: 1 });    setCreated(b1.id, base + 10)
    const c1 = createAgentMessage(PEER, 'c-cel', 'c urgent', null, null, { urgent: true }); setCreated(c1.id, base + 20)
    expect(selectTickWindow(getPendingMessages(), 25, MAIN_AGENT_ID).map((m) => m.id)).toEqual([c1.id, b1.id, a1.id])
  })

  it('⛔ an urgent row never spends the pair\'s high budget: with a budget of 1, the peer high after it is still high', async () => {
    process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR = '1'
    const urgent = await post({ from: PEER, to: TARGET, content: 'mentsd a munkat', urgent: true, priority: 'high' }, LISTED_KEY)
    expect(urgent.statusCode).toBe(200)
    expect(urgent.json.urgent).toBe(1)
    expect(storedPriority(Number(urgent.json.id))).toBe(0)
    expect(urgent.json.downgraded).toBeUndefined()
    expect(countHighForPairSince(PEER, TARGET, nowSec() - 3600)).toBe(0)
    const high = await post({ from: PEER, to: TARGET, content: 'high', priority: 'high' }, TOKEN)
    expect(storedPriority(Number(high.json.id))).toBe(1)
    expect(high.json.downgraded).toBeUndefined()
    // and the budget still works for the peer's highs
    const second = await post({ from: PEER, to: TARGET, content: 'high 2', priority: 'high' }, TOKEN)
    expect(second.json.downgraded).toBe(true)
  })

  it('an in-process urgent row that also carries priority 1 is not counted against the budget either', () => {
    createAgentMessage(PEER, TARGET, 'u', null, null, { urgent: true, priority: 1 })
    expect(countHighForPairSince(PEER, TARGET, nowSec() - 3600)).toBe(0)
  })

  it('the shared token still cannot buy the first rank: urgent is a 403, and priority high only reaches rank 1', async () => {
    expect((await post({ from: PEER, to: TARGET, content: 'x', urgent: true }, TOKEN)).statusCode).toBe(403)
    const urgent = createAgentMessage(PEER, TARGET, 'in-process urgent', null, null, { urgent: true })
    setCreated(urgent.id, nowSec() + 100) // even newer than everything
    const high = await post({ from: PEER, to: TARGET, content: 'high', priority: 'high' }, TOKEN)
    expect(getPendingMessages(TARGET).map((m) => m.id)).toEqual([urgent.id, Number(high.json.id)])
  })
})
