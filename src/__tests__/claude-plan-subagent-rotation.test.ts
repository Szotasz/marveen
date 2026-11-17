// SUBPLANTOKEN1110 2nd PR: the per sub-agent stage of the rotation heartbeat (claude-plan-subagent-rotation.ts),
// with every IO injected: who is managed, the thinned measurement, the shared decision with its reserved plans,
// the busy-pane deferral and its cap, the once-per-window NO_ALTERNATIVE, and the line names.
import { describe, it, expect } from 'vitest'
import {
  runSubAgentRotation, managedSubAgents, reusesLastReading, windowSpent, paneIdle,
  SUBAGENT_QUIET_PROBE_MS, SUBAGENT_MAX_DEFERRALS, type SubAgentRotationDeps,
} from '../claude-plan-subagent-rotation.js'
import { ROTATION_GATE } from '../claude-plan-rotation.js'
import type { ClaudePlan } from '../web/claude-plans.js'
import { setSubAgentRecord, type ClaudePlansState } from '../web/claude-plans-state.js'
import type { ProbeResult } from '../claude-plan-usage-probe.js'

const NOW = Date.UTC(2026, 10, 10, 21, 0, 0)
const resets = Math.floor(NOW / 1000) + 3 * 3600

function tokenPlan(id: string): ClaudePlan {
  return { id, label: `L-${id}`, tokenSecretId: `claude-plan-token-${id}`, planType: 'personal', channelsAllowed: true }
}
function dirPlan(id: string): ClaudePlan {
  return { id, label: id, configDir: `/opt/${id}`, planType: 'team', channelsAllowed: true }
}
// A probe answer with the 5h window at `pct` (the parsed PlanUsage the real probe returns).
function probeAt(pct: number, sevenPct?: number): ProbeResult {
  return {
    ok: true,
    httpStatus: 200,
    usage: {
      fiveHour: { usedPercent: pct, resetsAt: resets, status: pct >= 100 ? 'rejected' : 'allowed' },
      sevenDay: sevenPct === undefined ? null : { usedPercent: sevenPct, resetsAt: resets + 3 * 86400, status: 'allowed' },
      overallStatus: null,
      representativeClaim: null,
    },
  } as unknown as ProbeResult
}

interface World {
  agents: Record<string, { plan: string | null; remote?: boolean; running?: boolean }>
  pct: Record<string, number> // plan id -> 5h % the probe answers
  busy?: Record<string, boolean>
  tokens?: Record<string, string | null>
}
function deps(w: World, log: { probes: string[]; samples: string[]; warns: string[] }): SubAgentRotationDeps {
  return {
    listAgents: () => Object.keys(w.agents),
    planOf: (n) => w.agents[n]?.plan ?? null,
    isRemote: (n) => !!w.agents[n]?.remote,
    isRunning: (n) => w.agents[n]?.running !== false,
    readToken: (sid) => (w.tokens && sid in w.tokens ? w.tokens[sid] : `tok:${sid}`),
    probe: async (token) => {
      const planId = token.replace('tok:claude-plan-token-', '')
      log.probes.push(planId)
      return probeAt(w.pct[planId] ?? 10)
    },
    paneIdleSamples: async (n) => { log.samples.push(n); return w.busy?.[n] ? [true, false, true] : [true, true, true] },
    warn: (l) => { log.warns.push(l) },
  }
}
const emptyLog = () => ({ probes: [] as string[], samples: [] as string[], warns: [] as string[] })
const baseState = (over: Partial<ClaudePlansState> = {}): ClaudePlansState => ({ activePlanByAgent: { marveen: 'm' }, plans: {}, ...over })

describe('pure rules', () => {
  it('the busy rule is the manual-restart gate\'s: every sample idle', () => {
    expect(paneIdle([true, true, true])).toBe(true)
    expect(paneIdle([true, false, true])).toBe(false)
    expect(paneIdle([true, null, true])).toBe(false) // unreadable = not idle
    expect(paneIdle([])).toBe(false)
  })
  it('a spent window (100%, not yet reset) switches without waiting', () => {
    expect(windowSpent({ source: 'probe', fiveHour: { usedPercent: 100, resetsAt: resets } }, NOW)).toBe(true)
    expect(windowSpent({ source: 'probe', fiveHour: { usedPercent: 95, resetsAt: resets } }, NOW)).toBe(false)
    expect(windowSpent({ source: 'probe', fiveHour: { usedPercent: 100, resetsAt: Math.floor(NOW / 1000) - 1 } }, NOW)).toBe(false)
  })
  it('the last reading is reused only when it is a probe, fresh, and below the idle gate', () => {
    const obs = (pct: number, ageMs: number, source = 'probe') => ({ observedAt: NOW - ageMs, source, windows: { five_hour: { usedPercent: pct, resetsAt: resets } } })
    expect(reusesLastReading(obs(50, 60_000), NOW)).toBe(true)
    expect(reusesLastReading(obs(50, SUBAGENT_QUIET_PROBE_MS), NOW)).toBe(false)
    expect(reusesLastReading(obs(85, 60_000), NOW)).toBe(false)
    expect(reusesLastReading(obs(50, 60_000, 'usage-collect'), NOW)).toBe(false)
    expect(reusesLastReading(undefined, NOW)).toBe(false)
  })
})

