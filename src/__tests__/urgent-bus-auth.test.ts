import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { agentDir } from '../web/agent-config.js'
import { initDatabase, createAgentMessage, getAgentMessage, listAgentMessages } from '../db.js'
import { MAIN_AGENT_ID, parseDeviceKeyIds } from '../config.js'
import { tryHandleMessages, mayMarkUrgent } from '../web/routes/messages.js'
import { isStopMessage, STOP_PREFIX } from '../web/message-router-window.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { resolveAuth } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 795d1f48 (a): who may create an URGENT row (one the router types into a busy pane, router-urgent-delivery.test.ts).
// Only an in-process writer (createAgentMessage with urgent) or a POST on a FULL device key whose id the install lists
// in MESSAGE_URGENT_DEVICE_IDS: that is the key rotator's path. The shared dashboard token is the agent API, every
// sub-agent reads it, and it can mint a device key (POST /api/auth/device-keys): so neither the token nor an unlisted
// key may send one, and both are refused before anything is written.

// The install lists ONE key for urgent rows, id 7; the route reads the list at module load.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MESSAGE_URGENT_DEVICE_IDS: '7',
}))

type Auth = RouteContext['auth']

function fakeCtx(body: unknown, auth: Auth, path = '/api/messages'): { ctx: RouteContext; res: { statusCode: number; body: string } } {
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
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null, auth } as RouteContext, res: state }
}

async function post(body: unknown, auth: Auth): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body, auth)
  const handled = await tryHandleMessages(ctx)
  expect(handled).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

const TOKEN: Auth = { kind: 'token' } as Auth
const LISTED_KEY: Auth = { kind: 'device', device: 'kulcsvalto', deviceId: 7, scope: 'full' } as Auth
const UNLISTED_KEY: Auth = { kind: 'device', device: 'masik-eszkoz', deviceId: 8, scope: 'full' } as Auth
// The listed id, but an operator key: the scope still decides.
const OPERATOR_KEY: Auth = { kind: 'device', device: 'operator-gep', deviceId: 7, scope: 'operator' } as Auth
const rowCount = () => listAgentMessages(10_000).length
// A real, known sender (an agents/<id>/ directory), so a refusal below is the urgent gate's and not the unknown-sender rule's.
const SENDER = 'kulcsvalto-teszt-795d'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(agentDir(SENDER), { recursive: true })
})
afterAll(() => { rmSync(agentDir(SENDER), { recursive: true, force: true }) })

describe('POST /api/messages: urgent only on a device key the install lists (795d1f48 a)', () => {
  it('(a1) the shared dashboard token: 403, and no row is written', async () => {
    const before = rowCount()
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'mentesi jelzes', urgent: true }, TOKEN)
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toMatch(/urgent/i)
    expect(String(r.json.error)).toMatch(/MESSAGE_URGENT_DEVICE_IDS/)
    expect(rowCount()).toBe(before)
  })

  it('(a2) no auth context, and an operator key even with the listed id: 403 as well, no row', async () => {
    const before = rowCount()
    for (const auth of [undefined, OPERATOR_KEY]) {
      const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'x', urgent: true }, auth)
      expect(r.statusCode, `auth ${JSON.stringify(auth)}`).toBe(403)
      expect(String(r.json.error)).toMatch(/urgent/i)
    }
    expect(rowCount()).toBe(before)
  })

  it('(a3) the listed full key: 200, and the stored row is urgent (the same sender without urgent is accepted too: the control)', async () => {
    expect((await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'kontroll' }, TOKEN)).statusCode).toBe(200)
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'mentesi jelzes, kulcsvalto', urgent: true }, LISTED_KEY)
    expect(r.statusCode).toBe(200)
    const stored = getAgentMessage(Number(r.json.id))
    expect(stored?.urgent).toBe(1)
    expect(r.json.urgent).toBe(1)
  })

  it('(a4) urgent must be a JSON boolean: a string is a 400, before anything is written', async () => {
    const before = rowCount()
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'x', urgent: 'true' }, LISTED_KEY)
    expect(r.statusCode).toBe(400)
    expect(rowCount()).toBe(before)
  })

  it('(a5) without urgent, or urgent: false, the agent API works as before and the row is ordinary', async () => {
    const plain = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'sima uzenet' }, TOKEN)
    const explicit = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'sima uzenet 2', urgent: false }, TOKEN)
    expect(plain.statusCode).toBe(200)
    expect(explicit.statusCode).toBe(200)
    expect(getAgentMessage(Number(plain.json.id))?.urgent).toBe(0)
    expect(getAgentMessage(Number(explicit.json.id))?.urgent).toBe(0)
  })

  it('(a7) NEGATIVE: a full device key the install does not list: 403, no row (the same key without urgent is accepted)', async () => {
    const before = rowCount()
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'mentesi jelzes', urgent: true }, UNLISTED_KEY)
    expect(r.statusCode).toBe(403)
    expect(String(r.json.error)).toMatch(/MESSAGE_URGENT_DEVICE_IDS/)
    expect(rowCount()).toBe(before)
    expect((await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'sima, ugyanazzal a kulccsal' }, UNLISTED_KEY)).statusCode).toBe(200)
  })

  it('(a8) the measured path: the shared token mints a full key, and that key cannot send an urgent row', async () => {
    // 1. the shared token mints a key through the real route (a 201 with the raw key, scope full by default)
    const minted = fakeCtx({ name: 'barki-kulcsa' }, TOKEN, '/api/auth/device-keys')
    expect(await tryHandleAuth(minted.ctx)).toBe(true)
    expect(minted.res.statusCode).toBe(201)
    const key = JSON.parse(minted.res.body) as { id: number; key: string; scope: string }
    expect(key.scope).toBe('full')
    expect(parseDeviceKeyIds('7').has(key.id)).toBe(false) // guard: the minted key is not the listed one
    // 2. the HTTP gate resolves that key as web.ts would (a device principal), then the key asks for an urgent row
    const req = { headers: { authorization: `Bearer ${key.key}` } } as unknown as Parameters<typeof resolveAuth>[0]
    const gate = resolveAuth(req, new URL('http://localhost/api/messages'), '/api/messages', 'POST', 'z'.repeat(64))
    expect(gate).toMatchObject({ kind: 'device', deviceId: key.id, scope: 'full' })
    const auth = gate.kind === 'device' ? ({ kind: 'device', device: gate.device, deviceId: gate.deviceId, scope: gate.scope } as Auth) : undefined
    const before = rowCount()
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: 'a vert kulccsal', urgent: true }, auth)
    expect(r.statusCode).toBe(403)
    expect(rowCount()).toBe(before)
  })
})

