// GROMZOGATECONF1030 (c) (the owner's GO, Samu 59516, Dani 59506): a sub-agent's sender-role gate lives in ONE file
// under store/, which only the dashboard writes, and the launcher and the gate read ONLY from there. Before, the
// policy sat in the agent's own agents/<name>/agent-config.json, which the agent itself can write: a deceived agent
// could widen its own gate, live at its next restart. The store file is on the install-file gate's protected list
// (scripts/hooks/db-write-gate.mjs), so no agent writes it; an agent-config.json senderRoleGate is ignored (logged).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

export const SENDER_ROLE_GATES_FILE = 'agent-sender-role-gates.json'

export function senderRoleGatesPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, SENDER_ROLE_GATES_FILE)
}

/**
 * The gate's --policy for an unreadable store (a truncated write, a hand edit): a value the hook classifies as
 * malformed, so the gate is wired and every tool is denied in a non-owner's turn (as the main agent's UNREADABLE_POLICY).
 */
export const UNREADABLE_GATES_POLICY = Buffer.from(JSON.stringify('unreadable'), 'utf-8').toString('base64url')

/** The store: ok with every agent's gate (a missing file is none), or not ok when it cannot be read as one object. */
export type GatesStore = { ok: true; gates: Record<string, unknown> } | { ok: false }

export function readSenderRoleGates(path: string = senderRoleGatesPath()): GatesStore {
  if (!existsSync(path)) return { ok: true, gates: {} }
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
    return { ok: true, gates: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

/** The config shape the gate's pure helpers take, for one agent: its stored gate, or none. */
export function storedGateConfig(store: Extract<GatesStore, { ok: true }>, name: string): Record<string, unknown> {
  return Object.hasOwn(store.gates, name) ? { senderRoleGate: store.gates[name] } : {}
}

/**
 * One-time move of the gates that still sit in the agents' own agent-config.json into the store (the dashboard's
 * start). It runs only while the store file does not exist, and then writes it, empty ({}) when no agent had a gate:
 * the file's existence is the marker that the move is done. So a second run changes nothing, and an agent that writes
 * a senderRoleGate into its own agent-config.json AFTER the move never reaches the store through it (an "add the
 * agents still missing" move on every start would take exactly that value in). An unreadable agent-config.json is
 * skipped. Returns the agents moved, or null when the store was already there (nothing written).
 */
export function migrateSenderRoleGates(names: readonly string[], readAgentConfig: (name: string) => unknown,
  path: string = senderRoleGatesPath()): string[] | null {
  if (existsSync(path)) return null
  const gates: Record<string, unknown> = {}
  for (const name of names) {
    let cfg: unknown
    try {
      cfg = readAgentConfig(name)
    } catch {
      continue
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Object.hasOwn(cfg, 'senderRoleGate')) continue
    gates[name] = (cfg as Record<string, unknown>).senderRoleGate
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(gates, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  return Object.keys(gates)
}
