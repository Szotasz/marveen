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
 *  last active (or by a live probe while it was idle). */
export interface ObservedWindow {
  /** 0..100. */
  usedPercent: number
  /** Unix epoch SECONDS. */
  resetsAt: number
  /** Per-window status from a live probe ("allowed", "rejected", ...), when
   *  known. "rejected" means the window is exhausted whatever the percentage
   *  says, so it is read as 100% used. */
  status?: string
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

/** The per-window status value a live probe reports for an exhausted window. */
export const WINDOW_STATUS_EXHAUSTED = 'rejected'

/**
 * Effective % USED of one window at `nowMs`: 0 once its reset boundary has
 * passed (or with no observation at all -- fail open), 100 when the probe
 * said the window is rejected, otherwise the observed percentage.
 */
export function effectiveUsedPct(lastObserved: ObservedWindow | undefined, nowMs: number): number {
  if (!lastObserved) return 0
  // `>=`, not `>`: a reset landing on the exact current instant has already
  // cleared the window, matching the <= / expired boundary convention used
  // for window resets elsewhere (src/web/quota.ts).
  if (nowMs >= lastObserved.resetsAt * 1000) return 0
  if (lastObserved.status === WINDOW_STATUS_EXHAUSTED) return 100
  return lastObserved.usedPercent
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
  return 100 - effectiveUsedPct(lastObserved, nowMs)
}

export interface RotationCandidate {
  planId: string
  /** From estimateWindowFree() for the 5-hour window. */
  freeFivePct: number
  /** From estimateWindowFree() for the 7-day window. Absent = unknown = 100
   *  (fail open, same rule as a missing 5h observation). */
  freeSevenDayPct?: number
}

/** A candidate's usable headroom: the TIGHTER of its two windows. A plan with
 *  a fresh 5h window but a spent week is not headroom -- it fails within the
 *  hour, which is exactly the weekly-limit outage this ranking exists to
 *  avoid. */
export function candidateHeadroom(c: RotationCandidate): number {
  return Math.min(c.freeFivePct, c.freeSevenDayPct ?? 100)
}

/**
 * The best rotation target among candidates, excluding the currently active
 * plan. Ranked by candidateHeadroom() (min of the 5h and 7d free %). Ties
 * break on planId ascending (stable, not iteration-order dependent) so the
 * result never depends on how the caller assembled the candidate array.
 */
export function pickRotationTarget(
  candidates: RotationCandidate[],
  excludePlanId: string,
): string | null {
  const pool = candidates.filter((c) => c.planId !== excludePlanId)
  if (pool.length === 0) return null
  return pool.reduce((best, c) => {
    const h = candidateHeadroom(c)
    const bh = candidateHeadroom(best)
    if (h > bh) return c
    if (h === bh && c.planId < best.planId) return c
    return best
  }).planId
}

export const ROTATION_GATE = {
  /** Proactive switch threshold on the active plan's 5-hour window. */
  switchAtPercent: 90,
  /** Proactive switch threshold on the active plan's 7-day window. Same
   *  number as the 5h one (no evidence for a different value); a separate
   *  key so the two can be tuned independently. The weekly limit is the one
   *  that actually took whole fleets down (every recorded outage was 7d). */
  switchAtSevenDayPercent: 90,
  /** "About to reset anyway" -- rotating for less than this is not worth the
   *  Telegram noise + session interruption. Same value and rationale as
   *  quota-gate.ts's nearResetMs. Applied per window: a 7d window resetting
   *  in 3 days is never "near". */
  nearResetMs: 30 * 60_000,
} as const

/** Last-known state of a would-be rotation target, as far as candidacy is
 *  concerned. Structurally a subset of ObservedPlanState
 *  (web/claude-plans-state.ts) -- kept local so this module stays pure and
 *  free of web/ imports. */
export interface CandidateObservation {
  observedAt?: number
  windows?: Record<string, ObservedWindow | undefined>
  lastProbe?: { at: number; ok: boolean; error?: string }
}

/**
 * Pure: turn a plan's last-known observation into a RotationCandidate, or
 * null when the plan must NOT be rotated to right now:
 *
 * - its most recent live probe was rejected with invalid_token (revoked /
 *   mistyped token: rotating to it would log the agent out). Only while that
 *   probe is the newest thing known about the plan -- a later successful
 *   observation clears it.
 * - its 7-day window is at/over the switch threshold (or "rejected") and has
 *   NOT reset yet. Once resetsAt passes it is a full candidate again.
 * - its 5-hour window is exhausted (100% / "rejected") and has not reset:
 *   a plan at e.g. 92% 5h is still a better landing spot than a spent one, so
 *   only true exhaustion excludes on the 5h side; ranking handles the rest.
 *
 * No observation at all -> full-headroom candidate (fail open).
 */
export function candidateFromObservation(
  planId: string,
  observed: CandidateObservation | undefined,
  nowMs: number,
): RotationCandidate | null {
  const probe = observed?.lastProbe
  if (probe && !probe.ok && probe.error === 'invalid_token' && probe.at >= (observed?.observedAt ?? 0)) {
    return null
  }
  const five = observed?.windows?.five_hour
  const seven = observed?.windows?.seven_day
  if (effectiveUsedPct(seven, nowMs) >= ROTATION_GATE.switchAtSevenDayPercent) return null
  if (effectiveUsedPct(five, nowMs) >= 100) return null
  return {
    planId,
    freeFivePct: estimateWindowFree(five, nowMs),
    freeSevenDayPct: estimateWindowFree(seven, nowMs),
  }
}

export type RotationTrigger = '5h' | '7d'

export type RotationDecision =
  | { action: 'no-pressure'; reason: string }
  | { action: 'near-reset'; reason: string }
  | { action: 'no-alternative'; trigger: RotationTrigger; reason: string }
  | { action: 'rotate'; targetPlanId: string; trigger: RotationTrigger; reason: string }

/**
 * The proactive, heartbeat-cycle decision (design 6.3). The caller is
 * responsible for the upstream fail-open checks (untrusted/stale snapshot,
 * missing window) before calling this -- by the time this runs, the active
 * plan's 5-hour window is known-good. The 7-day window is optional: absent
 * means "not known", which is never pressure (fail open).
 *
 * Each window is judged on its own: over its threshold AND not about to
 * reset -> it demands a rotation. The 7d window wins the trigger label when
 * both demand it (it is the one that will not fix itself within hours).
 *
 * The reactive path (design 6.3 "reaktív út", a live 429 during a session)
 * is a separate trigger that calls performRotation(target) directly and does
 * not go through this proactive gate at all.
 */
export function decideRotationAction(input: {
  activePlanId: string
  activeFiveHour: ObservedWindow
  activeSevenDay?: ObservedWindow
  candidates: RotationCandidate[]
  nowMs: number
}): RotationDecision {
  const { activePlanId, activeFiveHour, activeSevenDay, candidates, nowMs } = input

  const windows: Array<{ key: RotationTrigger; w: ObservedWindow | undefined; threshold: number }> = [
    { key: '7d', w: activeSevenDay, threshold: ROTATION_GATE.switchAtSevenDayPercent },
    { key: '5h', w: activeFiveHour, threshold: ROTATION_GATE.switchAtPercent },
  ]
  const pressured = windows
    .map(({ key, w, threshold }) => {
      const used = effectiveUsedPct(w, nowMs)
      const untilResetMs = w ? w.resetsAt * 1000 - nowMs : 0
      return { key, used, threshold, untilResetMs }
    })
    .filter((x) => x.used >= x.threshold)

  const fmt = (x: { key: string; used: number }) => `${x.key}=${x.used}%`

  if (pressured.length === 0) {
    const five = effectiveUsedPct(activeFiveHour, nowMs)
    const seven = activeSevenDay ? `,7d=${effectiveUsedPct(activeSevenDay, nowMs)}%` : ''
    return { action: 'no-pressure', reason: `pressure:5h=${five}%${seven}` }
  }

  const demanding = pressured.filter((x) => x.untilResetMs > ROTATION_GATE.nearResetMs)
  if (demanding.length === 0) {
    return {
      action: 'near-reset',
      reason: pressured.map((x) => `pressure:${fmt(x)},resets-in:${Math.round(x.untilResetMs / 60_000)}m`).join(';'),
    }
  }

  const trigger = demanding[0]
  const target = pickRotationTarget(candidates, activePlanId)
  if (!target) {
    return { action: 'no-alternative', trigger: trigger.key, reason: `pressure:${fmt(trigger)},no-candidates` }
  }

  return { action: 'rotate', targetPlanId: target, trigger: trigger.key, reason: `pressure:${fmt(trigger)}->${target}` }
}

// Reactive path (design 6.3 addendum, Kobza Attila 2026-09-11): a live 429 /
// "quota exceeded" response during a session should trigger rotation
// immediately, without waiting for the next proactive heartbeat tick. The
// design left the exact detection SITE open ("hol figyeljük a 429-et...
// implementációs kérdés") -- this PR ships only the pure classifier; wiring
// it into a live tmux-output watcher is a separate, riskier follow-up (it
// means parsing a running session's output, not just reading a JSON
// snapshot) and is intentionally NOT part of this PR. See the PR description.
//
// Deliberately conservative: false negatives (missing a real quota error) are
// safe -- the proactive path still catches it within one heartbeat cycle.
// False positives are not: this string match must not fire on a plain error
// message that happens to mention "limit" for an unrelated reason, so it
// requires one of a short list of high-specificity phrases rather than any
// single common word.
const QUOTA_EXCEEDED_PATTERNS = [
  /\b429\b/,
  /quota[\s_-]?exceeded/i,
  /usage[\s_-]?limit[\s_-]?reached/i,
  /rate[\s_-]?limit[\s_-]?exceeded/i,
] as const

export function isQuotaExceededError(text: string): boolean {
  return QUOTA_EXCEEDED_PATTERNS.some((re) => re.test(text))
}
