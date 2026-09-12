// Pure decision logic for Claude plan rotation (PR2a).
//
// See docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md for the
// full design. This module answers two narrow questions, kept pure (no fs/
// network) so the thresholds are unit-tested with fixtures, mirroring
// quota-gate.ts:
//
//   1. How much headroom does an INACTIVE plan probably have right now?
//      (estimateWindowFree) -- deterministic, not fuzzy: an inactive plan's
//      usage is FROZEN at its last observed percentage, because nothing
//      consumes its quota while it is not the active login. The only thing
//      that changes an inactive plan's estimate is a reset boundary passing,
//      which is a known, computable instant, not a guess.
//
//   2. Given the ACTIVE plan's pressure and the other plans' estimated
//      headroom, should the fleet rotate now, wait for the reset, or rotate
//      to a specific target? (decideRotationAction)
//
// FAIL OPEN, same rule as quota-gate.ts: a plan with no observation yet is
// assumed to have full headroom (100% free) rather than excluded, because
// "we don't know" must never be a reason to strand the fleet on a spent plan.
//
// This module does NOT decide whether MAIN_AGENT_ISOLATED_CONFIG is active,
// does not read store/claude-plans.json or store/usage-latest.json, and does
// not restart any session. Those are wiring (PR2c).

/** Last observed state of one quota window (e.g. the 5-hour window) for a
 *  plan, as recorded in store/claude-plans-state.json while that plan was
 *  last active. */
export interface ObservedWindow {
  /** 0..100. */
  usedPercent: number
  /** Unix epoch SECONDS. */
  resetsAt: number
}

/** A plan's estimated headroom at a point in time, for logging/ranking. */
export interface PlanQuotaEstimate {
  planId: string
  /** 0..100, HIGHER = more free quota. */
  freeFivePct: number
  freeSevenDayPct: number
  /** nowMs at estimation time, for logging only. */
  estimatedAt: number
}

/**
 * Estimated % free (100 - used) for one window of a plan that is NOT
 * currently active. Deterministic: frozen at the last observed percentage
 * until a reset boundary passes, at which point it is fully free again.
 */
export function estimateWindowFree(
  lastObserved: ObservedWindow | undefined,
  nowMs: number,
): number {
  // No observation yet -- fail open, assume full headroom rather than
  // excluding the plan from rotation candidacy.
  if (!lastObserved) return 100

  const resetsAtMs = lastObserved.resetsAt * 1000
  // `>=`, not `>`: a reset landing on the exact current instant has already
  // cleared the window, matching the <= / expired boundary convention used
  // for window resets elsewhere (src/web/quota.ts).
  if (nowMs >= resetsAtMs) return 100

  return 100 - lastObserved.usedPercent
}

export interface RotationCandidate {
  planId: string
  /** From estimateWindowFree() for the 5-hour window. */
  freeFivePct: number
}

/**
 * The best rotation target among candidates, excluding the currently active
 * plan. Ties break on planId ascending (stable, not iteration-order
 * dependent) so the result never depends on how the caller assembled the
 * candidate array.
 */
export function pickRotationTarget(
  candidates: RotationCandidate[],
  excludePlanId: string,
): string | null {
  const pool = candidates.filter((c) => c.planId !== excludePlanId)
  if (pool.length === 0) return null
  return pool.reduce((best, c) => {
    if (c.freeFivePct > best.freeFivePct) return c
    if (c.freeFivePct === best.freeFivePct && c.planId < best.planId) return c
    return best
  }).planId
}

export const ROTATION_GATE = {
  /** Proactive switch threshold on the active plan's 5-hour window. */
  switchAtPercent: 90,
  /** "About to reset anyway" -- rotating for less than this is not worth the
   *  Telegram noise + session interruption. Same value and rationale as
   *  quota-gate.ts's nearResetMs. */
  nearResetMs: 30 * 60_000,
} as const

export type RotationDecision =
  | { action: 'no-pressure'; reason: string }
  | { action: 'near-reset'; reason: string }
  | { action: 'no-alternative'; reason: string }
  | { action: 'rotate'; targetPlanId: string; reason: string }

/**
 * The proactive, heartbeat-cycle decision (design 6.3). The caller is
 * responsible for the upstream fail-open checks (untrusted/stale snapshot,
 * missing window) before calling this -- by the time this runs, the active
 * plan's 5-hour window is known-good.
 *
 * The reactive path (design 6.3 "reaktív út", a live 429 during a session)
 * is a separate trigger that calls performRotation(target) directly and does
 * not go through this proactive gate at all.
 */
export function decideRotationAction(input: {
  activePlanId: string
  activeFiveHour: ObservedWindow
  candidates: RotationCandidate[]
  nowMs: number
}): RotationDecision {
  const { activePlanId, activeFiveHour, candidates, nowMs } = input

  const usedPct = activeFiveHour.usedPercent
  if (usedPct < ROTATION_GATE.switchAtPercent) {
    return { action: 'no-pressure', reason: `pressure:${usedPct}%` }
  }

  const untilResetMs = activeFiveHour.resetsAt * 1000 - nowMs
  if (untilResetMs <= ROTATION_GATE.nearResetMs) {
    return {
      action: 'near-reset',
      reason: `pressure:${usedPct}%,resets-in:${Math.round(untilResetMs / 60_000)}m`,
    }
  }

  const target = pickRotationTarget(candidates, activePlanId)
  if (!target) {
    return { action: 'no-alternative', reason: `pressure:${usedPct}%,no-candidates` }
  }

  return { action: 'rotate', targetPlanId: target, reason: `pressure:${usedPct}%->${target}` }
}
