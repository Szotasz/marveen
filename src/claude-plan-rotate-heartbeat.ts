// Pure core for the plan-rotation heartbeat (PR2c, design 6.3 + 6.6). No fs,
// no child_process, no settings-store -- scripts/claude-plan-rotate-check.ts
// is the thin IO wrapper that collects these inputs and calls decideAndRecord.
// Split into its own src/ module (rather than living directly in the scripts/
// entry point) so it unit-tests under tsc's rootDir=src, the same reason
// quota-gate.ts's decision logic lives under src/ instead of inside a script.
import { parseQuotaSnapshot } from './quota-snapshot.js'
import { decideRotationAction, estimateWindowFree, type RotationCandidate } from './claude-plan-rotation.js'
import type { ClaudePlan } from './web/claude-plans.js'
import {
  recordObservation,
  type ClaudePlansState,
  type ObservedPlanState,
} from './web/claude-plans-state.js'

export interface RotateCheckResult {
  /** The single structured line to print on stdout, or null to stay silent. */
  printLine: string | null
  /** State to persist. null when nothing changed (e.g. gated off, no plan
   *  assigned yet) -- the caller must not write in that case, to avoid
   *  bumping the file's mtime for no reason. */
  nextState: ClaudePlansState | null
}

const roundMin = (ms: number) => Math.round(ms / 60_000)

/**
 * Everything design 6.3/6.6 decides, given the already-collected inputs:
 * the registered plans, the current state side-car, and the raw
 * usage-collect.py --json output. Preconditions (design 6.2) and the
 * proactive gate (design 6.3) are both applied here; the caller is only
 * responsible for IO (spawning usage-collect.py, reading/writing the state
 * file, printing the result).
 */
export function decideAndRecord(input: {
  agentId: string
  plans: ClaudePlan[]
  state: ClaudePlansState
  usageCollectRaw: unknown
  nowMs: number
}): RotateCheckResult {
  const { agentId, plans, state, usageCollectRaw, nowMs } = input

  // Design 6.2 precondition: rotation only means anything with 2+ registered
  // plans. Below that, strict no-op -- existing single-plan installs must see
  // zero behavior change.
  if (plans.length < 2) return { printLine: null, nextState: null }

  const activePlanId = state.activePlanByAgent[agentId]
  // Bootstrap gap (design 6.5/4 open question, resolved in the PR
  // description): the very first assignment for an agent is not something
  // this heartbeat can guess -- it has no way to know which registered
  // plan's configDir the agent is CURRENTLY running from. That first
  // assignment is a one-time manual POST /api/claude-plans/rotate call;
  // after that, this heartbeat maintains it.
  if (!activePlanId) return { printLine: null, nextState: null }

  const activePlan = plans.find((p) => p.id === activePlanId)
  if (!activePlan) return { printLine: null, nextState: null }

  const snapshot = parseQuotaSnapshot(usageCollectRaw)
  // Same fail-open rule as quota-gate.ts: an untrusted/missing/incomplete
  // snapshot is not evidence of pressure, so never act on it.
  const trustedSources = ['authoritative', 'authoritative_cached']
  if (!snapshot || !trustedSources.includes((snapshot.source ?? '').toLowerCase())) {
    return { printLine: null, nextState: null }
  }
  const fiveHour = snapshot.windows?.five_hour
  if (!fiveHour || typeof fiveHour.used_percent !== 'number' || typeof fiveHour.resets_at !== 'number') {
    return { printLine: null, nextState: null }
  }
  const sevenDay = snapshot.windows?.seven_day

  const observed: ObservedPlanState = {
    observedAt: nowMs,
    source: snapshot.source ?? 'unknown',
    windows: {
      five_hour: { usedPercent: fiveHour.used_percent, resetsAt: fiveHour.resets_at },
      ...(sevenDay && typeof sevenDay.used_percent === 'number' && typeof sevenDay.resets_at === 'number'
        ? { seven_day: { usedPercent: sevenDay.used_percent, resetsAt: sevenDay.resets_at } }
        : {}),
    },
  }
  // Telemetry is recorded on every trustworthy tick, independent of whether a
  // rotation decision follows -- the dashboard's "last known %" badge should
  // stay current even on a quiet cycle.
  const stateWithObservation = recordObservation(state, agentId, activePlanId, observed)

  const candidates: RotationCandidate[] = plans
    .filter((p) => p.id !== activePlanId && p.channelsAllowed)
    .map((p) => {
      const lastObserved = stateWithObservation.plans[p.id]?.windows?.five_hour
      return { planId: p.id, freeFivePct: estimateWindowFree(lastObserved, nowMs) }
    })

  const decision = decideRotationAction({
    activePlanId,
    activeFiveHour: { usedPercent: fiveHour.used_percent, resetsAt: fiveHour.resets_at },
    candidates,
    nowMs,
  })

  const resetsInMin = roundMin(fiveHour.resets_at * 1000 - nowMs)
  const pct = Math.round(fiveHour.used_percent)

  if (decision.action === 'rotate') {
    const target = plans.find((p) => p.id === decision.targetPlanId)
    return {
      printLine: `ROTATE agent=${agentId} target=${decision.targetPlanId} targetLabel=${target?.label ?? decision.targetPlanId} currentLabel=${activePlan.label} currentPct=${pct} resetsInMin=${resetsInMin}`,
      nextState: stateWithObservation,
    }
  }
  if (decision.action === 'no-alternative') {
    return {
      printLine: `NO_ALTERNATIVE agent=${agentId} currentLabel=${activePlan.label} currentPct=${pct} resetsInMin=${resetsInMin}`,
      nextState: stateWithObservation,
    }
  }
  // no-pressure / near-reset: quiet tick, but the observation is still worth
  // keeping so the dashboard badge does not go stale.
  return { printLine: null, nextState: stateWithObservation }
}
