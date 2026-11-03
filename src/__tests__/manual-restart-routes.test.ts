/**
 * RESTARTFORCEUI1018: the manual main restart, through the REAL route handlers. manual-restart-wiring.test.ts
 * checks the order of the calls in the source text; this checks what a caller gets:
 * - a refused gate answers 409 restart-blocked with the reason and the force hint, and does NOT restart;
 * - an allowed gate restarts once and answers 200;
 * - an explicit {"force": true} skips the gate, restarts, and is logged;
 * - a body that is not an explicit force is gated like no body.
 * The gate and the hard restart are stubbed: no tmux, no launchctl.
 */
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.fn()
const hard = vi.fn()

vi.mock('../web/manual-restart-gate.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/manual-restart-gate.js')>()
  return { ...orig, gateManualRestart: (...a: unknown[]) => gate(...a) }
})
vi.mock('../web/channel-monitor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/channel-monitor.js')>()
  return { ...orig, hardRestartMarveenChannels: () => hard() }
})

const { tryHandleMarveen } = await import('../web/routes/marveen.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')
const { MANUAL_RESTART_FORCE_HINT } = await import('../web/manual-restart-gate.js')
const { logger } = await import('../logger.js')
type RouteContext = import('../web/routes/types.js').RouteContext

function fakeCtx(path: string, body: string | null) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]) as unknown as RouteContext['req']
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext
  return { ctx, out }
}

const ROUTES: Array<[string, string, (ctx: RouteContext) => Promise<boolean>]> = [
  ['/api/marveen/restart', '/api/marveen/restart', (ctx) => tryHandleMarveen(ctx, join(PROJECT_ROOT, 'web'))],
  ['/api/agents/:name/restart (main)', `/api/agents/${encodeURIComponent(MAIN_AGENT_ID)}/restart`, (ctx) => tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))],
]

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  gate.mockReset()
  hard.mockReset()
  hard.mockReturnValue({ ok: true })
  warn = vi.spyOn(logger, 'warn')
})
afterEach(() => { warn.mockRestore() })

const forcedLogged = () => (warn.mock.calls as unknown[][]).some((c) => c.some((a) => typeof a === 'string' && a.includes('forced past the pane gate')))

describe.each(ROUTES)('%s', (_label, path, handle) => {
  it.each(['busy', 'no-pane', 'unknown-state'])('a refused gate (%s) answers 409 with the reason and the hint, and does not restart', async (reason) => {
    gate.mockResolvedValue({ allow: false, reason })
    const { ctx, out } = fakeCtx(path, null)
    expect(await handle(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ error: 'restart-blocked', reason, hint: MANUAL_RESTART_FORCE_HINT })
    expect(gate).toHaveBeenCalledWith(MAIN_CHANNELS_SESSION)
    expect(hard).not.toHaveBeenCalled()
    expect(forcedLogged()).toBe(false)
  })

  it('an allowed gate restarts once and answers 200', async () => {
    gate.mockResolvedValue({ allow: true, reason: 'idle' })
    const { ctx, out } = fakeCtx(path, null)
    expect(await handle(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
    expect(hard).toHaveBeenCalledTimes(1)
  })

  it('an explicit {"force": true} skips the gate, restarts, and is logged', async () => {
    gate.mockResolvedValue({ allow: false, reason: 'busy' })
    const { ctx, out } = fakeCtx(path, JSON.stringify({ force: true }))
    expect(await handle(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(gate).not.toHaveBeenCalled()
    expect(hard).toHaveBeenCalledTimes(1)
    expect(forcedLogged()).toBe(true)
  })

  it.each(['{"force": "true"}', '{"force": 1}', 'not json', '{}'])('a body that is not an explicit force (%s) is gated', async (body) => {
    gate.mockResolvedValue({ allow: false, reason: 'busy' })
    const { ctx, out } = fakeCtx(path, body)
    expect(await handle(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(hard).not.toHaveBeenCalled()
  })

  it('a failed hard restart after an allowed gate is a 500, not a silent ok', async () => {
    gate.mockResolvedValue({ allow: true, reason: 'idle' })
    hard.mockReturnValue({ ok: false, error: 'boom' })
    const { ctx, out } = fakeCtx(path, null)
    expect(await handle(ctx)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body).toEqual({ error: 'boom' })
  })
})
