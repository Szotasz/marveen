// The owner's switches for the IT operator surface (DASHOPERATOR1005).
//
// Which capabilities an operator key gets is the OWNER's decision, made when
// the operator surface is turned on: one switch per capability, all OFF by
// default, and the whole surface OFF until `enabled`. The gate (operator-gate.ts)
// and every /api/operator/* route read this; nothing else does.
//
// Not a secret, so it lives beside the vault, not in it: store/operator-access.json.
// A missing or malformed file reads as everything OFF -- a broken file must
// close the surface, never open it.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

export const OPERATOR_ACCESS_PATH = join(STORE_DIR, 'operator-access.json')

export const OPERATOR_CAPABILITIES = ['agentControl', 'update', 'vaultWrite', 'paneView', 'commands'] as const
export type OperatorCapability = typeof OPERATOR_CAPABILITIES[number]

/** Commands the owner may allow as buttons; the server maps each to a fixed text. */
export const OPERATOR_COMMANDS = ['login', 'mcp'] as const
export type OperatorCommand = typeof OPERATOR_COMMANDS[number]

export interface OperatorAccess {
  enabled: boolean
  capabilities: Record<OperatorCapability, boolean>
  commands: OperatorCommand[]
}

export function defaultOperatorAccess(): OperatorAccess {
  return {
    enabled: false,
    capabilities: { agentControl: false, update: false, vaultWrite: false, paneView: false, commands: false },
    commands: [],
  }
}

/** Normalise any parsed value: only literal `true` turns a switch on; unknown keys and commands are dropped. */
export function normaliseOperatorAccess(raw: unknown): OperatorAccess {
  const out = defaultOperatorAccess()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as { enabled?: unknown; capabilities?: unknown; commands?: unknown }
  out.enabled = r.enabled === true
  if (r.capabilities && typeof r.capabilities === 'object') {
    const caps = r.capabilities as Record<string, unknown>
    for (const c of OPERATOR_CAPABILITIES) out.capabilities[c] = caps[c] === true
  }
  if (Array.isArray(r.commands)) {
    out.commands = [...new Set(r.commands.filter((c): c is OperatorCommand => (OPERATOR_COMMANDS as readonly unknown[]).includes(c)))]
  }
  return out
}

export function readOperatorAccess(path: string = OPERATOR_ACCESS_PATH): OperatorAccess {
  if (!existsSync(path)) return defaultOperatorAccess()
  try {
    return normaliseOperatorAccess(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    logger.warn({ path }, 'operator-access: unreadable, treating as everything OFF')
    return defaultOperatorAccess()
  }
}

export function writeOperatorAccess(access: OperatorAccess, path: string = OPERATOR_ACCESS_PATH): void {
  atomicWriteFileSync(path, JSON.stringify(normaliseOperatorAccess(access), null, 2))
}
