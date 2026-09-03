import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmuxInvocationFor, tmuxNeedsIndirection } from '../web/agent-process.js'

// Why these tests exist (two live failures on this install, 2026-08-26 22:15 and
// 2026-08-27 22:0x): buildTmuxInvocation was already correct and already covered
// by ssh-tmux.test.ts. The bug was that ONE module -- the dashboard terminal --
// held its own copy of the child-process plumbing and called the raw `tmux`
// binary. For an agent running under its own OS user that call cannot reach the
// pane (tmux refuses a cross-user connection), so the live terminal rendered
// blank and POST /api/agents/<name>/keys answered 500. The operator could not
// clear a permission prompt from the dashboard while two agents sat blocked.
//
// So a green buildTmuxInvocation proves nothing on its own: what has to be
// guarded is that the CALL SITES go through it.

describe('tmuxInvocationFor', () => {
  it('an agent with its own OS user is reached via sudo -n -u, args untouched', () => {
    const inv = tmuxInvocationFor(['send-keys', '-t', 'agent-x', '-l', '--', '1'], { host: null, runAsUser: 'agent-x' })
    expect(inv.file).toBe('sudo')
    expect(inv.args.slice(0, 3)).toEqual(['-n', '-u', 'agent-x'])
    expect(inv.args.slice(-6)).toEqual(['send-keys', '-t', 'agent-x', '-l', '--', '1'])
  })

  it('KNOWN GOOD -- a session belonging to no per-user agent still runs the plain local binary', () => {
    // Must keep passing: the default for every agent today is the router's own
    // user, and this is the path that was never broken. A fix that routed
    // EVERYTHING through sudo would pass the test above and break the install.
    const inv = tmuxInvocationFor(['capture-pane', '-t', 'agent-no-such-session-guard', '-p'])
    expect(inv.file).not.toBe('sudo')
    expect(inv.args).toEqual(['capture-pane', '-t', 'agent-no-such-session-guard', '-p'])
  })

  it('a remote host wins: ssh already logs in as someone', () => {
    const inv = tmuxInvocationFor(['has-session', '-t', 'agent-y'], { host: 'laptop', runAsUser: 'agent-y' })
    expect(inv.file).toBe('ssh')
  })

  it('tmuxNeedsIndirection separates the two cases', () => {
    expect(tmuxNeedsIndirection(['has-session', '-t', 'agent-z'], { host: null, runAsUser: 'agent-z' })).toBe(true)
    expect(tmuxNeedsIndirection(['has-session', '-t', 'agent-no-such-session-guard'])).toBe(false)
  })
})

// Modules that still resolve the tmux binary themselves instead of going through
// tmuxInvocationFor. This list is a MEASUREMENT (2026-08-28 07:0x), not an
// approval -- two entries are provably fine and the rest are unaudited:
//
//   background-tasks.ts  FINE: it creates and owns its own `bgtask-*` sessions on
//                        the router's own tmux server; there is no other user.
//   onboarding.ts        FINE: `show-environment -g` against the router's own server.
//
//   agent-worker.ts, channel-monitor.ts, channel-mcp-reconnect.ts,
//   channel-plugin-unlock.ts, stuck-tool-call-watcher.ts, reauth-healer.ts
//                        UNAUDITED: these send keys to / capture from a session
//                        name that can be an agent's, so each needs the same
//                        check agent-terminal.ts just got. Tracked on the board;
//                        not fixed here because that is six live code paths, one
//                        of which starts agents.
//
// The guard is a SUBSET assertion on purpose: fixing one of these keeps the test
// green, while a NEW module growing its own tmux plumbing fails it. An assertion
// on the exact set would go red on a legitimate fix, and a guard that fails on
// legitimate change is one somebody eventually deletes.
const KNOWN_OWN_TMUX = new Set([
  'background-tasks.ts',
  'onboarding.ts',
])

describe('the dashboard terminal does not keep its own tmux plumbing', () => {
  const routesDir = new URL('../web/routes/', import.meta.url).pathname
  const RAW = /resolveFromPath\(\s*['"]tmux['"]\s*\)/

  function rawTmuxRoutes(): string[] {
    return readdirSync(routesDir)
      .filter(f => f.endsWith('.ts'))
      .filter(f => RAW.test(readFileSync(join(routesDir, f), 'utf-8')))
  }

  it('agent-terminal.ts reaches tmux only through the shared resolver', () => {
    // The event this must fail on: someone restores the raw binary call here, or
    // adds a new tmux call to this file without the resolution. That is not
    // hypothetical -- it is exactly how this file was written, and it stayed
    // wrong because every test in the repo tested the builder, not the caller.
    const src = readFileSync(join(routesDir, 'agent-terminal.ts'), 'utf-8')
    expect(RAW.test(src)).toBe(false)
    expect(src).toContain('tmuxInvocationFor')
  })

  it('no NEW route module grows its own tmux binary lookup', () => {
    const unexpected = rawTmuxRoutes().filter(f => !KNOWN_OWN_TMUX.has(f))
    expect(unexpected).toEqual([])
  })

  it('the guard can actually fail (the pattern matches a real offender line)', () => {
    // Without this, the two assertions above would also pass on an empty
    // directory or a failed read -- a check that cannot fail is not a check.
    expect(RAW.test(`const TMUX = resolveFromPath('tmux')`)).toBe(true)
    expect(rawTmuxRoutes().length).toBeGreaterThan(0)
  })
})
