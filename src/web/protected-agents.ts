import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

// Agents the dashboard API must never stop or delete (card 2fd5bfae).
//
// Péter, 2026-08-26: "Sentinel soha ne legyen leállítva." The supervisor's own
// off-switch was in the hands of everything it supervises: POST
// /api/agents/sentinel/stop is the same call any agent can make, and DELETE
// /api/agents/sentinel had no guard at all.
//
// WHAT THIS DOES NOT DO. Sentinel audited the proposal and listed six OS-level
// bypasses that stay open, because every agent runs as the same OS user with
// shell and filesystem access: tmux kill-session, kill -9, tmux kill-server,
// hand-editing agents-desired.json, overwriting this list, and rm -rf on the
// agent directory. Péter accepted all six explicitly (decision #3, 2026-08-26:
// "nem lehetetlenné tesszük, csak nehézzé és nyoma marad"). So the contract of
// this module is narrow and should stay narrow: close the HTTP path, and leave
// a trace for everything it cannot close.
//
// There is deliberately NO writer exported here. The dashboard API only ever
// reads this list; an API that can edit its own guard list is not a guard.
const PROTECTED_FILE = join(STORE_DIR, 'protected-agents.json')

// Append-only evidence trail for guard events. Deliberately a separate file
// from the dashboard log: the log rotates and is noisy, this one is short
// enough to read by eye after an incident.
const BLOCK_LOG_FILE = join(STORE_DIR, 'protected-agent-block.log')

// Built-in fallback, used only when the file is missing or unreadable.
//
// Why a default at all: deleting protected-agents.json is bypass #5 on
// Sentinel's list, and without a default it would be the CHEAPEST of the six --
// no valid JSON needed, no knowledge of the format, one rm and the protection
// is simply gone. With it, switching protection off takes a deliberate edit
// that leaves its own evidence on disk, and an absent file still protects the
// one agent Péter named.
export const DEFAULT_PROTECTED_AGENTS: readonly string[] = ['sentinel']

// Warn-once state. The reads happen on stop/delete and on the reconciler's
// restart path, all of which are rare, but a protected agent that is down in a
// loop would otherwise repeat the identical line every 60s forever.
let missingFileWarned = false
const defaultAbsenceWarned = new Set<string>()

function fallback(): Set<string> {
  return new Set(DEFAULT_PROTECTED_AGENTS)
}

/**
 * The agents that must not be stopped or deleted through the API.
 *
 * Read fresh on every call on purpose -- no cache. The file is a handful of
 * bytes, the call sites are rare, and an operator edit has to take effect
 * without a dashboard restart (the alternative is a guard list that silently
 * describes a state nobody is in any more).
 *
 * `filePath` is injectable for tests only; production always uses STORE_DIR.
 */
export function getProtectedAgents(filePath: string = PROTECTED_FILE): Set<string> {
  let raw: string
  try {
    if (!existsSync(filePath)) {
      if (!missingFileWarned) {
        missingFileWarned = true
        logger.warn(
          { file: filePath, fallback: DEFAULT_PROTECTED_AGENTS },
          'protected-agents.json is missing -- using the built-in protected list',
        )
      }
      return fallback()
    }
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    logger.warn({ err, file: filePath }, 'protected-agents.json unreadable -- using the built-in protected list')
    return fallback()
  }
  missingFileWarned = false

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.warn({ err, file: filePath }, 'protected-agents.json is not valid JSON -- using the built-in protected list')
    return fallback()
  }
  if (!Array.isArray(parsed)) {
    logger.warn({ file: filePath }, 'protected-agents.json is not an array -- using the built-in protected list')
    return fallback()
  }

  const names = parsed
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  // A list that parses but drops a built-in default is honoured -- Péter owns
  // this file and may legitimately unprotect an agent. It is still announced,
  // because the same edit is what an overwrite attack produces, and the whole
  // point of the decision Péter signed off on is that a bypass leaves a trace.
  for (const name of DEFAULT_PROTECTED_AGENTS) {
    if (names.includes(name)) {
      defaultAbsenceWarned.delete(name)
      continue
    }
    if (defaultAbsenceWarned.has(name)) continue
    defaultAbsenceWarned.add(name)
    logger.warn(
      { agent: name, file: filePath },
      'Built-in protected agent is not listed in protected-agents.json -- its API protection is OFF',
    )
  }

  return new Set(names)
}

export function isProtectedAgent(name: string, filePath?: string): boolean {
  return getProtectedAgents(filePath).has(name)
}

export type ProtectedAgentOutcome = 'blocked' | 'restarted' | 'restart-failed'

export interface ProtectedAgentEvent {
  /** The protected agent the event is about. */
  agent: string
  /** What was attempted or observed: 'stop', 'delete', 'out-of-band-disappearance'. */
  action: string
  outcome: ProtectedAgentOutcome
  /** Caller identity when the event came in over HTTP; absent for internal detections. */
  source?: string
  /** Human-readable one-liner for whoever reads the log after an incident. */
  note?: string
}

/**
 * Append one guard event to the audit trail.
 *
 * Never throws: this runs inside request handling and inside the reconciler
 * sweep, and a full disk must not turn a refused stop into a 500 (which a
 * caller could then retry until something else gives). A failed append is
 * downgraded to a log line, so the event survives even when the file does not.
 */
export function recordProtectedAgentEvent(event: ProtectedAgentEvent, filePath: string = BLOCK_LOG_FILE): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  try {
    appendFileSync(filePath, `${line}\n`)
  } catch (err) {
    logger.error({ err, file: filePath, ...event }, 'Could not append to the protected-agent audit log')
  }
  // Second, independent trail. The log file can be deleted by the same actor
  // that triggered the event; the dashboard log is shipped elsewhere.
  logger.warn({ ...event }, 'Protected-agent guard event')
}

/**
 * Best-effort caller identity for the audit line. Every /api call is already
 * behind the bearer gate, so this answers "which credential and which socket",
 * not "which human" -- stated plainly here so nobody reads the log as proof of
 * identity it cannot provide.
 */
export function describeApiCaller(auth: { kind: string; user?: string; peer?: string; device?: string } | undefined, remoteAddress?: string): string {
  const who = auth
    ? [auth.kind, auth.user ?? auth.peer ?? auth.device].filter(Boolean).join(':')
    : 'unauthenticated'
  return remoteAddress ? `${who}@${remoteAddress}` : who
}
