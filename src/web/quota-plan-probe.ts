// QUOTANOTICE1126 per-plan probe: fresh 5-hour / weekly numbers for every NAMED subscription, so the quota notice and
// the auto-reply can judge an agent by the plan it really runs on.
//
// Why: a named plan's numbers live in store/claude-plans-state.json, and only the plan rotation refreshes them (the
// active plan every heartbeat, idle plans only near a limit). Without rotation a named plan had no numbers at all, and
// its agents could only be judged by their pane banner (owner decision 2026-11-26: "Legyen plan-enkénti lekérdezés is").
//
// How: the rotation's own live probe, unchanged (src/claude-plan-usage-probe.ts probePlanUsage: ONE minimal Messages
// call with the plan's own token, read from the vault, never logged; the result is recorded with observationFromProbe
// into claude-plans-state.json, the file quota-notice already reads). Rules:
//   - runs only while QUOTA_NOTICE or QUOTA_AUTOREPLY is on: off by default, so an install that did not ask for it
//     makes no call;
//   - token-mode plans only: a configDir plan has no token this code may read (its agents keep the pane fallback);
//   - at most once per QUOTA_PLAN_PROBE_MIN per plan, counted from the plan's LAST look of any kind, so a plan the
//     rotation measured recently is not probed again;
//   - backoff after a failed probe: a 429 waits 4 intervals, a rejected token a day, any other error 2 intervals
//     (the rotation's lastProbe record carries no retry-after, so the 429 wait is a fixed multiple).

import { logger } from '../logger.js'
import type { ClaudePlan } from './claude-plans.js'
import type { ClaudePlansState, ObservedPlanState } from './claude-plans-state.js'

export const QUOTA_PLAN_PROBE_DEFAULT_MIN = 15
const DAY_MS = 24 * 60 * 60 * 1000

/** When this plan may be probed again (epoch ms), given its last observation / probe and the interval. */
export function nextProbeAt(observed: ObservedPlanState | undefined, intervalMs: number): number {
  if (!observed) return 0
  const lastLook = Math.max(observed.observedAt || 0, observed.lastProbe?.at || 0)
  const p = observed.lastProbe
  // The last probe is the newest look and it failed: back off instead of the plain interval.
  if (p && !p.ok && p.at >= (observed.observedAt || 0)) {
    if (p.error === 'invalid_token') return p.at + DAY_MS
    if (p.error === 'rate_limited') return p.at + 4 * intervalMs
    return p.at + 2 * intervalMs
  }
  return lastLook + intervalMs
}

/** Pure: the named token-mode plans due for a probe now. */
export function selectQuotaProbePlans(input: { plans: ClaudePlan[]; state: ClaudePlansState; nowMs: number; intervalMs: number }): ClaudePlan[] {
  return input.plans.filter((p) => !!p.tokenSecretId && input.nowMs >= nextProbeAt(input.state.plans[p.id], input.intervalMs))
}

export interface QuotaPlanProbeDeps {
  enabled: () => boolean
  intervalMs: () => number
  now: () => number
  plans: () => ClaudePlan[]
  readState: () => ClaudePlansState
  /** Probe one plan with its own token and record the result into claude-plans-state.json. Returns the outcome. */
  probeAndRecord: (plan: ClaudePlan) => Promise<{ ok: boolean; error?: string; httpStatus?: number }>
}

/** One round: probes the due plans, one after the other. Returns the probed plan ids (for tests and the log). */
export async function runQuotaPlanProbes(deps: QuotaPlanProbeDeps): Promise<string[]> {
  if (!deps.enabled()) return []
  const due = selectQuotaProbePlans({ plans: deps.plans(), state: deps.readState(), nowMs: deps.now(), intervalMs: deps.intervalMs() })
  const done: string[] = []
  for (const plan of due) {
    try {
      const r = await deps.probeAndRecord(plan)
      // A plan whose token is not in the vault is skipped quietly: nothing was called, and it would repeat every tick.
      if (!r.ok && r.error !== 'no_token') logger.warn({ plan: plan.id, error: r.error, status: r.httpStatus ?? null }, 'quota-plan-probe: probe failed')
      if (r.error === 'no_token') continue
      done.push(plan.id)
    } catch (err) {
      logger.warn({ plan: plan.id, err: String(err).slice(0, 200) }, 'quota-plan-probe: probe threw')
    }
  }
  return done
}

/** Live wiring: the rotation's probe and state writer, the vault for the token. Nothing here logs a token. */
export async function liveQuotaPlanProbeDeps(enabled: () => boolean, intervalMin: () => number): Promise<QuotaPlanProbeDeps> {
  const [plansReg, plansState, probe, vault] = await Promise.all([
    import('./claude-plans.js'), import('./claude-plans-state.js'), import('../claude-plan-usage-probe.js'), import('./vault.js'),
  ])
  return {
    enabled,
    intervalMs: () => Math.max(5, intervalMin()) * 60_000,
    now: () => Date.now(),
    plans: () => plansReg.readClaudePlans(),
    readState: () => plansState.readClaudePlansState(),
    probeAndRecord: async (plan) => {
      let token: string | null = null
      try { token = plan.tokenSecretId ? vault.getSecret(plan.tokenSecretId) : null } catch { token = null }
      if (!token) return { ok: false, error: 'no_token' }
      const result = await probe.probePlanUsage(token)
      token = null
      const nowMs = Date.now()
      const state = plansState.readClaudePlansState()
      plansState.writeClaudePlansState(plansState.recordPlanObservation(state, plan.id, probe.observationFromProbe(result, state.plans[plan.id], nowMs)))
      return result.ok ? { ok: true } : { ok: false, error: result.error, httpStatus: result.httpStatus }
    },
  }
}
