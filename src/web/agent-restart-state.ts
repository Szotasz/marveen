// Persistence for the channel watchdog's per-agent restart back-off counters.
//
// WHY: channel-monitor.ts keeps the auto-restart back-off entirely in memory
// (agentRestartFailures + agentLastRestart Maps). The dashboard process itself
// restarts frequently (self-update, crashes, launchd/systemd bounce -- 14
// distinct dashboard PIDs were observed in a single night). Every dashboard
// restart wiped those Maps, so the exponential back-off that is supposed to
// SPACE OUT retries for an agent whose channel plugin never comes up reset to
// zero -- and the watchdog dropped straight back to the aggressive base-grace
// (~5 min) restart cadence. The result was a down agent (e.g. hacker, whose
// telegram poller was slow to register) being stop+start churned all night,
// each restart destroying the agent's --continue context.
//
// This module gives the counters a tiny on-disk home so they survive a
// dashboard restart. It is best-effort: any I/O or parse failure degrades to
// the previous in-memory-only behaviour (empty state), never throwing into the
// monitor tick. The serialize/deserialize halves are pure so they can be unit
// tested without touching the filesystem.

import { readFileSync, writeFileSync } from 'node:fs'
import { logger } from '../logger.js'

export interface PersistedRestartState {
  // Consecutive failed watchdog restarts, keyed by agent NAME. Mirrors
  // agentRestartFailures in channel-monitor.ts.
  failures: Record<string, number>
  // Wall-clock time (epoch ms) of the last watchdog restart, keyed by agent
  // NAME. Mirrors agentLastRestart. Persisted alongside failures because the
  // back-off grace check (shouldAutoRestartDownAgent) needs BOTH: losing
  // lastRestart makes msSinceLastRestart null, which skips the restart-grace
  // gate entirely and re-enables immediate churn.
  lastRestart: Record<string, number>
}

export function emptyRestartState(): PersistedRestartState {
  return { failures: {}, lastRestart: {} }
}

// Pure: turn the two in-memory Maps into the serialisable shape.
export function restartStateToJson(
  failures: Map<string, number>,
  lastRestart: Map<string, number>,
): string {
  const state: PersistedRestartState = {
    failures: Object.fromEntries(failures),
    lastRestart: Object.fromEntries(lastRestart),
  }
  return JSON.stringify(state)
}

// Pure: parse persisted JSON back into a normalised state. Any malformed or
// out-of-range entry is dropped rather than trusted, so a corrupt file can
// never inject a bogus counter (e.g. a negative grace or a NaN that disables
// back-off). Returns empty state on any failure.
export function parseRestartState(raw: string): PersistedRestartState {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== 'object') return emptyRestartState()
    const obj = parsed as Record<string, unknown>
    return {
      failures: normaliseCounterMap(obj.failures, { min: 0 }),
      lastRestart: normaliseCounterMap(obj.lastRestart, { min: 1 }),
    }
  } catch {
    return emptyRestartState()
  }
}

function normaliseCounterMap(value: unknown, opts: { min: number }): Record<string, number> {
  const out: Record<string, number> = {}
  if (value == null || typeof value !== 'object') return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < opts.min) continue
    out[k] = Math.floor(v)
  }
  return out
}

// Best-effort load. Missing file / parse error -> empty state.
export function loadRestartState(path: string): PersistedRestartState {
  try {
    return parseRestartState(readFileSync(path, 'utf-8'))
  } catch {
    return emptyRestartState()
  }
}

// Best-effort save. Never throws (logs at debug on failure) so a read-only or
// full disk can never break the monitor tick.
export function saveRestartState(
  path: string,
  failures: Map<string, number>,
  lastRestart: Map<string, number>,
): void {
  try {
    writeFileSync(path, restartStateToJson(failures, lastRestart))
  } catch (err) {
    logger.debug({ err, path }, 'saveRestartState failed (non-fatal)')
  }
}
