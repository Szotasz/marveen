// SCHEDWRITE1023: which sub-agents may write schedules through the dashboard
// schedule surface?
//
// The self-pace gate denies the whole schedule surface to every agent except the
// main agent, by name. An install that needs one sub-agent to create schedules for
// the operator (a personal assistant that sets reminders) had two options: exempt
// that agent from the whole gate, which also drops the egress-allowlist protection
// and the denies on `tmux send-keys` and the scheduler binaries, or patch the gate.
//
// An explicit list is the middle option. The setting SELF_PACE_SCHEDULE_WRITERS is
// a comma-separated list of agent names. The scaffold adds a flag to the
// self-pace-gate hook command of each listed agent; the hook then stops denying ONE
// route, a curl POST that creates a schedule (POST /api/schedules; PUT, PATCH, DELETE,
// the POST sub-routes and other HTTP clients stay denied), and keeps every
// other deny: the self-schedule store, the scheduled-tasks directory, the registry
// tool, the schedule table SQL, the dashboard database file. The default is the
// narrow reading: an empty list changes nothing.
//
// Scope: the flag removes the gate's own deny on the schedule API write; it
// does not add caller identification to the HTTP API, so it is a discipline
// boundary like the gate itself. The main agent is not gated and is never listed.

import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'

export const SELF_PACE_SCHEDULE_WRITERS_SETTING = 'SELF_PACE_SCHEDULE_WRITERS'
export const SELF_PACE_SCHEDULE_WRITE_FLAG = '--allow-schedule-write'

// Same shape the agent-name validators use elsewhere: a leading alphanumeric, then
// letters, digits, dot, underscore, and dash, 50 characters at most.
const AGENT_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/

/**
 * Parse the setting value. An element that is not a valid agent name is reported
 * and skipped: a malformed entry must never turn into a grant.
 */
export function parseScheduleWriters(raw: string | null | undefined): { names: string[]; invalid: string[] } {
  const names: string[] = []
  const invalid: string[] = []
  for (const part of String(raw ?? '').split(',')) {
    const name = part.trim()
    if (name === '') continue
    if (AGENT_NAME_RX.test(name)) names.push(name)
    else invalid.push(name)
  }
  return { names, invalid }
}

/** The configured writers. An unreadable or empty setting gives an empty list (narrow). */
export function readScheduleWriters(): string[] {
  let raw = ''
  try {
    raw = String(getEffectiveSettingValue(SELF_PACE_SCHEDULE_WRITERS_SETTING) ?? '')
  } catch {
    return []
  }
  const { names, invalid } = parseScheduleWriters(raw)
  if (invalid.length > 0) {
    logger.warn({ invalid }, 'SELF_PACE_SCHEDULE_WRITERS: ignoring entries that are not valid agent names')
  }
  return names
}

/**
 * Does this agent's self-pace-gate command carry the schedule-write flag? Pure:
 * the list is passed in. The main agent is exempt from the gate entirely, so the
 * flag is meaningless there and is never emitted.
 */
export function agentGetsScheduleWrite(name: string, writers: readonly string[]): boolean {
  return name !== MAIN_AGENT_ID && writers.includes(name)
}
