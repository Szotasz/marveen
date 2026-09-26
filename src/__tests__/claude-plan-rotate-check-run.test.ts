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
vi.mock('../settings-store.js', () => ({
  // MAIN_AGENT_CONFIG_DIR is a string setting whose real default is ''; every
  // other key here is a boolean defaulting to '0'.
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? (k === 'MAIN_AGENT_CONFIG_DIR' ? '' : '0'),
}))
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
let usageCollectCalls = 0
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    usageCollectCalls++
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

beforeEach(() => {
  probeMock.mockReset()
  probeMock.mockImplementation(async () => ({ ok: false as const, error: 'network' as const, message: 'mocked' }))
  usageCollectCalls = 0
  settings.clear()
  state = { activePlanByAgent: { marveen: 'a' }, plans: {} }
  // Near a limit by default, so the gating tests below isolate their own rule.
  usageJson = activeUsage(IDLE_PROBE_GATE.fiveHourPercent)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('runRotateCheck -> idle-plan probe wiring', () => {
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

  it('flag off: no idle probe, even with 2+ plans, rotation on and the active plan near its limit', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '0')
    settings.set('CLAUDE_ROTATION_ENABLED', '1')
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    probeReturns({ a: ROTATION_GATE.switchAtPercent })
    await runRotateCheck()
    // The active plan's own reading is not an idle probe; b must stay untouched.
    expect(probeMock).not.toHaveBeenCalledWith('token-for-claude-plan-token-b')
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
    rotationOn()
    plans = [tokenPlan('a'), tokenPlan('b'), tokenPlan('c')]
    // Stale knowledge says b is the emptier plan; the live probe says b is
    // exhausted and c is nearly empty. Only a probe that ran BEFORE the
    // decision can make it pick c.
    state = {
      activePlanByAgent: { marveen: 'a' },
      plans: { b: fiveHourObs(5), c: fiveHourObs(60) },
    } as ClaudePlansState
    const order: string[] = []
    probeReturns({ a: ROTATION_GATE.switchAtPercent + 5, b: 100, c: 3 }, order)
    const logs = captureLogs(order)
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledTimes(3)
    expect(order.slice(0, 3).every((o) => o.startsWith('probe:'))).toBe(true)
    expect(logs.some((l) => l.startsWith('ROTATE ') && l.includes('target=c '))).toBe(true)
  })

  it('the Settings description names the thresholds IDLE_PROBE_GATE actually uses, and defaults on', () => {
    const def = getSettingDefinition('CLAUDE_PLAN_USAGE_REFRESH')!
    expect(def.default).toBe('1')
    expect(def.description).toContain(`${IDLE_PROBE_GATE.fiveHourPercent}%`)
    expect(def.description).toContain(`${IDLE_PROBE_GATE.sevenDayPercent}%`)
  })
})

const nowS = () => Math.floor(Date.now() / 1000)
function fiveHourObs(pct: number) {
  return { observedAt: 0, source: 'probe', windows: { five_hour: { usedPercent: pct, resetsAt: nowS() + 3600 } } }
}
function configDirPlan(id: string): ClaudePlan {
  return { id, label: id, configDir: `/opt/claude-${id}`, planType: 'personal', channelsAllowed: true }
}
function rotationOn(): void {
  settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
  settings.set('CLAUDE_ROTATION_ENABLED', '1')
  settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
}
/** Probe answers per plan id (5h used %, 100 = rejected). */
function probeReturns(pctByPlan: Record<string, number>, order?: string[]): void {
  probeMock.mockImplementation(async (token: string) => {
    order?.push(`probe:${token}`)
    const id = token.replace('token-for-claude-plan-token-', '')
    const pct = pctByPlan[id] ?? 0
    return {
      ok: true,
      httpStatus: 200,
      usage: {
        fiveHour: { usedPercent: pct, resetsAt: nowS() + 3 * 3600, status: pct >= 100 ? 'rejected' : 'allowed' },
        sevenDay: null,
        overallStatus: null,
        representativeClaim: null,
      },
    } as never
  })
}
function captureLogs(order?: string[]): string[] {
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); order?.push('decision') })
  return logs
}

// Measured live 2026-09-26: usage-collect.py reads the HOST login, not the
// active token plan's account, and the heartbeat decided on the wrong numbers.
describe('runRotateCheck -> the active plan is read from the right account', () => {
  it('active token plan: its own probe says 5h exhausted, usage-collect says 0% -> ROTATE', async () => {
    rotationOn()
    plans = [tokenPlan('a'), tokenPlan('b')]
    probeReturns({ a: 100, b: 0 })
    usageJson = activeUsage(0, 0)
    const logs = captureLogs()
    await runRotateCheck()
    expect(logs.some((l) => l.startsWith('ROTATE ') && l.includes('target=b '))).toBe(true)
    expect(usageCollectCalls).toBe(0)
    expect(probeMock).toHaveBeenCalledWith('token-for-claude-plan-token-a')
  })

  it('mirror: probe says 0%, usage-collect says 100% -> quiet', async () => {
    rotationOn()
    plans = [tokenPlan('a'), tokenPlan('b')]
    probeReturns({ a: 0, b: 0 })
    usageJson = activeUsage(100, 100)
    const logs = captureLogs()
    await runRotateCheck()
    expect(logs).toEqual([])
    expect(usageCollectCalls).toBe(0)
    // Recorded as the active plan's observation.
    expect(state.plans.a?.windows.five_hour?.usedPercent).toBe(0)
  })

  it('a failed active probe stays silent; it never falls back to usage-collect', async () => {
    rotationOn()
    plans = [tokenPlan('a'), tokenPlan('b')]
    usageJson = activeUsage(100, 100)
    const logs = captureLogs()
    await runRotateCheck()
    expect(logs).toEqual([])
    expect(usageCollectCalls).toBe(0)
    expect(state.plans.a?.lastProbe).toMatchObject({ ok: false, error: 'network' })
  })

  it('the active plan is probed every tick, even right after a probe (idle throttles do not apply)', async () => {
    rotationOn()
    plans = [tokenPlan('a'), tokenPlan('b')]
    state = {
      activePlanByAgent: { marveen: 'a' },
      plans: { a: { ...fiveHourObs(10), lastProbe: { at: Date.now(), ok: true } } },
    } as ClaudePlansState
    probeReturns({ a: 10 })
    await runRotateCheck()
    expect(probeMock).toHaveBeenCalledWith('token-for-claude-plan-token-a')
  })

  it('configDir-mode active plan: usage-collect is the input, the active plan is not probed', async () => {
    rotationOn()
    plans = [configDirPlan('a'), tokenPlan('b')]
    probeReturns({ b: 0 })
    usageJson = activeUsage(100)
    const logs = captureLogs()
    await runRotateCheck()
    expect(usageCollectCalls).toBe(1)
    expect(logs.some((l) => l.startsWith('ROTATE ') && l.includes('target=b '))).toBe(true)
    expect(probeMock).not.toHaveBeenCalledWith('token-for-claude-plan-token-a')
  })

  it('main agent not isolated: the recorded token plan is not in effect, usage-collect is read', async () => {
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', '1')
    plans = [tokenPlan('a'), tokenPlan('b')]
    usageJson = activeUsage(10)
    await runRotateCheck()
    expect(usageCollectCalls).toBe(1)
    expect(probeMock).not.toHaveBeenCalled()
  })
})
