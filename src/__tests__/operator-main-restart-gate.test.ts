/**
 * OPERRESTART409_1018: the operator's main-agent restart, through the REAL operator route and the REAL owner route
 * behind it (only the pane gate and the hard restart are stubbed). Since #2043 the owner route refuses a manual
 * main restart at a busy or unreadable pane, and only an explicit {"force": true} gets past. What it proves:
 * - an operator never forces: with no body, and with a {"force": true} body, a busy gate means no restart;
 * - the refusal is a readable operator message, without the owner route's force hint;
 * - an allowed gate restarts once and the operator gets the owner route's answer unchanged;
 * - a failed restart reaches the operator as the owner route wrote it.
 */
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ access: null as any, mainId: '', gate: vi.fn(), hard: vi.fn() }))

vi.mock('../web/operator-access.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readOperatorAccess: () => h.access,
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...(await (async () => { const { MAIN_AGENT_ID } = await import('../config.js'); h.mainId = MAIN_AGENT_ID; return {} })()),
  isKnownAgent: (n: string) => n === h.mainId,
}))
vi.mock('../web/manual-restart-gate.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  gateManualRestart: (...a: unknown[]) => h.gate(...a),
}))
vi.mock('../web/channel-monitor.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hardRestartMarveenChannels: () => h.hard(),
}))

import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { defaultOperatorAccess, OPERATOR_CAPABILITIES } from '../web/operator-access.js'
import { MANUAL_RESTART_FORCE_HINT } from '../web/manual-restart-gate.js'
import { OPERATOR_MAIN_RESTART_BLOCKED, tryHandleOperator } from '../web/routes/operator.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  const a = defaultOperatorAccess()
  a.enabled = true
  for (const c of OPERATOR_CAPABILITIES) a.capabilities[c] = true
  h.access = a
  h.gate.mockReset()
  h.hard.mockReset()
  h.hard.mockReturnValue({ ok: true })
})

const OPERATOR = { kind: 'device', device: 'it-op', deviceId: 7, scope: 'operator' } as RouteContext['auth']

async function restartMain(body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    setHeader() { return res },
    writeHead(s: number) { out.status = s; return res },
    end(c?: string) { if (c) out.body = JSON.parse(String(c)) },
  }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.9' }
  const path = `/api/operator/agents/${encodeURIComponent(MAIN_AGENT_ID)}/restart`
  const ctx = { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), auth: OPERATOR } as RouteContext
  expect(await tryHandleOperator(ctx, '/nonexistent-web-dir')).toBe(true)
  return out
}

describe('operator main-agent restart behind the busy gate', () => {
  it.each([undefined, { force: true }])('a busy gate refuses, and the operator cannot force (body %j)', async (body) => {
    h.gate.mockResolvedValue({ allow: false, reason: 'busy' })
    const r = await restartMain(body)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'restart-blocked', reason: 'busy', message: OPERATOR_MAIN_RESTART_BLOCKED })
    expect(JSON.stringify(r.body)).not.toContain(MANUAL_RESTART_FORCE_HINT)
    expect(JSON.stringify(r.body)).not.toContain('force')
    expect(h.gate).toHaveBeenCalledTimes(1)
    expect(h.hard).not.toHaveBeenCalled()
  })

  it('an unreadable pane is refused the same way, with its reason', async () => {
    h.gate.mockResolvedValue({ allow: false, reason: 'no-pane' })
    const r = await restartMain()
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('no-pane')
    expect(r.body.message).toBe(OPERATOR_MAIN_RESTART_BLOCKED)
  })

  it('an allowed gate restarts once and passes the owner route answer through', async () => {
    h.gate.mockResolvedValue({ allow: true, reason: 'idle' })
    const r = await restartMain()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(h.hard).toHaveBeenCalledTimes(1)
  })

  it('a failed restart reaches the operator as the owner route wrote it', async () => {
    h.gate.mockResolvedValue({ allow: true, reason: 'idle' })
    h.hard.mockReturnValue({ ok: false, error: 'boom' })
    const r = await restartMain()
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'boom' })
  })

  it('the operator message names who can cut the turn, and offers no force', () => {
    expect(OPERATOR_MAIN_RESTART_BLOCKED).toContain('gazda')
    expect(OPERATOR_MAIN_RESTART_BLOCKED).not.toMatch(/force/i)
  })
})

// --- the operator page (web/operator.js agentAction, the shipped function, fake msg/api) ---
describe('operator page: a refused main restart shows the readable message', () => {
  const OP = readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf-8')
  const start = OP.indexOf('  async function agentAction(name, path, label) {')
  const end = OP.indexOf('\n  function renderAgents(', start)
  const run = async (reply: { ok: boolean; status: number; data: unknown }) => {
    const shown: Array<[string, string | undefined]> = []
    const fn = new Function('msg', 'api', 'refresh', 'setTimeout', `${OP.slice(start, end)}\nreturn agentAction`)(
      (_id: string, text: string, cls?: string) => { shown.push([text, cls]) },
      async () => reply, () => {}, () => 0,
    ) as (n: string, p: string, l: string) => Promise<void>
    await fn('marveen', '/api/operator/agents/marveen/restart', 'Újraindítás')
    return shown.at(-1)
  }

  it('the function is found in web/operator.js', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })
  it('409 restart-blocked: the message, as an error', async () => {
    expect(await run({ ok: false, status: 409, data: { error: 'restart-blocked', reason: 'busy', message: OPERATOR_MAIN_RESTART_BLOCKED } }))
      .toEqual([OPERATOR_MAIN_RESTART_BLOCKED, 'err'])
  })
  it('another failure keeps the old line', async () => {
    expect(await run({ ok: false, status: 500, data: { error: 'boom' } })).toEqual(['Újraindítás sikertelen (marveen): boom', 'err'])
  })
  it('success keeps the old line', async () => {
    expect(await run({ ok: true, status: 200, data: { ok: true } })).toEqual(['Újraindítás: marveen kész.', 'ok'])
  })
})
