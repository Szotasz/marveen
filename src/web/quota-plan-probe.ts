// QUOTANOTICE1126 per-plan probe: fresh 5-hour / weekly numbers for every NAMED subscription, so the quota notice can
// tell the owner about each plan, not only the default one.
//
// Why: a named plan's numbers live in store/claude-plans-state.json, and only the plan rotation refreshes them (the
// active plan every heartbeat, idle plans only near a limit). Without rotation a named plan had no numbers at all, and
// its agents could only be judged by their pane banner. This probe gives every named token plan its own numbers.
//
// How: the rotation's own live probe, unchanged (src/claude-plan-usage-probe.ts probePlanUsage: ONE minimal Messages
// call with the plan's own token, read from the vault, never logged; the result is recorded with observationFromProbe
// into claude-plans-state.json, the file quota-notice already reads). Rules:
//   - runs only while QUOTA_NOTICE is on: off by default, so an install that did not ask for it
//     makes no call;
//   - only a plan with an agent ACTIVE since its last look (selectQuotaProbePlans); an idle plan is not probed;
//   - token-mode plans only: a configDir plan has no token this code may read (it gets no percentage notice);
//   - at most once per QUOTA_PLAN_PROBE_MIN per plan, counted from the plan's LAST look of any kind, so a plan the
//     rotation measured recently is not probed again;
//   - backoff after a failed probe: a 429 waits 4 intervals, a rejected token a day, any other error 2 intervals
//     (the rotation's lastProbe record carries no retry-after, so the 429 wait is a fixed multiple).

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Pure: the named token-mode plans due for a probe now. Only plans in use are probed.
 *
 * A plan is probed only when at least one agent running on it was ACTIVE since the plan's last look (observation or
 * probe): an idle plan costs nothing, and its last numbers age out normally. "Active" is the agent's transcript being
 * written (`lastActiveMs`: the newest mtime of its transcript files), the signal the dashboard already uses for "this
 * agent did something" (channel-intake-monitor / inbound-probe read the same files): every turn, tool call and channel
 * message lands there, an idle agent's file stands still.
 *
 * Timing: the interval counts from the plan's last look, so an agent that turns active after a long idle gets its
 * plan probed on the very next tick (the stale numbers are not waited out). A failed probe's backoff always holds.
 */
export function selectQuotaProbePlans(input: {
  plans: ClaudePlan[]; state: ClaudePlansState; nowMs: number; intervalMs: number
  /** Newest activity (epoch ms) of the agents running on this plan; 0 when none ran or none is known. */
  lastActiveMs: (planId: string) => number
}): ClaudePlan[] {
  return input.plans.filter((p) => {
    if (!p.tokenSecretId) return false
    const observed = input.state.plans[p.id]
    const lastLook = observed ? Math.max(observed.observedAt || 0, observed.lastProbe?.at || 0) : 0
    if (input.lastActiveMs(p.id) <= lastLook) return false
    return input.nowMs >= nextProbeAt(observed, input.intervalMs)
  })
}

export interface QuotaPlanProbeDeps {
  enabled: () => boolean
  intervalMs: () => number
  now: () => number
  plans: () => ClaudePlan[]
  readState: () => ClaudePlansState
  /** Newest activity (epoch ms) of the agents on this plan, see selectQuotaProbePlans. */
  lastActiveMs: (planId: string) => number
  /** Probe one plan with its own token and record the result into claude-plans-state.json. Returns the outcome. */
  probeAndRecord: (plan: ClaudePlan) => Promise<{ ok: boolean; error?: string; httpStatus?: number }>
}

/** One round: probes the due plans, one after the other. Returns the probed plan ids (for tests and the log). */
export async function runQuotaPlanProbes(deps: QuotaPlanProbeDeps): Promise<string[]> {
  if (!deps.enabled()) return []
  const due = selectQuotaProbePlans({ plans: deps.plans(), state: deps.readState(), nowMs: deps.now(), intervalMs: deps.intervalMs(), lastActiveMs: deps.lastActiveMs })
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
/** The newest mtime (epoch ms) of the .jsonl files in these dirs; 0 when none. */
export function newestTranscriptMtimeMs(dirs: string[]): number {
  let best = 0
  for (const dir of dirs) {
    let names: string[]
    try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')) } catch { continue }
    for (const n of names) {
      try { best = Math.max(best, statSync(join(dir, n)).mtimeMs) } catch { /* vanished */ }
    }
  }
  return best
}

export async function liveQuotaPlanProbeDeps(
  enabled: () => boolean, intervalMin: () => number, planOf: (agent: string) => string, agents: () => string[],
): Promise<QuotaPlanProbeDeps> {
  const [plansReg, plansState, probe, vault, intake, config] = await Promise.all([
    import('./claude-plans.js'), import('./claude-plans-state.js'), import('../claude-plan-usage-probe.js'), import('./vault.js'),
    import('./channel-intake-monitor.js'), import('../config.js'),
  ])
  return {
    enabled,
    intervalMs: () => Math.max(5, intervalMin()) * 60_000,
    now: () => Date.now(),
    plans: () => plansReg.readClaudePlans(),
    readState: () => plansState.readClaudePlansState(),
    lastActiveMs: (planId) => {
      let best = 0
      for (const a of agents()) {
        if (planOf(a) !== planId) continue
        best = Math.max(best, newestTranscriptMtimeMs(intake.transcriptDirsFor(a, config.PROJECT_ROOT)))
      }
      return best
    },
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
