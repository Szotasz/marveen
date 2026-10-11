import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { buildInputStateRows, type InputStateDeps, type InputViews } from '../web/input-state.js'

// GET /api/agents/input-state: the after-restart check must see EVERY agent
// (main + local + remote, from the agent list), read each pane IN COLOUR (a
// colour-less capture shows a ghost suggestion as an unsent prompt), and report
// only the LENGTH of a parked text, never the text.

const SEP = '\x1b[38;5;244m' + '─'.repeat(80)
const FOOTER = '\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m'
const pane = (box: string) => ['● Done.', '', '\x1b[38;5;174m✻\x1b[39m \x1b[38;5;246mWorked for 23s\x1b[39m', SEP, box, SEP, FOOTER].join('\n')
const views = (coloured: string): InputViews => ({
  ghostless: coloured.replace(/\x1b\[2m[^\x1b]*/g, '').replace(/\x1b\[[0-9;]*m/g, ''),
  withGhost: coloured.replace(/\x1b\[[0-9;]*m/g, ''),
})
const SECRET = 'TEAM MEMBER NOTICE -- parked secret-looking payload 12345'

function deps(over: Partial<InputStateDeps> = {}): InputStateDeps & { captured: Array<[string, string | null]> } {
  const captured: Array<[string, string | null]> = []
  const panes: Record<string, InputViews> = {
    'main-channels': views(pane('❯\xa0')),
    'agent-loc': views(pane('❯\xa0' + SECRET)),
    'agent-rem': views(pane('❯\xa0\x1b[2mreview the remaining cards\x1b[0m')),
  }
  return {
    captured,
    mainAgentId: 'main',
    mainSession: 'main-channels',
    agents: ['loc', 'rem', 'off', 'gone'],
    remoteHostOf: (n) => (n === 'rem' || n === 'gone' ? 'u@laptop' : null),
    runStateOf: (n) => (n === 'off' ? 'stopped' : n === 'gone' ? 'unreachable' : 'running'),
    sessionOf: (n) => `agent-${n}`,
    capture: (s, h) => { captured.push([s, h]); return panes[s] ?? null },
    sessionExists: () => true,
    ...over,
  }
}

describe('buildInputStateRows (the endpoint contract, behaviour)', () => {
  it('every agent from the list + main, ghost-aware states, run states', () => {
    const rows = buildInputStateRows(deps())
    expect(rows.map(r => [r.name, r.run, r.input])).toEqual([
      ['main', 'running', 'empty'],
      ['loc', 'running', 'parked'],
      ['rem', 'running', 'ghost'],
      ['off', 'stopped', null],
      ['gone', 'unreachable', null],
    ])
  })

  it('NEVER returns the parked text; each row has exactly name,isMain,host,run,input,chars', () => {
    const rows = buildInputStateRows(deps())
    expect(JSON.stringify(rows)).not.toContain('parked secret-looking payload')
    expect(JSON.stringify(rows)).not.toContain('review the remaining')
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['chars', 'host', 'input', 'isMain', 'name', 'run'])
    expect(rows.find(r => r.name === 'loc')!.chars).toBe(SECRET.length)
  })

  it("a running agent whose capture fails is 'unreadable', never 'empty'", () => {
    const rows = buildInputStateRows(deps({ capture: (s) => (s === 'main-channels' ? views(pane('❯\xa0')) : null) }))
    expect(rows.find(r => r.name === 'loc')!.input).toBe('unreadable')
  })

  it("a RUNNING main session whose capture fails is 'running'/'unreadable', not 'stopped'", () => {
    const rows = buildInputStateRows(deps({ capture: () => null, sessionExists: () => true }))
    expect(rows[0]).toMatchObject({ name: 'main', run: 'running', input: 'unreadable' })
    const gone = buildInputStateRows(deps({ capture: () => null, sessionExists: () => false }))
    expect(gone[0]).toMatchObject({ run: 'stopped', input: null })
  })

  it('remote agents are captured WITH their host, local ones without; stopped/unreachable are not captured', () => {
    const d = deps()
    buildInputStateRows(d)
    expect(d.captured).toEqual([['main-channels', null], ['agent-loc', null], ['agent-rem', 'u@laptop']])
  })
})

// --- the REAL route handler and the REAL agent-process over a mocked tmux/ssh ---
// execFileSync is the one I/O seam: `tmux list-sessions` / `tmux capture-pane`
// locally, or the same wrapped in `ssh <host> '<tmux ...>'` for a remote agent.
const T = vi.hoisted(() => ({
  calls: [] as Array<{ host: string | null; cmd: string }>,
  localList: 'main-channels\nagent-loc\n' as string | { status: number },
  panes: {} as Record<string, string>,
}))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((file: string, args: string[] = []) => {
    const host = file === 'ssh' ? args[args.length - 2] : null
    const cmd = file === 'ssh' ? args[args.length - 1] : args.join(' ')
    if (!/list-sessions|capture-pane/.test(cmd)) return ''
    T.calls.push({ host, cmd })
    if (host === 'u@gone-host') throw Object.assign(new Error('ssh: connect timed out'), { status: 255 })
    if (cmd.includes('list-sessions')) {
      if (host === 'u@laptop') return 'agent-rem\n'
      if (typeof T.localList !== 'string') throw Object.assign(new Error('no server running'), T.localList)
      return T.localList
    }
    const session = Object.keys(T.panes).find(sn => cmd.includes(sn))
    if (session == null) throw Object.assign(new Error("can't find session"), { status: 1 })
    return T.panes[session]
  }),
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig() as object),
  listAgentNames: () => ['main', 'loc', 'rem', 'off', 'gone'],
  readAgentRemoteHost: (n: string) => (n === 'rem' ? 'u@laptop' : n === 'gone' ? 'u@gone-host' : null),
  readAgentRunAsUser: () => null,
}))
vi.mock('../config.js', async (orig) => ({ ...(await orig() as object), MAIN_AGENT_ID: 'main' }))
vi.mock('../web/ssh-tmux.js', async (orig) => ({ ...(await orig() as object), ensureControlDir: () => {} }))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentRunState, isAgentRunning } = await import('../web/agent-process.js')
type RouteContext = import('../web/routes/types.js').RouteContext

