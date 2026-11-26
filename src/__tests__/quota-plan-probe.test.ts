import { describe, it, expect, vi } from 'vitest'
import { nextProbeAt, selectQuotaProbePlans, runQuotaPlanProbes, type QuotaPlanProbeDeps } from '../web/quota-plan-probe.js'
import { planStateSnapshot, snapshotOfPlan, DEFAULT_PLAN_ID } from '../web/quota-notice.js'
import { observationFromProbe } from '../claude-plan-usage-probe.js'
import type { ClaudePlan } from '../web/claude-plans.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

const MIN = 60_000
const NOW = 1_795_700_000_000 // ms
const plan = (id: string, token = true): ClaudePlan => ({
  id, label: id, planType: 'personal', channelsAllowed: true,
  ...(token ? { tokenSecretId: `claude-plan-token-${id}` } : { configDir: `/tmp/${id}` }),
})
const st = (plans: ClaudePlansState['plans'] = {}): ClaudePlansState => ({ activePlanByAgent: {}, plans })

describe('scheduling', () => {
  it('a never-seen plan is due now; then once per interval from its last look', () => {
    expect(nextProbeAt(undefined, 15 * MIN)).toBe(0)
    expect(nextProbeAt({ observedAt: NOW, source: 'probe', windows: {}, lastProbe: { at: NOW, ok: true } }, 15 * MIN)).toBe(NOW + 15 * MIN)
  })
  it('a plan the rotation measured recently is not probed again', () => {
    const fresh = st({ a: { observedAt: NOW - 5 * MIN, source: 'usage-collect', windows: {} } })
    expect(selectQuotaProbePlans({ plans: [plan('a')], state: fresh, nowMs: NOW, intervalMs: 15 * MIN })).toEqual([])
    const old = st({ a: { observedAt: NOW - 20 * MIN, source: 'usage-collect', windows: {} } })
    expect(selectQuotaProbePlans({ plans: [plan('a')], state: old, nowMs: NOW, intervalMs: 15 * MIN }).map((p) => p.id)).toEqual(['a'])
  })
  it('configDir plans are never probed (no token this code may read)', () => {
    expect(selectQuotaProbePlans({ plans: [plan('dir', false)], state: st(), nowMs: NOW, intervalMs: 15 * MIN })).toEqual([])
  })
})

describe('backoff', () => {
  const failed = (error: string) => ({ observedAt: NOW - 60 * MIN, source: 'probe', windows: {}, lastProbe: { at: NOW, ok: false, error } })
  it('429: four intervals; rejected token: a day; other errors: two intervals', () => {
    expect(nextProbeAt(failed('rate_limited'), 15 * MIN)).toBe(NOW + 60 * MIN)
    expect(nextProbeAt(failed('invalid_token'), 15 * MIN)).toBe(NOW + 24 * 60 * MIN)
    expect(nextProbeAt(failed('network'), 15 * MIN)).toBe(NOW + 30 * MIN)
  })
  it('a newer good observation (e.g. the rotation) cancels the backoff', () => {
    const o = { observedAt: NOW + MIN, source: 'usage-collect', windows: {}, lastProbe: { at: NOW, ok: false, error: 'invalid_token' } }
    expect(nextProbeAt(o, 15 * MIN)).toBe(NOW + 16 * MIN)
  })
})

describe('runQuotaPlanProbes', () => {
  function deps(over: Partial<QuotaPlanProbeDeps>): QuotaPlanProbeDeps {
    return {
      enabled: () => true, intervalMs: () => 15 * MIN, now: () => NOW,
      plans: () => [plan('a'), plan('b'), plan('dir', false)],
      readState: () => st(),
      probeAndRecord: vi.fn(async () => ({ ok: true })),
      ...over,
    }
  }
  it('off (both notices off): no call at all', async () => {
    const d = deps({ enabled: () => false })
    expect(await runQuotaPlanProbes(d)).toEqual([])
    expect(d.probeAndRecord).not.toHaveBeenCalled()
  })
  it('on: every due token plan once, configDir skipped', async () => {
    const d = deps({})
    expect(await runQuotaPlanProbes(d)).toEqual(['a', 'b'])
    expect(d.probeAndRecord).toHaveBeenCalledTimes(2)
  })
  it('a failed or throwing probe does not stop the round', async () => {
    const d = deps({ probeAndRecord: vi.fn(async (p: ClaudePlan) => { if (p.id === 'a') throw new Error('x'); return { ok: false, error: 'rate_limited', httpStatus: 429 } }) })
    expect(await runQuotaPlanProbes(d)).toEqual(['b'])
  })
  it('a token missing from the vault is skipped quietly', async () => {
    const d = deps({ probeAndRecord: vi.fn(async () => ({ ok: false, error: 'no_token' })) })
    expect(await runQuotaPlanProbes(d)).toEqual([])
  })
})

describe('freshness merge: what the probe records is what quota-notice reads', () => {
  it('a probe result becomes a fresh per-plan snapshot, a failed one keeps the previous numbers', () => {
    const okResult = { ok: true as const, httpStatus: 200, usage: { fiveHour: { usedPercent: 93, resetsAt: NOW / 1000 + 3600 }, sevenDay: { usedPercent: 40, resetsAt: NOW / 1000 + 86400 } } }
    const obs = observationFromProbe(okResult as never, undefined, NOW)
    const snap = planStateSnapshot(obs, NOW / 1000)
    expect(snap).toMatchObject({ status: 'ok', fiveHour: { usedPercentage: 93 } })
    const failed = observationFromProbe({ ok: false, error: 'network', message: 'x' } as never, obs, NOW + 10 * MIN)
    expect(planStateSnapshot(failed, NOW / 1000 + 600)).toMatchObject({ status: 'ok', fiveHour: { usedPercentage: 93 } })
    expect(planStateSnapshot(failed, NOW / 1000 + 3 * 3600).status).toBe('stale')
    expect(snapshotOfPlan([{ planId: 'ceges', label: 'Céges', snap }], 'ceges').fiveHour?.usedPercentage).toBe(93)
    expect(snapshotOfPlan([{ planId: 'ceges', label: 'Céges', snap }], DEFAULT_PLAN_ID).status).toBe('missing')
  })
})
