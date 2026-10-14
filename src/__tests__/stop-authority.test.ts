import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { agentDir } from '../web/agent-config.js'
import { initDatabase, createAgentMessage, getAgentMessage } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { isStopMessage, STOP_PREFIX } from '../web/message-router-window.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 71263d15 (C), the #1809 review (point 2 of the follow-up): a STOP reaches a BUSY pane,
// so who may send one cannot rest on the self-declared `from`. POST /api/messages accepts
// from:"<main agent>" on the shared dashboard token, which every sub-agent reads. The privilege
// is the row's stop_authorized flag: only an in-process writer sets it (createAgentMessage with
// stopAuthorized), and the HTTP route never does, whatever the body says. Such a row is still
// delivered, as an ordinary one.

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
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null, auth } as RouteContext, res: state }
}

async function post(body: unknown, auth: Auth): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body, auth)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

const TOKEN: Auth = { kind: 'token' } as Auth
const DEVICE: Auth = { kind: 'device', device: 'barmelyik', deviceId: 3, scope: 'full' } as Auth
// A real, known recipient (an agents/<id>/ directory).
const TARGET = 'stop-cel-71263d15'
const STOP_TEXT = `${STOP_PREFIX} ne kuldd ki a levelet`

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(agentDir(TARGET), { recursive: true })
})
afterAll(() => { rmSync(agentDir(TARGET), { recursive: true, force: true }) })

describe('STOP authority is the write lane, not the claimed sender (71263d15 C)', () => {
  it('⛔ the shared token posting a [STOP] as the main agent: accepted, stored WITHOUT stop authority, so an ordinary row', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: STOP_TEXT }, TOKEN)
    expect(r.statusCode).toBe(200)
    const stored = getAgentMessage(Number(r.json.id))!
    expect(stored.stop_authorized).toBe(0)
    expect(stored.status).toBe('pending')
    expect(isStopMessage(stored, MAIN_AGENT_ID)).toBe(false)
  })

  it('⛔ a body that asks for it (stop_authorized / stopAuthorized) is ignored', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: STOP_TEXT, stop_authorized: 1, stopAuthorized: true }, TOKEN)
    expect(r.statusCode).toBe(200)
    const stored = getAgentMessage(Number(r.json.id))!
    expect(stored.stop_authorized).toBe(0)
    expect(isStopMessage(stored, MAIN_AGENT_ID)).toBe(false)
  })

  it('⛔ a device key does not grant it on this branch either (HTTP rows never STOP)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: TARGET, content: STOP_TEXT }, DEVICE)
    expect(r.statusCode).toBe(200)
    expect(isStopMessage(getAgentMessage(Number(r.json.id))!, MAIN_AGENT_ID)).toBe(false)
  })

  it('the in-process writer: stopAuthorized makes the same text a STOP; the default does not', () => {
    const authed = createAgentMessage(MAIN_AGENT_ID, TARGET, STOP_TEXT, null, null, { stopAuthorized: true })
    const plain = createAgentMessage(MAIN_AGENT_ID, TARGET, STOP_TEXT)
    expect(authed.stop_authorized).toBe(1)
    expect(getAgentMessage(authed.id)?.stop_authorized).toBe(1)
    expect(isStopMessage(getAgentMessage(authed.id)!, MAIN_AGENT_ID)).toBe(true)
    expect(plain.stop_authorized).toBe(0)
    expect(isStopMessage(getAgentMessage(plain.id)!, MAIN_AGENT_ID)).toBe(false)
  })

  it('an authorized row from any other sender, or without the prefix, is still not a STOP', () => {
    const peer = createAgentMessage('geri', TARGET, STOP_TEXT, null, null, { stopAuthorized: true })
    const noPrefix = createAgentMessage(MAIN_AGENT_ID, TARGET, 'allj meg', null, null, { stopAuthorized: true })
    expect(isStopMessage(getAgentMessage(peer.id)!, MAIN_AGENT_ID)).toBe(false)
    expect(isStopMessage(getAgentMessage(noPrefix.id)!, MAIN_AGENT_ID)).toBe(false)
  })
})
