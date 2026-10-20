// Manual-restart gate for the main agent.
//
// The scheduled restart already refuses a busy pane (restartBlockedBy in auto-restart.ts), but the
// manual restart routes called hardRestartMarveenChannels() with no check at all, so a click could
// cut a running turn. This gate sits in front of both manual routes. Principle: never cut live
// work; when the pane cannot be read, refuse (fail-closed). A session that does not exist has no
// turn to cut, so restarting a dead session stays allowed.
//
// Same rule as the respawn-gate: the decision is taken from the pane's observed state, not from
// the clock, and several samples must agree before a restart goes through.

import { paneLooksIdle } from '../pane-state.js'
import { capturePane, sessionExistsOnHost } from './agent-process.js'

export const MANUAL_RESTART_SAMPLES = 3
export const MANUAL_RESTART_INTERVAL_MS = 1200

export type ManualRestartVerdict =
  | { allow: true; reason: 'no-session' | 'idle' }
  | { allow: false; reason: 'busy' | 'no-pane' | 'unknown-state' }

/**
 * One sample per capture: true = idle, false = busy, null = pane unreadable.
 * Pure. Every sample must be idle; a single busy or unreadable sample refuses.
 */
export function decideManualRestart(samples: ReadonlyArray<boolean | null>): ManualRestartVerdict {
  if (samples.length !== MANUAL_RESTART_SAMPLES) return { allow: false, reason: 'unknown-state' }
  if (samples.some((s) => s === null)) return { allow: false, reason: 'no-pane' }
  if (samples.some((s) => s === false)) return { allow: false, reason: 'busy' }
  return { allow: true, reason: 'idle' }
}

/**
 * What a refused caller is told. A stuck main agent can show a busy pane and never make progress;
 * without an explicit override the gate would refuse every manual recovery, so the 409 says how to
 * ask for a forced restart. The force is an operator decision: it cuts the running turn.
 */
export const MANUAL_RESTART_FORCE_HINT =
  'Restart refused: the main agent\'s pane is busy. To restart anyway (this cuts the running turn), ' +
  'send POST /api/marveen/restart with the JSON body {"force": true}.'

/**
 * True only for an explicit {"force": true} body. The dashboard button sends no body, so it never
 * forces. A malformed body is not a force.
 */
export function wantsForceRestart(body: Buffer | string): boolean {
  try {
    const text = typeof body === 'string' ? body : body.toString('utf-8')
    if (text.trim() === '') return false
    const parsed = JSON.parse(text) as { force?: unknown } | null
    return parsed !== null && typeof parsed === 'object' && parsed.force === true
  } catch {
    return false
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Samples the session's pane MANUAL_RESTART_SAMPLES times, spaced by MANUAL_RESTART_INTERVAL_MS,
 * then decides. `sleep` is injectable so tests run without real waits.
 */
export async function gateManualRestart(
  session: string,
  host: string | null = null,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ManualRestartVerdict> {
  if (!sessionExistsOnHost(host, session)) return { allow: true, reason: 'no-session' }
  const samples: Array<boolean | null> = []
  for (let i = 0; i < MANUAL_RESTART_SAMPLES; i++) {
    if (i > 0) await sleep(MANUAL_RESTART_INTERVAL_MS)
    const pane = capturePane(session, host)
    samples.push(pane == null ? null : paneLooksIdle(pane))
  }
  return decideManualRestart(samples)
}
