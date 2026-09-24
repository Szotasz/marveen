// Pure core for the plan-rotation heartbeat (PR2c, design 6.3 + 6.6). No fs,
// no child_process, no settings-store -- scripts/claude-plan-rotate-check.ts
// is the thin IO wrapper that collects these inputs and calls decideAndRecord.
// Split into its own src/ module (rather than living directly in the scripts/
// entry point) so it unit-tests under tsc's rootDir=src, the same reason
// quota-gate.ts's decision logic lives under src/ instead of inside a script.
import { parseQuotaSnapshot } from './quota-snapshot.js'
import { decideRotationAction, candidateFromObservation, type RotationCandidate } from './claude-plan-rotation.js'
import type { ClaudePlan } from './web/claude-plans.js'
import {
  recordObservation,
  markFleetReported,
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

  // Candidacy looks at BOTH windows (candidateFromObservation): a plan whose
  // week is spent, or whose token was last rejected as invalid, is not a
  // landing spot however fresh its 5h window looks.
  const candidates: RotationCandidate[] = plans
    .filter((p) => p.id !== activePlanId && p.channelsAllowed)
    .map((p) => candidateFromObservation(p.id, stateWithObservation.plans[p.id], nowMs))
    .filter((c): c is RotationCandidate => c !== null)

  const activeSevenDay = observed.windows.seven_day
  const decision = decideRotationAction({
    activePlanId,
    activeFiveHour: { usedPercent: fiveHour.used_percent, resetsAt: fiveHour.resets_at },
    ...(activeSevenDay ? { activeSevenDay } : {}),
    candidates,
    nowMs,
  })

  const resetsInMin = roundMin(fiveHour.resets_at * 1000 - nowMs)
  const pct = Math.round(fiveHour.used_percent)
  // Appended AFTER the historical fields so a prompt that parses the old
  // ROTATE/NO_ALTERNATIVE shape keeps working; `trigger` names the window
  // that demanded the switch (5h or 7d).
  const weekly = activeSevenDay
    ? ` sevenDayPct=${Math.round(activeSevenDay.usedPercent)} sevenDayResetsInMin=${roundMin(activeSevenDay.resetsAt * 1000 - nowMs)}`
    : ''

  if (decision.action === 'rotate') {
    const target = plans.find((p) => p.id === decision.targetPlanId)
    return {
      printLine: `ROTATE agent=${agentId} target=${decision.targetPlanId} targetLabel=${target?.label ?? decision.targetPlanId} currentLabel=${activePlan.label} currentPct=${pct} resetsInMin=${resetsInMin} trigger=${decision.trigger}${weekly}`,
      nextState: stateWithObservation,
    }
  }
  if (decision.action === 'no-alternative') {
    return {
      printLine: `NO_ALTERNATIVE agent=${agentId} currentLabel=${activePlan.label} currentPct=${pct} resetsInMin=${resetsInMin} trigger=${decision.trigger}${weekly}`,
      nextState: stateWithObservation,
    }
  }
  // no-pressure / near-reset: quiet tick, but the observation is still worth
  // keeping so the dashboard badge does not go stale.
  return { printLine: null, nextState: stateWithObservation }
}

/**
 * The fleet leg of a rotation (CLAUDE_ROTATION_FLEET) runs inside the
 * dashboard after POST /api/claude-plans/rotate has already answered -- and
 * after the main agent that would report it has been restarted. It records
 * its structured line in the state side-car instead; the next heartbeat tick
 * prints it exactly once (this) so the scheduled task can relay it.
 */
export function pendingFleetReport(
  state: ClaudePlansState,
  nowMs: number,
): { printLine: string; nextState: ClaudePlansState } | null {
  if (!state.fleet || state.fleet.reportedAt !== undefined || !state.fleet.line) return null
  return { printLine: state.fleet.line, nextState: markFleetReported(state, nowMs) }
}
