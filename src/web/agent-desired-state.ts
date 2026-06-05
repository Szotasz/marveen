import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

// Desired run-state for sub-agents.
//
// The agents run on a tmux server shared with the main channels session, which
// gets `systemctl restart`ed several times a day (bun-watchdog, stuck-tool-call
// watchdog, hard-restart). Because that unit is KillMode=control-group, every
// such restart kills the whole tmux server and takes ALL sub-agents down with
// it -- and the channel monitor only auto-restarts agents whose *session still
// exists* with a dead plugin, not agents whose session vanished entirely.
//
// This file records which agents the operator wants running, so the monitor can
// reconcile reality back to that desired state (after a nuke, a dashboard
// restart, or a machine reboot). Explicit start adds; explicit stop removes --
// so a deliberately stopped agent is not resurrected.
const DESIRED_FILE = join(STORE_DIR, 'agents-desired.json')

export function getDesiredAgents(): Set<string> {
  try {
    if (!existsSync(DESIRED_FILE)) return new Set()
    const parsed = JSON.parse(readFileSync(DESIRED_FILE, 'utf-8'))
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
    return new Set()
  } catch (err) {
    logger.warn({ err }, 'Could not read agents-desired.json; treating as empty')
    return new Set()
  }
}

function writeDesired(set: Set<string>): void {
  try {
    writeFileSync(DESIRED_FILE, JSON.stringify([...set].sort(), null, 2))
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents-desired.json')
  }
}

export function addDesiredAgent(name: string): void {
  const set = getDesiredAgents()
  if (set.has(name)) return
  set.add(name)
  writeDesired(set)
  logger.info({ agent: name }, 'Agent added to desired run-state')
}

export function removeDesiredAgent(name: string): void {
  const set = getDesiredAgents()
  if (!set.delete(name)) return
  writeDesired(set)
  logger.info({ agent: name }, 'Agent removed from desired run-state')
}