describe('who may mark urgent, as pure rules (795d1f48 a)', () => {
  it('(a9) the list: positive integers only; empty, missing or unreadable means nobody', () => {
    expect([...parseDeviceKeyIds(undefined)]).toEqual([])
    expect([...parseDeviceKeyIds('')]).toEqual([])
    expect([...parseDeviceKeyIds(' 7, 9,, x, -1, 0, 3.5, 07, 1e3, 12 ')].sort((a, b) => a - b)).toEqual([7, 9, 12])
  })

  it('(a10) mayMarkUrgent: only a full key on the list; an empty list lets nobody through', () => {
    const listed = parseDeviceKeyIds('7')
    expect(mayMarkUrgent(LISTED_KEY, listed)).toBe(true)
    expect(mayMarkUrgent(LISTED_KEY, new Set())).toBe(false)
    expect(mayMarkUrgent(UNLISTED_KEY, listed)).toBe(false)
    expect(mayMarkUrgent(OPERATOR_KEY, listed)).toBe(false)
    expect(mayMarkUrgent(TOKEN, listed)).toBe(false)
    expect(mayMarkUrgent(undefined, listed)).toBe(false)
    expect(mayMarkUrgent({ kind: 'device', device: 'nincs-id', scope: 'full' } as Auth, listed)).toBe(false)
  })
})

describe('the in-process writer (795d1f48 a)', () => {
  it('(a6) createAgentMessage marks a row urgent only when asked; the default stays ordinary', () => {
    const urgent = createAgentMessage('system', MAIN_AGENT_ID, 'rendszer: mentsd a munkadat', null, null, { urgent: true })
    const plain = createAgentMessage('system', MAIN_AGENT_ID, 'rendszer: sima')
    expect(urgent.urgent).toBe(1)
    expect(getAgentMessage(urgent.id)?.urgent).toBe(1)
    expect(plain.urgent).toBe(0)
    expect(getAgentMessage(plain.id)?.urgent).toBe(0)
  })
})

describe('a STOP over HTTP rides on the same lane (71263d15 C, extended by 795d1f48 a)', () => {
  const STOP_TEXT = `${STOP_PREFIX} ne kuldd ki a levelet`

  it('⛔ the shared token: a [STOP] as the main agent is an ordinary row, and asking for urgent is a 403 with no row', async () => {
    const plain = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: STOP_TEXT }, TOKEN)
    expect(plain.statusCode).toBe(200)
    expect(isStopMessage(getAgentMessage(Number(plain.json.id))!, MAIN_AGENT_ID)).toBe(false)
    const before = rowCount()
    const forced = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: STOP_TEXT, urgent: true }, TOKEN)
    expect(forced.statusCode).toBe(403)
    expect(rowCount()).toBe(before)
  })

  it('⛔ an unlisted full key: the same 403 for urgent, and without urgent its [STOP] is ordinary', async () => {
    expect((await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: STOP_TEXT, urgent: true }, UNLISTED_KEY)).statusCode).toBe(403)
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: STOP_TEXT }, UNLISTED_KEY)
    expect(r.statusCode).toBe(200)
    expect(isStopMessage(getAgentMessage(Number(r.json.id))!, MAIN_AGENT_ID)).toBe(false)
  })

  it('the listed full key: {from: main agent, [STOP], urgent: true} is a STOP', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: STOP_TEXT, urgent: true }, LISTED_KEY)
    expect(r.statusCode).toBe(200)
    const stored = getAgentMessage(Number(r.json.id))!
    expect(stored.urgent).toBe(1)
    expect(stored.stop_authorized).toBe(0) // the HTTP route never sets the in-process flag
    expect(isStopMessage(stored, MAIN_AGENT_ID)).toBe(true)
  })

  it('the listed key cannot make a peer-named [STOP] a STOP (it is an urgent row, not a STOP)', async () => {
    const r = await post({ from: SENDER, to: MAIN_AGENT_ID, content: STOP_TEXT, urgent: true }, LISTED_KEY)
    expect(r.statusCode).toBe(200)
    expect(isStopMessage(getAgentMessage(Number(r.json.id))!, MAIN_AGENT_ID)).toBe(false)
  })
})