describe('who is managed', () => {
  it('local, running sub-agents on a TOKEN plan only, in name order; never the main agent', () => {
    const plans = [tokenPlan('a'), tokenPlan('b'), dirPlan('team'), tokenPlan('m')]
    const w: World = { agents: {
      marveen: { plan: 'm' }, zara: { plan: 'b' }, iris: { plan: 'a' }, devy: { plan: 'team' },
      far: { plan: 'a', remote: true }, off: { plan: 'b', running: false }, none: { plan: null }, ghost: { plan: 'gone' },
    }, pct: {} }
    expect(managedSubAgents(plans, 'marveen', deps(w, emptyLog())).map((x) => x.name)).toEqual(['iris', 'zara'])
  })
})

describe('runSubAgentRotation', () => {
  const plans = [tokenPlan('m'), tokenPlan('a'), tokenPlan('b'), tokenPlan('c')]

  it('a calm agent with a fresh, below-gate reading is not probed and prints nothing', async () => {
    const log = emptyLog()
    const state = baseState({ plans: { a: { observedAt: NOW - 60_000, source: 'probe', windows: { five_hour: { usedPercent: 40, resetsAt: resets } } } } })
    const r = await runSubAgentRotation({ plans, state, mainAgentId: 'marveen', nowMs: NOW, deps: deps({ agents: { iris: { plan: 'a' } }, pct: {} }, log) })
    expect(log.probes).toEqual([])
    expect(r.lines).toEqual([])
  })

  it('over the shared threshold: SUBAGENT_ROTATE, never onto the main plan, another sub-agent\'s plan or its own', async () => {
    const log = emptyLog()
    const w: World = { agents: { marveen: { plan: null }, iris: { plan: 'a' }, zara: { plan: 'b' } }, pct: { a: ROTATION_GATE.switchAtPercent + 3, b: 10, c: 50, m: 1 } }
    const r = await runSubAgentRotation({ plans, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, log) })
    const line = r.lines.find((l) => l.includes('agent=iris'))
    expect(line).toMatch(/^SUBAGENT_ROTATE agent=iris target=c /)
    expect(r.lines.every((l) => !l.startsWith('ROTATE '))).toBe(true)
  })

  it('two agents due in one tick never get the same target', async () => {
    const plans5 = [tokenPlan('m'), tokenPlan('a'), tokenPlan('b'), tokenPlan('c'), tokenPlan('d')]
    const w: World = { agents: { iris: { plan: 'a' }, zara: { plan: 'b' } }, pct: { a: 95, b: 95, c: 5, d: 30, m: 1 } }
    const r = await runSubAgentRotation({ plans: plans5, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, emptyLog()) })
    const targets = r.lines.map((l) => /target=(\S+)/.exec(l)?.[1])
    expect(targets).toHaveLength(2)
    expect(new Set(targets).size).toBe(2)
  })

  it('a busy pane defers the switch, at most SUBAGENT_MAX_DEFERRALS ticks, then it goes anyway', async () => {
    const w: World = { agents: { iris: { plan: 'a' } }, pct: { a: 93, c: 5 }, busy: { iris: true } }
    let state = baseState()
    for (let i = 1; i <= SUBAGENT_MAX_DEFERRALS; i++) {
      const r = await runSubAgentRotation({ plans, state, mainAgentId: 'marveen', nowMs: NOW + i, deps: deps(w, emptyLog()) })
      expect(r.lines).toEqual([])
      expect(r.state.subAgents?.iris?.deferrals).toBe(i)
      state = r.state
    }
    const last = await runSubAgentRotation({ plans, state, mainAgentId: 'marveen', nowMs: NOW + 10, deps: deps(w, emptyLog()) })
    expect(last.lines[0]).toMatch(/^SUBAGENT_ROTATE agent=iris /)
    expect(last.state.subAgents?.iris).toBeUndefined()
  })

  it('a spent window switches at once, without even sampling the pane', async () => {
    const log = emptyLog()
    const w: World = { agents: { iris: { plan: 'a' } }, pct: { a: 100, c: 5 }, busy: { iris: true } }
    const r = await runSubAgentRotation({ plans, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, log) })
    expect(r.lines[0]).toMatch(/^SUBAGENT_ROTATE agent=iris /)
    expect(log.samples).toEqual([])
  })

  it('NO_ALTERNATIVE is printed once per window, again in a new window', async () => {
    const two = [tokenPlan('m'), tokenPlan('a')] // nothing to switch to: m is the main agent's
    const w: World = { agents: { iris: { plan: 'a' } }, pct: { a: 95 } }
    const first = await runSubAgentRotation({ plans: two, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, emptyLog()) })
    expect(first.lines[0]).toMatch(/^SUBAGENT_NO_ALTERNATIVE agent=iris /)
    const again = await runSubAgentRotation({ plans: two, state: first.state, mainAgentId: 'marveen', nowMs: NOW + 600_000, deps: deps(w, emptyLog()) })
    expect(again.lines).toEqual([])
    const moved = { ...first.state, subAgents: { iris: { deferrals: 0, notice: 'other-window' } } }
    const next = await runSubAgentRotation({ plans: two, state: moved, mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, emptyLog()) })
    expect(next.lines[0]).toMatch(/^SUBAGENT_NO_ALTERNATIVE /)
  })

  it('a missing token: no probe, no line, a diagnostic that names the plan only', async () => {
    const log = emptyLog()
    const w: World = { agents: { iris: { plan: 'a' } }, pct: { a: 99 }, tokens: { 'claude-plan-token-a': null } }
    const r = await runSubAgentRotation({ plans, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, log) })
    expect(r.lines).toEqual([])
    expect(log.probes).toEqual([])
    expect(log.warns.join()).toContain('plan=a: token missing from vault')
  })

  it('fewer than 2 plans: nothing at all', async () => {
    const log = emptyLog()
    const r = await runSubAgentRotation({ plans: [tokenPlan('a')], state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps({ agents: { iris: { plan: 'a' } }, pct: { a: 99 } }, log) })
    expect(r.lines).toEqual([]); expect(log.probes).toEqual([])
  })
})

