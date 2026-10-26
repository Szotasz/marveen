// Outage tracking for the helper provider (work/local-model-routing/SPEC.md
// section 6): the owner hears about an outage ONCE when it starts and ONCE
// when it ends, never per failed call. sendRoutineAlert's 30-minute cooldown
// is deliberately not reused -- it would re-ping every half hour of a long
// outage.

export const HELPER_DOWN_AFTER_FAILURES = 2
/** While down, at most one real call per this window; the rest fail fast. */
export const HELPER_DOWN_RETRY_MS = 60_000

export interface HelperHealth {
  /** Consecutive failed calls (transport, timeout, HTTP error, invalid JSON). */
  fails: number
  /** Set when the provider went down; null while healthy. */
  downSince: number | null
  /** Runs skipped because of the outage, reported in the recovery note. */
  skipped: number
  lastAttemptMs: number
}

export type HealthAction = 'none' | 'down' | 'recover'

export function initialHealth(): HelperHealth {
  return { fails: 0, downSince: null, skipped: 0, lastAttemptMs: 0 }
}

/**
 * Pure transition. 'down' fires exactly once, when the streak first reaches
 * the threshold; 'recover' fires exactly once, on the first success after a
 * 'down'. Every other call returns 'none'.
 */
export function evaluateHelperCall(
  prev: HelperHealth | undefined,
  ok: boolean,
  nowMs: number,
  threshold = HELPER_DOWN_AFTER_FAILURES,
): { next: HelperHealth; action: HealthAction } {
  const p = prev ?? initialHealth()
  if (ok) {
    const wasDown = p.downSince !== null
    return { next: { fails: 0, downSince: null, skipped: 0, lastAttemptMs: nowMs }, action: wasDown ? 'recover' : 'none' }
  }
  const fails = p.fails + 1
  if (p.downSince === null && fails >= threshold) {
    return { next: { fails, downSince: nowMs, skipped: p.skipped, lastAttemptMs: nowMs }, action: 'down' }
  }
  return { next: { ...p, fails, lastAttemptMs: nowMs }, action: 'none' }
}

/** False while down and a real call was made within HELPER_DOWN_RETRY_MS. */
export function shouldAttemptCall(h: HelperHealth | undefined, nowMs: number): boolean {
  if (!h || h.downSince === null) return true
  return nowMs - h.lastAttemptMs >= HELPER_DOWN_RETRY_MS
}

export function countSkipped(h: HelperHealth | undefined): HelperHealth {
  const p = h ?? initialHealth()
  return { ...p, skipped: p.skipped + 1 }
}

export function outageText(providerLabel: string, action: Exclude<HealthAction, 'none'>, h: HelperHealth): string {
  return action === 'down'
    ? `\u{1F534} A helyi helper (${providerLabel}) nem válaszol (${h.fails} egymás utáni hiba). Amíg nem áll helyre, a helper-feladatok a beállított tartalék szerint futnak (kihagyás vagy Opus ágens). Erről egyszer szólok, a helyreállásról is egyszer.`
    : `\u{1F7E2} A helyi helper (${providerLabel}) ismét válaszol. A kiesés alatt kihagyott futások: ${h.skipped}.`
}
