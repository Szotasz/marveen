// Read-only view onto store/claude-plans-state.json, the machine-managed
// rotation side-car described in
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md section 5.2.
//
// PR2b ships ONLY this reader (behind GET /api/claude-plans/state, for the
// dashboard's plan cards). Nothing writes the file yet -- that lands with the
// rotation wiring (PR2c). The design doc's open question #1 (decided
// 2026-09-12: sub-agents rotate too, so `activePlanId` likely becomes
// per-agent, not one global value) is not yet reflected in a finalized
// schema, so this stays deliberately lenient: it reads back whatever object
// PR2c ends up writing rather than asserting a shape nobody has built yet,
// and reports a safe empty state when the file is absent or malformed.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

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
  /** The plan currently active for the main agent, or null when rotation has
   *  never run / the main agent is not on the isolated-config rotation path.
   *  May become per-agent in PR2c -- see the module comment. */
  activePlanId: string | null
  plans: Record<string, ObservedPlanState>
}

const EMPTY_STATE: ClaudePlansState = { activePlanId: null, plans: {} }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function readClaudePlansState(): ClaudePlansState {
  if (!existsSync(CLAUDE_PLANS_STATE_PATH)) return EMPTY_STATE
  try {
    const raw: unknown = JSON.parse(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8'))
    if (!isPlainObject(raw)) return EMPTY_STATE
    const activePlanId = typeof raw.activePlanId === 'string' ? raw.activePlanId : null
    const plans = isPlainObject(raw.plans) ? (raw.plans as unknown as ClaudePlansState['plans']) : {}
    return { activePlanId, plans }
  } catch {
    return EMPTY_STATE
  }
}
