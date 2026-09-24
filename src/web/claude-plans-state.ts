// store/claude-plans-state.json, the machine-managed rotation side-car
// described in
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md section 5.2.
//
// PR2b shipped ONLY the reader (behind GET /api/claude-plans/state, for the
// dashboard's plan cards), with a deliberately lenient schema because open
// question #1 (decided 2026-09-12: sub-agents rotate too) had not yet been
// reflected. PR2c finalizes the schema per that decision: `activePlanId` is
// now `activePlanByAgent`, keyed by agent id (MAIN_AGENT_ID for the main
// channels agent, or a sub-agent's name), because rotation runs per agent,
// not once for the fleet. `plans` stays a flat map keyed by plan id -- a
// plan's own usage does not depend on which agent currently points at it.
//
// PR2c also ships the writer: recordObservation() and applyRotation() are
// pure state-transition functions (no fs), unit-tested in isolation, and
// writeClaudePlansState() is the one atomic-write call site. The heartbeat
// entry point (scripts/claude-plan-rotate-check.ts) is the only production
// caller of the writer.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const CLAUDE_PLANS_STATE_PATH = join(PROJECT_ROOT, 'store', 'claude-plans-state.json')

export interface ObservedPlanWindow {
  usedPercent: number
  /** Unix epoch seconds. */
  resetsAt: number
  /** Per-window status as reported by a live probe (e.g. "allowed",
   *  "rejected"). Absent on heartbeat (usage-collect) observations. */
  status?: string
}

/** Outcome of the most recent live probe (src/claude-plan-usage-probe.ts) of
 *  a plan. Kept separately from `observedAt`/`windows` so a FAILED probe
 *  (e.g. a revoked token) is visible without discarding the last good numbers. */
export interface PlanProbeOutcome {
  /** Unix epoch ms. */
  at: number
  ok: boolean
  /** ProbeErrorKind when !ok. */
  error?: string
  httpStatus?: number
}

export interface ObservedPlanState {
  /** Unix epoch ms. */
  observedAt: number
  source: string
  windows: Record<string, ObservedPlanWindow>
  /** anthropic-ratelimit-unified-status from a live probe, when known. */
  overallStatus?: string
  lastProbe?: PlanProbeOutcome
}

/** Outcome of the most recent fleet leg of a rotation (CLAUDE_ROTATION_FLEET,
 *  src/claude-plan-fleet-rotation.ts): which plan's token the shared fleet
 *  token file was switched to, and which sub-agents were restarted. */
export interface FleetRotationRecord {
  /** Plan the fleet was pointed at (or would have been, when skipped). */
  fleetPlanId: string
  /** Unix epoch ms. */
  rotatedAt: number
  /** 'rotated': file written (or already held that token) and restarts ran.
   *  'skipped': nothing touched, see `reason`. 'failed': the file write
   *  itself failed, nothing restarted. */
  outcome: 'rotated' | 'skipped' | 'failed'
  reason?: string
  restarted: string[]
  failed: Array<{ agent: string; error: string }>
  /** Shared-token agents that were not running: they pick the new token up
   *  on their next start, nothing to restart. */
  notRunning: string[]
  /** The structured line (FLEET_ROTATE / FLEET_SKIPPED ...) describing it. */
  line: string
  /** Unix epoch ms at which the heartbeat printed `line`; absent = not yet
   *  reported (scripts/claude-plan-rotate-check.ts prints it once). */
  reportedAt?: number
}

export interface ClaudePlansState {
  /** Which plan id each agent is currently on. A missing key means that agent
   *  has never been rotated (not on the isolated-config path yet, or
   *  rotation has not run for it). */
  activePlanByAgent: Record<string, string>
  plans: Record<string, ObservedPlanState>
  /** Last fleet leg (opt-in). Absent on installs that never ran one. */
  fleet?: FleetRotationRecord
}

const EMPTY_STATE: ClaudePlansState = { activePlanByAgent: {}, plans: {} }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

export function readClaudePlansState(): ClaudePlansState {
  if (!existsSync(CLAUDE_PLANS_STATE_PATH)) return EMPTY_STATE
  try {
    const raw: unknown = JSON.parse(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8'))
    if (!isPlainObject(raw)) return EMPTY_STATE
    const activePlanByAgent = isStringRecord(raw.activePlanByAgent) ? raw.activePlanByAgent : {}
    const plans = isPlainObject(raw.plans) ? (raw.plans as unknown as ClaudePlansState['plans']) : {}
    const fleet = isPlainObject(raw.fleet) && typeof raw.fleet.fleetPlanId === 'string'
      ? (raw.fleet as unknown as FleetRotationRecord)
      : undefined
    return fleet ? { activePlanByAgent, plans, fleet } : { activePlanByAgent, plans }
  } catch {
    return EMPTY_STATE
  }
}

// Atomic overwrite of the whole side-car. Callers read-modify-write via
// recordObservation()/applyRotation() below, then call this once -- mirrors
// writeClaudePlans()'s single-writer-per-call shape in claude-plans.ts.
export function writeClaudePlansState(state: ClaudePlansState): void {
  mkdirSync(dirname(CLAUDE_PLANS_STATE_PATH), { recursive: true })
  atomicWriteFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

// Pure state transition: record a freshly observed quota snapshot for
// `planId` (the plan `agentId` is CURRENTLY on) and make sure `agentId` is
// marked as being on that plan. Called every heartbeat tick regardless of
// whether a rotation decision follows, so the dashboard's "last known %"
// badge stays current even when nothing rotates.
export function recordObservation(
  state: ClaudePlansState,
  agentId: string,
  planId: string,
  observed: ObservedPlanState,
): ClaudePlansState {
  const next = recordPlanObservation(state, planId, observed)
  return { ...next, activePlanByAgent: { ...state.activePlanByAgent, [agentId]: planId } }
}

// Pure state transition: record an observation for `planId` WITHOUT touching
// which plan any agent is on. This is the live-probe path (a plan's usage is
// read directly with its own token while it is idle); recordObservation above
// would wrongly mark the probed plan as an agent's active one.
export function recordPlanObservation(
  state: ClaudePlansState,
  planId: string,
  observed: ObservedPlanState,
): ClaudePlansState {
  return { ...state, plans: { ...state.plans, [planId]: observed } }
}

// Pure state transition: point `agentId` at `targetPlanId`. Used both by an
// actual rotation and by the one-time bootstrap assignment (design 6.5/4's
// open bootstrap question, resolved in the PR2c description: the very first
// assignment for an agent is just a rotation with no prior active plan --
// there is no separate bootstrap code path).
export function applyRotation(
  state: ClaudePlansState,
  agentId: string,
  targetPlanId: string,
): ClaudePlansState {
  return { ...state, activePlanByAgent: { ...state.activePlanByAgent, [agentId]: targetPlanId } }
}

// Pure state transition: record the outcome of a fleet leg. Replaces any
// previous record (only the latest one is interesting, and a fresh record
// has no reportedAt, so the heartbeat reports it once).
export function recordFleetRotation(state: ClaudePlansState, record: FleetRotationRecord): ClaudePlansState {
  return { ...state, fleet: record }
}

// Pure state transition: mark the current fleet record as reported.
export function markFleetReported(state: ClaudePlansState, nowMs: number): ClaudePlansState {
  if (!state.fleet) return state
  return { ...state, fleet: { ...state.fleet, reportedAt: nowMs } }
}
