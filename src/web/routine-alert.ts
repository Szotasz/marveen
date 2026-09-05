import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'

// Self-healing recoveries are the fleet's normal operating noise: a session
// died, the supervisor rebuilt it, nothing was lost. The owner still wants to
// hear about it -- a silent wedge cost a whole morning on 2026-07-30, which is
// why these alerts exist at all -- but on 2026-08-22 five of them landed in the
// channel inside fifteen minutes and the owner's read was "you only ever send
// me these". Repetition destroys the signal the first message carries.
//
// So: speak the first time, stay quiet for the cooldown, and when the same
// recovery is STILL firing after the cooldown, say so WITH the count. A
// recurring self-heal is a different (and worse) fact than a one-off, and that
// is the one worth a ping. Every suppressed occurrence is still logged, so
// dashboard.log keeps the full history for diagnosis.
export const ROUTINE_ALERT_COOLDOWN_MS = 30 * 60 * 1000

export type RoutineAlertState = { lastSentAt: number, suppressed: number }

export type RoutineAlertDecision =
  | { send: false }
  | { send: true, repeats: number }

// Pure decision half, so the throttle is testable without a channel.
// `repeats` counts the occurrences suppressed since the last message went out;
// zero means this is a clean first report.
export function decideRoutineAlert(
  prev: RoutineAlertState | undefined,
  now: number,
  cooldownMs: number,
): RoutineAlertDecision {
  if (prev && now - prev.lastSentAt < cooldownMs) return { send: false }
  return { send: true, repeats: prev?.suppressed ?? 0 }
}

export function routineAlertSuffix(repeats: number, cooldownMs: number): string {
  if (repeats <= 0) return ''
  const minutes = Math.round(cooldownMs / 60000)
  return `\n\n(Az elmult ${minutes} percben ${repeats + 1} ilyen volt. Ha nem all le magatol, nezz ra.)`
}

const states = new Map<string, RoutineAlertState>()

// `key` groups occurrences of the SAME recovery: same code path, same agent.
// Two different agents wedging must not silence each other, so per-agent call
// sites put the agent name in the key.
export function sendRoutineAlert(
  key: string,
  text: string,
  opts: { cooldownMs?: number, now?: number } = {},
): boolean {
  const cooldownMs = opts.cooldownMs ?? ROUTINE_ALERT_COOLDOWN_MS
  const now = opts.now ?? Date.now()
  const prev = states.get(key)
  const decision = decideRoutineAlert(prev, now, cooldownMs)
  if (!decision.send) {
    const state = prev as RoutineAlertState
    state.suppressed += 1
    logger.info({ key, suppressed: state.suppressed }, 'Routine recovery alert suppressed (inside cooldown) -- logged only')
    return false
  }
  states.set(key, { lastSentAt: now, suppressed: 0 })
  notifyChannel(text + routineAlertSuffix(decision.repeats, cooldownMs)).catch(() => {})
  return true
}

export function resetRoutineAlerts(): void {
  states.clear()
}