describe('setSubAgentRecord (the state side-car)', () => {
  it('sets, replaces and clears one agent\'s bookkeeping; an empty record removes it; the last removal drops the key', () => {
    let s: ClaudePlansState = { activePlanByAgent: { marveen: 'm' }, plans: {} }
    s = setSubAgentRecord(s, 'iris', { deferrals: 1 })
    s = setSubAgentRecord(s, 'zara', { deferrals: 0, notice: '5h:1:-' })
    expect(s.subAgents).toEqual({ iris: { deferrals: 1 }, zara: { deferrals: 0, notice: '5h:1:-' } })
    s = setSubAgentRecord(s, 'iris', { deferrals: 0 })
    expect(s.subAgents).toEqual({ zara: { deferrals: 0, notice: '5h:1:-' } })
    s = setSubAgentRecord(s, 'zara', null)
    expect('subAgents' in s).toBe(false)
    expect(s.activePlanByAgent).toEqual({ marveen: 'm' })
  })
})

describe('a directory name that is not a valid agent name never reaches a line (Dani 75608 (1))', () => {
  const plans = [tokenPlan('m'), tokenPlan('a'), tokenPlan('b'), tokenPlan('c')]
  it.each([
    'iris"}\nJSON\nrm -rf x',
    'iris targetPlanId',
    '../iris',
    '-iris',
    'x'.repeat(51),
  ])('%j is skipped with a diagnostic, not managed, not printed', async (bad) => {
    const log = emptyLog()
    const w: World = { agents: { [bad]: { plan: 'a' }, zara: { plan: 'b' } }, pct: { a: 99, b: 99, c: 1, m: 1 } }
    expect(managedSubAgents(plans, 'marveen', deps(w, log)).map((x) => x.name)).toEqual(['zara'])
    const r = await runSubAgentRotation({ plans, state: baseState(), mainAgentId: 'marveen', nowMs: NOW, deps: deps(w, emptyLog()) })
    expect(r.lines.every((l) => !l.includes(bad))).toBe(true)
    expect(r.lines.some((l) => l.includes('agent=zara'))).toBe(true)
    expect(log.warns.join()).toContain('not a valid agent name')
  })
  it('a valid name with a dot, a dash and an underscore stays managed', () => {
    const w: World = { agents: { 'qa.bot-2_x': { plan: 'a' } }, pct: {} }
    expect(managedSubAgents(plans, 'marveen', deps(w, emptyLog())).map((x) => x.name)).toEqual(['qa.bot-2_x'])
  })
})
