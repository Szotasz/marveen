// QUOTAHDRROT1118: the last-resort header reading (#2839) must not stand in for
// the active plan under plan rotation. usage-collect.py hands the entry the
// host's default login token; with rotation in effect (MAIN_AGENT_ISOLATED_CONFIG=1,
// no MAIN_AGENT_CONFIG_DIR, 2+ plans: the same gate as the rotation heartbeat's
// activeTokenPlan) that is not necessarily the account the main agent spends,
// so the entry makes no call and gives no reading. Off rotation (a single-account
// install, the #2833 case) the probe runs as before. Settings, the plan registry
// and the probe's network call are mocked; the rotation gate and the probe's
// header parser stay real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClaudePlan } from '../web/claude-plans.js'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? (k === 'MAIN_AGENT_CONFIG_DIR' ? '' : '0'),
}))
let plans: ClaudePlan[] = []
let plansThrow = false
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: () => { if (plansThrow) throw new Error('plans unreadable'); return plans },
  subAgentTokenPlanIds: () => new Set<string>(),
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
}))
vi.mock('../web/vault.js', () => ({ getSecret: (id: string) => `token-for-${id}` }))
vi.mock('../web/claude-plans-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/claude-plans-state.js')>()),
  readClaudePlansState: () => ({ activePlanByAgent: { marveen: 'a' }, plans: {} }),
  writeClaudePlansState: () => {},
}))

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0)
const nowS = Math.floor(NOW / 1000)
const probeMock = vi.fn(async (_token: string, _opts?: unknown) => ({
  ok: true as const, httpStatus: 200,
  usage: { fiveHour: { usedPercent: 35, resetsAt: nowS + 3600, status: 'allowed' }, sevenDay: null, overallStatus: 'allowed', representativeClaim: null },
}))
vi.mock('../claude-plan-usage-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-plan-usage-probe.js')>()),
  probePlanUsage: (token: string, opts?: unknown) => probeMock(token, opts),
}))

const { readRateLimits, ROTATION_SKIP_REASON, PLANS_UNREADABLE_REASON } = await import('../claude-ratelimit-reading.js')
const { activeTokenPlan } = await import('../claude-plan-rotate-check-run.js')

const plan = (id: string): ClaudePlan => ({ id, label: id, tokenSecretId: `S-${id}`, channelsAllowed: true } as unknown as ClaudePlan)
const reading = { ok: true, windows: { five_hour: { used_percent: 35, resets_at: nowS + 3600, status: 'allowed' } } }

beforeEach(() => {
  settings.clear()
  plans = []
  plansThrow = false
  probeMock.mockClear()
})

describe('readRateLimits under plan rotation (QUOTAHDRROT1118)', () => {
  it('rotation in effect (isolated, 2 plans): no call, no reading, a fixed reason', async () => {
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [plan('a'), plan('b')]
    expect(await readRateLimits('host-token', () => NOW)).toEqual({ ok: false, reason: ROTATION_SKIP_REASON })
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('single-account install (not isolated, one plan or none): the probe runs and its reading is returned', async () => {
    expect(await readRateLimits('host-token', () => NOW)).toEqual(reading)
    plans = [plan('a')]
    expect(await readRateLimits('host-token', () => NOW)).toEqual(reading)
    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(probeMock.mock.calls[0][0]).toBe('host-token')
  })

  it('isolated with one plan, or 2 plans without isolation: no rotation, the probe runs', async () => {
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    plans = [plan('a')]
    expect(await readRateLimits('host-token', () => NOW)).toEqual(reading)
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '0')
    plans = [plan('a'), plan('b')]
    expect(await readRateLimits('host-token', () => NOW)).toEqual(reading)
    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('an explicit MAIN_AGENT_CONFIG_DIR wins over rotation at launch, so the gate reads it as off (as activeTokenPlan does)', async () => {
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    settings.set('MAIN_AGENT_CONFIG_DIR', '/some/dir')
    plans = [plan('a'), plan('b')]
    expect(await readRateLimits('host-token', () => NOW)).toEqual(reading)
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('an unreadable plan registry counts as "rotation may be in effect": no call, a fixed reason (Samu, #2879)', async () => {
    plansThrow = true
    expect(await readRateLimits('host-token', () => NOW)).toEqual({ ok: false, reason: PLANS_UNREADABLE_REASON })
    // Even with isolation off: without the registry the gate cannot tell, so it does not spend the host login.
    settings.set('MAIN_AGENT_ISOLATED_CONFIG', '1')
    expect(await readRateLimits('host-token', () => NOW)).toEqual({ ok: false, reason: PLANS_UNREADABLE_REASON })
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('no token: no call (unchanged)', async () => {
    expect(await readRateLimits('', () => NOW)).toEqual({ ok: false, reason: 'no token in CLAUDE_RATELIMIT_TOKEN' })
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('the header reading and the rotation heartbeat agree on when rotation is in effect', async () => {
    // Plan 'a' is recorded as the main agent's active plan (state mock below), so activeTokenPlan answers
    // exactly with the shared gate.
    const cases: Array<[string, string, ClaudePlan[]]> = [
      ['1', '', [plan('a'), plan('b')]],
      ['1', '', [plan('a')]],
      ['0', '', [plan('a'), plan('b')]],
      ['1', '/x', [plan('a'), plan('b')]],
    ]
    const seen: boolean[] = []
    for (const [iso, dir, p] of cases) {
      settings.clear()
      settings.set('MAIN_AGENT_ISOLATED_CONFIG', iso)
      if (dir) settings.set('MAIN_AGENT_CONFIG_DIR', dir)
      plans = p
      const skipped = (await readRateLimits('t', () => NOW)).ok === false
      expect(skipped).toBe(activeTokenPlan(p) !== null)
      seen.push(skipped)
    }
    expect(seen).toEqual([true, false, false, false])
  })
})
