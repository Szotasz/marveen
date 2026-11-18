// PLANROTATEDEADLOCK1115 P5, Dani N1: a wave in which EVERY plan answers a header-less 429. The C-rule calls a
// header-less 429 exhausted on the second tick in a row, so without a guard the main agent is switched A -> B after
// two ticks and back two ticks later: one main restart every two ticks for the whole wave. With the lastRotationAt
// guard it is switched at most once per MAIN_ROTATION_MIN_GAP_MS.
//
// The whole backend chain is real: the tick (runRotationTick), the decision (rotateCheckOnce, with the P4 rule) and
// the rotation (rotatePlan, which records lastRotationAt and refuses too soon). Mocked: the probe (always a
// header-less 429), the vault, the settings, the plan registry, the side-car (in memory), the main-agent restart and
// the owner signal. No network, no tmux, no agent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? (k === 'MAIN_AGENT_CONFIG_DIR' ? '' : '0'),
}))
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => `token-for-${id}` }))
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: () => plans,
  subAgentTokenPlanIds: () => new Set<string>(),
}))
vi.mock('../web/claude-plans-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/claude-plans-state.js')>()
  return {
    ...actual,
    readClaudePlansState: () => state,
    writeClaudePlansState: (next: ClaudePlansState) => { state = next },
  }
})
const probeMock = vi.fn(async (_token: string) => ({ ok: false as const, error: 'rate_limited' as const, message: 'm', httpStatus: 429, retryAfterSec: 30 }))
vi.mock('../claude-plan-usage-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-plan-usage-probe.js')>()
  return { ...actual, probePlanUsage: (token: string) => probeMock(token) }
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: () => { throw new Error('usage-collect mocked out') },
}))
const restarts: number[] = []
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => { restarts.push(Date.now()); return { ok: true } },
  restartMainForRotationContinue: async () => ({ ok: true, mode: 'continue' }),
}))

const { rotateCheckOnce } = await import('../claude-plan-rotate-check-run.js')
const { rotatePlan } = await import('../web/routes/claude-plans.js')
const { runRotationTick } = await import('../web/claude-rotation-backend.js')
const { MAIN_ROTATION_MIN_GAP_MS } = await import('../web/claude-rotation-lock.js')

const T0 = Date.UTC(2026, 10, 18, 8, 0, 0)
const TICK_MS = 10 * 60_000

function tokenPlan(id: string): ClaudePlan {
  return { id, label: `Plan ${id.toUpperCase()}`, tokenSecretId: `claude-plan-token-${id}`, planType: 'personal', channelsAllowed: true }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  restarts.length = 0
  settings.clear()
  settings.set('CLAUDE_ROTATION_ENABLED', '1')
  settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
  plans = [tokenPlan('a'), tokenPlan('b')]
  state = { activePlanByAgent: { marveen: 'a' }, plans: {} }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers() })

/** Runs the wave for `ticks` ticks; `unguarded` pushes lastRotationAt back before each tick (the C-rule's own pace). */
async function wave(ticks: number, unguarded = false) {
  const signals: string[] = []
  const deps = {
    check: () => rotateCheckOnce(),
    rotate: (i: { agentId: string; targetPlanId: string; continue: boolean }) => rotatePlan(i),
    notify: async (text: string) => { signals.push(text); return true },
    readState: () => state,
    writeState: (s: ClaudePlansState) => { state = s },
    planLabel: (id: string) => plans.find((p) => p.id === id)?.label ?? id,
    rotationOn: () => true,
    now: () => Date.now(),
    lang: () => 'en' as const,
  }
  const refused: number[] = []
  for (let i = 1; i <= ticks; i++) {
    vi.setSystemTime(T0 + i * TICK_MS)
    if (unguarded && state.backend?.lastRotationAt !== undefined) state = { ...state, backend: { ...state.backend, lastRotationAt: 0 } }
    const s = await runRotationTick(deps)
    if (s.refused.length) refused.push(i)
  }
  const gaps = restarts.slice(1).map((t, i) => t - restarts[i])
  return { signals, refused, gaps }
}

// Measured on this chain (2026-11-18, 18 ticks, retry-after 30 s): 4 plans with the idle refresh off flip every two
// ticks for the whole wave (Dani N1 as stated); with the idle refresh on (the default) the candidate is already
// marked, so the switch after a switch comes ONE tick later. 2 plans flip once an hour (the synthesized exhaustion
// lasts an hour), so the guard does not bite there.
describe.each([
  ['4 plans, idle refresh off (Dani N1: every two ticks)', 4, '0'],
  ['4 plans, idle refresh on (the default: one tick apart)', 4, '1'],
  ['3 plans, idle refresh on', 3, '1'],
])('N1: an all-plan header-less 429 wave, %s (P5)', (_label, n, refresh) => {
  beforeEach(() => {
    plans = ['a', 'b', 'c', 'd'].slice(0, n).map(tokenPlan)
    settings.set('CLAUDE_PLAN_USAGE_REFRESH', refresh)
  })

  it('control: without the guard the chain restarts the main agent less than MAIN_ROTATION_MIN_GAP_MS apart', async () => {
    const { gaps } = await wave(18, true)
    expect(restarts.length).toBeGreaterThanOrEqual(4)
    expect(Math.min(...gaps)).toBeLessThan(MAIN_ROTATION_MIN_GAP_MS)
  })

  it('with the guard: at most one main switch per MAIN_ROTATION_MIN_GAP_MS, a refused switch is neither signalled nor failed', async () => {
    const { signals, refused, gaps } = await wave(18)
    expect(restarts.length).toBeGreaterThanOrEqual(2)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(MAIN_ROTATION_MIN_GAP_MS)
    expect(refused.length).toBeGreaterThan(0)
    expect(signals.filter((t) => t.startsWith('Claude plan switch')).length).toBe(restarts.length)
    expect(signals.some((t) => t.includes('FAILED'))).toBe(false)
    expect(state.backend?.lastRotationAt).toBe(restarts[restarts.length - 1])
  })
})
