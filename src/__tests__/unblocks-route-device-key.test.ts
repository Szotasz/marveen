import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { agentDir } from '../web/agent-config.js'
import { initDatabase, getAgentMessage, listAgentMessages } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// PR #2279 review: `affects_current_work: "unblocks"` must not be a second way
// round the urgent device-key gate. It reaches a busy pane exactly like an
// urgent row, so the route asks for the same key: a FULL device key whose id
// the install lists in MESSAGE_URGENT_DEVICE_IDS. The shared dashboard token
// (every sub-agent reads it) must be refused before anything is written.

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MESSAGE_URGENT_DEVICE_IDS: '7',
}))

type Auth = RouteContext['auth']

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
  return { ctx: { req, res, path: '/api/messages', method: 'POST', url: new URL('http://localhost/api/messages'), fedPeer: null, auth } as RouteContext, res: state }
}

async function post(body: unknown, auth: Auth): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body, auth)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

const TOKEN: Auth = { kind: 'token' } as Auth
const LISTED_KEY: Auth = { kind: 'device', device: 'webby-kulcs', deviceId: 7, scope: 'full' } as Auth
const UNLISTED_KEY: Auth = { kind: 'device', device: 'masik-eszkoz', deviceId: 8, scope: 'full' } as Auth
const OPERATOR_KEY: Auth = { kind: 'device', device: 'operator-gep', deviceId: 7, scope: 'operator' } as Auth
// A real, known recipient (an agents/<id>/ directory), so a 400/403 below is the unblocks rule's and not the unknown-agent rule's.
const RECIPIENT = 'feloldas-cimzett-673'
const rowCount = () => listAgentMessages(10_000).length

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(agentDir(RECIPIENT), { recursive: true })
})
afterAll(() => { rmSync(agentDir(RECIPIENT), { recursive: true, force: true }) })

describe('POST /api/messages: affects_current_work needs the urgent device key', () => {
  it('(d1) the shared dashboard token and no auth context: 403, no row written', async () => {
    const before = rowCount()
    for (const auth of [TOKEN, undefined]) {
      const r = await post({ from: MAIN_AGENT_ID, to: RECIPIENT, content: 'feloldva', affects_current_work: 'unblocks' }, auth)
      expect(r.statusCode, `auth ${JSON.stringify(auth)}`).toBe(403)
      expect(String(r.json.error)).toMatch(/MESSAGE_URGENT_DEVICE_IDS/)
    }
    expect(rowCount()).toBe(before)
  })

  it('(d2) an unlisted full key and a listed-id operator key: 403, no row written', async () => {
    const before = rowCount()
    for (const auth of [UNLISTED_KEY, OPERATOR_KEY]) {
      const r = await post({ from: MAIN_AGENT_ID, to: RECIPIENT, content: 'feloldva', affects_current_work: 'unblocks' }, auth)
      expect(r.statusCode, `auth ${JSON.stringify(auth)}`).toBe(403)
    }
    expect(rowCount()).toBe(before)
  })

  it('(d3) POSITIVE CONTROL: the listed full key as the main agent is accepted and the row stores unblocks', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: RECIPIENT, content: 'feloldva, mehet a kirakas', affects_current_work: 'unblocks' }, LISTED_KEY)
    expect(r.statusCode).toBe(200)
    expect(getAgentMessage(Number(r.json.id))?.affects_current_work).toBe('unblocks')
  })

  it('(d4) the same unlisted key and the shared token still work WITHOUT the field, and the row has no flag', async () => {
    for (const auth of [TOKEN, UNLISTED_KEY]) {
      const r = await post({ from: MAIN_AGENT_ID, to: RECIPIENT, content: 'sima uzenet' }, auth)
      expect(r.statusCode, `auth ${JSON.stringify(auth)}`).toBe(200)
      expect(getAgentMessage(Number(r.json.id))?.affects_current_work ?? null).toBeNull()
    }
  })

  it('(d5) a bad value or a non-main sender stays a 400 on the listed key, before anything is written', async () => {
    const before = rowCount()
    const bad = await post({ from: MAIN_AGENT_ID, to: RECIPIENT, content: 'x', affects_current_work: 'danger' }, LISTED_KEY)
    expect(bad.statusCode).toBe(400)
    const other = await post({ from: 'cody', to: MAIN_AGENT_ID, content: 'x', affects_current_work: 'unblocks' }, LISTED_KEY)
    expect(other.statusCode).toBe(400)
    expect(rowCount()).toBe(before)
  })
})
