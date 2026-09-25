// Wiring of runRotateCheck() (the body of scripts/claude-plan-rotate-check.ts):
// does the heartbeat actually call the idle-plan probe, only when opted in
// (CLAUDE_PLAN_USAGE_REFRESH=1), and only with 2+ plans? The probe itself, the
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

// usage-collect.py: fail, so runRotateCheck returns right after the probe
// pass and the fleet report -- the rotation decision is not under test here.
vi.mock('node:child_process', () => ({ execFileSync: () => { throw new Error('usage-collect mocked out') } }))

const { runRotateCheck } = await import('../claude-plan-rotate-check-run.js')

function tokenPlan(id: string): ClaudePlan {
  return { id, label: id, tokenSecretId: `claude-plan-token-${id}`, planType: 'personal', channelsAllowed: true }
}

describe('runRotateCheck -> idle-plan probe wiring', () => {
  beforeEach(() => {
    probeMock.mockClear()
    settings.clear()
    state = { activePlanByAgent: { marveen: 'a' }, plans: {} }
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
})
