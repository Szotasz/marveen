import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  localSubAgentStuckTargets, pruneSubAgentStuckState,
  type SubAgentStuckScopeDeps, type SubAgentAlertSpell,
} from '../web/channel-monitor.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { StuckInputState } from '../pane-state.js'

// Q046 (owner decision 2026-10-14): the Q045 overdue-guard and auto-clear must
// cover every local sub-agent, not only the ones with their own channel. Before
// this, the loop rode the channel targets list, and on this install that meant
// gembaecho alone out of six running sub-agents.

const FLEET = ['gembaecho', 'leanarchivist', 'leandev', 'leanlibrarian', 'leanpublisher', 'leanscout', 'leanwriter']

function scope(over: Partial<SubAgentStuckScopeDeps> = {}): SubAgentStuckScopeDeps {
  return {
    names: () => [MAIN_AGENT_ID, ...FLEET],
    running: () => true,
    remoteHost: () => null,
    session: (n) => `agent-${n}`,
    ...over,
  }
}

describe('localSubAgentStuckTargets', () => {
  it('covers every running local sub-agent, channel or not', () => {
    expect(localSubAgentStuckTargets(scope())).toEqual(FLEET.map((n) => ({ session: `agent-${n}`, agentName: n })))
  })

  it('never includes the main agent (it has its own recovery and respawn backstop)', () => {
    const names = localSubAgentStuckTargets(scope()).map((t) => t.agentName)
    expect(names).not.toContain(MAIN_AGENT_ID)
  })

  it('skips a stopped agent', () => {
    const names = localSubAgentStuckTargets(scope({ running: (n) => n !== 'leanscout' })).map((t) => t.agentName)
    expect(names).not.toContain('leanscout')
    expect(names).toHaveLength(FLEET.length - 1)
  })

  it('skips a remote-host agent: no local pane to archive and clear', () => {
    const names = localSubAgentStuckTargets(scope({ remoteHost: (n) => (n === 'leanwriter' ? 'box.example' : null) })).map((t) => t.agentName)
    expect(names).not.toContain('leanwriter')
    expect(names).toHaveLength(FLEET.length - 1)
  })

  it('takes the session name from the resolver, not from a hardcoded prefix', () => {
    const [first] = localSubAgentStuckTargets(scope({ names: () => ['gembaecho'], session: (n) => `x-${n}` }))
    expect(first).toEqual({ session: 'x-gembaecho', agentName: 'gembaecho' })
  })
})

describe('pruneSubAgentStuckState', () => {
  const st: StuckInputState = { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 2, attempts: 3 }
  const spell: SubAgentAlertSpell = { sig: 'sig', count: 2, deferNotified: false }

  it('drops every map entry of a session that left scope and keeps the live ones', () => {
    const states = new Map([['agent-a', st], ['agent-gone', st]])
    const alertedAt = new Map([['agent-a', 10], ['agent-gone', 20]])
    const spells = new Map([['agent-a', spell], ['agent-gone', spell]])
    pruneSubAgentStuckState(new Set(['agent-a']), { states, alertedAt, spells })
    expect([...states.keys()]).toEqual(['agent-a'])
    expect([...alertedAt.keys()]).toEqual(['agent-a'])
    expect([...spells.keys()]).toEqual(['agent-a'])
  })

  it('an empty scope empties all three maps', () => {
    const states = new Map([['agent-a', st]])
    const alertedAt = new Map([['agent-a', 10]])
    const spells = new Map([['agent-a', spell]])
    pruneSubAgentStuckState(new Set(), { states, alertedAt, spells })
    expect(states.size + alertedAt.size + spells.size).toBe(0)
  })
})

describe('wiring: the sweep runs the guard on the local scope, not on the channel targets', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const start = src.indexOf('maybeRestartWedgedMainChannel(mainStuckInput)')
  const block = src.slice(start, src.indexOf('for (const t of targets)', start))

  it('builds the scope, prunes with it, and recovers + ticks every entry', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toMatch(/const stuckScope = localSubAgentStuckTargets\(\)/)
    expect(block).toMatch(/pruneSubAgentStuckState\(new Set\(stuckScope\.map\(\(t\) => t\.session\)\)\)/)
    expect(block).toMatch(/for \(const t of stuckScope\)/)
    expect(block).toMatch(/recoverStuckInputForSession\(t\.session,/)
    expect(block).toMatch(/handleSubAgentStuckTick\(t\.session, t\.agentName, next\)/)
  })

  it('the per-session recovery is no longer inside a loop over the channel targets', () => {
    const loops = [...src.matchAll(/for \(const t of targets\) \{([\s\S]*?)\n    \}/g)].map((m) => m[1])
    expect(loops.length).toBeGreaterThan(0)
    for (const body of loops) expect(body).not.toMatch(/handleSubAgentStuckTick|recoverStuckInputForSession/)
  })
})
