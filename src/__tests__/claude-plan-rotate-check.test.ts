// PR2c: decideAndRecord (src/claude-plan-rotate-heartbeat.ts), the pure core
// that scripts/claude-plan-rotate-check.ts's heartbeat wrapper calls (design
// 6.3 + 6.6), tested end to end with fixture inputs -- no fs, no
// child_process, no settings-store. Mirrors quota-gate-wiring.test.ts's
// spirit: the collector's on-disk JSON shape in, a decision out.
import { describe, it, expect } from 'vitest'
import { decideAndRecord } from '../claude-plan-rotate-heartbeat.js'
import type { ClaudePlan } from '../web/claude-plans.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0)
const NOW_S = NOW / 1000

function plan(over: Partial<ClaudePlan> = {}): ClaudePlan {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '/opt/claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

function usageCollect(overrides: Partial<{ source: string; usedPercent: number; resetsAt: number }> = {}) {
  const { source = 'authoritative', usedPercent = 10, resetsAt = NOW_S + 3600 } = overrides
  return {
    generated_at: new Date(NOW).toISOString(),
    claude: {
      provider: 'claude',
      source,
      ok: true,
      windows: {
        five_hour: { used_percent: usedPercent, resets_at: resetsAt },
        seven_day: { used_percent: 20, resets_at: resetsAt + 6 * 24 * 3600 },
      },
    },
  }
}

const EMPTY_STATE: ClaudePlansState = { activePlanByAgent: {}, plans: {} }

describe('decideAndRecord: preconditions (design 6.2)', () => {
  it('no-ops with fewer than 2 registered plans', () => {
    const result = decideAndRecord({
      agentId: 'marveen',
      plans: [plan()],
      state: EMPTY_STATE,
      usageCollectRaw: usageCollect(),
      nowMs: NOW,
    })
    expect(result).toEqual({ printLine: null, nextState: null })
  })

  it('no-ops when the agent has no active plan recorded yet (bootstrap gap)', () => {
    const result = decideAndRecord({
      agentId: 'marveen',
      plans: [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' })],
      state: EMPTY_STATE,
      usageCollectRaw: usageCollect(),
      nowMs: NOW,
    })
    expect(result).toEqual({ printLine: null, nextState: null })
  })

  it('no-ops when the recorded active plan id no longer resolves (deleted/renamed)', () => {
    const state: ClaudePlansState = { activePlanByAgent: { marveen: 'gone' }, plans: {} }
    const result = decideAndRecord({
      agentId: 'marveen',
      plans: [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' })],
      state,
      usageCollectRaw: usageCollect(),
      nowMs: NOW,
    })
    expect(result).toEqual({ printLine: null, nextState: null })
  })
})

describe('decideAndRecord: snapshot trust (fail open, mirrors quota-gate.ts)', () => {
  const twoPlansState: ClaudePlansState = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
  const plans = [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' })]

  it('no-ops on an untrusted source (estimate)', () => {
    const result = decideAndRecord({
      agentId: 'marveen', plans, state: twoPlansState,
      usageCollectRaw: usageCollect({ source: 'estimate', usedPercent: 99 }),
      nowMs: NOW,
    })
    expect(result).toEqual({ printLine: null, nextState: null })
  })

  it('no-ops on a snapshot with no claude section at all', () => {
    const result = decideAndRecord({
      agentId: 'marveen', plans, state: twoPlansState,
      usageCollectRaw: { generated_at: new Date(NOW).toISOString() },
      nowMs: NOW,
    })
    expect(result).toEqual({ printLine: null, nextState: null })
  })
})

describe('decideAndRecord: quiet ticks still record telemetry', () => {
  it('records the observation but prints nothing when under pressure', () => {
    const state: ClaudePlansState = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const plans = [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 42 }),
      nowMs: NOW,
    })
    expect(result.printLine).toBeNull()
    expect(result.nextState).not.toBeNull()
    expect(result.nextState?.activePlanByAgent.marveen).toBe('pro')
    expect(result.nextState?.plans.pro.windows.five_hour.usedPercent).toBe(42)
    expect(result.nextState?.plans.pro.windows.seven_day?.usedPercent).toBe(20)
  })

  it('records telemetry but prints nothing when near reset', () => {
    const state: ClaudePlansState = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const plans = [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 95, resetsAt: NOW_S + 10 * 60 }),
      nowMs: NOW,
    })
    expect(result.printLine).toBeNull()
    expect(result.nextState).not.toBeNull()
  })
})

describe('decideAndRecord: rotate and no-alternative print exactly one structured line', () => {
  it('prints a ROTATE line naming the target and current labels/pct', () => {
    const state: ClaudePlansState = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const plans = [plan({ id: 'pro', label: 'Personal PRO' }), plan({ id: 'team', label: 'Team Seat' })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 95, resetsAt: NOW_S + 3600 }),
      nowMs: NOW,
    })
    expect(result.printLine).toBe(
      'ROTATE agent=marveen target=team targetLabel=Team Seat currentLabel=Personal PRO currentPct=95 resetsInMin=60',
    )
    expect(result.nextState?.activePlanByAgent.marveen).toBe('pro') // rotation itself is applied by the caller, not here
  })

  it('excludes a plan with channelsAllowed=false from candidacy', () => {
    const state: ClaudePlansState = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const plans = [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team', channelsAllowed: false })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 95, resetsAt: NOW_S + 3600 }),
      nowMs: NOW,
    })
    expect(result.printLine).toContain('NO_ALTERNATIVE')
  })

  it('prints a NO_ALTERNATIVE line when the only other plan is not channels-eligible', () => {
    const state: ClaudePlansState = {
      activePlanByAgent: { marveen: 'pro' },
      plans: { team: { observedAt: NOW - 1000, source: 'authoritative', windows: { five_hour: { usedPercent: 96, resetsAt: NOW_S + 100 } } } },
    }
    const plans = [plan({ id: 'pro', label: 'Personal PRO' }), plan({ id: 'team', label: 'Team Seat', channelsAllowed: false })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 95, resetsAt: NOW_S + 3600 }),
      nowMs: NOW,
    })
    expect(result.printLine).toBe('NO_ALTERNATIVE agent=marveen currentLabel=Personal PRO currentPct=95 resetsInMin=60')
  })

  it('picks the plan with the most estimated free headroom among several candidates', () => {
    const state: ClaudePlansState = {
      activePlanByAgent: { marveen: 'pro' },
      plans: {
        team: { observedAt: NOW - 1000, source: 'authoritative', windows: { five_hour: { usedPercent: 80, resetsAt: NOW_S + 100 } } },
        third: { observedAt: NOW - 1000, source: 'authoritative', windows: { five_hour: { usedPercent: 10, resetsAt: NOW_S + 100 } } },
      },
    }
    const plans = [plan({ id: 'pro' }), plan({ id: 'team', label: 'Team' }), plan({ id: 'third', label: 'Third' })]
    const result = decideAndRecord({
      agentId: 'marveen', plans, state,
      usageCollectRaw: usageCollect({ usedPercent: 95, resetsAt: NOW_S + 3600 }),
      nowMs: NOW,
    })
    expect(result.printLine).toContain('target=third')
  })
})