async function getInputState(): Promise<{ status: number; rows: Array<Record<string, unknown>>; raw: string }> {
  const out = { status: 0, raw: '' }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) out.raw = String(chunk) },
  }
  const url = new URL('http://localhost:3420/api/agents/input-state')
  const ctx = { req: { headers: {} } as RouteContext['req'], res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  expect(await tryHandleAgents(ctx, join(__dirname, '..', '..', 'web'))).toBe(true)
  return { status: out.status, rows: JSON.parse(out.raw) as Array<Record<string, unknown>>, raw: out.raw }
}

describe('GET /api/agents/input-state through the real route handler', () => {
  let clock = Date.now()
  beforeEach(() => {
    // the remote caches are module-level with a real-clock TTL: each case starts past every TTL
    clock += 60_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(clock)
    T.calls.length = 0
    T.localList = 'main-channels\nagent-loc\n'
    T.panes = {
      'main-channels': pane('❯\xa0'),
      'agent-loc': pane('❯\xa0' + SECRET),
      'agent-rem': pane('❯\xa0\x1b[2mreview the remaining cards\x1b[0m'),
    }
  })

  afterEach(() => { vi.useRealTimers() })

  it('every agent from the agent list (main once), run states, ghost-aware input, the parked TEXT never in the body', async () => {
    const { status, rows, raw } = await getInputState()
    expect(status).toBe(200)
    expect(rows.map(r => [r.name, r.isMain, r.host, r.run, r.input])).toEqual([
      ['main', true, null, 'running', 'empty'],
      ['loc', false, null, 'running', 'parked'],
      ['rem', false, 'u@laptop', 'running', 'ghost'],     // a colour-less capture would have read this as parked
      ['off', false, null, 'stopped', null],
      ['gone', false, 'u@gone-host', 'unreachable', null],
    ])
    expect(rows.find(r => r.name === 'loc')!.chars).toBe(SECRET.length)
    expect(raw).not.toContain('parked secret-looking payload')
    expect(raw).not.toContain('review the remaining')
  })

  it('every pane is captured IN COLOUR (-e), the remote one over ssh to ITS host; stopped/unreachable agents are never captured', async () => {
    await getInputState()
    const caps = T.calls.filter(c => c.cmd.includes('capture-pane'))
    expect(caps.every(c => /(^| |')-e( |'|$)/.test(c.cmd))).toBe(true)
    expect(caps.map(c => [c.host, ['main-channels', 'agent-loc', 'agent-rem'].find(sn => c.cmd.includes(sn))])).toEqual([
      [null, 'main-channels'], [null, 'agent-loc'], ['u@laptop', 'agent-rem'],
    ])
  })

  it('a burst of requests does not re-capture the remote pane over ssh (short-TTL cache); local panes are read fresh', async () => {
    await getInputState()
    await getInputState()
    const caps = T.calls.filter(c => c.cmd.includes('capture-pane'))
    expect(caps.filter(c => c.host === 'u@laptop').length).toBe(1)
    expect(caps.filter(c => c.host === null).length).toBe(4)
  })

  it('a /rename title banner pinned to the bottom is cut before classifying (else a busy pane reads unknown)', async () => {
    // the 2026-08-01 shape (session-title-banner.test.ts): a busy line, then a wrapped banner below it
    const banner = Array.from({ length: 8 }, (_, i) => `\x1b[38;5;16m\x1b[48;5;37m renamed session name wrap line ${i} \x1b[39m\x1b[49m`)
    T.panes['agent-loc'] = ['✻ Working… (· esc to interrupt)', ...banner].join('\n')
    const { rows } = await getInputState()
    expect(rows.find(r => r.name === 'loc')).toMatchObject({ run: 'running', input: 'busy' })
  })

  it("a RUNNING main whose capture fails is 'running'/'unreadable'; a missing main session is 'stopped'", async () => {
    delete T.panes['main-channels']
    let { rows } = await getInputState()
    expect(rows[0]).toMatchObject({ name: 'main', run: 'running', input: 'unreadable' })
    T.localList = 'agent-loc\n'
    ;({ rows } = await getInputState())
    expect(rows[0]).toMatchObject({ name: 'main', run: 'stopped', input: null })
  })
})

describe("a LOCAL agent: the sweep's agentRunState(name) === 'running' decides exactly as isAgentRunning(name)", () => {
  const cases: Array<[string, string | { status: number }, string]> = [
    ['session listed', 'main-channels\nagent-loc\n', 'running'],
    ['session not listed', 'main-channels\n', 'stopped'],
    ['no tmux server (exit 1)', { status: 1 }, 'stopped'],
    ['tmux killed / exit 255 (local: still stopped, never unreachable)', { status: 255 }, 'stopped'],
  ]
  for (const [what, list, want] of cases) {
    it(what, () => {
      T.localList = list
      expect(agentRunState('loc')).toBe(want)
      expect(isAgentRunning('loc')).toBe(want === 'running')
    })
  }
})
