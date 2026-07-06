import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Master opt-in toggle for the dashboard per-agent terminal-input (send-keys)
// feature. DEFAULT OFF.
//
// SECURITY (ddc0cd9b, 2026-07-05): the raw keystroke-injection endpoint
// (/api/agents/:name/keys) was the root-cause vector of the 2026-06-26
// forged-"Szabi" prompt-injection incident, so it was disabled outright. This
// toggle brings it back as a deliberate two-step, owner-gated opt-in: the
// operator must explicitly flip it ON in the dashboard (behind the
// dashboard-token gate) before ANY /keys call is accepted. It defaults to OFF
// and stays OFF across restarts unless the operator turned it on. Every accepted
// /keys call is audit-logged separately (the missing fix from the incident).
const STORE_PATH = join(PROJECT_ROOT, 'store', 'terminal-input.json')

interface TerminalInputConfig {
  enabled: boolean
}

const DEFAULT: TerminalInputConfig = { enabled: false }

/** Current toggle state; OFF by default and on any read error (fail-closed). */
export function readTerminalInputEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    return parsed?.enabled === true
  } catch {
    return DEFAULT.enabled
  }
}

/** Persist the toggle. Returns the new state. */
export function writeTerminalInputEnabled(enabled: boolean): boolean {
  const next: TerminalInputConfig = { enabled: enabled === true }
  atomicWriteFileSync(STORE_PATH, JSON.stringify(next, null, 2))
  return next.enabled
}
