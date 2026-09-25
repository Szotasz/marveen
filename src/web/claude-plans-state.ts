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
}

export interface ObservedPlanState {
  /** Unix epoch ms. */
  observedAt: number
  source: string
  windows: Record<string, ObservedPlanWindow>
}

export interface ClaudePlansState {
  /** Which plan id each agent is currently on. A missing key means that agent
   *  has never been rotated (not on the isolated-config path yet, or
   *  rotation has not run for it). */
  activePlanByAgent: Record<string, string>
  plans: Record<string, ObservedPlanState>
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
    return { activePlanByAgent, plans }
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
  return {
    activePlanByAgent: { ...state.activePlanByAgent, [agentId]: planId },
    plans: { ...state.plans, [planId]: observed },
  }
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
