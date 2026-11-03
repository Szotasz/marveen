// Fleet freeze ("piros gomb", KILLSWITCH1022): ONE file that stops the fleet acting.
//
// While store/fleet-freeze.json exists:
//   - every agent's tool calls are denied by a PreToolUse hook that checks the
//     same file (templates/settings.json.template for the sub-agents,
//     .claude/settings.json for the main agent), so a session stays alive with
//     its context, but cannot run a shell, write a file, send a letter or reply;
//   - the dashboard's background loops that act on agents (message delivery,
//     scheduler, auto-restart, reauth, context guard, desired-state revival,
//     nudges, watchers, federation polling) skip their tick (whileNotFrozen).
// What stays up: the dashboard HTTP server, the login, this API, the database and
// the logs, so the owner can see the state and lift it.
//
// Two modes. 'freeze' keeps every session running. 'stop' also stops the
// sub-agents' sessions and records which ones, so lifting the freeze starts
// exactly those again. The main agent is never stopped, only frozen (owner
// decision 2026-10-22: its launchd unit is not part of this).
//
// The file's EXISTENCE is the switch, on purpose: the hook
// (scripts/hooks/fleet-freeze-gate.sh) is one file test in bash, with no interpreter to fail, and an unreadable file still counts as
// frozen here (fail-closed).
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const FLEET_FREEZE_PATH = join(PROJECT_ROOT, 'store', 'fleet-freeze.json')

export type FleetFreezeMode = 'freeze' | 'stop'

export interface FleetFreezeState {
  mode: FleetFreezeMode
  reason: string
  /** Who switched it on: an agent name, a dashboard user or a device name. */
  by: string
  at: string
  /** 'stop' mode only: the sub-agents whose sessions were stopped. */
  stoppedAgents?: string[]
}

export const REASON_MAX = 500

export function isFleetFrozen(): boolean {
  return existsSync(FLEET_FREEZE_PATH)
}

/** The current state, or null when not frozen. An unreadable file is frozen. */
export function readFleetFreeze(): FleetFreezeState | null {
  if (!existsSync(FLEET_FREEZE_PATH)) return null
  try {
    const s = JSON.parse(readFileSync(FLEET_FREEZE_PATH, 'utf-8')) as Partial<FleetFreezeState>
    return {
      mode: s.mode === 'stop' ? 'stop' : 'freeze',
      reason: typeof s.reason === 'string' ? s.reason : '',
      by: typeof s.by === 'string' ? s.by : '?',
      at: typeof s.at === 'string' ? s.at : '',
      ...(Array.isArray(s.stoppedAgents) ? { stoppedAgents: s.stoppedAgents.filter((n): n is string => typeof n === 'string') } : {}),
    }
  } catch {
    return { mode: 'freeze', reason: 'unreadable freeze file', by: '?', at: '' }
  }
}

export function writeFleetFreeze(state: FleetFreezeState): void {
  atomicWriteFileSync(FLEET_FREEZE_PATH, JSON.stringify(state, null, 2))
}

/** Removes the file; returns the state it held (null if it was not frozen). */
export function clearFleetFreeze(): FleetFreezeState | null {
  const prev = readFleetFreeze()
  try { unlinkSync(FLEET_FREEZE_PATH) } catch { /* already gone */ }
  return prev
}

// One log line per loop per freeze, not one per tick.
const announced = new Set<string>()

/**
 * True (and logged once per freeze) when a loop's tick must do nothing because
 * the fleet is frozen. For ticks written inline, where wrapping is awkward:
 * `if (frozenSkip('label')) return` as the first line.
 */
export function frozenSkip(label: string): boolean {
  if (isFleetFrozen()) {
    if (!announced.has(label)) {
      announced.add(label)
      logger.warn({ loop: label }, 'fleet frozen: background loop paused')
    }
    return true
  }
  if (announced.delete(label)) logger.info({ loop: label }, 'fleet unfrozen: background loop resumed')
  return false
}

/**
 * Wraps a background loop's tick: while the fleet is frozen the tick does
 * nothing. The loop itself keeps its timer, so lifting the freeze needs no
 * restart.
 */
export function whileNotFrozen<A extends unknown[], R>(label: string, tick: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => (frozenSkip(label) ? undefined : tick(...args))
}
