// Wiring of runRotateCheck() (the body of scripts/claude-plan-rotate-check.ts):
// does the heartbeat actually call the idle-plan probe, only when allowed
// (CLAUDE_PLAN_USAGE_REFRESH=1), only with 2+ plans, and only while the active
// plan is near a limit (IDLE_PROBE_GATE) -- and then BEFORE the decision? The probe itself, the
// vault, settings, the state side-car and usage-collect.py are all mocked --
// no network, no fs, no child process. selectPlansToProbe stays real, so the
// "2+ plans" rule is the production one, not a test double.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClaudePlan } from '../web/claude-plans.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

let plans: ClaudePlan[] = []
let state: ClaudePlansState = { activePlanByAgent: {}, plans: {} }
const settings = new Map<string, string>()

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
}))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings.get(k) ?? '0' }))
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => `token-for-${id}` }))
vi.mock('../web/claude-plans.js', () => ({ readClaudePlans: () => plans }))
vi.mock('../web/claude-plans-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/claude-plans-state.js')>()
  return {
    ...actual,
    readClaudePlansState: () => state,
    writeClaudePlansState: (next: ClaudePlansState) => { state = next },
  }
})

const probeMock = vi.fn(async (_token: string) => ({ ok: false as const, error: 'network' as const, message: 'mocked' }))
vi.mock('../claude-plan-usage-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-plan-usage-probe.js')>()
  return { ...actual, probePlanUsage: (token: string) => probeMock(token) }
})

// usage-collect.py: returns `usageJson` (the active plan's windows) or throws
// when it is null.
let usageJson: string | null = null
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (usageJson === null) throw new Error('usage-collect mocked out')
    return usageJson
  },
}))
function activeUsage(fivePct: number, sevenPct?: number): string {
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600
  return JSON.stringify({
    generated_at: new Date().toISOString(),
    claude: {
      source: 'authoritative',
      windows: {
        five_hour: { used_percent: fivePct, resets_at: resetsAt },
        ...(sevenPct !== undefined ? { seven_day: { used_percent: sevenPct, resets_at: resetsAt + 3 * 86400 } } : {}),
      },
    },
  })
}

const { runRotateCheck } = await import('../claude-plan-rotate-check-run.js')
const { IDLE_PROBE_GATE, ROTATION_GATE } = await import('../claude-plan-rotation.js')
const { getSettingDefinition } = await import('../config-registry.js')

function tokenPlan(id: string): ClaudePlan {
  return { id, label: id, tokenSecretId: `claude-plan-token-${id}`, planType: 'personal', channelsAllowed: true }
}

describe('runRotateCheck -> idle-plan probe wiring', () => {
  beforeEach(() => {
    probeMock.mockClear()
    settings.clear()
    state = { activePlanByAgent: { marveen: 'a' }, plans: {} }
    // Near a limit by default, so the gating tests below isolate their own rule.
    usageJson = activeUsage(IDLE_PROBE_GATE.fiveHourPercent)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('opted in, 2+ plans: probes the idle token plan (never the active one)', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(probeMock).toHaveBeenCalledWith('token-for-claude-plan-token-b')
    // ...and the outcome is recorded against that plan.
    expect(state.plans.b?.lastProbe).toMatchObject({ ok: false, error: 'network' })
  })

  it('opted in, a single plan: no probe at all', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a')]
    state = { activePlanByAgent: {}, plans: {} }
    await runRotateCheck()
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('default (flag unset): no probe, even with 2+ plans and rotation on', async () => {
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    await runRotateCheck()
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('opted in without rotation: probes anyway (the Settings bars use case)', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    settings.set('CLAUDE_ROTATION_ENABLED', '0')
    plans = [tokenPlan('a'), tokenPlan('b')]
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('active plan healthy: zero probes', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a'), tokenPlan('b'), tokenPlan('c')]
    usageJson = activeUsage(IDLE_PROBE_GATE.fiveHourPercent - 1, IDLE_PROBE_GATE.sevenDayPercent - 1)
    await runRotateCheck()
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('active plan near the weekly limit only: probes', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    usageJson = activeUsage(10, IDLE_PROBE_GATE.sevenDayPercent)
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('usage-collect failed: no probe (not knowing is no reason to spend quota)', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    usageJson = null
    await runRotateCheck()
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('active plan near the limit: idle plans probed BEFORE the decision, which ranks on the fresh numbers', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [tokenPlan('a'), tokenPlan('b'), tokenPlan('c')]
    // Stale knowledge says b is the emptier plan; the live probe says b is
    // exhausted and c is nearly empty. Only a probe that ran BEFORE the
    // decision can make it pick c.
    const nowS = Math.floor(Date.now() / 1000)
    state = {
      activePlanByAgent: { marveen: 'a' },
      plans: {
        b: { observedAt: 0, source: 'probe', windows: { five_hour: { usedPercent: 5, resetsAt: nowS + 3600 } } },
        c: { observedAt: 0, source: 'probe', windows: { five_hour: { usedPercent: 60, resetsAt: nowS + 3600 } } },
      },
    } as ClaudePlansState
    const order: string[] = []
    probeMock.mockImplementation(async (token: string) => {
      order.push(`probe:${token}`)
      const pct = token.endsWith('-b') ? 100 : 3
      return {
        ok: true,
        httpStatus: 200,
        usage: {
          fiveHour: { usedPercent: pct, resetsAt: nowS + 3600, status: pct >= 100 ? 'rejected' : 'allowed' },
          sevenDay: null,
          overallStatus: null,
          representativeClaim: null,
        },
      } as never
    })
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); order.push('decision') })
    usageJson = activeUsage(ROTATION_GATE.switchAtPercent + 5)
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(order.slice(0, 2).every((o) => o.startsWith('probe:'))).toBe(true)
    expect(logs.some((l) => l.startsWith('ROTATE ') && l.includes('target=c '))).toBe(true)
    probeMock.mockReset()
    probeMock.mockImplementation(async () => ({ ok: false as const, error: 'network' as const, message: 'mocked' }))
  })

  it('the Settings description names the thresholds IDLE_PROBE_GATE actually uses, and defaults on', () => {
    const def = getSettingDefinition('CLAUDE_PLAN_USAGE_REFRESH')!
    expect(def.default).toBe('1')
    expect(def.description).toContain(`${IDLE_PROBE_GATE.fiveHourPercent}%`)
    expect(def.description).toContain(`${IDLE_PROBE_GATE.sevenDayPercent}%`)
  })
})
