/**
 * FEDAPPLYGATE1018: POST /api/federation/apply restarts the main agent, so it is a manual main restart and takes
 * the same gate as /api/marveen/restart (manual-restart-gate.ts). Before, it called hardRestartMarveenChannels()
 * with no check and could cut a running turn. What it proves:
 * - the route: a refused gate answers 409 with the reason and does not restart; an allowed gate restarts; an
 *   explicit {"force": true} skips the gate and is logged; the page's plain '{}' body is gated;
 * - the Federation page (the shipped fedApplyToMainAgent from web/app.js, fake DOM): a refusal asks a second time
 *   and only then forces; a declined second confirm starts nothing.
 * The gate and the hard restart are stubbed: no tmux, no launchctl.
 */
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
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

const { tryHandleFederation } = await import('../web/routes/federation.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')
const { logger } = await import('../logger.js')
type RouteContext = import('../web/routes/types.js').RouteContext

async function apply(body: string | null) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]) as unknown as RouteContext['req']
  const url = new URL('http://localhost:3420/api/federation/apply')
  const ctx = { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext
  expect(await tryHandleFederation(ctx)).toBe(true)
  return out
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  gate.mockReset()
  hard.mockReset()
  hard.mockReturnValue({ ok: true })
  warn = vi.spyOn(logger, 'warn')
})
afterEach(() => { warn.mockRestore() })
const forcedLogged = () => (warn.mock.calls as unknown[][]).some((c) => c.some((a) => typeof a === 'string' && a.includes('forced past the pane gate')))

describe('POST /api/federation/apply behind the busy gate', () => {
  it.each(['busy', 'no-pane', 'unknown-state'])('a refused gate (%s) answers 409 and does not restart', async (reason) => {
    gate.mockResolvedValue({ allow: false, reason })
    const r = await apply('{}')
    expect(r.status).toBe(409)
    expect(r.body?.error).toBe('restart-blocked')
    expect(r.body?.reason).toBe(reason)
    expect(gate).toHaveBeenCalledWith(MAIN_CHANNELS_SESSION)
    expect(hard).not.toHaveBeenCalled()
  })

  it.each([null, '{}'])('an allowed gate restarts once (body %j)', async (body) => {
    gate.mockResolvedValue({ allow: true, reason: 'idle' })
    const r = await apply(body)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(hard).toHaveBeenCalledTimes(1)
  })

  it('an explicit {"force": true} skips the gate, restarts, and is logged', async () => {
    gate.mockResolvedValue({ allow: false, reason: 'busy' })
    const r = await apply(JSON.stringify({ force: true }))
    expect(r.status).toBe(200)
    expect(gate).not.toHaveBeenCalled()
    expect(hard).toHaveBeenCalledTimes(1)
    expect(forcedLogged()).toBe(true)
  })
})

// --- the Federation page ---
const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const start = APP.indexOf('async function fedApplyToMainAgent()')
const end = APP.indexOf('\n// Re-poll peer reachability', start)
const SNIPPET = APP.slice(start, end)

interface Reply { status: number; body: Record<string, unknown> }
async function click(replies: Reply[], confirms: boolean[]) {
  const calls: Array<{ url: string; body?: string }> = []
  const toasts: string[] = []
  const asked: string[] = []
  const fetch = async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body })
    const r = replies.shift()
    if (!r) throw new Error('unexpected request')
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body }
  }
  const confirm = (m: string) => { asked.push(m); return confirms.shift() ?? false }
  const t = (k: string, p?: { msg?: string }) => (p?.msg ? `${k}:${p.msg}` : k)
  const showToast = (m: string) => { toasts.push(m) }
  const fn = new Function('fetch', 'confirm', 't', 'showToast', `${SNIPPET}\nreturn fedApplyToMainAgent`)(fetch, confirm, t, showToast) as () => Promise<void>
  await fn()
  return { calls, toasts, asked }
}

describe('Federation page apply button', () => {
  it('the snippet is found in web/app.js', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('idle: one request with the plain body, applied toast', async () => {
    const r = await click([{ status: 200, body: { ok: true } }], [true])
    expect(r.calls).toEqual([{ url: '/api/federation/apply', body: '{}' }])
    expect(r.toasts).toEqual(['federation.toast.applied'])
  })

  it.each([['busy', 'agents.confirm.force_restart_busy'], ['no-pane', 'agents.confirm.force_restart_unreadable']])(
    'refused (%s): a second confirm, then a forced request', async (reason, key) => {
      const r = await click([{ status: 409, body: { error: 'restart-blocked', reason } }, { status: 200, body: { ok: true } }], [true, true])
      expect(r.asked).toEqual(['federation.confirm.apply', key])
      expect(r.calls.map((c) => c.body)).toEqual(['{}', JSON.stringify({ force: true })])
      expect(r.toasts).toEqual(['federation.toast.applied'])
    })

  it('refused, second confirm declined: no forced request, nothing-started toast', async () => {
    const r = await click([{ status: 409, body: { error: 'restart-blocked', reason: 'busy' } }], [true, false])
    expect(r.calls).toHaveLength(1)
    expect(r.toasts).toEqual(['agents.toast.restart_not_forced'])
  })

  it('a 409 that is not restart-blocked is an error toast, never a second confirm', async () => {
    const r = await click([{ status: 409, body: { error: 'something else' } }], [true, true])
    expect(r.calls).toHaveLength(1)
    expect(r.asked).toEqual(['federation.confirm.apply'])
    expect(r.toasts).toEqual(['federation.toast.error:something else'])
  })

  it('another error is an error toast, never a force', async () => {
    const r = await click([{ status: 500, body: { error: 'Restart failed' } }], [true, true])
    expect(r.calls).toHaveLength(1)
    expect(r.toasts).toEqual(['federation.toast.error:Restart failed'])
  })
})
