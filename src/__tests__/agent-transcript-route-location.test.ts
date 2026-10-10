// TRANSCRIPTLOC1006: the transcript route must read where the session WRITES.
//
// The route used to take its config root from resolveAgentConfigDir(), which
// answers only what an operator CONFIGURED. The launcher writes elsewhere when
// nothing is configured (a sub-agent's auto-provisioned
// agents/<name>/.claude-config) and the main agent may run on an isolated or
// MAIN_AGENT_CONFIG_DIR root. On an install where those roots diverge from
// ~/.claude, the route would hand an operator an OLD session's log as the live
// one -- the same blind spot configDirFor() was written to close for the
// watchdogs. On the owner's host every root is a symlink to ~/.claude/projects,
// which is why nothing there ever showed it.
//
// What is pinned here is the BINDING: the route passes configDirFor(name)
// through to the reader, for the main agent and for a sub-agent, with the
// working directory the session runs in. The reader itself and both gates are
// covered elsewhere; here they are stubbed so the only thing measured is which
// location reaches readAgentTranscript.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ISOLATED_ROOT = '/isolated/config-root-that-is-not-home'
const SUB_AGENT = 'transcriptloc-sub'

const seen: { name: string; opts: Record<string, unknown> }[] = []
const configDirCalls: string[] = []

vi.mock('../web/agent-transcript.js', () => ({
  isTranscriptAllowed: () => true,
  readAgentTranscript: (name: string, opts: Record<string, unknown>) => {
    seen.push({ name, opts })
    return { events: [] }
  },
}))

vi.mock('../web/main-transcript-root.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/main-transcript-root.js')>()
  return {
    ...actual,
    configDirFor: (name: string) => { configDirCalls.push(name); return `${ISOLATED_ROOT}/${name}` },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // The route 404s a sub-agent whose agents/<name> dir is missing; this test
  // must not depend on what sits in agents/ on the machine running it.
  const existsSync = ((p: unknown) =>
    (typeof p === 'string' && p.endsWith(`/agents/${SUB_AGENT}`)) || actual.existsSync(p as string)
  ) as typeof actual.existsSync
  return { ...actual, existsSync, default: { ...actual, existsSync } }
})

const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { join } = await import('node:path')
type RouteContext = import('../web/routes/types.js').RouteContext

function fakeCtx(path: string): { ctx: RouteContext; out: { status: number } } {
  const out = { status: 0 }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  const auth: RouteContext['auth'] = { kind: 'session', user: 'owner' }
  return { ctx: { req: {} as RouteContext['req'], res, path: url.pathname, method: 'GET', url, auth } as RouteContext, out }
}

const WEB_DIR = join(PROJECT_ROOT, 'web')

beforeEach(() => { seen.length = 0; configDirCalls.length = 0 })

describe('transcript route: reads where the session writes', () => {
  it('main agent: PROJECT_ROOT as working dir, configDirFor() as config root', async () => {
    const { ctx, out } = fakeCtx(`/api/agents/${MAIN_AGENT_ID}/transcript`)
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(200)
    expect(configDirCalls).toEqual([MAIN_AGENT_ID])
    expect(seen).toHaveLength(1)
    expect(seen[0].opts.workingDir).toBe(PROJECT_ROOT)
    expect(seen[0].opts.configDir).toBe(`${ISOLATED_ROOT}/${MAIN_AGENT_ID}`)
  })

  it('sub-agent: its own agents/<name> dir, and its configDirFor() root', async () => {
    const { ctx, out } = fakeCtx(`/api/agents/${SUB_AGENT}/transcript`)
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(200)
    expect(configDirCalls).toEqual([SUB_AGENT])
    expect(seen).toHaveLength(1)
    expect(seen[0].opts.workingDir).toBe(join(PROJECT_ROOT, 'agents', SUB_AGENT))
    expect(seen[0].opts.configDir).toBe(`${ISOLATED_ROOT}/${SUB_AGENT}`)
  })
})
