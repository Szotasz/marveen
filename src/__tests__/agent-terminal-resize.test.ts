// The dashboard's agent terminal mirrors `tmux capture-pane`, so it can never show more than the pane holds. An agent
// session is detached and runs at the tmux default size (80x24), and the modal showed that small block in its top-left
// corner, the rest of the modal empty. POST /api/agents/:name/pane/size sizes the agent's tmux window to the viewer's
// xterm (cols x rows): `resize-window` through the same invocation as every other terminal call, then the window's
// `window-size` option is unset again (resize-window pins it to manual), so an operator who attaches with
// `tmux attach` later still gets the window sized to their own terminal. The window is never made smaller than 80x24
// (the pane readers judge idle/busy from capture-pane text). Owner-gated like /keys and /login.
//
// node:child_process is mocked: execFile records the tmux argv and succeeds (or fails on demand), spawn answers the
// main session's has-session probe as alive. No tmux runs.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let agentRunning = true
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => agentRunning,
}))
let failTmux = false
const execFileMock = vi.fn((...args: unknown[]) => {
  const cb = args.find((a) => typeof a === 'function') as ((e: Error | null, out?: string, err?: string) => void) | undefined
  if (failTmux) cb?.(new Error('tmux failed (mock)'))
  else cb?.(null, '', '')
  return { stdin: { end() {} } }
})
const spawnMock = vi.fn(() => {
  const child = { on(ev: string, fn: (x?: unknown) => void) { if (ev === 'exit') setTimeout(() => fn(0), 0); return child } }
  return child
})
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
  spawn: (...a: unknown[]) => (spawnMock as (...x: unknown[]) => unknown)(...a),
}))

const { initDatabase } = await import('../db.js')
const { tryHandleAgentTerminal, parseTerminalSize, appliedTerminalSize } = await import('../web/routes/agent-terminal.js')
const { agentDir } = await import('../web/agent-config.js')
const { agentSessionName } = await import('../web/agent-process.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')

const AGENT = '__test-resize-agent'
const DIR = agentDir(AGENT)
const AGENTS_ROOT = join(PROJECT_ROOT, 'agents')
const agentsRootExisted = existsSync(AGENTS_ROOT)

type Auth = { kind: 'token' | 'session'; tokenAgent?: string } | undefined
const OWNER: Auth = { kind: 'session' }
// `auth` is required (no default): an explicit `undefined` (no auth at all) must reach the handler as such.
async function post(name: string, body: unknown, auth: Auth) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = {}
  const path = `/api/agents/${encodeURIComponent(name)}/pane/size`
  ;(req as any).url = path
  ;(req as any).method = 'POST'
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleAgentTerminal({ req, res, path: url.pathname, method: 'POST', url, auth } as any)).toBe(true)
  return { status: out.status || 200, body: out.body }
}
// The tmux argv of every execFile call (the invocation may wrap tmux, e.g. for an agent on its own OS user, so the
// tmux arguments are matched as the tail of the argv).
const tmuxCalls = () => execFileMock.mock.calls.map((c) => c[1] as string[])
const tail = (argv: string[], n: number) => argv.slice(argv.length - n)

beforeAll(() => {
  // The owner-gate refusal reads the dashboard users (its message differs before the first login exists).
  initDatabase(':memory:')
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'CLAUDE.md'), '# resize test\n')
})
beforeEach(() => {
  agentRunning = true
  failTmux = false
  execFileMock.mockClear()
  spawnMock.mockClear()
})
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  if (!agentsRootExisted && existsSync(AGENTS_ROOT) && readdirSync(AGENTS_ROOT).length === 0) rmSync(AGENTS_ROOT, { recursive: true })
})

