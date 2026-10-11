import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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

// --- wiring: the route is the thin I/O shell around buildInputStateRows ---
const ROOT = join(__dirname, '..', '..')
const ROUTES = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
const PROC = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

describe('GET /api/agents/input-state wiring', () => {
  const start = ROUTES.indexOf("if (path === '/api/agents/input-state' && method === 'GET')")
  const body = ROUTES.slice(start, ROUTES.indexOf('\n    return true\n  }', start))
  it('uses buildInputStateRows over the agent list, the coloured capture, and the remote cache', () => {
    expect(start).toBeGreaterThan(0)
    expect(body).toMatch(/buildInputStateRows\(/)
    expect(body).toMatch(/agents: withoutMainAgent\(listAgentNames\(\)\)/)
    expect(body).toMatch(/captureInputBoxViews\(session, host\)/)
    expect(body).toMatch(/remoteInputViewCache\.getOrRefresh/)
  })
})

describe('captureInputBoxViews: one COLOUR capture, two views', () => {
  const s = PROC.indexOf('export function captureInputBoxViews')
  const fn = PROC.slice(s, PROC.indexOf('\n}', s))
  it('captures with -e (colour) and derives ghostless + withGhost from the SAME capture, banner cut first', () => {
    expect(s).toBeGreaterThan(0)
    expect(fn).toMatch(/'capture-pane', '-t', exactTmuxTarget\(session\), '-e', '-p'/)
    expect(fn).toMatch(/ghostless: stripGhostSuggestion\(raw\), withGhost: stripAllAnsi\(raw\)/)
    expect(fn).toMatch(/const raw = stripSessionTitleBanner\(captureTmux\(/)
    expect((fn.match(/captureTmux\(/g) || []).length).toBe(1)
  })
})

describe('the sweep\'s agentRunState(name) === \'running\' is EXACTLY isAgentRunning(name) (local path unchanged)', () => {
  it('isAgentRunning is defined as agentRunState(name) === \'running\'', () => {
    const s = PROC.indexOf('export function isAgentRunning(name: string): boolean {')
    expect(s).toBeGreaterThan(0)
    expect(PROC.slice(s, PROC.indexOf('\n}', s))).toMatch(/return agentRunState\(name\) === 'running'/)
  })
})