describe('parseTerminalSize', () => {
  it('accepts integer cols/rows inside the bounds', () => {
    expect(parseTerminalSize({ cols: 180, rows: 48 })).toEqual({ cols: 180, rows: 48 })
    expect(parseTerminalSize({ cols: 20, rows: 5 })).toEqual({ cols: 20, rows: 5 })
    expect(parseTerminalSize({ cols: 500, rows: 200 })).toEqual({ cols: 500, rows: 200 })
  })
  it('refuses anything else', () => {
    for (const bad of [
      null, undefined, 'x', [], {}, { cols: 180 }, { rows: 48 },
      { cols: 19, rows: 48 }, { cols: 501, rows: 48 }, { cols: 180, rows: 4 }, { cols: 180, rows: 201 },
      { cols: 180.5, rows: 48 }, { cols: '180', rows: 48 }, { cols: 180, rows: '48; rm -rf ~' },
      { cols: Number.NaN, rows: 48 }, { cols: Number.POSITIVE_INFINITY, rows: 48 }, { cols: -180, rows: 48 },
    ]) expect(parseTerminalSize(bad), JSON.stringify(bad)).toBeNull()
  })
})

describe('POST /api/agents/:name/pane/size', () => {
  it('resizes a sub-agent window to the requested size, then hands the size back to tmux attach', async () => {
    const r = await post(AGENT, { cols: 180, rows: 48 }, OWNER)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, cols: 180, rows: 48 })
    const calls = tmuxCalls()
    // One tmux process: the resize and the unset of window-size, joined by tmux's own `;` separator.
    expect(calls).toHaveLength(1)
    const target = `=${agentSessionName(AGENT)}:`
    expect(tail(calls[0], 14)).toEqual([
      'resize-window', '-t', target, '-x', '180', '-y', '48',
      ';', 'set-option', '-w', '-u', '-t', target, 'window-size',
    ])
  })

  it('never shrinks the window below the tmux default 80x24 (the pane readers need it)', async () => {
    for (const [req, want] of [
      [{ cols: 45, rows: 20 }, { cols: 80, rows: 24 }],
      [{ cols: 45, rows: 50 }, { cols: 80, rows: 50 }],
      [{ cols: 200, rows: 10 }, { cols: 200, rows: 24 }],
      [{ cols: 200, rows: 50 }, { cols: 200, rows: 50 }],
    ] as const) {
      execFileMock.mockClear()
      const r = await post(AGENT, req, OWNER)
      expect(r.status, JSON.stringify(req)).toBe(200)
      expect(r.body).toEqual({ ok: true, ...want })
      expect(tail(tmuxCalls()[0], 14).slice(3, 7)).toEqual(['-x', String(want.cols), '-y', String(want.rows)])
    }
  })

  it('appliedTerminalSize raises to the floor and keeps anything larger', () => {
    expect(appliedTerminalSize({ cols: 20, rows: 5 })).toEqual({ cols: 80, rows: 24 })
    expect(appliedTerminalSize({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    expect(appliedTerminalSize({ cols: 500, rows: 200 })).toEqual({ cols: 500, rows: 200 })
  })

  it('resizes the main agent session too', async () => {
    const r = await post(MAIN_AGENT_ID, { cols: 120, rows: 30 }, OWNER)
    expect(r.status).toBe(200)
    expect(tail(tmuxCalls()[0], 14).slice(0, 7)).toEqual(['resize-window', '-t', `=${MAIN_CHANNELS_SESSION}:`, '-x', '120', '-y', '30'])
  })

  it('refuses an invalid size without calling tmux', async () => {
    for (const body of [{ cols: 5000, rows: 48 }, { cols: 180, rows: '48' }, { cols: 1.5, rows: 2 }, 'not json']) {
      const r = await post(AGENT, body, OWNER)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('refuses the shared token without the owner session, before any tmux call', async () => {
    for (const auth of [{ kind: 'token' as const }, { kind: 'token' as const, tokenAgent: 'other' }, undefined]) {
      const r = await post(AGENT, { cols: 180, rows: 48 }, auth)
      expect(r.status).toBe(403)
      expect(r.body?.code).toBe('owner_session_required')
    }
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown agent and 400 for a stopped one', async () => {
    expect((await post('__test-resize-missing', { cols: 180, rows: 48 }, OWNER)).status).toBe(404)
    agentRunning = false
    expect((await post(AGENT, { cols: 180, rows: 48 }, OWNER)).status).toBe(400)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('answers 500 when tmux fails', async () => {
    failTmux = true
    const r = await post(AGENT, { cols: 180, rows: 48 }, OWNER)
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('resize failed')
  })
})
